// ---------------------------------------------------------------------------
// Fuel economy + service math
//
// Kept free of Firestore and the DOM so the rules here are easy to read (and to
// try out in a console): everything takes plain objects and returns numbers.
// ---------------------------------------------------------------------------

import { daysUntil } from "./format.js";

// Odometer is the honest ordering key -- someone entering a receipt they found
// in the glovebox gets slotted into the right place in the sequence regardless
// of when they typed it in. Date only breaks ties.
export function sortFillupsAscending(fillups) {
  return [...fillups].sort((a, b) => {
    if (a.odometerMiles !== b.odometerMiles) return a.odometerMiles - b.odometerMiles;
    return String(a.filledOn || "").localeCompare(String(b.filledOn || ""));
  });
}

// The garage list can't afford to read every fill-up of every vehicle just to
// show one number, so each vehicle document carries a cached average written
// the last time anything changed. That cache is only as current as the maths
// that produced it -- so it's stamped with this, and a vehicle carrying an
// older stamp gets recomputed the next time the list is opened.
//
// Bump it whenever a change here would give an existing log a different answer.
//   1 - the original gallons-weighted average
//   2 - outliers left out of the average, best and worst
export const STATS_VERSION = 2;

// ---------------------------------------------------------------------------
// Outliers
//
// A fuel log collects two kinds of strange number, and only one of them is
// interesting:
//
//   - Bad data. A fill-up that never got logged, which hands the next tank
//     twice the miles it earned and reads as double the MPG. Or a mistyped
//     odometer, which misses by an order of magnitude.
//   - Real driving. Towing a trailer, a winter of school runs, a road trip.
//     Genuinely unusual, genuinely yours, and it belongs in your numbers.
//
// The rule: a reading is bad data when it is at least double the 90th
// percentile of normal readings -- double, triple, quadruple or more. That is
// the shape of a missed fill-up, and it is out of reach of any real driving.
//
// Nothing is deleted or hidden. A flagged reading still appears in the log and
// the chart, says why it wasn't counted, and can be counted anyway with one tap.
// ---------------------------------------------------------------------------

// A hair under double, and deliberately so. When a fill-up goes unlogged, the
// next tank reports almost exactly twice the surrounding tanks -- so a strict
// "2× or more" test sits right on top of the very case it exists to catch, and
// whether it fires comes down to a rounding error in the last decimal. 1.9
// clears the boundary. Triple, quadruple and beyond are caught by the same
// test, being further out still.
const OUTLIER_MULTIPLE = 1.9;
const BASELINE_PERCENTILE = 0.9;

// Statistics need something to be a statistic about; with four readings,
// "unusual" doesn't mean anything yet.
const MIN_READINGS_FOR_STATS = 5;

// No car has ever done this. Unlike the rule above, this one doesn't need a
// baseline to compare against, so it catches a mistyped gallons figure on the
// very first tank.
const IMPLAUSIBLY_LOW_MPG = 5;

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = p * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

const median = (values) => percentile(values, 0.5);

// The 90th percentile of the readings at or below the median, rather than of
// every reading.
//
// Taken across the whole log, the percentile is inflated by the very readings
// it is meant to catch -- with five ordinary tanks and one missed fill-up, the
// missed one *is* the top of the range, and doubling it puts the bar out of
// reach. Even in a clean log of twenty-odd readings, the 90th percentile sits
// near the best tank a vehicle has ever managed, and a missed fill-up is double
// the *typical* tank, not double the best one. Measuring from the bottom half
// gives a baseline no outlier can contaminate.
function baselineMpg(values) {
  const mid = median(values);
  if (mid === null) return null;
  const normal = values.filter((v) => v <= mid);
  return percentile(normal, BASELINE_PERCENTILE);
}

export const OUTLIER_REASONS = {
  low: "too low to be real — check the odometer",
  manual: "you left this one out",
};

export const outlierHighReason = (multiple) =>
  `${multiple}× this vehicle's usual — a missed fill-up?`;

// Decides which readings count, marking each entry with `counted` and, when it
// isn't, why. Manual choices always win over the automatic ones.
export function flagOutliers(entries) {
  const readings = entries.filter((e) => e.mpg !== null);

  // An automatic judgement is only made about readings nobody has ruled on, so
  // one deliberately-included oddity can't drag the baseline around.
  const automatic = readings.filter((e) => e.countTowardMpg === undefined || e.countTowardMpg === null);
  const values = automatic.map((e) => e.mpg);
  const baseline = values.length >= MIN_READINGS_FOR_STATS ? baselineMpg(values) : null;
  const ceiling = baseline ? baseline * OUTLIER_MULTIPLE : null;

  for (const entry of readings) {
    if (entry.countTowardMpg === true) {
      entry.counted = true;
      entry.excludedReason = null;
      continue;
    }
    if (entry.countTowardMpg === false) {
      entry.counted = false;
      entry.excludedReason = OUTLIER_REASONS.manual;
      continue;
    }

    if (entry.mpg < IMPLAUSIBLY_LOW_MPG) {
      entry.counted = false;
      entry.excludedReason = OUTLIER_REASONS.low;
      continue;
    }

    if (ceiling !== null && entry.mpg >= ceiling) {
      entry.counted = false;
      // Say how far out it is -- "3× this vehicle's usual" points at a missed
      // fill-up far better than the word "outlier" does.
      entry.excludedReason = outlierHighReason(Math.max(2, Math.round(entry.mpg / baseline)));
      continue;
    }

    entry.counted = true;
    entry.excludedReason = null;
  }

  return entries;
}

// MPG for one fill-up is the miles driven since the tank was last *full*,
// divided by every gallon put in since that point (this fill-up included --
// that fuel is what replaces what the drive burned).
//
// Partial fills therefore don't get an MPG of their own; their gallons roll
// into the next full tank, which is what keeps the numbers honest for anyone
// who tops off. The very first full tank has no baseline before it, so it has
// no MPG either.
export function computeFuelStats(fillups) {
  const entries = sortFillupsAscending(fillups).map((f) => ({
    ...f,
    mpg: null,
    pricePerGallonCents: f.gallons > 0 ? f.totalCents / f.gallons : null,
  }));

  let baseline = null; // last full-tank entry
  let gallonsSince = 0;
  let costSince = 0;
  let trackedMiles = 0;
  let trackedGallons = 0;
  let trackedCostCents = 0;

  for (const entry of entries) {
    if (baseline) {
      gallonsSince += entry.gallons;
      costSince += entry.totalCents;
    }
    if (!entry.fullTank) continue;

    if (baseline) {
      const miles = entry.odometerMiles - baseline.odometerMiles;
      if (miles > 0 && gallonsSince > 0) {
        entry.mpg = miles / gallonsSince;
        // Kept on the entry so that a reading dropped as an outlier takes its
        // miles, gallons and cost out of the totals with it -- otherwise the
        // average would still be quietly carrying the bad data.
        entry.segment = { miles, gallons: gallonsSince, costCents: costSince };
      }
    }
    baseline = entry;
    gallonsSince = 0;
    costSince = 0;
  }

  flagOutliers(entries);

  const withMpg = entries.filter((e) => e.mpg !== null);
  const counted = withMpg.filter((e) => e.counted);
  for (const entry of counted) {
    trackedMiles += entry.segment.miles;
    trackedGallons += entry.segment.gallons;
    trackedCostCents += entry.segment.costCents;
  }
  const totalGallons = entries.reduce((sum, e) => sum + e.gallons, 0);
  const totalCostCents = entries.reduce((sum, e) => sum + e.totalCents, 0);

  return {
    entries,
    summary: {
      count: entries.length,
      lastOdometerMiles: entries.length ? entries[entries.length - 1].odometerMiles : null,
      // Gallons-weighted, not an average of averages: 400 miles on 20 gallons
      // and 30 miles on 2 should read as one long run, not two equal samples.
      avgMpg: trackedGallons > 0 ? trackedMiles / trackedGallons : null,
      lastMpg: counted.length ? counted[counted.length - 1].mpg : null,
      bestMpg: counted.length ? Math.max(...counted.map((e) => e.mpg)) : null,
      worstMpg: counted.length ? Math.min(...counted.map((e) => e.mpg)) : null,
      readingCount: withMpg.length,
      excludedCount: withMpg.length - counted.length,
      trackedMiles,
      trackedGallons,
      // Only fuel inside a measured stretch has miles to divide by, so cost per
      // mile ignores fill-ups that aren't part of one yet.
      costPerMileCents: trackedMiles > 0 ? trackedCostCents / trackedMiles : null,
      avgPriceCents: totalGallons > 0 ? totalCostCents / totalGallons : null,
      // Totals are what was actually spent and pumped, so they count every
      // fill-up. Only the rates above -- the ones an outlier would distort --
      // leave anything out.
      totalGallons,
      totalCostCents,
      mpgSeries: withMpg.map((e) => ({ on: e.filledOn, mpg: e.mpg, counted: e.counted })),
    },
  };
}

// How close a scheduled service is, by whichever of its two triggers is nearer.
// "soon" is 30 days or 500 miles out -- close enough to book an appointment.
const SOON_DAYS = 30;
const SOON_MILES = 500;

export function serviceStatus(service, { odometerMiles = null, today = new Date() } = {}) {
  if (service.status === "done") return { key: "done", label: "Done" };

  const days = service.dueOn ? daysUntil(service.dueOn, today) : null;
  const milesLeft =
    service.dueOdometerMiles !== null &&
    service.dueOdometerMiles !== undefined &&
    odometerMiles !== null
      ? service.dueOdometerMiles - odometerMiles
      : null;

  const overdue = (days !== null && days < 0) || (milesLeft !== null && milesLeft <= 0);
  if (overdue) return { key: "overdue", label: "Overdue", days, milesLeft };

  const soon =
    (days !== null && days <= SOON_DAYS) || (milesLeft !== null && milesLeft <= SOON_MILES);
  if (soon) return { key: "soon", label: "Due soon", days, milesLeft };

  return { key: "scheduled", label: "Scheduled", days, milesLeft };
}

// Sorts the most pressing service to the top: overdue first, then due soon,
// then everything with a date or mileage still comfortably ahead.
const STATUS_RANK = { overdue: 0, soon: 1, scheduled: 2, done: 3 };

export function compareServices(a, b, ctx) {
  const rankA = STATUS_RANK[serviceStatus(a, ctx).key];
  const rankB = STATUS_RANK[serviceStatus(b, ctx).key];
  if (rankA !== rankB) return rankA - rankB;

  const dayA = a.dueOn ? daysUntil(a.dueOn, ctx.today) : Infinity;
  const dayB = b.dueOn ? daysUntil(b.dueOn, ctx.today) : Infinity;
  if (dayA !== dayB) return dayA - dayB;

  const odoA = a.dueOdometerMiles ?? Infinity;
  const odoB = b.dueOdometerMiles ?? Infinity;
  if (odoA !== odoB) return odoA - odoB;

  return String(a.title || "").localeCompare(String(b.title || ""));
}
