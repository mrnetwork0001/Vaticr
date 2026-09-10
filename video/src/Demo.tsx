// The cut. Each beat is a scene with its narration; beats cross-fade, with a
// continuous bed underneath at low volume. Every timing comes from timeline.ts,
// which derives it from the manifest.
import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useVideoConfig } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { BEATS, FPS, TRANSITION_S, beatStartFrame, manifest } from "./timeline";
import { Narration, Sfx } from "./ui";
import { Intro } from "./scenes/Intro";
import { Gap } from "./scenes/Gap";
import { MintPair } from "./scenes/MintPair";
import { Evidence } from "./scenes/Evidence";
import { Footage } from "./scenes/Footage";
import { Close } from "./scenes/Close";

const Scene: React.FC<{ i: number }> = ({ i }) => {
  const b = BEATS[i];
  const frames = Math.round(b.seconds * FPS);
  switch (b.kind) {
    case "intro": return <Intro frames={frames} />;
    case "gap": return <Gap frames={frames} />;
    case "mint": return <MintPair frames={frames} />;
    case "evidence": return <Evidence frames={frames} />;
    case "footage": return <Footage beat={b} frames={frames} />;
    case "close": return <Close frames={frames} />;
  }
};

export const Demo: React.FC = () => {
  const { fps, durationInFrames } = useVideoConfig();
  const bed = manifest.sfx.bed;
  return (
    <AbsoluteFill style={{ background: "#07090f" }}>
      <TransitionSeries>
        {BEATS.map((b, i) => (
          <React.Fragment key={b.id}>
            {i > 0 ? (
              <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: Math.round(TRANSITION_S * fps) })} />
            ) : null}
            <TransitionSeries.Sequence durationInFrames={Math.round(b.seconds * fps)}>
              <Scene i={i} />
            </TransitionSeries.Sequence>
          </React.Fragment>
        ))}
      </TransitionSeries>

      {/* narration, placed on the global timeline so cross-fades never clip a sentence */}
      {BEATS.map((b, i) => (
        <Narration key={b.id} id={b.narration} at={beatStartFrame(i) + Math.round(fps * 0.35)} />
      ))}
      {/* Music bed: one continuous file, not a 20s loop.
          Looping it clicked audibly at every seam - the loudest transient in
          the whole film sat at 80 seconds, which is exactly four loops in. */}
      <Sequence from={0} durationInFrames={durationInFrames} layout="none">
        <Audio src={staticFile(bed.file)} volume={0.10} />
      </Sequence>
    </AbsoluteFill>
  );
};
