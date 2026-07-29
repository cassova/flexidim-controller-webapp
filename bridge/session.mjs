/**
 * An authenticated control session with a Scene Controller.
 *
 * Lifecycle, recovered from `-[JCLrootController initTCPto:onPort:channel:]`
 * and the stream-event handler:
 *
 *   1. open TCP to the controller on port 15274
 *   2. write the 23-byte authentication record immediately
 *   3. the controller replies with `f8` user-profile chunks
 *   4. once the profile is complete, subscribe with `f9`
 *   5. the controller streams `f0` level records until the socket closes
 *
 * The controller never acknowledges authentication. A bad security key shows up
 * as silence followed by the controller closing the socket, so the session
 * reports a profile timeout rather than a specific "wrong key" error.
 */
import net from 'node:net';
import { EventEmitter } from 'node:events';

import {
  authRecord,
  decodeRecord,
  dimFrame,
  scaleLevel,
  splitRecords,
  subscribeFrame,
  switchFrame,
  UserDataAssembler,
} from './protocol.mjs';
import { CONTROL_PORT } from './discovery.mjs';
import { parseUserProfile, subscribableChannels } from './user-profile.mjs';

/** How long to wait for the profile before giving up on the credentials. */
const PROFILE_TIMEOUT_MS = 15000;
/** How long to wait for the TCP handshake itself. */
const CONNECT_TIMEOUT_MS = 8000;

/**
 * Emits:
 *   'status'  {phase, message}
 *   'profile' parsed user profile (includes the security code; redact before
 *             sending onward)
 *   'levels'  Map-like object of {channel: level} batched updates
 *   'trace'   {direction, summary} for the diagnostics panel
 *   'error'   Error
 *   'close'   {reason}
 */
export class ControllerSession extends EventEmitter {
  constructor({ host, port = CONTROL_PORT, securityKey, siteType = 0, levelBatchMs = 120 }) {
    super();
    this.host = host;
    this.port = port;
    this.securityKey = securityKey;
    this.siteType = siteType;
    this.levelBatchMs = levelBatchMs;

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.assembler = new UserDataAssembler();
    this.profile = null;
    this.levels = new Map();
    this.pendingLevels = new Map();
    this.levelTimer = null;
    this.profileTimer = null;
    this.closed = false;
  }

  connect() {
    if (this.socket) throw new Error('session already started');
    this.emit('status', { phase: 'connecting', message: `Connecting to ${this.host}` });

    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    socket.on('timeout', () => {
      if (!this.profile) {
        this.fail(new Error('The controller did not respond. Check the address and that no other FlexiDim app is connected.'));
      } else {
        socket.setTimeout(0);
      }
    });

    socket.on('connect', () => {
      socket.setTimeout(0);
      this.emit('status', { phase: 'authenticating', message: 'Authenticating' });
      // The key never leaves this process in a log or an event.
      socket.write(Buffer.from(authRecord(this.securityKey)));
      this.emit('trace', { direction: 'tx', summary: 'authentication record (23 bytes)' });
      this.emit('status', { phase: 'awaitingProfile', message: 'Waiting for your rooms' });

      this.profileTimer = setTimeout(() => {
        if (!this.profile) {
          this.fail(new Error('The controller accepted the connection but sent no rooms. The security key is probably wrong.'));
        }
      }, PROFILE_TIMEOUT_MS);
    });

    socket.on('data', (chunk) => this.ingest(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.finish('The controller closed the connection'));

    return this;
  }

  ingest(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const { records, rest } = splitRecords(this.buffer);
    this.buffer = Buffer.from(rest);
    for (const record of records) this.handleRecord(record);
  }

  handleRecord(bytes) {
    const decoded = decodeRecord(bytes);
    switch (decoded.type) {
      case 'level':
        this.noteLevel(decoded.channel, decoded.level);
        break;
      case 'userData':
        this.handleUserData(decoded);
        break;
      case 'empty':
        break;
      default:
        this.emit('trace', {
          direction: 'rx',
          summary: `unrecognised record type 0x${(decoded.code ?? 0).toString(16)}`,
        });
    }
  }

  handleUserData({ marker, chunk }) {
    const result = this.assembler.push(marker, chunk);
    if (result.state === 'collecting') return;

    if (result.state === 'unchanged') {
      this.emit('trace', { direction: 'rx', summary: 'controller reports profile unchanged' });
      // Nothing cached in this process, so ask again by reconnecting is the
      // caller's choice; report it rather than hanging on the profile timeout.
      this.emit('status', {
        phase: 'profileUnchanged',
        message: 'The controller reported no profile changes',
      });
      return;
    }

    clearTimeout(this.profileTimer);
    this.profileTimer = null;
    try {
      this.profile = parseUserProfile(result.text);
    } catch (error) {
      this.fail(new Error(`The controller sent a user profile this app could not read: ${error.message}`));
      return;
    }
    this.emit('trace', {
      direction: 'rx',
      summary: `user profile: ${this.profile.rooms.length} rooms, ${this.profile.channels.length} channels`,
    });
    this.emit('profile', this.profile);
    this.subscribe();
    this.emit('status', { phase: 'ready', message: 'Connected' });
  }

  subscribe() {
    if (!this.profile) return;
    const channels = subscribableChannels(this.profile);
    if (channels.length === 0) return;
    const { frame, skipped } = subscribeFrame(channels, this.siteType);
    this.write(frame, `subscribe to ${channels.length} channel(s)`);
    if (skipped.length) {
      this.emit('trace', {
        direction: 'tx',
        summary: `${skipped.length} channel(s) outside the subscription range were not subscribed`,
      });
    }
  }

  noteLevel(channel, level) {
    this.levels.set(channel, level);
    this.pendingLevels.set(channel, level);
    if (this.levelTimer) return;
    this.levelTimer = setTimeout(() => {
      this.levelTimer = null;
      if (this.pendingLevels.size === 0) return;
      const batch = Object.fromEntries(this.pendingLevels);
      this.pendingLevels.clear();
      this.emit('levels', batch);
    }, this.levelBatchMs);
  }

  /** Look up a channel's declared maximum wire value from the profile. */
  channelType(address) {
    const channel = this.profile?.channels.find((c) => c.address === address);
    return channel ? channel.channelType : 0;
  }

  /**
   * Set one channel to a percentage. `transition` is in half-second ticks.
   */
  dim(address, percent, transition = 1) {
    const level = scaleLevel(percent, this.channelType(address));
    this.write(dimFrame(address, level, transition), `dim channel ${address} to ${level}`);
    // Reflect the request locally so the UI does not snap back while waiting
    // for the controller's own report.
    this.levels.set(address, level);
  }

  /** Press a scene button on a wall switch. */
  press(switchNumber, button) {
    this.write(switchFrame(switchNumber, button), `switch ${switchNumber} button ${button}`);
  }

  write(frame, summary) {
    if (this.closed || !this.socket || this.socket.destroyed) {
      throw new Error('not connected to the controller');
    }
    this.socket.write(Buffer.from(frame));
    this.emit('trace', { direction: 'tx', summary });
  }

  fail(error) {
    if (this.closed) return;
    this.emit('error', error);
    this.finish(error.message);
  }

  finish(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.profileTimer);
    clearTimeout(this.levelTimer);
    this.profileTimer = null;
    this.levelTimer = null;
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.emit('close', { reason });
  }

  disconnect() {
    this.finish('Disconnected');
  }
}
