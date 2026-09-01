import Dashboard from "../components/Dashboard";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Vaticr — live windows",
  description: "Live Bayesian forecasts on DreamDEX Event Contracts.",
};

export default function Page() {
  return <Dashboard />;
}
