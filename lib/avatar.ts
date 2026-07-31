// Deterministic avatar background from a player's name, so the same person
// keeps the same color across everyone's screens.
const PALETTE = [
  "#6C5CE7", "#00B894", "#0984E3", "#E17055",
  "#E84393", "#FDCB6E", "#00CEC9", "#A29BFE",
  "#FF7675", "#55EFC4",
];

export function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
