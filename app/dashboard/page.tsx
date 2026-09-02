import type { Metadata } from "next";
import Dashboard from "../components/Dashboard";

export const dynamic = "force-dynamic";

const DESCRIPTION =
  "Live Bayesian forecasts on DreamDEX Event Contracts: prior, posterior and the top-of-book mid per window, the headlines behind each posterior, and the Brier score against the coin-flip baseline.";

export const metadata: Metadata = {
  title: "Live windows",
  description: DESCRIPTION,
  alternates: { canonical: "/dashboard" },
  openGraph: {
    type: "website",
    siteName: "Vaticr",
    url: "/dashboard",
    title: "Vaticr — live windows",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary",
    title: "Vaticr — live windows",
    description: DESCRIPTION,
  },
};

export default function Page() {
  return <Dashboard />;
}
