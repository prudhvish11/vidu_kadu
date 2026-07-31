import type { CSSProperties } from "react";

// Peeking-eyes mark. Pupils glance side to side (the `.vk-peek-pupil` animation
// lives in globals.css) — a playful "spot the imposter" logo.
export default function Logo({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 96 96" width="96" height="96"
      xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Vidu Kadhu logo">
      <defs>
        <linearGradient id="vkLogoGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFB05A" />
          <stop offset="1" stopColor="#FF6A00" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="24" fill="url(#vkLogoGrad)" />
      <circle cx="38" cy="40" r="10" fill="#FFF6EC" />
      <circle cx="58" cy="40" r="10" fill="#FFF6EC" />
      <circle className="vk-peek-pupil" cx="40" cy="42" r="4.5" fill="#3A2A1A" />
      <circle className="vk-peek-pupil" cx="60" cy="42" r="4.5" fill="#3A2A1A" />
      <rect x="14" y="55" width="68" height="27" rx="9" fill="#FF3D77" />
    </svg>
  );
}
