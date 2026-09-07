# Vaticr - demo video script

**Target 2:45 at ~150 wpm. 1920x1080, 30fps.**

`[MG]` = motion graphic, built and rendered here.
`[SCR]` = screen recording (yours).
`[CAP]` = headless capture of the live site (mine).

---

## 1. The claim  ·  0:00 - 0:18

> `[MG]` Black. The question types itself: **"Will ETH close above where it opened?"**
> Then, beneath it, a probability bar fills to 89%.

**VO:**
"Every DreamDEX event contract asks one question. Will this window close at or
above the price it opened at? That makes the fair value of a YES token a real
probability - not an opinion. It can be derived."

---

## 2. Nobody derives it  ·  0:18 - 0:38

> `[MG]` Two markers on one probability axis. Indigo slides to 0.899 labelled
> MODEL. Amber sits at 0.889 labelled BOOK. The gap between them shades in.

**VO:**
"But the book is quoted by people eyeballing a chart. And when a window settles,
nobody can tell whether a quote was skilful or lucky - because nothing was
written down beforehand. Every track record in prediction markets is a claim
made after the fact. Vaticr fixes both halves."

---

## 3. What it does  ·  0:38 - 1:05

> `[CAP]` Landing page, slow scroll through the hero and "how it works".

**VO:**
"It derives the probability from the price process - a closed-form barrier
calculation using time remaining and volatility measured live. It tilts that
with scored news, folded in as log-odds so evidence compounds without any one
headline running the number to certainty. Then it trades the gap, and commits
every forecast on-chain before the window settles."

---

## 4. A real trade  ·  1:05 - 1:35

> `[SCR]` Your recording: empty wallet, gas, mint tUSDC, open the ticket, trade.

**VO:**
"Here it is live. A new wallet needs test collateral, and the app mints it in
one click. Then the ticket shows both numbers side by side: the model says
eighty-nine point nine, the book asks eighty-eight point nine. One cent of edge
per share. Take it, and the fill confirms on-chain in about a second."

---

## 5. Zero inventory  ·  1:35 - 2:00

> `[MG]` The crossing matrix. Buy YES x Buy NO highlights: "the pool mints a
> fresh pair - no seller needed". Then two bids appear at p-δ and (1-p)-δ and
> their sum resolves to 0.940.

**VO:**
"The agent quotes both sides at once. On a binary book, buying YES and buying NO
needs no seller - the pool mints a fresh pair. So two resting bids are a
complete two-sided market, made with no inventory and no counterparty maker.
That is what lets one small agent quote every live window."

---

## 6. It runs  ·  2:00 - 2:15

> `[SCR or CAP]` The bot's journal, live. Lines land: posterior, book, decision,
> resting order ids.

**VO:**
"This is the agent on a live book right now - reading the top, deriving the
posterior, and resting a pair of quotes around it. Those orders are getting
filled by real counterparties."

---

## 7. Is it any good  ·  2:15 - 2:38

> `[MG]` Reliability diagram draws itself against the diagonal, then the numbers
> count up: Brier 0.15522, skill +0.3791, accuracy 76.22%.

**VO:**
"And it is measurably right. Nine hundred forecasts over three hundred settled
windows the model never saw: a Brier score of zero point one-five-five against a
coin flip's zero point two-five. Skill, plus zero point three-seven-nine. The
harness is lookahead-free and the evidence file is in the repository - so you can
recompute it rather than trust it."

---

## 8. Proof and close  ·  2:38 - 2:55

> `[CAP]` Audit view: settlements recomputed, every row "match". Cut to the
> registry on the explorer. `[MG]` End card: usevaticr.xyz.

**VO:**
"Every settled window is recomputed from the public oracle feed and checked
against the chain. And a forecast committed three hundred and eighteen seconds
before its window expired is still there, unchanged, because that is the point.
Vaticr. Price the window, trade the gap, prove the record."

---

## Word count

About 400 words - 2:40 to 2:50 at a natural pace. Trim section 3 first if long.

## Notes for the recording

- Record at 1920x1080. Hide bookmarks, notifications, and any other tab.
- Fresh wallet, no prior Somnia history, so the onboarding panel shows.
- Do the whole flow in one take; we cut later. Do not narrate.
- Move deliberately. Pauses cut cleanly; hesitation does not.
- The moments that must be on screen: the onboarding panel, the mint
  confirmation, the ticket showing model vs book, and the fill confirmation.
