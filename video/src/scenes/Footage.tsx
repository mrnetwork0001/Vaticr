import React from "react";
import { AbsoluteFill, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { INK } from "../theme";
import type { Beat } from "../timeline";
import { manifest } from "../timeline";
import { Caption, Grid, Sfx } from "../ui";

/** A recorded clip in a framed viewport, with the sounds the capture logged at their real times. */
export const Footage: React.FC<{ beat: Beat; frames: number }> = ({ beat, frames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const clip = (manifest.footage as Record<string, typeof manifest.footage[keyof typeof manifest.footage]>)[beat.clip!];
  const from = beat.from ?? 0;
  const play = Math.min(beat.play ?? clip.seconds, clip.seconds - from);
  const seconds = frames / fps;
  // shorter footage than narration: slow it a little (never below 0.75x); longer: cut it
  const rate = play < seconds ? Math.max(0.7, play / seconds) : 1;
  // If the window still cannot fill the beat, freeze on its last frame rather
  // than run past the end and show black.
  const covers = play / rate;
  const held = Math.max(0, (seconds - covers) * fps);
  const enter = interpolate(frame, [0, 14], [0.965, 1], { extrapolateRight: "clamp" });
  const toFrame = (t: number) => Math.round(((t - from) / rate) * fps);
  const inWindow = (t: number) => t >= from && t <= from + play;
  const events = clip.events.filter((e) => inWindow(e.t));
  return (
    <AbsoluteFill>
      <Grid glow={false} />
      {/* Full bleed. The clip was previously inset in a rounded 1800x1012
          card, which read as a screenshot pasted onto a slide and made the
          recorded app smaller than the graphics either side of it. */}
      <AbsoluteFill>
        <OffthreadVideo
          src={staticFile(clip.file)}
          startFrom={Math.round(from * fps)}
          endAt={Math.round((from + play) * fps) + 1}
          playbackRate={rate}
          muted
          style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${enter})` }}
        />
      </AbsoluteFill>
      {beat.caption ? <Caption text={beat.caption} kicker={beat.kicker} total={frames} /> : null}
      {events.map((e, i) => {
        const at = toFrame(e.t);
        if (e.kind === "key") return <Sfx key={i} id="key" at={at} volume={0.55} />;
        if (e.kind === "click") return <Sfx key={i} id="click" at={at} volume={0.7} />;
        if (e.kind === "result") return <Sfx key={i} id="ding" at={at} volume={0.45} />;
        if (e.kind === "veto") return <Sfx key={i} id="veto" at={at} volume={0.6} />;
        if (e.kind === "scroll" && e.note) return <Sfx key={i} id="whoosh" at={at} volume={0.18} />;
        return null;
      })}
    </AbsoluteFill>
  );
};
