// The film's central image: one probability axis, two opinions, and the
// distance between them.
//
// Every figure is from the ticket in the footage two beats later - the model
// at 0.465, the book's best offer at 0.351, on an ETH 300-second window. The
// graphic and the screen recording quote the same trade on purpose: a viewer
// who checks one against the other should find them agreeing.
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { INK, MARKET, MARKET_DIM, MODEL, MODEL_DIM, MONO, SANS, TEXT } from "../theme";
import { Eyebrow, Grid } from "../ui";

const X0 = 300;
const X1 = 1620;
const Y = 372;
// The axis is zoomed to where both numbers sit. A full 0-1 scale renders a
// one-cent edge as ten pixels, which hides the only thing this frame is for.
const LO = 0.28;
const HI = 0.58;
const x = (p: number) => X0 + ((p - LO) / (HI - LO)) * (X1 - X0);

const MODEL_P = 0.465;
const BOOK_P = 0.351;

export const Gap: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = (s: number) => Math.round(fps * s);

  const axis = interpolate(frame, [at(0.2), at(1.1)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const bookIn = interpolate(frame, [at(1.2), at(1.8)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const modelIn = interpolate(frame, [at(2.2), at(2.8)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const gapIn = interpolate(frame, [at(3.4), at(4.2)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const out = interpolate(frame, [frames - 12, frames], [1, 0], { extrapolateLeft: "clamp" });

  const tick = (p: number, label: string) => (
    <g key={label}>
      <line x1={x(p)} y1={Y} x2={x(p)} y2={Y + 14} stroke={INK[700]} strokeWidth={2} />
      <text x={x(p)} y={Y + 46} textAnchor="middle" fontFamily={MONO} fontSize={22} fill={TEXT.lo}>{label}</text>
    </g>
  );

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Grid />
      <AbsoluteFill style={{ padding: "90px 120px" }}>
        <Eyebrow>Two voices, one number</Eyebrow>
        <div
          style={{
            fontFamily: SANS, fontWeight: 800, fontSize: 62, lineHeight: 1.06,
            letterSpacing: "-0.025em", color: TEXT.hi, marginTop: 18, maxWidth: 1400,
          }}
        >
          <span style={{ color: MODEL }}>What the model says</span> against{" "}
          <span style={{ color: MARKET }}>what the book asks</span>.
        </div>

        <svg width={1920} height={640} viewBox="0 0 1920 640" style={{ marginTop: 30, marginLeft: -120 }}>
          {/* the gap, shaded between the two marks */}
          <rect
            x={x(BOOK_P)} y={Y - 66} width={(x(MODEL_P) - x(BOOK_P)) * gapIn} height={132}
            fill="rgba(129,140,248,0.16)"
          />
          {gapIn > 0.6 ? (
            <text
              x={(x(BOOK_P) + x(MODEL_P)) / 2} y={Y - 92} textAnchor="middle"
              fontFamily={MONO} fontSize={26} fill={MODEL} opacity={(gapIn - 0.6) / 0.4}
            >
              +0.114 / share
            </text>
          ) : null}

          {/* axis */}
          <line x1={X0} y1={Y} x2={X0 + (X1 - X0) * axis} y2={Y} stroke={INK[700]} strokeWidth={3} />
          {axis > 0.98 ? [0.30, 0.35, 0.40, 0.45, 0.50, 0.55].map((p) => tick(p, p.toFixed(2))) : null}

          {/* the book */}
          <g opacity={bookIn}>
            <line x1={x(BOOK_P)} y1={Y - 64} x2={x(BOOK_P)} y2={Y} stroke={MARKET} strokeWidth={5} />
            <circle cx={x(BOOK_P)} cy={Y} r={11} fill={MARKET} />
            <text x={x(BOOK_P) - 22} y={Y - 84} textAnchor="end" fontFamily={MONO} fontSize={34} fontWeight={700} fill={MARKET}>
              BOOK 0.351
            </text>
            <text x={x(BOOK_P) - 22} y={Y - 122} textAnchor="end" fontFamily={MONO} fontSize={22} fill={MARKET_DIM}>
              best offer on YES
            </text>
          </g>

          {/* the model */}
          <g opacity={modelIn}>
            <line x1={x(MODEL_P)} y1={Y} x2={x(MODEL_P)} y2={Y + 96} stroke={MODEL} strokeWidth={5} />
            <circle cx={x(MODEL_P)} cy={Y} r={11} fill={MODEL} />
            <text x={x(MODEL_P) + 24} y={Y + 108} fontFamily={MONO} fontSize={34} fontWeight={700} fill={MODEL}>
              VATICR 0.465
            </text>
            <text x={x(MODEL_P) + 24} y={Y + 146} fontFamily={MONO} fontSize={22} fill={MODEL_DIM}>
              posterior on YES
            </text>
          </g>
          <text x={X1} y={Y + 92} textAnchor="end" fontFamily={MONO} fontSize={20} fill={TEXT.lo}>
            axis 0.28 - 0.58
          </text>
        </svg>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
