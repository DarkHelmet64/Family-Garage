// ---------------------------------------------------------------------------
// Importing records from a spreadsheet.
//
// Nobody's vehicle spreadsheet looks like anyone else's: the columns are in a
// different order, named differently, the dates might be real dates or text,
// and there's usually a title row or a totals row in the way. So this guesses
// the layout, shows what it worked out, and lets it be corrected before
// anything is written.
//
// Fill-ups and service records go through the same machinery. What differs
// between them -- which columns to look for, how a row becomes a record, what
// the preview shows -- lives in a profile at the bottom of the matching
// section, so there's one import flow rather than two.
//
// The logic here is deliberately free of Firestore: app.js hands in the
// records already stored and a callback that does the writing.
// ---------------------------------------------------------------------------

import { parseXlsx, excelSerialToISO, SpreadsheetError } from "./xlsx.js";
import { parseCsv } from "./csv.js";
import { buildModal, escapeHtml, openAlertModal } from "./ui.js";
import { formatUSD, formatGallons, formatISO, formatMiles } from "./format.js";

const LITRES_PER_GALLON = 3.785411784;

// ---------------------------------------------------------------------------
// Reading values that were typed by a human
// ---------------------------------------------------------------------------

function normalizeNumericText(str) {
  let text = str.replace(/[^0-9,.\-]/g, "");
  const hasDot = text.includes(".");
  const hasComma = text.includes(",");
  if (hasDot && hasComma) {
    // Whichever separator comes last is the decimal one: 1.234,56 and 1,234.56
    // are the same number written two ways.
    text = text.lastIndexOf(",") > text.lastIndexOf(".")
      ? text.replace(/\./g, "").replace(",", ".")
      : text.replace(/,/g, "");
  } else if (hasComma) {
    // "70,100" is a thousands separator; "13,5" is a decimal comma.
    text = /,\d{3}(\D|$)/.test(text) ? text.replace(/,/g, "") : text.replace(",", ".");
  }
  return text;
}

export function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = normalizeNumericText(value.trim());
  if (!text || !/\d/.test(text)) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

// A column of 03/04/2026 is unreadable on its own -- it's March 4th in the US
// and April 3rd almost everywhere else. Any row in the column with a first
// number above 12 settles it for the whole column.
export function detectDateOrder(values) {
  let sawDayFirst = false;
  for (const value of values) {
    if (typeof value !== "string") continue;
    const match = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(value.trim());
    if (!match) continue;
    if (Number(match[1]) > 12) sawDayFirst = true;
    if (Number(match[2]) > 12) return "mdy";
  }
  return sawDayFirst ? "dmy" : "mdy";
}

const pad2 = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

function expandYear(year) {
  if (year >= 1000) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

export function toISODate(value, order = "mdy") {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number") {
    // A bare number is only read as an Excel serial inside a plausible window:
    // 20000 is 1954 and 60000 is 2064. Odometer readings above that stay
    // numbers. The two ranges do overlap in the middle, which is why the
    // import preview shows the dates it worked out before anything is saved.
    if (value < 20000 || value > 60000) return null;
    return excelSerialToISO(value);
  }

  const text = String(value).trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return isoOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slashed = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(text);
  if (slashed) {
    const first = Number(slashed[1]);
    const second = Number(slashed[2]);
    const year = expandYear(Number(slashed[3]));
    const dayFirst = order === "dmy" || first > 12;
    const month = dayFirst ? second : first;
    const day = dayFirst ? first : second;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return isoOf(year, month, day);
  }

  // "14 Mar 2026", "March 14, 2026" -- read through Date, but take the local
  // parts, since Date is happy to hand back the previous day in UTC.
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return isoOf(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
}

const TRUE_WORDS = new Set(["true", "t", "yes", "y", "1", "x", "full", "fulltank", "f/t", "✓", "✔"]);
const FALSE_WORDS = new Set(["false", "f", "no", "n", "0", "partial", "part", "topoff", "top off", "half"]);

export function toBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  return null;
}

const text = (value) => String(value ?? "").trim();
const isBlankRow = (row) => !row || row.every((cell) => cell === null || cell === undefined || cell === "");

// ---------------------------------------------------------------------------
// Working out which column is which
// ---------------------------------------------------------------------------

const normalizeHeader = (raw) => String(raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// One column claims at most one field, so two columns can't both become "Date".
// Fields are tried in the order the profile lists them, most specific first --
// "Due Date" has to be claimed as a due date before "Date" gets a chance at it.
export function classifyHeader(raw, profile) {
  const value = text(raw);
  if (!value) return null;
  const lower = value.toLowerCase();

  const early = profile.preClassify && profile.preClassify(lower);
  if (early) return early;

  const normalized = normalizeHeader(value);
  if (!normalized) return null;

  for (const field of profile.fields) {
    if (field.exact.includes(normalized)) return field.key;
  }
  for (const field of profile.fields) {
    if (field.fuzzy.some((token) => normalized.includes(token))) return field.key;
  }
  return null;
}

export function detectColumns(headerRow = [], profile) {
  const claims = headerRow.map((cell) => classifyHeader(cell, profile));
  const mapping = {};
  const taken = new Set();
  for (const field of profile.fields) {
    const index = claims.findIndex((claim, i) => claim === field.key && !taken.has(i));
    mapping[field.key] = index;
    if (index >= 0) taken.add(index);
  }
  return mapping;
}

// The header isn't always row 1 -- people put a title, a note, or a blank line
// on top. Whichever of the first several rows looks most like a set of column
// names wins.
export function detectHeaderRow(rows, profile) {
  let best = { index: 0, score: 0 };
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] || [];
    const score = new Set(row.map((cell) => classifyHeader(cell, profile)).filter(Boolean)).size;
    if (score > best.score) best = { index: i, score };
  }
  return best.score >= 2 ? best.index : 0;
}

// A workbook often carries a notes tab, a summary tab, and the actual log, and
// the log is rarely the first one. Score each sheet by how much of a record it
// can see in its header row, and start on the winner.
export function pickBestSheet(sheets, profile) {
  let best = { index: 0, score: -1 };
  sheets.forEach((sheet, index) => {
    const headerIndex = detectHeaderRow(sheet.rows, profile);
    const mapping = detectColumns(sheet.rows[headerIndex] || [], profile);
    const essentials = profile.essentials.filter((key) => mapping[key] >= 0).length;
    const dataRows = Math.max(0, sheet.rows.length - headerIndex - 1);
    const score = essentials * 10 + Math.min(dataRows, 5);
    if (score > best.score) best = { index, score };
  });
  return best.index;
}

export function columnIsLitres(header) {
  return /lit(er|re)|\bl\b|\bltr/i.test(String(header ?? ""));
}

// Walks the data rows, handing each one to the profile to turn into a record.
// Blank rows are skipped; everything else comes back either as a record or as a
// row that was left out, with the reason and its real spreadsheet row number.
function buildRows(rows, { headerRowIndex, mapping, options, profile, dateOrder = null }) {
  const dateColumns = profile.dateFields
    .filter((key) => mapping[key] >= 0)
    .flatMap((key) => rows.slice(headerRowIndex + 1).map((row) => (row || [])[mapping[key]]));
  const order = dateOrder || detectDateOrder(dateColumns);

  const entries = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (isBlankRow(row)) continue;

    // Row numbers are the spreadsheet's own, so "row 14" means row 14 in Excel.
    const rowNumber = i + 1;
    const cell = (key) => (mapping[key] >= 0 ? (row[mapping[key]] ?? null) : null);
    const built = profile.buildRecord({ cell, order, options });
    entries.push({ rowNumber, ...built });
  }

  return { entries, dateOrder: order };
}

export { buildRows as buildEntries };

// ---------------------------------------------------------------------------
// Fill-ups
// ---------------------------------------------------------------------------

export const FILLUP_PROFILE = {
  key: "fillups",
  noun: "fill-up",
  nounPlural: "fill-ups",
  title: "Import fill-ups",
  intro:
    "Load a gas log out of a spreadsheet. An .xlsx from Excel, Numbers, or Google Sheets works, as does a .csv.",
  expects: "Date, Odometer, Gallons, Total — in any order",
  essentials: ["date", "odometer", "gallons"],
  dateFields: ["date"],

  // Ordered most specific first: "Price/Gal" has to be claimed as a unit price
  // before "Total" gets a chance to read it as money.
  fields: [
    {
      key: "date",
      label: "Date",
      exact: ["date", "filldate", "filleddate", "filledon", "datefilled", "day", "when", "fueldate", "purchasedate", "transactiondate"],
      fuzzy: ["date", "day"],
    },
    {
      key: "odometer",
      label: "Odometer",
      exact: ["odometer", "odo", "mileage", "milage", "miles", "odometerreading", "odoreading", "meter", "mi", "currentmileage", "reading"],
      fuzzy: ["odometer", "odo", "mileage", "milage", "miles"],
    },
    {
      key: "gallons",
      label: "Gallons",
      exact: ["gallons", "gallon", "gal", "gals", "volume", "quantity", "qty", "fuel", "litres", "liters", "litre", "liter", "fuelvolume"],
      fuzzy: ["gallon", "litre", "liter", "volume", "quantity", "qty"],
    },
    {
      key: "price",
      label: "Price per gallon",
      exact: ["pricepergallon", "pricegal", "ppg", "unitprice", "rate", "costpergallon", "pergallon", "priceperlitre", "priceperliter", "perlitre", "perliter"],
      fuzzy: ["pergallon", "perlitre", "perliter", "unitprice", "ppg"],
    },
    {
      key: "total",
      label: "Total cost",
      exact: ["total", "totalcost", "cost", "amount", "totalprice", "totalamount", "spent", "paid", "price", "amountpaid", "$"],
      fuzzy: ["total", "cost", "amount", "spent", "paid", "price"],
    },
    { key: "partial", label: "Partial fill", exact: ["partial", "partialfill", "partialtank", "topoff", "toppedoff"], fuzzy: ["partial"] },
    { key: "full", label: "Full tank", exact: ["full", "fulltank", "filledup", "tankfull", "completefill", "filltype"], fuzzy: ["fulltank", "full"] },
    {
      key: "station",
      label: "Station / notes",
      exact: ["station", "location", "where", "place", "vendor", "brand", "shop", "notes", "note", "comment", "comments", "description", "gasstation"],
      fuzzy: ["station", "location", "vendor", "brand", "note", "comment"],
    },
  ],

  preClassify(lower) {
    // "$/gal", "price per litre" -- a per-unit rate, whatever it's called.
    // Checked on the raw text because normalizing drops the "/" that makes it
    // a rate in the first place.
    if (/(\$|€|£|price|cost|rate)?\s*(\/|per\s*)\s*(gal|gallon|l\b|lit(er|re))/i.test(lower)) return "price";
    // A unit in parentheses says what the column holds, whatever the word in
    // front of it: "Amount (gal)" is volume, while a plain "Amount" is money.
    if (/\(\s*(gal|gallons?|lit(er|re)s?|l)\s*\)/i.test(lower) && !/[$€£]|price|cost/i.test(lower)) return "gallons";
    return null;
  },

  // Full and partial describe the same column from opposite ends, so only the
  // one the sheet actually has is offered.
  visibleFields: (mapping) =>
    ["date", "odometer", "gallons", "total", "price", mapping.partial >= 0 ? "partial" : "full", "station"],
  exclusive: [["full", "partial"]],

  buildRecord({ cell, order, options }) {
    const filledOn = toISODate(cell("date"), order);
    const odometerMiles = toNumber(cell("odometer"));
    const rawGallons = toNumber(cell("gallons"));
    const gallons = rawGallons === null ? null : options.litres ? rawGallons / LITRES_PER_GALLON : rawGallons;

    const problems = [];
    if (!filledOn) problems.push(cell("date") ? "date not understood" : "no date");
    if (odometerMiles === null || odometerMiles < 0) problems.push("no odometer reading");
    if (gallons === null || gallons <= 0) problems.push("no gallons");
    if (problems.length) return { status: "skipped", reason: problems.join(", ") };

    const total = toNumber(cell("total"));
    const unitPrice = toNumber(cell("price"));
    // A sheet that records the pump price instead of the total still knows what
    // the stop cost -- multiply it back out.
    const totalCents =
      total !== null ? Math.round(total * 100)
      : unitPrice !== null ? Math.round(unitPrice * gallons * 100)
      : 0;

    const partialFlag = toBool(cell("partial"));
    const fullFlag = toBool(cell("full"));
    // With no column for it, assume a full tank: that's what most logs record,
    // and it's what makes the MPG numbers work out.
    const fullTank = partialFlag !== null ? !partialFlag : fullFlag !== null ? fullFlag : true;

    return {
      status: "ok",
      filledOn,
      odometerMiles: Math.round(odometerMiles),
      gallons: Math.round(gallons * 1000) / 1000,
      totalCents: totalCents < 0 ? 0 : totalCents,
      fullTank,
      station: text(cell("station")).slice(0, 80) || null,
    };
  },

  keyOf: (record) => `${record.filledOn}|${record.odometerMiles}`,

  previewColumns: [
    { label: "Date", get: (e) => formatISO(e.filledOn, { withYear: "auto" }) },
    { label: "Odometer", get: (e) => formatMiles(e.odometerMiles) },
    { label: "Gallons", get: (e) => formatGallons(e.gallons) },
    { label: "Cost", get: (e) => (e.totalCents ? formatUSD(e.totalCents) : null) },
    { label: "Tank", get: (e) => (e.fullTank ? "Full" : "Partial") },
  ],

  emptyAdvice:
    "Nothing here can be imported yet — check that the Date, Odometer, and Gallons columns above point at the right things.",

  extraControls(state, headerRow) {
    const parts = [];
    if (state.mapping.gallons >= 0) {
      parts.push(`
        <label class="field-check" for="map-litres">
          <input type="checkbox" id="map-litres" ${state.options.litres ? "checked" : ""} />
          <span><span class="check-label">That column is in litres</span>
          <span class="field-hint">Converted to gallons on the way in, so the MPG works out.</span></span>
        </label>`);
    }
    if (state.mapping.total < 0 && state.mapping.price >= 0) {
      parts.push(`<p class="hint">No total-cost column, so each stop's cost is worked out from the price per gallon.</p>`);
    }
    return parts.join("");
  },

  bindExtras(controlsEl, state, rerender) {
    const litresBox = controlsEl.querySelector("#map-litres");
    if (litresBox) {
      litresBox.addEventListener("change", () => {
        state.options.litres = litresBox.checked;
        rerender();
      });
    }
  },

  defaultOptions: (headerRow, mapping) => ({
    litres: mapping.gallons >= 0 && columnIsLitres(headerRow[mapping.gallons]),
  }),
};

// ---------------------------------------------------------------------------
// Service records
//
// A service sheet is usually history -- what was done, when, what it cost. But
// the same sheet often carries a "next due" column, so a row with nothing but
// a due date comes in as a scheduled job rather than being thrown away.
// ---------------------------------------------------------------------------

export const SERVICE_PROFILE = {
  key: "services",
  noun: "service record",
  nounPlural: "service records",
  title: "Import service records",
  intro:
    "Load a service history out of a spreadsheet. An .xlsx from Excel, Numbers, or Google Sheets works, as does a .csv.",
  expects: "Service, Date, Odometer, Cost — in any order",
  essentials: ["title", "servicedOn"],
  dateFields: ["servicedOn", "dueOn"],

  // Due mileage and due date come first: "Next Due" has to be read as a
  // reminder before the plainer date and mileage matchers take it. And the
  // mileage one leads, because "Next Due Mileage" contains "next due" -- put
  // the date field first and it claims the column before the more specific
  // matcher is even tried.
  fields: [
    {
      key: "dueOdometer",
      label: "Next due (mi)",
      exact: ["dueat", "duemileage", "duemiles", "dueodometer", "nextmileage", "nextmiles", "nextodometer", "duemi"],
      fuzzy: ["duemile", "dueodo", "nextmile", "nextodo", "dueat"],
    },
    {
      key: "dueOn",
      label: "Next due (date)",
      exact: ["duedate", "nextdue", "nextduedate", "duebydate", "nextservice", "nextservicedate", "nextdate", "due", "dueby"],
      fuzzy: ["duedate", "nextdue", "nextservice", "duebydate"],
    },
    {
      key: "title",
      label: "Service",
      exact: ["service", "serviceperformed", "servicetype", "work", "workdone", "item", "description", "type", "maintenance", "job", "repair", "task"],
      fuzzy: ["service", "maintenance", "repair", "description", "workdone"],
    },
    {
      key: "servicedOn",
      label: "Date done",
      exact: ["date", "datedone", "dateperformed", "dateserviced", "serviced", "servicedate", "servicedon", "completed", "completedon", "performed", "day", "when"],
      fuzzy: ["date", "completed", "performed", "serviced"],
    },
    {
      key: "odometer",
      label: "Odometer",
      exact: ["odometer", "odo", "mileage", "milage", "miles", "odometerreading", "odoreading", "meter", "mi", "atmileage", "reading"],
      fuzzy: ["odometer", "odo", "mileage", "milage", "miles"],
    },
    {
      key: "cost",
      label: "Cost",
      exact: ["cost", "total", "totalcost", "amount", "price", "paid", "charge", "spent", "$", "invoice", "amountpaid"],
      fuzzy: ["cost", "total", "amount", "price", "paid", "charge"],
    },
    {
      key: "shop",
      label: "Shop",
      exact: ["shop", "garage", "vendor", "provider", "dealer", "dealership", "mechanic", "location", "where", "performedby", "servicedby", "place"],
      fuzzy: ["shop", "garage", "vendor", "dealer", "mechanic", "performedby"],
    },
    {
      key: "notes",
      label: "Notes",
      exact: ["notes", "note", "comment", "comments", "remarks", "remark", "details", "detail", "info"],
      fuzzy: ["note", "comment", "remark", "detail"],
    },
  ],

  visibleFields: () => ["title", "servicedOn", "odometer", "cost", "shop", "notes", "dueOn", "dueOdometer"],

  buildRecord({ cell, order }) {
    const title = text(cell("title")).slice(0, 80);
    if (!title) return { status: "skipped", reason: "no service name" };

    const servicedOn = toISODate(cell("servicedOn"), order);
    const odometerMiles = toNumber(cell("odometer"));
    const dueOn = toISODate(cell("dueOn"), order);
    const dueOdometerMiles = toNumber(cell("dueOdometer"));
    const shop = text(cell("shop")).slice(0, 80) || null;
    const notes = text(cell("notes")).slice(0, 500) || null;

    // A row that says when the work happened -- or how many miles were on the
    // clock -- is history. A row with only a due date is still to come.
    const isDone = !!servicedOn || odometerMiles !== null;

    if (!isDone && !dueOn && dueOdometerMiles === null) {
      const attempted = cell("servicedOn") || cell("dueOn");
      return { status: "skipped", reason: attempted ? "date not understood" : "no date or mileage" };
    }

    if (isDone) {
      const cost = toNumber(cell("cost"));
      return {
        status: "ok",
        title,
        recordStatus: "done",
        servicedOn,
        odometerMiles: odometerMiles === null ? null : Math.round(odometerMiles),
        costCents: cost === null ? null : Math.max(0, Math.round(cost * 100)),
        shop,
        notes,
        dueOn: null,
        dueOdometerMiles: null,
      };
    }

    return {
      status: "ok",
      title,
      recordStatus: "scheduled",
      servicedOn: null,
      odometerMiles: null,
      costCents: null,
      shop,
      notes,
      dueOn,
      dueOdometerMiles: dueOdometerMiles === null ? null : Math.round(dueOdometerMiles),
    };
  },

  // Two oil changes on the same day at the same mileage are the same oil
  // change; two a year apart are not.
  keyOf: (record) =>
    [
      text(record.title).toLowerCase(),
      record.servicedOn ?? "",
      record.odometerMiles ?? "",
      record.dueOn ?? "",
      record.dueOdometerMiles ?? "",
    ].join("|"),

  previewColumns: [
    { label: "Service", get: (e) => e.title },
    {
      label: "When",
      get: (e) =>
        e.recordStatus === "done"
          ? e.servicedOn
            ? formatISO(e.servicedOn, { withYear: "auto" })
            : null
          : e.dueOn
            ? `due ${formatISO(e.dueOn, { withYear: "auto" })}`
            : `due at ${formatMiles(e.dueOdometerMiles)}`,
    },
    {
      label: "Odometer",
      get: (e) => (e.odometerMiles !== null ? formatMiles(e.odometerMiles) : null),
    },
    { label: "Cost", get: (e) => (e.costCents ? formatUSD(e.costCents) : null) },
    { label: "Status", get: (e) => (e.recordStatus === "done" ? "Done" : "Scheduled") },
  ],

  emptyAdvice:
    "Nothing here can be imported yet — check that the Service column, and a date or an odometer reading, point at the right things.",

  extraControls(state) {
    const scheduled = state.mapping.dueOn >= 0 || state.mapping.dueOdometer >= 0;
    return scheduled
      ? `<p class="hint">Rows with a date or odometer reading come in as history. A row with only a
         next-due date or mileage comes in as a scheduled job.</p>`
      : "";
  },

  bindExtras() {},
  defaultOptions: () => ({}),
};

export const PROFILES = { fillups: FILLUP_PROFILE, services: SERVICE_PROFILE };

// ---------------------------------------------------------------------------
// Duplicates and counts
// ---------------------------------------------------------------------------

// Importing the same sheet twice shouldn't double every record, and a sheet
// that repeats a row shouldn't either. The two are worth telling apart: one
// means "you already have this", the other means "your spreadsheet says this
// twice", and only the second is a surprise worth pointing at a row for.
export function markDuplicates(entries, existing = [], keyOf) {
  const inLog = new Set(existing.map(keyOf));
  const inFile = new Map();

  for (const entry of entries) {
    if (entry.status !== "ok") continue;
    const key = keyOf(entry);
    if (inLog.has(key)) {
      entry.status = "duplicate";
      entry.duplicateOf = "log";
      entry.reason = "already in your log";
    } else if (inFile.has(key)) {
      entry.status = "duplicate";
      entry.duplicateOf = "file";
      entry.reason = `same as row ${inFile.get(key)}`;
    } else {
      inFile.set(key, entry.rowNumber);
    }
  }
  return entries;
}

export function summarize(entries) {
  const ready = entries.filter((e) => e.status === "ok");
  const duplicates = entries.filter((e) => e.status === "duplicate");
  const skipped = entries.filter((e) => e.status === "skipped");
  return {
    ready,
    readyCount: ready.length,
    duplicates,
    alreadyLoggedCount: duplicates.filter((d) => d.duplicateOf === "log").length,
    repeatedCount: duplicates.filter((d) => d.duplicateOf === "file").length,
    skipped,
    // Everything not being imported, in the order it appears in the sheet.
    issues: [...duplicates, ...skipped].sort((a, b) => a.rowNumber - b.rowNumber),
  };
}

// ---------------------------------------------------------------------------
// Reading the file the user picked
// ---------------------------------------------------------------------------

export async function readSpreadsheet(file) {
  const name = file.name.toLowerCase();

  if (name.endsWith(".xls")) {
    throw new SpreadsheetError(
      "That's the older .xls format, which this can't read. Open it and use File > Save As to make an .xlsx (or a CSV), then import that."
    );
  }
  if (name.endsWith(".csv") || name.endsWith(".txt") || name.endsWith(".tsv")) {
    return [{ name: file.name, rows: parseCsv(await file.text()) }];
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
    return parseXlsx(await file.arrayBuffer());
  }
  throw new SpreadsheetError("Pick an .xlsx or .csv file.");
}

export function columnLabel(index) {
  let label = "";
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    n = Math.floor((n - remainder) / 26);
  }
  return label;
}

// ---------------------------------------------------------------------------
// The import sheet
//
// Two steps: pick a file, then confirm what was made of it. The second step is
// the important one -- it shows the columns it matched, the first few records
// as they'll be saved, and anything it's going to skip, all before a single
// write happens.
// ---------------------------------------------------------------------------

export function openImportModal({ profile, vehicleName, existing = [], onImport }) {
  const overlay = buildModal(`
    <h2>${escapeHtml(profile.title)}</h2>
    <p class="hint">${escapeHtml(profile.intro)} Into ${escapeHtml(vehicleName)}. Nothing is saved
    until you've seen what it made of the file.</p>
    <div class="field">
      <label for="import-file">Spreadsheet</label>
      <input id="import-file" type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" />
      <span class="field-hint">It should have a header row naming the columns — something like
      ${escapeHtml(profile.expects)}.</span>
    </div>
    <p class="form-error" id="import-error" hidden></p>
    <div class="modal-actions">
      <button class="secondary" id="import-cancel">Cancel</button>
    </div>
  `);

  const errorEl = overlay.querySelector("#import-error");
  overlay.querySelector("#import-cancel").addEventListener("click", () => overlay.remove());

  overlay.querySelector("#import-file").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    errorEl.hidden = true;

    try {
      const sheets = await readSpreadsheet(file);
      const usable = sheets.filter((sheet) => sheet.rows.some((row) => !isBlankRow(row)));
      if (!usable.length) throw new SpreadsheetError("That file doesn't have any rows in it.");
      overlay.remove();
      openMappingModal({ profile, fileName: file.name, sheets: usable, existing, onImport });
    } catch (err) {
      // A parse failure is the user's file being unusual, not a crash -- say
      // what happened and leave the picker open so they can try another.
      errorEl.textContent =
        err instanceof SpreadsheetError ? err.message : `Couldn't read that file: ${err.message}`;
      errorEl.hidden = false;
      event.target.value = "";
    }
  });
}

function openMappingModal({ profile, fileName, sheets, existing, onImport }) {
  const state = { sheetIndex: pickBestSheet(sheets, profile), headerRowIndex: 0, mapping: {}, options: {} };

  const autoDetect = () => {
    const rows = sheets[state.sheetIndex].rows;
    state.headerRowIndex = detectHeaderRow(rows, profile);
    const headerRow = rows[state.headerRowIndex] || [];
    state.mapping = detectColumns(headerRow, profile);
    state.options = profile.defaultOptions(headerRow, state.mapping);
  };
  autoDetect();

  const overlay = buildModal(`
    <h2>${escapeHtml(profile.title)}</h2>
    <p class="hint" id="map-source"></p>
    <!-- What it made of the file comes first: that's the question on the
         reader's mind. The column controls sit underneath as the remedy. -->
    <div id="map-result"></div>
    <div id="map-controls"></div>
    <div class="modal-actions">
      <button class="secondary" id="map-cancel">Cancel</button>
      <button id="map-go">Import</button>
    </div>
  `);

  const controlsEl = overlay.querySelector("#map-controls");
  const resultEl = overlay.querySelector("#map-result");
  const goButton = overlay.querySelector("#map-go");
  let ready = [];

  const render = () => {
    const sheet = sheets[state.sheetIndex];
    const rows = sheet.rows;
    const headerRow = rows[state.headerRowIndex] || [];

    overlay.querySelector("#map-source").textContent =
      `${fileName}${sheets.length > 1 ? ` · ${sheet.name}` : ""}`;

    controlsEl.innerHTML = controlsHtml(profile, sheets, rows, headerRow, state);

    const { entries } = buildRows(rows, {
      headerRowIndex: state.headerRowIndex,
      mapping: state.mapping,
      options: state.options,
      profile,
    });
    markDuplicates(entries, existing, profile.keyOf);
    const summary = summarize(entries);
    ready = summary.ready;

    resultEl.innerHTML = resultHtml(profile, summary);
    goButton.disabled = ready.length === 0;
    goButton.textContent = ready.length
      ? `Import ${ready.length} ${ready.length === 1 ? profile.noun : profile.nounPlural}`
      : "Nothing to import";

    bindControls();
  };

  const bindControls = () => {
    const sheetSelect = controlsEl.querySelector("#map-sheet");
    if (sheetSelect) {
      sheetSelect.addEventListener("change", () => {
        state.sheetIndex = Number(sheetSelect.value);
        autoDetect();
        render();
      });
    }

    controlsEl.querySelector("#map-header").addEventListener("change", (e) => {
      state.headerRowIndex = Number(e.target.value);
      // A different header row means different column names, so start the
      // guesses over rather than keeping ones made against the old row.
      const headerRow = sheets[state.sheetIndex].rows[state.headerRowIndex] || [];
      state.mapping = detectColumns(headerRow, profile);
      state.options = profile.defaultOptions(headerRow, state.mapping);
      render();
    });

    controlsEl.querySelectorAll("[data-map-field]").forEach((select) => {
      select.addEventListener("change", () => {
        const field = select.dataset.mapField;
        state.mapping[field] = Number(select.value);
        // Some fields describe the same column from opposite ends; letting both
        // point somewhere would make the record ambiguous.
        if (Number(select.value) >= 0) {
          for (const pair of profile.exclusive || []) {
            if (!pair.includes(field)) continue;
            for (const other of pair) if (other !== field) state.mapping[other] = -1;
          }
        }
        render();
      });
    });

    profile.bindExtras(controlsEl, state, render);
  };

  overlay.querySelector("#map-cancel").addEventListener("click", () => overlay.remove());

  goButton.addEventListener("click", async () => {
    goButton.disabled = true;
    const total = ready.length;
    const label = total === 1 ? profile.noun : profile.nounPlural;
    try {
      await onImport(ready, (done) => {
        goButton.textContent = `Importing… ${done} of ${total}`;
      });
      overlay.remove();
    } catch (err) {
      goButton.disabled = false;
      goButton.textContent = `Import ${total} ${label}`;
      await openAlertModal(`Couldn't finish the import: ${err.message}`);
    }
  });

  render();
}

function controlsHtml(profile, sheets, rows, headerRow, state) {
  const sheetPicker =
    sheets.length > 1
      ? `<div class="field">
           <label for="map-sheet">Sheet</label>
           <select id="map-sheet">
             ${sheets.map((s, i) => `<option value="${i}" ${i === state.sheetIndex ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}
           </select>
         </div>`
      : "";

  const headerOptions = rows
    .slice(0, 15)
    .map((row, i) => {
      const preview = (row || []).filter((c) => c !== null && c !== "").slice(0, 4).join(" · ");
      return `<option value="${i}" ${i === state.headerRowIndex ? "selected" : ""}>Row ${i + 1}${preview ? ` — ${escapeHtml(preview.slice(0, 40))}` : " — (empty)"}</option>`;
    })
    .join("");

  const columnOptions = (selected) =>
    `<option value="-1">— none —</option>` +
    headerRow
      .map((cell, i) => {
        const name = text(cell);
        return `<option value="${i}" ${i === selected ? "selected" : ""}>${escapeHtml(columnLabel(i))}${name ? ` · ${escapeHtml(name.slice(0, 24))}` : ""}</option>`;
      })
      .join("");

  const labelFor = (key) => (profile.fields.find((f) => f.key === key) || {}).label || key;

  return `
    ${sheetPicker}
    <div class="field">
      <label for="map-header">Header row</label>
      <select id="map-header">${headerOptions}</select>
    </div>
    <div class="section-title">Columns it used</div>
    <div class="form-grid">
      ${profile
        .visibleFields(state.mapping)
        .map(
          (key) => `
        <div class="field field-half">
          <label for="map-${key}">${escapeHtml(labelFor(key))}</label>
          <select id="map-${key}" data-map-field="${key}">${columnOptions(state.mapping[key])}</select>
        </div>`
        )
        .join("")}
    </div>
    ${profile.extraControls(state, headerRow)}`;
}

function resultHtml(profile, summary) {
  const { ready, readyCount, alreadyLoggedCount, repeatedCount, skipped, issues } = summary;

  const counts = [
    `<span class="import-stat ok">${readyCount} to import</span>`,
    alreadyLoggedCount ? `<span class="import-stat dup">${alreadyLoggedCount} already logged</span>` : "",
    repeatedCount ? `<span class="import-stat dup">${repeatedCount} repeated in the file</span>` : "",
    skipped.length ? `<span class="import-stat skip">${skipped.length} skipped</span>` : "",
  ].join("");

  const preview = ready.slice(0, 4);
  const cell = (value) =>
    value === null || value === undefined || value === ""
      ? `<span class="muted">—</span>`
      : escapeHtml(String(value));

  const previewTable = preview.length
    ? `<div class="import-preview-wrap">
         <table class="import-preview">
           <thead>
             <tr><th>Row</th>${profile.previewColumns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}</tr>
           </thead>
           <tbody>
             ${preview
               .map(
                 (entry) => `
               <tr>
                 <td class="muted">${entry.rowNumber}</td>
                 ${profile.previewColumns.map((c) => `<td>${cell(c.get(entry))}</td>`).join("")}
               </tr>`
               )
               .join("")}
           </tbody>
         </table>
       </div>
       ${readyCount > preview.length ? `<p class="hint">…and ${readyCount - preview.length} more.</p>` : ""}`
    : `<p class="hint">${escapeHtml(profile.emptyAdvice)}</p>`;

  const problems = issues.slice(0, 6);
  const problemList = problems.length
    ? `<ul class="import-problems">
         ${problems.map((p) => `<li><strong>Row ${p.rowNumber}</strong> — ${escapeHtml(p.reason)}</li>`).join("")}
         ${issues.length > problems.length ? `<li class="muted">…and ${issues.length - problems.length} more</li>` : ""}
       </ul>
       <p class="hint">Rows left out are usually totals lines, gaps in the log, or records you
       already have. Your spreadsheet isn't changed either way.</p>`
    : "";

  return `<div class="import-summary">${counts}</div>${previewTable}${problemList}`;
}
