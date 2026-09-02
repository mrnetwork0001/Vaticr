/**
 * The spend rail.
 *
 * Every other bound in this bot is a bound on RISK, not on spend:
 * `maxNetInventory` caps the imbalance carried on one market, `edgeThreshold`
 * caps what a fill is worth paying, `maxMarkets` caps breadth. None of them
 * caps the total. A pinned posterior or a fat-fingered `VATICR_QUOTE_SIZE`
 * works through the whole wallet one perfectly reasonable-looking order at a
 * time, and every individual check passes on the way.
 *
 * So: one number, checked immediately before every write that escrows
 * collateral, for the life of the process.
 *
 * WHAT THE NUMBER IS
 *
 *   committed = settled + outstanding
 *
 * `outstanding` is escrow the venue is holding for orders believed to be
 * resting; `settled` is notional that filled and is not coming back. A buy
 * escrows `price x size` in the leg's OWN price (vendor/ec-core `assertFunded`)
 * and a cancelled order refunds it, so escrow has to be released on cancel —
 * which is why the runner tells this class when it pulls a market's quotes.
 *
 * Counting gross sends and never releasing was the first thing tried and it is
 * wrong, not merely conservative: this loop cancels and re-posts every market
 * every cycle, so 8 markets x 2 legs x 5 shares re-books roughly 40 collateral
 * every 8 seconds. Any cap small enough to be a rail would stop the bot inside
 * two cycles no matter how much of it was refunded a moment later, and a rail
 * that always fires is a rail nobody keeps switched on.
 *
 * THE KNOWN LEAK, stated rather than papered over: a resting quote that fills
 * BETWEEN cycles is invisible here — the fill is reported only for what filled
 * at send time — so its escrow is released as if it had been cancelled. That
 * understates `settled` by at most one cycle's resting size per market, and
 * the position it leaves behind is the thing `maxNetInventory` bounds. This
 * class is a spend ceiling, not an accounting ledger.
 */

const notionalOf = (price: number, size: number): number =>
  Math.max(0, price) * Math.max(0, size);

export class NotionalBudget {
  /** Notional that filled and is not coming back. */
  private settledNotional = 0;
  /** Escrow believed to be held per market key, refundable on cancel. */
  private readonly escrow = new Map<string, number>();
  private refusals = 0;

  constructor(readonly cap: number) {}

  /** What a buy of `size` shares at `price` escrows, in collateral. */
  static costOf(price: number, size: number): number {
    return notionalOf(price, size);
  }

  /** Filled notional plus escrow still held — the number the cap bounds. */
  get committed(): number {
    let open = 0;
    for (const v of this.escrow.values()) open += v;
    return this.settledNotional + open;
  }

  get settled(): number {
    return this.settledNotional;
  }

  get outstanding(): number {
    return this.committed - this.settledNotional;
  }

  /** What is left before the rail bites. */
  get remaining(): number {
    return Math.max(0, this.cap - this.committed);
  }

  /** How many writes the rail has refused this run. */
  get refused(): number {
    return this.refusals;
  }

  /**
   * Book the escrow for an order that is about to be sent. Returns false —
   * having charged nothing — when it would breach the cap, and the caller must
   * then skip the write rather than shrink it: half a two-sided quote is a
   * one-sided quote, which is a different strategy.
   */
  reserve(key: string, price: number, size: number): boolean {
    const cost = notionalOf(price, size);
    if (this.committed + cost > this.cap) {
      this.refusals++;
      return false;
    }
    this.escrow.set(key, (this.escrow.get(key) ?? 0) + cost);
    return true;
  }

  /** Escrow returned: a reverted write, or an IOC's unfilled remainder. */
  release(key: string, price: number, size: number): void {
    this.take(key, notionalOf(price, size));
  }

  /** Every order on this market has been cancelled — its escrow is back. */
  releaseMarket(key: string): void {
    this.escrow.delete(key);
  }

  /** Escrow that turned into a position: it stops being refundable. */
  recordFill(key: string, price: number, filled: number): void {
    const cost = notionalOf(price, filled);
    if (cost <= 0) return;
    this.take(key, cost);
    this.settledNotional += cost;
  }

  private take(key: string, amount: number): void {
    const held = this.escrow.get(key) ?? 0;
    const left = held - amount;
    if (left > 0) this.escrow.set(key, left);
    else this.escrow.delete(key);
  }
}
