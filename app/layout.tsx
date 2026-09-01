import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vaticr — DeAI market maker for DreamDEX Event Contracts",
  description:
    "Bayesian forecasting and autonomous market making on Somnia's DreamDEX Event Contracts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
