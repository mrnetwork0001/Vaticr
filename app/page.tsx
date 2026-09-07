import Hero from "./components/landing/Hero";
import Footer from "./components/landing/Footer";
import Nav from "./components/landing/Nav";
import { Code, Mono, Num, Panel, Section, Tag, nth } from "./components/landing/Section";
import Reveal from "./components/landing/Reveal";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Vaticr — derived odds for DreamDEX Event Contracts",
  description:
    "A DreamDEX event contract's YES token has a real, derivable probability. Vaticr computes it from the price process, tilts it with live news, trades the gap, and proves afterwards whether it was any good.",
};

const GITHUB = "https://github.com/mrnetwork0001/Vaticr";
const EXPLORER = "https://shannon-explorer.somnia.network";
const REGISTRY = "0x3D04ff026A4Dc553a2ae9071dbc238a40D24b27A";

export default function Landing() {
  return (
    <div className="min-h-screen">
      <Nav />
      <Hero />

      {/* ------------------------------------------------------- the constraint */}
      <Section
        id="constraint"
        eyebrow="the honest part"
        title="This is not a market factory, and it could not be."
        lead={
          <>
            Vaticr began as a headline-to-contract factory: scan the news, deploy a
            matching event contract, resolve it from a signed news payload. Building
            against the live protocol, all three premises turned out to be
            impossible. That is a property of DreamDEX, not a gap in it.
          </>
        }
      >
        <Reveal>
          <div className="stagger grid gap-4 md:grid-cols-3">
            {[
              ["Markets cannot be created", "Event contracts are rolling Up/Down windows on BTC and ETH, minted per window by BinaryMarketsModule. There is no permissionless creation entry point and the question text is fixed."],
              ["Contracts cannot be resolved", "Settlement is automatic. The question is scheduled on the OracleHub at creation with its resolution gas reserved, and Somnia reactivity fires the callback at expiry."],
              ["It is a CLOB, not an AMM", "One on-chain order book per market, quoted in YES terms, where a NO price is always 1 − yes. There is no curve to provide liquidity to."],
            ].map(([t, d], i) => (
              <div key={t} style={nth(i)}>
                <Panel className="h-full">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 font-mono text-down">✕</span>
                    <div>
                      <h3 className="text-[14px] font-semibold text-gray-100">{t}</h3>
                      <p className="mt-2 text-[13px] leading-relaxed text-gray-400">{d}</p>
                    </div>
                  </div>
                </Panel>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal i={1}>
          <div className="mt-4 rounded-lg border border-up/25 bg-up/[0.06] p-5">
            <p className="text-[14.5px] leading-relaxed text-gray-200">
              <span className="font-semibold text-up">So Vaticr does what is actually unowned.</span>{" "}
              It decides what these windows are worth, trades that view through the
              official Bot Kit, and makes the resulting track record auditable by
              someone who does not trust it. The pivot cost nothing in ambition — it
              swapped a subsystem the protocol forbids for one it rewards.
            </p>
          </div>
        </Reveal>
      </Section>

      {/* --------------------------------------------------------- how it works */}
      <Section
        id="how"
        eyebrow="how it works"
        title="A prior from physics, a posterior from the news."
        lead="Two stages. The price process gives an honest base rate; the news moves it. Bayes' rule is additive in log-odds, so the two combine exactly rather than by fudge factor."
      >
        <Reveal>
          <div className="stagger grid gap-4 lg:grid-cols-3">
            <div style={nth(0)}>
              <Panel className="h-full">
                <div className="flex items-center gap-2">
                  <Tag color="#818cf8">01</Tag>
                  <h3 className="text-[14px] font-semibold text-gray-100">Prior — the price process</h3>
                </div>
                <p className="mt-3 text-[13px] leading-relaxed text-gray-400">
                  Over seconds to an hour a driftless geometric Brownian motion is a
                  defensible model of BTC/ETH. With <Mono>S</Mono> the current level,{" "}
                  <Mono>S₀</Mono> the window&rsquo;s opening price and <Mono>τ</Mono> the
                  seconds remaining:
                </p>
                <div className="formula mt-3 rounded border border-ink-700 bg-ink-950 p-3">
                  P(<em>S_T</em> ≥ <em>S₀</em>) = Φ
                  <span className="inline-flex flex-col items-center px-1 align-middle">
                    <span>ln(<em>S</em>/<em>S₀</em>) − <em>σ</em>²<em>τ</em>/2</span>
                    <span className="my-0.5 h-px w-full bg-gray-600" />
                    <span><em>σ</em>√<em>τ</em></span>
                  </span>
                </div>
                <p className="mt-3 text-[13px] leading-relaxed text-gray-400">
                  This is already an edge: the honest read of where a window sits
                  against its own open, which a book of people watching a candle chart
                  tends to misprice near the extremes.
                </p>
              </Panel>
            </div>

            <div style={nth(1)}>
              <Panel className="h-full">
                <div className="flex items-center gap-2">
                  <Tag color="#818cf8">02</Tag>
                  <h3 className="text-[14px] font-semibold text-gray-100">Posterior — the headlines</h3>
                </div>
                <p className="mt-3 text-[13px] leading-relaxed text-gray-400">
                  Five public feeds are scored for direction, salience and source
                  credibility. Each headline contributes a log-likelihood ratio:
                </p>
                <div className="formula mt-3 rounded border border-ink-700 bg-ink-950 p-3">
                  logit(<em>posterior</em>) = logit(<em>prior</em>) + Σᵢ <em>LLRᵢ</em>
                </div>
                <p className="mt-3 text-[13px] leading-relaxed text-gray-400">
                  Every contribution is discounted three ways — by credibility, by
                  exponential time decay, and by how much of the window is left, since
                  a headline cannot move a contract expiring in four seconds. The total
                  is hard-capped so a burst of correlated stories cannot run the
                  posterior into a corner.
                </p>
              </Panel>
            </div>

            <div style={nth(2)}>
              <Panel className="h-full">
                <div className="flex items-center gap-2">
                  <Tag color="#818cf8">03</Tag>
                  <h3 className="text-[14px] font-semibold text-gray-100">Trade it, then prove it</h3>
                </div>
                <p className="mt-3 text-[13px] leading-relaxed text-gray-400">
                  When the posterior clears the <em className="not-italic text-market">touch</em> —
                  never the mid, because paying the spread is how a signal with real
                  edge still loses money — it crosses with an IOC. Otherwise it rests a
                  two-sided quote.
                </p>
                <p className="mt-3 text-[13px] leading-relaxed text-gray-400">
                  Every forecast is committed <span className="text-gray-200">before</span>{" "}
                  its window closes, then Brier-scored against what happened. A model
                  that cannot beat 0.25 is a coin flip with extra steps, and this is the
                  only way to know.
                </p>
              </Panel>
            </div>
          </div>
        </Reveal>
      </Section>

      {/* ------------------------------------------------------------- evidence */}
      <Section
        id="evidence"
        eyebrow="evidence"
        title="Does the model actually work?"
        lead={
          <>
            The claim is testable, so it is tested. Every input is public and
            historical, so the backtest replays settled windows the model never saw.
            The figures below are frozen in{" "}
            <a className="text-model hover:underline" href={`${GITHUB}/blob/main/docs/evidence/backtest-2026-09-04.json`} target="_blank" rel="noreferrer">
              docs/evidence/
            </a>{" "}
            — re-running drifts, because it replays a rolling window.
          </>
        }
      >
        <Reveal>
          <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
            <Panel>
              <table className="w-full text-[13px]">
                <tbody className="divide-y divide-ink-700/70">
                  {[
                    ["sample", "900 forecasts / 300 windows"],
                    ["Brier", "0.15522"],
                    ["coin flip", "0.25"],
                    ["skill", "+0.3791"],
                    ["accuracy", "0.7622"],
                    ["log loss", "0.46816"],
                  ].map(([k, v]) => (
                    <tr key={k}>
                      <td className="py-2 text-gray-400">{k}</td>
                      <td className={`py-2 text-right font-mono tabular-nums ${k === "skill" ? "font-bold text-up" : "text-gray-100"}`}>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <Panel>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-gray-500">
                skill by time elapsed
              </p>
              <div className="mt-4 flex h-40 items-end gap-6 px-2">
                {[
                  ["25%", 0.1816, "0.2046"],
                  ["50%", 0.3469, "0.16327"],
                  ["75%", 0.6088, "0.09779"],
                ].map(([label, skill, brier], i) => (
                  <div key={label as string} className="flex flex-1 flex-col items-center gap-2">
                    <span className="mono text-[11px] font-bold text-up">
                      +{(skill as number).toFixed(4)}
                    </span>
                    <div className="flex w-full flex-1 items-end">
                      <div
                        className="grow-y w-full rounded-t bg-model/70"
                        style={{ ...nth(i), height: `${(skill as number) / 0.65 * 100}%` }}
                      />
                    </div>
                    <span className="font-mono text-[10px] text-gray-500">{label}</span>
                    <span className="font-mono text-[9px] text-gray-600">brier {brier}</span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-gray-400">
                Skill <span className="text-gray-200">rises as the window closes</span>.
                That is the signature of a model reading the price process rather than
                fitting noise: information accumulates and the posterior sharpens.
              </p>
            </Panel>
          </div>
        </Reveal>

        <Reveal i={1}>
          <div className="stagger mt-4 grid gap-4 md:grid-cols-3">
            {[
              ["No lookahead", "Volatility and level at each decision point use only ticks at or before that instant. All 900 cases assert it, and 120 are re-run against a physically truncated history so the assertion is not vacuous."],
              ["Prior only", "The headline layer is excluded, because a historical scout window cannot be reconstructed without leaking the future. This measures the price-process prior alone."],
              ["Edge is concentrated", "The 300s windows — where the bot actually trades — score +0.3865 over n=597. The long windows are thin and closer to a coin flip on small samples."],
            ].map(([t, d], i) => (
              <div key={t} style={nth(i)}>
                <Panel className="h-full">
                  <h3 className="text-[13px] font-semibold text-gray-100">{t}</h3>
                  <p className="mt-2 text-[12.5px] leading-relaxed text-gray-400">{d}</p>
                </Panel>
              </div>
            ))}
          </div>
        </Reveal>
      </Section>

      {/* ----------------------------------------------------------- mint-a-pair */}
      <Section
        id="mint"
        eyebrow="the mechanic"
        title="Mint-a-pair: making markets with zero inventory."
        lead="Of the four ways orders cross on a binary book, one needs no seller at all. It is the best thing about building on this venue and deserves more than a row in a table."
      >
        <Reveal>
          <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
            <Panel className="p-0">
              <div className="border-b border-ink-700 px-5 py-3">
                <h3 className="text-[13px] font-semibold text-gray-200">How orders cross</h3>
              </div>
              <table className="w-full text-[12.5px]">
                <tbody className="divide-y divide-ink-700/70">
                  {[
                    ["Buy YES × Sell YES", "direct", "tokens ↔ collateral", false],
                    ["Buy NO × Sell NO", "direct", "tokens ↔ collateral", false],
                    ["Buy YES × Buy NO", "mint-a-pair", "the pool mints a fresh pair — no seller needed", true],
                    ["Sell YES × Sell NO", "burn-a-pair", "both positions burn", false],
                  ].map(([pair, path, what, hero]) => (
                    <tr key={pair as string} className={hero ? "bg-model/[0.08]" : ""}>
                      <td className={`px-5 py-2.5 font-mono ${hero ? "font-bold text-model" : "text-gray-300"}`}>{pair}</td>
                      <td className={`px-3 py-2.5 font-mono text-[11px] ${hero ? "text-model/80" : "text-gray-600"}`}>{path}</td>
                      <td className="px-5 py-2.5 text-[11.5px] text-gray-500">{what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <div className="space-y-4">
              <Panel>
                <h3 className="text-[14px] font-semibold text-gray-100">Two resting buys are a complete quote</h3>
                <div className="formula mt-3 space-y-1.5 rounded border border-ink-700 bg-ink-950 p-3">
                  <div>BUY_YES @ <em>p − δ</em></div>
                  <div>BUY_NO&nbsp; @ <em>(1 − p) − δ</em></div>
                </div>
                <p className="mt-3 text-[13px] leading-relaxed text-gray-400">
                  Because two opposite-side buyers cross against each other, that pair
                  quotes both sides with <span className="text-gray-200">no inventory</span> and{" "}
                  <span className="text-gray-200">no counterparty maker</span>. A
                  conventional maker must hold what it sells. Vaticr never sells.
                </p>
              </Panel>
              <Panel>
                <h3 className="text-[14px] font-semibold text-gray-100">So the only risk is the imbalance</h3>
                <p className="mt-3 text-[13px] leading-relaxed text-gray-400">
                  Since it only buys, its position is complete sets plus a remainder. A
                  complete set redeems for exactly 1 collateral whatever the outcome —
                  riskless. The only exposure is the net YES-minus-NO imbalance, which
                  the inventory cap bounds directly.
                </p>
              </Panel>
            </div>
          </div>
        </Reveal>
      </Section>

      {/* ------------------------------------------------------------- findings */}
      <Section
        id="findings"
        eyebrow="what we measured"
        title="Two findings that changed the implementation."
        lead="Both were silent failures — the code runs, the orders fill, and the money quietly goes the wrong way. Both are written up in the SDK feedback report."
      >
        <Reveal>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel className="p-0">
              <div className="border-b border-ink-700 px-5 py-4">
                <h3 className="text-[14px] font-semibold text-gray-100">Settlement resolves against the EMA, not spot</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-gray-400">
                  The docs describe the reference only as &ldquo;a multi-source price
                  reference&rdquo;, which reads like spot. The feed publishes both. It
                  settles on <Mono>mark</Mono>.
                </p>
              </div>
              <div className="px-5 py-4">
                <p className="mb-3 font-mono text-[11px] text-gray-500">
                  close-vs-open over the eight most recent settlements
                </p>
                <div className="space-y-2">
                  {[["mark", 100, "8/8", "#34d399"], ["spot", 75, "6/8", "#fb7185"]].map(([k, w, v, c]) => (
                    <div key={k as string} className="flex items-center gap-3">
                      <span className="mono w-12 text-[12px] text-gray-400">{k}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded bg-ink-700">
                        <div className="h-full rounded" style={{ width: `${w}%`, background: c as string }} />
                      </div>
                      <span className="mono w-10 text-right text-[12px] font-bold" style={{ color: c as string }}>{v}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[12px] leading-relaxed text-gray-500">
                  The two disagreements are exactly the windows where the series drifted
                  apart in direction — the near-the-money ones, where the probability is
                  most sensitive and most worth trading.
                </p>
              </div>
            </Panel>

            <Panel className="p-0">
              <div className="border-b border-ink-700 px-5 py-4">
                <h3 className="text-[14px] font-semibold text-gray-100">Naive volatility reads four times too low</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-gray-400">
                  Because <Mono>mark</Mono> is an EMA sampled every second, consecutive
                  increments are heavily autocorrelated. The textbook estimator measures
                  the smoothing, not the process.
                </p>
              </div>
              <div className="overflow-x-auto px-5 py-4">
                <table className="w-full font-mono text-[11.5px]">
                  <thead>
                    <tr className="text-gray-600">
                      <th className="pb-1 text-left font-normal">step</th>
                      {["1s", "5s", "15s", "30s", "60s"].map((h) => (
                        <th key={h} className="pb-1 text-right font-normal">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="text-gray-400">
                    <tr>
                      <td className="py-0.5">mark</td>
                      {["0.079", "0.155", "0.234", "0.278", "0.264"].map((v, i) => (
                        <td key={v} className={`py-0.5 text-right ${i === 0 ? "font-bold text-down" : ""}`}>{v}</td>
                      ))}
                    </tr>
                    <tr>
                      <td className="py-0.5">spot</td>
                      {["0.248", "0.272", "0.298", "0.303", "0.274"].map((v) => (
                        <td key={v} className="py-0.5 text-right">{v}</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
                <p className="mt-3 text-[12px] leading-relaxed text-gray-500">
                  Ground truth from realised 300-second moves is ≈0.33. Fed into a
                  Gaussian model, 0.079 drives P(Up) to 0.0000 on windows that are
                  genuinely a coin flip — maximum confidence exactly where there is
                  least information.
                </p>
              </div>
            </Panel>
          </div>
        </Reveal>
      </Section>

      {/* ------------------------------------------------------------ run it */}
      <Section
        id="build"
        eyebrow="under the hood"
        title="Four subsystems, one command."
        lead="Python reads and models; TypeScript owns every write, because that is where the Bot Kit and markets-sdk own signing, nonces and escrow — and two senders on one key race each other."
      >
        <Reveal>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel className="p-0">
              <div className="border-b border-ink-700 px-5 py-3">
                <h3 className="text-[13px] font-semibold text-gray-200">Modules</h3>
              </div>
              <table className="w-full text-[12.5px]">
                <tbody className="divide-y divide-ink-700/70">
                  {[
                    ["agents/scout.py", "headlines → directional evidence"],
                    ["agents/pricing.py", "GBM prior + log-odds evidence"],
                    ["agents/resolver.py", "audit · Brier · backstops"],
                    ["agents/server.py", "FastAPI surface the bot polls"],
                    ["bot/src/runner.ts", "the trading loop"],
                    ["bot/src/strategy.ts", "take-vs-quote, mint-a-pair levels"],
                    ["VaticrForecastRegistry", "append-only commitments"],
                  ].map(([k, v]) => (
                    <tr key={k}>
                      <td className="px-5 py-2 font-mono text-gray-300">{k}</td>
                      <td className="px-5 py-2 text-right text-gray-500">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <div className="space-y-4">
              <Panel>
                <h3 className="text-[13px] font-semibold text-gray-200">Get it running</h3>
                <Code className="mt-3">{`git clone github.com/mrnetwork0001/Vaticr
cd Vaticr

npm install
python -m venv .venv && ./.venv/bin/pip install -r requirements.txt
cp .env.example .env

npm run bot:start   # brain + bot, one command`}</Code>
                <p className="mt-3 text-[12.5px] leading-relaxed text-gray-500">
                  Starts in <Mono>DRY_RUN</Mono>, logging every order it would place and
                  sending nothing.
                </p>
              </Panel>

              <Panel>
                <h3 className="text-[13px] font-semibold text-gray-200">Live on Somnia testnet</h3>
                <p className="mt-2 text-[12.5px] leading-relaxed text-gray-400">
                  The forecast registry is deployed, with a forecast committed on-chain
                  318 seconds before its window closed and a real order placed.
                </p>
                <a
                  href={`${EXPLORER}/address/${REGISTRY}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mono mt-3 block truncate rounded border border-ink-700 bg-ink-950 px-3 py-2 text-[11px] text-model hover:border-gray-600"
                >
                  {REGISTRY}
                </a>
              </Panel>
            </div>
          </div>
        </Reveal>

        <Reveal i={1}>
          <div className="stagger mt-4 flex flex-wrap gap-2">
            {["Somnia testnet 50312", "DreamDEX Event Contracts", "dreamDEX Bot Kit", "@somnia-chain/markets-sdk", "Solidity 0.8.24", "Next.js 14", "Python 3.11 · FastAPI", "wagmi + viem"].map((t, i) => (
              <span key={t} style={nth(i)} className="rounded border border-ink-700 bg-ink-900 px-3 py-1 font-mono text-[11px] text-gray-400">
                {t}
              </span>
            ))}
          </div>
        </Reveal>
      </Section>

      {/* ------------------------------------------------------------------ cta */}
      <section className="border-t border-ink-700/70 py-16">
        <div className="mx-auto max-w-page px-4 text-center sm:px-6">
          <Reveal>
            <h2 className="text-balance text-2xl font-bold tracking-tight text-gray-100 sm:text-3xl">
              See it pricing live windows right now.
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-[14.5px] leading-relaxed text-gray-400">
              Every live BTC and ETH window with its prior, its posterior and the book
              side by side — plus the headlines moving them, every settlement
              recomputed from the oracle, and a wallet that can trade the gap.
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <a href="/dashboard" className="rounded bg-model px-6 py-2.5 font-mono text-sm font-bold text-ink-950 transition hover:bg-model/90">
                Launch app →
              </a>
              <a href={GITHUB} target="_blank" rel="noreferrer" className="rounded border border-ink-700 px-6 py-2.5 font-mono text-sm text-gray-200 transition hover:border-gray-600 hover:bg-ink-800">
                View source
              </a>
            </div>
          </Reveal>
        </div>
      </section>

      <Footer />
    </div>
  );
}
