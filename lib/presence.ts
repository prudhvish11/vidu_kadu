import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type PlayerLite = { id: string; is_host: boolean };

// How long a player can be absent from presence before being removed. Long
// enough that locking a phone / backgrounding the tab (which drops the Realtime
// socket) doesn't kick players — only genuine long-gone clients get cleaned up.
const GRACE_MS = 60000;

// Remove a player from a room: delete their votes and row, promote the
// earliest-joined remaining player to host if the leaver was host, and tear the
// room down if nobody is left. `players` should be the current roster ordered
// by joined_at (the order both pages already fetch in).
export async function removePlayerFromRoom(
  roomId: string,
  playerId: string,
  players: PlayerLite[],
) {
  const leaving = players.find((p) => p.id === playerId);
  const remaining = players.filter((p) => p.id !== playerId);

  await supabase.from("votes").delete().eq("voter_id", playerId);
  await supabase.from("players").delete().eq("id", playerId);

  if (remaining.length === 0) {
    await supabase.from("votes").delete().eq("room_id", roomId);
    await supabase.from("rooms").delete().eq("id", roomId);
    return;
  }
  if (leaving?.is_host) {
    // Promote the next player: update both the room pointer and the roster flag
    // so host powers and the host badge stay consistent.
    await supabase.from("rooms").update({ host_id: remaining[0].id }).eq("id", roomId);
    await supabase.from("players").update({ is_host: true }).eq("id", remaining[0].id);
  }
}

// Tracks who is actually connected via Supabase Realtime presence and (when
// `allowRemoval` is true) removes players who disconnect. To avoid every client
// deleting at once, a single "leader" performs removals: the host if it is
// online, otherwise the online player with the lowest id.
//
// Removal is only safe in the LOBBY. Once a game is in progress, pass `false`:
// a phone that locks drops its Realtime socket (iOS suspends it), and in
// pass-device mode everyone but the phone-holder is offline the whole round —
// removing them would wipe players mid-game. Returned `onlineIds` still updates
// regardless, so callers can show live-connection UI.
export function useRoomPresence(
  roomId: string | null,
  myId: string | null,
  players: PlayerLite[],
  allowRemoval: boolean = true,
): Set<string> {
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const playersRef = useRef<PlayerLite[]>(players);
  playersRef.current = players;
  const onlineRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const allowRemovalRef = useRef(allowRemoval);
  allowRemovalRef.current = allowRemoval;

  useEffect(() => {
    if (!roomId || !myId) return;

    function leaderId(online: Set<string>): string | null {
      const host = playersRef.current.find((p) => p.is_host && online.has(p.id));
      if (host) return host.id;
      return [...online].sort()[0] ?? null;
    }

    function reconcile() {
      const online = onlineRef.current;
      // Someone came back — cancel any pending removal.
      for (const [pid, t] of timersRef.current) {
        if (online.has(pid)) { clearTimeout(t); timersRef.current.delete(pid); }
      }
      if (!allowRemovalRef.current) return; // in-game: track presence, never remove
      if (leaderId(online) !== myId) return;
      for (const p of playersRef.current) {
        if (online.has(p.id) || timersRef.current.has(p.id)) continue;
        const timer = setTimeout(async () => {
          timersRef.current.delete(p.id);
          if (onlineRef.current.has(p.id)) return;            // came back
          if (leaderId(onlineRef.current) !== myId) return;    // no longer leader
          if (!playersRef.current.some((x) => x.id === p.id)) return; // already gone
          await removePlayerFromRoom(roomId!, p.id, playersRef.current);
        }, GRACE_MS);
        timersRef.current.set(p.id, timer);
      }
    }

    const channel = supabase.channel(`presence-${roomId}`, {
      config: { presence: { key: myId } },
    });
    channel.on("presence", { event: "sync" }, () => {
      const online = new Set(Object.keys(channel.presenceState()));
      onlineRef.current = online;
      setOnlineIds(online);
      reconcile();
    });
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") channel.track({ at: Date.now() });
    });

    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      supabase.removeChannel(channel);
    };
  }, [roomId, myId]);

  return onlineIds;
}
