import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseUserProfile,
  physicalSceneButtons,
  redactProfile,
  subscribableChannels,
  SWITCH_FLAG_EIGHT_SCENE,
  SWITCH_FLAG_FOUR_SCENE,
} from '../bridge/user-profile.mjs';

/**
 * Wholly synthetic profile in the exact shape the original iOS configuration
 * app compiles. Two rooms on one unnamed floor, one switch each, three
 * channels in total. No real site, key, name or address appears here.
 */
const SAMPLE =
  '0011223344556677|Owner|CFG1:0001|1||2' +
  '|Lounge|3|0|1|2' +
  '|Lounge Switch|1|0|Relax|Bright|||||||||||||||Up||Down||||On Off|' +
  '|Lounge Ceiling|1|1|Lounge Lamps|2|1' +
  '|Kitchen|10|0|1|1' +
  '|Kitchen Switch|2|1|Bright||||||||||||||||Up||Down||||On Off|' +
  '|Kitchen Spots|9|1|';

test('the sample payload parses into the expected shape', () => {
  const profile = parseUserProfile(SAMPLE);
  assert.equal(profile.securityCode, '0011223344556677');
  assert.equal(profile.userName, 'Owner');
  assert.equal(profile.siteId, 'CFG1:0001');
  assert.equal(profile.areas.length, 1);
  assert.equal(profile.areas[0].name, '');
  assert.equal(profile.rooms.length, 2);
  assert.deepEqual(profile.warnings, []);
});

test('rooms carry their icon and attach to the area named by their index', () => {
  const profile = parseUserProfile(SAMPLE);
  const [lounge, kitchen] = profile.rooms;
  assert.equal(lounge.name, 'Lounge');
  assert.equal(lounge.icon, 3);
  assert.equal(kitchen.icon, 10);
  // The third room integer is the area-table index, not a hardware type.
  assert.equal(lounge.areaIndex, 0);
  assert.deepEqual(profile.areas[0].rooms.map((r) => r.name), ['Lounge', 'Kitchen']);
});

test('switches expose only their populated button slots, one-based', () => {
  const profile = parseUserProfile(SAMPLE);
  const lounge = profile.rooms[0].switches[0];
  assert.equal(lounge.name, 'Lounge Switch');
  assert.equal(lounge.number, 1);
  assert.equal(lounge.flag, SWITCH_FLAG_EIGHT_SCENE);
  assert.ok(lounge.usable);
  assert.deepEqual(lounge.buttons, [
    { button: 1, label: 'Relax' },
    { button: 2, label: 'Bright' },
    { button: 17, label: 'Up' },
    { button: 19, label: 'Down' },
    { button: 23, label: 'On Off' },
  ]);

  const kitchen = profile.rooms[1].switches[0];
  assert.equal(kitchen.flag, SWITCH_FLAG_FOUR_SCENE);
  assert.equal(kitchen.number, 2);
});

test('logical scene assignments are paired into physical controller buttons', () => {
  assert.deepEqual(
    physicalSceneButtons({
      flag: SWITCH_FLAG_FOUR_SCENE,
      buttons: [
        { button: 1, label: 'Night' },
        { button: 5, label: 'Song on' },
        { button: 6, label: 'Snug off' },
        // Built-in profile labels are not scene buttons.
        { button: 17, label: 'Up' },
      ],
    }),
    [
      { button: 1, firstLabel: 'Night', secondLabel: undefined },
      { button: 3, firstLabel: 'Song on', secondLabel: 'Snug off' },
    ],
  );
});

test('channels carry their controller address and dimmability', () => {
  const profile = parseUserProfile(SAMPLE);
  assert.deepEqual(
    profile.channels.map((c) => [c.name, c.address, c.channelType, c.dimmable]),
    [
      ['Lounge Ceiling', 1, 1, false],
      ['Lounge Lamps', 2, 1, false],
      ['Kitchen Spots', 9, 1, false],
    ],
  );
  // Module position 1, channel 1 addresses as 9 — not (module << 4) | channel.
  assert.equal(profile.rooms[1].channels[0].address, 9);
});

test('a chType of 0 marks a fully dimmable channel', () => {
  const payload = '0011223344556677|Owner|CFG1:0001|1|Ground|1|Hall|0|0|0|1|Hall Lights|4|0|';
  const profile = parseUserProfile(payload);
  const channel = profile.channels[0];
  assert.equal(channel.channelType, 0);
  assert.ok(channel.dimmable);
});

test('subscription list is deduplicated and sorted', () => {
  const profile = parseUserProfile(SAMPLE);
  assert.deepEqual(subscribableChannels(profile), [1, 2, 9]);
});

test('trailing NUL padding from the chunk stream is stripped', () => {
  const profile = parseUserProfile(`${SAMPLE}\0\0\0\0`);
  assert.equal(profile.rooms.length, 2);
});

test('interior empty fields are preserved as data', () => {
  // One area whose name is genuinely empty, then a room. Collapsing the empty
  // field would shift every following index by one.
  const profile = parseUserProfile('code|user|site|1||1|Room|0|0|0|0|');
  assert.equal(profile.areas.length, 1);
  assert.equal(profile.areas[0].name, '');
  assert.equal(profile.rooms[0].name, 'Room');
});

test('a switch with no controller address is flagged unusable, not dropped', () => {
  const buttons = new Array(24).fill('').join('|');
  const payload = `code|user|site|1|Ground|1|Room|0|0|1|0|Spare|0|9|${buttons}|`;
  const profile = parseUserProfile(payload);
  const spare = profile.rooms[0].switches[0];
  assert.equal(spare.usable, false);
  assert.match(profile.warnings[0], /cannot be pressed/);
});

test('a room pointing at a missing area is reported', () => {
  const profile = parseUserProfile('code|user|site|1|Ground|1|Room|0|7|0|0|');
  assert.match(profile.warnings[0], /unknown area index 7/);
  assert.equal(profile.rooms.length, 1, 'the room still parses');
});

test('a truncated switch record fails loudly rather than mis-indexing', () => {
  const payload = 'code|user|site|1|Ground|1|Room|0|0|1|0|Half|1|0|A|B|';
  assert.throws(() => parseUserProfile(payload), /truncated at button/);
});

test('a non-numeric count fails loudly', () => {
  assert.throws(() => parseUserProfile('code|user|site|many|'), /area count is not a number/);
});

test('empty input is rejected', () => {
  assert.throws(() => parseUserProfile(''), /empty user-profile payload/);
  assert.throws(() => parseUserProfile(undefined), /empty user-profile payload/);
});

test('redaction removes the security code before the browser sees the profile', () => {
  const profile = parseUserProfile(SAMPLE);
  const safe = redactProfile(profile);
  assert.equal(safe.securityCode, undefined);
  assert.equal(safe.hasSecurityCode, true);
  assert.equal(safe.userName, 'Owner');
  assert.equal(JSON.stringify(safe).includes('0011223344556677'), false);
});
