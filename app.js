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
  increment,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

import {
  isoToDate,
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
  totalServiceCostCents,
  visitTitle,
  looksDerived,
  undoDerivedTitle,
  scheduleRows,
  normalizeJob,
  lastDoneFor,
  isLowStock,
  upcomingWork,
  shelfShortages,
  serviceNameReport,
  serviceNameSuggestions,
  STATS_VERSION,
} from "./stats.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const $app = document.getElementById("app");

const params = new URLSearchParams(location.search);
const vehicleId = params.get("vehicle");
const isNewVehiclePage = params.has("new");
const isSchedulePage = params.has("schedule");
const isPartsPage = params.has("parts");
const isNamesPage = params.has("names");

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
  } else if (isPartsPage) {
    renderPartsView();
  } else if (isNamesPage) {
    renderServiceNamesView();
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

// The order vehicles are listed in, wherever they're listed. By name, so it
// doesn't shift about as the numbers change -- and shared, so the garage
// screen's two lists can't disagree about which car comes first.
const byVehicleName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));

function vehicleSubtitle(data) {
  return [data.year, data.make, data.model].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Garage view: every vehicle, with what it needs
// ---------------------------------------------------------------------------

function renderGarageView() {
  $app.innerHTML = `
    <div class="page-head">
      <h1><span class="emoji">🚗</span>Family Garage</h1>
      <button class="ghost" id="more-btn">More</button>
    </div>
    <div id="vehicle-list"><p class="loading">Loading…</p></div>
    <div class="action-row">
      <a class="btn shelf-btn" href="?parts">🔩 Parts &amp; supplies</a>
    </div>
    <section id="coming-up" hidden>
      <h2><span class="emoji">📅</span>Coming up</h2>
      <div id="coming-up-body"><p class="loading small">Reading the whole garage…</p></div>
    </section>
  `;

  document.getElementById("more-btn").addEventListener("click", openGarageMenu);
  mountComingUp();

  const listEl = document.getElementById("vehicle-list");
  onSnapshot(
    collection(db, "vehicles"),
    (snap) => {
      document.getElementById("coming-up").hidden = snap.empty;
      if (snap.empty) {
        listEl.innerHTML = `
          <p class="empty">No vehicles yet.</p>
          <div class="single-action"><a class="btn" href="?new">+ Add a vehicle</a></div>
        `;
        return;
      }
      const vehicles = [];
      snap.forEach((docSnap) => vehicles.push({ id: docSnap.id, ...docSnap.data() }));
      vehicles.sort(byVehicleName);

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

  // Overdue and due-soon work already get full treatment in the "Coming up"
  // section below; repeating it here would just be noise.
  const pressing = status?.key === "overdue" || status?.key === "soon";

  const serviceLine =
    next && !pressing
      ? `<span class="vehicle-service ${status.key}">${escapeHtml(next.title)} · ${escapeHtml(dueSummary(next, vehicle.odometerMiles ?? null))}</span>`
      : "";

  return `
    <div class="card vehicle-row" data-id="${vehicle.id}">
      <div class="vehicle-main">
        <span class="vehicle-name">${escapeHtml(vehicle.name)}</span>
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
      { value: "names", label: "🏷️ Service names" },
      { value: "qr", label: "Show QR code" },
    ],
  }).then((choice) => {
    if (choice === "new") location.search = "?new";
    else if (choice === "names") location.search = "?names";
    else if (choice === "qr") openQrModal(siteUrl(), "Scan to open Family Garage");
  });
}

// ---------------------------------------------------------------------------
// Service names
//
// The same job ends up typed a few different ways over the years -- "Oil chg",
// "oil change", "Oil Change" -- and everything that matches on a job's name --
// the schedule deciding what's already booked, the suggestion list, what
// shows in Coming up -- treats each spelling as a different job. This is a
// register of every name in the garage: tap one to see which vehicles carry
// it and when it was last actually done on each, or fix it everywhere at
// once -- the schedule entry, the booked job, and every past visit that used
// it, on every vehicle. Merge picks up where a single rename leaves off, for
// when more than two spellings need folding into one in a single pass.
//
// Read once when the page opens, the same as the look-ahead and for the same
// reason: answering it needs every vehicle's schedule and service records, not
// just the vehicle documents, so there's real reading to do first.
// ---------------------------------------------------------------------------

function renderServiceNamesView() {
  $app.innerHTML = `
    <a class="back-link" href="./">&larr; Garage</a>
    <h1><span class="emoji">🏷️</span>Service names</h1>
    <p class="hint">Every job name in use across the garage, plus any added ahead of time. Tap one to
    see which vehicles carry it and when it was last done. Star a name to favorite it — that's what
    the service schedule's dropdown offers. Edit or merge changes every schedule entry, booked job,
    and past visit that used it — on every vehicle.</p>
    <div id="names-list"><p class="loading">Reading the whole garage…</p></div>
  `;

  const state = {
    vehicles: [],
    serviceNames: [],
    report: [],
    expandedNames: new Set(),
    mergeMode: false,
    mergeSelected: new Set(),
  };

  $app.addEventListener("click", (event) => {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    Promise.resolve(handleNamesAction(target.dataset.act, target.dataset.id, state)).catch(reportActionFailure);
  });

  state.reload = () =>
    loadGarage()
      .then((loaded) => {
        state.vehicles = loaded.vehicles;
        state.serviceNames = loaded.serviceNames;
        renderNamesList(state);
      })
      .catch((err) => {
        document.getElementById("names-list").innerHTML =
          `<p class="empty">Couldn't read the whole garage.<br /><span class="hint">${escapeHtml(err.message)}</span></p>`;
      });

  state.reload();
}

function handleNamesAction(action, id, state) {
  switch (action) {
    case "toggle-name":
      if (state.expandedNames.has(id)) state.expandedNames.delete(id);
      else state.expandedNames.add(id);
      renderNamesList(state);
      return null;
    case "add-name":
      return openServiceNameForm(null, state);
    case "edit-name":
      return openServiceNameForm(state.report.find((row) => row.key === id) || null, state);
    case "start-merge":
      state.mergeMode = true;
      state.mergeSelected = new Set();
      renderNamesList(state);
      return null;
    case "cancel-merge":
      state.mergeMode = false;
      state.mergeSelected = new Set();
      renderNamesList(state);
      return null;
    case "toggle-merge-select":
      if (state.mergeSelected.has(id)) state.mergeSelected.delete(id);
      else state.mergeSelected.add(id);
      renderNamesList(state);
      return null;
    case "do-merge":
      return handleMergeAction(state);
    default:
      return null;
  }
}

function renderNamesList(state) {
  state.report = serviceNameReport(state.vehicles, state.serviceNames);
  const listEl = document.getElementById("names-list");

  const header = `
    <div class="section-title row-title">
      <span>${state.report.length} name${state.report.length === 1 ? "" : "s"}</span>
      <div class="heading-actions">
        ${state.mergeMode ? "" : `<button class="secondary small" data-act="add-name">+ Add name</button>`}
        ${
          state.report.length > 1
            ? `<button class="secondary small" data-act="${state.mergeMode ? "cancel-merge" : "start-merge"}">${state.mergeMode ? "Cancel" : "Merge"}</button>`
            : ""
        }
      </div>
    </div>`;

  if (!state.report.length) {
    listEl.innerHTML =
      header +
      `<p class="empty small"><strong>+ Add name</strong> above, or a name shows up here as soon as a
       vehicle has a schedule entry or a service record.</p>`;
    return;
  }

  listEl.innerHTML = `
    ${header}
    ${
      state.mergeMode
        ? `<p class="hint">Two or more names for the same job? Pick them and merge into
           one — you choose which spelling wins.</p>`
        : ""
    }
    <div class="list">${state.report.map((entry) => nameRowHtml(entry, state)).join("")}</div>
    ${
      state.mergeMode && state.mergeSelected.size > 1
        ? `<button class="secondary full-action" data-act="do-merge">Merge ${state.mergeSelected.size} names</button>`
        : ""
    }
  `;
}

function nameRowHtml(entry, state) {
  const meta = [
    `${entry.vehicles} vehicle${entry.vehicles === 1 ? "" : "s"}`,
    `${entry.records} record${entry.records === 1 ? "" : "s"}`,
    entry.fitsVehicleIds ? `only on ${entry.fitsVehicleIds.length}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const star = entry.favorite ? "★ " : "";

  if (state.mergeMode) {
    const picked = state.mergeSelected.has(entry.key);
    return `
      <div class="row tappable ${picked ? "picked" : ""}" data-act="toggle-merge-select" data-id="${escapeHtml(entry.key)}">
        <input class="row-check" type="checkbox" tabindex="-1" ${picked ? "checked" : ""} />
        <div class="row-main">
          <span class="row-title-text">${star}${escapeHtml(entry.name)}</span>
          <span class="row-meta">${meta}</span>
        </div>
      </div>
    `;
  }

  const open = state.expandedNames.has(entry.key);
  return `
    <div class="row tappable" data-act="toggle-name" data-id="${escapeHtml(entry.key)}" aria-expanded="${open}">
      <div class="row-main">
        <span class="row-title-text">${star}${escapeHtml(entry.name)}</span>
        <span class="row-meta">${meta}</span>
      </div>
      <div class="row-side">
        <span class="status-caret">${open ? "▾" : "▸"}</span>
        <button class="secondary small" data-act="edit-name" data-id="${escapeHtml(entry.key)}">Edit</button>
      </div>
    </div>
    ${open ? `<div class="list status-jobs">${nameDetailHtml(entry, state.vehicles)}</div>` : ""}
  `;
}

// Which vehicles carry this name, and when it was last actually done on each
// -- the drill-down a bare count can't answer. "Last done" only counts a
// completed record; a schedule entry or a booked-but-not-done job that shares
// the name still puts the vehicle in the list, just with nothing done yet.
function nameDetailHtml(entry, vehicles) {
  const rows = entry.vehicleIds
    .map((id) => vehicles.find((v) => v.id === id))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  return rows
    .map((vehicle) => {
      const last = lastDoneFor(entry.key, vehicle.services || []);
      const lastText = last
        ? `last done ${[
            last.servicedOn ? formatISO(last.servicedOn) : null,
            last.odometerMiles !== null ? `at ${formatMiles(last.odometerMiles)}` : null,
          ]
            .filter(Boolean)
            .join(" ")}`
        : "not logged yet";
      return `
        <div class="row plan-row">
          <div class="row-main">
            <span class="row-title-text">${escapeHtml(vehicle.name)}</span>
            <span class="row-meta">${escapeHtml(lastText)}</span>
          </div>
          <div class="row-side">
            <a class="ghost btn" href="?vehicle=${encodeURIComponent(vehicle.id)}">Open</a>
          </div>
        </div>
      `;
    })
    .join("");
}

// Two or more existing names, folded into whichever one the person picks --
// same underlying rewrite as a single rename, just aimed at every loser in
// one pass instead of asking for each by hand. Favorite and vehicle scope
// carry forward too: a favorite loser keeps the winner favorited, and an
// unrestricted loser keeps the winner unrestricted even if it was scoped on
// its own -- merging is never how a name quietly loses reach.
async function handleMergeAction(state) {
  if (state.mergeSelected.size < 2) return;
  const entries = state.report.filter((row) => state.mergeSelected.has(row.key));

  const winnerKey = await openPickerModal({
    title: "Merge as which name?",
    options: entries.map((row) => ({
      value: row.key,
      label: `${row.name} (${row.vehicles} vehicle${row.vehicles === 1 ? "" : "s"} · ${row.records} record${row.records === 1 ? "" : "s"})`,
    })),
  });
  if (!winnerKey) return;

  const winner = entries.find((row) => row.key === winnerKey);
  let recordsTouched = 0;
  for (const loser of entries) {
    if (loser.key === winner.key) continue;
    const result = await renameServiceEverywhere(state.vehicles, loser.name, winner.name);
    recordsTouched += result.records;
  }

  const favorite = entries.some((row) => row.favorite);
  const unrestricted = entries.some((row) => !row.fitsVehicleIds);
  const fitsVehicleIds = unrestricted ? [] : [...new Set(entries.flatMap((row) => row.fitsVehicleIds || []))];
  await saveServiceName(winner, { name: winner.name, favorite, fitsVehicleIds });
  for (const loser of entries) {
    if (loser.key === winner.key || !loser.id) continue;
    await deleteDoc(doc(db, "serviceNames", loser.id));
  }

  showToast(
    recordsTouched
      ? `Merged into "${winner.name}" — ${recordsTouched} record${recordsTouched === 1 ? "" : "s"} updated`
      : "Nothing needed changing"
  );

  state.mergeMode = false;
  state.mergeSelected = new Set();
  await state.reload();
}

// Creates or saves over a name's own doc in the shared list -- an existing
// doc is updated in place, a name that's only ever been derived from usage
// gets one for the first time.
async function saveServiceName(entry, payload) {
  if (entry?.id) await updateDoc(doc(db, "serviceNames", entry.id), payload);
  else await addDoc(collection(db, "serviceNames"), { ...payload, createdAt: serverTimestamp() });
}

// One form for both a brand new name and editing one already in use --
// adding just skips the everywhere-rewrite a text change would otherwise
// trigger, since there's nowhere yet for a new name to appear.
async function openServiceNameForm(entry, state) {
  const values = await openFormModal({
    title: entry ? "Edit service name" : "Add a service name",
    hint: entry
      ? `Changes every "${entry.name}" across ${entry.vehicles} vehicle${entry.vehicles === 1 ? "" : "s"} if you rename it — the schedule entry, any booked job, and every past visit that used it.`
      : "Adds a name to the list, ready to pick from before it's ever been logged.",
    fields: [
      {
        name: "name",
        label: "Name",
        type: "text",
        value: entry?.name || "",
        suggestions: state.report.map((row) => row.name),
      },
      {
        name: "favorite",
        label: "Favorite",
        type: "checkbox",
        value: entry?.favorite || false,
        hint: "Favorites are what the service schedule's dropdown offers.",
      },
      {
        name: "fitsVehicleIds",
        label: "Applies to",
        type: "checks",
        value: entry?.fitsVehicleIds || [],
        options: [...state.vehicles].sort(byVehicleName).map((vehicle) => ({ value: vehicle.id, label: vehicle.name })),
        hint: "Pick none and it's offered for every vehicle.",
      },
    ],
    submitLabel: entry ? "Save changes" : "Add it",
    validate: (v) => (v.name ? null : "What should it be called?"),
  });
  if (!values) return;

  const renaming = entry && normalizeJob(values.name) !== normalizeJob(entry.name);
  const result = renaming ? await renameServiceEverywhere(state.vehicles, entry.name, values.name) : null;

  await saveServiceName(entry, {
    name: values.name,
    favorite: !!values.favorite,
    fitsVehicleIds: values.fitsVehicleIds || [],
  });

  showToast(
    !entry
      ? "Added"
      : result?.vehicles
        ? `Renamed on ${result.vehicles} vehicle${result.vehicles === 1 ? "" : "s"} — ${result.records} record${result.records === 1 ? "" : "s"} updated`
        : "Saved"
  );
  await state.reload();
}

// Rewrites `oldName` to `newName` everywhere it appears: the schedule entries
// that name it, the booked jobs that name it, every item on a past visit that
// named it, and which job a booked part was for, since that's recorded by name
// too. Matching is case-and-spacing-insensitive, the same rule scheduling
// already uses to decide two jobs are the same one -- so this doubles as a way
// to normalize stray casing even when the name you type back is the one
// already showing.
//
// One batch per vehicle that actually needs a write, so a vehicle the name
// never touched costs nothing.
async function renameServiceEverywhere(vehicles, oldName, newName) {
  const wanted = normalizeJob(oldName);
  let vehiclesTouched = 0;
  let recordsTouched = 0;

  for (const vehicle of vehicles) {
    const batch = writeBatch(db);
    let touchedThisVehicle = false;

    for (const entry of vehicle.schedule || []) {
      if (normalizeJob(entry.title) !== wanted || entry.title === newName) continue;
      batch.update(doc(db, "vehicles", vehicle.id, "schedule", entry.id), { title: newName });
      touchedThisVehicle = true;
      recordsTouched += 1;
    }

    for (const record of vehicle.services || []) {
      const ref = doc(db, "vehicles", vehicle.id, "services", record.id);

      if (record.status !== "done") {
        if (normalizeJob(record.title) !== wanted || record.title === newName) continue;
        batch.update(ref, { title: newName });
        touchedThisVehicle = true;
        recordsTouched += 1;
        continue;
      }

      const patch = {};
      let changed = false;

      if (Array.isArray(record.items) && record.items.length) {
        let itemsChanged = false;
        const items = record.items.map((item) => {
          if (normalizeJob(item.title) !== wanted || item.title === newName) return item;
          itemsChanged = true;
          return { ...item, title: newName };
        });
        if (itemsChanged) {
          patch.items = items;
          // The record's own title tracks its first named item -- see
          // visitTitle -- so a rename that touches that item keeps it in
          // step rather than leaving it to read the old name.
          patch.title = visitTitle(items);
          changed = true;
        }
      } else if (normalizeJob(record.title) === wanted && record.title !== newName) {
        patch.title = newName;
        changed = true;
      }

      if ((record.parts || []).some((part) => part.forJob && normalizeJob(part.forJob) === wanted && part.forJob !== newName)) {
        patch.parts = record.parts.map((part) =>
          part.forJob && normalizeJob(part.forJob) === wanted ? { ...part, forJob: newName } : part
        );
        changed = true;
      }

      if (!changed) continue;
      batch.update(ref, patch);
      touchedThisVehicle = true;
      recordsTouched += 1;
    }

    if (touchedThisVehicle) {
      await batch.commit();
      await recomputeSummary(vehicle.id);
      vehiclesTouched += 1;
    }
  }

  return { vehicles: vehiclesTouched, records: recordsTouched };
}

// ---------------------------------------------------------------------------
// What's coming up
//
// The part of the dashboard that looks across the whole garage: everything due
// in the next six months or year, whether it was booked in or is simply what a
// vehicle's schedule implies next -- plus a straight read of the shelf itself,
// so a Saturday job doesn't stall on a part nobody bought. The two are
// independent: a part comes off the shelf the moment it's assigned to any
// job, so the buy list doesn't need to know what's due or when -- see
// shelfShortages.
//
// It's the one thing on this screen that can't be answered from the vehicle
// documents alone -- it needs every vehicle's schedule, services and fill-ups --
// so it's read after the vehicle list has already been asked for rather than
// ahead of it, and the list paints without waiting on it.
//
// Read once when the dashboard opens rather than watched live: navigating away
// and back reads it again, which is as fresh as this needs to be.
// ---------------------------------------------------------------------------

function mountComingUp() {
  // Which counts have been opened, by vehicle and status. Kept here rather than
  // in the DOM so a redraw doesn't shut everything you'd opened.
  const state = { vehicles: [], parts: [], serviceNames: [], loaded: false, expanded: new Set() };

  $app.addEventListener("click", (event) => {
    const target = event.target.closest("[data-act=toggle-group]");
    if (!target) return;
    const key = target.dataset.id;
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    renderComingUp(state);
  });

  loadGarage()
    .then(async (loaded) => {
      Object.assign(state, loaded, { loaded: true });
      // Catches up anything booked before parts started reserving at
      // assignment time -- see migratePartsReservations. Only ever touches a
      // record once, so this is cheap and harmless on every visit after the
      // first too.
      const touched = await migratePartsReservations(loaded.vehicles).catch((err) => {
        console.warn("Couldn't sweep existing parts reservations", err);
        return 0;
      });
      if (touched) {
        const partSnap = await getDocs(collection(db, "parts"));
        state.parts = partSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      }
      renderComingUp(state);
    })
    .catch((err) => {
      // A dashboard that can't plan is still a usable dashboard, so this says
      // so in place instead of taking over the screen with an error.
      document.getElementById("coming-up-body").innerHTML =
        `<p class="empty small">Couldn't work out what's coming up.<br /><span class="hint">${escapeHtml(err.message)}</span></p>`;
    });
}

// One-time catch-up for records booked before parts started reserving off
// the shelf the moment they're assigned, rather than only once a job is
// marked done: anything still open with a parts list that's never actually
// been charged to the shelf gets swept in here. Marking each record as it's
// swept -- `reserved: true`, the same flag every other write already sets --
// is what makes this safe to run on every load rather than needing some
// separate "has this already happened" flag of its own: a record already
// marked simply has nothing left for this to do, so a second pass (or a
// second device running it at the same moment) costs a few reads and writes
// nothing.
async function migratePartsReservations(vehicles) {
  let touched = 0;
  for (const vehicle of vehicles) {
    for (const service of vehicle.services || []) {
      if (service.status === "done" || service.reserved) continue;
      const needed = service.partsNeeded || [];
      await updateDoc(doc(db, "vehicles", vehicle.id, "services", service.id), { reserved: true });
      if (needed.length) {
        await applyPartUsage([], needed);
        touched += 1;
      }
    }
  }
  return touched;
}

// Everything the coming-up section needs, in one pass.
async function loadGarage() {
  const [vehicleSnap, partSnap, nameSnap] = await Promise.all([
    getDocs(collection(db, "vehicles")),
    getDocs(collection(db, "parts")),
    getDocs(collection(db, "serviceNames")),
  ]);

  const vehicles = await Promise.all(
    vehicleSnap.docs.map(async (vehicleDoc) => {
      const id = vehicleDoc.id;
      const [services, schedule, fillups] = await Promise.all([
        getDocs(collection(db, "vehicles", id, "services")),
        getDocs(collection(db, "vehicles", id, "schedule")),
        getDocs(collection(db, "vehicles", id, "fillups")),
      ]);
      const data = vehicleDoc.data();
      const serviceList = services.docs.map((d) => ({ id: d.id, ...d.data() }));
      const fillupList = fillups.docs.map((d) => ({ id: d.id, ...d.data() }));
      return {
        id,
        name: data.name,
        year: data.year ?? null,
        odometerMiles: currentOdometer(data, fillupList, serviceList),
        services: serviceList,
        schedule: schedule.docs.map((d) => ({ id: d.id, ...d.data() })),
        fillups: fillupList,
      };
    })
  );

  return {
    vehicles,
    parts: partSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    serviceNames: nameSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
  };
}

function renderComingUp(state) {
  const bodyEl = document.getElementById("coming-up-body");
  if (!state.loaded) return;

  const today = new Date();
  const { overdue, soon } = upcomingWork(state.vehicles, { today });

  // A straight read of the shelf, not the jobs -- a part comes off it the
  // moment it's assigned to any job, so what's left already accounts for
  // everything already spoken for, whether that job is due today or next
  // year. Nothing to check once there's no shelf to speak of.
  const shortages = state.parts.length ? shelfShortages(state.parts) : [];
  const buyCard = state.parts.length
    ? `
    <div class="card shopping">
      <div class="section-title">To buy</div>
      ${
        shortages.length
          ? shortages
              .map(
                (need) => `<div class="shopping-row${need.negative ? " negative" : ""}">
                  <span>${escapeHtml(need.name)}</span>
                  <span class="shopping-need${need.negative ? " negative" : ""}">${shoppingNeedText(need)}</span>
                  ${
                    shoppingDetail(need)
                      ? `<span class="shopping-detail">${escapeHtml(shoppingDetail(need))}</span>`
                      : ""
                  }
                </div>`
              )
              .join("")
          : `<p class="hint ok-line">Everything on the shelf is at or above what you keep on hand.</p>`
      }
    </div>
  `
    : "";

  if (!overdue.length && !soon.length) {
    bodyEl.innerHTML =
      `<p class="empty small">Nothing overdue or due soon. Anything further out is on
      each vehicle's own page.</p>` +
      buyCard;
    return;
  }

  // By vehicle, then by status within it -- in the same order as the vehicle
  // cards above, so the two lists on this screen read down together.
  const byVehicle = new Map();
  for (const row of [...overdue, ...soon]) {
    if (!byVehicle.has(row.vehicleId)) {
      byVehicle.set(row.vehicleId, { id: row.vehicleId, name: row.vehicleName, overdue: [], soon: [] });
    }
    byVehicle.get(row.vehicleId)[row.status.key].push(row);
  }

  // Wrapped one div per vehicle -- not needed for phone width, where they just
  // stack as they always did, but it gives a tablet layout something to grid:
  // each vehicle's block placed as one unit rather than its heading and status
  // counts drifting into separate columns.
  const sections = [...byVehicle.values()]
    .sort(byVehicleName)
    .map(
      (vehicle) => `
      <div class="plan-vehicle">
        <div class="section-title">${escapeHtml(vehicle.name)}</div>
        ${statusGroupHtml(vehicle, "overdue", "Overdue", state.expanded)}
        ${statusGroupHtml(vehicle, "soon", "Due soon", state.expanded)}
      </div>`
    )
    .join("");

  bodyEl.innerHTML = `
    <p class="hint">${[
      overdue.length ? `${overdue.length} overdue` : null,
      soon.length ? `${soon.length} due soon` : null,
    ]
      .filter(Boolean)
      .join(" · ")}. Tap a count to see the jobs; open a vehicle for their dates and mileages.</p>

    <div class="plan-vehicles">${sections}</div>

    ${buyCard}
  `;
}

// What to buy, and how many -- once there's a floor to count up to. With
// none set, "low" only ever means "run out", so there's nothing to suggest
// beyond that. Negative gets its own wording: the count itself is wrong, not
// just thin, so it reads as a discrepancy rather than a restocking figure.
function shoppingNeedText(need) {
  if (need.negative) {
    const keep = need.floor === null ? "" : `, keep ${need.floor}+`;
    return `${need.short} ${escapeHtml(need.unit)} short of zero · have ${need.quantity}${keep} — worth a recount`;
  }
  if (need.floor === null) return `have ${need.quantity} — worth restocking`;
  return `${need.short} ${escapeHtml(need.unit)} short · have ${need.quantity}, keep ${need.floor}+`;
}

// A count you can open. Closed it answers "how bad is it" in one line; opened
// it lists the jobs behind the number.
// Which one to buy, and where -- the things you'd otherwise have to open the
// shelf to look up while standing in the aisle.
function shoppingDetail(need) {
  return [need.modelNumber ? `model ${need.modelNumber}` : null, need.size || null, need.vendor ? `from ${need.vendor}` : null]
    .filter(Boolean)
    .join(" · ");
}

function statusGroupHtml(vehicle, key, label, expanded) {
  const rows = vehicle[key];
  if (!rows.length) return "";

  const id = `${vehicle.id}:${key}`;
  const open = expanded.has(id);
  return `
    <button class="status-group ${key}" data-act="toggle-group" data-id="${escapeHtml(id)}"
            aria-expanded="${open}">
      <span class="status-caret">${open ? "▾" : "▸"}</span>
      <span class="status-name">${escapeHtml(label)}</span>
      <span class="status-count">${rows.length}</span>
    </button>
    ${open ? `<div class="list status-jobs">${rows.map(planRowHtml).join("")}</div>` : ""}
  `;
}

function planRowHtml(row) {
  return `
    <div class="row plan-row">
      <div class="row-main">
        <span class="row-title-text">${escapeHtml(row.title)}</span>
      </div>
      <div class="row-side">
        <a class="ghost btn" href="?vehicle=${encodeURIComponent(row.vehicleId)}">Open</a>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Parts and supplies
//
// One shelf for the whole garage rather than a list per vehicle: a case of oil
// or a box of wiper blades gets used on whichever car needs it. Quantities are
// changed with an atomic increment, never by writing a number worked out from
// what was read a moment ago, so two phones logging service at once can't undo
// each other's arithmetic.
// ---------------------------------------------------------------------------

const PART_UNITS = ["each", "qt", "gal", "L", "oz", "box", "set", "pair", "ft"];

const PART_CATEGORIES = [
  "Filters",
  "Fluids",
  "Brakes",
  "Tires & wheels",
  "Belts & hoses",
  "Ignition",
  "Electrical",
  "Wipers",
  "Lighting",
  "Shop supplies",
];

function renderPartsView() {
  $app.innerHTML = `
    <a class="back-link" href="./">&larr; Garage</a>
    <div class="page-head">
      <h1><span class="emoji">🔩</span>Parts &amp; supplies</h1>
      <button class="secondary small" data-act="add-part">+ Add a part</button>
    </div>
    <p class="hint" id="parts-intro"></p>
    <div id="parts-list"><p class="loading">Loading…</p></div>
  `;

  const state = { parts: [], vehicles: [] };
  $app.addEventListener("click", (event) => {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    Promise.resolve(handlePartsAction(target.dataset.act, target.dataset.id, state)).catch(reportActionFailure);
  });

  const listEl = document.getElementById("parts-list");

  // Only needed to name the vehicles a part fits -- the shelf itself renders
  // without waiting on them, and one that can't be read just goes unnamed.
  onSnapshot(
    collection(db, "vehicles"),
    (snap) => {
      state.vehicles = snap.docs.map((d) => ({ id: d.id, name: d.data().name }));
      state.vehicles.sort(byVehicleName);
      if (state.parts.length) drawParts(listEl, state);
    },
    (err) => console.warn("Couldn't read the vehicle list", err)
  );
  onSnapshot(
    collection(db, "parts"),
    (snap) => {
      state.parts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.parts.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

      const low = state.parts.filter(isLowStock);
      document.getElementById("parts-intro").textContent = state.parts.length
        ? `${state.parts.length} item${state.parts.length === 1 ? "" : "s"} on the shelf${low.length ? ` · ${low.length} running low` : ""}.`
        : "";

      drawParts(listEl, state);
    },
    (err) => {
      listEl.innerHTML = `<p class="empty">Couldn't load the parts list.<br /><span class="hint">${escapeHtml(err.message)}</span></p>`;
    }
  );
}

// What's already been typed into a field across the shelf, most common first,
// so "Fram" doesn't become "fram" and "FRAM" on three different rows.
function usedValues(parts, key) {
  const counts = new Map();
  for (const part of parts || []) {
    const value = String(part[key] || "").trim();
    if (!value) continue;
    const seen = counts.get(value.toLowerCase());
    if (seen) seen.count += 1;
    else counts.set(value.toLowerCase(), { value, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).map((e) => e.value);
}

// Grouped by category, since that's what a category is for -- but only once
// there's more than one to group into. A shelf where nothing has been
// categorised reads exactly as it always did, one flat list.
function drawParts(listEl, state) {
  if (!state.parts.length) {
    listEl.innerHTML = `<p class="empty small">Nothing on the shelf yet. Add the oil, filters and blades you keep
      around, and they can be booked against a service — which takes them back off the shelf.</p>`;
    return;
  }

  const groups = new Map();
  for (const part of state.parts) {
    const key = String(part.category || "").trim() || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(part);
  }

  const list = (parts) => `<div class="list">${parts.map((part) => partRowHtml(part, state.vehicles)).join("")}</div>`;
  if (groups.size === 1 && groups.has("")) {
    listEl.innerHTML = list(state.parts);
    return;
  }

  // Named categories first, alphabetically; whatever hasn't been given one
  // brings up the rear rather than heading the page.
  const named = [...groups.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
  listEl.innerHTML =
    named.map((key) => `<div class="section-title">${escapeHtml(key)}</div>${list(groups.get(key))}`).join("") +
    (groups.has("") ? `<div class="section-title">Uncategorised</div>${list(groups.get(""))}` : "");
}

function formatQuantity(part) {
  const quantity = Number(part.quantity) || 0;
  const rounded = Math.round(quantity * 100) / 100;
  return `${rounded} ${part.unit || "each"}`;
}

function partRowHtml(part, vehicles = []) {
  const low = isLowStock(part);
  // Booking out more than the shelf held leaves a negative count. That's kept
  // rather than clamped -- it means the count was wrong, and hiding it would
  // lose the only evidence of that -- but it's shown as a discrepancy, not as
  // "running low".
  const negative = (Number(part.quantity) || 0) < 0;
  const meta = [
    part.brand || null,
    part.partNumber ? `#${part.partNumber}` : null,
    part.modelNumber ? `model ${part.modelNumber}` : null,
    part.size || null,
    part.vendor ? `from ${part.vendor}` : null,
    part.unitCostCents ? `${formatUSD(part.unitCostCents)} each` : null,
    part.minQuantity ? `keep ${part.minQuantity}+` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Naming no vehicle means it fits anything, which needs no saying. A vehicle
  // since deleted is dropped rather than shown as a missing name.
  const fits = (part.fitsVehicleIds || [])
    .map((id) => vehicles.find((vehicle) => vehicle.id === id))
    .filter(Boolean)
    .map((vehicle) => vehicle.name);

  return `
    <div class="row part-row ${negative ? "negative" : low ? "low" : ""} tappable" data-act="edit-part" data-id="${part.id}">
      <div class="row-main">
        <span class="row-title-text">${escapeHtml(part.name)}</span>
        ${meta ? `<span class="row-meta">${escapeHtml(meta)}</span>` : ""}
        ${fits.length ? `<span class="row-meta fits-line">Fits ${escapeHtml(fits.join(", "))}</span>` : ""}
        ${part.notes ? `<span class="row-note">${escapeHtml(part.notes)}</span>` : ""}
      </div>
      <div class="row-side">
        <span class="part-qty ${negative ? "negative" : low ? "low" : ""}">${escapeHtml(formatQuantity(part))}</span>
        ${negative ? `<span class="row-meta">more booked out than the shelf held — worth a recount</span>` : ""}
        <div class="row-actions">
          <button class="ghost" data-act="part-minus" data-id="${part.id}" title="Take one off the shelf">−</button>
          <button class="ghost" data-act="part-plus" data-id="${part.id}" title="Put one back">+</button>
        </div>
      </div>
    </div>
  `;
}

function handlePartsAction(action, id, state) {
  switch (action) {
    case "add-part":
      return openPartForm(null, state);
    case "edit-part":
      return openPartForm(state.parts.find((part) => part.id === id) || null, state);
    case "part-plus":
      return adjustPartQuantity(id, 1);
    case "part-minus":
      return adjustPartQuantity(id, -1);
    default:
      return null;
  }
}

// A single atomic step, so tapping quickly -- or on two phones at once -- lands
// every change rather than the last read winning.
function adjustPartQuantity(partId, delta) {
  return updateDoc(doc(db, "parts", partId), { quantity: increment(delta), updatedAt: serverTimestamp() });
}

async function openPartForm(existing, state) {
  const values = await openFormModal({
    title: existing ? "Edit part" : "Add a part",
    fields: [
      { name: "name", label: "Part or supply", type: "text", value: existing?.name || "", placeholder: "Oil filter" },
      {
        name: "brand",
        label: "Brand (optional)",
        type: "text",
        half: true,
        value: existing?.brand || "",
        placeholder: "Fram",
        suggestions: usedValues(state.parts, "brand"),
      },
      {
        name: "category",
        label: "Category (optional)",
        type: "text",
        half: true,
        value: existing?.category || "",
        placeholder: "Filters",
        suggestions: [...usedValues(state.parts, "category"), ...PART_CATEGORIES].filter(
          (value, index, all) => all.findIndex((other) => other.toLowerCase() === value.toLowerCase()) === index
        ),
      },
      {
        name: "partNumber",
        label: "Part number (optional)",
        type: "text",
        half: true,
        value: existing?.partNumber || "",
        placeholder: "PH7317",
      },
      {
        name: "modelNumber",
        label: "Model (optional)",
        type: "text",
        half: true,
        value: existing?.modelNumber || "",
        placeholder: "XG7317",
      },
      {
        name: "size",
        label: "Size (optional)",
        type: "text",
        half: true,
        value: existing?.size || "",
        placeholder: "5W-30, 22 in",
        suggestions: usedValues(state.parts, "size"),
      },
      {
        name: "vendor",
        label: "Bought from (optional)",
        type: "text",
        half: true,
        value: existing?.vendor || "",
        placeholder: "NAPA",
        suggestions: usedValues(state.parts, "vendor"),
      },
      {
        name: "unit",
        label: "Counted in",
        type: "select",
        half: true,
        value: existing?.unit || "each",
        options: PART_UNITS.map((unit) => ({ value: unit, label: unit })),
      },
      {
        name: "quantity",
        label: "On the shelf",
        type: "number",
        step: "0.01",
        inputmode: "decimal",
        half: true,
        value: existing ? String(existing.quantity ?? 0) : "",
        placeholder: "4",
      },
      {
        name: "minQuantity",
        label: "Tell me below",
        type: "number",
        step: "0.01",
        inputmode: "decimal",
        min: 0,
        half: true,
        value: existing?.minQuantity != null ? String(existing.minQuantity) : "",
        placeholder: "1",
        hint: "Flags the item as running low once the shelf drops to this.",
      },
      {
        name: "unitCost",
        label: "Cost each (optional)",
        type: "number",
        step: "0.01",
        inputmode: "decimal",
        min: 0,
        half: true,
        value: existing?.unitCostCents ? (existing.unitCostCents / 100).toFixed(2) : "",
        placeholder: "8.99",
      },
      {
        name: "fitsVehicleIds",
        label: "Fits",
        type: "checks",
        value: existing?.fitsVehicleIds || [],
        options: (state.vehicles || []).map((vehicle) => ({ value: vehicle.id, label: vehicle.name })),
        hint: "Pick none and it counts as fitting anything — which is what a case of oil or a box of rags is.",
      },
      { name: "notes", label: "Notes (optional)", type: "text", value: existing?.notes || "", placeholder: "Bought two at a time" },
    ],
    submitLabel: existing ? "Save changes" : "Add it",
    destructive: existing ? { label: "Remove from the parts list" } : null,
    validate: (v) => {
      if (!v.name) return "What is it called?";
      if (v.quantity && !Number.isFinite(Number(v.quantity))) return "That quantity doesn't look like a number.";
      return null;
    },
  });
  if (!values) return;

  if (values.__destructive) {
    const confirmed = await openConfirmModal({
      title: "Remove this part?",
      message: `${existing.name} comes off the parts list. Service records that used it are left as they are.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!confirmed) return;
    await deleteDoc(doc(db, "parts", existing.id));
    showToast("Removed");
    return;
  }

  const payload = {
    name: values.name,
    brand: values.brand || null,
    category: values.category || null,
    modelNumber: values.modelNumber || null,
    size: values.size || null,
    vendor: values.vendor || null,
    fitsVehicleIds: values.fitsVehicleIds || [],
    partNumber: values.partNumber || null,
    unit: values.unit || "each",
    quantity: values.quantity ? Number(values.quantity) : 0,
    minQuantity: values.minQuantity ? Number(values.minQuantity) : null,
    unitCostCents: values.unitCost ? dollarsToCents(values.unitCost) : null,
    notes: values.notes || null,
    updatedAt: serverTimestamp(),
  };

  if (existing) await updateDoc(doc(db, "parts", existing.id), payload);
  else await addDoc(collection(db, "parts"), { ...payload, createdAt: serverTimestamp() });
  showToast(existing ? "Part updated" : "Added to the shelf");
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
    // Only used to stock the parts picker and offer suggestions, so rendering
    // doesn't wait on either.
    parts: [],
    serviceNames: [],
    showAllFillups: false,
    showHistory: false,
    combineMode: false,
    combineSelected: new Set(),
  };

  bodyEl.addEventListener("click", (event) => {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    Promise.resolve(handleVehicleAction(target.dataset.act, target.dataset.id, state)).catch(reportActionFailure);
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
    repairDerivedTitles(id, state.services);
    render();
    // Catches up this vehicle if it's opened directly (a QR code, a bookmark)
    // without ever passing through the garage screen, where this otherwise
    // runs first. Guarded so a page left open a while doesn't re-sweep on
    // every services update -- migratePartsReservations is itself safe to
    // call again, but there's no reason to. Any shelf change it makes
    // reaches this page through the parts listener already running below,
    // same as any other live update while the page is open.
    if (!state.swept) {
      state.swept = true;
      migratePartsReservations([{ id, services: state.services }]).catch((err) =>
        console.warn("Couldn't sweep existing parts reservations", err)
      );
    }
  });

  onSnapshot(
    collection(db, "parts"),
    (snap) => {
      state.parts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.parts.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      // The service list's own "Needs" line reads the shelf to say what's
      // short, so a shelf change while this page is open has to redraw it.
      render();
    },
    (err) => console.warn("Couldn't read the parts list", err)
  );

  onSnapshot(
    collection(db, "serviceNames"),
    (snap) => {
      state.serviceNames = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    // The list is a nicety here; if it can't be read, the suggestions are
    // just a little shorter.
    (err) => console.warn("Couldn't read the service names list", err)
  );
}

function vehicleBodyHtml(state) {
  const { vehicle } = state;
  const { entries, summary } = computeFuelStats(state.fillups);
  const odometerMiles = currentOdometer(vehicle, state.fillups, state.services);
  const ctx = { odometerMiles, today: new Date(), parts: state.parts || [] };

  const open = openServices(state.services, ctx);
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

    ${statsGridHtml(summary, totalServiceCostCents(state.services))}

    <div class="action-row">
      <button class="plan-btn" data-act="open-schedule">🗓️ Service schedule</button>
    </div>

    <div class="section-title row-title">
      <span>Service</span>
      <div class="heading-actions">
        ${
          open.length > 1
            ? `<button class="secondary small" data-act="log-visit">Log as one visit</button>`
            : ""
        }
      </div>
    </div>
    ${
      open.length
        ? `<div class="list">${open.map((s) => serviceRowHtml(s, ctx)).join("")}</div>`
        : `<p class="empty small">Nothing waiting. <strong>🔧 Add service</strong> above puts a job on the
           list — one the schedule doesn't cover, or anything you've decided needs doing — or logs one
           you've already had done.</p>`
    }

    ${
      history.length
        ? `<div class="section-title row-title">
             <span>Service history</span>
             <div class="heading-actions">
               ${
                 state.showHistory && history.length > 1
                   ? `<button class="secondary small" data-act="${state.combineMode ? "cancel-combine" : "start-combine"}">${state.combineMode ? "Cancel" : "Combine"}</button>`
                   : ""
               }
               <button class="secondary small" data-act="toggle-history">${state.showHistory ? "Hide" : `Show (${history.length})`}</button>
             </div>
           </div>
           ${
             state.showHistory
               ? `${
                   state.combineMode
                     ? `<p class="hint">Two visits that were really one trip? Pick them and combine into a
                        single record — its costs, parts and photos all come along.</p>`
                     : ""
                 }
                 <div class="list">${history.map((s) => serviceHistoryRowHtml(s, state)).join("")}</div>
                 ${
                   state.combineMode && state.combineSelected.size > 1
                     ? `<button class="secondary full-action" data-act="do-combine">Combine ${state.combineSelected.size} records</button>`
                     : ""
                 }`
               : ""
           }`
        : ""
    }

    <div class="section-title row-title">
      <span>Gas log</span>
      ${
        recent.length > 5
          ? `<button class="secondary small" data-act="toggle-fillups">${
              state.showAllFillups ? "Hide" : `Show (${recent.length})`
            }</button>`
          : ""
      }
    </div>
    ${
      shown.length
        ? `<div class="list">${shown.map((entry) => fillupRowHtml(entry)).join("")}</div>`
        : `<p class="empty small">No fill-ups yet. Log one every time you buy gas — MPG appears once you've filled the tank all the way twice.</p>`
    }
  `;
}

// What's waiting on the service list, most pressing first -- the same order the
// vehicle page shows, so the visit sheet lists the jobs the way you just read
// them.
function openServices(services, ctx) {
  return services.filter((service) => service.status !== "done").sort((a, b) => compareServices(a, b, ctx));
}

function statsGridHtml(summary, serviceCostCents) {
  if (!summary.count) return "";
  // Cost per mile including the shop, not just the pump -- same tracked
  // miles as the fuel-only figure above it, so the two are comparable.
  const costPerMileWithServiceCents =
    summary.trackedMiles > 0 ? (summary.trackedCostCents + serviceCostCents) / summary.trackedMiles : null;
  const totalCostCents = summary.totalCostCents + serviceCostCents;

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
    // A second row, lined up under the fuel-only figures above, that folds
    // service history into each one -- the true cost of keeping the car, not
    // just what went through the pump.
    {
      label: "Cost per mile w/ service",
      value: costPerMileWithServiceCents !== null ? `${costPerMileWithServiceCents.toFixed(1)}¢` : "—",
    },
    { label: "Service total", value: formatUSD(serviceCostCents) },
    { label: "Total w/ service", value: formatUSD(totalCostCents) },
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
        ${partsNeededHtml(service, ctx.parts)}
        ${photoTagHtml(service)}
      </div>
      <div class="row-side">
        <span class="badge ${status.key}">${escapeHtml(status.label)}</span>
        <button class="approve small" data-act="complete-service" data-id="${service.id}">Mark done</button>
      </div>
    </div>
  `;
}

// What to offer in the description dropdown: jobs this vehicle has had before,
// most recent first, then anything on its schedule, then the common ones. Its
// own history leads because that's the wording already in use -- offering
// "Oil change" when every past record says "Oil & filter" would slowly split
// one job into two.
function serviceSuggestions(state) {
  const out = [];
  const add = (title) => {
    const value = String(title || "").trim();
    if (!value || out.some((existing) => existing.toLowerCase() === value.toLowerCase())) return;
    out.push(value);
  };

  serviceNameSuggestions(state.serviceNames || [], state.id).forEach(add);
  SERVICE_SUGGESTIONS.forEach(add);
  return out;
}

// Shops carry across the driveway in a way service names don't -- the same
// family takes both cars to the same garage -- so the list is drawn from every
// vehicle, not just this one. The other vehicles are read once and remembered
// for the session; this vehicle's own come from live state, so a shop used
// today shows up immediately where it matters most.
let shopsElsewhere = null;

async function knownShops(state) {
  const out = [];
  const add = (value) => {
    const shop = String(value || "").trim();
    if (!shop || out.some((existing) => existing.toLowerCase() === shop.toLowerCase())) return;
    out.push(shop);
  };

  [...(state.services || [])]
    .sort((a, b) => String(b.servicedOn || "").localeCompare(String(a.servicedOn || "")))
    .forEach((record) => add(record.shop));

  if (!shopsElsewhere) {
    try {
      const vehicles = await getDocs(collection(db, "vehicles"));
      const lists = await Promise.all(
        vehicles.docs
          .filter((vehicle) => vehicle.id !== state.id)
          .map((vehicle) => getDocs(collection(db, "vehicles", vehicle.id, "services")))
      );
      shopsElsewhere = lists.flatMap((snap) => snap.docs.map((docSnap) => docSnap.data().shop)).filter(Boolean);
    } catch (err) {
      // Not worth failing the sheet over: the list is just shorter.
      console.warn("Couldn't read shops from the other vehicles", err);
      shopsElsewhere = [];
    }
  }
  shopsElsewhere.forEach(add);
  return out;
}

// Records saved while a visit was named after its first job plus a count get
// that count taken off, once, the next time the vehicle is opened. The history
// worked it out at render time either way, but the stored name is what a
// scheduled follow-up, the garage badge and the suggestions list all show.
const repairedTitles = new Set();

function repairDerivedTitles(vehicleId, services) {
  for (const service of services) {
    if (!looksDerived(service.title) || repairedTitles.has(service.id)) continue;
    repairedTitles.add(service.id);
    updateDoc(doc(db, "vehicles", vehicleId, "services", service.id), {
      title: undoDerivedTitle(service.title),
    }).catch((err) => {
      repairedTitles.delete(service.id);
      console.warn("Couldn't tidy up a visit's name", err);
    });
  }
}

// "5 × 0W-20 oil (M1-0W20, from NAPA)" -- the model and vendor come along so
// the record says which one it was, and where to get another. Records written
// before those were kept read as they always did.
const partsSummary = (parts) =>
  parts
    .map((used) => {
      const detail = [used.modelNumber || null, used.size || null, used.vendor ? `from ${used.vendor}` : null]
        .filter(Boolean)
        .join(", ");
      return `${used.quantity} × ${used.name}${detail ? ` (${detail})` : ""}`;
    })
    .join(", ");

// What a job has reserved off the shelf. Since assigning it already took it
// off, "short" now means the shelf itself is running low on that part -- the
// same check the shelf page and the buy list use -- not whether there was
// enough for this one job in isolation.
function partsNeededHtml(service, parts = []) {
  const needed = service.partsNeeded || [];
  if (!needed.length) return "";

  const short = needed.filter((want) => {
    const part = parts.find((candidate) => candidate.id === want.partId);
    return part && isLowStock(part);
  });

  return `<span class="row-meta parts-line${short.length ? " short" : ""}">Needs ${escapeHtml(partsSummary(needed))}${
    short.length ? ` — short of ${escapeHtml(short.map((want) => want.name).join(", "))}` : ""
  }</span>`;
}

// A record with receipts says so, without the list having to load any of them.
function photoTagHtml(service) {
  const count = service.photoCount || 0;
  if (!count) return "";
  return `<span class="row-tag photo">📎 ${count} receipt${count === 1 ? "" : "s"}</span>`;
}

function serviceHistoryRowHtml(service, state) {
  const combineMode = state.combineMode;
  const picked = combineMode && state.combineSelected.has(service.id);
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
  // Labor gets its own line the same way whenever there's one to show -- the
  // total on the right otherwise wouldn't match what's itemized underneath it.
  const laborLine = service.laborCostCents
    ? `<li><span>Labor</span><span class="item-cost">${escapeHtml(formatUSD(service.laborCostCents))}</span></li>`
    : "";
  const breakdown =
    items.length > 1 || laborLine
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
           ${laborLine}
         </ul>`
      : items[0] && items[0].notes
        ? `<span class="row-note">${escapeHtml(items[0].notes)}</span>`
        : "";

  // With several jobs listed underneath, a made-up heading like "Oil change + 2
  // more" only repeats the first line of the list. The visit itself is better
  // identified by when and where it happened, so that becomes the heading.
  const multiple = items.length > 1;
  const heading = multiple && bits.length ? bits.join(" · ") : service.title;

  return `
    <div class="row service-row done tappable ${picked ? "picked" : ""}"
         data-act="${combineMode ? "toggle-combine" : "edit-service"}" data-id="${service.id}">
      ${combineMode ? `<input class="row-check" type="checkbox" tabindex="-1" ${picked ? "checked" : ""} />` : ""}
      <div class="row-main">
        <span class="row-title-text${multiple ? " visit-heading" : ""}">${escapeHtml(heading)}</span>
        ${multiple ? "" : `<span class="row-meta">${escapeHtml(bits.join(" · "))}</span>`}
        ${breakdown}
        ${(service.parts || []).length ? `<span class="row-meta parts-line">Used ${escapeHtml(partsSummary(service.parts))}</span>` : ""}
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

// Every case returns its promise so the caller can catch. Without that, a
// rejected action is an unhandled rejection: the tap does nothing, no message,
// nothing in the interface to explain it.
function handleVehicleAction(action, id, state) {
  const { vehicle } = state;
  if (!vehicle) return null;
  const odometerMiles = currentOdometer(vehicle, state.fillups, state.services);

  switch (action) {
    case "log-fuel":
      return openFillupForm(state, null);
    case "edit-fillup":
      return openFillupForm(state, state.fillups.find((f) => f.id === id) || null);
    case "log-service":
      return openAddServiceMenu(state, odometerMiles);
    case "open-schedule":
      location.search = `?vehicle=${encodeURIComponent(state.id)}&schedule`;
      return null;
    case "log-visit":
      return openCompletedServiceForm(state, null, odometerMiles, {
        folding: openServices(state.services, { odometerMiles, today: new Date(), parts: state.parts || [] }),
      });
    case "edit-service": {
      const service = state.services.find((s) => s.id === id);
      if (!service) return null;
      return service.status === "done"
        ? openCompletedServiceForm(state, service, odometerMiles)
        : openScheduleServiceForm(state, service, odometerMiles);
    }
    case "complete-service":
      return openCompletedServiceForm(state, state.services.find((s) => s.id === id) || null, odometerMiles, {
        completing: true,
      });
    case "vehicle-menu":
      return openVehicleMenu(state);
    case "toggle-fillups":
      state.showAllFillups = !state.showAllFillups;
      document.getElementById("vehicle-body").innerHTML = vehicleBodyHtml(state);
      return null;
    case "toggle-history":
      state.showHistory = !state.showHistory;
      // Combine only makes sense with the rows actually on screen to pick
      // from -- hiding them mid-pick exits combine mode rather than leaving
      // it stranded with no visible way back out.
      if (!state.showHistory) {
        state.combineMode = false;
        state.combineSelected = new Set();
      }
      document.getElementById("vehicle-body").innerHTML = vehicleBodyHtml(state);
      return null;
    case "start-combine":
      state.combineMode = true;
      state.showHistory = true;
      state.combineSelected = new Set();
      document.getElementById("vehicle-body").innerHTML = vehicleBodyHtml(state);
      return null;
    case "cancel-combine":
      state.combineMode = false;
      state.combineSelected = new Set();
      document.getElementById("vehicle-body").innerHTML = vehicleBodyHtml(state);
      return null;
    case "toggle-combine":
      if (state.combineSelected.has(id)) state.combineSelected.delete(id);
      else state.combineSelected.add(id);
      document.getElementById("vehicle-body").innerHTML = vehicleBodyHtml(state);
      return null;
    case "do-combine":
      return combineServiceRecords(state, odometerMiles);
    default:
      return null;
  }
}

// Turns two or more already-logged visits into one. Chosen by hand rather
// than guessed at -- there's no reliable signal (same day? same shop?) that a
// separate record wasn't in fact a separate trip -- so this only ever acts on
// records the person picked.
async function combineServiceRecords(state, odometerMiles) {
  const records = state.services.filter((service) => state.combineSelected.has(service.id));
  if (records.length < 2) return;

  // Earliest first: that record keeps its id, its date, and its odometer
  // reading (all now presumed correct for the combined visit), and the rest
  // fold into it. Its own receipt photos need no migrating for the same
  // reason -- they're already filed under the id that's about to hold
  // everything else too.
  const [target, ...combining] = [...records].sort((a, b) =>
    String(a.servicedOn || "").localeCompare(String(b.servicedOn || ""))
  );

  await openCompletedServiceForm(state, target, odometerMiles, { combining });

  state.combineMode = false;
  state.combineSelected = new Set();
  document.getElementById("vehicle-body").innerHTML = vehicleBodyHtml(state);
}

// What to say when an action fails. A refusal from the database is worth
// naming, because it has a specific cause and a specific fix.
function reportActionFailure(err) {
  console.error(err);
  const denied = err && (err.code === "permission-denied" || /insufficient permissions/i.test(err.message || ""));
  return openAlertModal(
    denied
      ? "The database refused that. Publish firestore.rules from this repo in your Firebase console, then try again."
      : `Something went wrong: ${err && err.message ? err.message : err}`
  );
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

// Editing one already-scheduled job keeps its own name field -- there's only
// ever one title to change. Adding new ones offers a line per job instead, so
// a whole visit's worth (inspection, wipers, cabin filter, all due at once)
// can be booked in one pass, sharing the date, mileage, shop, parts and notes
// below. Parts entered here land on the first job listed, not every one of
// them -- one shared field, one reservation off the shelf; putting the same
// list on several new jobs would take it off the shelf several times over for
// what's really one intended pick. Add parts to any other job afterward by
// editing it on its own.
async function openScheduleServiceForm(state, existing, odometerMiles) {
  const values = await openFormModal({
    title: existing ? "Edit scheduled service" : "Schedule service",
    hint: existing
      ? "Set a date, a mileage, both, or neither — whichever's set is what the reminder goes by."
      : "Set a date, a mileage, both, or neither — whichever's set is what the reminder goes by. Add a line for each job due at the same time.",
    fields: [
      existing
        ? {
            name: "title",
            label: "Service",
            type: "text",
            value: existing.title || "",
            placeholder: "Oil change",
            suggestions: serviceSuggestions(state),
          }
        : {
            name: "titles",
            label: "Services",
            type: "list",
            titlesOnly: true,
            itemPlaceholder: "Oil change",
            addLabel: "+ Add another job",
            value: [],
            suggestions: serviceSuggestions(state),
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
      {
        name: "shop",
        label: "Shop (optional)",
        type: "text",
        value: existing?.shop || "",
        placeholder: "Dave's Auto",
        suggestions: await knownShops(state),
      },
      {
        name: "partsNeeded",
        label: "Parts needed (optional)",
        type: "parts",
        value: existing?.partsNeeded || [],
        catalogue: state.parts || [],
        vehicleId: state.id,
        hint: existing
          ? "Taken off the shelf as soon as you save this — put it back by clearing the part here or deleting the job."
          : "Taken off the shelf as soon as you save this. Adding more than one job above? This applies to the first one listed.",
      },
      { name: "notes", label: "Notes (optional)", type: "textarea", value: existing?.notes || "" },
    ],
    submitLabel: existing ? "Save changes" : "Schedule it",
    destructive: existing ? { label: "Delete this service" } : null,
    validate: (v) => {
      const titled = existing ? !!v.title : (v.titles || []).some((item) => item.title);
      if (!titled) return "What service is it?";
      if (v.dueOdometer && !Number.isFinite(Number(v.dueOdometer))) return "That mileage doesn't look right.";
      return null;
    },
  });
  if (!values) return;
  if (values.__destructive) {
    await deleteService(state, existing.id);
    return;
  }

  const shared = {
    status: "scheduled",
    dueOn: values.dueOn || null,
    dueOdometerMiles: values.dueOdometer ? Math.round(Number(values.dueOdometer)) : null,
    shop: values.shop || null,
    notes: values.notes || null,
  };

  if (existing) {
    const partsNeeded = values.partsNeeded || [];
    // Reserving more takes the difference off the shelf; reserving less puts
    // it back -- the same delta the shelf would move if you'd counted the
    // parts out by hand. A record that's never actually been charged yet
    // (from before this reserved at assignment time) starts from nothing, so
    // touching it here is also what finally reserves it.
    const before = currentlyReserved(existing);
    await updateDoc(doc(db, "vehicles", state.id, "services", existing.id), {
      ...shared,
      title: values.title,
      partsNeeded,
      reserved: true,
    });
    await applyPartUsage(before, partsNeeded);
    showToast("Service updated");
  } else {
    const titles = (values.titles || []).map((item) => item.title).filter(Boolean);
    await Promise.all(
      titles.map((title, index) =>
        addDoc(collection(db, "vehicles", state.id, "services"), {
          ...shared,
          title,
          partsNeeded: index === 0 ? values.partsNeeded || [] : [],
          reserved: true,
          servicedOn: null,
          odometerMiles: null,
          costCents: null,
          parts: null,
          repeatMiles: null,
          repeatMonths: null,
          createdAt: serverTimestamp(),
        })
      )
    );
    await applyPartUsage([], values.partsNeeded || []);
    showToast(titles.length > 1 ? `${titles.length} services scheduled` : "Service scheduled");
  }
  await recomputeSummary(state.id);
}

// `folding` is a list of scheduled records being logged as one trip to the
// shop: the sheet opens with a line per job, the parts those jobs said they'd
// need, and their shop if they all name the same one. The records themselves
// come off the list once the visit is saved, and only for the jobs that were
// still on the sheet when it was -- taking a line off is how you say you didn't
// have that one done after all.
//
// `combining` is different: a list of already-done records the person picked
// by hand to merge into `existing`. Everything about them -- their items,
// their parts, their photos -- moves onto `existing` unconditionally, and they
// are then deleted. Unlike folding there's no partial-match safety valve:
// picking records to combine is already the deliberate step, so there's
// nothing left to second-guess once the sheet opens.
async function openCompletedServiceForm(state, existing, odometerMiles, { completing = false, folding = null, combining = null } = {}) {
  const isEditingDone = existing && existing.status === "done";
  const [{ photos: existingPhotos, error: photoError }, shops, combiningPhotos] = await Promise.all([
    existing ? loadServicePhotos(state.id, existing.id) : { photos: [], error: null },
    knownShops(state),
    combining ? Promise.all(combining.map((record) => loadServicePhotos(state.id, record.id))) : [],
  ]);
  // Photos already on a record being merged in read as if they were already on
  // this one -- stripped of their old id, so saving writes them fresh under
  // this record instead of trying to update someone else's document.
  const mergedPhotos = combining
    ? [...existingPhotos, ...combiningPhotos.flatMap((loaded) => loaded.photos).map(({ id, ...rest }) => rest)]
    : existingPhotos;
  const laborCentsSoFar = combining
    ? (existing?.laborCostCents || 0) + combining.reduce((sum, record) => sum + (record.laborCostCents || 0), 0)
    : folding
      ? folding.reduce((sum, record) => sum + (record.laborCostCents || 0), 0)
      : existing?.laborCostCents || 0;
  const values = await openFormModal({
    title: combining
      ? "Combine into one visit"
      : folding
        ? "Log these as one visit"
        : completing
        ? "Mark service done"
        : isEditingDone
          ? "Edit service record"
          : "Log completed service",
    fields: [
      {
        name: "items",
        label: "What was done",
        type: "list",
        value: combining
          ? [...serviceItems(existing), ...combining.flatMap((record) => serviceItems(record))]
          : existing
            ? serviceItems(existing)
            : folding
              ? folding.flatMap((record) => serviceItems(record))
              : [],
        suggestions: serviceSuggestions(state),
        hint: combining
          ? "Everything from the records you picked, as one trip. Their costs and parts came with them — check the total before saving."
          : folding
            ? "Everything on the service list, as one trip. Put a cost against each job, and take off any line you didn't have done — those stay on the list."
            : "One trip, several jobs — add a line for each. The total is added up for you.",
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
        value: combining ? sharedShop([existing, ...combining]) : existing?.shop || (folding ? sharedShop(folding) : "") || "",
        placeholder: "Dave's Auto",
        suggestions: shops,
      },
      {
        name: "laborCost",
        label: "Labor cost (optional)",
        type: "number",
        step: "0.01",
        inputmode: "decimal",
        min: 0,
        half: true,
        // Combining or folding several visits into one brings their labor
        // costs with them, added together -- same as items and parts do,
        // nothing about the trip gets left behind.
        value: laborCentsSoFar ? (laborCentsSoFar / 100).toFixed(2) : "",
        placeholder: "60.00",
        hint: "Added on top of the items above.",
      },
      {
        name: "partsUsed",
        label: "Parts used (optional)",
        type: "parts",
        // Marking a scheduled job done starts from what's already reserved
        // for it -- taken off the shelf back when the job was booked, not a
        // second trip to the shelf now; a whole visit starts from what all of
        // its jobs had reserved, added up the same way. Change the picked
        // parts here and only the difference moves, in either direction.
        value: combining
          ? [...(existing?.parts || []), ...combining.flatMap((record) => record.parts || [])]
          : existing?.parts ||
            (completing && existing ? existing.partsNeeded : null) ||
            (folding ? partsNeededAcross(folding) : null) ||
            [],
        catalogue: state.parts || [],
        vehicleId: state.id,
        // What the shelf says these cost can be dropped onto one of the jobs
        // above, so the receipt doesn't have to be added up by hand.
        appliesTo: "items",
        hint: "Only the difference from what's already reserved moves when this is saved.",
      },
      {
        name: "photos",
        label: "Receipt photos (optional)",
        type: "photos",
        value: mergedPhotos,
        hint: photoError
          ? "Receipts couldn't be loaded — publish firestore.rules from the repo in your Firebase console. Everything else here still saves."
          : "Photographed receipts are shrunk to fit before they're saved — enough to read, not enough to fill up your database.",
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
    submitLabel: combining ? "Combine records" : folding ? "Log the visit" : completing ? "Mark done" : "Save",
    destructive: isEditingDone ? { label: "Delete this service record" } : null,
    validate: (v) => {
      const named = (v.items || []).filter((item) => item.title);
      if (!named.length) return "What was done? Add at least one item.";
      if (!v.servicedOn) return "Pick the date it was done.";
      if ((v.items || []).some((item) => item.costCents !== null && Number.isNaN(item.costCents))) {
        return "One of those costs doesn't look like an amount.";
      }
      if (v.laborCost && Number.isNaN(dollarsToCents(v.laborCost))) return "That labor cost doesn't look like an amount.";
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
  const laborCostCents = values.laborCost ? dollarsToCents(values.laborCost) : null;

  const items = (values.items || []).filter((item) => item.title);
  const partsUsed = values.partsUsed || [];
  const payload = {
    title: visitTitle(items),
    status: "done",
    servicedOn: values.servicedOn,
    odometerMiles: odo,
    items,
    // Kept alongside the items so lists and totals don't have to add them up
    // every time they render -- labor on top, since it's the visit's own
    // cost rather than any one job's.
    costCents: (itemsTotalCents(items) || 0) + (laborCostCents || 0) || null,
    laborCostCents,
    shop: values.shop || null,
    // Notes belong to the item they're about now; the field stays on the record
    // so anything written before this still reads back.
    notes: null,
    repeatMiles,
    repeatMonths,
    dueOn: null,
    dueOdometerMiles: null,
    parts: partsUsed,
    partsNeeded: null,
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
  // What was already reserved against this record is given back before the
  // new list is taken off, so saving moves the shelf by the difference
  // rather than charging it twice -- a done record's actual usage, or a
  // still-open one's reservation, whichever this one has. Combining folds in
  // what the merged-away records had already reserved too -- those parts
  // left the shelf once, when each visit was first logged, and moving them
  // onto this record isn't a second trip to the shelf. A brand new record
  // (folding or a fresh log) has nothing of its own yet; a folded record's
  // own reservation is released separately below, as each one comes off the
  // list.
  const partsBefore = combining
    ? [...(existing?.parts || []), ...combining.flatMap((record) => record.parts || [])]
    : currentlyReserved(existing);
  await applyPartUsage(partsBefore, partsUsed);

  const photoSaveError = await saveServicePhotos(state.id, serviceId, values.photos, {
    hadCount: existingPhotos.length,
  });
  if (photoSaveError) {
    await openAlertModal(
      "The service record saved, but the receipt photos didn't. Publish firestore.rules from the repo in your Firebase console and try adding them again."
    );
  }

  // The visit is now what says these jobs were done, so their scheduled records
  // come off the list. Matching is by name, the way the rest of the app decides
  // two jobs are the same one -- so a line renamed on the sheet leaves its
  // record behind rather than guessing, which is the harmless way to be wrong.
  const foldedAway = folding ? folding.filter((record) => saidDone(record, items)) : [];
  for (const record of foldedAway) {
    // Each one had already reserved its own parts when it was booked --
    // releasing that here, per record, is what the combined deduction above
    // is actually being weighed against.
    await applyPartUsage(currentlyReserved(record), []);
    await deleteServicePhotos(state.id, record.id);
    await deleteDoc(doc(db, "vehicles", state.id, "services", record.id));
  }

  // A combined-away record is absorbed whole, not judged item by item -- its
  // parts and photos already moved onto this record above, so removing it here
  // must not touch the shelf again, only clear what it leaves behind: its own
  // photo subcollection and the document itself.
  if (combining) {
    for (const record of combining) {
      await deleteServicePhotos(state.id, record.id);
      await deleteDoc(doc(db, "vehicles", state.id, "services", record.id));
    }
  }

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
  } else if (combining) {
    showToast(`Combined ${combining.length + 1} records into one visit`);
  } else if (folding) {
    showToast(`Logged ${items.length} job${items.length === 1 ? "" : "s"} as one visit`);
  } else {
    showToast("Service logged");
  }

  await recomputeSummary(state.id);
}

// A shop only carries into the visit if every job on the list agrees on it;
// two different shops is a question for you, not a guess for the sheet.
function sharedShop(records) {
  const named = [...new Set(records.map((record) => record.shop).filter(Boolean))];
  return named.length === 1 ? named[0] : "";
}

// What the whole visit needs off the shelf: every job's own reservation,
// added up, so two oil changes on one trip ask for both lots of oil rather
// than one.
function partsNeededAcross(records) {
  const merged = new Map();
  for (const record of records) {
    for (const need of record.partsNeeded || []) {
      if (!need.partId) continue;
      const current = merged.get(need.partId) || { ...need, quantity: 0 };
      current.quantity += Number(need.quantity) || 0;
      merged.set(need.partId, current);
    }
  }
  return [...merged.values()];
}

// Whether a scheduled record's job is among the ones the saved visit covered.
function saidDone(record, items) {
  const covered = new Set(items.map((item) => normalizeJob(item.title)));
  return serviceItems(record).some((item) => item.title && covered.has(normalizeJob(item.title)));
}

async function deleteService(state, id) {
  const ok = await openConfirmModal({
    title: "Delete service?",
    message: "This removes it from the schedule and the history.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  const removed = state.services.find((service) => service.id === id);
  // Whatever it took off the shelf goes back on -- a done record's actual
  // usage, or a still-open one's reservation, whichever this one has.
  await applyPartUsage(currentlyReserved(removed), []);
  await deleteServicePhotos(state.id, id);
  await deleteDoc(doc(db, "vehicles", state.id, "services", id));
  await recomputeSummary(state.id);
}

function openVehicleMenu(state) {
  openPickerModal({
    title: state.vehicle.name,
    options: [
      { value: "edit", label: "Edit details" },
      { value: "import", label: "Import from a spreadsheet" },
      { value: "qr", label: "Show QR code" },
      { value: "delete", label: "Delete vehicle" },
    ],
  }).then((choice) => {
    if (choice === "edit") openEditVehicleForm(state);
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
    try {
      const photoSnap = await getDocs(collection(db, "vehicles", state.id, "services", service.id, "photos"));
      photoSnap.forEach((photo) => batch.delete(photo.ref));
    } catch (err) {
      console.warn("Couldn't list receipt photos while deleting", err);
    }
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
  const state = { id, vehicle: null, services: null, fillups: [], schedule: null, parts: [], serviceNames: [] };

  bodyEl.addEventListener("click", (event) => {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    Promise.resolve(handleScheduleAction(target.dataset.act, target.dataset.id, state)).catch(reportActionFailure);
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
  onSnapshot(
    collection(db, "parts"),
    (snap) => {
      state.parts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.parts.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    },
    // The picker is just a little shorter if this fails; nothing here depends on it.
    (err) => console.warn("Couldn't read the parts list", err)
  );
  onSnapshot(
    collection(db, "serviceNames"),
    (snap) => {
      state.serviceNames = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    // The suggestions are just a little shorter if this fails.
    (err) => console.warn("Couldn't read the service names list", err)
  );
}

function scheduleBodyHtml(state) {
  const odometerMiles = currentOdometer(state.vehicle, state.fillups, state.services);
  const rows = scheduleRows(state.schedule, state.services, {
    odometerMiles,
    today: new Date(),
    vehicleYear: state.vehicle.year,
  });
  const onTheList = onListTitles(state.services);

  return `
    <div class="page-head">
      <h1><span class="emoji">🗓️</span>Service schedule</h1>
      <button class="secondary small" data-act="add-plan">+ Add a service</button>
    </div>
    <p class="hint">${escapeHtml(state.vehicle.name)} · ${formatMiles(odometerMiles)} on the odometer.
    How often each job comes round, and when it's next needed. Worked out from what you've
    logged, so it moves on its own as you log more.</p>

    ${
      rows.length
        ? `<div class="list schedule-list">${rows
            .map((row) => scheduleRowHtml(row, odometerMiles, onTheList, state.parts))
            .join("")}</div>`
        : `<p class="empty small">Nothing set up yet. Add the jobs this vehicle needs on a
           schedule — an oil change every 5,000 miles, an inspection every year — and this page
           will tell you when each one is next due.</p>`
    }
  `;
}

function intervalText(entry) {
  const parts = [];
  if (entry.everyMiles) parts.push(`every ${entry.everyMiles.toLocaleString()} mi`);
  if (entry.everyMonths) parts.push(`every ${entry.everyMonths} month${entry.everyMonths === 1 ? "" : "s"}`);
  return parts.join(" or ") || "no interval set";
}

function scheduleRowHtml(row, odometerMiles, onTheList, parts) {
  const lastDone = row.lastDone
    ? `last done ${[
        row.lastDone.servicedOn ? formatISO(row.lastDone.servicedOn) : null,
        row.lastDone.odometerMiles !== null ? `at ${formatMiles(row.lastDone.odometerMiles)}` : null,
      ]
        .filter(Boolean)
        .join(" ")}`
    : row.countedFrom
      ? `never logged — counting from new, ${formatISO(row.countedFrom.servicedOn)} at ${formatMiles(row.countedFrom.odometerMiles)}`
      : "never logged — the first one you log starts the clock";

  // Only an entry with nothing to count from at all -- nothing logged and no
  // model year -- has no next-due to show.
  const next =
    row.status.key === "unknown"
      ? ""
      : `<span class="row-meta">next: ${escapeHtml(dueSummary(row, odometerMiles))}</span>`;

  // Every job can be added to the list, whether it's overdue or not far off at
  // all -- you decide what you're doing on Saturday, not the interval. Only the
  // pressing ones get the green button, so the page still says at a glance
  // which ones are asking rather than offering.
  const onList = onTheList.has(normalizeJob(row.title));
  const pressing = row.status.key === "overdue" || row.status.key === "soon";
  const action = onList
    ? `<span class="row-meta on-list">On the list</span>`
    : `<button class="${pressing ? "approve" : "secondary"} small" data-act="book-plan" data-id="${row.id}">Add to list</button>`;

  return `
    <div class="row service-row ${row.status.key} tappable" data-act="edit-plan" data-id="${row.id}">
      <div class="row-main">
        <span class="row-title-text">${escapeHtml(row.title)}</span>
        <span class="row-meta">${escapeHtml(intervalText(row))}</span>
        <span class="row-meta">${escapeHtml(lastDone)}</span>
        ${next}
        ${partsNeededHtml(row, parts)}
      </div>
      <div class="row-side">
        <span class="badge ${row.status.key}">${escapeHtml(row.status.label)}</span>
        ${action}
      </div>
    </div>
  `;
}

// The jobs already waiting on the vehicle's service list, so the schedule can
// say "on the list" instead of offering to add a second copy.
function onListTitles(services) {
  return new Set(
    (services || []).filter((service) => service.status !== "done").map((service) => normalizeJob(service.title))
  );
}

function handleScheduleAction(action, id, state) {
  if (!state.vehicle) return null;
  switch (action) {
    case "add-plan":
      return openPlanForm(state, null);
    case "edit-plan":
      return openPlanForm(state, state.schedule.find((entry) => entry.id === id) || null);
    case "book-plan":
      return bookPlanEntry(state, id);
    default:
      return null;
  }
}

async function openPlanForm(state, existing) {
  const suggestions = serviceNameSuggestions(state.serviceNames || [], state.id, { favoritesOnly: true });

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
        hint: suggestions.length
          ? undefined
          : "Nothing's favorited yet — star a name on the Service names page to offer it here.",
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
      {
        name: "partsNeeded",
        label: "Parts needed (optional)",
        type: "parts",
        value: existing?.partsNeeded || [],
        catalogue: state.parts || [],
        vehicleId: state.id,
        hint: "What this job uses every time it comes round. Add to list carries this over onto the booked job, which is what actually reserves it off the shelf — setting it here doesn't.",
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
    partsNeeded: values.partsNeeded || [],
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
//
// `partsNeeded` comes from the caller rather than being read off `entry`
// directly -- the schedule page passes the entry's own list, but a caller is
// free to book the same entry without one.
// Hands back what it wrote, so a caller holding its own copy of the garage
// could move the row across without reading it all again.
async function bookScheduleEntry(vehicleId, entry, services, { partsNeeded = [] } = {}) {
  if (onListTitles(services).has(normalizeJob(entry.title))) {
    await openAlertModal(`${entry.title} is already on the service list.`);
    return null;
  }

  const payload = {
    title: entry.title,
    status: "scheduled",
    dueOn: entry.dueOn ?? null,
    dueOdometerMiles: entry.dueOdometerMiles ?? null,
    shop: null,
    notes: null,
    servicedOn: null,
    odometerMiles: null,
    costCents: null,
    repeatMiles: entry.everyMiles ?? null,
    repeatMonths: entry.everyMonths ?? null,
    partsNeeded,
    reserved: true,
  };

  const added = await addDoc(collection(db, "vehicles", vehicleId, "services"), {
    ...payload,
    createdAt: serverTimestamp(),
  });
  // The schedule entry's parts list is only a default until this moment --
  // booking the job is what actually reserves it off the shelf.
  await applyPartUsage([], partsNeeded);
  await recomputeSummary(vehicleId);
  showToast(`${entry.title} added to the service list`);
  return { id: added.id, ...payload };
}

// One tap, no sheet: everything "Add to list" needs is already decided by the
// schedule entry itself -- the date or mileage it's due by, and now what it
// needs off the shelf too, set once on the entry rather than asked again on
// every occurrence it comes due.
async function bookPlanEntry(state, id) {
  const odometerMiles = currentOdometer(state.vehicle, state.fillups, state.services);
  const row = scheduleRows(state.schedule, state.services, {
    odometerMiles,
    today: new Date(),
    vehicleYear: state.vehicle.year,
  }).find((entry) => entry.id === id);
  if (!row) return;
  await bookScheduleEntry(state.id, row, state.services, { partsNeeded: row.partsNeeded || [] });
}

// What's actually been taken off the shelf for a record already, as opposed
// to what it simply lists. A done record's real usage is always in `parts`.
// An open one's is in `partsNeeded`, but only once `reserved` says that list
// has actually been charged to the shelf -- a record from before parts
// started reserving at assignment time carries a partsNeeded list that was
// never deducted, so treating it as already-reserved would silently skip
// charging the shelf the first time that record is touched. See
// migratePartsReservations for the one-time sweep that catches the rest.
function currentlyReserved(record) {
  if (!record) return [];
  if (record.status === "done") return record.parts || [];
  return record.reserved ? record.partsNeeded || [] : [];
}

// Moves the shelf by the difference between what a record used to book and what
// it books now. Every change is an atomic increment on its own part document,
// so nothing here depends on reading a quantity first -- two people logging
// service at the same time each get their subtraction.
async function applyPartUsage(before, after) {
  const deltas = new Map();
  for (const used of before) deltas.set(used.partId, (deltas.get(used.partId) || 0) + Number(used.quantity || 0));
  for (const used of after) deltas.set(used.partId, (deltas.get(used.partId) || 0) - Number(used.quantity || 0));

  for (const [partId, delta] of deltas) {
    if (!partId || !delta) continue;
    try {
      await updateDoc(doc(db, "parts", partId), { quantity: increment(delta), updatedAt: serverTimestamp() });
    } catch (err) {
      // A part deleted from the list since is the usual reason; the record
      // still says what it used.
      console.warn("Couldn't adjust the shelf for a part", partId, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Receipt photos
//
// One document per photo in a subcollection under the service record, so the
// service list stays light: it reads the records themselves, and the pictures
// are only fetched when a record is opened. The count is kept on the record so
// the list can show a paperclip without reading any of them.
// ---------------------------------------------------------------------------

// Receipts are an extra on the record, not a precondition for opening it. If
// they can't be read -- most likely because firestore.rules hasn't been
// published since photos were added, so the subcollection is denied by default
// -- the sheet still opens with everything else editable and says why the
// pictures are missing.
async function loadServicePhotos(vehicleId, serviceId) {
  try {
    const snap = await getDocs(collection(db, "vehicles", vehicleId, "services", serviceId, "photos"));
    return {
      photos: snap.docs
        .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
        .sort((a, b) => String(a.addedOn || "").localeCompare(String(b.addedOn || ""))),
      error: null,
    };
  } catch (err) {
    console.warn("Couldn't load receipt photos", err);
    return { photos: [], error: err };
  }
}

// Deleting a document leaves whatever is underneath it, so the photos have to
// go explicitly or they'd linger unreachable.
async function deleteServicePhotos(vehicleId, serviceId) {
  try {
    const snap = await getDocs(collection(db, "vehicles", vehicleId, "services", serviceId, "photos"));
    await Promise.all(snap.docs.map((docSnap) => deleteDoc(docSnap.ref)));
  } catch (err) {
    // Better to leave a picture behind than to refuse to delete the record.
    console.warn("Couldn't clear receipt photos", err);
  }
}

async function saveServicePhotos(vehicleId, serviceId, photos, { hadCount = 0 } = {}) {
  if (!photos) return null;
  const { items = [], removedIds = [] } = photos;
  const added = items.filter((photo) => !photo.id);

  // Nothing to do is the common case when someone edits a record's costs, so
  // don't write -- and don't risk failing -- for no reason.
  if (!added.length && !removedIds.length && items.length === hadCount) return null;

  const photosRef = collection(db, "vehicles", vehicleId, "services", serviceId, "photos");
  try {
    for (const id of removedIds) {
      await deleteDoc(doc(db, "vehicles", vehicleId, "services", serviceId, "photos", id));
    }
    for (const photo of added) {
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
    return null;
  } catch (err) {
    // The record itself is already saved by this point; say what didn't make it
    // rather than pretending the whole edit failed.
    console.warn("Couldn't save receipt photos", err);
    return err;
  }
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
  const open = openServices(services, ctx);
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
