import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closeFrame,
  decodeFrames,
  pingFrame,
  pongFrame,
  WebSocketHeartbeat,
} from '../bridge/websocket.mjs';

/** Mask a client frame the way a browser does. */
function clientFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([
    Buffer.from([0x80 | opcode, 0x80 | body.length]),
    mask,
    masked,
  ]);
}

test('heartbeat frames use the correct WebSocket control opcodes', () => {
  assert.deepEqual([...pingFrame()], [0x89, 0x00]);
  assert.deepEqual([...pongFrame()], [0x8a, 0x00]);
  assert.deepEqual([...closeFrame()], [0x88, 0x00]);
});

test('the decoder recognises the browser pong that answers a bridge ping', () => {
  const decoded = decodeFrames(clientFrame(0x0a));
  assert.equal(decoded.pongs.length, 1);
  assert.equal(decoded.rest.length, 0);
});

test('an answering client remains live while a silent client is reaped', () => {
  let clock = 0;
  const pinged = [];
  const reaped = [];
  const heartbeat = new WebSocketHeartbeat({
    intervalMs: 1_000,
    timeoutMs: 3_000,
    now: () => clock,
    ping: (socket) => pinged.push(socket),
    reap: (socket) => reaped.push(socket),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  const answering = { name: 'answering' };
  const silent = { name: 'silent' };
  heartbeat.add(answering);
  heartbeat.add(silent);

  for (let round = 0; round < 3; round += 1) {
    clock += 1_000;
    heartbeat.touch(answering);
    heartbeat.tick();
  }

  assert.deepEqual(reaped, [silent]);
  assert.ok(pinged.includes(answering));
  assert.equal(heartbeat.tracked, 1);
});
