import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  broadcastTargets,
  candidateSubnets,
  directedBroadcast,
  isPrivateAddress,
  scanSubnets,
} from '../bridge/discovery.mjs';

test('directed broadcast is derived from address and netmask', () => {
  assert.equal(directedBroadcast('192.168.1.20', '255.255.255.0'), '192.168.1.255');
  assert.equal(directedBroadcast('10.4.3.2', '255.255.0.0'), '10.4.255.255');
  assert.equal(directedBroadcast('172.16.5.9', '255.255.255.240'), '172.16.5.15');
  assert.equal(directedBroadcast('nonsense', '255.255.255.0'), null);
});

test('broadcast targets include every non-internal interface, not just the limited one', () => {
  const interfaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    en0: [{ family: 'IPv4', address: '192.168.1.20', netmask: '255.255.255.0', internal: false }],
    en1: [{ family: 'IPv6', address: 'fe80::1', internal: false }],
  };
  const targets = broadcastTargets(undefined, interfaces);
  assert.ok(targets.includes('255.255.255.255'));
  assert.ok(targets.includes('192.168.1.255'), 'the directed broadcast is what actually works');
  assert.equal(targets.includes('127.255.255.255'), false, 'loopback is not probed');
});

test('an explicit seed contributes its subnet, for the container case', () => {
  const targets = broadcastTargets('10.1.2.3', {});
  assert.deepEqual(targets, ['255.255.255.255', '10.1.2.255']);
});

test('a public seed is ignored', () => {
  assert.deepEqual(broadcastTargets('8.8.8.8', {}), ['255.255.255.255']);
});

test('candidate subnets prefer the browser hint over anything else', () => {
  const interfaces = {
    eth0: [{ family: 'IPv4', address: '172.22.0.5', netmask: '255.255.0.0', internal: false }],
  };
  const subnets = candidateSubnets({ hint: '192.168.1.20', seed: '10.0.0.4', interfaces });
  assert.deepEqual(subnets, ['192.168.1', '10.0.0', '172.22.0']);
});

test('candidate subnets drop public and malformed hints', () => {
  assert.deepEqual(candidateSubnets({ hint: 'localhost', seed: '', interfaces: {} }), []);
  assert.deepEqual(candidateSubnets({ hint: '203.0.113.5', seed: '', interfaces: {} }), []);
});

test('private address detection covers the RFC1918 ranges', () => {
  for (const address of ['10.0.0.1', '192.168.4.5', '172.16.0.1', '172.31.255.254', '169.254.1.1']) {
    assert.ok(isPrivateAddress(address), `${address} should be private`);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '203.0.113.9']) {
    assert.equal(isPrivateAddress(address), false, `${address} should not be private`);
  }
});

test('the subnet sweep finds a listener on the control port', async (t) => {
  // Bind the loopback subnet so the sweep has something real to find without
  // touching the LAN. 127.0.0.x is entirely local on macOS and Linux.
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(15274, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const found = await scanSubnets(['127.0.0'], { port: 15274, timeoutMs: 200, concurrency: 32 });
  assert.ok(
    found.some((entry) => entry.host === '127.0.0.1'),
    `expected 127.0.0.1 among ${JSON.stringify(found)}`,
  );
  assert.equal(found[0].port, 15274);
  assert.equal(found[0].via, 'scan');
});

test('the sweep reports nothing when no port is open', async () => {
  // Port 1 is reserved and nothing will be listening on it.
  const found = await scanSubnets(['127.0.0'], { port: 1, timeoutMs: 100, concurrency: 64 });
  assert.deepEqual(found, []);
});
