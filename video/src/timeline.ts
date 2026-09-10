// The cut: one entry per narrated beat.
//
// Durations are derived, never guessed - a beat lasts as long as its narration
// plus a tail, and a footage beat never ends before the footage it needs. The
// numbers come from public/manifest.json, which ffprobes the real files.
//
// The four middle beats are one continuous hand recording of the live app,
// windowed by timestamp. Those offsets were read off the recording rather than
// estimated: every frame was OCR'd, so "the onboarding panel" is the interval
// where that panel is genuinely on screen.
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
  /** Two-part lower-left caption: kicker above, line below. */
  kicker?: string;
  caption?: string;
}

const N = manifest.narration;
const F = manifest.footage as Record<string, { file: string; seconds: number; events: { t: number; kind: string; note?: string }[] }>;
const has = (c: string) => Boolean(F[c]);
const secs = (c: string) => (has(c) ? F[c].seconds : 0);

/* ── the hand recording, mapped by OCR ────────────────────────────────────
   5.0 - 12.5   connect, wallet prompt, wrong-network banner
   13.0 - 17.5  the onboarding panel, both requirements unmet
   18.0 - 24.5  the public STT faucet
   25.5 - 32.0  gas satisfied, mint 1,000 tUSDC, sign
   32.5 - 45.5  the ticket: book 0.351, model 0.465, edge +0.114
   46.0 - 57.5  the fill, and the escrow released with it
   58.0 - 64.5  positions: one open window, 10.00 shares
   ────────────────────────────────────────────────────────────────────── */
const TRADE = has("trade") ? "trade" : "audit";
const w = (from: number, play: number) =>
  has("trade") ? { from, play } : { from: 0, play: Math.min(play, secs("audit")) };

const onboard = w(8.0, 9.5);   // starts late in the wallet popup: a glimpse, not four seconds of white
const fund = w(18.0, 14.0);
const ticket = w(32.5, 13.0);
const fill = w(46.5, 17.0);

// The landing capture holds five seconds on the hero, then steps down the page.
const landingA = { from: 2.0, play: 11.0 };
const landingB = { from: 12.0, play: Math.max(1, secs("landing") - 12.5) };
// The dashboard capture: audit clicked at 14.4s, table rendered by 17.9s.
const auditProof = { from: 13.5, play: 13.0 };

const tail = 0.9;

export const BEATS: Beat[] = [
  { id: "intro", kind: "intro", narration: "intro", seconds: Math.max(N.intro.seconds + 1.5, 5) },

  { id: "claim", kind: "footage", narration: "claim", clip: "landing", ...landingA,
    seconds: Math.max(N.claim.seconds + tail, landingA.play),
    kicker: "The front door", caption: "usevaticr.xyz · live on Somnia testnet" },

  { id: "gap", kind: "gap", narration: "gap", seconds: N.gap.seconds + tail },

  { id: "how", kind: "footage", narration: "how", clip: "landing", ...landingB,
    seconds: Math.max(N.how.seconds + tail, landingB.play),
    kicker: "Where the number comes from", caption: "Prior from the price process, posterior from scored news" },

  { id: "onboard", kind: "footage", narration: "onboard", clip: TRADE, ...onboard,
    seconds: Math.max(N.onboard.seconds + tail, onboard.play * 0.85),
    kicker: "A wallet that has never seen Somnia", caption: "The network is offered, then what is missing is named" },

  { id: "fund", kind: "footage", narration: "fund", clip: TRADE, ...fund,
    seconds: Math.max(N.fund.seconds + tail, fund.play * 0.85),
    kicker: "Gas, then collateral", caption: "A public faucet, then one click to mint test USDC" },

  { id: "trade", kind: "footage", narration: "trade", clip: TRADE, ...ticket,
    seconds: Math.max(N.trade.seconds + tail, ticket.play * 0.9),
    kicker: "The ticket", caption: "Book 0.351 · model 0.465 · +0.114 per share" },

  { id: "fill", kind: "footage", narration: "fill", clip: TRADE, ...fill,
    seconds: Math.max(N.fill.seconds + tail, fill.play * 0.87),
    kicker: "Filled", caption: "Ten shares, and the position it opened" },

  { id: "mint", kind: "mint", narration: "mint", seconds: N.mint.seconds + tail },

  { id: "evidence", kind: "evidence", narration: "evidence", seconds: N.evidence.seconds + tail },

  { id: "proof", kind: "footage", narration: "proof", clip: "audit", ...auditProof,
    seconds: Math.max(N.proof.seconds + tail, Math.min(auditProof.play, 18)),
    kicker: "It checks its own work", caption: "Every settlement recomputed from the oracle feed" },

  { id: "close", kind: "close", narration: "close", seconds: N.close.seconds + 2.6 },
];

export const totalFrames = () =>
  Math.round((BEATS.reduce((s, b) => s + b.seconds, 0) - TRANSITION_S * (BEATS.length - 1)) * FPS);
export const beatStartFrame = (i: number) =>
  Math.round((BEATS.slice(0, i).reduce((s, b) => s + b.seconds, 0) - TRANSITION_S * i) * FPS);

export { manifest };
