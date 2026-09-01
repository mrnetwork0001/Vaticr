import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#07080c", 900: "#0b0d14", 850: "#10131c", 800: "#161a26", 700: "#222736" },
        up: "#34d399",
        down: "#fb7185",
        accent: "#818cf8",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
