"use client";
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRoomPresence, removePlayerFromRoom } from "@/lib/presence";
import { avatarColor } from "@/lib/avatar";
import { sfx } from "@/lib/sound";
import SoundToggle from "@/components/SoundToggle";
import Confetti from "@/components/Confetti";
import Reactions from "@/components/Reactions";

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
  imposters_know?: boolean;
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

// The discussion turn order, starting from a randomly-chosen player (which may
// be a crew member OR the imposter — every player is eligible). Derived from a
// tiny hash of shared per-round state so every device shows the SAME order
// without storing anything, and it changes every round: the word is re-drawn
// and the imposter(s) re-assigned each round, so the seed shifts even if the
// same word happens to come up twice. `players` is in the same order on every
// client (always fetched ordered by joined_at).
function startingOrder(players: Player[], room: Room): Player[] {
  if (players.length === 0) return [];
  const imposterKey = players.filter((p) => p.is_imposter).map((p) => p.id).sort().join(",");
  const seed = `${room.word ?? ""}|${imposterKey}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const start = h % players.length;
  return [...players.slice(start), ...players.slice(0, start)];
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
  const [timeLeft, setTimeLeft] = useState(0);
  const [playAgainBusy, setPlayAgainBusy] = useState(false);

  const votingAdvancedRef = useRef(false);
  // After a runoff starts we must wait for the round-1 votes to actually clear
  // before accepting the next completion, otherwise an is_eliminated realtime
  // update that lands before the vote-delete makes "all voted" look true again.
  const awaitingRunoffClearRef = useRef(false);

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

  // Realtime subscriptions. Keyed on room.id (not the whole room object) so the
  // channel isn't torn down and rebuilt on every phase change — that rebuild
  // leaves a brief window where pushes are missed.
  useEffect(() => {
    const roomId = room?.id;
    if (!roomId) return;
    const channel = supabase
      .channel(`game-${roomId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomId}` },
        () => fetchPlayers(roomId))
      .on("postgres_changes", { event: "*", schema: "public", table: "votes", filter: `room_id=eq.${roomId}` },
        () => fetchVotes(roomId))
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
        async () => {
          const updated = await fetchRoom();
          if (updated?.status === "lobby") router.push(`/room?code=${code}`);
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [room?.id, fetchPlayers, fetchVotes, fetchRoom, code, router]);

  // Catch-up sync. iOS Safari suspends the Realtime socket when the phone locks
  // or the tab is backgrounded, so pushes alone let a phone fall behind. Re-fetch
  // whenever we return to the foreground, plus a light poll as a safety net, so
  // every device advances within a few seconds even if its socket is asleep.
  useEffect(() => {
    const roomId = room?.id;
    if (!roomId) return;
    const sync = () => {
      fetchRoom().then((updated) => {
        if (updated?.status === "lobby") router.push(`/room?code=${code}`);
      });
      fetchPlayers(roomId);
      fetchVotes(roomId);
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
  }, [room?.id, fetchRoom, fetchPlayers, fetchVotes, code, router]);

  // hints default to ON, the rest default OFF when the column is null/absent.
  const hintsEnabled = room?.hints_enabled ?? true;
  const showCategory = room?.show_category ?? false;
  const showWordLength = room?.show_word_length ?? false;
  const showFirstLetter = room?.show_first_letter ?? false;
  const impostersKnow = room?.imposters_know ?? false;
  // Fellow imposters a given imposter should be shown (when the toggle is on and
  // there are 2+). Excludes the viewer themselves.
  const teammatesFor = (playerId: string) =>
    impostersKnow
      ? players.filter((p) => p.is_imposter && p.id !== playerId).map((p) => p.name)
      : [];

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
  }, [room?.status]);

  useEffect(() => {
    if (room?.status !== "voting") { votingAdvancedRef.current = false; awaitingRunoffClearRef.current = false; }
  }, [room?.status]);

  // Win/lose sting when the reveal screen appears.
  useEffect(() => {
    if (room?.status === "reveal") {
      if (computeResult(players, votes).crewWins) sfx.win();
      else sfx.lose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.status]);

  // Track live connections, but NEVER auto-remove mid-game: a locked phone
  // drops its socket, and in pass-device mode everyone but the phone-holder is
  // offline the whole round. Players only leave in-game via the Leave button.
  useRoomPresence(room?.id ?? null, myId, players, false);

  async function leaveRoom() {
    try { localStorage.removeItem("vk_last_room"); } catch { /* ignore */ }
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

  // A tie-breaker runoff is in progress when some players have been marked out
  // of contention (is_eliminated) but the game is still voting.
  const isRunoff = players.some((p) => p.is_eliminated);

  // Tally votes and either (a) trigger a one-time runoff between the tied top
  // candidates, or (b) apply scores and move to reveal. Guarded by a ref so it
  // runs once per voting round. supabase-js builders are lazy — always await.
  const advanceToReveal = useCallback(async () => {
    if (!room || votingAdvancedRef.current) return;
    votingAdvancedRef.current = true;

    // Who's tied at the top of this round's votes?
    const counts = new Map<string, number>();
    for (const v of votes) counts.set(v.target_id, (counts.get(v.target_id) || 0) + 1);
    const max = Math.max(0, ...players.map((p) => counts.get(p.id) || 0));
    const tiedIds = players.filter((p) => (counts.get(p.id) || 0) === max && max > 0).map((p) => p.id);
    const alreadyRunoff = players.some((p) => p.is_eliminated);

    // First tie → run a single runoff between the tied players. A second tie
    // (in the runoff) falls through to reveal, where ties favor the imposter.
    if (tiedIds.length > 1 && !alreadyRunoff) {
      awaitingRunoffClearRef.current = true; // gate the effect until votes clear
      for (const p of players) {
        await supabase.from("players").update({ is_eliminated: !tiedIds.includes(p.id) }).eq("id", p.id);
      }
      await supabase.from("votes").delete().eq("room_id", room.id);
      votingAdvancedRef.current = false; // let the runoff round advance when it completes
      return;
    }

    const { crewWins } = computeResult(players, votes);
    for (const p of players) {
      const patch = p.is_imposter
        ? { wins: crewWins ? p.wins : p.wins + 1, losses: crewWins ? p.losses + 1 : p.losses, times_caught: crewWins ? p.times_caught + 1 : p.times_caught }
        : { wins: crewWins ? p.wins + 1 : p.wins, losses: crewWins ? p.losses : p.losses + 1 };
      await supabase.from("players").update(patch).eq("id", p.id);
    }
    const { error } = await supabase.from("rooms").update({ status: "reveal" }).eq("id", room.id);
    if (error) votingAdvancedRef.current = false;
  }, [room, players, votes]);

  // Auto-advance to reveal once everyone still in the room has voted. The host
  // can also force it from the waiting screen if someone is absent (see below).
  useEffect(() => {
    if (!room || room.status !== "voting" || !isHost) return;
    // Wait for the round-1 votes to actually clear after a runoff starts.
    if (awaitingRunoffClearRef.current) {
      if (votes.length === 0) awaitingRunoffClearRef.current = false;
      return;
    }
    if (players.length === 0 || votes.length < players.length) return;
    advanceToReveal();
  }, [room, isHost, players, votes, advanceToReveal]);

  async function markRevealed(playerId: string) {
    await supabase.from("players").update({ has_revealed: true }).eq("id", playerId);
  }

  // Host override: mark everyone who hasn't looked as revealed, so the round can
  // move to discussion even if an absent player never opened their card.
  async function skipRemainingReveals() {
    for (const p of players.filter((x) => !x.has_revealed)) {
      await supabase.from("players").update({ has_revealed: true }).eq("id", p.id);
    }
  }

  async function startVoting() {
    if (!room) return;
    await supabase.from("rooms").update({ status: "voting" }).eq("id", room.id);
  }

  async function castVote() {
    if (!room || !myId || !selectedTarget || votingBusy) return;
    setVotingBusy(true);
    sfx.vote();
    await supabase.from("votes").insert({ room_id: room.id, voter_id: myId, target_id: selectedTarget });
    // Always resync from the DB so the screen advances even if the Realtime echo
    // is missed (and a duplicate/failed insert self-corrects instead of hanging).
    await fetchVotes(room.id);
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
          teammates={teammatesFor(currentPassPlayer.id)}
          revealed={revealed}
          onReveal={() => setRevealed(true)}
          onDone={() => { setRevealed(false); markRevealed(currentPassPlayer.id); }}
        />
      );
    }
    if (!me) return null;
    if (me.has_revealed) {
      const doneCount = players.filter((p) => p.has_revealed).length;
      const pending = players.filter((p) => !p.has_revealed).map((p) => p.name);
      return (
        <WaitingScreen title="Word revealed!" subtitle={`${doneCount}/${players.length} have looked`}
          pendingLabel="Still looking:" pending={pending} onLeave={leaveRoom}
          action={isHost && pending.length > 0 ? (
            <button className="btn-outline" onClick={() => { sfx.tap(); skipRemainingReveals(); }}>
              Continue without them →
            </button>
          ) : undefined} />
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
        teammates={teammatesFor(me.id)}
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
    const order = startingOrder(players, room);
    return (
      <div className="page">
        <LeaveButton onLeave={leaveRoom} />
        <SoundToggle />
        <div className="screen vk-phase" style={{ textAlign: "center", gap: "16px" }}>
          <div className="vk-float" style={{ fontSize: "44px" }}>🗣️</div>
          <h2 style={{ fontSize: "22px", fontWeight: "700", color: "var(--t1)" }}>Discussion time</h2>
          <p style={{ fontSize: "13px", color: "var(--t2)" }}>Talk it out — who doesn&apos;t know the word?</p>

          <div className="glass" style={{ padding: "16px", borderRadius: "18px", width: "100%" }}>
            <p style={{ fontSize: "12px", fontWeight: "700", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--t3)", marginBottom: "12px" }}>
              🎤 Speaking order
            </p>
            <p style={{ fontSize: "15px", color: "var(--t2)", marginBottom: "14px" }}>
              <strong style={{ color: "var(--accent-dark)" }}>{order[0]?.name}</strong> starts
              {order.length > 1 && <> · <strong style={{ color: "var(--t1)" }}>{order[order.length - 1]?.name}</strong> ends</>}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center", alignItems: "center" }}>
              {order.map((p, i) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "7px", padding: "6px 12px 6px 8px", borderRadius: "999px",
                    background: i === 0 ? "var(--accent)" : "var(--bg2)",
                    border: i === 0 ? "none" : "1px solid var(--border)" }}>
                    <span style={{ display: "grid", placeItems: "center", width: "22px", height: "22px", borderRadius: "50%", background: avatarColor(p.name), color: "#fff", fontSize: "11px", fontWeight: "700" }}>
                      {i + 1}
                    </span>
                    <span style={{ fontSize: "14px", fontWeight: i === 0 ? "700" : "500", color: i === 0 ? "#fff" : "var(--t1)" }}>
                      {p.name}
                    </span>
                  </div>
                  {i < order.length - 1 && <span style={{ color: "var(--t3)", fontSize: "13px" }}>→</span>}
                </div>
              ))}
            </div>
          </div>

          {room.timer_enabled && (
            <div className={timeLeft <= 10 && timeLeft > 0 ? "vk-pulse" : undefined}
              style={{ fontSize: "52px", fontWeight: "800", color: timeLeft === 0 ? "var(--danger)" : "var(--accent)", letterSpacing: "0.03em", fontVariantNumeric: "tabular-nums" }}>
              {mm}:{ss}
            </div>
          )}

          <Reactions roomId={room.id} />
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
      const pending = players.filter((p) => !votes.some((v) => v.voter_id === p.id)).map((p) => p.name);
      return (
        <WaitingScreen
          title={`You voted for ${target?.name || "..."}`}
          subtitle={`${votes.length}/${players.length} have voted`}
          pendingLabel="Yet to vote:"
          pending={pending}
          onLeave={leaveRoom}
          action={isHost && pending.length > 0 ? (
            <button className="btn-outline" onClick={() => { sfx.tap(); advanceToReveal(); }}>
              Reveal results now →
            </button>
          ) : undefined}
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
            {isRunoff && (
              <p style={{ fontSize: "12px", fontWeight: 600, color: "var(--accent-dark)", marginTop: "4px" }}>
                ⚖️ It&apos;s a tie — vote again between the top picks
              </p>
            )}
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
          <Reactions roomId={room.id} />
        </div>
      </div>
    );
  }

  // ---- Phase: reveal (votes → result → scoreboard) ----
  if (room.status === "reveal") {
    // Everything auto-shows on one screen once voting completes — result,
    // vote tally (with who voted for whom), and scoreboard — no click-through.
    const { crewWins } = computeResult(players, votes);
    const imposters = players.filter((p) => p.is_imposter);
    const maxVotes = Math.max(1, ...players.map((p) => votes.filter((v) => v.target_id === p.id).length));
    const sorted = [...players].sort((a, b) => b.wins - a.wins);
    // End-of-round awards, derived from cumulative stats (no extra data needed).
    const gamesPlayed = players.some((p) => p.wins + p.losses > 0);
    const topWinner = gamesPlayed ? [...players].sort((a, b) => b.wins - a.wins)[0] : null;
    const topCaught = players.reduce<Player | null>((m, p) => (p.times_caught > (m?.times_caught ?? 0) ? p : m), null);
    const awards = gamesPlayed
      ? [
          topWinner && topWinner.wins > 0 ? { icon: "🥇", label: "Most wins", name: topWinner.name } : null,
          topCaught && topCaught.times_caught > 0 ? { icon: "🎯", label: "Most caught", name: topCaught.name } : null,
        ].filter(Boolean) as { icon: string; label: string; name: string }[]
      : [];
    const medals = ["🥇", "🥈", "🥉"];
    return (
      <div className="page" style={{ justifyContent: "flex-start", paddingTop: "clamp(20px, 4vh, 36px)" }}>
        {crewWins && <Confetti />}
        <LeaveButton onLeave={leaveRoom} />
        <SoundToggle />
        <div className="screen vk-phase" style={{ gap: "16px" }}>

          <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: "6px" }}>
            <div className="vk-pop" style={{ fontSize: "56px" }}>{crewWins ? "🎉" : "😈"}</div>
            <h2 className="vk-pop" style={{ fontSize: "26px", fontWeight: "800", color: crewWins ? "var(--accent-light)" : "var(--danger)", animationDelay: "0.08s" }}>
              {crewWins ? "Crew Wins!" : "Imposter Wins!"}
            </h2>
            <p style={{ fontSize: "14px", color: "var(--t2)" }}>
              {imposters.length > 1 ? "The imposters were " : "The imposter was "}
              <strong style={{ color: "var(--t1)" }}>{imposters.map((p) => p.name).join(", ")}</strong>
            </p>
            {room.word && (
              <p style={{ fontSize: "13px", color: "var(--t3)" }}>The word was <strong style={{ color: "var(--t1)" }}>{room.word}</strong></p>
            )}
          </div>

          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div className="label" style={{ margin: 0 }}>Votes</div>
            {players.map((p) => {
              const targeters = votes.filter((v) => v.target_id === p.id);
              const voters = targeters.map((v) => players.find((x) => x.id === v.voter_id)?.name).filter(Boolean);
              return (
                <div key={p.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", color: "var(--t1)", marginBottom: "5px" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span className="avatar" style={{ width: "22px", height: "22px", fontSize: "10px", background: avatarColor(p.name) }}>{p.name[0].toUpperCase()}</span>
                      {p.name}{p.is_imposter ? " 🎭" : ""}
                    </span>
                    <span style={{ color: "var(--t2)", fontWeight: "600" }}>{targeters.length}</span>
                  </div>
                  <div style={{ height: "9px", background: "var(--bg3)", borderRadius: "5px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(targeters.length / maxVotes) * 100}%`, background: "linear-gradient(90deg, var(--accent-light), var(--accent))", borderRadius: "5px", animation: "vk-bar 0.6s ease both" }} />
                  </div>
                  {voters.length > 0 && (
                    <div style={{ fontSize: "11px", color: "var(--t3)", marginTop: "3px" }}>← {voters.join(", ")}</div>
                  )}
                </div>
              );
            })}
          </div>

          {awards.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center" }}>
              {awards.map((a) => (
                <div key={a.label} style={{ display: "flex", alignItems: "center", gap: "7px", padding: "6px 12px", borderRadius: "999px", background: "var(--bg2)", border: "1px solid var(--border2)" }}>
                  <span style={{ fontSize: "16px" }}>{a.icon}</span>
                  <span style={{ fontSize: "12px", color: "var(--t3)" }}>{a.label}</span>
                  <span style={{ fontSize: "13px", fontWeight: "700", color: "var(--t1)" }}>{a.name}</span>
                </div>
              ))}
            </div>
          )}

          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0" }}>
            <div style={{ display: "flex", fontSize: "10px", color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.06em", padding: "0 0 8px", borderBottom: "0.5px solid var(--border)" }}>
              <span style={{ flex: 1 }}>🏆 Scoreboard</span>
              <span style={{ width: "40px", textAlign: "center" }}>W</span>
              <span style={{ width: "40px", textAlign: "center" }}>L</span>
              <span style={{ width: "56px", textAlign: "center" }}>Caught</span>
            </div>
            {sorted.map((p, i) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: "9px", fontSize: "14px", color: "var(--t1)", padding: "10px 0", borderBottom: i < sorted.length - 1 ? "0.5px solid var(--border)" : "none" }}>
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
          <Reactions roomId={room.id} />
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

function WaitingScreen({ title, subtitle, pending, pendingLabel, onLeave, action }: {
  title: string; subtitle: string; pending?: string[]; pendingLabel?: string; onLeave?: () => void; action?: ReactNode;
}) {
  return (
    <div className="page">
      {onLeave && <LeaveButton onLeave={onLeave} />}
      <div className="screen vk-fade-up" style={{ textAlign: "center", gap: "12px", alignItems: "center" }}>
        <div className="vk-float" style={{ fontSize: "36px" }}>⏳</div>
        <h2 style={{ fontSize: "18px", fontWeight: "700", color: "var(--t1)" }}>{title}</h2>
        <p style={{ fontSize: "13px", color: "var(--t3)" }}>{subtitle}</p>
        {pending && pending.length > 0 && (
          <div style={{ maxWidth: "320px" }}>
            {pendingLabel && <p style={{ fontSize: "11px", color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>{pendingLabel}</p>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center" }}>
              {pending.map((name) => (
                <span key={name} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "4px 12px 4px 4px", borderRadius: "999px", background: "var(--bg2)", border: "1px solid var(--border2)", fontSize: "12px", color: "var(--t1)" }}>
                  <span className="avatar" style={{ width: "20px", height: "20px", fontSize: "10px", background: avatarColor(name) }}>{name[0].toUpperCase()}</span>
                  {name}
                </span>
              ))}
            </div>
          </div>
        )}
        {action && <div style={{ marginTop: "8px", width: "100%", maxWidth: "320px" }}>{action}</div>}
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
  isImposter, hintsEnabled, showCategory, categoryName, showWordLength, showFirstLetter, word, wordRow, teammates, revealed, onReveal, onDone, prompt,
}: {
  isImposter: boolean;
  hintsEnabled: boolean;
  showCategory: boolean;
  categoryName: string | null;
  showWordLength: boolean;
  showFirstLetter: boolean;
  word: string | null;
  wordRow: WordRow | null;
  teammates: string[];
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
                {teammates.length > 0 && (
                  <div style={{ marginTop: "6px", paddingTop: "12px", borderTop: "0.5px solid #5A1A1A", display: "flex", flexDirection: "column", gap: "2px" }}>
                    <p style={{ fontSize: "11px", color: "#C99", textTransform: "uppercase", letterSpacing: "0.08em" }}>🤝 {teammates.length > 1 ? "Your fellow imposters" : "Your fellow imposter"}</p>
                    <p style={{ fontSize: "18px", fontWeight: "700", color: "#FFB3B3" }}>{teammates.join(", ")}</p>
                  </div>
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
  me, hintsEnabled, showCategory, categoryName, showWordLength, showFirstLetter, word, wordRow, teammates, revealed, onReveal, onDone,
}: {
  me: Player;
  hintsEnabled: boolean;
  showCategory: boolean;
  categoryName: string | null;
  showWordLength: boolean;
  showFirstLetter: boolean;
  word: string | null;
  wordRow: WordRow | null;
  teammates: string[];
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
      teammates={teammates}
      revealed={revealed}
      onReveal={onReveal}
      onDone={onDone}
      prompt="Take a look, then hide it before you show your neighbor."
    />
  );
}

function PassRevealScreen({
  player, hintsEnabled, showCategory, categoryName, showWordLength, showFirstLetter, word, wordRow, teammates, revealed, onReveal, onDone,
}: {
  player: Player;
  hintsEnabled: boolean;
  showCategory: boolean;
  categoryName: string | null;
  showWordLength: boolean;
  showFirstLetter: boolean;
  word: string | null;
  wordRow: WordRow | null;
  teammates: string[];
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
      teammates={teammates}
      revealed={revealed}
      onReveal={onReveal}
      onDone={onDone}
      prompt={`${player.name}, don't let anyone else see`}
    />
  );
}
