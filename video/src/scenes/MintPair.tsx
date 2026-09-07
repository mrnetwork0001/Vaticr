// Mint-a-pair: the crossing that needs no seller, and the two bids it makes
// into a complete quote.
//
// The rows arrive in order and the third highlights, because that is the one
// the protocol allows and nobody exploits. Then the arithmetic: p-δ and
// (1-p)-δ, summing to 1-2δ, which is where the spread actually comes from.
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { INK, MARKET, MODEL, MONO, SANS, TEXT, UP } from "../theme";
import { Eyebrow, Grid } from "../ui";

const ROWS: { pair: string; path: string; what: string; hero?: boolean }[] = [
  { pair: "Buy YES × Sell YES", path: "direct", what: "tokens ↔ collateral" },
  { pair: "Buy NO × Sell NO", path: "direct", what: "tokens ↔ collateral" },
  { pair: "Buy YES × Buy NO", path: "mint-a-pair", what: "the pool mints a fresh pair — no seller needed", hero: true },
  { pair: "Sell YES × Sell NO", path: "burn-a-pair", what: "both positions burn" },
];

export const MintPair: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = (s: number) => Math.round(fps * s);

  const quoteIn = interpolate(frame, [at(5.2), at(6.0)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const sumIn = interpolate(frame, [at(7.0), at(7.8)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const out = interpolate(frame, [frames - 12, frames], [1, 0], { extrapolateLeft: "clamp" });

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Grid />
      <AbsoluteFill style={{ padding: "84px 120px" }}>
        <Eyebrow>Mint-a-pair</Eyebrow>
        <div
          style={{
            fontFamily: SANS, fontWeight: 800, fontSize: 60, lineHeight: 1.05,
            letterSpacing: "-0.025em", color: TEXT.hi, marginTop: 16,
          }}
        >
          Two resting buys are a complete quote.
        </div>

        <div style={{ marginTop: 44, display: "flex", flexDirection: "column", gap: 1, background: INK[700], border: `1px solid ${INK[700]}`, borderRadius: 10, overflow: "hidden" }}>
          {ROWS.map((r, i) => {
            const o = interpolate(frame, [at(1.0 + i * 0.42), at(1.5 + i * 0.42)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            const dx = interpolate(frame, [at(1.0 + i * 0.42), at(1.5 + i * 0.42)], [-26, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            return (
              <div
                key={r.pair}
                style={{
                  display: "grid", gridTemplateColumns: "440px 260px 1fr", alignItems: "center", gap: 24,
                  padding: "22px 30px", background: r.hero ? "rgba(129,140,248,0.10)" : INK[900],
                  opacity: o, transform: `translateX(${dx}px)`,
                }}
              >
                <span style={{ fontFamily: MONO, fontSize: 30, fontWeight: r.hero ? 700 : 400, color: r.hero ? MODEL : TEXT.hi }}>
                  {r.pair}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 24, color: r.hero ? MODEL : TEXT.lo }}>{r.path}</span>
                <span style={{ fontFamily: SANS, fontSize: 24, color: r.hero ? TEXT.hi : TEXT.mid }}>{r.what}</span>
              </div>
            );
          })}
        </div>

        {/* the quote the highlighted row makes possible */}
        <div style={{ marginTop: 46, display: "flex", alignItems: "center", gap: 54, opacity: quoteIn }}>
          <div style={{ fontFamily: MONO, fontSize: 40, color: TEXT.hi }}>
            BUY_YES <span style={{ color: MODEL }}>@ p − δ</span>
          </div>
          <div style={{ fontFamily: MONO, fontSize: 40, color: TEXT.hi }}>
            BUY_NO <span style={{ color: MODEL }}>@ (1 − p) − δ</span>
          </div>
          <div style={{ fontFamily: MONO, fontSize: 34, color: TEXT.lo, opacity: sumIn }}>
            → sum <span style={{ color: UP, fontWeight: 700 }}>0.940</span>
            <span style={{ color: TEXT.lo }}> = 1 − 2δ</span>
          </div>
        </div>

        <div style={{ marginTop: 26, fontFamily: SANS, fontSize: 28, color: MARKET, opacity: sumIn }}>
          No inventory. No counterparty maker.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
