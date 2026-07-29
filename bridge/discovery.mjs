/**
 * Controller discovery.
 *
 * Recovered from `-[JCLrootController initUDPSocket:]`: bind UDP 15001, enable
 * broadcast, then send the four ASCII bytes "FLEX" to 255.255.255.255:15270.
 * The controller answers from its own address, and the source address of that
 * reply is the controller host. The payload of the reply is not needed.
 */
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';

export const DISCOVERY_REPLY_PORT = 15001;
export const DISCOVERY_BROADCAST_PORT = 15270;
export const CONTROL_PORT = 15274;
export const PROBE = 'FLEX';

const PRIVATE_V4 =
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

export function isPrivateAddress(address) {
  return typeof address === 'string' && PRIVATE_V4.test(address);
}

/** Directed broadcast address for an interface, from its address and netmask. */
export function directedBroadcast(address, netmask) {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  if (a.length !== 4 || m.length !== 4 || [...a, ...m].some((n) => !Number.isInteger(n))) {
    return null;
  }
  return a.map((octet, i) => (octet & m[i]) | (~m[i] & 0xff)).join('.');
}

/**
 * Every address the probe should be sent to.
 *
 * The limited broadcast 255.255.255.255 is tried first but cannot be relied
 * on: macOS rejects it outright with EHOSTUNREACH because the routing table
 * will not pick an interface for it, and inside a Docker bridge network it only
 * ever reaches the container subnet.
 *
 * So the real targets are the *directed* broadcasts of every non-internal IPv4
 * interface — 192.168.1.255 for a 192.168.1.x/24 interface. Those are ordinary
 * routable destinations, they work on macOS, and they need no configuration.
 * `FLEXIDIM_DISCOVERY_SEED` remains supported for the one case the interface
 * list cannot cover: a container on a bridge network, which can only see its
 * own subnet and has to be told the host's LAN address.
 */
export function broadcastTargets(
  seed = process.env.FLEXIDIM_DISCOVERY_SEED,
  interfaces = os.networkInterfaces(),
) {
  const targets = ['255.255.255.255'];
  const add = (value) => {
    if (value && !targets.includes(value)) targets.push(value);
  };

  for (const entries of Object.values(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      const family = entry.family;
      if (family !== 'IPv4' && family !== 4) continue;
      if (entry.internal) continue;
      add(entry.broadcast ?? directedBroadcast(entry.address, entry.netmask));
    }
  }

  const trimmed = String(seed ?? '').trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed) && isPrivateAddress(trimmed)) {
    add(`${trimmed.split('.').slice(0, 3).join('.')}.255`);
  }
  return targets;
}

/**
 * Candidate /24 subnets to sweep, most specific first.
 *
 * A container on a Docker bridge network sees only its own 172.x subnet, so its
 * interface list is useless for finding the house LAN. Two things do know the
 * real subnet: `FLEXIDIM_DISCOVERY_SEED`, and — much more reliably, because it
 * needs no configuration at all — the address the browser used to load the
 * page. If you opened http://192.168.1.20:3000 then 192.168.1.0/24 is where
 * your controller lives.
 */
export function candidateSubnets({ hint, seed = process.env.FLEXIDIM_DISCOVERY_SEED, interfaces = os.networkInterfaces() } = {}) {
  const subnets = [];
  const add = (address) => {
    if (typeof address !== 'string' || !isPrivateAddress(address)) return;
    const base = address.split('.').slice(0, 3).join('.');
    if (!subnets.includes(base)) subnets.push(base);
  };
  add(hint);
  add(seed);
  for (const entries of Object.values(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) add(entry.address);
    }
  }
  return subnets;
}

/** Is a Scene Controller listening on this address? */
function probeControlPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Sweep a /24 for anything listening on the control port.
 *
 * The fallback for when UDP discovery cannot work — most importantly from
 * inside a Docker container, where a broadcast never reaches the LAN but an
 * ordinary TCP connection routes out fine. Bounded on purpose: one port, one
 * /24, a short timeout and a capped number of sockets in flight, so it finishes
 * in a couple of seconds and cannot be mistaken for a port scanner.
 *
 * A bare open port is a candidate, not a confirmed controller — authenticating
 * would need the user's key. The UI presents the results as suggestions.
 */
export async function scanSubnets(subnets, {
  port = CONTROL_PORT,
  timeoutMs = 400,
  concurrency = 64,
  signal,
} = {}) {
  const found = [];
  for (const base of subnets) {
    const hosts = [];
    for (let octet = 1; octet <= 254; octet += 1) hosts.push(`${base}.${octet}`);

    let cursor = 0;
    const worker = async () => {
      while (cursor < hosts.length) {
        if (signal?.aborted) return;
        const host = hosts[cursor];
        cursor += 1;
        if (await probeControlPort(host, port, timeoutMs)) {
          found.push({ host, port, via: 'scan' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
    // A controller on the first subnet is the answer; do not keep sweeping.
    if (found.length) break;
  }
  return found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

/**
 * Broadcast a discovery probe and collect the controllers that answer.
 *
 * @param {{timeoutMs?:number, broadcastAddress?:string, replyPort?:number, seed?:string}} options
 * @returns {Promise<Array<{host:string, port:number}>>}
 */
export function discoverControllers({
  timeoutMs = 2000,
  broadcastAddress,
  replyPort = DISCOVERY_REPLY_PORT,
  seed,
} = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed; nothing to do.
      }
      if (error) reject(error);
      else resolve([...found.values()]);
    };

    const timer = setTimeout(() => finish(), timeoutMs);

    socket.on('error', (error) => finish(error));

    socket.on('message', (_msg, rinfo) => {
      // The reply's source address is the controller. Ignore anything that is
      // not a private LAN address: this protocol has no authentication of the
      // discovery reply, so a wide-area answer would be a redirection attempt.
      if (!isPrivateAddress(rinfo.address)) return;
      if (!found.has(rinfo.address)) {
        found.set(rinfo.address, { host: rinfo.address, port: CONTROL_PORT });
      }
    });

    socket.bind(replyPort, () => {
      try {
        socket.setBroadcast(true);
        const targets = broadcastAddress ? [broadcastAddress] : broadcastTargets(seed);
        for (const target of targets) {
          socket.send(Buffer.from(PROBE, 'latin1'), DISCOVERY_BROADCAST_PORT, target, (error) => {
            // One unreachable target must not abandon the others: the limited
            // broadcast often fails inside a container while the directed one
            // succeeds, and vice versa on a plain host.
            if (error) process.stderr.write(`[flexidim-bridge] probe to ${target} failed: ${error.message}\n`);
          });
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}
