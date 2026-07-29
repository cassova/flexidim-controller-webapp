import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authRecord,
  decodeRecord,
  dimFrame,
  latin1,
  maxSubscribableChannel,
  normalizeSecurityKey,
  scaleLevel,
  siteTypeFromSiteId,
  splitRecords,
  subscribeFrame,
  switchFrame,
  unscaleLevel,
  UserDataAssembler,
  MARKER_FINAL,
  MARKER_UNCHANGED,
} from '../bridge/protocol.mjs';

const hex = (bytes) => Buffer.from(bytes).toString('hex');

test('dim frame matches the recovered five-byte template', () => {
  // -[JCLrootController sendChMsg:withTransition:] template f1 00 00 01 ff,
  // with channel at [1], level at [2] and transition at [3].
  assert.equal(hex(dimFrame(17, 100, 1)), 'f1116401ff');
  assert.equal(hex(dimFrame(1, 0, 0)), 'f1010000ff');
  assert.equal(hex(dimFrame(9, 50, 4)), 'f1093204ff');
});

test('switch frame matches the recovered four-byte template', () => {
  // Template f0 00 00 ff, switch at [1], button at [2].
  assert.equal(hex(switchFrame(1, 1)), 'f00101ff');
  assert.equal(hex(switchFrame(3, 8)), 'f00308ff');
});

test('no command frame may contain a stray terminator', () => {
  assert.throws(() => dimFrame(0xff, 10, 1), /frame terminator/);
  assert.throws(() => switchFrame(2, 0xff), /frame terminator/);
  assert.throws(() => dimFrame(5, 300, 1), /0\.\.254/);
  assert.throws(() => dimFrame(5, -1, 1), /0\.\.254/);
});

test('subscription frame packs seven channels per byte', () => {
  const { frame } = subscribeFrame([1], 0);
  assert.equal(frame.length, 21);
  assert.equal(frame[0], 0xf9);
  assert.equal(frame[20], 0xff);
  assert.equal(frame[1], 0b0000001, 'channel 1 is bit 0 of the first bitmap byte');

  assert.equal(subscribeFrame([7], 0).frame[1], 0b1000000, 'channel 7 is bit 6');
  assert.equal(subscribeFrame([8], 0).frame[2], 0b0000001, 'channel 8 starts the next byte');
  assert.equal(subscribeFrame([14], 0).frame[2], 0b1000000);
  assert.equal(subscribeFrame([15], 0).frame[3], 0b0000001);
});

test('a full bitmap byte is 0x7f and can never be mistaken for a terminator', () => {
  const { frame } = subscribeFrame([1, 2, 3, 4, 5, 6, 7], 0);
  assert.equal(frame[1], 0x7f);
  const body = frame.subarray(0, frame.length - 1);
  assert.ok(!body.includes(0xff), 'only the final byte may be 0xff');
});

test('subscription capacity depends on site type', () => {
  assert.equal(maxSubscribableChannel(0), 133);
  assert.equal(maxSubscribableChannel(1), 133);
  assert.equal(maxSubscribableChannel(2), 259);
  assert.equal(subscribeFrame([], 2).frame.length, 39);
});

test('out-of-range channels are reported rather than silently dropped', () => {
  const { frame, skipped } = subscribeFrame([1, 200, 0, -3], 0);
  assert.deepEqual(skipped, [200, 0, -3]);
  assert.equal(frame[1], 0b0000001);
});

test('authentication record is key + six-digit nonce + 0xff in Latin-1', () => {
  const record = authRecord('0123456789abcdef', 533720);
  assert.equal(record.length, 23);
  assert.equal(latin1(record.subarray(0, 16)), '0123456789abcdef');
  assert.equal(latin1(record.subarray(16, 22)), '533720');
  assert.equal(record[22], 0xff);
});

test('authentication nonce is zero-padded to exactly six digits', () => {
  const record = authRecord('0123456789abcdef', 42);
  assert.equal(latin1(record.subarray(16, 22)), '000042');
  assert.equal(record.length, 23);
});

test('authentication rejects keys that are not 16 printable ASCII characters', () => {
  assert.throws(() => authRecord('short', 1), /exactly 16/);
  assert.throws(() => authRecord('0123456789abcdeÿ', 1), /printable ASCII/);
});

test('a key typed in the four-group display form authenticates identically', () => {
  // The configuration app shows keys as "s62a elti j8kf mcan"; the spaces are
  // presentation only and the wire value is the 16 characters.
  const spaced = authRecord('s62a elti j8kf mcan', 1);
  const plain = authRecord('s62aeltij8kfmcan', 1);
  assert.deepEqual([...spaced], [...plain]);
  assert.equal(spaced.length, 23);
});

test('security key normalization strips whitespace but preserves case', () => {
  assert.equal(normalizeSecurityKey('s62a elti j8kf mcan'), 's62aeltij8kfmcan');
  assert.equal(normalizeSecurityKey('  s62aeltij8kfmcan \n'), 's62aeltij8kfmcan');
  assert.equal(normalizeSecurityKey('S62AELTIJ8KFMCAN'), 'S62AELTIJ8KFMCAN');
  assert.equal(normalizeSecurityKey(undefined), '');
});

test('level scaling follows the recovered chType clamp', () => {
  // chType 0: the percentage passes through untouched.
  assert.equal(scaleLevel(100, 0), 100);
  assert.equal(scaleLevel(37, 0), 37);
  // chType 1: an on/off channel whose maximum wire value is 1.
  assert.equal(scaleLevel(100, 1), 1);
  assert.equal(scaleLevel(1, 1), 0);
  assert.equal(scaleLevel(0, 1), 0);
  // An intermediate maximum scales and clamps.
  assert.equal(scaleLevel(100, 80), 80);
  assert.equal(scaleLevel(50, 80), 40);
});

test('level unscaling round-trips the dimmable case', () => {
  for (const percent of [0, 1, 25, 50, 99, 100]) {
    assert.equal(unscaleLevel(scaleLevel(percent, 0), 0), percent);
  }
  assert.equal(unscaleLevel(1, 1), 100);
  assert.equal(unscaleLevel(0, 1), 0);
});

test('records are split on the 0xff terminator and partials are carried over', () => {
  const stream = Uint8Array.from([0xf0, 0x31, 0x7c, 0x39, 0xff, 0xf0, 0x32]);
  const { records, rest } = splitRecords(stream);
  assert.equal(records.length, 1);
  assert.equal(latin1(records[0]), 'ð1|9');
  assert.equal(hex(rest), 'f032');
});

test('level records decode address and level as ASCII decimal', () => {
  const encode = (text) => Uint8Array.from([0xf0, ...[...text].map((c) => c.charCodeAt(0))]);
  assert.deepEqual(decodeRecord(encode('17|100')), { type: 'level', channel: 17, level: 100 });
  assert.deepEqual(decodeRecord(encode('1|0')), { type: 'level', channel: 1, level: 0 });
});

test('user-data records carry a 14-bit marker, low seven bits first', () => {
  const record = Uint8Array.from([0xf8, 0x7f, 0x7f, 0x41, 0x42]);
  assert.deepEqual(decodeRecord(record), { type: 'userData', marker: MARKER_FINAL, chunk: 'AB' });

  const first = Uint8Array.from([0xf8, 0x00, 0x00, 0x41]);
  assert.equal(decodeRecord(first).marker, 0);

  const second = Uint8Array.from([0xf8, 0x01, 0x00, 0x41]);
  assert.equal(decodeRecord(second).marker, 1);

  // 0x0080 needs the high byte: 0 | (1 << 7).
  const eightyOne = Uint8Array.from([0xf8, 0x00, 0x01, 0x41]);
  assert.equal(decodeRecord(eightyOne).marker, 128);
});

test('user data reassembles across chunks and completes on the final marker', () => {
  const assembler = new UserDataAssembler();
  assert.deepEqual(assembler.push(0, 'hello '), { state: 'collecting' });
  assert.deepEqual(assembler.push(1, 'brave '), { state: 'collecting' });
  assert.deepEqual(assembler.push(MARKER_FINAL, 'world'), {
    state: 'complete',
    text: 'hello brave world',
  });
  // The assembler is reusable for the next profile.
  assert.deepEqual(assembler.push(MARKER_FINAL, 'again'), { state: 'complete', text: 'again' });
});

test('the unchanged marker reports no new profile and discards partials', () => {
  const assembler = new UserDataAssembler();
  assembler.push(0, 'partial');
  assert.deepEqual(assembler.push(MARKER_UNCHANGED, ''), { state: 'unchanged' });
  assert.deepEqual(assembler.push(MARKER_FINAL, 'fresh'), { state: 'complete', text: 'fresh' });
});

test('site type comes from the fifth character of the site id', () => {
  assert.equal(siteTypeFromSiteId('FD4-0EST'), 0);
  assert.equal(siteTypeFromSiteId('FD4-2EST'), 2);
  assert.equal(siteTypeFromSiteId('tiny'), 0);
});
