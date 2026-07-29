import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The store reads CONFIG_DIR once at import, so point it at a scratch directory
// before importing it.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flexidim-sites-'));
process.env.CONFIG_DIR = dir;

const store = await import('../bridge/site-store.mjs');

test.after(() => fs.rm(dir, { recursive: true, force: true }));

const KEY = '0123456789abcdef';

test('an empty store reads as no sites rather than failing', async () => {
  const record = await store.readSites();
  assert.deepEqual(record.sites, []);
  assert.equal(record.lastUsedHost, null);
});

test('a saved site round-trips and becomes the last used', async () => {
  await store.saveSite({ host: '10.0.0.5', label: 'Home', securityKey: KEY });
  const record = await store.readSites();
  assert.equal(record.sites.length, 1);
  assert.equal(record.sites[0].host, '10.0.0.5');
  assert.equal(record.sites[0].label, 'Home');
  assert.equal(record.sites[0].securityKey, KEY);
  assert.equal(record.lastUsedHost, '10.0.0.5');
});

test('saving the same host again replaces it instead of duplicating', async () => {
  await store.saveSite({ host: '10.0.0.5', label: 'Renamed', securityKey: 'ffffffffffffffff' });
  const record = await store.readSites();
  assert.equal(record.sites.length, 1);
  assert.equal(record.sites[0].label, 'Renamed');
  assert.equal(record.sites[0].securityKey, 'ffffffffffffffff');
});

test('the key file is not world readable', async () => {
  const stat = await fs.stat(store.CONFIG_PATH);
  assert.equal(stat.mode & 0o077, 0, 'group and other must have no access');
});

test('a short key is refused, so a broken record cannot be persisted', async () => {
  await assert.rejects(
    () => store.saveSite({ host: '10.0.0.9', securityKey: 'short' }),
    /exactly 16 characters/,
  );
});

test('findSite returns the stored key for a host and null otherwise', async () => {
  assert.equal((await store.findSite('10.0.0.5')).securityKey, 'ffffffffffffffff');
  assert.equal(await store.findSite('10.0.0.99'), null);
});

test('redaction removes every key before the list reaches a browser', async () => {
  const safe = store.redactSites(await store.readSites());
  assert.equal(JSON.stringify(safe).includes('ffffffffffffffff'), false);
  assert.equal(safe.sites[0].hasKey, true);
  assert.equal(safe.sites[0].securityKey, undefined);
});

test('forgetting the last-used site moves the pointer to a survivor', async () => {
  await store.saveSite({ host: '10.0.0.6', label: 'Other', securityKey: KEY });
  let record = await store.readSites();
  assert.equal(record.lastUsedHost, '10.0.0.6');

  record = await store.forgetSite('10.0.0.6');
  assert.equal(record.sites.length, 1);
  assert.equal(record.lastUsedHost, '10.0.0.5', 'auto-connect must not point at a deleted site');
});

test('a corrupt file degrades to an empty store instead of crashing the bridge', async () => {
  await fs.writeFile(store.CONFIG_PATH, 'not json at all');
  const record = await store.readSites();
  assert.deepEqual(record.sites, []);
});
