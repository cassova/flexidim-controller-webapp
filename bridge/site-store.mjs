/**
 * Persistent record of the systems this installation knows about.
 *
 * Saved on the server rather than in the browser so the details survive a
 * reboot, follow the deployment rather than the device, and mean the security
 * key is typed once ever instead of once per phone. Mount CONFIG_DIR on a
 * volume and a new container picks up where the old one left off.
 *
 * The key is stored in clear text, because the controller protocol needs the
 * literal 16 characters to authenticate and there is nothing to verify a hash
 * against. The file is written 0600 and the directory 0700, and the key is
 * never sent back to a browser — the browser asks to connect to a *host* and
 * the bridge supplies the key from here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const CONFIG_DIR = process.env.CONFIG_DIR ?? './config';
const FILE = path.join(CONFIG_DIR, 'sites.json');
const VERSION = 1;

const EMPTY = { version: VERSION, sites: [], lastUsedHost: null };

function sanitize(record) {
  if (!record || typeof record !== 'object') return { ...EMPTY };
  const sites = Array.isArray(record.sites) ? record.sites : [];
  return {
    version: VERSION,
    lastUsedHost: typeof record.lastUsedHost === 'string' ? record.lastUsedHost : null,
    sites: sites
      .filter((site) => site && typeof site.host === 'string' && typeof site.securityKey === 'string')
      .map((site) => ({
        host: site.host,
        port: Number(site.port) || undefined,
        label: typeof site.label === 'string' ? site.label : site.host,
        securityKey: site.securityKey,
      })),
  };
}

export async function readSites() {
  try {
    return sanitize(JSON.parse(await fs.readFile(FILE, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      process.stderr.write(`[flexidim-bridge] could not read ${FILE}: ${error.message}\n`);
    }
    return { ...EMPTY };
  }
}

async function write(record) {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Write-then-rename so a crash mid-write cannot leave a truncated file that
  // loses every saved system.
  const temporary = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, FILE);
  return record;
}

export async function saveSite({ host, port, label, securityKey }) {
  if (typeof host !== 'string' || host.trim() === '') throw new Error('a host is required');
  if (typeof securityKey !== 'string' || securityKey.length !== 16) {
    throw new Error('the security key must be exactly 16 characters');
  }
  const current = await readSites();
  const trimmed = host.trim();
  const next = {
    ...current,
    lastUsedHost: trimmed,
    sites: [
      ...current.sites.filter((site) => site.host !== trimmed),
      {
        host: trimmed,
        port: Number(port) || undefined,
        label: (label ?? '').trim() || trimmed,
        securityKey,
      },
    ],
  };
  return write(next);
}

export async function forgetSite(host) {
  const current = await readSites();
  const remaining = current.sites.filter((site) => site.host !== host);
  return write({
    ...current,
    sites: remaining,
    lastUsedHost:
      current.lastUsedHost === host ? (remaining[0]?.host ?? null) : current.lastUsedHost,
  });
}

/** Record which system was used most recently, for auto-connect on next load. */
export async function noteLastUsed(host) {
  const current = await readSites();
  if (current.lastUsedHost === host) return current;
  if (!current.sites.some((site) => site.host === host)) return current;
  return write({ ...current, lastUsedHost: host });
}

export async function findSite(host) {
  const { sites } = await readSites();
  return sites.find((site) => site.host === host) ?? null;
}

/** The browser-safe view: everything except the credential itself. */
export function redactSites(record) {
  return {
    lastUsedHost: record.lastUsedHost,
    sites: record.sites.map(({ host, port, label }) => ({ host, port, label, hasKey: true })),
  };
}

export const CONFIG_PATH = FILE;
