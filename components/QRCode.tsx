"use client";
import { useMemo } from "react";
import qrcode from "qrcode-generator";

// A self-contained QR code rendered as a crisp SVG path (dark modules on a
// white quiet-zone), sized to `size`. Encodes any string — here, the room's
// join link so friends can scan instead of typing the code.
export default function QRCode({ value, size = 168 }: { value: string; size?: number }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, "M"); // auto version, medium error correction
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      }
    }
    return { path: d, count: n };
  }, [value]);

  const pad = 12;
  return (
    <div style={{ background: "#fff", padding: pad, borderRadius: 16, boxShadow: "0 4px 14px -6px rgba(0,0,0,0.25)", lineHeight: 0 }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${count} ${count}`}
        shapeRendering="crispEdges"
        style={{ display: "block" }}
        role="img"
        aria-label="QR code to join the room"
      >
        <path d={path} fill="#1a1205" />
      </svg>
    </div>
  );
}
