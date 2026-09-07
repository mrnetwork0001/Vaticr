// The cut: one entry per narrated beat.
//
// Durations are derived, never guessed - a beat lasts as long as its narration
// plus a tail, and a footage beat never ends before the footage it needs. The
// numbers come from public/manifest.json, which ffprobes the real files.
import manifest from "../public/manifest.json";

export const FPS = 30;
export const W = 1920;
export const H = 1080;
export const TRANSITION_S = 0.5;

type Kind = "intro" | "gap" | "mint" | "evidence" | "footage" | "close";
export interface Beat {
  id: string;
  kind: Kind;
  narration: keyof typeof manifest.narration;
  seconds: number;
  /** footage beats: which clip, where to start, how long to play (seconds) */
  clip?: string;
  from?: number;
  play?: number;
  caption?: string;
}

const N = manifest.narration;
const F = manifest.footage as Record<string, { file: string; seconds: number; events: { t: number; kind: string; note?: string }[] }>;

const has = (c: string) => Boolean(F[c]);
const secs = (c: string) => (has(c) ? F[c].seconds : 0);

// The hand-recorded wallet flow. Until it lands, that beat borrows the
// dashboard footage so the film still renders end to end.
const TRADE = has("trade") ? "trade" : "audit";
const tradeFrom = TRADE === "trade" ? 0 : 0;
const tradePlay = TRADE === "trade" ? secs("trade") : Math.min(16, secs("audit"));

// The landing clip is used twice: the hero states the question, the lower
// sections show how it is answered. Two windows, one file.
// The capture holds five seconds on the hero, then steps down the page. The
// claim beat takes the hero; the "how" beat takes the sections that answer it.
const landingA = { from: 2.0, play: 11.0 };                // hero (held to 8.8s), then into "how it works"
const landingB = { from: 12.0, play: Math.max(1, secs("landing") - 12.5) };

// The dashboard clip splits the same way: live windows first, the audit second.
// The capture holds on markets, clicks through to the audit at about 7s, then
// to calibration at about 17s. Each beat takes the window it names.
const auditMarkets = { from: 3.6, play: 10.4 };            // live windows, up to the first click
const auditProof = { from: 13.5, play: 13.0 };             // audit clicked at 14.4s, table rendered by 17.9s

const tail = 0.9;

export const BEATS: Beat[] = [
  { id: "intro", kind: "intro", narration: "intro", seconds: Math.max(N.intro.seconds + 1.5, 5) },

  { id: "claim", kind: "footage", narration: "claim", clip: "landing", ...landingA,
    seconds: Math.max(N.claim.seconds + tail, landingA.play),
    caption: "usevaticr.xyz · live on Somnia Shannon testnet" },

  { id: "gap", kind: "gap", narration: "gap", seconds: N.gap.seconds + tail },

  { id: "how", kind: "footage", narration: "how", clip: "landing", ...landingB,
    seconds: Math.max(N.how.seconds + tail, landingB.play),
    caption: "Prior from the price process · posterior from scored news" },

  { id: "trade", kind: "footage", narration: "trade", clip: TRADE, from: tradeFrom, play: tradePlay,
    seconds: Math.max(N.trade.seconds + tail, Math.min(tradePlay, 26)),
    caption: "A real wallet, a real order book, a real fill" },

  { id: "mint", kind: "mint", narration: "mint", seconds: N.mint.seconds + tail },

  { id: "bot", kind: "footage", narration: "bot", clip: "audit", ...auditMarkets,
    seconds: Math.max(N.bot.seconds + tail, Math.min(auditMarkets.play, 14)),
    caption: "Every live window, priced against the top of its book" },

  { id: "evidence", kind: "evidence", narration: "evidence", seconds: N.evidence.seconds + tail },

  { id: "proof", kind: "footage", narration: "proof", clip: "audit", ...auditProof,
    seconds: Math.max(N.proof.seconds + tail, Math.min(auditProof.play, 18)),
    caption: "Every settlement recomputed from the oracle feed · 10 of 10 verified" },

  { id: "close", kind: "close", narration: "close", seconds: N.close.seconds + 2.6 },
];

export const totalFrames = () =>
  Math.round((BEATS.reduce((s, b) => s + b.seconds, 0) - TRANSITION_S * (BEATS.length - 1)) * FPS);
export const beatStartFrame = (i: number) =>
  Math.round((BEATS.slice(0, i).reduce((s, b) => s + b.seconds, 0) - TRANSITION_S * i) * FPS);

export { manifest };
