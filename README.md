# FlexiDim Controller

FlexiDim Controller is a local, browser-based replacement for **JCL FlexiDim
Controller for iOS**. It is intended for owners of existing FlexiDim lighting
systems whose original iPhone or iPad app is no longer practical to run.

The app discovers and authenticates with a Scene Controller on the local
network, reads the rooms and controls available to that user, follows live
channel levels, dims lights, and operates configured scene buttons. The web
interface and its protocol bridge run on your own network and do not require a
cloud service.

This project is the everyday lighting-control counterpart to
[FlexiDim Web](https://github.com/cassova/flexidim-configuration-webapp), which
imports, edits, compares, backs up, and—on specifically qualified
hardware—transfers FlexiDim configurations.

> [!IMPORTANT]
> This app controls real lighting but does not edit or transfer the installed
> configuration. Keep the original iOS apps and a known-good `.fd4cfg` backup.
> Test representative rooms and scenes before depending on it, particularly
> where loss of lighting could create a safety risk.

## What is supported

FlexiDim Controller provides:

- local Scene Controller discovery, including a Docker-friendly subnet
  fallback;
- authenticated local control using a 16-character user security key;
- rooms and controls derived from the authenticated user's controller profile;
- live channel-level updates;
- dimmable and on/off channel control;
- physical scene-button control, including paired first/second assignments;
- saved systems and automatic reconnect on later page loads;
- responsive layouts for desktop, tablet, and phone;
- a local controller emulator and protocol regression suite.

The implementation currently supports the plaintext local type-0 controller
profile. Encrypted site types, the discontinued `flexidim.net` remote service,
colour-changer controls, built-in press-and-hold raise/lower controls, and
custom brightness presets are not implemented. Unsupported behavior should be
omitted instead of guessed.

This app does not create or modify rooms, channels, switches, scenes, periods,
or users. Use
[FlexiDim Web](https://github.com/cassova/flexidim-configuration-webapp) for
configuration work.

## Before you begin

Make recovery possible first:

1. Keep the original controller and configuration iOS apps available.
2. Preserve the latest working `.fd4cfg` in at least two locations.
3. Record the Scene Controller's reserved LAN address if known.
4. Obtain the 16-character key for the user profile you intend to control.
5. Initially test one light and one scene at a safe time.

The user key limits the rooms and switches returned by the controller. It is
not the same credential as the controller security code used by the
configuration application.

## Quick start

Docker Compose is the simplest local deployment because it starts the web
server and controller bridge together.

Requirements:

- Docker with Compose;
- a computer on the same LAN as the FlexiDim Scene Controller;
- a modern browser;
- a 16-character FlexiDim user security key.

Start the application:

```bash
git clone https://github.com/cassova/flexidim-controller-webapp.git
cd flexidim-controller-webapp
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). To use a phone or tablet,
open `http://<computer-lan-address>:3000` while connected to the same trusted
network.

If Docker is unavailable, use Node.js 22.13 or newer. From the repository
directory, run the following commands in two separate command windows:

```bash
# Run once:
npm install

# Command window 1 — start the web server:
npm run dev

# Command window 2 — start the local controller bridge:
npm run bridge
```

Compose creates a named `flexidim-config` volume for saved systems and their
user keys. Normal rebuilds reuse it. `docker compose down` stops the
application without deleting the volume; do not add `-v` unless you
intentionally want to remove every saved system and re-enter its key.

## Deploying the pre-built container image

Every push to `main` publishes a single image containing both the web server
and bridge to GHCR as
`ghcr.io/cassova/flexidim-controller-webapp`, tagged `latest` and with a
version number (`vX.Y.Z`).

By default the image starts both processes, so one container is a complete
deployment:

```bash
docker run -d --name flexidim-controller \
  -p 3000:3000 \
  -v flexidim-controller-config:/config \
  --restart unless-stopped \
  ghcr.io/cassova/flexidim-controller-webapp:latest
```

- Map a host port to container port `3000` for the web interface.
- Mount a persistent volume or host directory at `/config` to preserve saved
  systems and keys.
- Do not publish bridge port `8765` or Scene Controller port `15274`.

The repository's [compose.yaml](compose.yaml) runs the same image as separate
web and bridge services with health checks.

On Linux, [compose.host-network.yaml](compose.host-network.yaml) can place the
bridge directly on the LAN so native UDP discovery works:

```bash
docker compose -f compose.yaml -f compose.host-network.yaml up --build
```

Ordinary bridge networking still supports discovery: if the UDP reply cannot
return from the LAN, the bridge performs a bounded TCP search using the
browser's private address as its preferred subnet hint. You can always enter a
known controller address directly.

## First-time setup

### 1. Find the Scene Controller

Select **Find**. The bridge first sends the recovered FlexiDim UDP discovery
probe and then uses the local subnet fallback if no controller answers.

If it is not found:

- confirm the host and controller are on the same LAN or routed VLAN;
- load the page using the host's LAN address rather than `localhost`;
- check the router's DHCP client or reservation list;
- look in the original app's Site details;
- enter the controller address manually.

Reserve the address in the router once found. Do not expose the controller
directly to the public internet.

### 2. Connect with a user key

Enter the 16-character user security key. Spaces are ignored, so a key written
as four groups of four characters can be pasted directly.

When **Remember this system on this device** is selected, the bridge stores the
key under `/config`; the browser never receives it again. A later page load
automatically reconnects to the last-used saved system.

The normal local control port is `15274`. Some Scene Controllers allow only one
control session, so fully close the original controller app if authentication
succeeds but the session immediately closes.

### 3. Verify representative controls

Before relying on the app:

1. Confirm the returned room and switch names match the intended user.
2. Test one on/off channel.
3. Test one dimmable channel at a moderate level.
4. Test one scene button and its optional second-press behavior.
5. Confirm the physical wall controls still operate normally.

Scene labels come from the user profile, while execution uses the controller's
installed configuration. Each physical button can have first- and second-press
assignments; the Scene Controller owns that state and decides which action
runs.

## Data storage and security

Saved systems are stored at:

- direct Node run: `./config/sites.json`;
- container: `/config/sites.json`;
- Compose: the named `flexidim-config` volume mounted at `/config`.

The file contains user security keys in clear text because the controller
protocol requires the literal characters during authentication. The bridge
creates it with owner-only permissions, never sends stored keys back to the
browser, and excludes them from diagnostics. Protect and back up the host and
volume accordingly.

Forgetting a system removes its saved key. Deleting the data directory or
Compose volume removes every saved system.

## Network and deployment safety

With Compose or the single-container command, only port `3000` is published.
The browser reaches the private bridge through the web server's `/bridge`
WebSocket proxy.

The first connection sends the user key over that WebSocket. Plain HTTP is
appropriate only on a trusted, isolated LAN. For broader household, guest
network, or remote access, put the app behind a trusted reverse proxy with TLS
and authentication. Never port-forward `8765`, `15274`, or the application
directly to the public internet.

Run one application replica per controller. A Scene Controller may permit only
one active control session, and competing clients can disconnect one another.

## Troubleshooting

### “The bridge is not running”

With Compose, inspect both services:

```bash
docker compose ps
docker compose logs flexidim-web flexidim-bridge
```

With a direct Node installation, confirm `npm run bridge` is running and
[http://127.0.0.1:8765/health](http://127.0.0.1:8765/health) returns a healthy
response.

### The controller is not found

- confirm the host and controller can route to one another;
- open the page through the host's private LAN address so it can provide the
  correct subnet hint;
- set `FLEXIDIM_DISCOVERY_SEED` to a private address on the controller's subnet
  when the page must be opened as `localhost`;
- enter the reserved controller address manually;
- confirm local firewall rules allow outbound LAN TCP connections to `15274`.

### Authentication fails or no rooms appear

- verify this is the user's 16-character key, not the configuration
  controller code;
- preserve letter case;
- close the original iOS controller app and other web sessions;
- confirm the key's user profile has access to at least one room;
- reconnect once rather than repeatedly sending credentials.

### A scene label runs an unexpected action

Check the switch's first/second assignments in
[FlexiDim Web](https://github.com/cassova/flexidim-configuration-webapp).
Profile labels describe logical assignments in pairs, while the controller
executes one physical-button press using its installed configuration.

### Saved systems disappear after an update

Confirm the replacement container uses the same `/config` volume or host
directory. Recreating a container without that mount starts with an empty
store.

## Development and validation

```bash
npm test
npm run lint
npm run build
```

To exercise the browser, bridge, and controller protocol without real
hardware, start the emulator, web server, and bridge in separate command
windows, then run the smoke check:

```bash
# Command window 1:
npm run emulator

# Command window 2:
npm run dev

# Command window 3:
npm run bridge

# Command window 4:
npm run smoke
```

The regression corpus is synthetic and contains no real installation, address,
name, or security key. Protocol details and evidence boundaries are documented
in [PROTOCOL.md](PROTOCOL.md); remaining work is tracked in [TODO.md](TODO.md).

## Project layout

```text
app/      Responsive controller interface and bridge client
bridge/   WebSocket bridge, discovery, profiles, protocol, and TCP sessions
server/   Next.js host, WebSocket proxy, and combined-process supervisor
tests/    Synthetic protocol, profile, session, and storage tests
tools/    Controller emulator and end-to-end smoke checks
```

## Disclaimer

FlexiDim Controller is an independent interoperability and preservation
project. It is not an official JCL product, is not affiliated with the former
manufacturer, and comes with no guarantee that every FlexiDim hardware or
firmware variant is supported. JCL, FlexiDim, and their names belong to their
respective rights holders.

Use it only with equipment you own or are authorized to control. Lighting can
be safety-critical. Keep the original recovery method, test changes while
someone has physical access to the installation, and seek qualified electrical
or FlexiDim assistance if outputs behave unexpectedly.
