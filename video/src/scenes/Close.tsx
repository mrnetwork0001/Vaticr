import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { INK, MARKET, MODEL, MONO, SANS, TEXT } from "../theme";
import { Eyebrow, Grid, Mark, Sfx } from "../ui";

/** Four numbers this project can defend, not four it would like to have. */
const STATS = [
  { value: 900, label: "forecasts scored" },
  { value: 318, label: "seconds early", suffix: "" },
  { value: 114, label: "tests passing" },
  { value: 8, label: "SDK findings" },
];

export const Close: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tileAt = (i: number) => Math.round(fps * (0.35 + i * 0.4));
  const brand = spring({ frame: frame - fps * 2.3, fps, config: { damping: 14, stiffness: 120 } });
  const links = interpolate(frame, [fps * 3.2, fps * 3.9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill>
      <Grid />
      <AbsoluteFill style={{ padding: "96px 130px" }}>
        <Eyebrow>Measured, not asserted</Eyebrow>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24, marginTop: 34 }}>
          {STATS.map((s, i) => {
            const p = spring({ frame: frame - tileAt(i), fps, config: { damping: 18, stiffness: 90 } });
            return (
              <div
                key={s.label}
                style={{
                  opacity: p, transform: `translateY(${(1 - p) * 30}px)`,
                  background: INK[900], border: `1px solid ${INK[700]}`, borderRadius: 16, padding: "32px 28px",
                }}
              >
                <div style={{ fontFamily: MONO, fontSize: 80, fontWeight: 700, color: TEXT.hi, fontVariantNumeric: "tabular-nums" }}>
                  {Math.round(s.value * Math.min(1, p))}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 19, letterSpacing: "0.2em", textTransform: "uppercase", color: MODEL, marginTop: 8 }}>
                  {s.label}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 38, marginTop: 84, opacity: brand, transform: `translateY(${(1 - brand) * 20}px)` }}>
          <Mark size={130} delay={Math.round(fps * 2.1)} />
          <div>
            <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 92, color: TEXT.hi, letterSpacing: "0.12em" }}>VATICR</div>
            <div style={{ fontFamily: MONO, fontSize: 24, letterSpacing: "0.26em", color: MARKET, marginTop: 4 }}>
              PRICE THE WINDOW · TRADE THE GAP · PROVE THE RECORD
            </div>
          </div>
        </div>

        <div style={{ marginTop: 48, opacity: links, fontFamily: MONO, fontSize: 30, color: TEXT.mid, display: "flex", gap: 60 }}>
          <span><span style={{ color: MODEL }}>▸</span> usevaticr.xyz</span>
          <span><span style={{ color: MODEL }}>▸</span> github.com/mrnetwork0001/Vaticr</span>
        </div>
      </AbsoluteFill>

      {STATS.map((_, i) => (
        <Sfx key={i} id="click" at={tileAt(i)} volume={0.55} />
      ))}
      <Sfx id="ding" at={Math.round(fps * 2.3)} volume={0.45} />
    </AbsoluteFill>
  );
};
