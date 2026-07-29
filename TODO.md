# TODO

Ordered roughly by what unblocks the most. Completed items cite either a
real-controller observation or the automated regression that proves them.
Partly completed items are split so finished work is not hidden inside an open
checkbox.

## 1. Hardware verification — the gate on everything else

The app has now discovered, authenticated with, and controlled lights through a
real Scene Controller. The remaining items cover protocol details and edge
cases that ordinary switching does not prove.

- [x] Discover a real controller with the UDP `FLEX` probe and confirm the
      reply's source address. **Done 2026-07-29** — a real controller answered
      the directed broadcast and the address auto-filled in the UI. Note this
      verifies the UDP path, which only works when the bridge can see the LAN;
      Docker Desktop uses the automatic TCP-scan fallback instead.
- [x] Connect and authenticate on TCP 15274 with a real 16-character user
      security key. **Done 2026-07-29** — the locally running app loaded the
      controller profile and was able to control lights.
- [x] Confirm that a real controller sends the `f8` user-profile stream after
      authentication and that the app can parse it. **Done 2026-07-29** — the
      locally running app loaded the authenticated user's real rooms, switches,
      buttons and channels.
- [ ] Commit a **sanitized** real-profile transcript shape as a fixture (counts
      and field structure only; never names, keys or addresses). The existing
      parser fixture is synthetic.
- [x] Confirm that the installed site's channel records are compatible with the
      three-field `name|address|type` parser. **Done 2026-07-29** — the real
      profile parsed completely and produced working named channel controls.
      This does not settle the separate high-hardware-code compiler discrepancy.
- [ ] Confirm `f0` level records use the same one-based channel addressing as
      the `f1` command. If levels appear one channel out, that is the cause.
- [x] Send an `f1` dim to a known channel and confirm the physical light
      responds. **Done 2026-07-29** — on/off commands from the locally running
      app operated real lights.
- [ ] Confirm the subsequent controller-reported `f0` level agrees with the
      physical light. The UI updates optimistically when it sends an `f1`, so
      the visible control moving by itself is not evidence of the reply.
- [x] Confirm a real scene-button `f0` command reaches the controller and runs a
      scene. **Done 2026-07-29** — the original Island test ran the exterior
      scene, exposing that logical assignment slots were being sent as physical
      button numbers.
- [ ] Re-test representative scene buttons after pairing logical profile slots
      `2P-1`/`2P` into physical wire button `P`, including a button with both
      first- and second-press assignments.
- [ ] Confirm whether a second client is refused while the app holds the
      session, and whether port 15274 and 15273 can be held at the same time.

Safety rules while testing: one command at a time, no repeated toggling, and
never send a frame whose payload is not fully understood. A malformed frame has
already been observed to make a controller drop the link in the sibling project.

## 2. Correctness follow-ups

- [ ] Reconcile the channel-record discrepancy with the sibling project's
      `compile-user-profiles.ts` and update whichever document is wrong.
- [ ] Decide what a fresh client should do with marker `0x3ffe` ("unchanged").
      Reconnecting to force a resend is one option; caching the last profile per
      site is another.
- [ ] Handle a controller that sends a profile larger than one subscription
      frame can cover (more than 133 channels on a type-0 site). Today the
      excess is reported and skipped.
- [ ] Reconnect-on-drop with backoff, rather than dropping the user back to the
      connect screen.
- [x] Keep the browser-to-bridge WebSocket alive while a tab is backgrounded.
      **Done 2026-07-29** — the bridge heartbeat now sends a ping rather than a
      pong, with a regression covering responsive and silent clients.
- [ ] Investigate interacting-output behaviour such as the exterior “spikes”
      flashing after Patio Main is operated. Determine whether this comes from
      installed scene/channel configuration or from commands sent by the app.

## 3. Features the original app has and this does not

- [ ] Colour changers. `JCLColourViewController` drives RGB/white channels
      through a colour wheel and `-sendColour` (`0x100016afc`), with presets in
      `JCLColourPresetViewController`. The profile's `rmColourChangers` list is
      not parsed yet.
- [ ] The built-in Up/Down dim controls, including press-and-hold ramping
      (`-dimPress:`, `-nextDimStep:`).
- [ ] Custom button naming and per-user custom brightness presets
      (`customBrightnesses`, `customButtons`, stored in `CustomButtons.fdr`).
- [x] Multiple saved sites with one-tap selection and removal. The bridge
      persists multiple credentials, sends only redacted site metadata to the
      browser, and the connect screen renders each saved system as a selectable
      entry. A dedicated in-session switcher can still be added later if useful.

## 4. Deferred infrastructure (explicitly parked by the user)

- [x] `Dockerfile` + `compose.yaml` — web and bridge as two services sharing one
      image, proven working against an emulated controller and reachable from a
      LAN address.
- [x] `Taskfile.yml` — mirrors the sibling project's task runner.
- [ ] Run `task up:host` on the Linux NAS and confirm UDP discovery works there.
      The overlay is config-valid but has never been executed — a Mac cannot
      exercise `network_mode: host`. If UDP still fails, confirm `task up`
      finds the controller through the TCP-scan fallback.
- [ ] Decide whether to serve the stack over TLS from the NAS's reverse proxy.
      `wss://` is already derived from the page protocol, so it needs no code
      change; without it the security key crosses the LAN in the clear on the
      first connect.
- [x] `README.md` — public getting-started guide: what this is, why it exists,
      how to run it, and the compatibility boundary.
- [x] Release/CD workflow — every push to `main` creates the next semantic
      version tag and GitHub release, then publishes versioned and `latest`
      images to GHCR.
- [ ] CI workflow that runs the test suite and lint before release. The release
      image build already runs the production Next.js build, but currently does
      not run `npm test` or `npm run lint`.
- [ ] PWA manifest, icons and an offline shell, so the app installs to a phone
      home screen. This is the delivery mode that matters most for a
      light switch.
- [ ] Licence and contribution notes for a public project.

## 5. Quality

- [ ] DOM interaction tests for the UI, mirroring the sibling project's
      `tests/ui-interaction.test.mjs` approach.
- [x] Standing privacy regressions for bridge-to-browser data: saved-site
      records and parsed profiles are both tested to ensure their security keys
      are removed before serialization.
- [x] Brightness controls have channel-specific screen-reader labels, controls
      expose pressed state where applicable, keyboard focus is visible, and
      reduced-motion preferences disable animation and transition durations.
- [ ] Full accessibility audit of keyboard focus order and screen-reader flow
      across connection, room selection and room control.
- [ ] Real-device check on a phone, including one-handed reach and the
      brightness drag under a thumb.
