"use client";

import { Card, PanelState, Pill } from "./ui";
import type { Calibration } from "./types";

/**
 * The proof-of-skill panel.
 *
 * A Brier score is the whole argument this project makes: a forecast that
 * cannot beat 0.25 is a coin flip with extra steps. It is also the number most
 * easily oversold, so this panel is built to make the sample size impossible to
 * miss - the headline figure and the reason not to believe it yet sit in the
 * same block of text.
 *
 * The threshold below is not a convention borrowed from anywhere; it comes out
 * of the arithmetic in `noiseBound`. Below roughly thirty scored windows the
 * uncertainty on the mean Brier is wider than any edge a good model would show
 * over the baseline, so the comparison cannot resolve either way.
 */
const MIN_MEANINGFUL_SAMPLE = 30;

/**
 * A conservative one-standard-error bound on the mean Brier score.
 *
 * Individual Brier scores are bounded in [0, 1], and a variable on [0, 1] has
 * standard deviation at most 0.5, so the standard error of the mean is at most
 * 0.5/sqrt(n) whatever the distribution turns out to be. It is a bound rather
 * than an estimate - the per-window scores are not exposed by /calibration -
 * which is the right direction to err when the number is being used to argue
 * that a model has edge.
 */
function noiseBound(n: number): number {
  return 0.5 / Math.sqrt(n);
}

function Stat({
  label, value, hint, tone = "plain",
}: {
  label: string; value: string; hint?: string; tone?: "plain" | "good" | "muted";
}) {
  const colour =
    tone === "good" ? "text-up" : tone === "muted" ? "text-slate-300" : "text-white";
  return (
    <div className="rounded-lg border border-white/10 bg-ink-950/50 px-3.5 py-3">
      <div className={`mono text-lg font-semibold ${colour}`}>{value}</div>
      <div className="mt-0.5 text-[11.5px] font-medium text-slate-300">{label}</div>
      {hint && <div className="text-[11px] leading-tight text-slate-400">{hint}</div>}
    </div>
  );
}

/**
 * The reliability diagram: forecast probability against how often those windows
 * actually closed up.
 *
 * Position carries the meaning, not colour - every point is also labelled with
 * its bucket and count, and the same numbers are repeated in the table below,
 * which is what a screen reader gets.
 */
function Reliability({ cal }: { cal: Calibration }) {
  const P = 176; // plot edge, in viewBox units
  const M = 30; // margin for the axis labels
  const x = (p: number) => M + p * P;
  const y = (p: number) => M + (1 - p) * P;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  const summary = cal.buckets
    .map(
      (b) =>
        `forecast ${(b.mean_forecast * 100).toFixed(0)} percent, observed ` +
        `${(b.observed_up_rate * 100).toFixed(0)} percent, from ${b.count} window` +
        `${b.count === 1 ? "" : "s"}`,
    )
    .join("; ");

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
      <svg
        viewBox={`0 0 ${P + M * 2} ${P + M * 2}`}
        className="w-full max-w-[15rem] shrink-0"
        role="img"
        aria-label={
          `Reliability diagram. Points on the diagonal are perfectly calibrated. ` +
          (summary || "No buckets to plot.")
        }
      >
        <rect
          x={M} y={M} width={P} height={P}
          fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.12)"
        />
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={x(t)} y1={M} x2={x(t)} y2={M + P}
              stroke="rgba(255,255,255,0.06)"
            />
            <line
              x1={M} y1={y(t)} x2={M + P} y2={y(t)}
              stroke="rgba(255,255,255,0.06)"
            />
            <text
              x={x(t)} y={M + P + 14} textAnchor="middle"
              fill="#94a3b8" fontSize="9" fontFamily="ui-monospace, monospace"
            >
              {t}
            </text>
            <text
              x={M - 6} y={y(t) + 3} textAnchor="end"
              fill="#94a3b8" fontSize="9" fontFamily="ui-monospace, monospace"
            >
              {t}
            </text>
          </g>
        ))}
        {/* Perfect calibration is the diagonal; distance from it is the error. */}
        <line
          x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)}
          stroke="#94a3b8" strokeWidth="1" strokeDasharray="4 3"
        />
        {cal.buckets.map((b) => {
          const r = 3 + Math.sqrt(b.count) * 1.6;
          return (
            <g key={b.range}>
              <line
                x1={x(b.mean_forecast)} y1={y(b.mean_forecast)}
                x2={x(b.mean_forecast)} y2={y(b.observed_up_rate)}
                stroke="rgba(129,140,248,0.45)" strokeWidth="1"
              />
              <circle
                cx={x(b.mean_forecast)} cy={y(b.observed_up_rate)} r={r}
                fill="rgba(129,140,248,0.35)" stroke="#818cf8" strokeWidth="1.5"
              />
              <text
                x={x(b.mean_forecast) + r + 4} y={y(b.observed_up_rate) + 3}
                fill="#cbd5e1" fontSize="9" fontFamily="ui-monospace, monospace"
              >
                n={b.count}
              </text>
            </g>
          );
        })}
        <text
          x={M + P / 2} y={P + M * 2 - 6} textAnchor="middle"
          fill="#94a3b8" fontSize="9"
        >
          forecast probability
        </text>
        <text
          x={10} y={M + P / 2} textAnchor="middle" fontSize="9" fill="#94a3b8"
          transform={`rotate(-90 10 ${M + P / 2})`}
        >
          observed up rate
        </text>
      </svg>

      <div className="min-w-0 flex-1">
        <table className="w-full text-left text-[11.5px]">
          <caption className="sr-only">
            Reliability by forecast bucket: mean forecast against the observed
            rate of upward closes.
          </caption>
          <thead className="text-slate-300">
            <tr className="border-b border-white/10">
              <th scope="col" className="py-1.5 pr-3 font-medium">Bucket</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">n</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Mean forecast</th>
              <th scope="col" className="py-1.5 font-medium">Observed up</th>
            </tr>
          </thead>
          <tbody className="mono divide-y divide-white/5 text-slate-300">
            {cal.buckets.map((b) => (
              <tr key={b.range}>
                <td className="py-1.5 pr-3">{b.range}</td>
                <td className="py-1.5 pr-3">{b.count}</td>
                <td className="py-1.5 pr-3">{(b.mean_forecast * 100).toFixed(1)}%</td>
                <td className="py-1.5">{(b.observed_up_rate * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-[11.5px] leading-relaxed text-slate-400">
          A perfectly calibrated forecaster lands on the dashed diagonal: the
          windows it called 70% close up 70% of the time. With one or two
          windows per bucket the observed rate can only be 0% or 100%, so points
          sitting at the corners are arithmetic, not miscalibration.
        </p>
      </div>
    </div>
  );
}

export default function CalibrationPanel({
  cal, state, detail,
}: {
  cal: Calibration | null;
  state: "loading" | "ready" | "error";
  detail?: string;
}) {
  const n = cal?.scored ?? 0;
  const thin = n < MIN_MEANINGFUL_SAMPLE;
  const bound = n > 0 ? noiseBound(n) : null;

  return (
    <Card
      id="calibration"
      title="Calibration - is any of this actually skill?"
      subtitle="Every forecast committed before its window closed, then Brier-scored against the settlement"
      right={
        cal && (
          <Pill tone={thin ? "warn" : "up"}>
            n = {n} scored
          </Pill>
        )
      }
    >
      {state === "loading" && <PanelState state="loading" />}
      {state === "error" && (
        <PanelState state="error">
          Calibration unavailable - {detail ?? "the scorer did not answer."}
        </PanelState>
      )}

      {state === "ready" && cal && (
        <div className="px-4 py-4">
          {/* The honesty notice comes FIRST, above the numbers it qualifies.
              Putting it underneath would let a reader take the Brier score at
              face value and stop reading. */}
          {thin && (
            <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/[0.07] px-4 py-3">
              <p className="text-[13px] font-semibold text-amber-300">
                {n === 0
                  ? "Nothing has been scored yet."
                  : `${n} scored window${n === 1 ? "" : "s"} - far too few to conclude anything.`}
              </p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-300">
                {n === 0 ? (
                  <>
                    {cal.pending} forecast{cal.pending === 1 ? " is" : "s are"} committed and
                    waiting on settlement. Until windows resolve there is no track record
                    here, only the machinery that will keep one.
                  </>
                ) : (
                  <>
                    Brier scores are bounded in [0,&nbsp;1], so the standard error of this
                    mean is at most{" "}
                    <span className="mono text-slate-100">
                      0.5/&radic;{n} = ±{bound!.toFixed(2)}
                    </span>
                    . The gap to the 0.25 coin-flip baseline is{" "}
                    <span className="mono text-slate-100">
                      {cal.brier_score === null
                        ? "-"
                        : Math.abs(0.25 - cal.brier_score).toFixed(3)}
                    </span>
                    , which is well inside that noise. This panel is evidence that the
                    scoring loop runs end to end, and nothing more. Roughly{" "}
                    {MIN_MEANINGFUL_SAMPLE} scored windows is where the comparison starts
                    to mean anything.
                  </>
                )}
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
            <Stat
              label="Brier score"
              value={cal.brier_score === null ? "-" : cal.brier_score.toFixed(3)}
              hint="lower is better"
              tone={thin ? "muted" : "good"}
            />
            <Stat
              label="Coin-flip baseline"
              value={cal.baseline_brier.toFixed(2)}
              hint="what 50/50 scores"
              tone="muted"
            />
            <Stat
              label="Skill"
              value={cal.skill === null ? "-" : `${(cal.skill * 100).toFixed(1)}%`}
              hint="1 − brier/0.25"
              tone={thin || (cal.skill ?? 0) <= 0 ? "muted" : "good"}
            />
            <Stat
              label="Directional accuracy"
              value={cal.accuracy === null ? "-" : `${(cal.accuracy * 100).toFixed(0)}%`}
              hint={`over ${n} window${n === 1 ? "" : "s"}`}
              tone="muted"
            />
            <Stat
              label="Pending / voided"
              value={`${cal.pending} / ${cal.voided}`}
              hint="committed, not yet scored"
              tone="muted"
            />
          </div>

          {cal.buckets.length > 0 ? (
            <div className="mt-5 border-t border-white/10 pt-5">
              <h3 className="text-[12.5px] font-semibold text-slate-100">
                Reliability diagram
              </h3>
              <p className="mb-4 mt-0.5 text-[11.5px] text-slate-400">
                Mean forecast against the observed up rate, by bucket.
              </p>
              <Reliability cal={cal} />
            </div>
          ) : (
            <p className="mt-4 border-t border-white/10 pt-4 text-[12px] text-slate-400">
              A reliability diagram needs scored windows to bucket. It appears
              here as soon as the first forecast settles.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
