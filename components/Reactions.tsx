"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { sfx } from "@/lib/sound";

const EMOJIS = ["😂", "👀", "🤔", "😱", "🔥", "👏"];
type FloatItem = { id: string; emoji: string; left: number };

// Lightweight, ephemeral reactions over a Supabase Realtime *broadcast* channel
// (no DB rows). Tapping an emoji broadcasts it; every connected client — sender
// included (self:true) — floats it up the screen for ~2.6s. One instance is
// mounted at a time (phases are exclusive), so a single channel is live.
export default function Reactions({ roomId }: { roomId: string | null }) {
  const [items, setItems] = useState<FloatItem[]>([]);
  const chanRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const spawn = useCallback((emoji: string) => {
    const id = Math.random().toString(36).slice(2);
    const left = 8 + Math.random() * 84; // percent across the viewport
    setItems((prev) => [...prev.slice(-24), { id, emoji, left }]);
    setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== id)), 2600);
  }, []);

  useEffect(() => {
    if (!roomId) return;
    const ch = supabase.channel(`reactions-${roomId}`, { config: { broadcast: { self: true } } });
    ch.on("broadcast", { event: "reaction" }, (msg) => {
      const emoji = (msg as { payload?: { emoji?: string } })?.payload?.emoji;
      if (typeof emoji === "string") spawn(emoji);
    });
    ch.subscribe();
    chanRef.current = ch;
    return () => { supabase.removeChannel(ch); chanRef.current = null; };
  }, [roomId, spawn]);

  function send(emoji: string) {
    sfx.tap();
    chanRef.current?.send({ type: "broadcast", event: "reaction", payload: { emoji } });
  }

  return (
    <>
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 40, overflow: "hidden" }}>
        {items.map((i) => (
          <span key={i.id} className="vk-reaction" style={{ left: `${i.left}%` }}>{i.emoji}</span>
        ))}
      </div>
      <div style={{ display: "flex", gap: "6px", justifyContent: "center", flexWrap: "wrap" }}>
        {EMOJIS.map((e) => (
          <button key={e} onClick={() => send(e)} aria-label={`React ${e}`}
            style={{ fontSize: "20px", lineHeight: 1, padding: "7px 11px", borderRadius: "999px", background: "var(--bg2)", border: "1px solid var(--border2)", cursor: "pointer" }}>
            {e}
          </button>
        ))}
      </div>
    </>
  );
}
