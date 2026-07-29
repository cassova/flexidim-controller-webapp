import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { ControllerSession } from '../bridge/session.mjs';
import { startEmulator, SAMPLE_PROFILE } from '../tools/controller-emulator.mjs';

const KEY = '0123456789abcdef';

async function connected(emulator, options = {}) {
  const session = new ControllerSession({
    host: '127.0.0.1',
    port: emulator.port,
    securityKey: KEY,
    levelBatchMs: 10,
    ...options,
  });
  const profilePromise = once(session, 'profile');
  session.connect();
  const [profile] = await profilePromise;
  return { session, profile };
}

test('a session authenticates, receives the profile and subscribes', async (t) => {
  const emulator = await startEmulator({ securityKey: KEY });
  t.after(() => emulator.close());

  const { session, profile } = await connected(emulator);
  t.after(() => session.disconnect());

  assert.equal(emulator.events.authRecords.length, 1);
  assert.equal(emulator.events.authRecords[0].key, KEY);
  assert.match(emulator.events.authRecords[0].nonce, /^\d{6}$/);
  assert.equal(emulator.events.authRecords[0].end, 0xff);

  assert.equal(profile.userName, 'Demo User');
  assert.equal(profile.areas.length, 2);
  assert.deepEqual(profile.areas.map((a) => a.name), ['Ground', 'First']);
  assert.equal(profile.rooms.length, 3);
  assert.deepEqual(profile.rooms.map((r) => r.name), ['Lounge', 'Kitchen', 'Bedroom']);
  assert.equal(profile.channels.length, 5);
  assert.deepEqual(profile.warnings, []);

  // The Bedroom sits on the First floor, so the areas must not both be flat.
  assert.deepEqual(profile.areas[1].rooms.map((r) => r.name), ['Bedroom']);
});

test('the subscription covers every channel in the profile', async (t) => {
  const emulator = await startEmulator({ securityKey: KEY });
  t.after(() => emulator.close());
  const { session } = await connected(emulator);
  t.after(() => session.disconnect());

  const [levels] = await once(session, 'levels');
  // Channels 1, 2, 9, 10 and 17 are the synthetic installation's addresses.
  assert.deepEqual(Object.keys(levels).map(Number).sort((a, b) => a - b), [1, 2, 9, 10, 17]);
});

test('dimming sends a scaled frame and the controller reports it back', async (t) => {
  const emulator = await startEmulator({ securityKey: KEY });
  t.after(() => emulator.close());
  const { session } = await connected(emulator);
  t.after(() => session.disconnect());

  await once(session, 'levels'); // drain the initial subscription report

  session.dim(1, 60);
  const [levels] = await once(session, 'levels');
  assert.equal(levels[1], 60, 'channel 1 has chType 0, so the percentage passes through');
  // f1 <channel 01> <level 3c = 60> <transition 01>, terminator stripped.
  assert.ok(
    emulator.events.frames.includes('f1013c01'),
    `expected f1 01 3c 01 among ${JSON.stringify(emulator.events.frames)}`,
  );
});

test('an on/off channel is scaled to its maximum wire value of 1', async (t) => {
  const emulator = await startEmulator({ securityKey: KEY });
  t.after(() => emulator.close());
  const { session } = await connected(emulator);
  t.after(() => session.disconnect());
  await once(session, 'levels');

  // "Under Cupboard" is channel 10 with chType 1.
  session.dim(10, 100);
  const [levels] = await once(session, 'levels');
  assert.equal(levels[10], 1);
});

test('a wrong security key surfaces as a failure, not a hang', async (t) => {
  const emulator = await startEmulator({ securityKey: 'the-correct-key0' });
  t.after(() => emulator.close());

  const session = new ControllerSession({
    host: '127.0.0.1',
    port: emulator.port,
    securityKey: KEY,
  });
  const closed = once(session, 'close');
  session.connect();
  const [{ reason }] = await closed;
  assert.match(reason, /closed the connection|security key/);
});

test('pressing a scene button writes the recovered four-byte frame', async (t) => {
  const emulator = await startEmulator({ securityKey: KEY });
  t.after(() => emulator.close());
  const { session } = await connected(emulator);
  t.after(() => session.disconnect());
  await once(session, 'levels');

  session.press(1, 2);
  await once(session, 'levels');
  assert.ok(
    emulator.events.frames.some((f) => f === 'f00102'),
    `expected f0 01 02 among ${JSON.stringify(emulator.events.frames)}`,
  );
});

test('commands before the profile arrives are refused rather than queued', async () => {
  const session = new ControllerSession({ host: '127.0.0.1', port: 1, securityKey: KEY });
  assert.throws(() => session.dim(1, 50), /not connected/);
});

test('the emulator profile is the one the parser was written against', () => {
  assert.ok(SAMPLE_PROFILE.endsWith('|'), 'payloads carry a trailing delimiter');
  assert.ok(!SAMPLE_PROFILE.includes('\n'), 'payloads contain no line breaks');
});
