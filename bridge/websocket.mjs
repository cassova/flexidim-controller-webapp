/**
 * WebSocket framing and liveness for the app-facing bridge socket.
 *
 * The bridge speaks WebSocket directly instead of depending on a library, so
 * the frame codec lives here where it can be exercised without opening a port.
 *
 * Shared verbatim with the sibling flexidim-configuration-webapp project; keep
 * the two copies in step when either changes.
 *
 * The heartbeat exists because the Scene Controller connection is an exclusive
 * resource: a controller accepts one control session, and the bridge releases
 * it from the app socket's `close` event. A browser that dies without sending a
 * close frame or a FIN — a crash, a suspended laptop, a dropped Wi-Fi link —
 * never produces that event. Without an independent liveness check the bridge
 * keeps believing the browser is there, holds the controller socket open
 * indefinitely, and locks the original iOS app out of the very session it needs
 * as the documented recovery route.
 */

export const TEXT_OPCODE = 0x1;
export const CLOSE_OPCODE = 0x8;
export const PING_OPCODE = 0x9;
export const PONG_OPCODE = 0xa;

/** Ping cadence and the silence after which a client is considered gone. */
export const PING_INTERVAL_MS = 15_000;
export const IDLE_TIMEOUT_MS = 45_000;

/** A JSON text frame. Server-to-client frames are never masked. */
export function websocketFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126)
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const head = Buffer.alloc(4);
  head[0] = 0x81;
  head[1] = 126;
  head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

/**
 * A control frame. RFC 6455 caps a control payload at 125 bytes and forbids
 * fragmenting one, so the FIN bit is always set and the length is always the
 * single-byte form.
 */
export function controlFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  if (body.length > 125)
    throw new RangeError("a WebSocket control frame payload cannot exceed 125 bytes");
  return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
}

export const pingFrame = (payload) => controlFrame(PING_OPCODE, payload);
export const pongFrame = (payload) => controlFrame(PONG_OPCODE, payload);
export const closeFrame = () => controlFrame(CLOSE_OPCODE);

/**
 * Decode as many complete frames as `buffer` holds, returning the undecoded
 * remainder. Control frames are surfaced separately from text: a client ping
 * obliges us to answer with a pong carrying the identical payload, and a pong
 * is the liveness signal the heartbeat waits for.
 */
export function decodeFrames(buffer) {
  const messages = [];
  const pings = [];
  const pongs = [];
  let closeRequested = false;
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    }
    if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const masked = Boolean(second & 0x80);
    let mask;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (masked)
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    const opcode = first & 0x0f;
    if (opcode === TEXT_OPCODE) messages.push(payload.toString("utf8"));
    else if (opcode === CLOSE_OPCODE) closeRequested = true;
    else if (opcode === PING_OPCODE) pings.push(payload);
    else if (opcode === PONG_OPCODE) pongs.push(payload);
    offset = cursor + length;
  }
  return { messages, closeRequested, pings, pongs, rest: buffer.subarray(offset) };
}

/**
 * Pings tracked clients on an interval and reports the ones that have gone
 * silent for longer than the timeout. It owns a single timer for every client
 * rather than one each, and stops entirely when no client is tracked, so an
 * idle bridge schedules no work.
 *
 * Any inbound byte counts as liveness, not only a pong: a browser that is
 * actively sending commands is self-evidently alive.
 */
export class WebSocketHeartbeat {
  constructor({
    intervalMs = PING_INTERVAL_MS,
    timeoutMs = IDLE_TIMEOUT_MS,
    ping,
    reap,
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    if (!(intervalMs > 0))
      throw new TypeError("the heartbeat needs a positive ping interval");
    if (!(timeoutMs > intervalMs))
      throw new TypeError(
        "the idle timeout must exceed the ping interval, or a healthy client is reaped before it can answer",
      );
    if (typeof ping !== "function")
      throw new TypeError("the heartbeat needs a ping function");
    if (typeof reap !== "function")
      throw new TypeError("the heartbeat needs a reap function");
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.ping = ping;
    this.reap = reap;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.lastSeen = new Map();
    this.timer = undefined;
  }

  add(socket) {
    this.lastSeen.set(socket, this.now());
    this.start();
  }

  /** Record inbound activity. Ignored for an untracked or already reaped socket. */
  touch(socket) {
    if (this.lastSeen.has(socket)) this.lastSeen.set(socket, this.now());
  }

  remove(socket) {
    this.lastSeen.delete(socket);
    if (!this.lastSeen.size) this.stop();
  }

  get tracked() {
    return this.lastSeen.size;
  }

  start() {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => this.tick(), this.intervalMs);
    // Never keep the process alive purely to ping clients.
    this.timer?.unref?.();
  }

  stop() {
    if (!this.timer) return;
    this.clearIntervalFn(this.timer);
    this.timer = undefined;
  }

  tick() {
    const now = this.now();
    // Snapshot first: reap() closes sockets, which removes entries.
    for (const [socket, seen] of [...this.lastSeen]) {
      const silentMs = now - seen;
      if (silentMs >= this.timeoutMs) {
        this.remove(socket);
        this.reap(socket, silentMs);
      } else this.ping(socket);
    }
  }
}
