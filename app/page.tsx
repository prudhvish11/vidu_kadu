"use client";
import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { generateId } from "@/lib/id";

function generateCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function Home() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const prefillCode = searchParams.get("join") || "";
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState(prefillCode);
  const [mode, setMode] = useState<"home" | "create" | "join">(prefillCode ? "join" : "home");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function createRoom() {
    if (!name.trim()) { setError("Enter your name"); return; }
    setLoading(true);
    setError("");
    try {
      const playerId = generateId();
      let code = generateCode();
      let exists = true;
      while (exists) {
        const { data } = await supabase.from("rooms").select("id").eq("code", code).single();
        if (!data) exists = false;
        else code = generateCode();
      }
      const { data: room, error: roomErr } = await supabase
        .from("rooms").insert({ code, host_id: playerId }).select().single();
      if (roomErr) throw roomErr;
      const { error: playerErr } = await supabase
        .from("players").insert({ id: playerId, room_id: room.id, name: name.trim(), is_host: true });
      if (playerErr) throw playerErr;
      localStorage.setItem("vk_player_id", playerId);
      localStorage.setItem("vk_player_name", name.trim());
      router.push(`/room?code=${room.code}`);
    } catch (e: unknown) {
      setError("Something went wrong. Try again.");
      console.error(e);
    }
    setLoading(false);
  }

  async function joinRoom() {
    if (!name.trim()) { setError("Enter your name"); return; }
    if (!joinCode.trim()) { setError("Enter room code"); return; }
    setLoading(true);
    setError("");
    try {
      const { data: room, error: roomErr } = await supabase
        .from("rooms").select().eq("code", joinCode.trim().toUpperCase()).single();
      if (roomErr || !room) { setError("Room not found. Check the code."); setLoading(false); return; }
      if (room.status !== "lobby") { setError("Game already started."); setLoading(false); return; }

      // check if player already in room (rejoining)
      const existingId = localStorage.getItem("vk_player_id");
      if (existingId) {
        const { data: existing } = await supabase
          .from("players").select().eq("id", existingId).eq("room_id", room.id).single();
        if (existing) {
          router.push(`/room?code=${room.code}`);
          setLoading(false);
          return;
        }
      }

      const playerId = generateId();
      const { error: playerErr } = await supabase
        .from("players").insert({ id: playerId, room_id: room.id, name: name.trim(), is_host: false });
      if (playerErr) throw playerErr;
      localStorage.setItem("vk_player_id", playerId);
      localStorage.setItem("vk_player_name", name.trim());
      router.push(`/room?code=${room.code}`);
    } catch (e: unknown) {
      setError("Something went wrong. Try again.");
      console.error(e);
    }
    setLoading(false);
  }

  return (
    <div className="page">
      <div className="screen vk-fade-up">
        <div style={{ textAlign: "center", marginBottom: "8px" }}>
          <div className="vk-float" style={{ fontSize: "52px", marginBottom: "8px" }}>🕵️</div>
          <h1 style={{ fontSize: "34px", fontWeight: "800", letterSpacing: "-0.02em", background: "linear-gradient(135deg, var(--t1), var(--accent-light))", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>
            Vidu Kadhu
          </h1>
          <p style={{ fontSize: "13px", color: "var(--t3)", marginTop: "4px" }}>It&apos;s not him.</p>
        </div>

        {mode === "home" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "16px" }}>
            <button className="btn-primary" onClick={() => setMode("create")}>Create Room</button>
            <button className="btn-outline" onClick={() => setMode("join")}>Join Room</button>
          </div>
        )}

        {mode === "create" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div>
              <div className="label">Your name</div>
              <input className="input" placeholder="Enter your name" value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && createRoom()}
                maxLength={20} autoFocus />
            </div>
            {error && <p style={{ fontSize: "13px", color: "var(--danger)" }}>{error}</p>}
            <button className="btn-primary" onClick={createRoom} disabled={loading}>
              {loading ? "Creating..." : "Create Room"}
            </button>
            <button className="btn-outline" onClick={() => { setMode("home"); setError(""); }}>Back</button>
          </div>
        )}

        {mode === "join" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div>
              <div className="label">Your name</div>
              <input className="input" placeholder="Enter your name" value={name}
                onChange={e => setName(e.target.value)} maxLength={20} autoFocus />
            </div>
            <div>
              <div className="label">Room code</div>
              <input className="input" placeholder="Enter 4-letter code" value={joinCode}
                onChange={e => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === "Enter" && joinRoom()}
                maxLength={4} style={{ letterSpacing: "0.15em", fontWeight: "500" }} />
            </div>
            {error && <p style={{ fontSize: "13px", color: "var(--danger)" }}>{error}</p>}
            <button className="btn-primary" onClick={joinRoom} disabled={loading}>
              {loading ? "Joining..." : "Join Room"}
            </button>
            <button className="btn-outline" onClick={() => { setMode("home"); setError(""); }}>Back</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Home />
    </Suspense>
  );
}