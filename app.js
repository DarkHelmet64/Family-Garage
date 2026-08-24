import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

import {
  formatUSD,
  formatPricePerGallon,
  dollarsToCents,
  formatMiles,
  formatGallons,
  formatMpg,
  formatISO,
  todayISO,
  addMonthsISO,
  relativeDayLabel,
} from "./format.js";
import {
  escapeHtml,
  showToast,
  openAlertModal,
  openConfirmModal,
  openPickerModal,
  openFormModal,
  openQrModal,
  mpgChartSvg,
} from "./ui.js";
import { computeFuelStats, serviceStatus, compareServices, STATS_VERSION } from "./stats.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const $app = document.getElementById("app");

const params = new URLSearchParams(location.search);
const vehicleId = params.get("vehicle");
const isNewVehiclePage = params.has("new");

// Common services, offered as a datalist so the same wording gets reused across
// vehicles instead of "Oil change" / "oil chg" / "Oil".
const SERVICE_SUGGESTIONS = [
  "Oil change",
  "Tire rotation",
  "New tires",
  "Brake pads",
  "State inspection",
  "Registration renewal",
  "Engine air filter",
  "Cabin air filter",
  "Battery",
  "Wiper blades",
  "Transmission fluid",
  "Coolant flush",
  "Spark plugs",
  "Alignment",
];

// Which screen this is. Called from the very bottom of the file rather than
// here, so that the whole module -- every const included -- is initialized
// before a render runs. A snapshot callback that fires straight away would
// otherwise reach state declared further down before it exists.
function route() {
  if (isConfigMissing()) {
    renderConfigMissing();
  } else if (isNewVehiclePage) {
    renderNewVehicleView();
  } else if (vehicleId) {
    renderVehicleView(vehicleId);
  } else {
    renderGarageView();
  }
}

function isConfigMissing() {
  return !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("YOUR_");
}

function renderConfigMissing() {
  $app.innerHTML = `
    <h1><span class="emoji">🚗</span>Family Garage</h1>
    <div class="card">
      <p>This app isn't connected to a database yet.</p>
      <p class="hint">Fill in <code>firebase-config.js</code> with your free Firebase project's
      web config, then reload this page. See README.md for step-by-step setup instructions.</p>
    </div>
  `;
}

function siteUrl() {
  const url = new URL(location.href);
  url.search = "";
  return url.toString();
}

function vehicleSubtitle(data) {
  return [data.year, data.make, data.model].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Garage view: every vehicle, with what it needs
// ---------------------------------------------------------------------------

function renderGarageView() {
  $app.innerHTML = `
    <h1><span class="emoji">🚗</span>Family Garage</h1>
    <div id="vehicle-list"><p class="loading">Loading…</p></div>
    <button class="secondary full-action" id="more-btn">More</button>
  `;

  document.getElementById("more-btn").addEventListener("click", openGarageMenu);

  const listEl = document.getElementById("vehicle-list");
  onSnapshot(
    collection(db, "vehicles"),
    (snap) => {
      if (snap.empty) {
        listEl.innerHTML = `
          <p class="empty">No vehicles yet.</p>
          <div class="single-action"><a class="btn" href="?new">+ Add a vehicle</a></div>
        `;
        return;
      }
      const vehicles = [];
      snap.forEach((docSnap) => vehicles.push({ id: docSnap.id, ...docSnap.data() }));
      vehicles.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

      listEl.innerHTML = vehicles.map(vehicleCardHtml).join("");
      refreshStaleSummaries(vehicles);
      listEl.querySelectorAll(".vehicle-row").forEach((row) => {
        row.addEventListener("click", () => {
          location.search = `?vehicle=${row.dataset.id}`;
        });
      });
    },
    (err) => {
      listEl.innerHTML = `<p class="empty">Couldn't load your vehicles.<br /><span class="hint">${escapeHtml(err.message)}</span></p>`;
    }
  );
}

// The garage list reads only the vehicle documents -- the MPG and next-service
// figures on them are kept up to date by recomputeSummary() on every write, so
// showing ten vehicles is one query rather than thirty.
function vehicleCardHtml(vehicle) {
  const subtitle = vehicleSubtitle(vehicle);
  const next = vehicle.nextService || null;
  const status = next
    ? serviceStatus({ ...next, status: "scheduled" }, { odometerMiles: vehicle.odometerMiles ?? null })
    : null;

  const badge =
    status && (status.key === "overdue" || status.key === "soon")
      ? `<span class="badge ${status.key}">${escapeHtml(status.label)}</span>`
      : "";

  const serviceLine = next
    ? `<span class="vehicle-service ${status.key}">${escapeHtml(next.title)} · ${escapeHtml(dueSummary(next, vehicle.odometerMiles ?? null))}</span>`
    : "";

  return `
    <div class="card vehicle-row" data-id="${vehicle.id}">
      <div class="vehicle-main">
        <span class="vehicle-name">${escapeHtml(vehicle.name)}${badge}</span>
        ${subtitle ? `<span class="vehicle-sub">${escapeHtml(subtitle)}</span>` : ""}
        ${serviceLine}
      </div>
      <div class="vehicle-stats">
        <span class="stat-big">${formatMpg(vehicle.avgMpg ?? null)}</span>
        <span class="stat-label">avg MPG</span>
        <span class="stat-odo">${formatMiles(vehicle.odometerMiles ?? null)}</span>
      </div>
    </div>
  `;
}

// "due Sep 4 · in 12 days", "due at 52,000 mi · 340 mi away", or both.
function dueSummary(service, odometerMiles) {
  const parts = [];
  if (service.dueOn) parts.push(`due ${formatISO(service.dueOn, { withYear: "auto" })} (${relativeDayLabel(service.dueOn)})`);
  if (service.dueOdometerMiles !== null && service.dueOdometerMiles !== undefined) {
    const left = odometerMiles !== null ? service.dueOdometerMiles - odometerMiles : null;
    const distance =
      left === null ? "" : left > 0 ? ` (${formatMiles(left)} away)` : ` (${formatMiles(-left)} past)`;
    parts.push(`due at ${formatMiles(service.dueOdometerMiles)}${distance}`);
  }
  return parts.join(" · ") || "no due date set";
}

// A vehicle whose cached figures were worked out by an older version of the
// maths is brought up to date here, once, in the background: the snapshot
// listener above redraws the card as soon as the new numbers land. Without
// this, the list would go on showing the old average until something else
// happened to write to that vehicle -- and would disagree with the vehicle's
// own page, which computes from the fill-ups every time.
const refreshingSummaries = new Set();

function refreshStaleSummaries(vehicles) {
  for (const vehicle of vehicles) {
    if (vehicle.statsVersion === STATS_VERSION || refreshingSummaries.has(vehicle.id)) continue;
    refreshingSummaries.add(vehicle.id);
    recomputeSummary(vehicle.id).catch(() => {
      // Leave it stale rather than hammering a failing connection; the next
      // visit tries again.
      refreshingSummaries.delete(vehicle.id);
    });
  }
}

function openGarageMenu() {
  openPickerModal({
    title: "More",
    options: [
      { value: "new", label: "+ Add a vehicle" },
      { value: "qr", label: "Show QR code" },
    ],
  }).then((choice) => {
    if (choice === "new") location.search = "?new";
    else if (choice === "qr") openQrModal(siteUrl(), "Scan to open Family Garage");
  });
}

// ---------------------------------------------------------------------------
// New vehicle
// ---------------------------------------------------------------------------

function renderNewVehicleView() {
  $app.innerHTML = `
    <a class="back-link" href="./">&larr; Garage</a>
    <h1><span class="emoji">🚗</span>Add a vehicle</h1>
    <div class="card">
      <form id="new-vehicle-form" class="stacked-form">
        <label for="v-name">Name</label>
        <input id="v-name" type="text" placeholder="e.g. Mom's van" required autofocus autocomplete="off" />
        <div class="form-grid">
          <div class="field field-half">
            <label for="v-year">Year</label>
            <input id="v-year" type="number" inputmode="numeric" placeholder="2019" />
          </div>
          <div class="field field-half">
            <label for="v-make">Make</label>
            <input id="v-make" type="text" placeholder="Honda" autocomplete="off" />
          </div>
          <div class="field field-half">
            <label for="v-model">Model</label>
            <input id="v-model" type="text" placeholder="Odyssey" autocomplete="off" />
          </div>
          <div class="field field-half">
            <label for="v-odo">Odometer today</label>
            <input id="v-odo" type="number" inputmode="numeric" min="0" placeholder="48000" />
          </div>
        </div>
        <p class="hint">Only the name is required — the rest just makes the list easier to read.
        The odometer keeps itself up to date from your fill-ups and service records.</p>
        <button type="submit">Add vehicle</button>
      </form>
    </div>
  `;

  document.getElementById("new-vehicle-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("v-name").value.trim();
    if (!name) return;
    const odoStr = document.getElementById("v-odo").value;
    const startOdometerMiles = odoStr ? Math.round(Number(odoStr)) : null;
    if (odoStr && (!Number.isFinite(startOdometerMiles) || startOdometerMiles < 0)) {
      await openAlertModal("Please enter a valid odometer reading.");
      return;
    }

    const ref = await addDoc(collection(db, "vehicles"), {
      name,
      year: document.getElementById("v-year").value.trim() || null,
      make: document.getElementById("v-make").value.trim() || null,
      model: document.getElementById("v-model").value.trim() || null,
      startOdometerMiles,
      odometerMiles: startOdometerMiles,
      avgMpg: null,
      lastMpg: null,
      nextService: null,
      createdAt: serverTimestamp(),
    });

    location.search = `?vehicle=${ref.id}`;
  });
}

// ---------------------------------------------------------------------------
// Vehicle view: fuel economy, service, and history for one vehicle
//
// The three live queries (the vehicle, its fill-ups, its services) all feed one
// piece of state and one render pass. Clicks are handled by delegation on the
// container, so a re-render never leaves a dead button behind.
// ---------------------------------------------------------------------------

function renderVehicleView(id) {
  $app.innerHTML = `
    <a class="back-link" href="./">&larr; Garage</a>
    <div id="vehicle-body"><p class="loading">Loading…</p></div>
  `;

  const bodyEl = document.getElementById("vehicle-body");
  const state = {
    id,
    vehicle: null,
    fillups: null,
    services: null,
    showAllFillups: false,
    showHistory: false,
  };

  bodyEl.addEventListener("click", (event) => {
    const target = event.target.closest("[data-act]");
    if (target) handleVehicleAction(target.dataset.act, target.dataset.id, state);
  });

  const render = () => {
    if (!state.vehicle || !state.fillups || !state.services) return;
    bodyEl.innerHTML = vehicleBodyHtml(state);
  };

  onSnapshot(doc(db, "vehicles", id), (snap) => {
    if (!snap.exists()) {
      bodyEl.innerHTML = `<div class="card"><p class="empty">This vehicle doesn't exist (maybe it was deleted).</p></div>`;
      state.vehicle = null;
      return;
    }
    state.vehicle = { id: snap.id, ...snap.data() };
    render();
  });

  onSnapshot(collection(db, "vehicles", id, "fillups"), (snap) => {
    state.fillups = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });

  onSnapshot(collection(db, "vehicles", id, "services"), (snap) => {
    state.services = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
}

function vehicleBodyHtml(state) {
  const { vehicle } = state;
  const { entries, summary } = computeFuelStats(state.fillups);
  const odometerMiles = currentOdometer(vehicle, state.fillups, state.services);
  const ctx = { odometerMiles, today: new Date() };

  const open = state.services.filter((s) => s.status !== "done").sort((a, b) => compareServices(a, b, ctx));
  const history = state.services
    .filter((s) => s.status === "done")
    .sort((a, b) => String(b.servicedOn || "").localeCompare(String(a.servicedOn || "")));

  const subtitle = vehicleSubtitle(vehicle);
  const recent = [...entries].reverse();
  const shown = state.showAllFillups ? recent : recent.slice(0, 5);

  return `
    <div class="card hero">
      <div class="hero-head">
        <div>
          <div class="hero-name">${escapeHtml(vehicle.name)}</div>
          ${subtitle ? `<div class="hero-sub">${escapeHtml(subtitle)}</div>` : ""}
        </div>
        <button class="ghost" data-act="vehicle-menu">More</button>
      </div>
      <div class="hero-figure">
        <span class="hero-mpg">${formatMpg(summary.avgMpg)}</span>
        <span class="hero-unit">avg MPG</span>
      </div>
      <div class="hero-odo">${formatMiles(odometerMiles)} on the odometer</div>
      ${
        summary.excludedCount
          ? `<div class="hero-note">${summary.excludedCount} of ${summary.readingCount} readings left out of these figures — they're marked in the gas log below</div>`
          : ""
      }
      ${summary.mpgSeries.length >= 2 ? mpgChartSvg(summary.mpgSeries, summary.avgMpg) : ""}
    </div>

    <div class="action-row">
      <button class="fuel-btn" data-act="log-fuel">⛽ Log fill-up</button>
      <button class="service-btn" data-act="log-service">🔧 Add service</button>
    </div>

    ${statsGridHtml(summary)}

    <div class="section-title">Service</div>
    ${
      open.length
        ? `<div class="list">${open.map((s) => serviceRowHtml(s, ctx)).join("")}</div>`
        : `<p class="empty small">Nothing scheduled. Tap <strong>Add service</strong> to book the next oil change or log one you've already had done.</p>`
    }

    ${
      history.length
        ? `<div class="section-title row-title">
             <span>Service history</span>
             <a class="inline-link" href="#" data-act="toggle-history">${state.showHistory ? "Hide" : `Show (${history.length})`}</a>
           </div>
           ${state.showHistory ? `<div class="list">${history.map((s) => serviceHistoryRowHtml(s)).join("")}</div>` : ""}`
        : ""
    }

    <div class="section-title">Gas log</div>
    ${
      shown.length
        ? `<div class="list">${shown.map((entry) => fillupRowHtml(entry)).join("")}</div>
           ${
             recent.length > 5
               ? `<div class="single-action"><a class="inline-link" href="#" data-act="toggle-fillups">${
                   state.showAllFillups ? "Show fewer" : `Show all ${recent.length}`
                 }</a></div>`
               : ""
           }`
        : `<p class="empty small">No fill-ups yet. Log one every time you buy gas — MPG appears once you've filled the tank all the way twice.</p>`
    }
  `;
}

function statsGridHtml(summary) {
  if (!summary.count) return "";
  const cells = [
    { label: "Last fill-up", value: formatMpg(summary.lastMpg), unit: "MPG" },
    { label: "Best", value: formatMpg(summary.bestMpg), unit: "MPG" },
    { label: "Worst", value: formatMpg(summary.worstMpg), unit: "MPG" },
    {
      label: "Cost per mile",
      value: summary.costPerMileCents !== null ? `${(summary.costPerMileCents).toFixed(1)}¢` : "—",
    },
    { label: "Avg price", value: formatPricePerGallon(summary.avgPriceCents), unit: "/gal" },
    { label: "Fuel total", value: formatUSD(summary.totalCostCents) },
  ];
  return `
    <div class="stat-grid">
      ${cells
        .map(
          (cell) => `
        <div class="stat-cell">
          <span class="stat-value">${escapeHtml(cell.value)}${cell.unit ? `<span class="stat-unit">${escapeHtml(cell.unit)}</span>` : ""}</span>
          <span class="stat-label">${escapeHtml(cell.label)}</span>
        </div>`
        )
        .join("")}
    </div>
  `;
}

function serviceRowHtml(service, ctx) {
  const status = serviceStatus(service, ctx);
  // The row itself opens the edit sheet (which holds Delete); only the one
  // action you actually came here for gets a button of its own.
  return `
    <div class="row service-row tappable ${status.key}" data-act="edit-service" data-id="${service.id}">
      <div class="row-main">
        <span class="row-title-text">${escapeHtml(service.title)}</span>
        <span class="row-meta">${escapeHtml(dueSummary(service, ctx.odometerMiles))}</span>
        ${service.shop ? `<span class="row-meta">${escapeHtml(service.shop)}</span>` : ""}
        ${service.notes ? `<span class="row-note">${escapeHtml(service.notes)}</span>` : ""}
      </div>
      <div class="row-side">
        <span class="badge ${status.key}">${escapeHtml(status.label)}</span>
        <button class="approve small" data-act="complete-service" data-id="${service.id}">Mark done</button>
      </div>
    </div>
  `;
}

function serviceHistoryRowHtml(service) {
  const bits = [
    service.servicedOn ? formatISO(service.servicedOn) : null,
    service.odometerMiles !== null && service.odometerMiles !== undefined
      ? formatMiles(service.odometerMiles)
      : null,
    service.shop || null,
  ].filter(Boolean);

  return `
    <div class="row service-row done tappable" data-act="edit-service" data-id="${service.id}">
      <div class="row-main">
        <span class="row-title-text">${escapeHtml(service.title)}</span>
        <span class="row-meta">${escapeHtml(bits.join(" · "))}</span>
        ${service.notes ? `<span class="row-note">${escapeHtml(service.notes)}</span>` : ""}
      </div>
      <div class="row-side">
        ${service.costCents ? `<span class="row-amount">${formatUSD(service.costCents)}</span>` : ""}
      </div>
    </div>
  `;
}

function fillupRowHtml(entry) {
  const excluded = entry.mpg !== null && entry.counted === false;
  const detail = [
    formatGallons(entry.gallons),
    entry.totalCents ? formatUSD(entry.totalCents) : null,
    entry.totalCents ? `${formatPricePerGallon(entry.pricePerGallonCents)}/gal` : null,
    entry.station || null,
  ]
    .filter(Boolean)
    .join(" · ");

  return `
    <div class="row fillup-row tappable" data-act="edit-fillup" data-id="${entry.id}">
      <div class="row-main">
        <span class="row-title-text">${escapeHtml(formatMiles(entry.odometerMiles))}
          <span class="row-date">${escapeHtml(formatISO(entry.filledOn, { withYear: "auto" }))}</span>
        </span>
        <span class="row-meta">${escapeHtml(detail)}</span>
        ${entry.fullTank ? "" : `<span class="row-tag">partial fill</span>`}
        ${excluded ? `<span class="row-tag warn">not counted · ${escapeHtml(entry.excludedReason)}</span>` : ""}
      </div>
      <div class="row-side">
        <span class="row-mpg ${excluded ? "excluded" : ""}">${entry.mpg !== null ? `${formatMpg(entry.mpg)}<span class="stat-unit">MPG</span>` : ""}</span>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function handleVehicleAction(action, id, state) {
  const { vehicle } = state;
  if (!vehicle) return;
  const odometerMiles = currentOdometer(vehicle, state.fillups, state.services);

  switch (action) {
    case "log-fuel":
      openFillupForm(state, null);
      break;
    case "edit-fillup":
      openFillupForm(state, state.fillups.find((f) => f.id === id) || null);
      break;
    case "log-service":
      openAddServiceMenu(state, odometerMiles);
      break;
    case "edit-service": {
      const service = state.services.find((s) => s.id === id);
      if (!service) return;
      if (service.status === "done") openCompletedServiceForm(state, service, odometerMiles);
      else openScheduleServiceForm(state, service, odometerMiles);
      break;
    }
    case "complete-service":
      openCompletedServiceForm(state, state.services.find((s) => s.id === id) || null, odometerMiles, {
        completing: true,
      });
      break;
    case "vehicle-menu":
      openVehicleMenu(state);
      break;
    case "toggle-fillups":
      state.showAllFillups = !state.showAllFillups;
      document.getElementById("vehicle-body").innerHTML = vehicleBodyHtml(state);
      break;
    case "toggle-history":
      state.showHistory = !state.showHistory;
      document.getElementById("vehicle-body").innerHTML = vehicleBodyHtml(state);
      break;
  }
}

// The odometer is whatever the highest reading anywhere is: the number entered
// when the vehicle was added, or any fill-up or completed service since.
function currentOdometer(vehicle, fillups, services) {
  const readings = [
    vehicle.startOdometerMiles,
    ...fillups.map((f) => f.odometerMiles),
    ...services.map((s) => s.odometerMiles),
  ].filter((n) => typeof n === "number" && Number.isFinite(n));
  return readings.length ? Math.max(...readings) : null;
}

async function openFillupForm(state, existing) {
  const odometerMiles = currentOdometer(state.vehicle, state.fillups, state.services);
  // Only fill-ups that produce an MPG reading can be counted or not, so the
  // toggle appears for those and stays out of the way otherwise.
  const reading = existing ? computeFuelStats(state.fillups).entries.find((e) => e.id === existing.id) : null;
  const hasReading = !!reading && reading.mpg !== null;
  const draft = existing
    ? {
        odometer: String(existing.odometerMiles ?? ""),
        gallons: String(existing.gallons ?? ""),
        total: existing.totalCents ? (existing.totalCents / 100).toFixed(2) : "",
        fullTank: existing.fullTank !== false,
        filledOn: existing.filledOn || todayISO(),
        station: existing.station || "",
      }
    : { odometer: "", gallons: "", total: "", fullTank: true, filledOn: todayISO(), station: "" };

  const values = await openFillupFormWith(draft, odometerMiles, !!existing, hasReading ? reading : null);
  if (!values) return;
  if (values.__destructive) {
    await deleteFillup(state, existing.id);
    return;
  }

  const payload = {
    odometerMiles: Math.round(Number(values.odometer)),
    gallons: Number(values.gallons),
    totalCents: values.total ? dollarsToCents(values.total) : 0,
    fullTank: values.fullTank,
    filledOn: values.filledOn,
    station: values.station || null,
  };

  if (hasReading) {
    // Store an explicit choice only where it actually overrides what the app
    // would have decided; otherwise leave it on automatic.
    payload.countTowardMpg = values.countMpg
      ? (wouldAutoExclude(state, existing.id) ? true : null)
      : false;
  }

  if (existing) {
    await updateDoc(doc(db, "vehicles", state.id, "fillups", existing.id), payload);
  } else {
    await addDoc(collection(db, "vehicles", state.id, "fillups"), {
      ...payload,
      createdAt: serverTimestamp(),
    });
  }
  await recomputeSummary(state.id);
  showToast(existing ? "Fill-up updated" : "Fill-up logged");
}

// Asks what the outlier check would say about this reading on its own merits,
// ignoring any choice already made about it.
function wouldAutoExclude(state, id) {
  const fillups = state.fillups.map((f) => (f.id === id ? { ...f, countTowardMpg: null } : f));
  const entry = computeFuelStats(fillups).entries.find((e) => e.id === id);
  return !!entry && entry.mpg !== null && entry.counted === false;
}

// Split out so a rejected odometer sanity-check can reopen the sheet with what
// was already typed instead of making someone enter it all again.
async function openFillupFormWith(draft, odometerMiles, isEdit, reading = null) {
  const values = await openFormModal({
    title: isEdit ? "Edit fill-up" : "Log fill-up",
    fields: [
      {
        name: "odometer",
        label: "Odometer (mi)",
        type: "number",
        inputmode: "numeric",
        min: 0,
        half: true,
        value: draft.odometer,
        placeholder: odometerMiles !== null ? String(odometerMiles) : "48210",
      },
      {
        name: "filledOn",
        label: "Date",
        type: "date",
        half: true,
        value: draft.filledOn,
      },
      {
        name: "gallons",
        label: "Gallons",
        type: "number",
        step: "0.001",
        inputmode: "decimal",
        min: 0,
        half: true,
        value: draft.gallons,
        placeholder: "12.483",
      },
      {
        name: "total",
        label: "Total cost",
        type: "number",
        step: "0.01",
        inputmode: "decimal",
        min: 0,
        half: true,
        value: draft.total,
        placeholder: "41.24",
      },
      { name: "station", label: "Station (optional)", type: "text", value: draft.station, placeholder: "Costco on Main" },
      {
        name: "fullTank",
        label: "Filled the tank all the way",
        type: "checkbox",
        value: draft.fullTank,
        hint: "MPG is measured between full tanks. Leave this off for a partial fill and its gallons roll into the next full one.",
      },
      ...(reading
        ? [
            {
              name: "countMpg",
              label: `Count this ${formatMpg(reading.mpg)} MPG toward your averages`,
              type: "checkbox",
              value: reading.counted,
              hint: reading.counted
                ? "Untick to leave this reading out of the average, best and worst."
                : `Left out: ${reading.excludedReason}. Tick to count it anyway.`,
            },
          ]
        : []),
    ],
    submitLabel: isEdit ? "Save changes" : "Log fill-up",
    destructive: isEdit ? { label: "Delete this fill-up" } : null,
    validate: (v) => {
      const odo = Number(v.odometer);
      if (!v.odometer || !Number.isFinite(odo) || odo < 0) return "Enter the odometer reading.";
      const gallons = Number(v.gallons);
      if (!v.gallons || !Number.isFinite(gallons) || gallons <= 0) return "Enter how many gallons you put in.";
      if (v.total && Number.isNaN(dollarsToCents(v.total))) return "That total doesn't look like an amount.";
      if (!v.filledOn) return "Pick the date you filled up.";
      return null;
    },
  });
  if (!values || values.__destructive) return values;

  // Typos here quietly wreck every MPG figure after them, so a reading that
  // goes backwards gets a second look rather than a silent save.
  if (!isEdit && odometerMiles !== null && Number(values.odometer) < odometerMiles) {
    const ok = await openConfirmModal({
      title: "Odometer went backwards",
      message: `You entered ${formatMiles(Number(values.odometer))}, which is below the highest reading on record (${formatMiles(odometerMiles)}). Save it anyway?`,
      confirmLabel: "Save anyway",
    });
    if (!ok) {
      return openFillupFormWith({ ...values, fullTank: values.fullTank }, odometerMiles, isEdit, reading);
    }
  }
  return values;
}

async function deleteFillup(state, id) {
  const ok = await openConfirmModal({
    title: "Delete fill-up?",
    message: "This removes it from the gas log and recalculates the MPG around it.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  await deleteDoc(doc(db, "vehicles", state.id, "fillups", id));
  await recomputeSummary(state.id);
}

function openAddServiceMenu(state, odometerMiles) {
  openPickerModal({
    title: "Add service",
    options: [
      { value: "schedule", label: "📅 Schedule something coming up" },
      { value: "done", label: "✅ Log service already done" },
    ],
  }).then((choice) => {
    if (choice === "schedule") openScheduleServiceForm(state, null, odometerMiles);
    else if (choice === "done") openCompletedServiceForm(state, null, odometerMiles);
  });
}

async function openScheduleServiceForm(state, existing, odometerMiles) {
  const values = await openFormModal({
    title: existing ? "Edit scheduled service" : "Schedule service",
    hint: "Set a date, a mileage, or both — whichever comes first is what the reminder goes by.",
    fields: [
      {
        name: "title",
        label: "Service",
        type: "text",
        value: existing?.title || "",
        placeholder: "Oil change",
        suggestions: SERVICE_SUGGESTIONS,
      },
      { name: "dueOn", label: "Due date", type: "date", half: true, value: existing?.dueOn || "" },
      {
        name: "dueOdometer",
        label: "Due at (mi)",
        type: "number",
        inputmode: "numeric",
        min: 0,
        half: true,
        value: existing?.dueOdometerMiles != null ? String(existing.dueOdometerMiles) : "",
        placeholder: odometerMiles !== null ? String(odometerMiles + 5000) : "53000",
      },
      { name: "shop", label: "Shop (optional)", type: "text", value: existing?.shop || "", placeholder: "Dave's Auto" },
      { name: "notes", label: "Notes (optional)", type: "textarea", value: existing?.notes || "" },
    ],
    submitLabel: existing ? "Save changes" : "Schedule it",
    destructive: existing ? { label: "Delete this service" } : null,
    validate: (v) => {
      if (!v.title) return "What service is it?";
      if (!v.dueOn && !v.dueOdometer) return "Add a due date, a due mileage, or both.";
      if (v.dueOdometer && !Number.isFinite(Number(v.dueOdometer))) return "That mileage doesn't look right.";
      return null;
    },
  });
  if (!values) return;
  if (values.__destructive) {
    await deleteService(state, existing.id);
    return;
  }

  const payload = {
    title: values.title,
    status: "scheduled",
    dueOn: values.dueOn || null,
    dueOdometerMiles: values.dueOdometer ? Math.round(Number(values.dueOdometer)) : null,
    shop: values.shop || null,
    notes: values.notes || null,
  };

  if (existing) {
    await updateDoc(doc(db, "vehicles", state.id, "services", existing.id), payload);
  } else {
    await addDoc(collection(db, "vehicles", state.id, "services"), {
      ...payload,
      servicedOn: null,
      odometerMiles: null,
      costCents: null,
      repeatMiles: null,
      repeatMonths: null,
      createdAt: serverTimestamp(),
    });
  }
  showToast(existing ? "Service updated" : "Service scheduled");
  await recomputeSummary(state.id);
}

async function openCompletedServiceForm(state, existing, odometerMiles, { completing = false } = {}) {
  const isEditingDone = existing && existing.status === "done";
  const values = await openFormModal({
    title: completing ? "Mark service done" : isEditingDone ? "Edit service record" : "Log completed service",
    fields: [
      {
        name: "title",
        label: "Service",
        type: "text",
        value: existing?.title || "",
        placeholder: "Oil change",
        suggestions: SERVICE_SUGGESTIONS,
      },
      {
        name: "servicedOn",
        label: "Date",
        type: "date",
        half: true,
        value: existing?.servicedOn || todayISO(),
      },
      {
        name: "odometer",
        label: "Odometer (mi)",
        type: "number",
        inputmode: "numeric",
        min: 0,
        half: true,
        value:
          existing?.odometerMiles != null
            ? String(existing.odometerMiles)
            : odometerMiles !== null
              ? String(odometerMiles)
              : "",
      },
      {
        name: "cost",
        label: "Cost (optional)",
        type: "number",
        step: "0.01",
        inputmode: "decimal",
        min: 0,
        half: true,
        value: existing?.costCents ? (existing.costCents / 100).toFixed(2) : "",
        placeholder: "79.95",
      },
      {
        name: "shop",
        label: "Shop (optional)",
        type: "text",
        half: true,
        value: existing?.shop || "",
        placeholder: "Dave's Auto",
      },
      { name: "notes", label: "Notes (optional)", type: "textarea", value: existing?.notes || "" },
      {
        name: "repeatMiles",
        label: "Do it again in (mi)",
        type: "number",
        inputmode: "numeric",
        min: 0,
        half: true,
        value: existing?.repeatMiles != null ? String(existing.repeatMiles) : "",
        placeholder: "5000",
      },
      {
        name: "repeatMonths",
        label: "…or in (months)",
        type: "number",
        inputmode: "numeric",
        min: 0,
        half: true,
        value: existing?.repeatMonths != null ? String(existing.repeatMonths) : "",
        placeholder: "6",
      },
    ],
    submitLabel: completing ? "Mark done" : "Save",
    destructive: isEditingDone ? { label: "Delete this service record" } : null,
    validate: (v) => {
      if (!v.title) return "What service was it?";
      if (!v.servicedOn) return "Pick the date it was done.";
      if (v.cost && Number.isNaN(dollarsToCents(v.cost))) return "That cost doesn't look like an amount.";
      return null;
    },
  });
  if (!values) return;
  if (values.__destructive) {
    await deleteService(state, existing.id);
    return;
  }

  const odo = values.odometer ? Math.round(Number(values.odometer)) : null;
  const repeatMiles = values.repeatMiles ? Math.round(Number(values.repeatMiles)) : null;
  const repeatMonths = values.repeatMonths ? Math.round(Number(values.repeatMonths)) : null;

  const payload = {
    title: values.title,
    status: "done",
    servicedOn: values.servicedOn,
    odometerMiles: odo,
    costCents: values.cost ? dollarsToCents(values.cost) : null,
    shop: values.shop || null,
    notes: values.notes || null,
    repeatMiles,
    repeatMonths,
    dueOn: null,
    dueOdometerMiles: null,
  };

  const services = collection(db, "vehicles", state.id, "services");
  if (existing) {
    await updateDoc(doc(db, "vehicles", state.id, "services", existing.id), payload);
  } else {
    await addDoc(services, { ...payload, createdAt: serverTimestamp() });
  }

  // A repeat interval schedules the next one straight away, which is the whole
  // point of recording "every 5,000 miles" -- otherwise it lives in your head.
  if (repeatMiles || repeatMonths) {
    await addDoc(services, {
      title: values.title,
      status: "scheduled",
      dueOn: repeatMonths ? addMonthsISO(values.servicedOn, repeatMonths) : null,
      dueOdometerMiles: repeatMiles && odo !== null ? odo + repeatMiles : null,
      shop: values.shop || null,
      notes: null,
      servicedOn: null,
      odometerMiles: null,
      costCents: null,
      repeatMiles,
      repeatMonths,
      createdAt: serverTimestamp(),
    });
    showToast("Logged — next one scheduled");
  } else {
    showToast("Service logged");
  }

  await recomputeSummary(state.id);
}

async function deleteService(state, id) {
  const ok = await openConfirmModal({
    title: "Delete service?",
    message: "This removes it from the schedule and the history.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  await deleteDoc(doc(db, "vehicles", state.id, "services", id));
  await recomputeSummary(state.id);
}

function openVehicleMenu(state) {
  openPickerModal({
    title: state.vehicle.name,
    options: [
      { value: "edit", label: "Edit details" },
      { value: "import", label: "Import fill-ups from a spreadsheet" },
      { value: "qr", label: "Show QR code" },
      { value: "delete", label: "Delete vehicle" },
    ],
  }).then((choice) => {
    if (choice === "edit") openEditVehicleForm(state);
    else if (choice === "import") startImport(state);
    else if (choice === "qr") openQrModal(location.href, `Scan to open ${state.vehicle.name}`);
    else if (choice === "delete") deleteVehicle(state);
  });
}

async function openEditVehicleForm(state) {
  const { vehicle } = state;
  const values = await openFormModal({
    title: "Edit vehicle",
    fields: [
      { name: "name", label: "Name", type: "text", value: vehicle.name || "" },
      { name: "year", label: "Year", type: "number", inputmode: "numeric", half: true, value: vehicle.year || "" },
      { name: "make", label: "Make", type: "text", half: true, value: vehicle.make || "" },
      { name: "model", label: "Model", type: "text", half: true, value: vehicle.model || "" },
      {
        name: "startOdometer",
        label: "Starting odometer",
        type: "number",
        inputmode: "numeric",
        min: 0,
        half: true,
        value: vehicle.startOdometerMiles != null ? String(vehicle.startOdometerMiles) : "",
        hint: "Only used until your first fill-up or service gives a newer reading.",
      },
    ],
    submitLabel: "Save changes",
    validate: (v) => (v.name ? null : "The vehicle needs a name."),
  });
  if (!values) return;

  await updateDoc(doc(db, "vehicles", state.id), {
    name: values.name,
    year: values.year || null,
    make: values.make || null,
    model: values.model || null,
    startOdometerMiles: values.startOdometer ? Math.round(Number(values.startOdometer)) : null,
  });
  await recomputeSummary(state.id);
  showToast("Vehicle updated");
}

async function deleteVehicle(state) {
  const ok = await openConfirmModal({
    title: "Delete vehicle?",
    message: `This deletes ${state.vehicle.name} along with its gas log and service records. It can't be undone.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;

  // Deleting a document doesn't touch what's underneath it, so the fill-ups and
  // service records have to go explicitly or they'd linger as orphans.
  const batch = writeBatch(db);
  for (const sub of ["fillups", "services"]) {
    const snap = await getDocs(collection(db, "vehicles", state.id, sub));
    snap.forEach((docSnap) => batch.delete(docSnap.ref));
  }
  batch.delete(doc(db, "vehicles", state.id));
  await batch.commit();
  location.search = "";
}

// ---------------------------------------------------------------------------
// Importing a gas log from a spreadsheet
//
// import.js works out what the file contains and gets it confirmed; this part
// is only the writing, which it hands back here so that module never has to
// know Firestore exists.
// ---------------------------------------------------------------------------

// The spreadsheet readers are a good chunk of code that most sessions never
// touch, so they're fetched at the moment someone actually imports rather than
// on every load of the app at a gas pump.
async function startImport(state) {
  const { openImportModal } = await import("./import.js");
  openImportModal({
    vehicleName: state.vehicle.name,
    existingFillups: state.fillups,
    onImport: async (entries, onProgress) => {
      const written = await writeImportedFillups(state.id, entries, onProgress);
      await recomputeSummary(state.id);
      showToast(`Imported ${written} fill-up${written === 1 ? "" : "s"}`);
    },
  });
}

// Firestore takes at most 500 writes in a batch, so a long history goes up in
// chunks -- with the count reported back so the button can say where it's got to.
const IMPORT_CHUNK = 400;

async function writeImportedFillups(vehicleId, entries, onProgress) {
  const fillups = collection(db, "vehicles", vehicleId, "fillups");
  let written = 0;

  for (let start = 0; start < entries.length; start += IMPORT_CHUNK) {
    const chunk = entries.slice(start, start + IMPORT_CHUNK);
    const batch = writeBatch(db);
    for (const entry of chunk) {
      batch.set(doc(fillups), {
        odometerMiles: entry.odometerMiles,
        gallons: entry.gallons,
        totalCents: entry.totalCents,
        fullTank: entry.fullTank,
        filledOn: entry.filledOn,
        station: entry.station,
        source: "import",
        createdAt: serverTimestamp(),
      });
    }
    await batch.commit();
    written += chunk.length;
    onProgress(written);
  }

  return written;
}

// ---------------------------------------------------------------------------
// Denormalized summary
//
// The garage list wants each vehicle's odometer, average MPG, and next service
// without reading every fill-up for every vehicle, so those three are cached on
// the vehicle document and refreshed after each write.
// ---------------------------------------------------------------------------

async function recomputeSummary(id) {
  const [fillupsSnap, servicesSnap, vehicleSnap] = await Promise.all([
    getDocs(collection(db, "vehicles", id, "fillups")),
    getDocs(collection(db, "vehicles", id, "services")),
    getDocs(collection(db, "vehicles")),
  ]);

  const fillups = fillupsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const services = servicesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const vehicleDoc = vehicleSnap.docs.find((d) => d.id === id);
  if (!vehicleDoc) return;

  const { summary } = computeFuelStats(fillups);
  const odometerMiles = currentOdometer(vehicleDoc.data(), fillups, services);
  const ctx = { odometerMiles, today: new Date() };
  const open = services.filter((s) => s.status !== "done").sort((a, b) => compareServices(a, b, ctx));
  const next = open[0] || null;

  await updateDoc(doc(db, "vehicles", id), {
    odometerMiles,
    avgMpg: summary.avgMpg,
    lastMpg: summary.lastMpg,
    statsVersion: STATS_VERSION,
    nextService: next
      ? {
          title: next.title,
          dueOn: next.dueOn ?? null,
          dueOdometerMiles: next.dueOdometerMiles ?? null,
        }
      : null,
  });
}

route();
