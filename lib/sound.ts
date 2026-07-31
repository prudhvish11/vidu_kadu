// Lightweight sound + haptics. Sounds are synthesized with the Web Audio API
// (no asset files, so nothing extra to bundle/host). Everything is a no-op on
// the server and respects a persisted mute preference. The AudioContext is
// created lazily on first use — which happens inside a user gesture — so
// browsers won't block it.

let ctx: AudioContext | null = null;
let muted = false;

if (typeof window !== "undefined") {
  muted = localStorage.getItem("vk_muted") === "1";
}

function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function isMuted() { return muted; }
export function setMuted(m: boolean) {
  muted = m;
  if (typeof window !== "undefined") localStorage.setItem("vk_muted", m ? "1" : "0");
}
export function toggleMuted() { setMuted(!muted); return muted; }

function tone(freq: number, dur: number, type: OscillatorType = "sine", gain = 0.06, delay = 0) {
  const c = ac();
  if (!c || muted) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t = c.currentTime + delay;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

function buzz(pattern: number | number[]) {
  if (!muted && typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(pattern);
}

export const sfx = {
  tap() { tone(430, 0.07, "triangle", 0.045); buzz(8); },
  reveal() { tone(300, 0.12, "sine", 0.06); tone(520, 0.2, "sine", 0.05, 0.09); buzz(18); },
  vote() { tone(620, 0.07, "square", 0.035); buzz(12); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.26, "triangle", 0.06, i * 0.12)); buzz([20, 40, 20, 40]); },
  lose() { [420, 330, 250].forEach((f, i) => tone(f, 0.3, "sawtooth", 0.05, i * 0.13)); buzz(40); },
};
