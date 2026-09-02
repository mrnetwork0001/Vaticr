/**
 * Tests for the decision layer.
 *
 * `decide()` and `skipReason()` are pure, and they are the last gate before
 * real money crosses a spread — every other module either reads the chain or
 * writes what these two returned. So the cases below are written as claims
 * about *money*, not about return shapes:
 *
 *   - crossing costs the touch, so the edge is measured against the touch;
 *   - a resting quote that reaches through the touch is a taker order wearing
 *     a maker's clothes, and pays the spread it was supposed to earn;
 *   - the only risk Vaticr carries is the net imbalance, so the inventory cap
 *     has to bind on the *taking* path too, not just on the quoting path.
 */

import { describe, expect, it } from "vitest";
import { decide, skipReason, type BookTop } from "./strategy.js";
import { loadVaticrConfig, type VaticrConfig } from "./config.js";

/** The shipped config, read once. */
const shipped = loadVaticrConfig();

/**
 * Fixture config: the shipped defaults with every field `decide()` reads pinned
 * to a literal.
 *
 * Spreading `shipped` rather than writing the object out means a new config
 * field cannot break this file, and pinning the four the strategy reads means
 * a retuned default cannot silently change what these cases assert. The
 * no-cross block below deliberately uses `shipped` itself instead.
 */
const base: VaticrConfig = {
  ...shipped,
  quoteSize: 5,
  halfSpread: 0.03,
  edgeThreshold: 0.05,
  maxNetInventory: 25,
  dryRun: true,
};

const cfg = (over: Partial<VaticrConfig> = {}): VaticrConfig => ({ ...base, ...over });

describe("decide() — taking YES", () => {
  it("lifts the ask when the posterior clears it by more than edgeThreshold", () => {
    const d = decide(0.6, { bestBid: 0.4, bestAsk: 0.5 }, 0, cfg());

    expect(d.action).toBe("take_yes");
    expect(d.edge).toBeCloseTo(0.1, 10);
    expect(d.takeSize).toBe(base.quoteSize);
    expect(d.reason).toContain("clears ask");
  });

  it("does not take when the edge over the ask is under edgeThreshold", () => {
    // 0.54 vs a 0.50 ask is 0.04 of edge — real, but it does not pay for the
    // half-spread on the way back out.
    const d = decide(0.54, { bestBid: 0.4, bestAsk: 0.5 }, 0, cfg());

    expect(d.action).toBe("quote");
  });

  it("does not take when the edge over the ask is exactly edgeThreshold", () => {
    // Binary-exact fractions so the boundary is the boundary, not a float
    // artefact: 0.5 - 0.25 is precisely 0.25, and the guard is strict `>`.
    const d = decide(0.5, { bestBid: 0.125, bestAsk: 0.25 }, 0, cfg({ edgeThreshold: 0.25 }));

    expect(d.action).toBe("quote");
  });
});

describe("decide() — taking NO", () => {
  it("hits the bid when it clears the posterior by more than edgeThreshold", () => {
    const d = decide(0.5, { bestBid: 0.6, bestAsk: 0.7 }, 0, cfg());

    expect(d.action).toBe("take_no");
    expect(d.edge).toBeCloseTo(0.1, 10);
    expect(d.takeSize).toBe(base.quoteSize);
    expect(d.reason).toContain("clears posterior");
  });

  it("does not take when the bid clears the posterior by less than edgeThreshold", () => {
    const d = decide(0.56, { bestBid: 0.6, bestAsk: 0.7 }, 0, cfg());

    expect(d.action).toBe("quote");
  });

  it("does not take when the bid clears the posterior by exactly edgeThreshold", () => {
    const d = decide(0.5, { bestBid: 0.75, bestAsk: 0.875 }, 0, cfg({ edgeThreshold: 0.25 }));

    expect(d.action).toBe("quote");
  });
});

describe("decide() — the pay-the-spread trap", () => {
  // The whole reason edgeThreshold is measured against the touch. On a wide
  // book the mid is a price nobody will trade with you at; an edge over it is
  // an edge over a fiction, and acting on it hands the spread to the maker.
  it("does not take YES on a posterior above the mid but below the ask", () => {
    const book: BookTop = { bestBid: 0.3, bestAsk: 0.7 };
    const posterior = 0.65; // mid 0.50 — a 0.15 "edge" that costs 0.05 to collect.

    const d = decide(posterior, book, 0, cfg());

    expect(d.action).not.toBe("take_yes");
    expect(d.action).toBe("quote");
  });

  it("does not take NO on a posterior below the mid but above the bid", () => {
    const book: BookTop = { bestBid: 0.3, bestAsk: 0.7 };

    const d = decide(0.35, book, 0, cfg());

    expect(d.action).not.toBe("take_no");
    expect(d.action).toBe("quote");
  });
});

describe("decide() — mint-a-pair quoting", () => {
  it("seeds both sides on an empty book", () => {
    // Cold start: no bid, no ask, no counterparty maker needed — two opposite
    // buys mint a fresh pair out of the pool.
    const d = decide(0.6, {}, 0, cfg());

    expect(d.action).toBe("quote");
    expect(d.yesBid).toBeDefined();
    expect(d.noBid).toBeDefined();
    expect(d.edge).toBe(0);
    expect(d.reason).toContain("empty book");
  });

  it.each([0.2, 0.5, 0.62, 0.8])(
    "keeps the two legs complementary at posterior %s",
    (posterior) => {
      const d = decide(posterior, {}, 0, cfg());

      // The pair costs yesBid + noBid and settles at exactly 1 whichever way
      // the window closes, so the captured spread is 1 - (yesBid + noBid).
      expect(d.yesBid! + d.noBid!).toBeCloseTo(1 - 2 * base.halfSpread, 10);
    },
  );

  it("keeps both legs inside the tradable band at an extreme posterior", () => {
    // 1 - 0.99 - halfSpread is negative; the derived price has to be clamped
    // rather than sent, or the venue rejects the whole cycle.
    const d = decide(0.99, {}, 0, cfg());

    expect(d.yesBid!).toBeGreaterThanOrEqual(0.01);
    expect(d.yesBid!).toBeLessThanOrEqual(0.99);
    expect(d.noBid!).toBeGreaterThanOrEqual(0.01);
    expect(d.noBid!).toBeLessThanOrEqual(0.99);
  });
});

describe("decide() — inventory caps", () => {
  it("quotes only the NO leg past +maxNetInventory", () => {
    const d = decide(0.5, { bestBid: 0.45, bestAsk: 0.55 }, 26, cfg());

    expect(d.action).toBe("quote");
    expect(d.yesBid).toBeUndefined();
    expect(d.noBid).toBeDefined();
  });

  it("quotes only the YES leg past -maxNetInventory", () => {
    const d = decide(0.5, { bestBid: 0.45, bestAsk: 0.55 }, -26, cfg());

    expect(d.action).toBe("quote");
    expect(d.yesBid).toBeDefined();
    expect(d.noBid).toBeUndefined();
  });

  it("binds at exactly the cap, not one share past it", () => {
    expect(decide(0.5, {}, 25, cfg()).yesBid).toBeUndefined();
    expect(decide(0.5, {}, -25, cfg()).noBid).toBeUndefined();
  });

  it("blocks taking YES while long-capped, however large the edge", () => {
    // A 0.60 edge over the ask, and it still must not add to the imbalance:
    // the cap is the only thing standing between this bot and directional risk.
    const d = decide(0.9, { bestBid: 0.2, bestAsk: 0.3 }, 26, cfg());

    expect(d.action).toBe("quote");
    expect(d.yesBid).toBeUndefined();
  });

  it("blocks taking NO while short-capped, however large the edge", () => {
    const d = decide(0.1, { bestBid: 0.9, bestAsk: 0.95 }, -26, cfg());

    expect(d.action).toBe("quote");
    expect(d.noBid).toBeUndefined();
  });

  it("skips when both legs are capped", () => {
    // maxNetInventory 0 caps in both directions at once — the degenerate
    // "hold nothing" configuration, which must produce no orders at all.
    const d = decide(0.6, { bestBid: 0.2, bestAsk: 0.3 }, 0, cfg({ maxNetInventory: 0 }));

    expect(d.action).toBe("skip");
    expect(d.edge).toBe(0);
    expect(d.reason).toContain("inventory capped");
  });
});

describe("decide() — a resting quote must not reach through the touch", () => {
  // A post-only buy at or above the ask is not a maker order: it is rejected
  // (PostOnlyWouldCross) or filled as a taker, paying the spread the quote
  // exists to earn. Both legs land on the one YES book — BUY_NO at n is the
  // same resting order as a YES ask at 1 - n — so the quote the venue sees is
  // bid p - halfSpread / ask p + halfSpread, and it crosses whenever the
  // posterior sits further than halfSpread from a touch. Since the taking
  // branch only fires past edgeThreshold, every posterior in
  // halfSpread <= |p - touch| <= edgeThreshold is a cycle that neither takes
  // nor rests. These assert the outcome, not any one way of reaching it.

  it("rests the YES bid strictly below the ask", () => {
    const book: BookTop = { bestBid: 0.4, bestAsk: 0.5 };
    const d = decide(0.54, book, 0, shipped); // 0.04 of edge — quotes, does not take.

    expect(d.action).toBe("quote");
    expect(d.yesBid!).toBeLessThan(book.bestAsk!);
  });

  it("rests the NO bid strictly above the bid, in YES terms", () => {
    // Buying NO at noBid is offering YES at 1 - noBid; that offer has to sit
    // above the standing bid or it lifts it.
    const book: BookTop = { bestBid: 0.6, bestAsk: 0.7 };
    const d = decide(0.56, book, 0, shipped); // 0.04 of edge — quotes, does not take.

    expect(d.action).toBe("quote");
    expect(1 - d.noBid!).toBeGreaterThan(book.bestBid!);
  });

  it.each([
    { label: "a 0.10-wide book", bestBid: 0.4, bestAsk: 0.5 },
    { label: "a 0.01-wide book", bestBid: 0.495, bestAsk: 0.505 },
  ])("rests behind both touches across the whole band on $label", ({ bestBid, bestAsk }) => {
    const book: BookTop = { bestBid, bestAsk };
    let quoted = 0;

    // Step across the dead band and well past it on both sides. Every posterior
    // that does not take must produce a quote the venue would actually accept.
    for (let p = bestBid - 0.1; p <= bestAsk + 0.1; p += 0.005) {
      const d = decide(p, book, 0, shipped);
      if (d.action !== "quote") continue;
      quoted++;
      expect(d.yesBid!, `YES leg at posterior ${p.toFixed(3)}`).toBeLessThan(bestAsk);
      expect(1 - d.noBid!, `NO leg at posterior ${p.toFixed(3)}`).toBeGreaterThan(bestBid);
    }

    expect(quoted).toBeGreaterThan(0);
  });
});

describe("decide() — where an IOC is priced", () => {
  // A taking order priced at exactly the touch no-fills the moment the book
  // moves a tick between read and send, so it is priced through. The cap is
  // what makes that safe: a fill above fair value loses by construction, so
  // the buffer may eat the edge but must never invert it.
  it("prices through the ask by the buffer when taking YES", () => {
    const d = decide(0.6, { bestBid: 0.4, bestAsk: 0.5 }, 0, cfg({ takeBuffer: 0.005 }));

    expect(d.action).toBe("take_yes");
    expect(d.takePrice).toBeCloseTo(0.505, 10);
  });

  it("prices through the bid by the buffer when taking NO, in NO terms", () => {
    // Hitting a 0.60 YES bid is buying NO at 0.40; NO's own fair value is 0.50.
    const d = decide(0.5, { bestBid: 0.6, bestAsk: 0.7 }, 0, cfg({ takeBuffer: 0.005 }));

    expect(d.action).toBe("take_no");
    expect(d.takePrice).toBeCloseTo(0.405, 10);
  });

  it("never prices an IOC past fair value, however large the buffer", () => {
    const yes = decide(0.6, { bestBid: 0.4, bestAsk: 0.5 }, 0, cfg({ takeBuffer: 0.5 }));
    expect(yes.action).toBe("take_yes");
    expect(yes.takePrice!).toBeLessThanOrEqual(0.6);

    const no = decide(0.5, { bestBid: 0.6, bestAsk: 0.7 }, 0, cfg({ takeBuffer: 0.5 }));
    expect(no.action).toBe("take_no");
    expect(no.takePrice!).toBeLessThanOrEqual(0.5); // NO fair value is 1 - 0.5.
  });
});

describe("skipReason()", () => {
  it("skips a degraded forecast", () => {
    expect(skipReason(0.5, 600, 60, true)).toBe("degraded forecast");
  });

  it("skips a degraded forecast even when everything else is fine", () => {
    // Degradation is checked first on purpose: a stale posterior is worse than
    // a thin window, because it looks tradable.
    expect(skipReason(0.5, 5, 60, true)).toBe("degraded forecast");
  });

  it("skips when there is not enough headroom left in the window", () => {
    const reason = skipReason(0.5, 20, 60, false);

    expect(reason).toContain("20s left");
    expect(reason).toContain("60s");
  });

  it("skips a posterior pinned at either bound", () => {
    expect(skipReason(0.01, 600, 60, false)).toContain("pinned");
    expect(skipReason(0.99, 600, 60, false)).toContain("pinned");
    // Inclusive: 0.02 and 0.98 are already decided as far as the book cares.
    expect(skipReason(0.02, 600, 60, false)).toContain("pinned");
    expect(skipReason(0.98, 600, 60, false)).toContain("pinned");
  });

  it("proceeds on a live, unpinned, healthy forecast", () => {
    expect(skipReason(0.5, 600, 60, false)).toBeNull();
    expect(skipReason(0.03, 600, 60, false)).toBeNull();
    expect(skipReason(0.97, 600, 60, false)).toBeNull();
  });
});
