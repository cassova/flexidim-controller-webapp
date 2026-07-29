"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Where the bridge lives, from the browser's point of view.
 *
 * Same-origin `/bridge` by default, which the web host proxies to the bridge
 * process. Going straight to 127.0.0.1:8765 would only ever work on the machine
 * running the bridge — a phone loading the page over the LAN has no route to
 * the host's loopback, and the phone is the main way this app gets used.
 */
function bridgeUrl() {
  const configured = process.env.NEXT_PUBLIC_BRIDGE_URL;
  if (configured) return configured;
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/bridge`;
}

export type Channel = {
  id: string;
  roomId: string;
  roomName: string;
  name: string;
  address: number;
  channelType: number;
  dimmable: boolean;
  level: number;
};

export type SwitchButton = { button: number; label: string };
export type PhysicalSceneButton = {
  button: number;
  firstLabel?: string;
  secondLabel?: string;
};

export type WallSwitch = {
  id: string;
  roomId: string;
  roomName: string;
  name: string;
  number: number;
  flag: number;
  usable: boolean;
  buttons: SwitchButton[];
  sceneButtons: PhysicalSceneButton[];
};

export type Room = {
  id: string;
  index: number;
  name: string;
  icon: number;
  areaIndex: number;
  switches: WallSwitch[];
  channels: Channel[];
};

export type Area = { index: number; name: string; rooms: Room[] };

export type Profile = {
  userName: string;
  siteId: string;
  areas: Area[];
  rooms: Room[];
  switches: WallSwitch[];
  channels: Channel[];
  warnings: string[];
  hasSecurityCode: boolean;
};

export type Phase =
  | "offline"
  | "idle"
  | "discovering"
  | "connecting"
  | "authenticating"
  | "awaitingProfile"
  | "ready"
  | "error";

export type DiscoveredController = { host: string; port: number };

/** A system saved on the server. The key stays there; this never carries it. */
export type SavedSite = { host: string; port?: number; label: string; hasKey: boolean };

export type BridgeState = {
  /** Whether the browser is talking to the local bridge process at all. */
  bridgeUp: boolean;
  phase: Phase;
  message: string;
  error: string | null;
  profile: Profile | null;
  /** Controller-reported wire levels, keyed by channel address. */
  levels: Record<number, number>;
  discovered: DiscoveredController[];
  /** True once a discovery sweep has finished, so "none found" can be shown. */
  discoveryRan: boolean;
  sites: SavedSite[];
  lastUsedHost: string | null;
  /** Set once the saved-system list has arrived, so auto-connect fires once. */
  sitesLoaded: boolean;
};

const INITIAL: BridgeState = {
  bridgeUp: false,
  phase: "offline",
  message: "Starting",
  error: null,
  profile: null,
  levels: {},
  discovered: [],
  discoveryRan: false,
  sites: [],
  lastUsedHost: null,
  sitesLoaded: false,
};

/**
 * Owns the WebSocket to the local bridge and exposes the commands the UI needs.
 *
 * Reconnects to the bridge on its own, because the bridge is a separate process
 * the user may restart. It does NOT silently reconnect to the controller: that
 * needs the security key, and re-authenticating without being asked would be
 * surprising when the user deliberately disconnected.
 */
export function useBridge() {
  const [state, setState] = useState<BridgeState>(INITIAL);
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const open = () => {
      if (!mountedRef.current) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(bridgeUrl());
      } catch {
        retryRef.current = setTimeout(open, 2000);
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        if (!mountedRef.current) return;
        setState((s) => ({ ...s, bridgeUp: true, phase: "idle", message: "Ready", error: null }));
      };

      socket.onclose = () => {
        if (!mountedRef.current) return;
        socketRef.current = null;
        setState((s) => ({
          ...s,
          bridgeUp: false,
          phase: "offline",
          message: "The FlexiDim bridge is not running",
          profile: null,
        }));
        retryRef.current = setTimeout(open, 2000);
      };

      socket.onerror = () => {
        // onclose always follows; handle the state change there once.
      };

      socket.onmessage = (event) => {
        if (!mountedRef.current) return;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          return;
        }
        setState((s) => reduce(s, payload));
      };
    };

    open();

    return () => {
      mountedRef.current = false;
      if (retryRef.current) clearTimeout(retryRef.current);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, []);

  const send = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const actions = useMemo(
    () => ({
      /**
       * The page's own hostname is the best clue to which subnet the
       * controller is on, and unlike an environment variable it is always
       * correct: if you loaded this page from 192.168.1.20 then that is the
       * network you are on.
       */
      discover: () =>
        send({ type: "discover", hint: window.location.hostname }),
      /**
       * `securityKey` may be omitted for a system the bridge already has saved;
       * the key never needs to come back to the browser to reconnect.
       */
      connect: (options: {
        host: string;
        securityKey?: string;
        port?: number;
        remember?: boolean;
        label?: string;
      }) => send({ type: "connect", ...options }),
      forgetSite: (host: string) => send({ type: "forgetSite", host }),
      disconnect: () => send({ type: "disconnect" }),
      dim: (channel: number, percent: number, transition = 1) =>
        send({ type: "dim", channel, percent, transition }),
      press: (switchNumber: number, button: number) =>
        send({ type: "press", switch: switchNumber, button }),
      clearError: () => setState((s) => ({ ...s, error: null })),
      /**
       * Show a level change immediately instead of waiting for the controller
       * to echo it. Without this the slider fights the user's thumb.
       */
      previewLevel: (channel: number, wireLevel: number) =>
        setState((s) => ({ ...s, levels: { ...s.levels, [channel]: wireLevel } })),
    }),
    [send],
  );

  return { state, actions };
}

function reduce(state: BridgeState, payload: Record<string, unknown>): BridgeState {
  switch (payload.type) {
    case "status": {
      const phase = String(payload.phase ?? state.phase) as Phase;
      return { ...state, phase, message: String(payload.message ?? ""), error: null };
    }
    case "discovered":
      return {
        ...state,
        phase: state.phase === "discovering" ? "idle" : state.phase,
        discovered: (payload.controllers as DiscoveredController[]) ?? [],
        discoveryRan: true,
      };
    case "sites":
      return {
        ...state,
        sites: (payload.sites as SavedSite[]) ?? [],
        lastUsedHost: (payload.lastUsedHost as string | null) ?? null,
        sitesLoaded: true,
      };
    case "profile": {
      const profile = payload.profile as Profile;
      return { ...state, profile, error: null };
    }
    case "levels": {
      const incoming = payload.levels as Record<string, number>;
      return { ...state, levels: { ...state.levels, ...numericKeys(incoming) } };
    }
    case "disconnected":
      return {
        ...state,
        phase: "idle",
        message: String(payload.reason ?? "Disconnected"),
        profile: null,
        levels: {},
      };
    case "error":
      return { ...state, phase: "error", error: String(payload.message ?? "Something went wrong") };
    default:
      return state;
  }
}

function numericKeys(input: Record<string, number>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [key, value] of Object.entries(input ?? {})) out[Number(key)] = value;
  return out;
}

/** Mirrors bridge/protocol.mjs scaleLevel/unscaleLevel for optimistic display. */
export function toWireLevel(percent: number, channelType: number) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  if (!channelType) return clamped;
  return Math.min(Math.floor((clamped * channelType) / 100), channelType);
}

export function toPercent(wireLevel: number, channelType: number) {
  const level = Math.max(0, wireLevel || 0);
  if (!channelType) return Math.min(100, level);
  if (level >= channelType) return 100;
  return Math.round((level * 100) / channelType);
}
