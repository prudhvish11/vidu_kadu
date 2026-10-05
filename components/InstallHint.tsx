"use client";
import { useEffect, useState } from "react";
import { sfx } from "@/lib/sound";

type InstallPromptEvent = Event & {
  prompt: () => void;
  userChoice: Promise<{ outcome: string }>;
};

// A dismissible "add to home screen" nudge. On Chrome/Android it captures the
// native install prompt and offers an Install button; on iOS Safari (which has
// no such event) it shows the manual Share → Add to Home Screen tip. Hidden if
// the app is already installed (standalone) or the user dismissed it before.
export default function InstallHint() {
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (localStorage.getItem("vk_install_dismissed")) return;
    const nav = navigator as Navigator & { standalone?: boolean };
    const standalone = window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
    if (standalone) return;

    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    const isSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);

    const onPrompt = (e: Event) => { e.preventDefault(); setDeferred(e as InstallPromptEvent); setShow(true); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    if (isIOS && isSafari) { setIosHint(true); setShow(true); }

    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (!show) return null;

  function dismiss() { localStorage.setItem("vk_install_dismissed", "1"); setShow(false); }
  async function install() {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* ignore */ }
    setDeferred(null);
    dismiss();
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "14px", padding: "10px 12px", borderRadius: "14px", background: "var(--bg2)", border: "1px solid var(--border)" }}>
      <span style={{ fontSize: "20px" }}>📲</span>
      <div style={{ flex: 1, fontSize: "12px", color: "var(--t2)", lineHeight: 1.4 }}>
        {iosHint ? (
          <>Add to your Home Screen — tap <strong style={{ color: "var(--t1)" }}>Share</strong>, then <strong style={{ color: "var(--t1)" }}>Add to Home Screen</strong>.</>
        ) : (
          <>Install Vidu Kadhu for one-tap access.</>
        )}
      </div>
      {!iosHint && deferred && (
        <button onClick={() => { sfx.tap(); install(); }}
          style={{ fontSize: "12px", fontWeight: 600, padding: "6px 12px", borderRadius: "999px", background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer", flexShrink: 0 }}>
          Install
        </button>
      )}
      <button onClick={dismiss} aria-label="Dismiss" style={{ fontSize: "15px", color: "var(--t3)", background: "none", border: "none", cursor: "pointer", lineHeight: 1, flexShrink: 0 }}>✕</button>
    </div>
  );
}
