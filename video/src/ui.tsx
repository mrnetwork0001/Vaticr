// Shared pieces: the ground, the mark, eyebrow captions, lower thirds, sound cues.
import React from "react";
import { AbsoluteFill, Audio, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { INK, MODEL, MARKET, MONO, SANS, TEXT } from "./theme";
import { manifest } from "./timeline";

/**
 * The ground every graphic sits on.
 *
 * Two washes, one per voice - indigo top-left for the model, amber top-right
 * for the book - so even an empty frame carries the film's one idea.
 */
export const Grid: React.FC<{ glow?: boolean }> = ({ glow = true }) => (
  <AbsoluteFill
    style={{
      background: INK[950],
      backgroundImage:
        "linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px)",
      backgroundSize: "44px 44px",
    }}
  >
    {glow ? (
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(55% 55% at 14% 0%, rgba(129,140,248,0.14), transparent 62%), radial-gradient(45% 45% at 92% 6%, rgba(240,185,11,0.08), transparent 60%)",
        }}
      />
    ) : null}
  </AbsoluteFill>
);

/** The wordmark, springing in from the brand asset rather than redrawn. */
export const Mark: React.FC<{ size?: number; delay?: number }> = ({ size = 190, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = Math.max(0, frame - delay);
  const s = spring({ frame: f, fps, config: { damping: 14, stiffness: 120 } });
  const o = interpolate(f, [0, fps * 0.4], [0, 1], { extrapolateRight: "clamp" });
  return (
    <Img
      src={staticFile("brand/vaticr-mark.png")}
      style={{ width: size, height: "auto", opacity: o, transform: `scale(${0.86 + s * 0.14})` }}
    />
  );
};

export const Eyebrow: React.FC<{ children: React.ReactNode; color?: string; style?: React.CSSProperties }> = ({
  children, color = MODEL, style,
}) => (
  <div style={{ fontFamily: MONO, fontSize: 22, letterSpacing: "0.24em", textTransform: "uppercase", color, ...style }}>
    {children}
  </div>
);

/** Lower-third caption: fades in after `delay`, out before the beat ends. */
export const Caption: React.FC<{ text: string; delay?: number; total: number }> = ({ text, delay = 10, total }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [delay, delay + 12, total - 18, total - 4], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const y = interpolate(frame, [delay, delay + 12], [16, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: 72, bottom: 56, opacity: o, transform: `translateY(${y}px)` }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 14, padding: "12px 18px", borderRadius: 10, background: "rgba(7,9,15,0.82)", border: `1px solid ${INK[700]}`, backdropFilter: "blur(6px)" }}>
        <span style={{ width: 10, height: 10, background: MARKET, borderRadius: 2 }} />
        <span style={{ fontFamily: SANS, fontSize: 24, color: TEXT.hi, fontWeight: 600 }}>{text}</span>
      </div>
    </div>
  );
};

/** A number that counts up to its value, then holds. Digits never reflow. */
export const Count: React.FC<{
  to: number; decimals?: number; prefix?: string; suffix?: string; delay?: number; color?: string; size?: number;
}> = ({ to, decimals = 0, prefix = "", suffix = "", delay = 0, color = TEXT.hi, size = 88 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const v = interpolate(frame, [delay, delay + fps * 1.1], [0, to], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
    easing: (t) => 1 - Math.pow(1 - t, 3),
  });
  return (
    <span style={{ fontFamily: MONO, fontSize: size, fontWeight: 700, color, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>
      {prefix}{v.toFixed(decimals)}{suffix}
    </span>
  );
};

type SfxId = keyof typeof manifest.sfx;
export const Sfx: React.FC<{ id: SfxId; at: number; volume?: number }> = ({ id, at, volume = 0.5 }) => {
  const { fps } = useVideoConfig();
  const s = manifest.sfx[id];
  const frames = Math.max(2, Math.ceil(s.seconds * fps));
  if (at < 0) return null;
  return (
    <Sequence from={Math.round(at)} durationInFrames={frames} layout="none">
      <Audio src={staticFile(s.file)} volume={volume} />
    </Sequence>
  );
};

export const Narration: React.FC<{ id: keyof typeof manifest.narration; at?: number }> = ({ id, at = 0 }) => {
  const { fps } = useVideoConfig();
  const n = manifest.narration[id];
  return (
    <Sequence from={at} durationInFrames={Math.ceil(n.seconds * fps) + 2} layout="none">
      <Audio src={staticFile(n.file)} volume={1} />
    </Sequence>
  );
};
