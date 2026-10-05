"use client";
import { Suspense, useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRoomPresence, removePlayerFromRoom } from "@/lib/presence";
import { avatarColor } from "@/lib/avatar";
import { sfx } from "@/lib/sound";
import SoundToggle from "@/components/SoundToggle";
import HowToPlay from "@/components/HowToPlay";
import QRCode from "@/components/QRCode";

type Player = {
  id: string;
  name: string;
  is_host: boolean;
  is_imposter: boolean;
  is_eliminated: boolean;
  has_revealed: boolean;
  wins: number;
  losses: number;
  times_caught: number;
};

type Room = {
  id: string;
  code: string;
  host_id: string;
  status: string;
  word: string | null;
  category_id: string | null;
  category_ids: string[] | null;
  imposter_count: number;
  reveal_mode: string;
  timer_enabled: boolean;
  timer_seconds: number;
  hints_enabled: boolean;
  show_category: boolean;
  show_word_length: boolean;
  show_first_letter: boolean;
  imposters_know?: boolean; // optional: column may not be migrated yet
};

type Category = { id: string; name: string };

function RoomPage() {
  const searchParams = useSearchParams();
  const code = searchParams.get("code") || "";
  const router = useRouter();

  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [myId, setMyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showSettings, setShowSettings] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [imposterCount, setImposterCount] = useState(1);
  const [revealMode, setRevealMode] = useState<"own" | "pass">("own");
  const [timerEnabled, setTimerEnabled] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(120);
  const [hintsEnabled, setHintsEnabled] = useState(true);
  const [showCategory, setShowCategory] = useState(false);
  const [showWordLength, setShowWordLength] = useState(false);
  const [showFirstLetter, setShowFirstLetter] = useState(false);
  const [impostersKnow, setImpostersKnow] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [startError, setStartError] = useState("");
  const [joinUrl, setJoinUrl] = useState(""); // the scan/share link; set client-side (needs window)
  const [showQR, setShowQR] = useState(true);

  const fetchPlayers = useCallback(async (roomId: string) => {
    const { data } = await supabase
      .from("players")
      .select()
      .eq("room_id", roomId)
      .order("joined_at");
    if (data) setPlayers(data);
  }, []);

  const fetchRoom = useCallback(async () => {
    const { data } = await supabase.from("rooms").select().eq("code", code).single();
    if (data) {
      setRoom(data);
      setImposterCount(data.imposter_count);
      setRevealMode(data.reveal_mode);
      setTimerEnabled(data.timer_enabled);
      setTimerSeconds(data.timer_seconds);
      setHintsEnabled(data.hints_enabled ?? true);
      setShowCategory(data.show_category ?? false);
      setShowWordLength(data.show_word_length ?? false);
      setShowFirstLetter(data.show_first_letter ?? false);
      setImpostersKnow(data.imposters_know ?? false);
      // Category selection is initialized once by the effect below (needs the
      // categories list too), so it isn't overwritten on every room update.
    }
    return data;
  }, [code]);

  useEffect(() => {
    if (!code) { router.push("/"); return; }
    const id = localStorage.getItem("vk_player_id");
    if (!id) { router.push(`/?join=${code}`); return; }
    setMyId(id);

    async function init() {
      const { data: roomData } = await supabase
        .from("rooms").select().eq("code", code).single();
      if (!roomData) { setError("Room not found."); setLoading(false); return; }

      // If this device isn't actually a player in this room (e.g. followed a
      // shared link but has a stale id from a past game), send them to join.
      const { data: mine } = await supabase
        .from("players").select("id").eq("id", id).eq("room_id", roomData.id).maybeSingle();
      if (!mine) { router.push(`/?join=${code}`); return; }

      setRoom(roomData);
      setImposterCount(roomData.imposter_count);
      setRevealMode(roomData.reveal_mode);
      setTimerEnabled(roomData.timer_enabled);
      setTimerSeconds(roomData.timer_seconds);
      setHintsEnabled(roomData.hints_enabled ?? true);
      setShowCategory(roomData.show_category ?? false);
      setShowWordLength(roomData.show_word_length ?? false);
      setShowFirstLetter(roomData.show_first_letter ?? false);
      setImpostersKnow(roomData.imposters_know ?? false);

      await fetchPlayers(roomData.id);

      if (["playing", "voting", "reveal"].includes(roomData.status)) {
        router.push(`/room/game?code=${code}`);
        return;
      }
      setLoading(false);
    }
    init();
  }, [code, router, fetchPlayers]);

  // Realtime subscriptions. Keyed on room.id (not the whole room object) so the
  // channel isn't torn down and rebuilt on every settings/roster change.
  useEffect(() => {
    const roomId = room?.id;
    if (!roomId) return;
    const channel = supabase.channel(`lobby-${roomId}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomId}` },
        () => fetchPlayers(roomId))
      .on("postgres_changes",
        { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
        async () => {
          const updated = await fetchRoom();
          if (updated?.status === "playing") router.push(`/room/game?code=${code}`);
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [room?.id, fetchPlayers, fetchRoom, code, router]);

  // Catch-up sync. iOS Safari suspends the Realtime socket when the phone locks
  // or the tab is backgrounded, so a phone can miss the host pressing "Start".
  // Re-fetch on foreground plus a light poll so every device starts on time.
  useEffect(() => {
    const roomId = room?.id;
    if (!roomId) return;
    const sync = () => {
      fetchRoom().then((updated) => {
        if (updated?.status === "playing") router.push(`/room/game?code=${code}`);
      });
      fetchPlayers(roomId);
    };
    const onVisible = () => { if (document.visibilityState === "visible") sync(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onVisible);
    const iv = setInterval(() => { if (document.visibilityState === "visible") sync(); }, 4000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
      clearInterval(iv);
    };
  }, [room?.id, fetchPlayers, fetchRoom, code, router]);

  // Track live connections; auto-removes players who disconnect.
  const onlineIds = useRoomPresence(room?.id ?? null, myId, players);

  async function leaveRoom() {
    try { localStorage.removeItem("vk_last_room"); } catch { /* ignore */ }
    if (myId && room) await removePlayerFromRoom(room.id, myId, players);
    router.push("/");
  }

  // Load categories
  useEffect(() => {
    supabase.from("categories").select()
      .then(({ data }) => { if (data) setCategories(data); });
  }, []);

  // Category selection is an explicit list of ids. Initialize once, after both
  // the room and the categories are loaded: use the stored subset, or default a
  // room with no stored selection to "all". Runs once so "Deselect all" sticks.
  const didInitCats = useRef(false);
  useEffect(() => {
    if (didInitCats.current || categories.length === 0 || !room) return;
    didInitCats.current = true;
    const stored = catIdsFromRoom(room);
    setSelectedCategoryIds(stored.length ? stored : categories.map(c => c.id));
  }, [categories, room]);

  const allCategoryIds = categories.map(c => c.id);
  const catSelected = (id: string) => selectedCategoryIds.includes(id);
  function toggleCategory(id: string) {
    setSelectedCategoryIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function saveSettings() {
    if (!room) return;
    setSavingSettings(true);
    const base = {
      imposter_count: imposterCount,
      reveal_mode: revealMode,
      timer_enabled: timerEnabled,
      timer_seconds: timerSeconds,
      category_id: selectedCategoryIds.length === 1 ? selectedCategoryIds[0] : null,
      // The host plays too (and can be the imposter), so they never pick the
      // word — it's always drawn at random when the game starts.
      word: null,
    };
    const full = {
      ...base,
      hints_enabled: hintsEnabled,
      show_category: showCategory,
      show_word_length: showWordLength,
      show_first_letter: showFirstLetter,
    };
    // Persist everything, then progressively fall back so a not-yet-migrated
    // column (category_ids / show_* ) never blocks the other settings.
    const { error } = await supabase.from("rooms").update({ ...full, category_ids: selectedCategoryIds }).eq("id", room.id);
    if (error) {
      const { error: e2 } = await supabase.from("rooms").update(full).eq("id", room.id);
      if (e2) {
        const { error: e3 } = await supabase.from("rooms").update({ ...base, hints_enabled: hintsEnabled }).eq("id", room.id);
        if (e3) await supabase.from("rooms").update(base).eq("id", room.id);
      }
    }
    // Best-effort, decoupled so a not-yet-migrated column can't drop the rest.
    await supabase.from("rooms").update({ imposters_know: impostersKnow }).eq("id", room.id);
    setSavingSettings(false);
    setShowSettings(false);
  }

  async function kickPlayer(p: Player) {
    if (!room || p.id === myId) return;
    if (!window.confirm(`Remove ${p.name} from the room?`)) return;
    await removePlayerFromRoom(room.id, p.id, players);
  }

  async function startGame() {
    if (!room) return;
    setStartError("");
    if (players.length < 3) { setStartError("Need at least 3 players to start."); return; }

    // Always draw a random word from the selected categories (all if none narrowed).
    const pool = selectedCategoryIds.length ? selectedCategoryIds : allCategoryIds;
    if (pool.length === 0) { setStartError("No categories available yet."); return; }
    const { data: wpool } = await supabase.from("words").select("word").in("category_id", pool);
    if (!wpool || wpool.length === 0) { setStartError("The selected categories have no words."); return; }
    const word = wpool[Math.floor(Math.random() * wpool.length)].word;

    const shuffled = [...players].sort(() => Math.random() - 0.5);
    const imposterIds = shuffled.slice(0, imposterCount).map(p => p.id);

    for (const player of players) {
      await supabase.from("players")
        .update({ is_imposter: imposterIds.includes(player.id) })
        .eq("id", player.id);
    }
    await supabase.from("rooms").update({ status: "playing", word }).eq("id", room.id);
  }

  async function copyText(text: string) {
    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // fall through to the execCommand fallback below
      }
    }
    // navigator.clipboard requires a secure context (HTTPS or localhost)
    // and is unavailable over plain HTTP LAN access (e.g. from a phone).
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    document.body.removeChild(textarea);
    return copied;
  }

  async function copyCode() {
    const copied = await copyText(code);
    alert(copied ? "Code copied!" : code);
  }

  function joinLink() {
    // Point straight at the join screen (name prompt), not the lobby — so a
    // visitor always gets to enter their name. Preserves origin + basePath.
    const u = new URL(window.location.href);
    u.pathname = u.pathname.replace(/room\/?$/, "");
    u.search = `?join=${code}`;
    u.hash = "";
    return u.toString();
  }

  // Compute the join link on the client (joinLink needs window; skipped during
  // the static prerender, which only ever shows the loading state).
  useEffect(() => {
    if (code) setJoinUrl(joinLink());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  async function shareRoom() {
    const url = joinLink();
    if (navigator.share) {
      navigator.share({ title: "Vidu Kadhu", text: `Join my game! Code: ${code}`, url });
    } else {
      const copied = await copyText(url);
      alert(copied ? "Link copied!" : url);
    }
  }

  if (loading) return (
    <div className="page">
      <div style={{ color: "var(--t3)", fontSize: "14px" }}>Loading room...</div>
    </div>
  );

  if (error) return (
    <div className="page">
      <div className="screen" style={{ textAlign: "center", gap: "16px" }}>
        <p style={{ color: "var(--danger)" }}>{error}</p>
        <button className="btn-outline" onClick={() => router.push("/")}>Go Home</button>
      </div>
    </div>
  );

  // Derive host status directly from room.host_id vs myId — never from me
  const isHost = !!(myId && room && room.host_id === myId);
  const me = players.find(p => p.id === myId);

  return (
    <div className="page" style={{ justifyContent: "flex-start", paddingTop: "clamp(24px, 6vh, 48px)" }}>
      <SoundToggle />
      <div className="screen vk-fade-up">

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h2 style={{ fontSize: "18px", fontWeight: "700", color: "var(--t1)" }}>
              {isHost ? "Your Room" : "Joined Room"}
            </h2>
            <p style={{ fontSize: "12px", color: "var(--t2)", marginTop: "2px" }}>
              {isHost ? "You are the host" : `Hosted by ${players.find(p => p.is_host)?.name || "..."}`}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <HowToPlay />
            <button onClick={leaveRoom}
              style={{ fontSize: "12px", color: "var(--t2)", background: "none", border: "none", cursor: "pointer" }}>
              Leave
            </button>
          </div>
        </div>

        {/* Room code — ticket style */}
        <div className="card" style={{ display: "flex", alignItems: "stretch", gap: "14px", padding: "16px 18px" }}>
          <div style={{ flex: 1 }}>
            <div className="label">🎟 Room code</div>
            <div style={{ fontSize: "clamp(30px, 9vw, 38px)", fontWeight: "800", color: "var(--accent-dark)", letterSpacing: "0.16em", lineHeight: 1 }}>
              {code}
            </div>
          </div>
          <div style={{ width: "1px", background: "repeating-linear-gradient(to bottom, var(--border2) 0 5px, transparent 5px 10px)" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", justifyContent: "center" }}>
            <button onClick={() => { sfx.tap(); copyCode(); }}
              style={{ fontSize: "11px", fontWeight: 600, padding: "7px 14px", borderRadius: "999px", background: "var(--bg3)", color: "var(--accent-dark)", border: "1px solid var(--border2)", cursor: "pointer" }}>
              Copy
            </button>
            <button onClick={() => { sfx.tap(); shareRoom(); }}
              style={{ fontSize: "11px", fontWeight: 600, padding: "7px 14px", borderRadius: "999px", background: "var(--bg3)", color: "var(--accent-dark)", border: "1px solid var(--border2)", cursor: "pointer" }}>
              Share ↗
            </button>
          </div>
        </div>

        {/* QR code — scan to join, no code typing */}
        {joinUrl && (
          <div className="card" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", padding: showQR ? "18px" : "12px 18px" }}>
            {showQR && <QRCode value={joinUrl} size={168} />}
            <button onClick={() => { sfx.tap(); setShowQR(v => !v); }}
              style={{ fontSize: "12px", fontWeight: 600, color: "var(--accent-dark)", background: "none", border: "none", cursor: "pointer" }}>
              {showQR ? "📷 Scan to join — tap to hide" : "📷 Show QR to join"}
            </button>
          </div>
        )}

        {/* Players list */}
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <div className="label" style={{ margin: 0 }}>Players</div>
            <div style={{ fontSize: "12px", color: "var(--t2)", fontWeight: "500" }}>
              {players.length} / 15
            </div>
          </div>

          {/* Progress bar */}
          <div style={{ height: "3px", background: "var(--bg3)", borderRadius: "2px", marginBottom: "12px" }}>
            <div style={{ height: "100%", width: `${(players.length / 15) * 100}%`, background: "var(--accent)", borderRadius: "2px", transition: "width 0.3s" }} />
          </div>

          {players.map((p, i) => {
            const online = onlineIds.size === 0 || onlineIds.has(p.id);
            return (
            <div key={p.id} className="vk-fade-up" style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 0", borderBottom: i < players.length - 1 ? "0.5px solid var(--border)" : "none", animationDelay: `${i * 0.05}s`, opacity: online ? 1 : 0.45 }}>
              <div className="avatar" style={{ background: avatarColor(p.name) }}>
                {p.name[0].toUpperCase()}
              </div>
              <div style={{ flex: 1, fontSize: "14px", color: "var(--t1)", display: "flex", alignItems: "center", gap: "7px" }}>
                {p.name}
                <span className={online ? "dot dot-on" : "dot dot-off"} title={online ? "online" : "offline"} />
              </div>
              <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
                {p.is_host && (
                  <span style={{ fontSize: "10px", background: "var(--bg3)", color: "var(--accent)", borderRadius: "4px", padding: "2px 7px" }}>
                    host
                  </span>
                )}
                {p.id === myId && (
                  <span style={{ fontSize: "10px", color: "var(--t3)" }}>you</span>
                )}
                {isHost && p.id !== myId && (
                  <button onClick={() => { sfx.tap(); kickPlayer(p); }} title={`Remove ${p.name}`}
                    style={{ fontSize: "13px", color: "var(--t3)", background: "none", border: "none", cursor: "pointer", padding: "2px 4px", lineHeight: 1 }}>
                    ✕
                  </button>
                )}
              </div>
            </div>
            );
          })}

          {players.length < 3 && (
            <p style={{ fontSize: "11px", color: "var(--t3)", marginTop: "10px", fontStyle: "italic" }}>
              Need at least {3 - players.length} more player{3 - players.length > 1 ? "s" : ""} to start...
            </p>
          )}
        </div>

        {/* Settings summary — visible to all */}
        {room && (
          <div className="card" style={{ fontSize: "12px", color: "var(--t2)", display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ fontSize: "11px", fontWeight: "500", color: "var(--t3)", marginBottom: "2px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Game settings</div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <span>Categories</span>
              <span style={{ color: "var(--t1)", textAlign: "right" }}>{categorySummary(room, categories)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Imposters</span>
              <span style={{ color: "var(--t1)" }}>{room.imposter_count}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Reveal mode</span>
              <span style={{ color: "var(--t1)" }}>{room.reveal_mode === "own" ? "Own phone" : "Pass device"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Timer</span>
              <span style={{ color: "var(--t1)" }}>{room.timer_enabled ? `${room.timer_seconds}s` : "Off"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <span>Imposter sees</span>
              <span style={{ color: "var(--t1)", textAlign: "right" }}>
                {[
                  room.hints_enabled === false ? null : "Hint",
                  room.show_category ? "Category" : null,
                  room.show_word_length ? "Length" : null,
                  room.show_first_letter ? "First letter" : null,
                ].filter(Boolean).join(", ") || "Nothing"}
              </span>
            </div>
          </div>
        )}

        {startError && (
          <p style={{ fontSize: "13px", color: "var(--danger)", textAlign: "center" }}>{startError}</p>
        )}

        {/* HOST ONLY controls */}
        {isHost && (
          <>
            <button className="btn-outline" onClick={() => { sfx.tap(); setShowSettings(true); }}>
              ⚙️ Game Settings
            </button>
            <button className="btn-primary" onClick={() => { sfx.tap(); startGame(); }}
              disabled={players.length < 3}>
              Start Game →
            </button>
          </>
        )}

        {/* NON-HOST view */}
        {!isHost && me && (
          <div style={{ textAlign: "center", padding: "16px", background: "var(--bg2)", borderRadius: "12px", border: "0.5px solid var(--border2)" }}>
            <div style={{ fontSize: "20px", marginBottom: "6px" }}>⏳</div>
            <p style={{ fontSize: "14px", color: "var(--t2)" }}>
              Waiting for <strong style={{ color: "var(--t1)" }}>{players.find(p => p.is_host)?.name || "host"}</strong> to start...
            </p>
          </div>
        )}

      </div>

      {/* Settings modal — HOST ONLY */}
      {showSettings && isHost && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50 }}>
          <div style={{ background: "var(--bg2)", borderRadius: "20px 20px 0 0", padding: "24px 20px", width: "100%", maxWidth: "420px", maxHeight: "85vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: "14px" }}>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ fontSize: "16px", fontWeight: "600", color: "var(--t1)" }}>Game Settings</h3>
              <button onClick={() => setShowSettings(false)}
                style={{ color: "var(--t3)", background: "none", border: "none", fontSize: "20px", cursor: "pointer" }}>×</button>
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <div className="label" style={{ margin: 0 }}>Categories</div>
                <div style={{ display: "flex", gap: "14px" }}>
                  <button onClick={() => setSelectedCategoryIds(allCategoryIds)}
                    style={{ fontSize: "11px", fontWeight: 600, color: "var(--accent-dark)", background: "none", border: "none", cursor: "pointer" }}>
                    Select all
                  </button>
                  <button onClick={() => setSelectedCategoryIds([])}
                    style={{ fontSize: "11px", fontWeight: 600, color: "var(--t3)", background: "none", border: "none", cursor: "pointer" }}>
                    Deselect all
                  </button>
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {categories.map(c => {
                  const sel = catSelected(c.id);
                  return (
                    <button key={c.id} onClick={() => toggleCategory(c.id)}
                      style={{ padding: "7px 13px", borderRadius: "999px", fontSize: "12px", fontWeight: 600, cursor: "pointer",
                        border: `1px solid ${sel ? "var(--accent)" : "var(--border2)"}`,
                        background: sel ? "var(--accent)" : "var(--bg3)", color: sel ? "#fff" : "var(--t2)" }}>
                      {c.name}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: "11px", color: "var(--t3)", marginTop: "7px" }}>
                {selectedCategoryIds.length === 0
                  ? "Pick at least one (otherwise all are used)"
                  : selectedCategoryIds.length === allCategoryIds.length
                    ? "🎲 Random word from all categories"
                    : selectedCategoryIds.length === 1
                      ? "Random word from this category"
                      : `🎲 Random word from ${selectedCategoryIds.length} selected categories`}
              </div>
            </div>


            <div>
              <div className="label" style={{ marginBottom: "4px" }}>Hints — what the imposter sees</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", background: "var(--bg3)", borderRadius: "12px", padding: "12px 14px" }}>
                <SettingToggle label="Hint about the word" desc="The word&apos;s clue" on={hintsEnabled} onToggle={() => setHintsEnabled(!hintsEnabled)} />
                <SettingToggle label="Category" desc="e.g. Telugu Movies" on={showCategory} onToggle={() => setShowCategory(!showCategory)} />
                <SettingToggle label="Word length" desc="How many letters" on={showWordLength} onToggle={() => setShowWordLength(!showWordLength)} />
                <SettingToggle label="First letter" desc="The starting letter" on={showFirstLetter} onToggle={() => setShowFirstLetter(!showFirstLetter)} />
              </div>
            </div>

            <div>
              <div className="label">Number of imposters</div>
              <div style={{ display: "flex", gap: "8px" }}>
                {[1, 2, 3].map(n => (
                  <button key={n} onClick={() => setImposterCount(n)}
                    style={{ flex: 1, padding: "10px", borderRadius: "8px", border: `0.5px solid ${imposterCount === n ? "var(--accent)" : "var(--border2)"}`, background: imposterCount === n ? "var(--accent)" : "var(--bg3)", color: imposterCount === n ? "#fff" : "var(--t2)", cursor: "pointer", fontSize: "14px", fontWeight: "500" }}>
                    {n}
                  </button>
                ))}
              </div>
              {imposterCount >= 2 && (
                <div style={{ marginTop: "10px" }}>
                  <SettingToggle label="Imposters know each other" desc="Teammates see who the other imposter(s) are" on={impostersKnow} onToggle={() => setImpostersKnow(!impostersKnow)} />
                </div>
              )}
            </div>

            <div>
              <div className="label">Reveal mode</div>
              <div style={{ display: "flex", gap: "8px" }}>
                {(["own", "pass"] as const).map(m => (
                  <button key={m} onClick={() => setRevealMode(m)}
                    style={{ flex: 1, padding: "10px", borderRadius: "8px", border: `0.5px solid ${revealMode === m ? "var(--accent)" : "var(--border2)"}`, background: revealMode === m ? "var(--accent)" : "var(--bg3)", color: revealMode === m ? "#fff" : "var(--t2)", cursor: "pointer", fontSize: "13px" }}>
                    {m === "own" ? "Own phone" : "Pass device"}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <div className="label" style={{ margin: 0 }}>Discussion timer</div>
                <button onClick={() => setTimerEnabled(!timerEnabled)}
                  style={{ padding: "4px 12px", borderRadius: "20px", border: `0.5px solid ${timerEnabled ? "var(--accent)" : "var(--border2)"}`, background: timerEnabled ? "var(--accent)" : "var(--bg3)", color: timerEnabled ? "#fff" : "var(--t2)", cursor: "pointer", fontSize: "12px" }}>
                  {timerEnabled ? "On" : "Off"}
                </button>
              </div>
              {timerEnabled && (
                <div style={{ display: "flex", gap: "8px" }}>
                  {[60, 90, 120, 180, 300].map(s => (
                    <button key={s} onClick={() => setTimerSeconds(s)}
                      style={{ flex: 1, padding: "8px 4px", borderRadius: "8px", border: `0.5px solid ${timerSeconds === s ? "var(--accent)" : "var(--border2)"}`, background: timerSeconds === s ? "var(--accent)" : "var(--bg3)", color: timerSeconds === s ? "#fff" : "var(--t2)", cursor: "pointer", fontSize: "11px" }}>
                      {s < 60 ? `${s}s` : `${s / 60}m`}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ position: "sticky", bottom: 0, margin: "0 -20px -24px", padding: "12px 20px calc(24px + env(safe-area-inset-bottom))", background: "var(--bg2)", borderTop: "1px solid var(--border)" }}>
              <button className="btn-primary" onClick={saveSettings} disabled={savingSettings}>
                {savingSettings ? "Saving..." : "Save Settings"}
              </button>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

// The selected category pool: explicit list, or [] meaning "all" (with a
// legacy fallback to the old single category_id).
function catIdsFromRoom(r: { category_ids?: string[] | null; category_id?: string | null }): string[] {
  if (Array.isArray(r.category_ids) && r.category_ids.length) return r.category_ids;
  return r.category_id ? [r.category_id] : [];
}

function categorySummary(room: Room, categories: Category[]): string {
  const ids = catIdsFromRoom(room);
  if (ids.length === 0 || ids.length === categories.length) return "🎲 All (random)";
  if (ids.length === 1) return categories.find(c => c.id === ids[0])?.name || "1 category";
  return `🎲 ${ids.length} categories`;
}

function SettingToggle({ label, desc, on, onToggle }: { label: string; desc: string; on: boolean; onToggle: () => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
      <div>
        <div style={{ fontSize: "14px", color: "var(--t1)", fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: "11px", color: "var(--t3)", marginTop: "1px" }}>{desc}</div>
      </div>
      <button onClick={onToggle}
        style={{ flexShrink: 0, width: "52px", padding: "5px 0", borderRadius: "20px", border: `1px solid ${on ? "var(--accent)" : "var(--border2)"}`, background: on ? "var(--accent)" : "var(--bg2)", color: on ? "#fff" : "var(--t2)", cursor: "pointer", fontSize: "12px", fontWeight: 600 }}>
        {on ? "On" : "Off"}
      </button>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <RoomPage />
    </Suspense>
  );
}