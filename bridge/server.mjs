/**
 * Loopback WebSocket bridge.
 *
 * Browsers cannot open raw TCP or UDP sockets, so the page talks JSON to this
 * process over ws://127.0.0.1:8765 and this process talks FlexiDim to the
 * Scene Controller on the home LAN. Nothing is sent to a cloud service.
 *
 * A Scene Controller accepts one control session at a time, so the bridge holds
 * at most one session per browser connection and drops it as soon as the
 * browser goes away — including when the browser dies without closing cleanly,
 * which is what the heartbeat is for.
 */
import http from 'node:http';
import crypto from 'node:crypto';

import { ControllerSession } from './session.mjs';
import {
  CONTROL_PORT,
  candidateSubnets,
  discoverControllers,
  isPrivateAddress,
  scanSubnets,
} from './discovery.mjs';
import { normalizeSecurityKey } from './protocol.mjs';
import { redactProfile } from './user-profile.mjs';
import {
  findSite,
  forgetSite,
  noteLastUsed,
  readSites,
  redactSites,
  saveSite,
} from './site-store.mjs';
import {
  WebSocketHeartbeat,
  closeFrame,
  decodeFrames,
  pingFrame,
  pongFrame,
  websocketFrame,
} from './websocket.mjs';

const HOST = process.env.FLEXIDIM_BRIDGE_HOST ?? '127.0.0.1';
const PORT = Number(process.env.FLEXIDIM_BRIDGE_PORT ?? 8765);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Per-connection state. */
const clients = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: [...clients.values()].filter((c) => c.session).length }));
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('This endpoint speaks WebSocket only.\n');
});

const heartbeat = new WebSocketHeartbeat({
  ping: (socket) => {
    try {
      socket.write(pingFrame());
    } catch {
      // The reaper will deal with it on the next tick.
    }
  },
  reap: (socket, silentMs) => {
    log(`reaping a browser that went silent for ${Math.round(silentMs / 1000)}s`);
    teardown(socket, 'browser stopped responding');
  },
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  // Refuse upgrades from public origins: this bridge drives the user's
  // lighting and must not be reachable from a page on the open internet.
  const origin = req.headers.origin;
  if (origin && !isTrustedOrigin(origin)) {
    log(`refused a WebSocket upgrade from origin ${origin}`);
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  const state = { socket, buffer: Buffer.alloc(0), session: null };
  clients.set(socket, state);
  heartbeat.add(socket);
  send(socket, { type: 'hello', controlPort: CONTROL_PORT });
  // The saved-system list is what lets the page offer a one-tap reconnect (and
  // auto-connect) without ever holding the key, so send it unprompted.
  readSites()
    .then((record) => send(socket, { type: 'sites', ...redactSites(record) }))
    .catch((error) => log(`could not read saved systems: ${error.message}`));

  socket.on('data', (chunk) => {
    heartbeat.touch(socket);
    state.buffer = Buffer.concat([state.buffer, chunk]);
    const { messages, closeRequested, pings, rest } = decodeFrames(state.buffer);
    state.buffer = Buffer.from(rest);
    for (const payload of pings) socket.write(pongFrame(payload));
    for (const text of messages) {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        send(socket, { type: 'error', message: 'malformed request' });
        continue;
      }
      handle(state, message).catch((error) => {
        send(socket, { type: 'error', message: error.message });
      });
    }
    if (closeRequested) {
      try {
        socket.write(closeFrame());
      } catch {
        // Closing anyway.
      }
      teardown(socket, 'browser closed the connection');
    }
  });

  socket.on('error', () => teardown(socket, 'browser socket error'));
  socket.on('close', () => teardown(socket, 'browser disconnected'));
});

/**
 * Loopback and private-LAN origins are trusted; anything public is refused.
 *
 * The page is normally served from the LAN so a phone can load it, which means
 * a strict loopback-only rule would reject the primary use case. A private
 * origin still cannot do anything without the 16-character security key, and
 * each WebSocket owns its own session, so one client cannot take over
 * another's. What this does block is a page on the open internet quietly
 * driving the lights of whoever visits it.
 *
 * FLEXIDIM_ALLOWED_ORIGINS adds exact origins for anything else, such as a
 * reverse proxy with a hostname.
 */
function isTrustedOrigin(origin) {
  const allowed = (process.env.FLEXIDIM_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowed.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
      return true;
    }
    return isPrivateAddress(hostname);
  } catch {
    return false;
  }
}

function send(socket, value) {
  try {
    socket.write(websocketFrame(value));
  } catch {
    // The socket is gone; teardown will follow from its own events.
  }
}

function teardown(socket, reason) {
  const state = clients.get(socket);
  if (!state) return;
  clients.delete(socket);
  heartbeat.remove(socket);
  if (state.session) {
    state.session.disconnect();
    state.session = null;
    log(`released the controller session (${reason})`);
  }
  try {
    socket.destroy();
  } catch {
    // Already gone.
  }
}

async function handle(state, message) {
  const { socket } = state;
  switch (message.type) {
    case 'discover': {
      send(socket, { type: 'status', phase: 'discovering', message: 'Looking for your controller' });
      const hint = typeof message.hint === 'string' ? message.hint : undefined;

      let found = await discoverControllers({ timeoutMs: Number(message.timeoutMs) || 2000 });

      // UDP is the protocol's own mechanism, but it cannot cross a Docker
      // bridge network, which is exactly where this app usually runs. Sweeping
      // the LAN for the control port does work from a container, so fall back
      // to it rather than reporting "no controller" to someone whose controller
      // is plainly sitting there.
      if (found.length === 0) {
        const subnets = candidateSubnets({ hint });
        if (subnets.length) {
          send(socket, {
            type: 'status',
            phase: 'discovering',
            message: `Checking ${subnets[0]}.0/24 for a controller`,
          });
          found = await scanSubnets(subnets);
          if (found.length) log(`UDP found nothing; subnet scan found ${found.length} candidate(s)`);
        }
      }

      send(socket, { type: 'discovered', controllers: found });
      return;
    }

    case 'sites': {
      send(socket, { type: 'sites', ...redactSites(await readSites()) });
      return;
    }

    case 'forgetSite': {
      const record = await forgetSite(String(message.host ?? ''));
      send(socket, { type: 'sites', ...redactSites(record) });
      return;
    }

    case 'connect': {
      if (state.session) state.session.disconnect();
      const host = String(message.host ?? '').trim();
      if (!host) throw new Error('a controller address is required');

      // A saved system reconnects by host alone: the key stays on the server,
      // so the browser never has to hold or re-send it.
      let securityKey = normalizeSecurityKey(message.securityKey);
      if (!securityKey) {
        const stored = await findSite(host);
        if (!stored) throw new Error(`no security key saved for ${host}`);
        securityKey = stored.securityKey;
      }
      if (securityKey.length !== 16) {
        throw new Error('the security key must be exactly 16 characters');
      }

      if (message.remember) {
        const record = await saveSite({ host, port: message.port, label: message.label, securityKey });
        send(socket, { type: 'sites', ...redactSites(record) });
      } else {
        // Still worth recording: auto-connect follows the last system used,
        // even one the user chose not to save a new key for.
        await noteLastUsed(host);
      }

      const session = new ControllerSession({
        host,
        port: Number(message.port) || CONTROL_PORT,
        securityKey,
        siteType: Number(message.siteType) || 0,
      });
      state.session = session;

      session.on('status', (status) => send(socket, { type: 'status', ...status }));
      session.on('profile', (profile) => {
        send(socket, { type: 'profile', profile: redactProfile(profile) });
      });
      session.on('levels', (levels) => send(socket, { type: 'levels', levels }));
      session.on('trace', (trace) => send(socket, { type: 'trace', ...trace }));
      session.on('error', (error) => send(socket, { type: 'error', message: error.message }));
      session.on('close', ({ reason }) => {
        if (state.session === session) state.session = null;
        send(socket, { type: 'disconnected', reason });
      });

      session.connect();
      return;
    }

    case 'dim': {
      requireSession(state).dim(
        Number(message.channel),
        Number(message.percent),
        message.transition === undefined ? 1 : Number(message.transition),
      );
      return;
    }

    case 'press': {
      requireSession(state).press(Number(message.switch), Number(message.button));
      return;
    }

    case 'disconnect': {
      if (state.session) state.session.disconnect();
      state.session = null;
      return;
    }

    default:
      throw new Error(`unsupported request "${message.type}"`);
  }
}

function requireSession(state) {
  if (!state.session) throw new Error('not connected to a controller');
  return state.session;
}

function log(text) {
  process.stdout.write(`[flexidim-bridge] ${text}\n`);
}

server.listen(PORT, HOST, () => {
  log(`listening on ws://${HOST}:${PORT}`);
  log(`controller control port is ${CONTROL_PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const socket of [...clients.keys()]) teardown(socket, `bridge received ${signal}`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
