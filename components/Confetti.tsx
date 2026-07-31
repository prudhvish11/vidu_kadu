"use client";
import { useMemo, type CSSProperties } from "react";

const COLORS = ["#FF7A00", "#12B886", "#FF3D77", "#FFC24B", "#7C5CFF", "#FF9A3D"];

// Lightweight CSS confetti burst — spawns once, falls, and drifts off-screen.
export default function Confetti({ count = 70 }: { count?: number }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: count }).map((_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.7,
        dur: 2.6 + Math.random() * 1.8,
        color: COLORS[i % COLORS.length],
        size: 9 + Math.random() * 9,
        rot: Math.random() * 360,
        round: Math.random() > 0.5,
        drift: (Math.random() - 0.5) * 80,
      })),
    [count],
  );
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 3 }}>
      {pieces.map((p, i) => (
        <span
          key={i}
          style={{
            position: "absolute", top: "-8%", left: `${p.left}%`,
            width: `${p.size}px`, height: `${p.size * (p.round ? 1 : 1.5)}px`,
            background: p.color, borderRadius: p.round ? "50%" : "2px",
            "--drift": `${p.drift}px`,
            animation: `vk-confetti ${p.dur}s ${p.delay}s cubic-bezier(0.3,0.4,0.7,1) forwards`,
            transform: `rotate(${p.rot}deg)`,
          } as CSSProperties}
        />
      ))}
    </div>
  );
}
