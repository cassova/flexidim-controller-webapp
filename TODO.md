# TODO

Ordered roughly by what unblocks the most. Items are unchecked unless the
evidence for them actually exists — a box is not ticked because code was
written, only because it was shown to work.

## 1. Hardware verification — the gate on everything else

Nothing in this project has touched a real Scene Controller yet. Every protocol
claim is binary verified only. Until this section is done, treat the app as
plausible rather than proven.

- [x] Discover a real controller with the UDP `FLEX` probe and confirm the
      reply's source address. **Done 2026-07-29** — a real controller answered
      the directed broadcast and the address auto-filled in the UI. Note this
      verifies the UDP path, which only works when the bridge can see the LAN;
      Docker Desktop uses the automatic TCP-scan fallback instead.
- [ ] Connect and authenticate on TCP 15274 with a real 16-character user
      security key.
- [ ] Capture the `f8` user-profile stream verbatim and commit a **sanitized**
      transcript shape (counts and field structure, never names, keys or
      addresses) as a fixture.
- [ ] Confirm the channel-record field count against real output. This settles
      the 2-versus-3-field open question in `PROTOCOL.md`. If real payloads use
      2 fields for some channels, the parser needs the disambiguation rule.
- [ ] Confirm `f0` level records use the same one-based channel addressing as
      the `f1` command. If levels appear one channel out, that is the cause.
- [ ] Send one `f1` dim to a known channel and confirm the physical light and
      the reported level agree.
- [ ] Press one scene button (`f0`) and confirm the correct scene runs, which
      validates the "button code = slot index + 1" mapping.
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

## 3. Features the original app has and this does not

- [ ] Colour changers. `JCLColourViewController` drives RGB/white channels
      through a colour wheel and `-sendColour` (`0x100016afc`), with presets in
      `JCLColourPresetViewController`. The profile's `rmColourChangers` list is
      not parsed yet.
- [ ] The built-in Up/Down dim controls, including press-and-hold ramping
      (`-dimPress:`, `-nextDimStep:`).
- [ ] Custom button naming and per-user custom brightness presets
      (`customBrightnesses`, `customButtons`, stored in `CustomButtons.fdr`).
- [ ] Multiple saved sites with a switcher, rather than a flat saved list.

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
- [ ] `README.md` — public getting-started guide: what this is, why it exists,
      how to run it, and the compatibility boundary.
- [ ] CI/CD — GitHub Actions running the test suite, lint and build.
- [ ] PWA manifest, icons and an offline shell, so the app installs to a phone
      home screen. This is the delivery mode that matters most for a
      light switch.
- [ ] Licence and contribution notes for a public project.

## 5. Quality

- [ ] DOM interaction tests for the UI, mirroring the sibling project's
      `tests/ui-interaction.test.mjs` approach.
- [ ] A test that the security key never appears in any bridge-to-browser
      message, as a standing privacy regression.
- [ ] Accessibility pass: focus order, screen-reader labels on the brightness
      sliders, and reduced-motion behaviour.
- [ ] Real-device check on a phone, including one-handed reach and the
      brightness drag under a thumb.
