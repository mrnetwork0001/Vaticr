import type { Config } from "tailwindcss";

/**
 * Vaticr's design tokens, aligned to the house style: a cool near-black ink
 * ramp, functional colour coding rather than decoration, and no glow.
 *
 * The two accents are not brand colours, they are MEANINGS, and the whole site
 * depends on the reader learning them in the first five seconds:
 *
 *   model   what Vaticr's posterior says a window is worth
 *   market  what the order book is actually asking
 *
 * Everywhere those two appear together — the probability bar, the trade ticket,
 * the row badges — they keep these colours. `up` and `down` stay semantic
 * (a window closing above or below its open) and are never used for anything else.
 */
const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#07090f",
          900: "#0b0f19",
          850: "#0e1420",
          800: "#111827",
          700: "#1f2937",
        },
        model: { DEFAULT: "#818cf8", dim: "#5b64c4" },
        market: { DEFAULT: "#F0B90B", dim: "#c99a05" },
        up: "#34d399",
        down: "#fb7185",
        // Retained so existing components keep compiling; `model` is the name
        // to reach for in anything new.
        accent: "#818cf8",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      maxWidth: {
        page: "calc(50vw + 36rem)",
        nav: "calc(75vw + 18rem)",
      },
    },
  },
  plugins: [],
};
export default config;
