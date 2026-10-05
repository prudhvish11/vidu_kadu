"use client";
import { useState } from "react";
import { sfx } from "@/lib/sound";

const STEPS: { icon: string; title: string; body: string }[] = [
  { icon: "🤫", title: "Everyone gets a secret word", body: "…except the imposter(s). The crew all see the same word; the imposter sees only the clues the host turned on — or nothing at all." },
  { icon: "👀", title: "Peek at your card", body: "Look secretly, then hide it. Don't let anyone see your screen — or whether you smiled." },
  { icon: "🗣️", title: "Discuss in turn", body: "Going by the speaking order, each person describes the word WITHOUT saying it. The imposter has to bluff and blend in." },
  { icon: "🗳️", title: "Vote", body: "Everyone secretly votes for who they think is the imposter." },
  { icon: "🏆", title: "Who wins?", body: "The crew wins if they vote out an imposter. The imposter wins if they escape the vote (ties go to the imposter)." },
];

// Self-contained "How to Play" button + modal. Drop it anywhere; it manages its
// own open state. `variant` controls the trigger's look.
export default function HowToPlay({ variant = "link" }: { variant?: "link" | "button" }) {
  const [open, setOpen] = useState(false);

  const trigger =
    variant === "button" ? (
      <button className="btn-outline" onClick={() => { sfx.tap(); setOpen(true); }}>How to play</button>
    ) : (
      <button
        onClick={() => { sfx.tap(); setOpen(true); }}
        style={{ fontSize: "13px", fontWeight: 600, color: "var(--accent-dark)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: "3px" }}
      >
        ❔ How to play
      </button>
    );

  return (
    <>
      {trigger}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "flex-end", justifyContent: "center",
            background: "rgba(40,20,0,0.35)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="vk-fade-up"
            style={{ width: "100%", maxWidth: "460px", maxHeight: "86vh", overflowY: "auto", background: "var(--bg2)",
              borderRadius: "22px 22px 0 0", padding: "22px 20px calc(24px + env(safe-area-inset-bottom))",
              borderTop: "1px solid var(--border)", boxShadow: "0 -10px 40px -10px rgba(0,0,0,0.3)" }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
              <h2 style={{ fontSize: "20px", fontWeight: "800", color: "var(--t1)" }}>How to play</h2>
              <button onClick={() => setOpen(false)}
                style={{ fontSize: "20px", color: "var(--t3)", background: "none", border: "none", cursor: "pointer", lineHeight: 1 }}>
                ✕
              </button>
            </div>

            <p style={{ fontSize: "13px", color: "var(--t2)", marginBottom: "18px" }}>
              A party game of secret words and sneaky imposters. Find who doesn&apos;t know the word — or, if it&apos;s you, don&apos;t get caught.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              {STEPS.map((s, i) => (
                <div key={i} style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                  <div style={{ flexShrink: 0, width: "38px", height: "38px", borderRadius: "12px", display: "grid", placeItems: "center", fontSize: "20px", background: "var(--bg3)", border: "1px solid var(--border2)" }}>
                    {s.icon}
                  </div>
                  <div>
                    <div style={{ fontSize: "14px", fontWeight: "700", color: "var(--t1)", marginBottom: "2px" }}>{s.title}</div>
                    <div style={{ fontSize: "13px", color: "var(--t2)", lineHeight: 1.45 }}>{s.body}</div>
                  </div>
                </div>
              ))}
            </div>

            <button className="btn-primary" style={{ marginTop: "22px" }} onClick={() => { sfx.tap(); setOpen(false); }}>
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
