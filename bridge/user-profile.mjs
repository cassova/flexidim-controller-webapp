/**
 * Parser for the FlexiDim user-profile payload.
 *
 * The controller sends this text after a client authenticates. It is the only
 * description of the installation the controller app ever receives: there is no
 * local configuration file and no `.fd4cfg` involved. Everything the UI shows —
 * areas, rooms, switches, buttons, channels — comes from here.
 *
 * The format is a single line of `|`-separated fields with no CR or LF and no
 * escaping mechanism. Structure is positional and driven by embedded counts.
 * Trailing `|` means a naive split yields one extra empty element.
 *
 *   <securityCode> | <userName> | <siteId> | <areaCount>
 *   <areaName> * areaCount
 *   <roomCount>
 *   ( <roomName> | <icon> | <areaIndex> | <switchCount> | <channelCount>
 *     ( <switchName> | <switchNumber> | <switchFlag> | <button> * 24 ) * switchCount
 *     ( <channelName> | <channelAddress> | <channelType> )      * channelCount
 *   ) * roomCount
 *
 * Recovered from the record-complete branch of
 * `-[JCLrootController stream:handleEvent:]`, which walks exactly these
 * indices. Cross-checked against the configuration app's producer for the same
 * payload (`app/compile-user-profiles.ts` in flexidim-configuration-webapp),
 * which is oracle-proven byte-identical to the original iOS compiler.
 */

export const BUTTON_SLOTS = 24;
export const SWITCH_FIELDS = 3 + BUTTON_SLOTS;
export const CHANNEL_FIELDS = 3;

/** Switch flag values from the payload's third switch field. */
export const SWITCH_FLAG_UNASSIGNED = 9;  // switch has no hardware number
export const SWITCH_FLAG_EIGHT_SCENE = 0; // hardware type 15
export const SWITCH_FLAG_FOUR_SCENE = 1;  // everything else, e.g. type 13

/**
 * Pair the profile's logical scene slots into the physical buttons sent on f0.
 *
 * A physical button P owns two configuration assignments: first press is
 * logical slot 2P-1 and second press is slot 2P. The control protocol accepts
 * P, not either logical slot; the Scene Controller decides which assignment
 * applies from its installed configuration and state.
 */
export function physicalSceneButtons(wallSwitch) {
  const physicalCount = wallSwitch.flag === SWITCH_FLAG_EIGHT_SCENE ? 8 : 4;
  const labels = new Map(wallSwitch.buttons.map(({ button, label }) => [button, label]));
  const result = [];
  for (let button = 1; button <= physicalCount; button += 1) {
    const firstLabel = labels.get(button * 2 - 1);
    const secondLabel = labels.get(button * 2);
    if (firstLabel || secondLabel) result.push({ button, firstLabel, secondLabel });
  }
  return result;
}

class ProfileFormatError extends Error {
  constructor(message, index) {
    super(index === undefined ? message : `${message} (at field ${index})`);
    this.name = 'ProfileFormatError';
    this.fieldIndex = index;
  }
}

export { ProfileFormatError };

function intAt(fields, index, what) {
  const raw = fields[index];
  if (raw === undefined) throw new ProfileFormatError(`missing ${what}`, index);
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new ProfileFormatError(`${what} is not a number`, index);
  }
  return value;
}

function textAt(fields, index, what) {
  const raw = fields[index];
  if (raw === undefined) throw new ProfileFormatError(`missing ${what}`, index);
  return raw;
}

/**
 * Parse a complete user-profile payload.
 *
 * @param {string} payload the reassembled `f8` text
 * @returns {{securityCode:string,userName:string,siteId:string,areas:Array,rooms:Array,channels:Array,switches:Array,warnings:string[]}}
 */
export function parseUserProfile(payload) {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new ProfileFormatError('empty user-profile payload');
  }

  // Strip NUL padding left by the fixed-size chunking, then the single trailing
  // delimiter. Only one empty element is dropped: interior empties are data.
  const cleaned = payload.replace(/\0+$/, '');
  const fields = cleaned.split('|');
  if (fields.length && fields[fields.length - 1] === '') fields.pop();

  const warnings = [];
  const securityCode = textAt(fields, 0, 'security code');
  const userName = textAt(fields, 1, 'user name');
  const siteId = textAt(fields, 2, 'site id');
  const areaCount = intAt(fields, 3, 'area count');
  if (areaCount < 0) throw new ProfileFormatError('negative area count', 3);

  const areas = [];
  for (let i = 0; i < areaCount; i += 1) {
    areas.push({ index: i, name: textAt(fields, 4 + i, `area ${i} name`), rooms: [] });
  }

  let cursor = 4 + areaCount;
  const roomCount = intAt(fields, cursor, 'room count');
  cursor += 1;

  const rooms = [];
  const allSwitches = [];
  const allChannels = [];

  for (let r = 0; r < roomCount; r += 1) {
    const name = textAt(fields, cursor, `room ${r} name`);
    const icon = intAt(fields, cursor + 1, `room ${r} icon`);
    const areaIndex = intAt(fields, cursor + 2, `room ${r} area index`);
    const switchCount = intAt(fields, cursor + 3, `room ${r} switch count`);
    const channelCount = intAt(fields, cursor + 4, `room ${r} channel count`);
    cursor += 5;

    const room = {
      id: `room-${r}`,
      index: r,
      name,
      icon,
      areaIndex,
      switches: [],
      channels: [],
    };

    for (let s = 0; s < switchCount; s += 1) {
      const swName = textAt(fields, cursor, `room ${r} switch ${s} name`);
      const number = intAt(fields, cursor + 1, `room ${r} switch ${s} number`);
      const flag = intAt(fields, cursor + 2, `room ${r} switch ${s} flag`);
      const buttons = [];
      for (let b = 0; b < BUTTON_SLOTS; b += 1) {
        const label = fields[cursor + 3 + b];
        if (label === undefined) {
          throw new ProfileFormatError(
            `room ${r} switch ${s} is truncated at button ${b + 1}`,
            cursor + 3 + b,
          );
        }
        // These are one-based logical assignment slots. Consecutive pairs are
        // folded into physical wire buttons below.
        if (label !== '') buttons.push({ button: b + 1, label });
      }
      cursor += SWITCH_FIELDS;

      const wallSwitch = {
        id: `switch-${r}-${s}`,
        roomId: room.id,
        roomName: name,
        name: swName,
        number,
        flag,
        usable: flag !== SWITCH_FLAG_UNASSIGNED && number > 0,
        buttons,
      };
      wallSwitch.sceneButtons = physicalSceneButtons(wallSwitch);
      if (!wallSwitch.usable) {
        warnings.push(`switch "${swName}" in ${name} has no controller address and cannot be pressed`);
      }
      room.switches.push(wallSwitch);
      allSwitches.push(wallSwitch);
    }

    for (let c = 0; c < channelCount; c += 1) {
      const chName = textAt(fields, cursor, `room ${r} channel ${c} name`);
      const address = intAt(fields, cursor + 1, `room ${r} channel ${c} address`);
      const channelType = intAt(fields, cursor + 2, `room ${r} channel ${c} type`);
      cursor += CHANNEL_FIELDS;

      const channel = {
        id: `channel-${address}`,
        roomId: room.id,
        roomName: name,
        name: chName,
        address,
        channelType,
        // chType 1 means the channel's maximum wire value is 1: it is on/off,
        // not dimmable. 0 means unrestricted 0..100.
        dimmable: channelType !== 1,
        level: 0,
      };
      room.channels.push(channel);
      allChannels.push(channel);
    }

    rooms.push(room);
    const area = areas[areaIndex];
    if (area) area.rooms.push(room);
    else warnings.push(`room "${name}" refers to unknown area index ${areaIndex}`);
  }

  if (cursor < fields.length) {
    warnings.push(`${fields.length - cursor} unparsed trailing field(s) in user profile`);
  }

  return { securityCode, userName, siteId, areas, rooms, switches: allSwitches, channels: allChannels, warnings };
}

/**
 * The set of channel addresses to subscribe to, deduplicated and sorted.
 */
export function subscribableChannels(profile) {
  const seen = new Set();
  for (const channel of profile.channels) {
    if (Number.isInteger(channel.address) && channel.address > 0) seen.add(channel.address);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Strip the security code before the profile crosses the bridge to the browser.
 * The browser needs the model, never the credential.
 */
export function redactProfile(profile) {
  const { securityCode, ...rest } = profile;
  return { ...rest, hasSecurityCode: Boolean(securityCode) };
}
