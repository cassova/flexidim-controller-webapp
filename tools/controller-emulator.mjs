/**
 * An emulated FlexiDim Scene Controller for the user/control protocol.
 *
 * It speaks the recovered port-15274 conversation: accept a TCP connection,
 * read the 23-byte authentication record, stream the user profile back as `f8`
 * chunks, then answer subscriptions with `f0` level records and apply incoming
 * dim and switch frames.
 *
 * This exists so the bridge and the UI can be exercised without touching real
 * hardware. It asserts nothing about a real controller's behaviour beyond what
 * PROTOCOL.md already records.
 */
import net from 'node:net';

import {
  MARKER_FINAL,
  REC_LEVEL,
  REC_USERDATA,
  END,
  splitRecords,
  latin1,
} from '../bridge/protocol.mjs';

/**
 * Build a payload from a structured description, so the 24 button slots and the
 * embedded counts are always consistent. Hand-writing the pipes is how you get
 * an off-by-one that only shows up as a mis-parsed channel address.
 *
 * @param {{securityCode?:string,userName?:string,siteId?:string,areas:string[],rooms:Array}} spec
 */
export function buildProfile(spec) {
  const {
    securityCode = '0011223344556677',
    userName = 'Demo User',
    siteId = 'DEMO:0001',
    areas,
    rooms,
  } = spec;
  const fields = [securityCode, userName, siteId, String(areas.length), ...areas, String(rooms.length)];

  for (const room of rooms) {
    const switches = room.switches ?? [];
    const channels = room.channels ?? [];
    fields.push(room.name, String(room.icon ?? 0), String(room.areaIndex ?? 0),
      String(switches.length), String(channels.length));
    for (const sw of switches) {
      const slots = new Array(24).fill('');
      for (const [slot, label] of Object.entries(sw.buttons ?? {})) slots[Number(slot)] = label;
      fields.push(sw.name, String(sw.number), String(sw.flag), ...slots);
    }
    for (const ch of channels) {
      fields.push(ch.name, String(ch.address), String(ch.channelType ?? 0));
    }
  }
  return `${fields.join('|')}|`;
}

/** A wholly synthetic three-room installation. No real site data appears here. */
export const SAMPLE_PROFILE = buildProfile({
  areas: ['Ground', 'First'],
  rooms: [
    {
      name: 'Lounge',
      icon: 3,
      areaIndex: 0,
      switches: [
        {
          name: 'Lounge Switch',
          number: 1,
          flag: 0,
          // Slots 0-7 are the scene buttons; 16/18/22 are the built-in
          // Up/Down/On-Off the original app renders separately.
          buttons: { 0: 'Relax', 1: 'Bright', 2: 'Movie', 3: 'All Off', 16: 'Up', 18: 'Down', 22: 'On Off' },
        },
      ],
      channels: [
        { name: 'Lounge Ceiling', address: 1, channelType: 0 },
        { name: 'Lounge Lamps', address: 2, channelType: 0 },
      ],
    },
    {
      name: 'Kitchen',
      icon: 10,
      areaIndex: 0,
      switches: [
        {
          name: 'Kitchen Switch',
          number: 2,
          flag: 1,
          buttons: { 0: 'Bright', 1: 'Low', 16: 'Up', 18: 'Down', 22: 'On Off' },
        },
      ],
      channels: [
        { name: 'Kitchen Spots', address: 9, channelType: 0 },
        { name: 'Under Cupboard', address: 10, channelType: 1 },
      ],
    },
    {
      name: 'Bedroom',
      icon: 5,
      areaIndex: 1,
      channels: [{ name: 'Bedside', address: 17, channelType: 0 }],
    },
  ],
});

const CHUNK = 256;

function userDataFrames(text) {
  const frames = [];
  const total = Math.max(1, Math.ceil(text.length / CHUNK));
  for (let i = 0; i < total; i += 1) {
    const slice = text.slice(i * CHUNK, (i + 1) * CHUNK);
    const final = i === total - 1;
    const marker = final ? MARKER_FINAL : i;
    const body = [REC_USERDATA, marker & 0x7f, (marker >> 7) & 0x7f];
    for (const ch of slice) body.push(ch.charCodeAt(0) & 0xff);
    body.push(END);
    frames.push(Uint8Array.from(body));
  }
  return frames;
}

function levelFrame(channel, level) {
  const text = `${channel}|${level}`;
  const body = [REC_LEVEL, ...[...text].map((c) => c.charCodeAt(0)), END];
  return Uint8Array.from(body);
}

/**
 * @param {{port?:number, profile?:string, securityKey?:string, host?:string}} options
 */
export function startEmulator({ port = 0, profile = SAMPLE_PROFILE, securityKey = null, host = '127.0.0.1' } = {}) {
  const events = { authRecords: [], frames: [] };
  const levels = new Map();
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let authenticated = false;
    let subscribed = [];

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!authenticated) {
        if (buffer.length < 23) return;
        const record = buffer.subarray(0, 23);
        buffer = buffer.subarray(23);
        const key = latin1(record.subarray(0, 16));
        events.authRecords.push({ key, nonce: latin1(record.subarray(16, 22)), end: record[22] });
        if (securityKey !== null && key !== securityKey) {
          // A real controller goes silent and eventually drops the link.
          socket.destroy();
          return;
        }
        authenticated = true;
        for (const frame of userDataFrames(profile)) socket.write(Buffer.from(frame));
      }

      const { records, rest } = splitRecords(buffer);
      buffer = Buffer.from(rest);
      for (const record of records) {
        if (record.length === 0) continue;
        events.frames.push(Buffer.from(record).toString('hex'));
        const type = record[0];
        if (type === 0xf9) {
          subscribed = [];
          for (let byteIndex = 1; byteIndex < record.length; byteIndex += 1) {
            for (let bit = 0; bit < 7; bit += 1) {
              if (record[byteIndex] & (1 << bit)) {
                subscribed.push((byteIndex - 1) * 7 + bit + 1);
              }
            }
          }
          for (const channel of subscribed) {
            socket.write(Buffer.from(levelFrame(channel, levels.get(channel) ?? 0)));
          }
        } else if (type === 0xf1) {
          const [, channel, level] = record;
          levels.set(channel, level);
          socket.write(Buffer.from(levelFrame(channel, level)));
        } else if (type === 0xf0) {
          // A scene button: report every subscribed channel at full.
          for (const channel of subscribed) {
            levels.set(channel, 100);
            socket.write(Buffer.from(levelFrame(channel, 100)));
          }
        }
      }
    });

    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        server,
        port: server.address().port,
        events,
        levels,
        // Destroy live connections first: server.close() alone waits for every
        // open socket, which deadlocks a test whose session is still attached.
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close(done);
          }),
      });
    });
  });
}

// Allow running the emulator standalone: `node tools/controller-emulator.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 15274);
  const emulator = await startEmulator({ port });
  process.stdout.write(`[emulator] Scene Controller listening on 127.0.0.1:${emulator.port}\n`);
  process.stdout.write('[emulator] security key: any 16 characters\n');
}
