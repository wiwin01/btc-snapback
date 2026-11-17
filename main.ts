// Variant B: z-score snap-back scalper for cbBTC, long only, one position at a time.
//
// Idea (mean reversion, kept deliberately different from the kit's RSI/Bollinger house
// baseline): watch the last WINDOW one-minute closes. When the newest close sits far
// below that window's own mean in standard-deviation units (a z-score stretch), the
// move is treated as a short-term extreme rather than news, and the bot buys a fixed
// slice of equity expecting the price to snap back toward the mean. The exit is the
// trade: leave when the price has reverted to (about) the mean, take a hard profit a
// little past it, cut the loss if the stretch keeps stretching, and never hold longer
// than MAX_HOLD bars, because a reversion that has not happened within the hour is
// probably a trend instead.
//
// References behind the knobs:
//   - Bollinger-band snap-back: buy the tag of the lower band, sell at the middle band
//     (John Bollinger's classic band-trading rules; the middle band is the target).
//   - A full round trip here costs about 26 bps (4 bps fee + 2 bps slippage + impact,
//     twice), so the take-profit has to sit clearly above that: +55 bps over cost, with
//     the stop a little wider at -85 bps so ordinary noise does not shake the bot out.
//   - A falling-knife guard: if the window's mean itself dropped hard over the last
//     DRIFT_BARS bars, the "extreme" is a leg of a trend, not a stretch; stay out.
//   - After any exit the bot waits COOLDOWN bars before buying again, so one stretch
//     cannot churn it through fee after fee.
//
// All indicator math is float64 on + - * / and Math.sqrt alone, so the same bars give
// the same orders on every run. No clock, no environment, no randomness.

import { BPS, runBars, type Bar, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

/** Closes kept for the rolling mean and standard deviation. */
const WINDOW = 60;
/** Buy when the close is at least this many standard deviations below the mean. */
const ENTRY_Z = -1.7;
/**
 * ... and at least this share below the mean in plain price terms. On a thin pool many
 * bars are flat, so the window's standard deviation can shrink to a few bps and a bare
 * z-score would fire on dips smaller than the ~26 bps a round trip costs; the absolute
 * floor keeps every entry chasing a move that can pay its own fees.
 */
const MIN_DIP = 0.0085;
/** Leave once the close has reverted all the way back to the mean (z at or above this). */
const EXIT_Z = 0.0;
/** Leave at once if the close overshoots this far above the mean. */
const OVERSHOOT_Z = 0.8;
/** Hard take-profit: the position worth 10075/10000 of its cost (+0.75%). */
const TAKE_PROFIT: readonly [bigint, bigint] = [10075n, 10000n];
/** Stop-loss: the position worth 9925/10000 of its cost (-0.75%). */
const STOP_LOSS: readonly [bigint, bigint] = [9925n, 10000n];
/** Bars a position may live before it is sold whatever the tape says. */
const MAX_HOLD = 60;
/** Bars to sit out after an exit before the next buy. */
const COOLDOWN = 5;
/** Skip the entry when the mean fell more than this share over DRIFT_BARS bars. */
const DRIFT_BARS = 10;
const DRIFT_MAX_DROP = 0.006;
/** Share of equity one entry may spend (the rest is a buffer against impact). */
const STAKE_BPS = 6000;
/** Refuse a fill that moved more than this past the close the order was decided on. */
const MAX_SLIPPAGE_BPS = 60;

/** Rolling closes of the one traded symbol, oldest first, plus the means history the drift guard reads. */
const closes: number[] = [];
const means: number[] = [];
/** Bars the current position has been held for (0 while flat). */
let heldBars = 0;
/** Bars left to sit out after the last exit. */
let cooldown = 0;
/** True between sending a sell and the batch that shows the position gone. */
let sellPending = false;

function pushBar(bar: Bar): void {
  closes.push(Number(bar.c));
  if (closes.length > WINDOW) closes.shift();
  if (closes.length === WINDOW) {
    let sum = 0;
    for (const c of closes) sum += c;
    means.push(sum / WINDOW);
    if (means.length > DRIFT_BARS + 1) means.shift();
  }
}

/** Mean and population standard deviation of the kept closes, or null before the window fills. */
function stats(): { mean: number; sd: number } | null {
  if (closes.length < WINDOW) return null;
  let sum = 0;
  for (const c of closes) sum += c;
  const mean = sum / WINDOW;
  let sq = 0;
  for (const c of closes) sq += (c - mean) * (c - mean);
  return { mean, sd: Math.sqrt(sq / WINDOW) };
}

/** The falling-knife guard: the window's own mean is sliding down too fast to fade. */
function meanFallingTooFast(): boolean {
  if (means.length <= DRIFT_BARS) return false;
  const then = means[means.length - 1 - DRIFT_BARS];
  const now = means[means.length - 1];
  return then > 0 && (then - now) / then > DRIFT_MAX_DROP;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) pushBar(bar);
    const fresh = new Set(batch.bars.map((b) => b.symbol));
    const { caps, fees } = state.hello;
    const orders: OrderInput[] = [];

    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const held = state.positions.get(symbol);
      const st = stats();
      if (st === null || st.sd === 0) continue;
      const close = closes[closes.length - 1];
      const z = (close - st.mean) / st.sd;

      if (held !== undefined) {
        // The position is live: count its age and run the exits, tightest first.
        heldBars += 1;
        const value = state.value(symbol, held.qty);
        const pastProfit = value * TAKE_PROFIT[1] >= held.cost * TAKE_PROFIT[0];
        const pastStop = value * STOP_LOSS[1] <= held.cost * STOP_LOSS[0];
        if (pastStop || pastProfit || z >= EXIT_Z || z >= OVERSHOOT_Z || heldBars >= MAX_HOLD) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          sellPending = true;
        }
        continue;
      }

      // Flat. A sell sent on an earlier batch may still be working: the position can
      // read as gone for one batch only when its fill lands, so sellPending plus the
      // cooldown together keep the bot from rebuying into the same stretch.
      if (sellPending) {
        sellPending = false;
        cooldown = COOLDOWN;
        heldBars = 0;
      }
      if (cooldown > 0) {
        cooldown -= 1;
        continue;
      }
      if (state.warmingUp) continue;
      if (z > ENTRY_Z) continue;
      if (close > st.mean * (1 - MIN_DIP)) continue;
      if (meanFallingTooFast()) continue;

      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      const byStake = (BigInt(STAKE_BPS) * state.equity) / BPS;
      let slice = byWeight < byStake ? byWeight : byStake;
      if (state.cash < slice) slice = state.cash;
      if (slice <= 0n || slice < BigInt(fees.min_notional_quote_units)) continue;
      if (orders.length >= caps.max_orders_per_bar) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
    return orders;
  },
});
