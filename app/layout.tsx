import type { Metadata, Viewport } from "next";
import "./globals.css";
import Providers from "./providers";

/**
 * A crystal ball, inline.
 *
 * Kept as a data URI rather than a file so the repository carries no binary
 * assets: the icon is diffable, and it inherits the palette from the same
 * tokens the site uses (ink-950 ground, accent violet).
 */
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
      `<rect width="32" height="32" rx="7" fill="#07080c"/>` +
      `<circle cx="16" cy="13.5" r="8" fill="#818cf8" fill-opacity="0.18" stroke="#818cf8" stroke-width="2"/>` +
      `<path d="M9.5 26.5c1.6-2.6 3.9-3.9 6.5-3.9s4.9 1.3 6.5 3.9z" fill="#818cf8"/>` +
      `<circle cx="12.8" cy="10.6" r="2.1" fill="#e0e7ff"/>` +
      `</svg>`,
  );

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

const TITLE = "Vaticr — DeAI market maker for DreamDEX Event Contracts";
const DESCRIPTION =
  "An event contract's YES token has a real, derivable probability. Vaticr derives it from the price process, tilts it with live news, trades it with zero inventory, and Brier-scores itself afterwards.";

export const metadata: Metadata = {
  // Without a metadataBase Next emits relative og:url values, which every
  // unfurler drops — the shared link then renders as a bare URL.
  metadataBase: new URL(SITE),
  title: {
    default: TITLE,
    template: "%s · Vaticr",
  },
  description: DESCRIPTION,
  applicationName: "Vaticr",
  keywords: [
    "prediction markets", "event contracts", "DreamDEX", "Somnia",
    "Bayesian forecasting", "market making", "Brier score",
  ],
  authors: [{ name: "Vaticr" }],
  icons: {
    icon: [{ url: FAVICON, type: "image/svg+xml" }],
    shortcut: [{ url: FAVICON, type: "image/svg+xml" }],
  },
  openGraph: {
    type: "website",
    siteName: "Vaticr",
    url: SITE,
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    // "summary", not "summary_large_image": the card advertises a picture the
    // repository does not ship, and Twitter renders a broken frame for it.
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#07080c",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Both pages anchor their <main> at #main, so this reaches content on
            either one without a per-page skip target. */}
        <a href="#main" className="skip-link">Skip to main content</a>
        {/* Wallet + market-data context. Everything below still renders with no
            wallet connected — connecting only unlocks the write paths. */}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
