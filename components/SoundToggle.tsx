"use client";
import { useEffect, useState } from "react";
import { isMuted, toggleMuted } from "@/lib/sound";

// Floating mute button, top-right on every screen. Reads the persisted mute
// state after mount to avoid a hydration mismatch on the static shell.
export default function SoundToggle() {
  const [muted, setMuted] = useState(false);
  useEffect(() => { setMuted(isMuted()); }, []);

  return (
    <button
      aria-label={muted ? "Unmute sounds" : "Mute sounds"}
      onClick={() => setMuted(toggleMuted())}
      style={{
        position: "fixed", top: "14px", right: "14px", zIndex: 30,
        width: "38px", height: "38px", borderRadius: "50%", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px",
        background: "linear-gradient(160deg, rgba(255,255,255,0.7), rgba(255,255,255,0.35))",
        backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
        border: "1px solid var(--glass-border)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.9)",
      }}
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );
}
