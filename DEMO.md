# Vaticr — demo video runbook

A 2–3 minute walkthrough is a required submission deliverable. This is the shot
list: exact commands in order, what is on screen, and what to say over it.

**Total budget: 2:45.** Every second of dead air is a second not spent on the
audit, which is the part nobody else will have.

---

## Before you hit record

Do all of this *first*. None of it should be on camera.

```bash
cd path/to/Vaticr

# 1. Everything installed, tests green.
npm install
./.venv/bin/pip install -r requirements.txt
npm test                       # expect: 17 tests passed  ·  7 passing

# 2. Pick a free API port and pin it. 8787 is the default; if anything else on
#    the machine already holds it, use 8799 and set BOTH of these in .env.
lsof -i :8787 || echo "8787 free"
#   .env:  VATICR_API_PORT=8799
#          VATICR_API_URL=http://127.0.0.1:8799

# 3. Confirm the venue is live *today*. Venue ids move; a dead venue is the one
#    failure mode that kills a recording.
npm run doctor                 # want: live markets listed, forecasts returned

# 4. Warm the caches so nothing stalls on camera: the first /forecasts call
#    fetches 40 minutes of tick history per asset.
curl -s -X POST http://127.0.0.1:8799/scan
curl -s "http://127.0.0.1:8799/forecasts?limit=6" > /dev/null

# 5. Have settled history to audit. If the audit table comes back short, wait
#    for a few 300s windows to close and re-run:
./.venv/bin/python -m agents.resolver --limit 12
```

Terminal set-up: **one window, large font (16pt+), dark theme, ~100 columns.**
Two tabs — `bot` and `agents`. Browser at `http://localhost:3000/dashboard`,
already loaded, with `npm run dev` running in a third tab you never show.

Recording: 1080p minimum, screen only, no webcam needed. Talk over it live — a
scripted voiceover cut against footage is more work and reads as less honest.

---

## Shot 1 — the claim (0:00 – 0:20)

**On screen:** the landing page at `http://localhost:3000`.

**Say:**
> "A DreamDEX Event Contract asks one question: will this window close at or
> above the price it opened at? So the fair value of a YES token is a
> probability — and a probability can be derived instead of guessed. Vaticr
> derives it, trades it, and then proves whether it was any good."

Do not narrate the pivot here. It goes in shot 5, where it has evidence behind
it.

---

## Shot 2 — one command (0:20 – 0:50)

**Run, on camera:**

```bash
npm run bot:start
```

**On screen:** the launcher starting the Python layer, `waiting for the
scout....`, then the first trading cycle.

**Say, while it comes up:**
> "One command. It starts the Python intelligence layer, waits for the first
> news scan, then hands over to the bot — which is dry run by default, so it
> logs every order it would send and sends nothing."

**Then let a full cycle print and read one line out loud.** Point the cursor at
it:

```
BTC-0-01SEP26-0630/tUSDC book=[0.096/0.118] prior=0.186 post=0.186 news=-0.003(2) net=0.0 -> take_yes
   posterior 0.186 clears ask 0.118 by 0.068
```

> "Prior from the price process — where this window sits against its own open,
> given time left and measured volatility. Posterior after the news evidence.
> The book is asking 0.118, we think it is worth 0.186, so that clears the
> touch and it takes. Note *touch*, not mid — paying the spread is how a bot
> with real edge still loses money."

If the cycle shows a `quote` instead, take that line — it is the better story:

> "No takeable edge, so it rests a two-sided quote instead: buy YES below fair,
> buy NO below its fair. On this venue two opposite-side buyers mint a fresh
> pair, so that is a complete two-sided market with **zero inventory** and no
> counterparty maker. It is the single best thing about building here."

---

## Shot 3 — the dashboard (0:50 – 1:20)

**On screen:** switch to the browser, `http://localhost:3000/dashboard`.

**Say, scrolling once, slowly:**
> "Same data, live. Every live window with its prior, its posterior, and the
> headlines that moved it — each headline scored for direction, how
> market-moving it is at all, and source credibility. When there is no news the
> posterior sits on the prior, which is the honest answer: genuinely fresh
> market-moving crypto headlines are rare, so the price process carries most of
> the weight and news is a tilt on top."

Hover one headline so its contribution is visible. Do not read the whole list.

---

## Shot 4 — the measurement nobody documents (1:20 – 1:45)

**On screen:** open `docs/SDK_FEEDBACK.md` in the editor, scroll to §3 and §5.

**Say:**
> "Two findings that decide whether any of this works. Settlement resolves
> against `mark` — the EMA — not spot. That is undocumented; we measured it,
> eight out of eight versus six out of eight, and the two disagreements were
> exactly the near-the-money windows most worth trading. And because `mark` is
> an EMA at one-second resolution, differencing it naively reads volatility
> about four times too low, which drives priors to 0.0000 — maximum confidence
> exactly where there is least information. So Vaticr takes the *level* from
> `mark` and the *volatility* from `spot`, resampled to thirty seconds."

Keep this to twenty-five seconds. Show the table in §5; do not read it.

---

## Shot 5 — the part nobody else has (1:45 – 2:30)

**Run, on camera, in the `agents` tab:**

```bash
./.venv/bin/python -m agents.resolver --limit 8
```

**On screen:** the audit table, then the backstops and calibration blocks.

**Say:**
> "And then it checks its own homework. Every settled window is recomputed
> independently from the public oracle feed and compared to what the chain
> actually paid out."

Point at an `inconclusive` row:

> "This row matters. The oracle settles on its own sampled tick; we recover the
> reference by timestamp, and on a window that closed five thousandths of a
> percent from its open those can disagree. Rather than call that a failed
> settlement, the audit reports it as inconclusive — our resolution ran out, the
> chain is not wrong. Anything above one basis point is a real mismatch and gets
> reported as one. Over twenty settlements there were zero genuine mismatches."

Then the calibration block:

> "And every forecast is committed *before* its window closes, then Brier-scored
> once the oracle speaks. A coin flip scores 0.25. That is the only way to know
> whether a forecasting bot is a forecaster or a random number generator — and
> it is why the commitments also go on-chain, append-only, no owner, no
> revisions. An agent that could edit its own history would prove nothing by
> having one."

---

## Shot 6 — close (2:30 – 2:45)

**On screen:** back to the terminal, run:

```bash
npm test
```

**Say, over the output:**
> "One hundred and fourteen tests across the engine, the news scorer, the store, the resolver and the strategy, including Monte-Carlo recovery of a
> known volatility, including seven on the registry. Built on the official DreamDEX
> Bot Kit, vendored verbatim. Apache-2.0. Thanks for watching."

End on the passing output. No outro card, no music.

---

## Things that will bite you

| | |
|---|---|
| **A dead venue.** | Venue ids move — they changed three times in one week. Run `npm run doctor` immediately before recording, not the night before. |
| **A cold cache.** | The first `/forecasts` call fetches ~40 minutes of ticks per asset and can take seconds. Warm it (step 4 above). |
| **An empty audit.** | `--limit 8` on a venue with nothing recently settled prints an empty table. Check it before you record; wait for windows to close if needed. |
| **Port 8787 taken.** | Set `VATICR_API_PORT` **and** `VATICR_API_URL` together, or the bot and the dashboard look at different places. |
| **Leaking a key.** | Record in dry run. `DRY_RUN=true` is the default; do not put a real `PRIVATE_KEY` in `.env` for this, and do not open `.env` on camera. |
| **Live headlines.** | The feeds are real. Glance at the dashboard before recording so a headline on screen is not something you would rather not narrate. |

## What to submit alongside it

The checklist lives at the bottom of
[VATICR_PROJECT_SPEC.md](VATICR_PROJECT_SPEC.md). Two items must be closed
registry (`npm run deploy:registry`) if you want shot 5's on-chain-commitment
claim to point at a real address.
