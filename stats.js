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
        trackedMiles += miles;
        trackedGallons += gallonsSince;
        trackedCostCents += costSince;
      }
    }
    baseline = entry;
    gallonsSince = 0;
    costSince = 0;
  }

  const withMpg = entries.filter((e) => e.mpg !== null);
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
      lastMpg: withMpg.length ? withMpg[withMpg.length - 1].mpg : null,
      bestMpg: withMpg.length ? Math.max(...withMpg.map((e) => e.mpg)) : null,
      worstMpg: withMpg.length ? Math.min(...withMpg.map((e) => e.mpg)) : null,
      trackedMiles,
      trackedGallons,
      // Only fuel inside a measured stretch has miles to divide by, so cost per
      // mile ignores fill-ups that aren't part of one yet.
      costPerMileCents: trackedMiles > 0 ? trackedCostCents / trackedMiles : null,
      avgPriceCents: totalGallons > 0 ? totalCostCents / totalGallons : null,
      totalGallons,
      totalCostCents,
      mpgSeries: withMpg.map((e) => ({ on: e.filledOn, mpg: e.mpg })),
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
