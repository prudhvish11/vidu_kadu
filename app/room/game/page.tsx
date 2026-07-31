"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRoomPresence, removePlayerFromRoom } from "@/lib/presence";
import { avatarColor } from "@/lib/avatar";
import { sfx } from "@/lib/sound";
import SoundToggle from "@/components/SoundToggle";
import Confetti from "@/components/Confetti";

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
  reveal_mode: "own" | "pass";
  timer_enabled: boolean;
  timer_seconds: number;
  hints_enabled: boolean;
  show_category: boolean;
  show_word_length: boolean;
  show_first_letter: boolean;
};

type WordRow = {
  id: string;
  word: string;
  category_id?: string | null;
  hint?: string | null;
  hint_hard?: string | null; // legacy source; kept only as a pre-migration fallback
};

type Vote = { id: string; voter_id: string; target_id: string };

// Reveal ("who was the imposter") plays out in local, per-round steps that
// aren't stored in the DB — only room.status ("playing" | "voting" | "reveal")
// is shared across clients.
type RevealStep = "votes" | "result" | "scoreboard";

function computeResult(players: Player[], votes: Vote[]) {
  const tally = new Map<string, number>();
  for (const v of votes) tally.set(v.target_id, (tally.get(v.target_id) || 0) + 1);

  let topId: string | null = null;
  let topCount = 0;
  let tie = false;
  for (const p of players) {
    const c = tally.get(p.id) || 0;
    if (c > topCount) { topCount = c; topId = p.id; tie = false; }
    else if (c === topCount && c > 0) { tie = true; }
  }

  const topPlayer = players.find((p) => p.id === topId) || null;
  // Crew wins only if they land on a single, unambiguous imposter.
  const crewWins = !tie && topCount > 0 && !!topPlayer?.is_imposter;
  return { tally, topPlayer, tie, crewWins };
}

function GamePage() {
  const searchParams = useSearchParams();
  const code = searchParams.get("code") || "";
  const router = useRouter();

  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [votes, setVotes] = useState<Vote[]>([]);
  const [wordRow, setWordRow] = useState<WordRow | null>(null);
  const [categoryName, setCategoryName] = useState<string | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [revealed, setRevealed] = useState(false); // has *this* card been tapped open
  const [selectedTarget, setSelectedTarget] = useState("");
  const [votingBusy, setVotingBusy] = useState(false);
  const [revealStep, setRevealStep] = useState<RevealStep>("votes");
  const [showWhoVoted, setShowWhoVoted] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  const [playAgainBusy, setPlayAgainBusy] = useState(false);

  const votingAdvancedRef = useRef(false);

  const fetchRoom = useCallback(async () => {
    const { data } = await supabase.from("rooms").select().eq("code", code).single();
    if (data) setRoom(data);
    return data as Room | null;
  }, [code]);

  const fetchPlayers = useCallback(async (roomId: string) => {
    const { data } = await supabase.from("players").select().eq("room_id", roomId).order("joined_at");
    if (data) setPlayers(data);
  }, []);

  const fetchVotes = useCallback(async (roomId: string) => {
    const { data } = await supabase.from("votes").select().eq("room_id", roomId);
    if (data) setVotes(data);
  }, []);

  // Initial load + auth/status guards
  useEffect(() => {
    if (!code) { router.push("/"); return; }
    const id = localStorage.getItem("vk_player_id");
    if (!id) { router.push(`/?join=${code}`); return; }
    setMyId(id);

    async function init() {
      const { data: roomData } = await supabase.from("rooms").select().eq("code", code).single();
      if (!roomData) { setError("Room not found."); setLoading(false); return; }
      if (!["playing", "voting", "reveal"].includes(roomData.status)) {
        router.push(`/room?code=${code}`);
        return;
      }
      setRoom(roomData);
      await Promise.all([fetchPlayers(roomData.id), fetchVotes(roomData.id)]);
      setLoading(false);
    }
    init();
  }, [code, router, fetchPlayers, fetchVotes]);

  // Realtime subscriptions
  useEffect(() => {
    if (!room) return;
    const channel = supabase
      .channel(`game-${room.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `room_id=eq.${room.id}` },
        () => fetchPlayers(room.id))
      .on("postgres_changes", { event: "*", schema: "public", table: "votes", filter: `room_id=eq.${room.id}` },
        () => fetchVotes(room.id))
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${room.id}` },
        async () => {
          const updated = await fetchRoom();
          if (updated?.status === "lobby") router.push(`/room?code=${code}`);
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [room, fetchPlayers, fetchVotes, fetchRoom, code, router]);

  // hints default to ON, the rest default OFF when the column is null/absent.
  const hintsEnabled = room?.hints_enabled ?? true;
  const showCategory = room?.show_category ?? false;
  const showWordLength = room?.show_word_length ?? false;
  const showFirstLetter = room?.show_first_letter ?? false;

  // Look up the word row (for the hint text, and its category_id so the category
  // clue works even when the room's category is random / null). Needed whenever
  // the hint or the category clue is on.
  useEffect(() => {
    if ((!hintsEnabled && !showCategory) || !room?.word) { setWordRow(null); return; }
    let q = supabase.from("words").select().eq("word", room.word);
    if (room.category_id) q = q.eq("category_id", room.category_id);
    q.limit(1).maybeSingle().then(({ data }) => setWordRow(data || null));
  }, [hintsEnabled, showCategory, room?.word, room?.category_id]);

  // Category name for the imposter clue — from the room, or fall back to the
  // word's own category (used when the host chose "Random category").
  const clueCategoryId = room?.category_id || wordRow?.category_id || null;
  useEffect(() => {
    if (!showCategory || !clueCategoryId) { setCategoryName(null); return; }
    supabase
      .from("categories").select("name").eq("id", clueCategoryId).single()
      .then(({ data }) => setCategoryName(data?.name ?? null));
  }, [showCategory, clueCategoryId]);

  // Reset per-round local UI state whenever the room phase changes
  useEffect(() => {
    setRevealed(false);
    setSelectedTarget("");
    setRevealStep("votes");
    setShowWhoVoted(false);
  }, [room?.status]);

  useEffect(() => {
    if (room?.status !== "voting") votingAdvancedRef.current = false;
  }, [room?.status]);

  // Win/lose sting when the result is shown.
  useEffect(() => {
    if (room?.status === "reveal" && revealStep === "result") {
      if (computeResult(players, votes).crewWins) sfx.win();
      else sfx.lose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealStep, room?.status]);

  // Track live connections; auto-removes players who disconnect mid-game.
  useRoomPresence(room?.id ?? null, myId, players);

  async function leaveRoom() {
    if (myId && room) await removePlayerFromRoom(room.id, myId, players);
    router.push("/");
  }

  const isHost = !!(myId && room && room.host_id === myId);
  const me = players.find((p) => p.id === myId) || null;
  const allRevealed = players.length > 0 && players.every((p) => p.has_revealed);
  const currentPassPlayer = players.find((p) => !p.has_revealed) || null;

  // Discussion countdown (host and players roughly sync since all clients
  // enter "discussion" together via allRevealed becoming true)
  useEffect(() => {
    if (!room || room.status !== "playing" || !allRevealed || !room.timer_enabled) return;
    setTimeLeft(room.timer_seconds);
    const iv = setInterval(() => setTimeLeft((t) => Math.max(0, t - 1)), 1000);
    return () => clearInterval(iv);
  }, [room?.status, allRevealed, room?.timer_enabled, room?.timer_seconds, room]);

  // Auto-advance to reveal once everyone has voted. Scoring is applied here,
  // during the one-time voting -> reveal transition, so a host reload while in
  // the reveal phase never re-applies scores. supabase-js query builders are
  // lazy — each call must be awaited to actually execute.
  useEffect(() => {
    if (!room || room.status !== "voting" || !isHost) return;
    if (votingAdvancedRef.current) return;
    if (players.length === 0 || votes.length < players.length) return;
    votingAdvancedRef.current = true;

    (async () => {
      const { crewWins } = computeResult(players, votes);
      for (const p of players) {
        const patch = p.is_imposter
          ? { wins: crewWins ? p.wins : p.wins + 1, losses: crewWins ? p.losses + 1 : p.losses, times_caught: crewWins ? p.times_caught + 1 : p.times_caught }
          : { wins: crewWins ? p.wins + 1 : p.wins, losses: crewWins ? p.losses : p.losses + 1 };
        await supabase.from("players").update(patch).eq("id", p.id);
      }
      const { error } = await supabase.from("rooms").update({ status: "reveal" }).eq("id", room.id);
      if (error) votingAdvancedRef.current = false;
    })();
  }, [room, isHost, players, votes]);

  async function markRevealed(playerId: string) {
    await supabase.from("players").update({ has_revealed: true }).eq("id", playerId);
  }

  async function startVoting() {
    if (!room) return;
    await supabase.from("rooms").update({ status: "voting" }).eq("id", room.id);
  }

  async function castVote() {
    if (!room || !myId || !selectedTarget) return;
    setVotingBusy(true);
    sfx.vote();
    await supabase.from("votes").insert({ room_id: room.id, voter_id: myId, target_id: selectedTarget });
    setVotingBusy(false);
  }

  async function playAgain() {
    if (!room) return;
    setPlayAgainBusy(true);
    await supabase.from("votes").delete().eq("room_id", room.id);
    for (const p of players) {
      await supabase.from("players").update({ is_imposter: false, is_eliminated: false, has_revealed: false }).eq("id", p.id);
    }
    await supabase.from("rooms").update({ status: "lobby", word: null }).eq("id", room.id);
    setPlayAgainBusy(false);
  }

  if (loading) return (
    <div className="page">
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "14px" }}>
        <div className="spinner" />
        <div style={{ color: "var(--t3)", fontSize: "14px" }}>Loading game...</div>
      </div>
    </div>
  );

  if (error || !room) return (
    <div className="page">
      <div className="screen" style={{ textAlign: "center", gap: "16px" }}>
        <p style={{ color: "var(--danger)" }}>{error || "Something went wrong."}</p>
        <button className="btn-outline" onClick={() => router.push("/")}>Go Home</button>
      </div>
    </div>
  );

  // ---- Phase: word reveal ----
  if (room.status === "playing" && !allRevealed) {
    if (room.reveal_mode === "pass") {
      if (!currentPassPlayer) return null;
      return (
        <PassRevealScreen
          player={currentPassPlayer}
          hintsEnabled={hintsEnabled}
          showCategory={showCategory}
          categoryName={categoryName}
          showWordLength={showWordLength}
          showFirstLetter={showFirstLetter}
          word={room.word}
          wordRow={wordRow}
          revealed={revealed}
          onReveal={() => setRevealed(true)}
          onDone={() => { setRevealed(false); markRevealed(currentPassPlayer.id); }}
        />
      );
    }
    if (!me) return null;
    if (me.has_revealed) {
      const doneCount = players.filter((p) => p.has_revealed).length;
      return (
        <WaitingScreen title="Word revealed!" subtitle={`Waiting for everyone to look... (${doneCount}/${players.length})`} onLeave={leaveRoom} />
      );
    }
    return (
      <OwnRevealScreen
        me={me}
        hintsEnabled={hintsEnabled}
        showCategory={showCategory}
        categoryName={categoryName}
        showWordLength={showWordLength}
        showFirstLetter={showFirstLetter}
        word={room.word}
        wordRow={wordRow}
        revealed={revealed}
        onReveal={() => setRevealed(true)}
        onDone={() => markRevealed(me.id)}
      />
    );
  }

  // ---- Phase: discussion ----
  if (room.status === "playing" && allRevealed) {
    const mm = String(Math.floor(timeLeft / 60)).padStart(2, "0");
    const ss = String(timeLeft % 60).padStart(2, "0");
    return (
      <div className="page">
        <LeaveButton onLeave={leaveRoom} />
        <SoundToggle />
        <div className="screen vk-phase" style={{ textAlign: "center", gap: "16px" }}>
          <div className="vk-float" style={{ fontSize: "44px" }}>🗣️</div>
          <h2 style={{ fontSize: "22px", fontWeight: "700", color: "var(--t1)" }}>Discussion time</h2>
          <p style={{ fontSize: "13px", color: "var(--t2)" }}>Talk it out — who doesn&apos;t know the word?</p>
          {room.timer_enabled && (
            <div className={timeLeft <= 10 && timeLeft > 0 ? "vk-pulse" : undefined}
              style={{ fontSize: "52px", fontWeight: "800", color: timeLeft === 0 ? "var(--danger)" : "var(--accent)", letterSpacing: "0.03em", fontVariantNumeric: "tabular-nums" }}>
              {mm}:{ss}
            </div>
          )}
          {isHost ? (
            <button className="btn-primary" onClick={() => { sfx.tap(); startVoting(); }}>Start Voting →</button>
          ) : (
            <p style={{ fontSize: "12px", color: "var(--t3)" }}>Waiting for host to start voting...</p>
          )}
        </div>
      </div>
    );
  }

  // ---- Phase: voting ----
  if (room.status === "voting") {
    const myVote = votes.find((v) => v.voter_id === myId);
    if (myVote) {
      const target = players.find((p) => p.id === myVote.target_id);
      return (
        <WaitingScreen
          title={`You voted for ${target?.name || "..."}`}
          subtitle={`Waiting for others... (${votes.length}/${players.length})`}
          onLeave={leaveRoom}
        />
      );
    }
    const candidates = players.filter((p) => p.id !== myId && !p.is_eliminated);
    return (
      <div className="page" style={{ justifyContent: "flex-start", paddingTop: "clamp(24px, 6vh, 48px)" }}>
        <LeaveButton onLeave={leaveRoom} />
        <SoundToggle />
        <div className="screen vk-phase">
          <div style={{ textAlign: "center", marginBottom: "4px" }}>
            <div style={{ fontSize: "36px" }}>🗳️</div>
            <h2 style={{ fontSize: "20px", fontWeight: "700", color: "var(--t1)" }}>Who&apos;s the imposter?</h2>
          </div>
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {candidates.map((p) => {
              const sel = selectedTarget === p.id;
              return (
              <button key={p.id} onClick={() => { sfx.tap(); setSelectedTarget(p.id); }}
                style={{ display: "flex", alignItems: "center", gap: "10px", textAlign: "left", padding: "10px 12px", borderRadius: "12px", cursor: "pointer",
                  border: `1px solid ${sel ? "var(--accent)" : "var(--border2)"}`,
                  background: sel ? "rgba(255,122,0,0.16)" : "rgba(255,255,255,0.5)",
                  color: "var(--t1)", fontSize: "14px", transition: "background 0.15s, border-color 0.15s, transform 0.1s" }}>
                <span className="avatar" style={{ width: "28px", height: "28px", fontSize: "12px", background: avatarColor(p.name) }}>
                  {p.name[0].toUpperCase()}
                </span>
                <span style={{ flex: 1 }}>{p.name}</span>
                {sel && <span style={{ color: "var(--accent)", fontSize: "16px" }}>✓</span>}
              </button>
              );
            })}
          </div>
          <button className="btn-primary" onClick={castVote} disabled={!selectedTarget || votingBusy}>
            {votingBusy ? "Casting vote..." : "Cast Vote"}
          </button>
        </div>
      </div>
    );
  }

  // ---- Phase: reveal (votes → result → scoreboard) ----
  if (room.status === "reveal") {
    if (revealStep === "votes") {
      const maxVotes = Math.max(1, ...players.map((p) => votes.filter((v) => v.target_id === p.id).length));
      return (
        <div className="page" style={{ justifyContent: "flex-start", paddingTop: "clamp(24px, 6vh, 48px)" }}>
          <LeaveButton onLeave={leaveRoom} />
          <SoundToggle />
          <div className="screen vk-phase">
            <h2 style={{ fontSize: "20px", fontWeight: "700", color: "var(--t1)", textAlign: "center" }}>Votes are in</h2>
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {players.map((p) => {
                const count = votes.filter((v) => v.target_id === p.id).length;
                return (
                  <div key={p.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", color: "var(--t1)", marginBottom: "5px" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span className="avatar" style={{ width: "22px", height: "22px", fontSize: "10px", background: avatarColor(p.name) }}>{p.name[0].toUpperCase()}</span>
                        {p.name}
                      </span>
                      <span style={{ color: "var(--t2)", fontWeight: "600" }}>{count}</span>
                    </div>
                    <div style={{ height: "9px", background: "var(--bg3)", borderRadius: "5px", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${(count / maxVotes) * 100}%`, background: "linear-gradient(90deg, var(--accent-light), var(--accent))", borderRadius: "5px", animation: "vk-bar 0.6s ease both" }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <button className="btn-outline" onClick={() => { sfx.tap(); setShowWhoVoted((s) => !s); }}>
              {showWhoVoted ? "Hide" : "Show"} who voted for whom
            </button>
            {showWhoVoted && (
              <div className="card" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {votes.map((v) => (
                  <div key={v.id} style={{ fontSize: "13px", color: "var(--t2)", display: "flex", justifyContent: "space-between" }}>
                    <span>{players.find((p) => p.id === v.voter_id)?.name || "?"}</span>
                    <span style={{ color: "var(--t1)" }}>→ {players.find((p) => p.id === v.target_id)?.name || "?"}</span>
                  </div>
                ))}
              </div>
            )}
            <button className="btn-primary" onClick={() => { sfx.tap(); setRevealStep("result"); }}>Reveal Imposter →</button>
          </div>
        </div>
      );
    }

    if (revealStep === "result") {
      const { crewWins } = computeResult(players, votes);
      const imposters = players.filter((p) => p.is_imposter);
      return (
        <div className="page" style={{ background: crewWins ? undefined : "radial-gradient(circle at 50% 30%, #2A0F0F, #140707)" }}>
          {crewWins && <Confetti />}
          <SoundToggle />
          <div className="screen" style={{ textAlign: "center", gap: "16px" }}>
            <div className="vk-pop" style={{ fontSize: "60px" }}>{crewWins ? "🎉" : "😈"}</div>
            <h2 className="vk-pop" style={{ fontSize: "28px", fontWeight: "800", color: crewWins ? "var(--accent-light)" : "var(--danger)", animationDelay: "0.08s" }}>
              {crewWins ? "Crew Wins!" : "Imposter Wins!"}
            </h2>
            <p className="vk-fade-up" style={{ fontSize: "14px", color: "var(--t2)", animationDelay: "0.2s" }}>
              {imposters.length > 1 ? "The imposters were" : "The imposter was"}{" "}
              <strong style={{ color: "var(--t1)" }}>{imposters.map((p) => p.name).join(", ")}</strong>
            </p>
            {room.word && (
              <p className="vk-fade-up" style={{ fontSize: "13px", color: "var(--t3)", animationDelay: "0.28s" }}>The word was <strong style={{ color: "var(--t1)" }}>{room.word}</strong></p>
            )}
            <button className="btn-primary" onClick={() => { sfx.tap(); setRevealStep("scoreboard"); }}>See Scoreboard →</button>
          </div>
        </div>
      );
    }

    // scoreboard
    const sorted = [...players].sort((a, b) => b.wins - a.wins);
    const medals = ["🥇", "🥈", "🥉"];
    return (
      <div className="page" style={{ justifyContent: "flex-start", paddingTop: "clamp(24px, 6vh, 48px)" }}>
        <LeaveButton onLeave={leaveRoom} />
        <SoundToggle />
        <div className="screen vk-phase">
          <h2 style={{ fontSize: "20px", fontWeight: "700", color: "var(--t1)", textAlign: "center" }}>🏆 Scoreboard</h2>
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0" }}>
            <div style={{ display: "flex", fontSize: "10px", color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.06em", padding: "0 0 8px", borderBottom: "0.5px solid var(--border)" }}>
              <span style={{ flex: 1 }}>Player</span>
              <span style={{ width: "40px", textAlign: "center" }}>W</span>
              <span style={{ width: "40px", textAlign: "center" }}>L</span>
              <span style={{ width: "56px", textAlign: "center" }}>Caught</span>
            </div>
            {sorted.map((p, i) => (
              <div key={p.id} className="vk-fade-up" style={{ display: "flex", alignItems: "center", gap: "9px", fontSize: "14px", color: "var(--t1)", padding: "10px 0", borderBottom: i < sorted.length - 1 ? "0.5px solid var(--border)" : "none", animationDelay: `${i * 0.06}s` }}>
                <span style={{ width: "20px", textAlign: "center", fontSize: "14px" }}>{medals[i] || <span style={{ color: "var(--t3)", fontSize: "12px" }}>{i + 1}</span>}</span>
                <span className="avatar" style={{ width: "26px", height: "26px", fontSize: "11px", background: avatarColor(p.name) }}>{p.name[0].toUpperCase()}</span>
                <span style={{ flex: 1 }}>{p.name}{p.id === myId ? " (you)" : ""}</span>
                <span style={{ width: "40px", textAlign: "center", color: "var(--accent-light)", fontWeight: "600" }}>{p.wins}</span>
                <span style={{ width: "40px", textAlign: "center", color: "var(--danger)" }}>{p.losses}</span>
                <span style={{ width: "56px", textAlign: "center", color: "var(--t2)" }}>{p.times_caught}</span>
              </div>
            ))}
          </div>
          {isHost ? (
            <button className="btn-primary" onClick={() => { sfx.tap(); playAgain(); }} disabled={playAgainBusy}>
              {playAgainBusy ? "Starting..." : "Play Again"}
            </button>
          ) : (
            <p style={{ fontSize: "12px", color: "var(--t3)", textAlign: "center" }}>Waiting for host to start the next round...</p>
          )}
        </div>
      </div>
    );
  }

  return null;
}

export default function Page() {
  return (
    <Suspense>
      <GamePage />
    </Suspense>
  );
}

function LeaveButton({ onLeave }: { onLeave: () => void }) {
  return (
    <button onClick={onLeave}
      style={{ position: "fixed", top: "14px", left: "14px", zIndex: 30, fontSize: "12px", fontWeight: 600, color: "var(--accent-dark)", cursor: "pointer",
        padding: "7px 13px", borderRadius: "999px",
        background: "linear-gradient(160deg, rgba(255,255,255,0.7), rgba(255,255,255,0.35))",
        backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
        border: "1px solid var(--glass-border)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.9)" }}>
      ← Leave
    </button>
  );
}

function WaitingScreen({ title, subtitle, onLeave }: { title: string; subtitle: string; onLeave?: () => void }) {
  return (
    <div className="page">
      {onLeave && <LeaveButton onLeave={onLeave} />}
      <div className="screen vk-fade-up" style={{ textAlign: "center", gap: "12px", alignItems: "center" }}>
        <div className="vk-float" style={{ fontSize: "36px" }}>⏳</div>
        <h2 style={{ fontSize: "18px", fontWeight: "700", color: "var(--t1)" }}>{title}</h2>
        <p style={{ fontSize: "13px", color: "var(--t3)" }}>{subtitle}</p>
        <div className="spinner" style={{ marginTop: "4px" }} />
      </div>
    </div>
  );
}

// A word has a single hint. Prefer a dedicated `hint` column if present,
// otherwise fall back to the legacy difficulty columns.
function getHint(wordRow: WordRow | null) {
  if (!wordRow) return "No hint available";
  return wordRow.hint || wordRow.hint_hard || "No hint available";
}

function RevealCard({
  isImposter, hintsEnabled, showCategory, categoryName, showWordLength, showFirstLetter, word, wordRow, revealed, onReveal, onDone, prompt,
}: {
  isImposter: boolean;
  hintsEnabled: boolean;
  showCategory: boolean;
  categoryName: string | null;
  showWordLength: boolean;
  showFirstLetter: boolean;
  word: string | null;
  wordRow: WordRow | null;
  revealed: boolean;
  onReveal: () => void;
  onDone: () => void;
  prompt: string;
}) {
  const holdRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [holding, setHolding] = useState(false);
  const letters = word ? word.replace(/\s+/g, "").length : 0;
  const firstLetter = word ? (word.trim()[0] || "").toUpperCase() : "";
  const hasCategory = showCategory && !!categoryName;
  const anyClue = hintsEnabled || hasCategory || (showWordLength && !!word) || (showFirstLetter && !!word);
  const bg = isImposter ? "radial-gradient(circle at 50% 25%, #2A0F0F, #140707)" : undefined;
  const accentColor = isImposter ? "#FF6B6B" : "var(--accent)";
  const accentDark = isImposter ? "#C0392B" : "var(--accent-dark)";

  function startHold() {
    setHolding(true);
    holdRef.current = setTimeout(() => { setHolding(false); sfx.reveal(); onReveal(); }, 750);
  }
  function cancelHold() {
    setHolding(false);
    if (holdRef.current) { clearTimeout(holdRef.current); holdRef.current = undefined; }
  }

  return (
    <div className="page" style={{ background: bg }}>
      <SoundToggle />
      <div className="screen" style={{ textAlign: "center", gap: "18px" }}>
        <p style={{ fontSize: "13px", color: isImposter ? "#f0b9b9" : "var(--t2)" }}>{prompt}</p>
        {!revealed ? (
          <button
            onPointerDown={startHold} onPointerUp={cancelHold} onPointerLeave={cancelHold} onPointerCancel={cancelHold}
            onContextMenu={(e) => e.preventDefault()}
            style={{ position: "relative", overflow: "hidden", width: "100%", padding: "16px 24px", borderRadius: "16px", border: `1px solid ${isImposter ? "rgba(255,120,120,0.6)" : "rgba(255,150,60,0.7)"}`, background: `linear-gradient(160deg, ${accentColor}, ${accentDark})`, color: "#fff", fontSize: "15px", fontWeight: 700, cursor: "pointer", boxShadow: `0 9px 22px -7px ${accentColor}`, touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}>
            <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: holding ? "100%" : "0%", background: "rgba(255,255,255,0.28)", transition: holding ? "width 0.75s linear" : "width 0.15s ease" }} />
            <span style={{ position: "relative" }}>{holding ? "Keep holding…" : "👆 Hold to reveal"}</span>
          </button>
        ) : (
          <div className="vk-flip" style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            {isImposter ? (
              <div className="card" style={{ background: "rgba(255,107,107,0.08)", border: "0.5px solid #5A1A1A", padding: "24px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>
                <div style={{ fontSize: "44px" }}>🎭</div>
                <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#FF6B6B" }}>You are the imposter</h2>
                {hasCategory && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <p style={{ fontSize: "11px", color: "#C99", textTransform: "uppercase", letterSpacing: "0.08em" }}>Category</p>
                    <p style={{ fontSize: "18px", fontWeight: "700", color: "#FFB3B3" }}>{categoryName}</p>
                  </div>
                )}
                {showFirstLetter && word && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <p style={{ fontSize: "11px", color: "#C99", textTransform: "uppercase", letterSpacing: "0.08em" }}>Starts with</p>
                    <p style={{ fontSize: "22px", fontWeight: "800", color: "#FFB3B3" }}>{firstLetter}</p>
                  </div>
                )}
                {showWordLength && word && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <p style={{ fontSize: "11px", color: "#C99", textTransform: "uppercase", letterSpacing: "0.08em" }}>Word length</p>
                    <p style={{ fontSize: "18px", fontWeight: "700", color: "#FFB3B3", letterSpacing: "0.15em" }}>
                      {"_ ".repeat(letters).trim()}
                    </p>
                    <p style={{ fontSize: "12px", color: "#C99" }}>{letters} letters</p>
                  </div>
                )}
                {hintsEnabled && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <p style={{ fontSize: "11px", color: "#C99", textTransform: "uppercase", letterSpacing: "0.08em" }}>Hint</p>
                    <p style={{ fontSize: "26px", fontWeight: "800", color: "#FF6B6B" }}>{getHint(wordRow)}</p>
                  </div>
                )}
                {!anyClue && (
                  <p style={{ fontSize: "14px", color: "#C99" }}>No clues — blend in and don&apos;t get caught.</p>
                )}
              </div>
            ) : (
              <div className="card" style={{ padding: "28px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>
                <p style={{ fontSize: "11px", color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>The word is</p>
                <h2 style={{ fontSize: "34px", fontWeight: "800", color: "var(--t1)", letterSpacing: "-0.01em" }}>{word}</h2>
              </div>
            )}
            <button className="btn-outline" onClick={() => { sfx.tap(); onDone(); }}>Got it</button>
          </div>
        )}
      </div>
    </div>
  );
}

function OwnRevealScreen({
  me, hintsEnabled, showCategory, categoryName, showWordLength, showFirstLetter, word, wordRow, revealed, onReveal, onDone,
}: {
  me: Player;
  hintsEnabled: boolean;
  showCategory: boolean;
  categoryName: string | null;
  showWordLength: boolean;
  showFirstLetter: boolean;
  word: string | null;
  wordRow: WordRow | null;
  revealed: boolean;
  onReveal: () => void;
  onDone: () => void;
}) {
  return (
    <RevealCard
      isImposter={me.is_imposter}
      hintsEnabled={hintsEnabled}
      showCategory={showCategory}
      categoryName={categoryName}
      showWordLength={showWordLength}
      showFirstLetter={showFirstLetter}
      word={word}
      wordRow={wordRow}
      revealed={revealed}
      onReveal={onReveal}
      onDone={onDone}
      prompt="Take a look, then hide it before you show your neighbor."
    />
  );
}

function PassRevealScreen({
  player, hintsEnabled, showCategory, categoryName, showWordLength, showFirstLetter, word, wordRow, revealed, onReveal, onDone,
}: {
  player: Player;
  hintsEnabled: boolean;
  showCategory: boolean;
  categoryName: string | null;
  showWordLength: boolean;
  showFirstLetter: boolean;
  word: string | null;
  wordRow: WordRow | null;
  revealed: boolean;
  onReveal: () => void;
  onDone: () => void;
}) {
  if (!revealed) {
    return (
      <div className="page">
        <SoundToggle />
        <div className="screen vk-phase" style={{ textAlign: "center", gap: "16px" }}>
          <div className="vk-float" style={{ fontSize: "44px" }}>📱</div>
          <h2 style={{ fontSize: "20px", fontWeight: "700", color: "var(--t1)" }}>Pass the phone to</h2>
          <p style={{ fontSize: "28px", fontWeight: "800", color: "var(--accent-dark)" }}>{player.name}</p>
          <button className="btn-primary" onClick={() => { sfx.tap(); onReveal(); }}>I&apos;m {player.name}, tap to reveal</button>
        </div>
      </div>
    );
  }
  return (
    <RevealCard
      isImposter={player.is_imposter}
      hintsEnabled={hintsEnabled}
      showCategory={showCategory}
      categoryName={categoryName}
      showWordLength={showWordLength}
      showFirstLetter={showFirstLetter}
      word={word}
      wordRow={wordRow}
      revealed={revealed}
      onReveal={onReveal}
      onDone={onDone}
      prompt={`${player.name}, don't let anyone else see`}
    />
  );
}
