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
import {
  computeFuelStats,
  serviceStatus,
  compareServices,
  serviceItems,
  itemsTotalCents,
  visitTitle,
  scheduleRows,
  completedJobs,
  STATS_VERSION,
} from "./stats.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const $app = document.getElementById("app");

const params = new URLSearchParams(location.search);
const vehicleId = params.get("vehicle");
const isNewVehiclePage = params.has("new");
const isSchedulePage = params.has("schedule");

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
  } else if (vehicleId && isSchedulePage) {
    renderScheduleView(vehicleId);
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
        ${photoTagHtml(service)}
      </div>
      <div class="row-side">
        <span class="badge ${status.key}">${escapeHtml(status.label)}</span>
        <button class="approve small" data-act="complete-service" data-id="${service.id}">Mark done</button>
      </div>
    </div>
  `;
}

// A record with receipts says so, without the list having to load any of them.
function photoTagHtml(service) {
  const count = service.photoCount || 0;
  if (!count) return "";
  return `<span class="row-tag photo">📎 ${count} receipt${count === 1 ? "" : "s"}</span>`;
}

function serviceHistoryRowHtml(service) {
  const bits = [
    service.servicedOn ? formatISO(service.servicedOn) : null,
    service.odometerMiles !== null && service.odometerMiles !== undefined
      ? formatMiles(service.odometerMiles)
      : null,
    service.shop || null,
  ].filter(Boolean);

  const items = serviceItems(service);
  // One job reads as it always has. Several are broken out underneath, each
  // with what it cost, since that's the point of entering them separately.
  const breakdown =
    items.length > 1
      ? `<ul class="item-breakdown">
           ${items
             .map(
               (item) => `
             <li>
               <span>${escapeHtml(item.title)}${item.notes ? `<span class="item-note">${escapeHtml(item.notes)}</span>` : ""}</span>
               <span class="item-cost">${item.costCents ? escapeHtml(formatUSD(item.costCents)) : ""}</span>
             </li>`
             )
             .join("")}
         </ul>`
      : items[0] && items[0].notes
        ? `<span class="row-note">${escapeHtml(items[0].notes)}</span>`
        : "";

  return `
    <div class="row service-row done tappable" data-act="edit-service" data-id="${service.id}">
      <div class="row-main">
        <span class="row-title-text">${escapeHtml(service.title)}</span>
        <span class="row-meta">${escapeHtml(bits.join(" · "))}</span>
        ${breakdown}
        ${photoTagHtml(service)}
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
  const existingPhotos = existing ? await loadServicePhotos(state.id, existing.id) : [];
  const values = await openFormModal({
    title: completing ? "Mark service done" : isEditingDone ? "Edit service record" : "Log completed service",
    fields: [
      {
        name: "items",
        label: "What was done",
        type: "list",
        value: existing ? serviceItems(existing) : [],
        suggestions: SERVICE_SUGGESTIONS,
        hint: "One trip, several jobs — add a line for each. The total is added up for you.",
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
        name: "shop",
        label: "Shop (optional)",
        type: "text",
        half: true,
        value: existing?.shop || "",
        placeholder: "Dave's Auto",
      },
      {
        name: "photos",
        label: "Receipt photos (optional)",
        type: "photos",
        value: existingPhotos,
        hint: "Photographed receipts are shrunk to fit before they're saved — enough to read, not enough to fill up your database.",
      },
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
      const named = (v.items || []).filter((item) => item.title);
      if (!named.length) return "What was done? Add at least one item.";
      if (!v.servicedOn) return "Pick the date it was done.";
      if ((v.items || []).some((item) => item.costCents !== null && Number.isNaN(item.costCents))) {
        return "One of those costs doesn't look like an amount.";
      }
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

  const items = (values.items || []).filter((item) => item.title);
  const payload = {
    title: visitTitle(items),
    status: "done",
    servicedOn: values.servicedOn,
    odometerMiles: odo,
    items,
    // Kept alongside the items so lists and totals don't have to add them up
    // every time they render.
    costCents: itemsTotalCents(items),
    shop: values.shop || null,
    // Notes belong to the item they're about now; the field stays on the record
    // so anything written before this still reads back.
    notes: null,
    repeatMiles,
    repeatMonths,
    dueOn: null,
    dueOdometerMiles: null,
  };

  const services = collection(db, "vehicles", state.id, "services");
  let serviceId;
  if (existing) {
    serviceId = existing.id;
    await updateDoc(doc(db, "vehicles", state.id, "services", existing.id), payload);
  } else {
    // Photos picked while filling the sheet in are written once the record they
    // belong to exists, so a receipt can be attached as the service is logged
    // rather than after saving and reopening it.
    serviceId = (await addDoc(services, { ...payload, createdAt: serverTimestamp() })).id;
  }
  await saveServicePhotos(state.id, serviceId, values.photos);

  // A repeat interval schedules the next one straight away, which is the whole
  // point of recording "every 5,000 miles" -- otherwise it lives in your head.
  if (repeatMiles || repeatMonths) {
    await addDoc(services, {
      title: payload.title,
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
  await deleteServicePhotos(state.id, id);
  await deleteDoc(doc(db, "vehicles", state.id, "services", id));
  await recomputeSummary(state.id);
}

function openVehicleMenu(state) {
  openPickerModal({
    title: state.vehicle.name,
    options: [
      { value: "schedule", label: "Service schedule" },
      { value: "edit", label: "Edit details" },
      { value: "import", label: "Import from a spreadsheet" },
      { value: "qr", label: "Show QR code" },
      { value: "delete", label: "Delete vehicle" },
    ],
  }).then((choice) => {
    if (choice === "schedule") location.search = `?vehicle=${state.id}&schedule`;
    else if (choice === "edit") openEditVehicleForm(state);
    else if (choice === "import") chooseImport(state);
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

  // Deleting a document doesn't touch what's underneath it, so the fill-ups,
  // service records and any receipts under those have to go explicitly or
  // they'd linger as orphans.
  const batch = writeBatch(db);
  const serviceSnap = await getDocs(collection(db, "vehicles", state.id, "services"));
  for (const service of serviceSnap.docs) {
    const photoSnap = await getDocs(collection(db, "vehicles", state.id, "services", service.id, "photos"));
    photoSnap.forEach((photo) => batch.delete(photo.ref));
  }
  for (const sub of ["fillups", "services", "schedule"]) {
    const snap = await getDocs(collection(db, "vehicles", state.id, sub));
    snap.forEach((docSnap) => batch.delete(docSnap.ref));
  }
  batch.delete(doc(db, "vehicles", state.id));
  await batch.commit();
  location.search = "";
}

// ---------------------------------------------------------------------------
// Service schedule
//
// The rest of the app records what happened. This page records what's supposed
// to happen: how often each job comes round on this vehicle. Intervals sit on
// the vehicle because they differ between them -- a van that tows wants its oil
// changed sooner than a car that does the school run.
//
// Nothing here is a reminder in its own right; the next-due figures are worked
// out from the history every time the page opens, so logging a service moves
// them on its own. "Add to service list" is there for when you want one to show
// up alongside the jobs you've booked in.
// ---------------------------------------------------------------------------

function renderScheduleView(id) {
  $app.innerHTML = `
    <a class="back-link" href="?vehicle=${encodeURIComponent(id)}">&larr; Back</a>
    <div id="schedule-body"><p class="loading">Loading…</p></div>
  `;

  const bodyEl = document.getElementById("schedule-body");
  const state = { id, vehicle: null, services: null, fillups: [], schedule: null };

  bodyEl.addEventListener("click", (event) => {
    const target = event.target.closest("[data-act]");
    if (target) handleScheduleAction(target.dataset.act, target.dataset.id, state);
  });

  const render = () => {
    if (!state.vehicle || !state.services || !state.schedule) return;
    bodyEl.innerHTML = scheduleBodyHtml(state);
  };

  onSnapshot(doc(db, "vehicles", id), (snap) => {
    if (!snap.exists()) {
      bodyEl.innerHTML = `<div class="card"><p class="empty">This vehicle doesn't exist any more.</p></div>`;
      return;
    }
    state.vehicle = { id: snap.id, ...snap.data() };
    render();
  });
  onSnapshot(collection(db, "vehicles", id, "services"), (snap) => {
    state.services = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  onSnapshot(collection(db, "vehicles", id, "fillups"), (snap) => {
    state.fillups = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  onSnapshot(collection(db, "vehicles", id, "schedule"), (snap) => {
    state.schedule = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
}

function scheduleBodyHtml(state) {
  const odometerMiles = currentOdometer(state.vehicle, state.fillups, state.services);
  const rows = scheduleRows(state.schedule, state.services, { odometerMiles, today: new Date() });

  return `
    <h1><span class="emoji">🔧</span>Service schedule</h1>
    <p class="hint">${escapeHtml(state.vehicle.name)} · ${formatMiles(odometerMiles)} on the odometer.
    How often each job comes round, and when it's next needed. Worked out from what you've
    logged, so it moves on its own as you log more.</p>

    ${
      rows.length
        ? `<div class="list schedule-list">${rows.map((row) => scheduleRowHtml(row, odometerMiles)).join("")}</div>`
        : `<p class="empty small">Nothing set up yet. Add the jobs this vehicle needs on a
           schedule — an oil change every 5,000 miles, an inspection every year — and this page
           will tell you when each one is next due.</p>`
    }

    <button class="secondary full-action" data-act="add-plan">+ Add a service</button>
  `;
}

function intervalText(entry) {
  const parts = [];
  if (entry.everyMiles) parts.push(`every ${entry.everyMiles.toLocaleString()} mi`);
  if (entry.everyMonths) parts.push(`every ${entry.everyMonths} month${entry.everyMonths === 1 ? "" : "s"}`);
  return parts.join(" or ") || "no interval set";
}

function scheduleRowHtml(row, odometerMiles) {
  const lastDone = row.lastDone
    ? `last done ${[
        row.lastDone.servicedOn ? formatISO(row.lastDone.servicedOn) : null,
        row.lastDone.odometerMiles !== null ? `at ${formatMiles(row.lastDone.odometerMiles)}` : null,
      ]
        .filter(Boolean)
        .join(" ")}`
    : "never logged — the first one you log starts the clock";

  const next = row.neverDone
    ? ""
    : `<span class="row-meta">next: ${escapeHtml(dueSummary(row, odometerMiles))}</span>`;

  const canSchedule = row.status.key === "overdue" || row.status.key === "soon";

  return `
    <div class="row service-row ${row.status.key} tappable" data-act="edit-plan" data-id="${row.id}">
      <div class="row-main">
        <span class="row-title-text">${escapeHtml(row.title)}</span>
        <span class="row-meta">${escapeHtml(intervalText(row))}</span>
        <span class="row-meta">${escapeHtml(lastDone)}</span>
        ${next}
      </div>
      <div class="row-side">
        <span class="badge ${row.status.key}">${escapeHtml(row.status.label)}</span>
        ${canSchedule ? `<button class="approve small" data-act="book-plan" data-id="${row.id}">Add to list</button>` : ""}
      </div>
    </div>
  `;
}

function handleScheduleAction(action, id, state) {
  if (!state.vehicle) return;
  switch (action) {
    case "add-plan":
      openPlanForm(state, null);
      break;
    case "edit-plan":
      openPlanForm(state, state.schedule.find((entry) => entry.id === id) || null);
      break;
    case "book-plan":
      bookPlanEntry(state, id);
      break;
  }
}

async function openPlanForm(state, existing) {
  // Offer what this vehicle has actually had done as well as the usual list, so
  // the wording matches the history and the two line up.
  const seen = [...new Set(completedJobs(state.services).map((job) => job.title))];
  const suggestions = [...new Set([...seen, ...SERVICE_SUGGESTIONS])];

  const values = await openFormModal({
    title: existing ? "Edit schedule entry" : "Add to the schedule",
    hint: "Set a mileage interval, a time interval, or both — whichever comes round first is what counts.",
    fields: [
      {
        name: "title",
        label: "Service",
        type: "text",
        value: existing?.title || "",
        placeholder: "Oil change",
        suggestions,
      },
      {
        name: "everyMiles",
        label: "Every (mi)",
        type: "number",
        inputmode: "numeric",
        min: 0,
        half: true,
        value: existing?.everyMiles != null ? String(existing.everyMiles) : "",
        placeholder: "5000",
      },
      {
        name: "everyMonths",
        label: "…or every (months)",
        type: "number",
        inputmode: "numeric",
        min: 0,
        half: true,
        value: existing?.everyMonths != null ? String(existing.everyMonths) : "",
        placeholder: "6",
      },
    ],
    submitLabel: existing ? "Save changes" : "Add it",
    destructive: existing ? { label: "Remove from the schedule" } : null,
    validate: (v) => {
      if (!v.title) return "What service is it?";
      if (!v.everyMiles && !v.everyMonths) return "Add a mileage interval, a time interval, or both.";
      return null;
    },
  });
  if (!values) return;

  if (values.__destructive) {
    await deleteDoc(doc(db, "vehicles", state.id, "schedule", existing.id));
    showToast("Removed from the schedule");
    return;
  }

  const payload = {
    title: values.title,
    everyMiles: values.everyMiles ? Math.round(Number(values.everyMiles)) : null,
    everyMonths: values.everyMonths ? Math.round(Number(values.everyMonths)) : null,
  };

  if (existing) {
    await updateDoc(doc(db, "vehicles", state.id, "schedule", existing.id), payload);
  } else {
    await addDoc(collection(db, "vehicles", state.id, "schedule"), { ...payload, createdAt: serverTimestamp() });
  }
  showToast(existing ? "Schedule updated" : "Added to the schedule");
}

// Turns a due entry into a real scheduled job, so it appears in the vehicle's
// service list and on the garage badge alongside anything booked in by hand.
async function bookPlanEntry(state, id) {
  const odometerMiles = currentOdometer(state.vehicle, state.fillups, state.services);
  const row = scheduleRows(state.schedule, state.services, { odometerMiles, today: new Date() })
    .find((entry) => entry.id === id);
  if (!row) return;

  const alreadyThere = state.services.some(
    (service) => service.status !== "done" && String(service.title).toLowerCase() === row.title.toLowerCase()
  );
  if (alreadyThere) {
    await openAlertModal(`${row.title} is already on the service list.`);
    return;
  }

  await addDoc(collection(db, "vehicles", state.id, "services"), {
    title: row.title,
    status: "scheduled",
    dueOn: row.dueOn,
    dueOdometerMiles: row.dueOdometerMiles,
    shop: null,
    notes: null,
    servicedOn: null,
    odometerMiles: null,
    costCents: null,
    repeatMiles: row.everyMiles,
    repeatMonths: row.everyMonths,
    createdAt: serverTimestamp(),
  });
  await recomputeSummary(state.id);
  showToast(`${row.title} added to the service list`);
}

// ---------------------------------------------------------------------------
// Receipt photos
//
// One document per photo in a subcollection under the service record, so the
// service list stays light: it reads the records themselves, and the pictures
// are only fetched when a record is opened. The count is kept on the record so
// the list can show a paperclip without reading any of them.
// ---------------------------------------------------------------------------

async function loadServicePhotos(vehicleId, serviceId) {
  const snap = await getDocs(collection(db, "vehicles", vehicleId, "services", serviceId, "photos"));
  return snap.docs
    .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
    .sort((a, b) => String(a.addedOn || "").localeCompare(String(b.addedOn || "")));
}

// Deleting a document leaves whatever is underneath it, so the photos have to
// go explicitly or they'd linger unreachable.
async function deleteServicePhotos(vehicleId, serviceId) {
  const snap = await getDocs(collection(db, "vehicles", vehicleId, "services", serviceId, "photos"));
  await Promise.all(snap.docs.map((docSnap) => deleteDoc(docSnap.ref)));
}

async function saveServicePhotos(vehicleId, serviceId, photos) {
  if (!photos) return;
  const { items = [], removedIds = [] } = photos;
  const photosRef = collection(db, "vehicles", vehicleId, "services", serviceId, "photos");

  for (const id of removedIds) {
    await deleteDoc(doc(db, "vehicles", vehicleId, "services", serviceId, "photos", id));
  }
  for (const photo of items) {
    if (photo.id) continue; // already stored
    await addDoc(photosRef, {
      dataUrl: photo.dataUrl,
      width: photo.width,
      height: photo.height,
      bytes: photo.bytes,
      addedOn: new Date().toISOString(),
      createdAt: serverTimestamp(),
    });
  }

  // Kept on the record itself so the list can show the paperclip cheaply.
  await updateDoc(doc(db, "vehicles", vehicleId, "services", serviceId), { photoCount: items.length });
}

// ---------------------------------------------------------------------------
// Importing a gas log from a spreadsheet
//
// import.js works out what the file contains and gets it confirmed; this part
// is only the writing, which it hands back here so that module never has to
// know Firestore exists.
// ---------------------------------------------------------------------------

function chooseImport(state) {
  openPickerModal({
    title: "Import from a spreadsheet",
    options: [
      { value: "fillups", label: "⛽ Fill-ups" },
      { value: "services", label: "🔧 Service records" },
    ],
  }).then((choice) => {
    if (choice) startImport(state, choice);
  });
}

// The spreadsheet readers are a good chunk of code that most sessions never
// touch, so they're fetched at the moment someone actually imports rather than
// on every load of the app at a gas pump.
async function startImport(state, kind) {
  const { openImportModal, PROFILES } = await import("./import.js");
  const importingFuel = kind === "fillups";

  openImportModal({
    profile: PROFILES[kind],
    vehicleName: state.vehicle.name,
    existing: importingFuel ? state.fillups : state.services,
    onImport: async (entries, onProgress) => {
      const written = importingFuel
        ? await writeImported(state.id, "fillups", entries, fillupDoc, onProgress)
        : await writeImported(state.id, "services", entries, serviceDoc, onProgress);
      await recomputeSummary(state.id);
      const noun = importingFuel ? "fill-up" : "service record";
      showToast(`Imported ${written} ${noun}${written === 1 ? "" : "s"}`);
    },
  });
}

const fillupDoc = (entry) => ({
  odometerMiles: entry.odometerMiles,
  gallons: entry.gallons,
  totalCents: entry.totalCents,
  fullTank: entry.fullTank,
  filledOn: entry.filledOn,
  station: entry.station,
});

// Imported service records keep the same shape as ones added by hand, so
// nothing downstream has to know where they came from. A repeat interval isn't
// set here on purpose: a history of twelve oil changes would otherwise schedule
// twelve identical reminders.
const serviceDoc = (entry) => ({
  title: entry.title,
  status: entry.recordStatus,
  // Rows from one trip to the shop arrive already folded into a single visit,
  // each job a line on it.
  items: entry.items || [{ title: entry.title, costCents: entry.costCents, notes: entry.notes }],
  servicedOn: entry.servicedOn,
  odometerMiles: entry.odometerMiles,
  costCents: entry.costCents,
  shop: entry.shop,
  notes: entry.notes,
  dueOn: entry.dueOn,
  dueOdometerMiles: entry.dueOdometerMiles,
  repeatMiles: null,
  repeatMonths: null,
});

// Firestore takes at most 500 writes in a batch, so a long history goes up in
// chunks -- with the count reported back so the button can say where it's got to.
const IMPORT_CHUNK = 400;

async function writeImported(vehicleId, subcollection, entries, toDoc, onProgress) {
  const target = collection(db, "vehicles", vehicleId, subcollection);
  let written = 0;

  for (let start = 0; start < entries.length; start += IMPORT_CHUNK) {
    const chunk = entries.slice(start, start + IMPORT_CHUNK);
    const batch = writeBatch(db);
    for (const entry of chunk) {
      batch.set(doc(target), { ...toDoc(entry), source: "import", createdAt: serverTimestamp() });
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
