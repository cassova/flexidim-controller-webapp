"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  type Channel,
  type Profile,
  type Room,
  type WallSwitch,
  toPercent,
  toWireLevel,
} from "./bridge-client";

/* ------------------------------------------------------------------ status */

export function StatusBar({
  bridgeUp,
  phase,
  message,
  siteName,
  onDisconnect,
}: {
  bridgeUp: boolean;
  phase: string;
  message: string;
  siteName?: string;
  onDisconnect?: () => void;
}) {
  const connected = phase === "ready";
  const tone = !bridgeUp
    ? "bg-danger"
    : connected
      ? "bg-ok"
      : phase === "error"
        ? "bg-danger"
        : "bg-glow-soft";

  return (
    <header className="sticky top-0 z-20 border-b border-hairline bg-surface/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        <span className={`size-2.5 shrink-0 rounded-full ${tone}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{siteName ?? "FlexiDim"}</p>
          <p className="truncate text-xs text-ink-faint">{message}</p>
        </div>
        {connected && onDisconnect ? (
          <button
            type="button"
            onClick={onDisconnect}
            className="rounded-full border border-hairline px-3 py-1.5 text-xs font-medium text-ink-dim active:scale-95"
          >
            Disconnect
          </button>
        ) : null}
      </div>
    </header>
  );
}

/* ----------------------------------------------------------------- connect */

import type { SavedSite } from "./bridge-client";

/**
 * The configuration app shows a key as four groups of four — "s62a elti j8kf
 * mcan" — but the stored and transmitted value is the 16 characters with no
 * spaces. Someone reading it off an iPad will type the spaces, so strip them.
 * Case is left alone: generated keys are lowercase, but a hand-set key need not
 * be, and folding it would break that key with no clue as to why.
 */
function normalizeKey(value: string) {
  return value.replace(/\s+/g, "");
}

/** Render a key back in the four-group form it is displayed in elsewhere. */
function groupKey(value: string) {
  return value.replace(/(.{4})(?=.)/g, "$1 ");
}

export function ConnectPanel({
  bridgeUp,
  busy,
  discovered,
  discoveryRan,
  saved,
  error,
  onDiscover,
  onConnect,
  onForget,
}: {
  bridgeUp: boolean;
  busy: boolean;
  discovered: { host: string; port: number }[];
  discoveryRan: boolean;
  saved: SavedSite[];
  error: string | null;
  onDiscover: () => void;
  onConnect: (host: string, key: string, remember: boolean, label: string) => void;
  onForget: (host: string) => void;
}) {
  const [host, setHost] = useState("");
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [remember, setRemember] = useState(true);
  const [revealKey, setRevealKey] = useState(false);

  const keyOk = key.length === 16;
  const canConnect = bridgeUp && !busy && host.trim().length > 0 && keyOk;

  // A single controller is the overwhelmingly common case, so filling the field
  // is what "Find" should obviously do. With several, the chips let the user
  // pick — but the first is still filled in so the button is never a no-op.
  const lastFilled = useRef<string | null>(null);
  useEffect(() => {
    const first = discovered[0]?.host;
    if (!first || lastFilled.current === first) return;
    lastFilled.current = first;
    setHost((current) => (current.trim() === "" ? first : current));
  }, [discovered]);

  return (
    <div className="mx-auto w-full max-w-md px-4 pb-16 pt-8">
      <div className="mb-8 text-center">
        <div
          className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-surface-raised shadow-lg"
          aria-hidden
        >
          <LampIcon className="size-9 text-glow" on />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">FlexiDim</h1>
        <p className="mt-1 text-sm text-ink-dim">
          Connect to your Scene Controller to turn the lights on.
        </p>
      </div>

      {!bridgeUp ? (
        <Notice tone="danger" title="The bridge is not running">
          A browser cannot open the network connection this lighting system needs, so a small
          helper runs on this computer. Start it with{" "}
          <code className="rounded bg-surface-sunken px-1.5 py-0.5 text-[0.8em]">npm run bridge</code>{" "}
          and this page will connect on its own.
        </Notice>
      ) : null}

      {error ? (
        <Notice tone="danger" title="Could not connect">
          {error}
        </Notice>
      ) : null}

      {saved.length > 0 ? (
        <section className="mb-6">
          <SectionLabel>Saved systems</SectionLabel>
          <ul className="space-y-2">
            {saved.map((site) => (
              <li key={site.host} className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!bridgeUp || busy}
                  // No key passed: the bridge holds it and looks it up by host.
                  onClick={() => onConnect(site.host, "", false, site.label)}
                  className="flex-1 rounded-card border border-hairline bg-surface-raised px-4 py-3 text-left active:scale-[0.99] disabled:opacity-50"
                >
                  <span className="block truncate text-sm font-medium">{site.label || site.host}</span>
                  <span className="block truncate text-xs text-ink-faint">{site.host}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onForget(site.host)}
                  aria-label={`Forget ${site.label || site.host}`}
                  className="rounded-full border border-hairline p-2.5 text-ink-faint active:scale-95"
                >
                  <TrashIcon className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-card border border-hairline bg-surface-raised p-4">
        <SectionLabel>Add a system</SectionLabel>

        <label className="mb-1.5 block text-xs font-medium text-ink-dim" htmlFor="host">
          Controller address
        </label>
        <div className="mb-3 flex gap-2">
          <input
            id="host"
            value={host}
            onChange={(event) => setHost(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            placeholder="192.168.1.50"
            className="min-w-0 flex-1 rounded-xl border border-hairline bg-surface px-3 py-3 text-base outline-none focus:border-glow"
          />
          <button
            type="button"
            onClick={onDiscover}
            disabled={!bridgeUp || busy}
            className="shrink-0 rounded-xl border border-hairline px-3.5 text-sm font-medium text-ink-dim active:scale-95 disabled:opacity-50"
          >
            Find
          </button>
        </div>

        {discovered.length > 1 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {discovered.map((c) => (
              <button
                key={c.host}
                type="button"
                onClick={() => setHost(c.host)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium active:scale-95 ${
                  host === c.host ? "bg-glow text-surface-sunken" : "bg-surface-sunken text-ink-dim"
                }`}
              >
                {c.host}
              </button>
            ))}
          </div>
        ) : null}

        {discoveryRan && discovered.length === 0 ? (
          <p className="mb-3 text-xs text-ink-faint">
            No controller answered. It may be switched off, on another network, or unable to hear
            a broadcast from where this app is running — type its address above instead.
          </p>
        ) : null}

        <label className="mb-1.5 block text-xs font-medium text-ink-dim" htmlFor="key">
          Security key
        </label>
        <div className="relative mb-1">
          <input
            id="key"
            // Held unspaced so the 16-character count is honest, but shown in
            // the four-group form it is displayed in when revealed, so it can
            // be checked against the screen it was copied from.
            value={revealKey ? groupKey(key) : key}
            onChange={(event) => setKey(normalizeKey(event.target.value).slice(0, 16))}
            type={revealKey ? "text" : "password"}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="16 characters"
            className="w-full rounded-xl border border-hairline bg-surface py-3 pl-3 pr-12 font-mono text-base tracking-wider outline-none focus:border-glow"
          />
          <button
            type="button"
            onClick={() => setRevealKey((shown) => !shown)}
            aria-label={revealKey ? "Hide security key" : "Show security key"}
            aria-pressed={revealKey}
            className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-ink-faint active:scale-90"
          >
            {revealKey ? <EyeOffIcon className="size-5" /> : <EyeIcon className="size-5" />}
          </button>
        </div>
        <p className="mb-3 text-xs text-ink-faint">
          {key.length === 0
            ? "From your FlexiDim configuration, under Users. Spaces are ignored."
            : keyOk
              ? "16 of 16 characters."
              : `${key.length} of 16 characters.`}
        </p>

        <label className="mb-3 flex items-center gap-2.5 text-sm text-ink-dim">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            className="size-4 accent-[var(--color-glow)]"
          />
          Remember this system on this device
        </label>

        {remember ? (
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Name (optional), e.g. Home"
            className="mb-3 w-full rounded-xl border border-hairline bg-surface px-3 py-3 text-base outline-none focus:border-glow"
          />
        ) : null}

        <button
          type="button"
          disabled={!canConnect}
          onClick={() => onConnect(host.trim(), key, remember, label.trim())}
          className="w-full rounded-xl bg-glow px-4 py-3.5 text-base font-semibold text-surface-sunken active:scale-[0.99] disabled:opacity-40"
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
      </section>

      <p className="mt-4 text-center text-xs text-ink-faint">
        The key is sent only to your controller on your own network, and is stored on this device
        alone.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------- rooms */

export function RoomList({
  profile,
  levels,
  onOpen,
}: {
  profile: Profile;
  levels: Record<number, number>;
  onOpen: (room: Room) => void;
}) {
  // Only show the area heading when there is more than one, so a single-floor
  // house does not get a pointless "Ground" band above every room.
  const areas = profile.areas.filter((area) => area.rooms.length > 0);
  const showAreaNames = areas.length > 1;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-20 pt-4">
      {areas.map((area) => (
        <section key={area.index} className="mb-6">
          {showAreaNames ? (
            <SectionLabel>{area.name || `Area ${area.index + 1}`}</SectionLabel>
          ) : null}
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {area.rooms.map((room) => (
              <li key={room.id}>
                <RoomTile room={room} levels={levels} onOpen={() => onOpen(room)} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {profile.warnings.length > 0 ? (
        <details className="mt-2 rounded-card border border-hairline bg-surface-raised p-4">
          <summary className="cursor-pointer text-sm font-medium text-ink-dim">
            {profile.warnings.length} note{profile.warnings.length === 1 ? "" : "s"} about this
            system
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-ink-faint">
            {profile.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function RoomTile({
  room,
  levels,
  onOpen,
}: {
  room: Room;
  levels: Record<number, number>;
  onOpen: () => void;
}) {
  const lit = room.channels.filter((c) => (levels[c.address] ?? 0) > 0).length;
  const brightest = room.channels.reduce(
    (max, c) => Math.max(max, toPercent(levels[c.address] ?? 0, c.channelType)),
    0,
  );
  const on = lit > 0;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative w-full overflow-hidden rounded-card border border-hairline bg-surface-raised p-4 text-left transition active:scale-[0.98]"
    >
      {/* A warm wash whose strength tracks the brightest light in the room. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: "var(--color-glow)",
          opacity: (brightest / 100) * 0.18,
        }}
      />
      <span className="relative flex flex-col gap-6">
        <LampIcon className={`size-7 ${on ? "text-glow" : "text-ink-faint"}`} on={on} />
        <span>
          <span className="block truncate text-sm font-semibold">{room.name}</span>
          <span className="block text-xs text-ink-faint">
            {room.channels.length === 0
              ? `${room.switches.length} switch${room.switches.length === 1 ? "" : "es"}`
              : on
                ? `${lit} of ${room.channels.length} on`
                : "All off"}
          </span>
        </span>
      </span>
    </button>
  );
}

/* -------------------------------------------------------------- room detail */

export function RoomDetail({
  room,
  levels,
  onBack,
  onDim,
  onPress,
  onPreview,
}: {
  room: Room;
  levels: Record<number, number>;
  onBack: () => void;
  onDim: (channel: number, percent: number, transition?: number) => void;
  onPress: (switchNumber: number, button: number) => void;
  onPreview: (channel: number, wireLevel: number) => void;
}) {
  const anyOn = room.channels.some((c) => (levels[c.address] ?? 0) > 0);

  const setAll = (percent: number) => {
    for (const channel of room.channels) onDim(channel.address, percent);
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-3">
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-full border border-hairline p-2.5 active:scale-95"
          aria-label="Back to rooms"
        >
          <ChevronLeftIcon className="size-5" />
        </button>
        <h2 className="flex-1 truncate text-xl font-semibold">{room.name}</h2>
      </div>

      {room.channels.length > 0 ? (
        <div className="mb-5 flex gap-2">
          <button
            type="button"
            onClick={() => setAll(100)}
            className="flex-1 rounded-xl bg-glow px-4 py-3 text-sm font-semibold text-surface-sunken active:scale-[0.98]"
          >
            All on
          </button>
          <button
            type="button"
            onClick={() => setAll(0)}
            disabled={!anyOn}
            className="flex-1 rounded-xl border border-hairline px-4 py-3 text-sm font-semibold active:scale-[0.98] disabled:opacity-40"
          >
            All off
          </button>
        </div>
      ) : null}

      {room.switches.filter((s) => s.usable && s.sceneButtons.length > 0).length > 0 ? (
        <section className="mb-6">
          <SectionLabel>Scenes</SectionLabel>
          {room.switches
            .filter((s) => s.usable && s.sceneButtons.length > 0)
            .map((wallSwitch) => (
              <div key={wallSwitch.id} className="mb-3">
                {room.switches.length > 1 ? (
                  <p className="mb-1.5 text-xs text-ink-faint">{wallSwitch.name}</p>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  {wallSwitch.sceneButtons.map((button) => (
                    <button
                      key={button.button}
                      type="button"
                      onClick={() => onPress(wallSwitch.number, button.button)}
                      className="rounded-card border border-hairline bg-surface-raised px-4 py-4 text-sm font-medium active:scale-[0.98]"
                    >
                      <span className="block">
                        {button.firstLabel ?? `Second press: ${button.secondLabel}`}
                      </span>
                      {button.firstLabel && button.secondLabel ? (
                        <span className="mt-1 block text-xs font-normal text-ink-faint">
                          Then {button.secondLabel}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </section>
      ) : null}

      {room.channels.length > 0 ? (
        <section>
          <SectionLabel>Lights</SectionLabel>
          <ul className="space-y-3">
            {room.channels.map((channel) => (
              <li key={channel.id}>
                <ChannelControl
                  channel={channel}
                  wireLevel={levels[channel.address] ?? 0}
                  onDim={onDim}
                  onPreview={onPreview}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {room.channels.length === 0 && room.switches.length === 0 ? (
        <p className="py-12 text-center text-sm text-ink-faint">
          Your profile grants no lights or switches in this room.
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- channels */

function ChannelControl({
  channel,
  wireLevel,
  onDim,
  onPreview,
}: {
  channel: Channel;
  wireLevel: number;
  onDim: (channel: number, percent: number, transition?: number) => void;
  onPreview: (channel: number, wireLevel: number) => void;
}) {
  const percent = toPercent(wireLevel, channel.channelType);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState(percent);
  const throttle = useRef<{ last: number; timer: ReturnType<typeof setTimeout> | null }>({
    last: 0,
    timer: null,
  });

  // While the thumb is down the slider owns the value; otherwise the controller
  // does. Without this the position jumps back whenever a status record lands
  // mid-drag.
  const shown = dragging ? draft : percent;
  const on = shown > 0;

  useEffect(() => {
    const state = throttle.current;
    return () => {
      if (state.timer) clearTimeout(state.timer);
    };
  }, []);

  /**
   * Dragging can emit an event per animation frame. Each one is a wire frame to
   * a 1990s lighting controller, so they are coalesced to ~10/second and sent
   * with a zero transition, which is what makes a drag feel immediate rather
   * than smeared across overlapping half-second fades.
   */
  const sendLive = useCallback(
    (value: number) => {
      const state = throttle.current;
      const now = Date.now();
      const elapsed = now - state.last;
      if (state.timer) clearTimeout(state.timer);
      if (elapsed >= 100) {
        state.last = now;
        onDim(channel.address, value, 0);
      } else {
        state.timer = setTimeout(() => {
          state.last = Date.now();
          onDim(channel.address, value, 0);
        }, 100 - elapsed);
      }
    },
    [channel.address, onDim],
  );

  const commit = (value: number) => {
    const state = throttle.current;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.last = Date.now();
    setDragging(false);
    onPreview(channel.address, toWireLevel(value, channel.channelType));
    onDim(channel.address, value, 0);
  };

  const toggle = () => {
    const next = on ? 0 : 100;
    setDraft(next);
    onPreview(channel.address, toWireLevel(next, channel.channelType));
    onDim(channel.address, next, 1);
  };

  return (
    <div className="no-select rounded-card border border-hairline bg-surface-raised p-3">
      <div className="mb-2 flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-pressed={on}
          aria-label={`${on ? "Turn off" : "Turn on"} ${channel.name}`}
          className={`flex size-10 shrink-0 items-center justify-center rounded-full border transition ${
            on ? "border-transparent bg-glow text-surface-sunken" : "border-hairline text-ink-faint"
          } active:scale-95`}
        >
          <PowerIcon className="size-5" />
        </button>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{channel.name}</span>
          <span className="block text-xs text-ink-faint">
            {channel.dimmable ? "Dimmable" : "On/off"} · channel {channel.address}
          </span>
        </span>
        <span className="shrink-0 tabular-nums text-sm font-semibold text-ink-dim">
          {channel.dimmable ? `${shown}%` : on ? "On" : "Off"}
        </span>
      </div>

      {channel.dimmable ? (
        <input
          className="brightness"
          type="range"
          min={0}
          max={100}
          step={1}
          value={shown}
          aria-label={`${channel.name} brightness`}
          style={
            {
              // The filled portion is the level readout, so the track is drawn
              // rather than left to the browser's default.
              "--track": `linear-gradient(to right,
                var(--color-glow) 0%,
                var(--color-glow-soft) ${shown}%,
                var(--color-surface-sunken) ${shown}%,
                var(--color-surface-sunken) 100%)`,
            } as React.CSSProperties
          }
          onPointerDown={() => setDragging(true)}
          onChange={(event) => {
            const value = Number(event.target.value);
            setDragging(true);
            setDraft(value);
            sendLive(value);
          }}
          onPointerUp={(event) => commit(Number((event.target as HTMLInputElement).value))}
          onPointerCancel={() => setDragging(false)}
          onKeyUp={(event) => commit(Number((event.target as HTMLInputElement).value))}
          onBlur={() => setDragging(false)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- bits */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
      {children}
    </h3>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "danger" | "info";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`mb-5 rounded-card border p-4 ${
        tone === "danger" ? "border-danger/40 bg-danger/10" : "border-hairline bg-surface-raised"
      }`}
      role={tone === "danger" ? "alert" : undefined}
    >
      <p className="mb-1 text-sm font-semibold">{title}</p>
      <p className="text-sm leading-relaxed text-ink-dim">{children}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ icons */

function LampIcon({ className, on }: { className?: string; on?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.8 1 .9 1.6l.1.6h5.2l.1-.6c.1-.6.4-1.2.9-1.6A6 6 0 0 0 12 3Z"
        fill={on ? "currentColor" : "none"}
        fillOpacity={on ? 0.25 : 0}
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M9.5 19h5M10.5 21.5h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PowerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3v9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M7.5 6.5a7 7 0 1 0 9 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.8M6.4 7.7A17 17 0 0 0 2.5 12S6 18.5 12 18.5c1.3 0 2.4-.3 3.4-.7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4 3.5l16 17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
