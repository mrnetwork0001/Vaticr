// Opening: the mark springs in, the wordmark types, the tagline follows.
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { MARKET, MODEL, MONO, SANS, TEXT } from "../theme";
import { Grid, Mark } from "../ui";

const WORD = "VATICR";

export const Intro: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // One letter every two frames, starting once the mark has landed.
  const start = Math.round(fps * 0.55);
  const shown = Math.max(0, Math.min(WORD.length, Math.floor((frame - start) / 2)));
  const caret = frame > start && shown < WORD.length && Math.floor(frame / 6) % 2 === 0;

  const tagIn = Math.round(fps * 1.7);
  const tagO = interpolate(frame, [tagIn, tagIn + fps * 0.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const tagY = interpolate(frame, [tagIn, tagIn + fps * 0.5], [14, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const out = interpolate(frame, [frames - 12, frames], [1, 0], { extrapolateLeft: "clamp" });

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Grid />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 34 }}>
        <Mark size={200} />

        <div style={{ display: "flex", alignItems: "center" }}>
          <span
            style={{
              fontFamily: SANS, fontWeight: 800, fontSize: 104, letterSpacing: "0.16em",
              color: TEXT.hi, paddingLeft: "0.16em",
            }}
          >
            {WORD.slice(0, shown)}
          </span>
          {caret ? (
            <span style={{ width: 8, height: 82, background: MODEL, marginLeft: 6, display: "inline-block" }} />
          ) : null}
        </div>

        <div
          style={{
            fontFamily: MONO, fontSize: 26, letterSpacing: "0.28em", textTransform: "uppercase",
            color: MARKET, opacity: tagO, transform: `translateY(${tagY}px)`,
          }}
        >
          Price the window · Trade the gap
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
