# FlexiDim controller protocol

This document describes how the original **FlexiDim** iOS app (version 2.61,
`com.jclighting.flexidim1`) controls a JC Lighting Scene Controller, and how
FlexiDim Controller Web reproduces it.

The protocol was reconstructed without source code, from the app's arm64
Objective-C metadata and machine code. Treat the confidence labels as part of
the specification:

- **Binary verified** — recovered directly from the iOS executable, with the
  address of the recovering method given.
- **Hardware verified** — additionally observed working against a real Scene
  Controller.
- **Inferred** — consistent with the binary but not proven; the exact bytes or
  semantics still need a capture.
- **Unknown** — evidence exists that something is there, but not what.

Nothing in this project is hardware verified yet. Every claim below is binary
verified unless stated otherwise.

## This is not the configuration protocol

The sibling project `flexidim-configuration-webapp` documents a *different*
protocol on **TCP port 15273**: `ff f3`-prefixed frames, CRC-16/X25 checksums
and `1b` escaping.

The controller app speaks a **separate service on TCP port 15274**. It has:

- no CRC of any kind,
- no `1b` escaping,
- a different frame vocabulary,
- and a completely different model of the installation.

Two services, two protocols. Do not carry assumptions between the documents.
`0xf0` means "switch press" from the client here and "channel level report"
from the controller, and neither is the configuration protocol's `f0`.

## Architecture

Browsers cannot open raw TCP or UDP sockets, so the webapp uses a loopback
bridge, exactly as the configuration project does:

```text
Browser / PWA
    │ JSON over WebSocket ws://127.0.0.1:8765
    ▼
Local Node.js bridge
    │ FlexiDim over TCP 15274 on the home LAN
    ▼
Scene Controller
```

The bridge binds `127.0.0.1` and refuses cross-origin WebSocket upgrades.
Controller traffic never leaves the LAN.

## Discovery — binary verified

From `-[JCLrootController initUDPSocket:]` (`0x10001af94`):

1. Bind UDP port **15001** (`0x3a99`).
2. Enable broadcast.
3. Send the four ASCII bytes `FLEX` to **255.255.255.255:15270** (`0x3ba6`).
4. The source address of the reply is the controller.

This is byte-identical to the configuration app's discovery, so a controller
answers one probe for both services. Only the reply's *source address* is used;
its payload is ignored.

**Hardware verified 2026-07-29:** a real controller answered this probe and was
located on the LAN.

Two webapp-side departures, neither part of the recovered protocol:

- Replies from non-private IPv4 addresses are ignored. The reply is
  unauthenticated, so a wide-area answer would be a redirection attempt.
- The probe is sent to the **directed broadcast of every non-internal IPv4
  interface** (`192.168.1.255` for a `192.168.1.x/24` interface) as well as to
  `255.255.255.255`. The limited broadcast alone is not enough: macOS rejects it
  with `EHOSTUNREACH` because the routing table will not choose an interface for
  it, and in a container it reaches only the container subnet. The directed
  broadcast is what actually finds the controller.

UDP discovery does **not** work from inside a Docker Desktop container on macOS
even with the correct target address — the probe leaves but no reply returns.
Host networking on Linux (`compose.host-network.yaml`) fixes the UDP path.

When UDP returns no controller, the bridge automatically falls back to a
bounded TCP sweep for port 15274. The browser includes the private IPv4 address
from which it loaded the app as the preferred `/24` hint; an explicit
`FLEXIDIM_DISCOVERY_SEED` and the bridge's interfaces are secondary candidates.
This lets ordinary Docker bridge networking discover a controller because TCP
connections route out of the container even though UDP broadcasts and their
replies do not. An open port is reported as a candidate and is authenticated
only when the user connects with the controller's security key.

## Connection and authentication — binary verified

`-[JCLrootController initTCPto:onPort:channel:]` (`0x10001aae4`) opens a
CFStream pair to the controller and starts a 15-second open timeout. The port
comes from the app's own constant **15274** (`0x3baa`, loaded in `viewDidLoad`,
`loadKnownSites` and `retryUDPInit:`).

On the stream's open event the app immediately writes a 23-byte record:

```text
<16 ASCII security-key bytes><six ASCII decimal nonce digits><ff>
```

Built as `[NSString stringWithFormat:@"%@%06d%c", key, nonce, 0xff]` and encoded
with **`NSISOLatin1StringEncoding` (5)**. The encoding matters: Latin-1 emits the
trailing `0xFF` as one byte where UTF-8 would emit two.

The nonce is `arc4random() % 1000000`, zero-padded to six digits. It is not a
challenge response — the controller sends nothing to derive one from — so any
value in range is accepted.

After writing the record the app sets its internal `lTcpState` ivar to **4**,
which is the gate every send path checks, and its UI-facing `tcpState` to 2.

The security key is the 16-character **user** security key from the
configuration's Users list, not the site's controller security code. Different
users get different keys and therefore different room access.

**Spaces are presentation only.** The configuration app displays a key as four
groups of four, `s62a elti j8kf mcan`, but the stored and transmitted value is
the 16 characters with no spaces. The iOS controller app performs no
normalization whatsoever — its only input rule is a hard 16-character limit
(`-[JCLSiteCell textField:shouldChangeCharactersInRange:replacementString:]`
at `0x100025700`, which returns whether the resulting length is below 17), so a
key typed with its displayed spaces would not even fit the field. FlexiDim
Controller Web strips whitespace on entry and leaves case alone: generated keys
are lowercase base-36, but nothing stops a hand-set key containing uppercase and
silently folding it would break that key invisibly.

There is **no acknowledgement**. A wrong key produces silence and, eventually,
the controller closing the socket. The webapp reports that as a probable bad key
after 15 seconds rather than inventing an error the protocol does not have.

## Framing

Every frame in **both** directions is terminated by a single `0xFF` byte, and
`0xFF` may not appear anywhere else inside a frame. There is no length field, no
checksum and no escape mechanism — the terminator is the entire framing.

The subscription bitmap packs only seven channels per byte specifically so that
a fully-populated bitmap byte is `0x7F` and can never collide with the
terminator.

### Client-to-controller frames

| Frame | Bytes | Source |
| --- | --- | --- |
| Switch press | `f0 <switch> <button> ff` | `-sendSwMsg:button:` (`0x100020584`) |
| Dim channel | `f1 <channel> <level> <transition> ff` | `-sendChMsg:withTransition:` (`0x1000206c8`) |
| Subscribe | `f9 <bitmap…> ff` | `-registerForUpdates:` (`0x100020a80`) |

All three are gated on `lTcpState == 4` **and** the output stream reporting
`NSStreamStatusOpen`.

#### Dim (`f1`)

The literal template at `0x10002e2e0` is `f1 00 00 01 ff`; the method overwrites
bytes 1, 2 and 3 and writes 5 bytes.

| Field | Meaning |
| --- | --- |
| `channel` | One-based controller channel address |
| `level` | Wire level, already scaled (see below) |
| `transition` | Half-second ticks. The template's resting value is `1` (0.5 s) |

Before building the frame the method scales the requested level:

```c
if (chType != 0) {
    level = level * chType / 100;
    if (level > chType) level = chType;
}
```

`chType` is the channel's **maximum wire value**, taken from the third field of
its user-profile channel record. A `chType` of `0` means "send the percentage
unchanged", which is what dimmable channels use. A `chType` of `1` is an on/off
channel whose only levels are `0` and `1` — such a channel is *not* driven with
0 and 100.

#### Switch press (`f0`)

Template at `0x10002e2d0` is `f0 00 00 ff`; bytes 1 and 2 are overwritten and
4 bytes are written.

`switch` is the controller's hardware switch number, which is the second field
of the profile's switch record. `button` is the physical button code.

`-[JCLViewController buttonPress:]` (`0x10002944c`) sends the pressed
`UIButton`'s `tag` verbatim as the button code, and explicitly skips tags 9 and
10, which are the Up/Down dim controls handled by the dim path instead. It does
not track first/second-press state locally.

The profile's button labels are **logical assignment slots**, not wire button
codes. Each physical scene button `P` owns two consecutive assignments:
`2P-1` is its first-press scene and `2P` is its optional second-press scene.
Both must therefore be rendered as one physical control which sends `P`. The
Scene Controller, not the browser or iOS app, decides which assignment applies
from its installed configuration and current state. An eight-scene plate uses
physical codes 1–8 (logical slots 1–16); a four-scene plate uses physical codes
1–4 (logical slots 1–8).

*Inferred:* whether the built-in slots 17/19/23 (`Up`/`Down`/`On Off`) can be
sent as button codes. The original app never does — it drives them through the
dim path — so this webapp does not offer them as buttons either.

#### Subscribe (`f9`)

The frame is a bitmap of the channels the client wants reported:

- byte 0 is `f9`;
- bitmap bytes start at offset 1;
- for a one-based channel `n`, set bit `(n-1) % 7` of bitmap byte
  `1 + (n-1) / 7`;
- the last byte is `ff`.

The frame length depends on the site type, from the three branches of
`registerForUpdates:`:

| Site type | Frame length | Bitmap bytes | Highest channel |
| --- | --- | --- | --- |
| `0`, `1` | 21 | 19 | 133 |
| `2` | 39 | 37 | 259 |

Site type is the fifth character of the site ID, compared against ASCII `'1'`
(`0x31`) and `'2'` (`0x32`). Types 1 and 2 wrap the frame in AES-CFB; only
type 0 (plaintext, local) is implemented here.

`registerForUpdates:` returns a boolean. `-processUpdatesForChannels:`
(`0x100020928`) retries on a 0.1-second timer until it succeeds, so a
subscription attempted before the link is ready is not lost.

### Controller-to-client records

The app reads the input stream as **Latin-1 text**, appends it to an
accumulator, and splits on `0xFF`. A message is complete when the accumulated
buffer's last character is `0xFF`. Each record's **first character** is its type.

#### `f0` — channel level

```text
f0<address>|<level>
```

Both values are ASCII decimal, separated by a literal `|`. The app parses the
two components and stores the level in a 256-entry byte table indexed by the
address. Records arrive once per subscribed channel immediately after a
subscription, and again whenever a level changes — including changes made by a
physical wall switch or another client.

#### `f8` — user profile

```text
f8<marker-lo7><marker-hi7><text chunk>
```

The 14-bit marker is little-endian across two seven-bit bytes:
`marker = lo | (hi << 7)`. This is the same chunk-marker scheme the
configuration protocol uses for its `ff f2` user transfer, which is strong
evidence that the controller is relaying the very payload the configuration app
compiled and stored.

| Marker | Meaning |
| --- | --- |
| `0` | first chunk; start a new profile |
| `1`, `2`, … | continuation chunks |
| `0x3fff` | final chunk; the profile is complete |
| `0x3ffe` | nothing has changed — keep the profile you already have |

Concatenate the chunks in arrival order, strip trailing NULs, and parse.

*Unknown:* whether a real controller ever sends `0x3ffe` to a client that has no
cached profile, and what it expects the client to do about it. The webapp
surfaces the state rather than silently hanging.

## The user-profile payload — binary verified

This text is the **only** description of the installation the controller app
receives. There is no local configuration file, no `.fd4cfg` and no cloud
lookup: areas, rooms, switches, buttons and channels all come from here, scoped
to the authenticated user's access rights.

It is a single line of `|`-separated fields. There are **no CR or LF characters
anywhere**, no escaping mechanism, and a trailing `|` after the final field.
Structure is positional and driven by embedded counts.

```text
<securityCode> | <userName> | <siteId> | <areaCount>
<areaName>  * areaCount
<roomCount>
( <roomName> | <icon> | <areaIndex> | <switchCount> | <channelCount>
  ( <switchName> | <switchNumber> | <switchFlag> | <buttonLabel> * 24 ) * switchCount
  ( <channelName> | <channelAddress> | <channelType> )                  * channelCount
) * roomCount
```

Recovered from the record-complete branch of `-[JCLrootController
stream:handleEvent:]`, which walks exactly these indices: areas are read from
index 4, the room count from `4 + areaCount`, and each room advances the cursor
by 5 plus its switch and channel records.

### Header

| Field | Meaning |
| --- | --- |
| 0 | The user's 16-character security key — the same value used to authenticate |
| 1 | User display name |
| 2 | Site ID, formatted `XXXX:YYYY` (a colon inserted after four characters) |
| 3 | Number of area (floor) names that follow |

Area names may be empty strings. A single-floor installation typically has
`areaCount` 1 and an empty name, giving the sequence `…|1||<roomCount>|…`.
Collapsing that empty field shifts every subsequent index by one.

### Room record

| Field | Meaning |
| --- | --- |
| name | Room short name |
| icon | Room image index; the app loads `RoomImage<N>.png` |
| areaIndex | **Zero-based index into the area-name table.** Not a hardware type |
| switchCount | Number of switch records that follow |
| channelCount | Number of channel records that follow |

The app looks the area up with `[clAreas objectAtIndex:areaIndex]` and appends
the room to that area's `arRooms`, which is what confirms the third integer's
meaning.

### Switch record — always 27 fields

| Field | Meaning |
| --- | --- |
| name | Switch name |
| number | Controller hardware switch number, used as the `f0` switch byte |
| flag | `0` = eight-scene plate (hardware type 15), `1` = four-scene, `9` = no hardware number |
| 24 button labels | Scene name per slot, or an empty string |

Slots are always 24 regardless of the plate's physical button count. Unused
slots are **empty strings, never `"0"`**. Slots 16, 18 and 22 (zero-based) carry
the built-in `Up`, `Down` and `On Off` labels when the switch has a Basic
Assignment.

A switch with flag `9` has no controller address and cannot be pressed. The
webapp shows it as unavailable rather than dropping it, so the room's contents
still match what the user sees on the wall.

### Channel record — always 3 fields

| Field | Meaning |
| --- | --- |
| name | Channel name |
| address | One-based controller address, used as the `f1` channel byte |
| channelType | Maximum wire level; `0` = dimmable 0–100, `1` = on/off |

The address is `modulePosition * 8 + channelIndex`, where `modulePosition` is
the module's zero-based slot in the site's stored module order. It is not
`(module << 4) | channel`.

**Open question.** The controller app's parser advances the cursor by exactly 3
fields per channel. The configuration app's compiler
(`app/compile-user-profiles.ts` in the sibling project, oracle-proven
byte-identical to the original iOS compiler) emits only 2 fields — name and
address, with no type suffix — for channels whose archived hardware code is 7 or
above. Those two behaviours cannot both be right for the same payload. Either
the suffix rule differs between the app versions, or the sibling project's
mutation-derived rule for hardware codes 7–255 is incomplete. This webapp
follows the controller app, because the controller app is the component that
successfully consumes real controller output. A capture from real hardware
resolves it; until then a site with such channels may mis-parse, which the
parser reports as a loud error rather than silently mis-indexing.

## Site types and encryption — binary verified, not implemented

`-[JCLrootController getCurrentSiteType]` derives the type from the site ID's
fifth character. The send paths branch on it:

- type `0` — plaintext on the local network. The only type implemented here.
- type `1` — `AESCFBEncode:length:` applied to each frame before writing.
- type `2` — same, with the larger 39-byte subscription frame.

`AESEncode:`, `AESDecode:`, `AESCFBEncode:length:` and `AESCFBDecode:length:`
exist at `0x100024a28`–`0x10002514c`, and the class keeps 16-byte `IVI`/`IVO`
buffers with separate counters. On connect for an encrypted session the app
reads 32 bytes and runs `AESEncode:` over both halves to establish them.

*Unknown:* the key schedule and how the IVs are derived. Not implemented.

## Remote access — binary verified, not implemented

The app can reach a controller through `flexidim.net` on port 15274, with a
different authentication record (`@"%@%04d%c%c%c"`) and a `RemSID`/`RemPIP`/
`RemSEC` table of remote credentials. That service no longer exists — JC
Lighting is out of business — so there is nothing to connect to and it is not
implemented.

## Browser-to-bridge protocol

The browser sends JSON over the loopback WebSocket:

| Type | Fields | Bridge action |
| --- | --- | --- |
| `discover` | `timeoutMs` | UDP `FLEX` broadcast; reply with the hosts found |
| `connect` | `host`, `port`, `securityKey` | Open TCP, authenticate, await the profile, subscribe |
| `dim` | `channel`, `percent`, `transition` | Scale by the channel's type and send `f1` |
| `press` | `switch`, `button` | Send `f0` |
| `disconnect` | — | Close the controller socket |

The bridge sends:

| Type | Meaning |
| --- | --- |
| `hello` | Bridge is up |
| `status` | `{phase, message}` connection lifecycle |
| `profile` | The parsed installation, **with the security code removed** |
| `levels` | Batched `{address: wireLevel}` updates |
| `trace` | Human-readable frame summaries for diagnostics |
| `error` | A failure message |
| `disconnected` | The controller session ended, with a reason |

The security key crosses from the browser to the bridge on connect and is never
sent back, logged, or included in a trace.

## Implementation map

| Concern | Source |
| --- | --- |
| Frames, records, level scaling, chunk reassembly | `bridge/protocol.mjs` |
| User-profile text parser | `bridge/user-profile.mjs` |
| UDP discovery | `bridge/discovery.mjs` |
| TCP session lifecycle | `bridge/session.mjs` |
| WebSocket bridge | `bridge/server.mjs` |
| Scene Controller emulator | `tools/controller-emulator.mjs` |
| End-to-end smoke check | `tools/smoke.mjs` |
| Protocol regression tests | `tests/protocol.test.mjs` |

## Open questions

- Does a real controller send `f8` chunks unprompted on connect, or only after
  some request the app makes implicitly? The recovered app writes nothing but
  the authentication record before the profile arrives, which suggests
  unprompted.
- Are channel records 2 or 3 fields for high hardware codes? See above.
- What is the `0x3ffe` "unchanged" flow meant to do on a fresh client?
- Do `f0` level records use the same one-based addressing as the `f1` command,
  or the zero-based form the configuration protocol's `f2` records use? The
  parser stores them by the value as sent; if a real controller reports levels
  one channel out, this is the first thing to check.
- How are the AES keys and IVs derived for site types 1 and 2?

Answers should be added only with a binary reference or a packet capture, and
the confidence label updated to match.
