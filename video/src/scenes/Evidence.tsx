// The reliability diagram draws itself against perfect calibration, then the
// headline numbers count up.
//
// The ten buckets are the published ones from docs/evidence/backtest-2026-09-04.json,
// unrounded. A forecast of 0.75 being right about three times in four is the
// whole claim, and the diagonal is what makes it checkable at a glance.
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { INK, MODEL, MONO, SANS, TEXT, UP } from "../theme";
import { Count, Eyebrow, Grid } from "../ui";

/** [mean forecast, observed up rate] per bucket, from the frozen backtest. */
const BUCKETS: [number, number][] = [
  [0.0466, 0.051], [0.1454, 0.0972], [0.2477, 0.1765], [0.3499, 0.2805], [0.4479, 0.4059],
  [0.5515, 0.4848], [0.6513, 0.6228], [0.7493, 0.7308], [0.8485, 0.8696], [0.9657, 0.9832],
];

const PX = 120, PY = 90, W = 720, H = 720;      // plot box inside the svg
const px = (v: number) => PX + v * W;
const py = (v: number) => PY + H - v * H;

export const Evidence: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = (s: number) => Math.round(fps * s);

  const diag = interpolate(frame, [at(0.3), at(1.1)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const draw = interpolate(frame, [at(1.2), at(3.4)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const out = interpolate(frame, [frames - 12, frames], [1, 0], { extrapolateLeft: "clamp" });

  const shown = Math.floor(draw * BUCKETS.length);
  const pts = BUCKETS.slice(0, Math.max(2, shown)).map(([f, o]) => `${px(f)},${py(o)}`).join(" ");

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Grid />
      <AbsoluteFill style={{ padding: "70px 110px", flexDirection: "row", gap: 70, alignItems: "center" }}>
        <svg width={960} height={900} viewBox="0 0 960 900">
          <rect x={PX} y={PY} width={W} height={H} fill="none" stroke={INK[700]} strokeWidth={2} />
          {[0.25, 0.5, 0.75].map((g) => (
            <g key={g}>
              <line x1={PX} y1={py(g)} x2={PX + W} y2={py(g)} stroke="#151f30" strokeWidth={1} />
              <line x1={px(g)} y1={PY} x2={px(g)} y2={PY + H} stroke="#151f30" strokeWidth={1} />
            </g>
          ))}

          {/* perfect calibration */}
          <line
            x1={px(0)} y1={py(0)} x2={px(diag)} y2={py(diag)}
            stroke={TEXT.lo} strokeWidth={2.5} strokeDasharray="9 9"
          />
          <text x={px(0.78)} y={py(0.86)} fontFamily={MONO} fontSize={22} fill={TEXT.lo}>perfect</text>

          {/* what the model actually did */}
          {shown >= 2 ? <polyline points={pts} fill="none" stroke={MODEL} strokeWidth={4.5} /> : null}
          {BUCKETS.slice(0, shown).map(([f, o]) => (
            <circle key={f} cx={px(f)} cy={py(o)} r={8} fill={MODEL} />
          ))}

          {[0, 0.5, 1].map((v) => (
            <g key={v}>
              <text x={px(v)} y={PY + H + 40} textAnchor="middle" fontFamily={MONO} fontSize={22} fill={TEXT.lo}>{v.toFixed(1)}</text>
              <text x={PX - 22} y={py(v) + 8} textAnchor="end" fontFamily={MONO} fontSize={22} fill={TEXT.lo}>{v.toFixed(1)}</text>
            </g>
          ))}
          <text x={PX + W / 2} y={PY + H + 78} textAnchor="middle" fontFamily={MONO} fontSize={24} fill={TEXT.mid}>mean forecast</text>
          <text x={38} y={PY + H / 2} textAnchor="middle" fontFamily={MONO} fontSize={24} fill={TEXT.mid} transform={`rotate(-90 38 ${PY + H / 2})`}>observed up rate</text>
        </svg>

        <div style={{ flex: 1 }}>
          <Eyebrow>Does it work</Eyebrow>
          <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 58, lineHeight: 1.05, letterSpacing: "-0.025em", color: TEXT.hi, marginTop: 16 }}>
            900 forecasts,<br />scored against<br />a coin flip.
          </div>

          <div style={{ marginTop: 52, display: "flex", flexDirection: "column", gap: 34 }}>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 20, letterSpacing: "0.2em", color: TEXT.lo, textTransform: "uppercase" }}>Brier score</div>
              <Count to={0.15522} decimals={5} delay={at(4.2)} color={MODEL} size={78} />
              <span style={{ fontFamily: MONO, fontSize: 26, color: TEXT.lo, marginLeft: 18 }}>vs 0.25</span>
            </div>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 20, letterSpacing: "0.2em", color: TEXT.lo, textTransform: "uppercase" }}>Skill</div>
              <Count to={0.3791} decimals={4} prefix="+" delay={at(5.0)} color={UP} size={78} />
            </div>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 20, letterSpacing: "0.2em", color: TEXT.lo, textTransform: "uppercase" }}>Accuracy</div>
              <Count to={76.22} decimals={2} suffix="%" delay={at(5.8)} size={78} />
            </div>
          </div>

          <div style={{ marginTop: 40, fontFamily: MONO, fontSize: 22, color: TEXT.lo, lineHeight: 1.6 }}>
            lookahead-free · 120/120 truncation checks<br />frozen in the repository
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
