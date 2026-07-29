"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useBridge, type Room } from "./bridge-client";
import { ConnectPanel, RoomDetail, RoomList, StatusBar } from "./components";

export default function Page() {
  const { state, actions } = useBridge();
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);

  const {
    profile,
    levels,
    phase,
    message,
    bridgeUp,
    error,
    discovered,
    discoveryRan,
    sites,
    lastUsedHost,
    sitesLoaded,
  } = state;

  /**
   * Reconnect to the system last used, once, as soon as the saved list arrives.
   *
   * The whole point of saving the key on the server is not having to type it
   * again, so an installed home-screen app should come up already connected.
   * It fires once per page load and never after the user has deliberately
   * disconnected — otherwise Disconnect would immediately undo itself.
   */
  const autoConnected = useRef(false);
  useEffect(() => {
    if (autoConnected.current) return;
    if (!bridgeUp || !sitesLoaded || phase !== "idle") return;
    const target = sites.find((site) => site.host === lastUsedHost) ?? sites[0];
    if (!target?.hasKey) return;
    autoConnected.current = true;
    actions.connect({ host: target.host, port: target.port });
  }, [actions, bridgeUp, lastUsedHost, phase, sites, sitesLoaded]);

  const handleConnect = useCallback(
    (host: string, securityKey: string, remember: boolean, label: string) => {
      actions.clearError();
      // A blank key means "use the one already saved for this host".
      autoConnected.current = true;
      actions.connect({ host, securityKey: securityKey || undefined, remember, label });
    },
    [actions],
  );

  // Deriving the open room rather than tracking it separately means a profile
  // that no longer contains it falls back to the list on its own.
  const openRoom: Room | null = useMemo(
    () => profile?.rooms.find((room) => room.id === openRoomId) ?? null,
    [profile, openRoomId],
  );

  const connecting =
    phase === "connecting" || phase === "authenticating" || phase === "awaitingProfile";

  const ready = phase === "ready" && profile;

  return (
    <main className="min-h-dvh">
      <StatusBar
        bridgeUp={bridgeUp}
        phase={phase}
        // The room name is already the page heading; repeating it here wastes
        // the one line that should say who is connected.
        message={ready ? `Connected as ${profile.userName}` : message}
        siteName={ready ? profile.siteId : undefined}
        onDisconnect={() => {
          setOpenRoomId(null);
          actions.disconnect();
        }}
      />

      {ready ? (
        openRoom ? (
          <RoomDetail
            room={openRoom}
            levels={levels}
            onBack={() => setOpenRoomId(null)}
            onDim={actions.dim}
            onPress={actions.press}
            onPreview={actions.previewLevel}
          />
        ) : (
          <RoomList profile={profile} levels={levels} onOpen={(room) => setOpenRoomId(room.id)} />
        )
      ) : (
        <ConnectPanel
          bridgeUp={bridgeUp}
          busy={connecting || phase === "discovering"}
          discovered={discovered}
          discoveryRan={discoveryRan}
          saved={sites}
          error={error}
          onDiscover={actions.discover}
          onConnect={handleConnect}
          onForget={actions.forgetSite}
        />
      )}
    </main>
  );
}
