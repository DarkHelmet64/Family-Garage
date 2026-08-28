// ---------------------------------------------------------------------------
// Formatting + date helpers
//
// Dates the user picks (when a tank was filled, when a service is due) are kept
// as plain "YYYY-MM-DD" strings rather than timestamps. A fill-up belongs to a
// calendar day, not an instant, and storing the day directly avoids the
// off-by-one that a UTC timestamp gives you when the phone is west of UTC.
// ---------------------------------------------------------------------------

export function formatUSD(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Gas prices are quoted to a tenth of a cent, so keep the third decimal here.
export function formatPricePerGallon(cents) {
  if (cents === null || !Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(3)}`;
}

export function dollarsToCents(dollarsStr) {
  const val = Math.round(parseFloat(dollarsStr) * 100);
  return Number.isFinite(val) ? val : NaN;
}

export function formatMiles(miles) {
  if (miles === null || !Number.isFinite(miles)) return "—";
  return `${Math.round(miles).toLocaleString()} mi`;
}

export function formatGallons(gallons) {
  if (gallons === null || !Number.isFinite(gallons)) return "—";
  // 12.500 -> 12.5, 12.000 -> 12
  const trimmed = gallons.toFixed(3).replace(/\.?0+$/, "");
  return `${trimmed} gal`;
}

export function formatMpg(mpg) {
  if (mpg === null || !Number.isFinite(mpg)) return "—";
  return mpg.toFixed(1);
}

export function todayISO() {
  return isoFromDate(new Date());
}

export function isoFromDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// "2026-08-13" -> a Date at local midnight (never UTC, see the note above).
export function isoToDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

// withYear: true always shows it, false never does, and "auto" shows it only
// when the date falls outside the current year -- so a service due next March
// doesn't read as if it were this March.
export function formatISO(iso, { withYear = true } = {}) {
  const date = isoToDate(iso);
  if (!date) return "";
  const showYear =
    withYear === "auto" ? date.getFullYear() !== new Date().getFullYear() : !!withYear;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(showYear ? { year: "numeric" } : {}),
  });
}

// Whole days from today to `iso`: negative in the past, 0 today.
export function daysUntil(iso, today = new Date()) {
  const target = isoToDate(iso);
  if (!target) return null;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - start) / 86400000);
}

export function addMonthsISO(iso, months) {
  const date = isoToDate(iso);
  if (!date) return null;
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  // Clamp for short months: Jan 31 + 1 month lands on Feb 28/29, not Mar 3.
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return isoFromDate(date);
}

export function relativeDayLabel(iso, today = new Date()) {
  const days = daysUntil(iso, today);
  if (days === null) return "";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days < 0) return `${Math.abs(days)} days ago`;
  return `in ${days} days`;
}
