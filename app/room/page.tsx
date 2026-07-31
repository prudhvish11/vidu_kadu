"use client";
import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRoomPresence, removePlayerFromRoom } from "@/lib/presence";
import { avatarColor } from "@/lib/avatar";
import { sfx } from "@/lib/sound";
import SoundToggle from "@/components/SoundToggle";

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
  imposter_count: number;
  reveal_mode: string;
  timer_enabled: boolean;
  timer_seconds: number;
  hints_enabled: boolean;
  show_category: boolean;
};

type Category = { id: string; name: string };
type Word = { id: string; word: string };

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
  const [words, setWords] = useState<Word[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [selectedWord, setSelectedWord] = useState<string>("");
  const [imposterCount, setImposterCount] = useState(1);
  const [revealMode, setRevealMode] = useState<"own" | "pass">("own");
  const [timerEnabled, setTimerEnabled] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(120);
  const [hintsEnabled, setHintsEnabled] = useState(true);
  const [showCategory, setShowCategory] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [startError, setStartError] = useState("");

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
      setSelectedCategory(data.category_id || "");
    }
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

      setRoom(roomData);
      setImposterCount(roomData.imposter_count);
      setRevealMode(roomData.reveal_mode);
      setTimerEnabled(roomData.timer_enabled);
      setTimerSeconds(roomData.timer_seconds);
      setHintsEnabled(roomData.hints_enabled ?? true);
      setShowCategory(roomData.show_category ?? false);
      setSelectedCategory(roomData.category_id || "");

      await fetchPlayers(roomData.id);

      if (["playing", "voting", "reveal"].includes(roomData.status)) {
        router.push(`/room/game?code=${code}`);
        return;
      }
      setLoading(false);
    }
    init();
  }, [code, router, fetchPlayers]);

  // Realtime subscriptions
  useEffect(() => {
    if (!room) return;
    const channel = supabase.channel(`lobby-${room.id}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "players", filter: `room_id=eq.${room.id}` },
        () => fetchPlayers(room.id))
      .on("postgres_changes",
        { event: "*", schema: "public", table: "rooms", filter: `id=eq.${room.id}` },
        async () => {
          await fetchRoom();
          const { data } = await supabase
            .from("rooms").select("status").eq("id", room.id).single();
          if (data?.status === "playing") router.push(`/room/game?code=${code}`);
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [room, fetchPlayers, fetchRoom, code, router]);

  // Track live connections; auto-removes players who disconnect.
  const onlineIds = useRoomPresence(room?.id ?? null, myId, players);

  async function leaveRoom() {
    if (myId && room) await removePlayerFromRoom(room.id, myId, players);
    router.push("/");
  }

  // Load categories
  useEffect(() => {
    supabase.from("categories").select()
      .then(({ data }) => { if (data) setCategories(data); });
  }, []);

  // Load words when category changes
  useEffect(() => {
    if (!selectedCategory) { setWords([]); return; }
    supabase.from("words").select().eq("category_id", selectedCategory)
      .then(({ data }) => { if (data) setWords(data); });
  }, [selectedCategory]);

  async function saveSettings() {
    if (!room) return;
    setSavingSettings(true);
    const randomWord = selectedWord ||
      (words.length > 0 ? words[Math.floor(Math.random() * words.length)].word : null);
    const base = {
      imposter_count: imposterCount,
      reveal_mode: revealMode,
      timer_enabled: timerEnabled,
      timer_seconds: timerSeconds,
      category_id: selectedCategory || null,
      word: randomWord,
    };
    // Try to persist everything, then progressively fall back so a not-yet-added
    // column (show_category needs a migration) never blocks the other settings.
    const full = { ...base, hints_enabled: hintsEnabled, show_category: showCategory };
    const { error } = await supabase.from("rooms").update(full).eq("id", room.id);
    if (error) {
      const { error: e2 } = await supabase.from("rooms")
        .update({ ...base, hints_enabled: hintsEnabled }).eq("id", room.id);
      if (e2) await supabase.from("rooms").update(base).eq("id", room.id);
    }
    setSavingSettings(false);
    setShowSettings(false);
  }

  async function startGame() {
    if (!room) return;
    setStartError("");
    if (players.length < 3) { setStartError("Need at least 3 players to start."); return; }

    let word = room.word;
    if (!word) {
      if (!selectedCategory) { setStartError("Pick a category in settings first."); return; }
      if (words.length > 0) word = words[Math.floor(Math.random() * words.length)].word;
    }

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

  async function shareRoom() {
    // Current URL already includes origin, basePath and ?code= — robust for any host.
    const url = window.location.href;
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
          <button onClick={leaveRoom}
            style={{ fontSize: "12px", color: "var(--t2)", background: "none", border: "none", cursor: "pointer" }}>
            Leave
          </button>
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
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Category</span>
              <span style={{ color: "var(--t1)" }}>{categories.find(c => c.id === room.category_id)?.name || "Not set"}</span>
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
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Imposter hint</span>
              <span style={{ color: "var(--t1)" }}>{room.hints_enabled === false ? "Off" : "On"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Show category</span>
              <span style={{ color: "var(--t1)" }}>{room.show_category ? "On" : "Off"}</span>
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
              <div className="label">Category</div>
              <select className="input" value={selectedCategory}
                onChange={e => { setSelectedCategory(e.target.value); setSelectedWord(""); }}
                style={{ appearance: "none" }}>
                <option value="">Pick a category</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {selectedCategory && words.length > 0 && (
              <div>
                <div className="label">Word (blank = random)</div>
                <select className="input" value={selectedWord}
                  onChange={e => setSelectedWord(e.target.value)}
                  style={{ appearance: "none" }}>
                  <option value="">Random word</option>
                  {words.map(w => <option key={w.id} value={w.word}>{w.word}</option>)}
                </select>
              </div>
            )}

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div className="label" style={{ margin: 0 }}>Show hint to imposter</div>
                  <div style={{ fontSize: "11px", color: "var(--t3)", marginTop: "2px" }}>Give the imposter the word&apos;s hint</div>
                </div>
                <button onClick={() => setHintsEnabled(!hintsEnabled)}
                  style={{ padding: "4px 14px", borderRadius: "20px", border: `1px solid ${hintsEnabled ? "var(--accent)" : "var(--border2)"}`, background: hintsEnabled ? "var(--accent)" : "var(--bg3)", color: hintsEnabled ? "#fff" : "var(--t2)", cursor: "pointer", fontSize: "12px", fontWeight: 600 }}>
                  {hintsEnabled ? "On" : "Off"}
                </button>
              </div>
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div className="label" style={{ margin: 0 }}>Show category to imposter</div>
                  <div style={{ fontSize: "11px", color: "var(--t3)", marginTop: "2px" }}>Reveal the category name (e.g. Telugu Movies)</div>
                </div>
                <button onClick={() => setShowCategory(!showCategory)}
                  style={{ padding: "4px 14px", borderRadius: "20px", border: `1px solid ${showCategory ? "var(--accent)" : "var(--border2)"}`, background: showCategory ? "var(--accent)" : "var(--bg3)", color: showCategory ? "#fff" : "var(--t2)", cursor: "pointer", fontSize: "12px", fontWeight: 600 }}>
                  {showCategory ? "On" : "Off"}
                </button>
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

            <button className="btn-primary" onClick={saveSettings} disabled={savingSettings}>
              {savingSettings ? "Saving..." : "Save Settings"}
            </button>

          </div>
        </div>
      )}
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