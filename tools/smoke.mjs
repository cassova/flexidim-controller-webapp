/**
 * End-to-end smoke check: browser -> bridge -> controller.
 *
 * Drives the bridge over the same loopback WebSocket the page uses, so it
 * exercises the real framing, session and protocol code rather than importing
 * around them.
 *
 * By default it starts the emulator and talks to that, which is safe to run any
 * time. Point it at real hardware with:
 *
 *   CONTROLLER_HOST=192.168.1.50 CONTROLLER_KEY=<16 chars> node tools/smoke.mjs
 *
 * Against real hardware it connects, reads the profile and reads levels. It
 * sends a dim command only when DIM_CHANNEL is set, so the default run never
 * changes a light.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { startEmulator } from './controller-emulator.mjs';

// The proxied path the browser actually uses. Set BRIDGE_URL to
// ws://127.0.0.1:8765 to bypass the web host and hit the bridge directly.
const BRIDGE = process.env.BRIDGE_URL ?? 'ws://127.0.0.1:3000/bridge';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

async function main() {
  let emulator = null;
  let host = process.env.CONTROLLER_HOST;
  let port = Number(process.env.CONTROLLER_PORT) || undefined;
  const key = process.env.CONTROLLER_KEY ?? '0123456789abcdef';

  if (!host) {
    emulator = await startEmulator({ port: 0 });
    host = '127.0.0.1';
    port = emulator.port;
    process.stdout.write(`Using the emulated controller on 127.0.0.1:${port}\n\n`);
  } else {
    process.stdout.write(`Using the controller at ${host}\n\n`);
  }

  const socket = new WebSocket(BRIDGE);
  const inbox = [];
  socket.addEventListener('message', (event) => inbox.push(JSON.parse(event.data)));

  const opened = await Promise.race([
    new Promise((resolve) => socket.addEventListener('open', () => resolve(true))),
    sleep(3000).then(() => false),
  ]);
  check('bridge accepts a WebSocket connection', opened, opened ? '' : `no bridge at ${BRIDGE}`);
  if (!opened) return finish(emulator, socket);

  const waitFor = async (type, ms = 20000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = inbox.find((m) => m.type === type);
      if (found) return found;
      await sleep(25);
    }
    return null;
  };

  check('bridge greets the client', Boolean(await waitFor('hello', 3000)));

  socket.send(JSON.stringify({ type: 'connect', host, port, securityKey: key }));

  const profileMessage = await waitFor('profile');
  check('controller returns a user profile', Boolean(profileMessage));
  if (!profileMessage) {
    const err = inbox.find((m) => m.type === 'error');
    if (err) check('…the bridge reported', false, err.message);
    return finish(emulator, socket);
  }

  const profile = profileMessage.profile;
  check('profile has rooms', profile.rooms.length > 0, `${profile.rooms.length} rooms`);
  check('profile has channels', profile.channels.length > 0, `${profile.channels.length} channels`);
  check(
    'the security code never reaches the browser',
    !JSON.stringify(profile).includes(key) && profile.securityCode === undefined,
  );
  check('profile parsed without warnings', profile.warnings.length === 0,
    profile.warnings.join('; '));

  const levels = await waitFor('levels');
  check('controller reports channel levels', Boolean(levels),
    levels ? `${Object.keys(levels.levels).length} channels reported` : 'none within 20s');

  const dimChannel = Number(process.env.DIM_CHANNEL);
  if (Number.isInteger(dimChannel) && dimChannel > 0) {
    const target = Number(process.env.DIM_PERCENT ?? 40);
    inbox.length = 0;
    socket.send(JSON.stringify({ type: 'dim', channel: dimChannel, percent: target }));
    const echo = await waitFor('levels', 5000);
    check(`dim channel ${dimChannel} to ${target}%`, Boolean(echo),
      echo ? JSON.stringify(echo.levels) : 'no level report came back');
  } else {
    process.stdout.write('  --   dim command skipped (set DIM_CHANNEL to include it)\n');
  }

  socket.send(JSON.stringify({ type: 'disconnect' }));
  await sleep(150);
  return finish(emulator, socket);
}

async function finish(emulator, socket) {
  try {
    socket?.close();
  } catch {
    // Closing anyway.
  }
  if (emulator) await emulator.close();
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
}

await main();
