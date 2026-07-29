/**
 * FlexiDim controller (user) protocol — pure frame encoding and decoding.
 *
 * This is the protocol spoken by the original "FlexiDim" iOS app (2.61) on
 * TCP port 15274. It is NOT the configuration protocol on port 15273: that one
 * uses `ff f3`-prefixed, CRC-16/X25-framed, `1b`-escaped frames. This one uses
 * short records terminated by a single `0xFF` byte and carries no checksum at
 * all. Every claim here is traced to the arm64 binary; see PROTOCOL.md for the
 * addresses and confidence labels.
 *
 * Every frame in both directions ends with 0xFF, and no other byte in a frame
 * is allowed to be 0xFF. That is why the subscription bitmap packs only seven
 * channels per byte.
 */

/** Record type sent by the client. */
export const CMD_SWITCH = 0xf0;      // -[JCLrootController sendSwMsg:button:]
export const CMD_DIM = 0xf1;         // -[JCLrootController sendChMsg:withTransition:]
export const CMD_SUBSCRIBE = 0xf9;   // -[JCLrootController registerForUpdates:]

/** Record type sent by the controller. */
export const REC_LEVEL = 0xf0;       // "f0<address>|<level>"
export const REC_USERDATA = 0xf8;    // "f8<marker-lo7><marker-hi7><text chunk>"

/** Frame terminator, and the only byte that may not appear inside a frame. */
export const END = 0xff;

/** Final-chunk marker for an `f8` user-data stream (14 bits, all set). */
export const MARKER_FINAL = 0x3fff;
/** "Nothing changed — keep using the profile you already have." */
export const MARKER_UNCHANGED = 0x3ffe;

/**
 * Channels are addressed 1..N on the wire. The subscription bitmap uses seven
 * bits per byte so that a byte of all-ones is 0x7F and can never collide with
 * the 0xFF terminator.
 */
export const CHANNELS_PER_BITMAP_BYTE = 7;

/**
 * Subscription frame length by site type. Recovered from the three branches of
 * `-[JCLrootController registerForUpdates:]`: site types "0" and "1" build a
 * 21-byte frame, site type "2" a 39-byte one.
 */
export function subscriptionFrameLength(siteType = 0) {
  return Number(siteType) === 2 ? 39 : 21;
}

/** Highest channel address a subscription frame of this site type can carry. */
export function maxSubscribableChannel(siteType = 0) {
  return (subscriptionFrameLength(siteType) - 2) * CHANNELS_PER_BITMAP_BYTE;
}

/**
 * Every payload byte must stay below 0xFF, which is reserved as the frame
 * terminator: a 0xFF anywhere else would truncate the frame at the controller.
 */
function assertByte(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xfe) {
    throw new RangeError(
      `${name} must be an integer in 0..254 (0xff is the frame terminator), received ${value}`,
    );
  }
}

/**
 * Dim one channel.
 *
 *   f1 <channel> <level> <transition> ff
 *
 * `transition` is in half-second ticks; the iOS template's resting value is 1
 * (0.5 s). `level` is the already-scaled wire level — see scaleLevel().
 */
export function dimFrame(channel, level, transition = 1) {
  assertByte('channel', channel);
  assertByte('level', level);
  assertByte('transition', transition);
  return Uint8Array.from([CMD_DIM, channel, level, transition, END]);
}

/**
 * Press a physical switch button.
 *
 *   f0 <switch> <button> ff
 *
 * `switchNumber` is the controller's hardware switch number (the value carried
 * in the user profile's switch record), not a UI row index.
 */
export function switchFrame(switchNumber, button) {
  assertByte('switchNumber', switchNumber);
  assertByte('button', button);
  return Uint8Array.from([CMD_SWITCH, switchNumber, button, END]);
}

/**
 * Ask the controller to start reporting levels for a set of channels.
 *
 *   f9 <bitmap bytes> ff
 *
 * For a one-based channel address `n`, bit `(n-1) % 7` of bitmap byte
 * `(n-1) / 7` is set. The controller replies with one `f0` level record per
 * subscribed channel and then keeps sending them as levels change.
 *
 * A channel outside the frame's capacity is reported rather than silently
 * dropped, because a silently missing subscription looks identical to a dead
 * channel in the UI.
 */
export function subscribeFrame(channels, siteType = 0) {
  const length = subscriptionFrameLength(siteType);
  const frame = new Uint8Array(length);
  frame[0] = CMD_SUBSCRIBE;
  frame[length - 1] = END;
  const limit = maxSubscribableChannel(siteType);
  const skipped = [];
  for (const raw of channels) {
    const channel = Number(raw);
    if (!Number.isInteger(channel) || channel < 1 || channel > limit) {
      skipped.push(raw);
      continue;
    }
    const zeroBased = channel - 1;
    const index = 1 + Math.floor(zeroBased / CHANNELS_PER_BITMAP_BYTE);
    frame[index] |= 1 << (zeroBased % CHANNELS_PER_BITMAP_BYTE);
  }
  return { frame, skipped };
}

/**
 * Strip presentation whitespace from a security key.
 *
 * The configuration app displays a key in four groups of four — "s62a elti j8kf
 * mcan" — but the value it stores and the value the controller authenticates
 * against are the 16 characters with no spaces. The original iOS controller
 * app does no normalization at all: its only input rule is a hard 16-character
 * limit, so a key typed with the spaces it is displayed with simply would not
 * fit. Accepting both spellings here costs nothing and removes a trap.
 *
 * Case is deliberately left alone. Generated keys are lowercase base-36, but
 * nothing prevents a hand-set key from containing uppercase, and silently
 * folding case would break it with no way for the user to tell why.
 */
export function normalizeSecurityKey(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, '') : '';
}

/**
 * Authentication record, written immediately after the TCP stream opens.
 *
 *   <16 ASCII security-key bytes><six ASCII decimal nonce digits><ff>
 *
 * Built by the iOS app as [NSString stringWithFormat:@"%@%06d%c", key, nonce,
 * 0xff] encoded as NSISOLatin1StringEncoding (5). Latin-1 matters: it makes the
 * trailing 0xFF exactly one byte, where UTF-8 would emit two.
 *
 * The nonce is arc4random() % 1000000. It is not a challenge response — the
 * controller never sends anything to base it on — so any value in range works;
 * a random one is used to match the original app's traffic.
 */
export function authRecord(securityKey, nonce) {
  const key = normalizeSecurityKey(securityKey);
  if (key.length !== 16) {
    throw new RangeError('security key must be exactly 16 characters');
  }
  if (!/^[\x21-\x7e]{16}$/.test(key)) {
    throw new RangeError('security key must be printable ASCII');
  }
  const value = Number.isInteger(nonce) ? nonce % 1000000 : randomNonce();
  const text = `${key}${String(value).padStart(6, '0')}`;
  const bytes = new Uint8Array(text.length + 1);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  bytes[text.length] = END;
  return bytes;
}

function randomNonce() {
  // Node's webcrypto is always present on the supported versions.
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] % 1000000;
}

/**
 * Scale a 0..100 percentage to the wire level for one channel.
 *
 * Recovered from `-[JCLrootController sendChMsg:withTransition:]`:
 *
 *   if (chType != 0) { level = level * chType / 100; if (level > chType) level = chType; }
 *
 * `chType` is the channel's maximum wire value, taken from the third field of
 * its user-profile record. A `chType` of 0 means "send the percentage as-is",
 * which is what dimmable channels use.
 */
export function scaleLevel(percent, channelType = 0) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const max = Number(channelType) || 0;
  if (max === 0) return clamped;
  return Math.min(Math.floor((clamped * max) / 100), max);
}

/** Inverse of scaleLevel, for rendering a controller-reported level. */
export function unscaleLevel(wireLevel, channelType = 0) {
  const level = Math.max(0, Number(wireLevel) || 0);
  const max = Number(channelType) || 0;
  if (max === 0) return Math.min(100, level);
  if (level >= max) return 100;
  return Math.round((level * 100) / max);
}

/**
 * Split a byte stream into 0xFF-terminated records.
 *
 * Returns the complete records plus whatever trailing bytes have not yet been
 * terminated, which the caller carries into the next read. The terminator is
 * not included in the returned record.
 */
export function splitRecords(bytes) {
  const records = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === END) {
      records.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  return { records, rest: bytes.subarray(start) };
}

/** Decode a record body (terminator already stripped) as Latin-1 text. */
export function latin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * Classify one controller record.
 *
 * `f0<address>|<level>` — a live channel level, both values ASCII decimal.
 * `f8<lo7><hi7><chunk>` — one chunk of the user-profile text. The 14-bit
 * marker is little-endian across two seven-bit bytes, exactly as in the
 * configuration protocol's `ff f2` user transfer.
 */
export function decodeRecord(bytes) {
  if (!bytes || bytes.length === 0) return { type: 'empty' };
  const type = bytes[0];

  if (type === REC_LEVEL) {
    const text = latin1(bytes.subarray(1));
    const parts = text.split('|');
    if (parts.length !== 2) return { type: 'unknown', code: type, text };
    const channel = Number.parseInt(parts[0], 10);
    const level = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(channel) || !Number.isFinite(level)) {
      return { type: 'unknown', code: type, text };
    }
    return { type: 'level', channel, level };
  }

  if (type === REC_USERDATA) {
    if (bytes.length < 3) return { type: 'unknown', code: type, text: latin1(bytes) };
    const marker = bytes[1] | (bytes[2] << 7);
    return { type: 'userData', marker, chunk: latin1(bytes.subarray(3)) };
  }

  return { type: 'unknown', code: type, text: latin1(bytes) };
}

/**
 * Reassembles the chunked `f8` user-profile stream.
 *
 * Marker 0 starts a fresh profile, MARKER_FINAL (0x3fff) closes it, and
 * MARKER_UNCHANGED (0x3ffe) means the controller has nothing new to send and
 * the client should keep the profile it already has.
 */
export class UserDataAssembler {
  constructor() {
    this.chunks = [];
    this.started = false;
  }

  /**
   * @returns {{state:'collecting'}|{state:'complete',text:string}|{state:'unchanged'}}
   */
  push(marker, chunk) {
    if (marker === MARKER_UNCHANGED) {
      this.reset();
      return { state: 'unchanged' };
    }
    if (marker === 0) {
      this.chunks = [];
      this.started = true;
    }
    this.chunks.push(chunk);
    if (marker === MARKER_FINAL) {
      const text = this.chunks.join('');
      this.reset();
      return { state: 'complete', text };
    }
    return { state: 'collecting' };
  }

  reset() {
    this.chunks = [];
    this.started = false;
  }
}

/**
 * Site type is the fifth character of the site ID, as a digit. The iOS app
 * keeps it as the raw character code and compares it against '1' and '2'.
 */
export function siteTypeFromSiteId(siteId) {
  if (typeof siteId !== 'string' || siteId.length < 5) return 0;
  const digit = Number.parseInt(siteId[4], 10);
  return Number.isFinite(digit) ? digit : 0;
}
