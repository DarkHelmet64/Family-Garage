// ---------------------------------------------------------------------------
// Fuel economy + service math
//
// Kept free of Firestore and the DOM so the rules here are easy to read (and to
// try out in a console): everything takes plain objects and returns numbers.
// ---------------------------------------------------------------------------

import { daysUntil, addMonthsISO, isoToDate } from "./format.js";

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
      trackedCostCents,
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

// A service visit is one trip to the shop, and one trip usually covers several
// jobs. Those live in an `items` array; records written before that existed --
// or by the spreadsheet importer, one row at a time -- have a single job
// described by the record's own fields, so they're read as a one-item visit.
export function serviceItems(record) {
  if (Array.isArray(record.items) && record.items.length) return record.items;
  return [{ title: record.title || "", costCents: record.costCents ?? null, notes: record.notes || null }];
}

export function itemsTotalCents(items) {
  const total = items.reduce((sum, item) => sum + (item.costCents || 0), 0);
  return total || null;
}

// Every dollar spent at the shop, across every completed visit -- the fuel
// log's totals have a counterpart here so the two can be added together.
// Reads each record's own stored costCents rather than re-summing its items,
// since that figure already carries labor on top of them -- a whole-record
// cost, same as items themselves are, that recomputing from items alone
// would silently drop.
export function totalServiceCostCents(services) {
  return services
    .filter((record) => record.status === "done")
    .reduce((sum, record) => sum + (record.costCents || 0), 0);
}

// What a visit is called. Just the first job -- not "Oil change + 2 more".
//
// That count read well in a list and badly everywhere else it ended up: on a
// follow-up scheduled by a repeat interval, on the garage badge, and in the
// dropdown of previously used service names, where "+ 2 more" is not something
// anyone means to type. The history doesn't need it either, since a visit
// covering several jobs is headed by its date and shop and lists them
// underneath.
export function visitTitle(items) {
  const named = items.filter((item) => item.title);
  return named.length ? named[0].title : "Service";
}

// Titles saved while visits were named "Oil change + 2 more".
const DERIVED_TITLE = / \+ \d+ more$/;

export const looksDerived = (title) => DERIVED_TITLE.test(String(title || ""));
export const undoDerivedTitle = (title) => String(title || "").replace(DERIVED_TITLE, "");

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

// Running low is a shelf at or below the level you said to keep. With no level
// set, only actually running out counts.
export function isLowStock(part) {
  const quantity = Number(part.quantity) || 0;
  const floor = part.minQuantity == null ? 0 : Number(part.minQuantity);
  return quantity <= floor;
}

// The cabinet's own shopping list: every part sitting at or below what you
// said to keep on hand, and how many to buy to get back there. Parts are
// reserved off the shelf the moment they're assigned to a job -- see
// applyPartUsage's call sites -- so the shelf's own count already is the
// answer; nothing here needs to know what any job is due for or when.
export function shelfShortages(parts) {
  return (parts || [])
    .filter(isLowStock)
    .map((part) => {
      const quantity = Number(part.quantity) || 0;
      const hasFloor = part.minQuantity != null;
      const floor = hasFloor ? Number(part.minQuantity) : 0;
      return {
        partId: part.id,
        name: part.name,
        unit: part.unit || "each",
        quantity,
        // Nobody said how many to keep on hand, so there's nothing to count
        // up to beyond zero -- short only has a real number once a floor's
        // been set.
        floor: hasFloor ? floor : null,
        short: hasFloor ? Math.max(0, floor - quantity) : Math.max(0, -quantity),
        // Gone past zero -- more booked out than the shelf ever held -- is a
        // different kind of problem than merely being low: the count itself
        // is now wrong, not just thin.
        negative: quantity < 0,
        modelNumber: part.modelNumber || null,
        size: part.size || null,
        vendor: part.vendor || null,
      };
    })
    // Negative first, regardless of how short anything else is -- a shelf
    // that's actively wrong outranks one that's merely running low.
    .sort((a, b) => b.negative - a.negative || b.short - a.short || String(a.name).localeCompare(String(b.name)));
}

// Which vendors are worth a filter chip on the To buy list -- every distinct
// one actually carried by something currently short, in the same worst-first
// order shelfShortages already sorted them into, so the chips read top to
// bottom the same way the list itself would. A part with no vendor set
// doesn't get a chip; there's nowhere to file it.
export function shortageVendors(shortages) {
  const seen = new Set();
  const vendors = [];
  for (const need of shortages || []) {
    if (need.vendor && !seen.has(need.vendor)) {
      seen.add(need.vendor);
      vendors.push(need.vendor);
    }
  }
  return vendors;
}

// ---------------------------------------------------------------------------
// The service schedule
//
// A record says what was done. A schedule entry says how often it comes round
// on this vehicle -- every so many miles, every so many months, or both. Put
// the two together and you get the question people actually have: when is this
// next needed?
//
// Intervals belong to the vehicle rather than to the app, because they differ:
// a van towing a trailer wants its oil changed sooner than a commuter car, and
// two vehicles in the same driveway rarely share a service book.
// ---------------------------------------------------------------------------

// One job is "the same job" as another when their names match, ignoring case
// and stray spacing. Exported because the app matches on it too -- deciding
// whether a schedule entry is already on the service list, and which of
// those the visit you just logged covered.
export const normalizeJob = (title) => String(title || "").trim().toLowerCase();

// Every job in a vehicle's history, flattened out of the visits that contain
// them, so a job done as part of a three-item visit still counts as done.
export function completedJobs(services) {
  const jobs = [];
  for (const record of services) {
    if (record.status !== "done") continue;
    for (const item of serviceItems(record)) {
      if (!item.title) continue;
      jobs.push({
        title: item.title,
        servicedOn: record.servicedOn ?? null,
        odometerMiles: record.odometerMiles ?? null,
        record,
      });
    }
  }
  return jobs;
}

// The most recent time a particular job was done. "Most recent" goes by
// odometer where both have one, since that's the reading the next interval is
// measured from; date breaks the tie.
export function lastDoneFor(title, services) {
  const wanted = normalizeJob(title);
  const matches = completedJobs(services).filter((job) => normalizeJob(job.title) === wanted);
  if (!matches.length) return null;

  return matches.sort((a, b) => {
    if (a.odometerMiles !== null && b.odometerMiles !== null && a.odometerMiles !== b.odometerMiles) {
      return a.odometerMiles - b.odometerMiles;
    }
    return String(a.servicedOn || "").localeCompare(String(b.servicedOn || ""));
  })[matches.length - 1];
}

// What stands in for a job that has never been logged: the vehicle as it left
// the factory -- zero miles, on January 1st of its model year. Every interval
// then has something to count from, so a job never logged on a 2016 car reads
// as long overdue rather than as a blank the page can say nothing about.
//
// A vehicle with no model year has no such date. Those entries stay
// unmeasurable and say so, rather than counting from a year invented for them.
export function vehicleStartBaseline(vehicleYear) {
  const year = Number(vehicleYear);
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return null;
  return { servicedOn: `${year}-01-01`, odometerMiles: 0 };
}

// When an entry is next needed: the last time it was done plus its interval --
// or, with nothing logged, the same interval measured from the vehicle's own
// beginning.
export function nextDueFor(entry, lastDone, { vehicleYear = null } = {}) {
  const from = lastDone || vehicleStartBaseline(vehicleYear);
  if (!from) return { dueOn: null, dueOdometerMiles: null, neverDone: true, countedFrom: null };
  return {
    dueOn: entry.everyMonths && from.servicedOn ? addMonthsISO(from.servicedOn, entry.everyMonths) : null,
    dueOdometerMiles:
      entry.everyMiles && from.odometerMiles !== null ? from.odometerMiles + entry.everyMiles : null,
    neverDone: !lastDone,
    // Set only when the figures came from the vehicle's age rather than from
    // something logged, so the page can say where they came from -- the
    // difference between a measurement and an assumption is worth showing.
    countedFrom: lastDone ? null : from,
  };
}

// The whole page in one call: each entry with when it was last done, when it's
// next needed, and how urgent that is -- most pressing first.
export function scheduleRows(schedule, services, { odometerMiles = null, today = new Date(), vehicleYear = null } = {}) {
  const rows = schedule.map((entry) => {
    const lastDone = lastDoneFor(entry.title, services);
    const due = nextDueFor(entry, lastDone, { vehicleYear });
    // Nothing logged *and* no model year to fall back on is the only case left
    // that can't say when a job is next needed.
    const status =
      due.dueOn === null && due.dueOdometerMiles === null
        ? { key: "unknown", label: "Not logged yet" }
        : serviceStatus({ status: "scheduled", dueOn: due.dueOn, dueOdometerMiles: due.dueOdometerMiles },
            { odometerMiles, today });
    return { ...entry, lastDone, ...due, status };
  });

  const rank = { overdue: 0, soon: 1, unknown: 2, scheduled: 3 };
  return rows.sort((a, b) => {
    if (rank[a.status.key] !== rank[b.status.key]) return rank[a.status.key] - rank[b.status.key];
    return String(a.title || "").localeCompare(String(b.title || ""));
  });
}

// ---------------------------------------------------------------------------
// Every job name in use across the garage
//
// The same job ends up typed a few different ways over the years -- "Oil chg",
// "oil change", "Oil Change" -- each one a distinct string to everything that
// matches on it: the schedule deciding what's already booked, the suggestion
// list, the badge on the garage card. This is the other side of that: one row
// per name (grouped the same case-and-spacing-insensitive way scheduling
// already does), so a rename can fix it everywhere at once.
// ---------------------------------------------------------------------------

// One row per distinct job name across every vehicle's schedule and service
// records: the casing seen most often (that's what a rename starts from), how
// many vehicles carry it, and how many records.
// `serviceNames` is the garage's own list of names -- added ahead of time,
// favorited, or scoped to particular vehicles, the same shelf-wide way parts
// carry a `fitsVehicleIds`. A name saved there shows up here even with
// nothing logged yet; one that's only ever been typed into a record shows up
// too, just without a saved doc behind it (`id: null`) until it's edited.
export function serviceNameReport(vehicles, serviceNames = []) {
  const byKey = new Map();

  const seen = (title, vehicleId) => {
    const raw = String(title || "").trim();
    if (!raw) return;
    const key = normalizeJob(raw);
    const entry = byKey.get(key) || { key, casing: new Map(), vehicleIds: new Set(), records: 0 };
    entry.casing.set(raw, (entry.casing.get(raw) || 0) + 1);
    entry.vehicleIds.add(vehicleId);
    entry.records += 1;
    byKey.set(key, entry);
  };

  for (const vehicle of vehicles) {
    for (const entry of vehicle.schedule || []) seen(entry.title, vehicle.id);
    for (const record of vehicle.services || []) {
      if (record.status === "done") {
        for (const item of serviceItems(record)) seen(item.title, vehicle.id);
      } else {
        seen(record.title, vehicle.id);
      }
    }
  }

  for (const saved of serviceNames) {
    const raw = String(saved.name || "").trim();
    if (!raw) continue;
    const key = normalizeJob(raw);
    if (!byKey.has(key)) byKey.set(key, { key, casing: new Map([[raw, 1]]), vehicleIds: new Set(), records: 0 });
  }

  const savedByKey = new Map(serviceNames.map((saved) => [normalizeJob(saved.name), saved]));

  return [...byKey.values()]
    .map((entry) => {
      const saved = savedByKey.get(entry.key) || null;
      return {
        key: entry.key,
        id: saved?.id || null,
        name: saved?.name || [...entry.casing.entries()].sort((a, b) => b[1] - a[1])[0][0],
        vehicles: entry.vehicleIds.size,
        vehicleIds: [...entry.vehicleIds],
        records: entry.records,
        favorite: !!saved?.favorite,
        fitsVehicleIds: saved?.fitsVehicleIds?.length ? saved.fitsVehicleIds : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Which saved names offer themselves as suggestions on a given vehicle --
// unrestricted names plus any explicitly scoped to it. Favorites bubble to
// the top, since that's what marking one is for; with `favoritesOnly`,
// nothing else is offered at all -- the service schedule's own dropdown,
// where the whole point is to pick from the handful you actually keep on top
// of, not everything that's ever been typed.
export function serviceNameSuggestions(serviceNames, vehicleId, { favoritesOnly = false } = {}) {
  return (serviceNames || [])
    .filter((entry) => !entry.fitsVehicleIds?.length || entry.fitsVehicleIds.includes(vehicleId))
    .filter((entry) => !favoritesOnly || entry.favorite)
    .slice()
    .sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || String(a.name).localeCompare(String(b.name)))
    .map((entry) => String(entry.name || "").trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// What's coming up
//
// Two kinds of work land on a calendar: jobs actually booked in, and jobs a
// vehicle's schedule implies are next. Both can be due on a date, on an
// odometer reading, or both -- and a mileage on its own says nothing about
// *when*, which is exactly what planning needs. So mileage is turned into a
// date using how fast the vehicle has actually been driven.
// ---------------------------------------------------------------------------

// Miles a day, measured across the whole fill-up history. Needs two readings
// far enough apart to mean anything; a week of records would swing wildly.
const MIN_DAYS_FOR_RATE = 21;

export function milesPerDay(fillups) {
  const sorted = sortFillupsAscending(fillups);
  if (sorted.length < 2) return null;

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const miles = last.odometerMiles - first.odometerMiles;
  const start = isoToDate(first.filledOn);
  const end = isoToDate(last.filledOn);
  if (!start || !end || miles <= 0) return null;

  const days = (end - start) / 86400000;
  if (days < MIN_DAYS_FOR_RATE) return null;
  return miles / days;
}

const pad = (n) => String(n).padStart(2, "0");

export function dateAfterDays(days, today = new Date()) {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  date.setDate(date.getDate() + Math.round(days));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// What's asking for attention across the whole garage: everything overdue and
// everything due soon, each group soonest-first. Nothing further out -- the
// point of this list is what you'd otherwise forget, not the whole year.
export function upcomingWork(vehicles, { today = new Date() } = {}) {
  const overdue = [];
  const soon = [];

  for (const vehicle of vehicles) {
    const services = vehicle.services || [];
    const odometerMiles = vehicle.odometerMiles ?? null;
    const rate = milesPerDay(vehicle.fillups || []);

    const rows = [];

    // Booked jobs first; they're a commitment rather than a rule.
    for (const service of services) {
      if (service.status === "done") continue;
      rows.push({
        source: "booked",
        id: service.id,
        title: service.title,
        dueOn: service.dueOn || null,
        dueOdometerMiles: service.dueOdometerMiles ?? null,
      });
    }

    // Then anything the schedule says is next, unless it's already booked --
    // including jobs never logged, which the schedule dates from the vehicle's
    // own beginning. Those dates are assumptions rather than measurements, so
    // the row carries `neverDone` and says as much.
    const booked = new Set(rows.map((row) => normalizeJob(row.title)));
    for (const entry of scheduleRows(vehicle.schedule || [], services, {
      odometerMiles,
      today,
      vehicleYear: vehicle.year ?? null,
    })) {
      if (booked.has(normalizeJob(entry.title))) continue;
      rows.push({
        source: "schedule",
        id: entry.id,
        title: entry.title,
        dueOn: entry.dueOn || null,
        dueOdometerMiles: entry.dueOdometerMiles ?? null,
        neverDone: entry.neverDone,
        countedFrom: entry.countedFrom || null,
      });
    }

    for (const row of rows) {
      const milesAway =
        row.dueOdometerMiles !== null && odometerMiles !== null ? row.dueOdometerMiles - odometerMiles : null;
      // Only miles still to drive can be turned into a date. Projecting from a
      // mileage already passed used to clamp to today, which read as "due
      // today" on a job thirty thousand miles past -- so it gets no date at
      // all, and the row says how far past it is instead.
      const projectedOn = milesAway !== null && milesAway > 0 && rate ? dateAfterDays(milesAway / rate, today) : null;

      // Whichever comes first, as everywhere else in the app.
      const on = row.dueOn && projectedOn ? (row.dueOn < projectedOn ? row.dueOn : projectedOn) : row.dueOn || projectedOn;

      const entry = {
        ...row,
        vehicleId: vehicle.id,
        vehicleName: vehicle.name,
        milesAway,
        on,
        projected: !!on && on === projectedOn && !(row.dueOn && row.dueOn <= projectedOn),
      };

      // Overdue by the same rule as everywhere else, rather than by whether
      // `on` fell in the past. A job driven past its due mileage projects to
      // *today* -- the projection can't run backwards -- so going by the date
      // alone would file something 38,000 miles overdue under this month.
      const status = serviceStatus(
        { status: "scheduled", dueOn: row.dueOn, dueOdometerMiles: row.dueOdometerMiles },
        { odometerMiles, today }
      );

      entry.status = status;

      // Only what's asking for attention. Work comfortably ahead is real, but
      // it belongs on the vehicle's own page: a garage screen that lists it
      // buries the two jobs you actually have to deal with.
      if (status.key === "overdue") overdue.push(entry);
      else if (status.key === "soon") soon.push(entry);
    }
  }

  // A job with no date to sort by goes last in its group rather than first,
  // which is what an empty string would do.
  const soonestFirst = (a, b) =>
    String(a.on || "9999").localeCompare(String(b.on || "9999")) ||
    String(a.vehicleName).localeCompare(String(b.vehicleName));
  // Oldest first among the overdue, which is longest-overdue first.
  overdue.sort(soonestFirst);
  soon.sort(soonestFirst);
  return { overdue, soon };
}

