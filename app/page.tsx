import LiveStats from "./components/LiveStats";
import {
  BOT_KIT, DREAMDEX_DOCS, Finding, GITHUB, HACKATHON, Row, Section, Step,
} from "./components/landing/Sections";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Vaticr — DeAI forecasting for DreamDEX Event Contracts",
  description:
    "An event contract's YES token has a real, derivable probability. Vaticr derives it from the price process, tilts it with live news, trades it with zero inventory, and proves afterwards whether it was any good.",
};

export default function Landing() {
  return (
    <div className="min-h-screen">
      {/* ---------------------------------------------------------------- nav */}
      <nav className="sticky top-0 z-50 border-b border-white/5 bg-ink-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
          <a href="/" className="flex items-center gap-2.5">
            <span className="text-lg">🔮</span>
            <span className="text-[15px] font-semibold tracking-tight text-white">
              Vaticr
            </span>
          </a>
          <div className="flex items-center gap-1 sm:gap-5">
            <a href="#how" className="hidden text-[13px] text-slate-400 transition hover:text-white sm:block">
              How it works
            </a>
            <a href="#mint" className="hidden text-[13px] text-slate-400 transition hover:text-white sm:block">
              Mint-a-pair
            </a>
            <a href="#findings" className="hidden text-[13px] text-slate-400 transition hover:text-white sm:block">
              Findings
            </a>
            <a href={GITHUB} target="_blank" rel="noreferrer"
               className="hidden text-[13px] text-slate-400 transition hover:text-white sm:block">
              GitHub
            </a>
            <a href="/dashboard"
               className="rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-semibold text-ink-950 transition hover:bg-accent/90">
              Launch app
            </a>
          </div>
        </div>
      </nav>

      {/* --------------------------------------------------------------- hero */}
      <header className="mx-auto max-w-6xl px-5 pb-6 pt-20 sm:pt-28">
        <div className="rise">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11.5px] text-slate-400">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-up" />
            Built on Somnia × DreamDEX Event Contracts
          </span>

          <h1 className="mt-7 max-w-4xl text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-6xl">
            A prediction market where the odds can be{" "}
            <span className="text-accent">derived</span>, not guessed.
          </h1>

          <p className="mt-6 max-w-2xl text-pretty text-[16.5px] leading-relaxed text-slate-400">
            A DreamDEX event contract asks exactly one question:{" "}
            <em className="not-italic text-slate-200">
              will this window close at or above the price it opened at?
            </em>{" "}
            That makes the fair value of its YES token a genuine probability — and a
            probability can be computed. Vaticr computes it, trades it with zero
            inventory, and then proves whether it was any good.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <a href="/dashboard"
               className="rounded-lg bg-accent px-5 py-2.5 text-[14px] font-semibold text-ink-950 transition hover:bg-accent/90">
              Launch app →
            </a>
            <a href={GITHUB} target="_blank" rel="noreferrer"
               className="rounded-lg border border-white/15 px-5 py-2.5 text-[14px] font-medium text-slate-200 transition hover:border-white/30 hover:bg-white/5">
              View source
            </a>
            <a href="#how" className="px-2 py-2.5 text-[14px] text-slate-500 transition hover:text-slate-300">
              How it works
            </a>
          </div>

          <LiveStats />
        </div>
      </header>

      <div className="rule mx-auto max-w-6xl" />

      {/* ------------------------------------------------------- the constraint */}
      <Section
        eyebrow="The honest part"
        title="This is not a market factory — and it could not be."
        lede="Vaticr started as a headline-to-contract factory: scan the news, deploy a matching event contract, resolve it from a signed news payload. Building against the live protocol, all three premises turned out to be impossible. That is a property of DreamDEX, not a gap in it."
      >
        <div className="mt-9 grid gap-4 md:grid-cols-3">
          {[
            {
              t: "Markets can't be created",
              d: "Event contracts are rolling Up/Down windows on BTC and ETH, minted per window by BinaryMarketsModule. There is no permissionless creation entry point, and the question text is fixed.",
            },
            {
              t: "Contracts can't be resolved",
              d: "Settlement is automatic. The question is scheduled on the OracleHub at creation with its resolution gas reserved, and Somnia reactivity fires the callback at expiry. Nobody has to — the chain does.",
            },
            {
              t: "It's a CLOB, not an AMM",
              d: "One on-chain order book per market, quoted in YES terms, where a NO price is always 1 − yes. There is no curve to provide liquidity to.",
            },
          ].map((c) => (
            <div key={c.t} className="card p-5">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 text-down">✕</span>
                <div>
                  <h3 className="text-[14px] font-semibold text-white">{c.t}</h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-slate-400">{c.d}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-xl border border-up/25 bg-up/[0.07] p-6">
          <p className="text-[14.5px] leading-relaxed text-slate-200">
            <span className="font-semibold text-up">So Vaticr does what is actually unowned.</span>{" "}
            It decides what these windows are worth, trades that view through the
            official Bot Kit, and makes the resulting track record auditable by
            someone who does not trust it. The pivot cost nothing in ambition — it
            swapped a subsystem the protocol forbids for one it rewards.
          </p>
        </div>
      </Section>

      <div className="rule mx-auto max-w-6xl" />

      {/* ------------------------------------------------------------ how it works */}
      <Section
        id="how"
        eyebrow="How it works"
        title="A prior from physics, a posterior from the news."
        lede="Two stages. The price process gives an honest base rate; the news moves it. Bayes' rule is additive in log-odds, so the two combine exactly rather than by fudge factor."
      >
        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          <Step n="1" title="Prior — the price process">
            <p>
              Over seconds to an hour, a driftless geometric Brownian motion is a
              defensible model of BTC/ETH. With <em>S</em> the current level,{" "}
              <em>S₀</em> the window&rsquo;s opening price, <em>τ</em> the seconds
              remaining and <em>σ</em> the measured volatility:
            </p>
            <div className="formula rounded-lg border border-white/10 bg-ink-950/60 p-4">
              P(<em>S_T</em> ≥ <em>S₀</em>) = Φ
              <span className="text-slate-500">(</span>
              <span className="inline-flex flex-col items-center px-1 align-middle">
                <span>ln(<em>S</em>/<em>S₀</em>) − <em>σ</em>²<em>τ</em>/2</span>
                <span className="my-0.5 h-px w-full bg-slate-600" />
                <span><em>σ</em>√<em>τ</em></span>
              </span>
              <span className="text-slate-500">)</span>
            </div>
            <p>
              This is already an edge on its own: it is the honest read of where a
              window sits against its own open — which a book full of people watching
              a candle chart tends to misprice near the extremes.
            </p>
          </Step>

          <Step n="2" title="Posterior — the headlines">
            <p>
              Five public news feeds are scored for directional impact, salience and
              source credibility. Each headline contributes a log-likelihood ratio:
            </p>
            <div className="formula rounded-lg border border-white/10 bg-ink-950/60 p-4">
              logit(<em>posterior</em>) = logit(<em>prior</em>) + Σᵢ <em>LLRᵢ</em>
            </div>
            <p>
              Every contribution is discounted three ways — by credibility, by
              exponential time decay (news gets priced in), and by how much of the
              window is left, since a headline cannot move a contract expiring in
              four seconds. The total is hard-capped so a burst of correlated stories
              cannot run the posterior into a corner.
            </p>
          </Step>

          <Step n="3" title="Trade, then prove it">
            <p>
              When the posterior clears the <em>touch</em> — never the mid, because
              paying the spread is how a signal with real edge still loses money — it
              crosses with an IOC. Otherwise it rests a two-sided quote.
            </p>
            <p>
              Every forecast is committed <em>before</em> its window closes, then
              Brier-scored against what actually happened. A model that cannot beat
              0.25 is a coin flip with extra steps, and this is the only way to know.
            </p>
            <p className="text-slate-500">
              Commitments can also be published on-chain, so the record is checkable
              by someone who does not trust the agent that produced it.
            </p>
          </Step>
        </div>
      </Section>

      <div className="rule mx-auto max-w-6xl" />

      {/* --------------------------------------------------------------- mint-a-pair */}
      <Section
        id="mint"
        eyebrow="The mechanic"
        title="Mint-a-pair: making markets with zero inventory."
        lede="This is the best thing about building on this venue, and it deserves more than one row in a table. Of the four ways orders cross on a binary book, one needs no seller at all."
      >
        <div className="mt-10 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
          <div className="card overflow-hidden">
            <div className="border-b border-white/10 px-5 py-3">
              <h3 className="text-[13px] font-semibold text-slate-200">
                How orders cross on a binary book
              </h3>
            </div>
            <div className="divide-y divide-white/5">
              {[
                ["Buy YES × Sell YES", "direct", "tokens ↔ collateral", false],
                ["Buy NO × Sell NO", "direct", "tokens ↔ collateral", false],
                ["Buy YES × Buy NO", "mint-a-pair", "the pool mints a fresh pair — no seller needed", true],
                ["Sell YES × Sell NO", "burn-a-pair", "both positions burn", false],
              ].map(([pair, path, what, hero]) => (
                <div key={pair as string}
                     className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3 ${hero ? "bg-accent/[0.08]" : ""}`}>
                  <span className={`mono text-[12.5px] ${hero ? "font-semibold text-accent" : "text-slate-300"}`}>
                    {pair}
                  </span>
                  <span className={`text-[11px] ${hero ? "text-accent/80" : "text-slate-600"}`}>
                    {path}
                  </span>
                  <span className="w-full text-[12px] text-slate-500">{what}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <div className="card p-6">
              <h3 className="text-[14px] font-semibold text-white">
                Two resting buys are a complete two-sided quote
              </h3>
              <div className="formula mt-4 space-y-1.5 rounded-lg border border-white/10 bg-ink-950/60 p-4">
                <div>BUY_YES @ <em>p − δ</em></div>
                <div>BUY_NO&nbsp; @ <em>(1 − p) − δ</em></div>
              </div>
              <p className="mt-4 text-[13.5px] leading-relaxed text-slate-400">
                Because two opposite-side buyers can cross against each other, that
                pair quotes both sides of the market with{" "}
                <span className="text-slate-200">no inventory</span> and{" "}
                <span className="text-slate-200">no counterparty market maker</span>.
                A conventional maker must hold what it sells. Vaticr never sells.
              </p>
            </div>

            <div className="card p-6">
              <h3 className="text-[14px] font-semibold text-white">
                Which means the risk is only the imbalance
              </h3>
              <p className="mt-3 text-[13.5px] leading-relaxed text-slate-400">
                Since it only ever buys, its position is complete sets plus a
                remainder. A complete set redeems for exactly 1 collateral whatever
                the outcome — it is riskless. So the only exposure carried is the{" "}
                <span className="text-slate-200">net YES-minus-NO imbalance</span>,
                which the inventory cap bounds directly. Past the cap, only the leg
                that flattens is quoted.
              </p>
            </div>
          </div>
        </div>
      </Section>

      <div className="rule mx-auto max-w-6xl" />

      {/* ------------------------------------------------------------- findings */}
      <Section
        id="findings"
        eyebrow="What we measured"
        title="Two findings that changed the implementation."
        lede="Both were silent failures — the kind where the code runs, the orders fill, and the money quietly goes the wrong way. Both are written up in full in the SDK feedback report."
      >
        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <Finding
            title="Settlement resolves against the EMA, not spot"
            problem="The docs describe the settlement reference only as “a multi-source price reference”, which reads like spot. The feed publishes two series: spot, and mark, its EMA. It settles on mark."
            evidence={
              <div>
                <p className="mb-3 text-[12px] text-slate-500">
                  Close-vs-open over the eight most recent settlements:
                </p>
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="mono w-12 text-[12px] text-slate-400">mark</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-700">
                      <div className="h-full rounded-full bg-up" style={{ width: "100%" }} />
                    </div>
                    <span className="mono w-10 text-right text-[12px] font-semibold text-up">8/8</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="mono w-12 text-[12px] text-slate-400">spot</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-700">
                      <div className="h-full rounded-full bg-down" style={{ width: "75%" }} />
                    </div>
                    <span className="mono w-10 text-right text-[12px] font-semibold text-down">6/8</span>
                  </div>
                </div>
                <p className="mt-3 text-[12px] leading-relaxed text-slate-500">
                  The two disagreements were exactly the windows where the series
                  drifted apart in direction — the near-the-money ones, where the
                  probability is most sensitive and most worth trading.
                </p>
              </div>
            }
            fix="Price the level off mark, the series settlement actually compares."
          />

          <Finding
            title="Naive volatility reads four times too low"
            problem="Because mark is an EMA sampled every second, consecutive increments are heavily autocorrelated. The textbook realised-volatility estimator measures the smoothing, not the process."
            evidence={
              <div>
                <p className="mb-3 text-[12px] text-slate-500">
                  Annualised vol by sampling step, live BTC testnet data:
                </p>
                <div className="overflow-x-auto">
                  <table className="mono w-full text-[11.5px]">
                    <thead>
                      <tr className="text-slate-600">
                        <th className="pb-1 text-left font-normal">step</th>
                        {["1s", "5s", "15s", "30s", "60s"].map((h) => (
                          <th key={h} className="pb-1 text-right font-normal">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="text-slate-400">
                        <td className="py-0.5">mark</td>
                        {["0.079", "0.155", "0.234", "0.278", "0.264"].map((v, i) => (
                          <td key={v} className={`py-0.5 text-right ${i === 0 ? "font-semibold text-down" : ""}`}>{v}</td>
                        ))}
                      </tr>
                      <tr className="text-slate-400">
                        <td className="py-0.5">spot</td>
                        {["0.248", "0.272", "0.298", "0.303", "0.274"].map((v) => (
                          <td key={v} className="py-0.5 text-right">{v}</td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-[12px] leading-relaxed text-slate-500">
                  Ground truth from the realised 300-second moves is ≈0.33. Fed into
                  a Gaussian model, 0.079 drives P(Up) to 0.0000 on windows that are
                  genuinely a coin flip — maximum confidence exactly where there is
                  least information.
                </p>
              </div>
            }
            fix="Resample onto a 30-second grid, and estimate volatility from spot while taking the level from mark. Understating volatility makes the prior overconfident — the direction that loses money."
          />
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <a href={`${GITHUB}/blob/main/docs/SDK_FEEDBACK.md`} target="_blank" rel="noreferrer"
             className="rounded-lg border border-white/15 px-4 py-2 text-[13px] text-slate-200 transition hover:border-white/30 hover:bg-white/5">
            Read the full SDK feedback report →
          </a>
          <a href={`${GITHUB}/blob/main/docs/ARCHITECTURE.md`} target="_blank" rel="noreferrer"
             className="rounded-lg border border-white/15 px-4 py-2 text-[13px] text-slate-200 transition hover:border-white/30 hover:bg-white/5">
            Architecture note →
          </a>
        </div>
      </Section>

      <div className="rule mx-auto max-w-6xl" />

      {/* ----------------------------------------------------------- under the hood */}
      <Section
        eyebrow="Under the hood"
        title="Four subsystems, one command."
        lede="Python reads and models; TypeScript owns every write, because that is where the Bot Kit and markets-sdk own signing, nonces and escrow — and two senders on one key race each other."
      >
        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <div className="card p-6">
            <h3 className="text-[13px] font-semibold text-slate-200">Modules</h3>
            <div className="mt-3">
              <Row k="agents/scout.py" v="headlines → directional evidence" />
              <Row k="agents/pricing.py" v="GBM prior + log-odds evidence" />
              <Row k="agents/resolver.py" v="audit · Brier score · backstops" />
              <Row k="agents/server.py" v="FastAPI surface the bot polls" />
              <Row k="bot/src/runner.ts" v="the trading loop" />
              <Row k="bot/src/strategy.ts" v="take-vs-quote, mint-a-pair levels" />
              <Row k="bot/src/backstop.ts" v="pokeOracle / voidExpired" />
              <Row k="VaticrForecastRegistry.sol" v="append-only commitments" />
            </div>
          </div>

          <div className="space-y-5">
            <div className="card p-6">
              <h3 className="text-[13px] font-semibold text-slate-200">Get it running</h3>
              <pre className="mono mt-3 overflow-x-auto rounded-lg border border-white/10 bg-ink-950/70 p-4 text-[12.5px] leading-relaxed text-slate-300">
{`git clone ${GITHUB.replace("https://", "")}
cd Vaticr

npm install
pip install -r requirements.txt
cp .env.example .env

npm run bot:start   # brain + bot, one command`}
              </pre>
              <p className="mt-3 text-[12.5px] leading-relaxed text-slate-500">
                Starts in <span className="mono text-slate-400">DRY_RUN</span>, logging
                every order it would place and sending nothing.
              </p>
            </div>

            <div className="card p-6">
              <h3 className="text-[13px] font-semibold text-slate-200">Verification</h3>
              <div className="mt-3 grid grid-cols-2 gap-3 text-center">
                {[
                  ["17", "engine property tests"],
                  ["7", "Solidity tests"],
                ].map(([n, l]) => (
                  <div key={l} className="rounded-lg border border-white/10 bg-ink-950/50 py-3">
                    <div className="mono text-lg font-semibold text-white">{n}</div>
                    <div className="mt-0.5 text-[11px] leading-tight text-slate-500">{l}</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[12.5px] leading-relaxed text-slate-500">
                Including Monte-Carlo recovery of a known volatility, and a regression
                for the EMA bug above. Settlements are recomputed continuously rather
                than claimed once &mdash; the live figure is in the strip at the top,
                and every row is on the dashboard.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {[
            "Somnia testnet (50312)", "DreamDEX Event Contracts", "dreamDEX Bot Kit",
            "@somnia-chain/markets-sdk", "Solidity 0.8.24", "Next.js 14",
            "Python 3.11 · FastAPI", "Claude (optional)",
          ].map((t) => (
            <span key={t}
                  className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11.5px] text-slate-400">
              {t}
            </span>
          ))}
        </div>
      </Section>

      {/* ------------------------------------------------------------------- cta */}
      <section className="mx-auto max-w-6xl px-5 pb-20">
        <div className="card overflow-hidden">
          <div className="px-8 py-12 text-center">
            <h2 className="text-balance text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              See it pricing live windows right now.
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-[14.5px] leading-relaxed text-slate-400">
              The dashboard shows every live BTC and ETH window with its prior, its
              posterior and the book mid side by side — plus the headline feed moving
              them and every settlement recomputed from the oracle.
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <a href="/dashboard"
                 className="rounded-lg bg-accent px-6 py-2.5 text-[14px] font-semibold text-ink-950 transition hover:bg-accent/90">
                Launch app →
              </a>
              <a href={GITHUB} target="_blank" rel="noreferrer"
                 className="rounded-lg border border-white/15 px-6 py-2.5 text-[14px] font-medium text-slate-200 transition hover:border-white/30 hover:bg-white/5">
                View source
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- footer */}
      <footer className="border-t border-white/5">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-7">
          <p className="text-[12px] text-slate-600">
            Vaticr · Apache-2.0 · Markets and settlement are the DreamDEX protocol;
            the forecasting is Vaticr&rsquo;s.
          </p>
          <div className="flex flex-wrap gap-5 text-[12px]">
            <a href={GITHUB} target="_blank" rel="noreferrer" className="text-slate-500 transition hover:text-slate-300">GitHub</a>
            <a href={DREAMDEX_DOCS} target="_blank" rel="noreferrer" className="text-slate-500 transition hover:text-slate-300">DreamDEX docs</a>
            <a href={BOT_KIT} target="_blank" rel="noreferrer" className="text-slate-500 transition hover:text-slate-300">Bot Kit</a>
            <a href={HACKATHON} target="_blank" rel="noreferrer" className="text-slate-500 transition hover:text-slate-300">Hackathon</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
