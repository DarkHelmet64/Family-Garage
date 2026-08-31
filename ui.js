// ---------------------------------------------------------------------------
// Modals, toasts, QR codes, and the little SVG chart.
//
// Every dialog here is in-page rather than window.prompt/alert/confirm: iOS
// Safari silently disables the native ones once a page is opened from a
// home-screen icon, which is exactly how this app gets used at a gas pump.
// ---------------------------------------------------------------------------

import { formatMpg, formatISO, formatUSD, dollarsToCents } from "./format.js";
import { readReceiptPhoto, PhotoError, formatBytes } from "./photos.js";

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str === null || str === undefined ? "" : str;
  return div.innerHTML;
}

export function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Clipboard API unavailable (older browsers, some webviews) -- fall back below.
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

export function buildModal(innerHtml, { onDismiss } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `<div class="modal">${innerHtml}</div>`;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.remove();
      if (onDismiss) onDismiss();
    }
  });
  document.body.appendChild(overlay);
  return overlay;
}

export function openAlertModal(message) {
  return new Promise((resolve) => {
    const overlay = buildModal(
      `
        <p>${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button id="alert-ok">OK</button>
        </div>
      `,
      { onDismiss: () => resolve() }
    );
    overlay.querySelector("#alert-ok").addEventListener("click", () => {
      overlay.remove();
      resolve();
    });
  });
}

export function openConfirmModal({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const overlay = buildModal(
      `
        <h2>${escapeHtml(title)}</h2>
        ${message ? `<p class="hint">${escapeHtml(message)}</p>` : ""}
        <div class="modal-actions">
          <button class="secondary" id="confirm-cancel">Cancel</button>
          <button class="${danger ? "danger-solid" : ""}" id="confirm-ok">${escapeHtml(confirmLabel)}</button>
        </div>
      `,
      { onDismiss: () => resolve(false) }
    );
    const finish = (value) => {
      overlay.remove();
      resolve(value);
    };
    overlay.querySelector("#confirm-cancel").addEventListener("click", () => finish(false));
    overlay.querySelector("#confirm-ok").addEventListener("click", () => finish(true));
  });
}

export function openPickerModal({ title, options, cancelLabel = "Cancel" }) {
  return new Promise((resolve) => {
    const overlay = buildModal(
      `
        <h2>${escapeHtml(title)}</h2>
        <div class="picker-list">
          ${options
            .map(
              (opt) =>
                `<button class="secondary picker-option" data-value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</button>`
            )
            .join("")}
        </div>
        <div class="modal-actions">
          <button class="secondary" id="picker-cancel">${escapeHtml(cancelLabel)}</button>
        </div>
      `,
      { onDismiss: () => resolve(null) }
    );
    const finish = (value) => {
      overlay.remove();
      resolve(value);
    };
    overlay.querySelector("#picker-cancel").addEventListener("click", () => finish(null));
    overlay.querySelectorAll(".picker-option").forEach((button) => {
      button.addEventListener("click", () => finish(button.dataset.value));
    });
  });
}

// ---------------------------------------------------------------------------
// Form modal
//
// Fill-ups and service records are both "a handful of labelled fields and a
// Save button", so they share one builder rather than each hand-rolling a form.
// Fields marked `half: true` sit two-per-row; everything else spans the width.
// Resolves with a { name: value } object, or null if the sheet was dismissed.
// ---------------------------------------------------------------------------

export function openFormModal({ title, hint, fields, submitLabel = "Save", validate, destructive }) {
  return new Promise((resolve) => {
    const fieldHtml = fields.map((field) => renderField(field)).join("");

    const overlay = buildModal(
      `
        <h2>${escapeHtml(title)}</h2>
        ${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ""}
        <div class="form-grid">${fieldHtml}</div>
        <p class="form-error" id="form-error" hidden></p>
        <div class="modal-actions">
          <button class="secondary" id="form-cancel">Cancel</button>
          <button id="form-submit">${escapeHtml(submitLabel)}</button>
        </div>
        ${destructive ? `<button class="link-danger" id="form-destructive">${escapeHtml(destructive.label)}</button>` : ""}
      `,
      { onDismiss: () => resolve(null) }
    );

    const errorEl = overlay.querySelector("#form-error");

    // Photo fields keep their own state: which pictures are on the record now,
    // which have been added in this sheet, and which have been taken off.
    const photoState = new Map();
    for (const field of fields) {
      if (field.type !== "photos") continue;
      photoState.set(field.name, { items: [...(field.value || [])], removedIds: [] });
      bindPhotoField(overlay, field, photoState.get(field.name), errorEl);
    }

    // A list field (the line items on a service visit) keeps its rows in its
    // own state and hands back a read function, since the rows come and go
    // while the sheet is open.
    const listState = new Map();
    for (const field of fields) {
      if (field.type === "list") listState.set(field.name, bindListField(overlay, field));
    }
    for (const field of fields) {
      if (field.type !== "parts") continue;
      const parts = bindPartsField(overlay, field);
      listState.set(field.name, parts);
      // A parts field naming a list field can hand it what the shelf says
      // those parts cost. Bound after the list fields so it's there to name.
      const lines = field.appliesTo && listState.get(field.appliesTo);
      if (lines && lines.lines) parts.useLines(lines);
    }

    // Bound before the Enter-to-submit handler below, so that when the panel is
    // open Enter picks the highlighted suggestion instead of saving the sheet.
    for (const field of fields) {
      if (field.type === "list" || !field.suggestions) continue;
      const input = overlay.querySelector(`[data-field="${field.name}"]`);
      if (input) attachSuggest(input, field.suggestions);
    }

    const readValues = () => {
      const values = {};
      for (const field of fields) {
        if (field.type === "photos") {
          values[field.name] = photoState.get(field.name);
          continue;
        }
        if (field.type === "list" || field.type === "parts") {
          values[field.name] = listState.get(field.name).read();
          continue;
        }
        if (field.type === "checks") {
          values[field.name] = [...overlay.querySelectorAll(`[data-check="${field.name}"]:checked`)].map(
            (box) => box.value
          );
          continue;
        }
        const input = overlay.querySelector(`[data-field="${field.name}"]`);
        if (!input) continue;
        values[field.name] = field.type === "checkbox" ? input.checked : input.value.trim();
      }
      return values;
    };

    const submit = () => {
      const values = readValues();
      const error = validate ? validate(values) : null;
      if (error) {
        errorEl.textContent = error;
        errorEl.hidden = false;
        return;
      }
      overlay.remove();
      resolve(values);
    };

    overlay.querySelector("#form-cancel").addEventListener("click", () => {
      overlay.remove();
      resolve(null);
    });
    overlay.querySelector("#form-submit").addEventListener("click", submit);
    // Editing and deleting the same record belong in the same sheet, so rows in
    // the log don't each need to carry their own Delete button.
    if (destructive) {
      overlay.querySelector("#form-destructive").addEventListener("click", () => {
        overlay.remove();
        resolve({ __destructive: true });
      });
    }
    overlay.querySelectorAll("input").forEach((input) => {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
    });

    const first = overlay.querySelector("[data-field]");
    if (first && first.type !== "checkbox") {
      // Focus the first field without its suggestions springing open: a sheet
      // that opens with a dropdown already covering it hides the form before
      // anyone has asked for help.
      first.dataset.suggestSilent = "1";
      first.focus();
      delete first.dataset.suggestSilent;
    }
  });
}

function renderField(field) {
  const {
    name,
    label,
    type = "text",
    value = "",
    placeholder = "",
    hint,
    half = false,
    options = [],
    step,
    min,
    inputmode,
    suggestions,
  } = field;

  const shared = `data-field="${escapeHtml(name)}" id="field-${escapeHtml(name)}"`;
  const hintHtml = hint ? `<span class="field-hint">${escapeHtml(hint)}</span>` : "";

  if (type === "parts") {
    return `
      <div class="field" data-parts-field="${escapeHtml(name)}">
        <label>${escapeHtml(label)}</label>
        <div class="item-list" data-parts-rows="${escapeHtml(name)}"></div>
        <div class="item-list-foot">
          <button type="button" class="secondary small" data-parts-add="${escapeHtml(name)}">+ Add part</button>
          <span class="item-total" data-parts-total="${escapeHtml(name)}"></span>
        </div>
        ${hintHtml}
      </div>`;
  }

  if (type === "list") {
    return `
      <div class="field" data-list-field="${escapeHtml(name)}">
        <label>${escapeHtml(label)}</label>
        <div class="item-list" data-list-rows="${escapeHtml(name)}"></div>
        <div class="item-list-foot">
          <button type="button" class="secondary small" data-list-add="${escapeHtml(name)}">+ Add item</button>
          <span class="item-total" data-list-total="${escapeHtml(name)}"></span>
        </div>
        ${hintHtml}
      </div>`;
  }

  if (type === "photos") {
    return `
      <div class="field" data-photo-field="${escapeHtml(name)}">
        <label>${escapeHtml(label)}</label>
        <div class="photo-strip" data-photo-strip="${escapeHtml(name)}"></div>
        ${hintHtml}
      </div>`;
  }

  // Several answers to one question -- which vehicles a part fits, say. Chips
  // rather than a stack of checkboxes: the whole set has to be readable at a
  // glance to be worth ticking.
  if (type === "checks") {
    const chosen = new Set(Array.isArray(value) ? value : []);
    return `
      <div class="field">
        <label>${escapeHtml(label)}</label>
        <div class="check-row">
          ${options
            .map(
              (option) => `
            <label class="check-chip">
              <input type="checkbox" data-check="${escapeHtml(name)}" value="${escapeHtml(option.value)}"
                     ${chosen.has(option.value) ? "checked" : ""} />
              <span>${escapeHtml(option.label)}</span>
            </label>`
            )
            .join("")}
        </div>
        ${hintHtml}
      </div>`;
  }

  if (type === "checkbox") {
    return `
      <label class="field field-check" for="field-${escapeHtml(name)}">
        <input type="checkbox" ${shared} ${value ? "checked" : ""} />
        <span><span class="check-label">${escapeHtml(label)}</span>${hintHtml}</span>
      </label>`;
  }

  const control =
    type === "select"
      ? `<select ${shared}>
           ${options
             .map(
               (opt) =>
                 `<option value="${escapeHtml(opt.value)}" ${opt.value === value ? "selected" : ""}>${escapeHtml(opt.label)}</option>`
             )
             .join("")}
         </select>`
      : type === "textarea"
        ? `<textarea ${shared} rows="2" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`
        : `<input ${shared} type="${escapeHtml(type)}" value="${escapeHtml(value)}"
             placeholder="${escapeHtml(placeholder)}"
             ${step ? `step="${escapeHtml(step)}"` : ""}
             ${min !== undefined ? `min="${escapeHtml(min)}"` : ""}
             ${inputmode ? `inputmode="${escapeHtml(inputmode)}"` : ""}
             autocomplete="off" />`;

  return `
    <div class="field ${half ? "field-half" : ""}">
      <label for="field-${escapeHtml(name)}">${escapeHtml(label)}</label>
      ${control}
      ${hintHtml}
    </div>`;
}

// Which parts a job uses, chosen off the shelf. Each row is a part and how many
// of it; the count of what's actually in stock rides along in the option text
// and a warning appears under any row asking for more than there is.
// Only what fits the vehicle in hand. A part naming no vehicle fits anything,
// which is what a case of oil or a box of rags is; one naming other vehicles
// is left out.
//
// Except whatever the row already holds, which stays offered however it's
// marked. A part can be booked against a vehicle and marked for another
// afterwards, and dropping it from the list would empty the select and quietly
// change what a saved record says was used.
function partOptionsHtml(catalogue, selectedId, vehicleId) {
  const optionHtml = (part) =>
    `<option value="${escapeHtml(part.id)}" ${part.id === selectedId ? "selected" : ""}>${escapeHtml(part.name)} (${escapeHtml(String(part.quantity ?? 0))} ${escapeHtml(part.unit || "each")})</option>`;

  const fits = (part) => !(part.fitsVehicleIds || []).length || part.fitsVehicleIds.includes(vehicleId);
  const offered = vehicleId ? catalogue.filter((part) => fits(part) || part.id === selectedId) : catalogue;

  // An empty list is a dead end otherwise -- nothing to pick and no reason why.
  const placeholder = offered.length
    ? `<option value="">— pick a part —</option>`
    : `<option value="">— nothing on the shelf fits this vehicle —</option>`;

  return placeholder + offered.map(optionHtml).join("");
}

function bindPartsField(overlay, field) {
  const rowsEl = overlay.querySelector(`[data-parts-rows="${field.name}"]`);
  const addButton = overlay.querySelector(`[data-parts-add="${field.name}"]`);
  const totalEl = overlay.querySelector(`[data-parts-total="${field.name}"]`);
  const catalogue = field.catalogue || [];
  // Set by openFormModal when this field names a list field whose jobs its
  // parts can be booked against. Without one the picker behaves as it always
  // did: parts and quantities, with nothing to attribute them to.
  let lineField = null;
  // What this field last wrote into each job line, by line id, so it can tell
  // its own figures from ones typed by hand.
  const written = new Map();

  let rows = (field.value || []).map((used) => ({
    partId: used.partId || "",
    quantity: used.quantity != null ? String(used.quantity) : "1",
    // The saved job name, resolved to a line once the lines are known.
    forJob: used.forJob || "",
    lineId: null,
  }));

  const sync = () => {
    const previous = rows;
    rows = [...rowsEl.querySelectorAll("[data-part-row]")].map((row, index) => {
      const pick = row.querySelector("[data-part-job]");
      const was = previous[index] || { forJob: "", lineId: null };
      return {
        partId: row.querySelector("[data-part-id]").value,
        quantity: row.querySelector("[data-part-qty]").value,
        forJob: was.forJob,
        lineId: pick ? (pick.value === "" ? null : Number(pick.value)) : was.lineId,
      };
    });
  };

  // What the shelf says a row costs. A part with no cost-each recorded
  // contributes nothing rather than nothing-at-all: the total is of what's
  // priced, and rows without a price simply don't show one.
  const rowCostCents = (row) => {
    const part = catalogue.find((candidate) => candidate.id === row.partId);
    const quantity = Number(row.quantity);
    if (!part || !part.unitCostCents || !Number.isFinite(quantity)) return null;
    return part.unitCostCents * quantity;
  };

  const totalCents = () => rows.reduce((sum, row) => sum + (rowCostCents(row) || 0), 0);

  const costLine = (row) => {
    const part = catalogue.find((candidate) => candidate.id === row.partId);
    return `${formatUSD(part.unitCostCents)} each = ${formatUSD(rowCostCents(row))}`;
  };

  const asDollars = (cents) => (cents / 100).toFixed(2);
  const titledLines = () => (lineField ? lineField.lines().filter((line) => line.title) : []);

  // Each part's cost lands on the job it was booked against -- the oil on the
  // oil change, the blades on the wiper job. One job on the sheet is not a
  // choice, so everything goes to it.
  const perLine = (lines) => {
    const sums = new Map();
    for (const row of rows) {
      const cents = rowCostCents(row);
      if (!cents) continue;
      const target = lines.length === 1 ? lines[0] : lines.find((line) => line.id === row.lineId);
      if (target) sums.set(target.id, (sums.get(target.id) || 0) + cents);
    }
    return sums;
  };

  // A line is this field's to write while it holds exactly what was put there,
  // or nothing at all. A figure typed over by hand is the receipt disagreeing
  // with the shelf, and the receipt wins from then on.
  const applyCosts = () => {
    if (!lineField) return;
    const lines = titledLines();
    const sums = perLine(lines);
    for (const line of lines) {
      const ours = written.has(line.id) ? line.cost === asDollars(written.get(line.id)) : line.cost === "";
      if (!ours) continue;
      const cents = sums.get(line.id) || 0;
      if (cents) {
        lineField.setCost(line.id, asDollars(cents));
        written.set(line.id, cents);
      } else if (written.has(line.id)) {
        lineField.setCost(line.id, "");
        written.delete(line.id);
      }
    }
  };

  // Only worth asking once there's more than one job it could belong to.
  const jobPickHtml = (row, lines) =>
    lines.length < 2
      ? ""
      : `<div class="part-job">
           <span class="part-job-label">for</span>
           <select data-part-job>
             <option value="">— which job? —</option>
             ${lines
               .map(
                 (line) =>
                   `<option value="${line.id}" ${line.id === row.lineId ? "selected" : ""}>${escapeHtml(line.title)}</option>`
               )
               .join("")}
           </select>
         </div>`;

  const shortfall = (row) => {
    const part = catalogue.find((candidate) => candidate.id === row.partId);
    if (!part) return null;
    const wanted = Number(row.quantity);
    const have = Number(part.quantity) || 0;
    if (!Number.isFinite(wanted) || wanted <= have) return null;
    return `only ${have} ${part.unit || "each"} on the shelf`;
  };

  const render = () => {
    const lines = titledLines();
    rowsEl.innerHTML = rows
      .map(
        (row, index) => `
        <div class="item-row" data-part-row>
          <div class="item-row-top">
            <select data-part-id>
              ${partOptionsHtml(catalogue, row.partId, field.vehicleId)}
            </select>
            <input data-part-qty type="number" step="0.01" min="0" inputmode="decimal"
                   placeholder="Qty" value="${escapeHtml(row.quantity)}" />
            <button type="button" class="item-remove" data-part-remove="${index}" title="Remove">×</button>
          </div>
          ${jobPickHtml(row, lines)}
          ${rowCostCents(row) ? `<span class="field-hint">${escapeHtml(costLine(row))}</span>` : ""}
          ${shortfall(row) ? `<span class="field-hint short">${escapeHtml(shortfall(row))}</span>` : ""}
        </div>`
      )
      .join("");

    rowsEl.querySelectorAll("[data-part-remove]").forEach((button) => {
      button.addEventListener("click", () => {
        sync();
        rows.splice(Number(button.dataset.partRemove), 1);
        render();
      });
    });
    rowsEl.querySelectorAll("[data-part-id], [data-part-qty], [data-part-job]").forEach((control) => {
      control.addEventListener("change", () => {
        sync();
        render();
      });
    });

    totalEl.textContent = totalCents() ? `Parts ${formatUSD(totalCents())}` : "";
    applyCosts();
  };

  // The job names change as they're typed, and the pickers have to follow --
  // but rebuilding the whole picker would tear out the select or quantity box
  // someone may be in the middle of. Only the options are replaced, and only
  // when a job appearing or disappearing changes whether there's a choice at
  // all is the row rebuilt.
  const refreshJobs = () => {
    const lines = titledLines();
    const rowEls = [...rowsEl.querySelectorAll("[data-part-row]")];
    const wanted = lines.length >= 2;
    const shown = rowEls.length > 0 && rowEls.every((el) => !!el.querySelector("[data-part-job]"));
    if (rowEls.length && wanted !== shown) {
      sync();
      render();
      return;
    }
    rowEls.forEach((el, index) => {
      const pick = el.querySelector("[data-part-job]");
      if (!pick) return;
      const current = rows[index] ? rows[index].lineId : null;
      pick.innerHTML =
        `<option value="">— which job? —</option>` +
        lines.map((line) => `<option value="${line.id}">${escapeHtml(line.title)}</option>`).join("");
      pick.value = lines.some((line) => line.id === current) ? String(current) : "";
    });
    sync();
    applyCosts();
  };

  addButton.addEventListener("click", () => {
    sync();
    rows.push({ partId: "", quantity: "1", forJob: "", lineId: null });
    render();
  });

  render();

  return {
    // Wired up by openFormModal once both fields exist.
    useLines: (controller) => {
      lineField = controller;
      // A saved record names the job it went on, since line ids only live as
      // long as the sheet is open. Match those back up now the lines exist.
      const lines = titledLines();
      for (const row of rows) {
        if (!row.forJob) continue;
        const match = lines.find((line) => line.title.toLowerCase() === String(row.forJob).toLowerCase());
        if (match) row.lineId = match.id;
      }
      controller.onChange(refreshJobs);
      render();
    },
    read: () => {
      sync();
      const lines = titledLines();
      return rows
        .filter((row) => row.partId && Number(row.quantity) > 0)
        .map((row) => {
          const part = catalogue.find((candidate) => candidate.id === row.partId) || {};
          const job = lines.length === 1 ? lines[0] : lines.find((line) => line.id === row.lineId);
          return {
            partId: row.partId,
            // Kept alongside the id, not looked up from it: what the record
            // says was used shouldn't change because the shelf entry was later
            // edited, renamed, or taken off the list altogether.
            name: part.name || "Part",
            unit: part.unit || "each",
            modelNumber: part.modelNumber || null,
            size: part.size || null,
            vendor: part.vendor || null,
            // Which job it went on, by name -- the only handle that survives
            // the sheet being closed and opened again.
            forJob: job ? job.title : null,
            quantity: Number(row.quantity),
          };
        });
    },
  };
}

// A dropdown of things typed before, narrowing as you type.
//
// This replaces the browser's own <datalist>, which looks like the right tool
// and isn't: whether it filters, and whether it appears at all, varies by
// browser, and on an iPhone -- where this app mostly gets used, standing next
// to the car -- it is least dependable of all. A short list drawn in the page
// behaves the same everywhere.
const SUGGEST_LIMIT = 8;

// Panels live on <body>, so they outlive the field they belong to unless
// something clears them up: close a sheet with its dropdown open and the input
// goes while the panel stays, stranded over the page. Watching body's children
// catches the sheet being removed straight away, rather than waiting for a tap
// that the stranded panel would swallow anyway.
const suggestPanels = new Set();

function sweepSuggestPanels() {
  for (const entry of [...suggestPanels]) {
    if (!entry.input.isConnected) entry.destroy();
  }
}

if (typeof MutationObserver !== "undefined" && typeof document !== "undefined" && document.body) {
  new MutationObserver(sweepSuggestPanels).observe(document.body, { childList: true });
}

export function attachSuggest(input, suggestions) {
  if (!suggestions || !suggestions.length || input.dataset.suggestBound) return;
  input.dataset.suggestBound = "1";

  // The panel lives on <body> and is positioned over the field, rather than
  // sitting inside it. Inside, an absolutely positioned panel counts towards
  // the sheet's scrollable area: opening one made the sheet taller, and closing
  // it shrank it again and slid everything up by the difference. Press Cancel
  // with the panel open and the button moved out from under the release --
  // no click, nothing happened.
  const panel = document.createElement("div");
  panel.className = "suggest-panel";
  panel.hidden = true;
  document.body.appendChild(panel);

  let matches = [];
  let active = -1;

  const place = () => {
    const rect = input.getBoundingClientRect();
    panel.style.left = `${Math.round(rect.left)}px`;
    panel.style.width = `${Math.round(rect.width)}px`;

    // Stay clear of the sheet's own buttons. They're pinned to the bottom of
    // the sheet, and a dropdown lying over Save and Cancel would leave someone
    // unable to finish what they were typing.
    const actions = input.closest(".modal") && input.closest(".modal").querySelector(".modal-actions");
    const floor = actions ? Math.min(actions.getBoundingClientRect().top, window.innerHeight) : window.innerHeight;

    const roomBelow = floor - rect.bottom - 10;
    const roomAbove = rect.top - 10;
    // Below by default; above when there's more room there -- which on a phone
    // is wherever the keyboard has pushed the field.
    const goBelow = roomBelow >= 150 || roomBelow >= roomAbove;

    panel.style.maxHeight = `${Math.max(80, Math.min(220, goBelow ? roomBelow : roomAbove))}px`;
    if (goBelow) {
      panel.style.bottom = "auto";
      panel.style.top = `${Math.round(rect.bottom + 4)}px`;
    } else {
      panel.style.top = "auto";
      panel.style.bottom = `${Math.round(window.innerHeight - rect.top + 4)}px`;
    }
  };

  // Anything starting with what's typed comes first, then anything containing
  // it -- so "oil" offers "Oil change" before "Transmission fluid and oil".
  const findMatches = (value) => {
    const query = value.trim().toLowerCase();
    if (!query) return suggestions.slice(0, SUGGEST_LIMIT);
    const starts = [];
    const contains = [];
    for (const suggestion of suggestions) {
      const lower = suggestion.toLowerCase();
      if (lower === query) continue; // already typed in full
      if (lower.startsWith(query)) starts.push(suggestion);
      else if (lower.includes(query)) contains.push(suggestion);
    }
    return [...starts, ...contains].slice(0, SUGGEST_LIMIT);
  };

  const close = () => {
    panel.hidden = true;
    active = -1;
  };

  const entry = { input, destroy: () => {} };
  const destroy = () => {
    panel.remove();
    suggestPanels.delete(entry);
    document.removeEventListener("pointerdown", closeOnOutside, true);
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
  };
  entry.destroy = destroy;
  suggestPanels.add(entry);

  const draw = () => {
    // Rows come and go inside a sheet as items are added and removed, taking
    // their fields with them; this clears up after those too.
    sweepSuggestPanels();
    // Only ever open under the field someone is actually in. Without this a
    // value set from elsewhere -- or a stale event -- can leave the panel
    // hanging over the rest of the sheet, swallowing taps meant for it.
    if (document.activeElement !== input) return close();
    matches = findMatches(input.value);
    if (!matches.length) return close();
    panel.innerHTML = matches
      .map(
        (suggestion, index) =>
          `<button type="button" class="suggest-option${index === active ? " active" : ""}"
                   data-suggest-index="${index}">${escapeHtml(suggestion)}</button>`
      )
      .join("");
    panel.hidden = false;
    place();
  };

  const reposition = () => {
    if (!panel.hidden) place();
  };

  const choose = (index) => {
    if (index < 0 || index >= matches.length) return;
    input.value = matches[index];
    input.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    input.focus();
  };

  const closeOnOutside = (event) => {
    if (!input.isConnected) return destroy();
    if (event.target === input || panel.contains(event.target)) return;
    close();
  };

  input.addEventListener("focus", () => {
    if (input.dataset.suggestSilent) return;
    draw();
  });
  // Tapping a field that already has focus fires no focus event, so this is
  // what opens the list when someone comes back to it.
  input.addEventListener("click", draw);
  input.addEventListener("input", () => {
    active = -1;
    draw();
  });

  input.addEventListener("keydown", (event) => {
    if (panel.hidden) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      active = event.key === "ArrowDown"
        ? Math.min(active + 1, matches.length - 1)
        : Math.max(active - 1, 0);
      draw();
      return;
    }
    if (event.key === "Enter" && active >= 0) {
      // Stop the form's own Enter handler: picking a suggestion and saving the
      // sheet in one keystroke is nobody's intention.
      event.preventDefault();
      event.stopImmediatePropagation();
      choose(active);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }
  });

  // mousedown rather than click, so the choice registers before the input
  // loses focus and takes the panel with it.
  panel.addEventListener("mousedown", (event) => {
    const option = event.target.closest("[data-suggest-index]");
    if (!option) return;
    event.preventDefault();
    choose(Number(option.dataset.suggestIndex));
  });

  input.addEventListener("blur", () =>
    setTimeout(() => {
      close();
      if (!input.isConnected) destroy();
    }, 120)
  );

  // A tap anywhere else puts the panel away, and the sheet scrolling under it
  // keeps it with its field.
  document.addEventListener("pointerdown", closeOnOutside, true);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
}

// One service visit, several things done. Each row is a line item -- what was
// done, what it cost, and any note about it -- and the total underneath is the
// sum, so nobody has to add up a receipt by hand.
//
// Rows are read out of the DOM before every re-render, so half-typed text
// survives adding or removing a row.
function bindListField(overlay, field) {
  const rowsEl = overlay.querySelector(`[data-list-rows="${field.name}"]`);
  const totalEl = overlay.querySelector(`[data-list-total="${field.name}"]`);
  const addButton = overlay.querySelector(`[data-list-add="${field.name}"]`);

  // Rows carry an id of their own because another field points at them, and
  // position won't do for that: removing the first line would silently move
  // every part booked against the second onto the third.
  let nextId = 0;
  let rows = (field.value || []).map((item) => ({
    id: ++nextId,
    title: item.title || "",
    cost: item.costCents !== null && item.costCents !== undefined ? (item.costCents / 100).toFixed(2) : "",
    notes: item.notes || "",
  }));
  if (!rows.length) rows = [{ id: ++nextId, title: "", cost: "", notes: "" }];

  const sync = () => {
    rows = [...rowsEl.querySelectorAll("[data-item-row]")].map((row, index) => ({
      id: rows[index] ? rows[index].id : ++nextId,
      title: row.querySelector("[data-item-title]").value,
      cost: row.querySelector("[data-item-cost]").value,
      notes: row.querySelector("[data-item-notes]").value,
    }));
  };

  const updateTotal = () => {
    const cents = [...rowsEl.querySelectorAll("[data-item-cost]")].reduce((sum, input) => {
      const value = dollarsToCents(input.value);
      return sum + (input.value && Number.isFinite(value) ? value : 0);
    }, 0);
    totalEl.textContent = cents ? `Total ${formatUSD(cents)}` : "";
  };

  const render = () => {
    rowsEl.innerHTML = rows
      .map(
        (row, index) => `
        <div class="item-row" data-item-row>
          <div class="item-row-top">
            <input data-item-title type="text" placeholder="What was done" value="${escapeHtml(row.title)}"
                   autocomplete="off" />
            <input data-item-cost type="number" step="0.01" min="0" inputmode="decimal"
                   placeholder="Cost" value="${escapeHtml(row.cost)}" />
            <button type="button" class="item-remove" data-item-remove="${index}"
                    title="Remove this item" ${rows.length === 1 ? "disabled" : ""}>×</button>
          </div>
          <input data-item-notes type="text" placeholder="Notes for this item (optional)"
                 value="${escapeHtml(row.notes)}" autocomplete="off" />
        </div>`
      )
      .join("");

    if (field.suggestions) {
      rowsEl.querySelectorAll("[data-item-title]").forEach((input) => attachSuggest(input, field.suggestions));
    }
    rowsEl.querySelectorAll("[data-item-remove]").forEach((button) => {
      button.addEventListener("click", () => {
        sync();
        rows.splice(Number(button.dataset.itemRemove), 1);
        render();
      });
    });
    rowsEl.querySelectorAll("[data-item-cost]").forEach((input) => {
      input.addEventListener("input", updateTotal);
    });
    updateTotal();
  };

  addButton.addEventListener("click", () => {
    sync();
    rows.push({ id: ++nextId, title: "", cost: "", notes: "" });
    render();
    const inputs = rowsEl.querySelectorAll("[data-item-title]");
    inputs[inputs.length - 1].focus();
  });

  render();

  return {
    read: () => {
      sync();
      return rows
        .filter((row) => row.title.trim() || row.cost.trim() || row.notes.trim())
        .map((row) => ({
          title: row.title.trim(),
          costCents: row.cost.trim() ? dollarsToCents(row.cost) : null,
          notes: row.notes.trim() || null,
        }));
    },
    // What the parts field needs to offer "apply to": what the lines are
    // called, and a way to put a figure in one of them.
    lines: () => {
      sync();
      return rows.map((row, index) => ({ id: row.id, index, title: row.title.trim(), cost: row.cost.trim() }));
    },
    setCost: (id, dollars) => {
      const index = rows.findIndex((row) => row.id === id);
      const input = index < 0 ? null : rowsEl.querySelectorAll("[data-item-cost]")[index];
      if (!input) return;
      input.value = dollars;
      sync();
      updateTotal();
    },
    onChange: (fn) => {
      // Titles change as they're typed, and the apply-to list has to follow.
      rowsEl.addEventListener("input", fn);
      rowsEl.addEventListener("change", fn);
      addButton.addEventListener("click", fn);
    },
  };
}

// A strip of thumbnails with an Add tile on the end. Tapping a thumbnail opens
// it full size, which is also where it can be taken off the record.
function bindPhotoField(overlay, field, state, errorEl) {
  const strip = overlay.querySelector(`[data-photo-strip="${field.name}"]`);
  let busy = 0;

  const render = () => {
    const thumbs = state.items
      .map(
        (photo, index) => `
        <button type="button" class="photo-thumb" data-photo-index="${index}"
                title="${escapeHtml(formatBytes(photo.bytes || photo.dataUrl.length))}">
          <img src="${photo.dataUrl}" alt="Receipt ${index + 1}" />
        </button>`
      )
      .join("");

    strip.innerHTML = `
      ${thumbs}
      ${busy ? `<span class="photo-busy">Adding${busy > 1 ? ` ${busy}` : ""}…</span>` : ""}
      <label class="photo-add">
        <input type="file" accept="image/*" multiple hidden data-photo-input />
        <span>+ Photo</span>
      </label>`;

    strip.querySelector("[data-photo-input]").addEventListener("change", onPick);
    strip.querySelectorAll("[data-photo-index]").forEach((button) => {
      button.addEventListener("click", () => openPhotoViewer(state.items[Number(button.dataset.photoIndex)], {
        onRemove: () => {
          const [removed] = state.items.splice(Number(button.dataset.photoIndex), 1);
          if (removed && removed.id) state.removedIds.push(removed.id);
          render();
        },
      }));
    });
  };

  async function onPick(event) {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (!files.length) return;

    busy += files.length;
    render();
    for (const file of files) {
      try {
        state.items.push(await readReceiptPhoto(file));
        errorEl.hidden = true;
      } catch (err) {
        // One bad file shouldn't lose the others, so say what happened and
        // carry on with the rest.
        errorEl.textContent = err instanceof PhotoError ? err.message : `Couldn't add that photo: ${err.message}`;
        errorEl.hidden = false;
      }
      busy--;
      render();
    }
  }

  render();
}

export function openPhotoViewer(photo, { onRemove } = {}) {
  const overlay = buildModal(`
    <div class="photo-view">
      <img src="${photo.dataUrl}" alt="Receipt" />
    </div>
    <div class="modal-actions">
      ${onRemove ? `<button class="secondary" id="photo-remove">Remove</button>` : ""}
      <button id="photo-close">Close</button>
    </div>
  `);
  const close = () => overlay.remove();
  overlay.querySelector("#photo-close").addEventListener("click", close);
  if (onRemove) {
    overlay.querySelector("#photo-remove").addEventListener("click", () => {
      close();
      onRemove();
    });
  }
}

// ---------------------------------------------------------------------------
// MPG chart: the last dozen readings as bars, with the running average as a
// dashed line across them. Hand-rolled SVG so the app keeps its "open the file
// and it runs" property -- no chart library to load at the pump.
// ---------------------------------------------------------------------------

export function mpgChartSvg(series, avgMpg) {
  const points = series.slice(-12);
  if (points.length < 2) return "";

  const width = 320;
  const height = 96;
  const padBottom = 16;
  // A reading that isn't counted still gets a bar -- but it's kept out of the
  // scale, since one 300 MPG typo would otherwise flatten every real bar into
  // the baseline. Its own bar is capped at the top of the chart instead.
  const counted = points.filter((p) => p.counted !== false);
  const values = (counted.length ? counted : points).map((p) => p.mpg);
  // Zoom into the range that's actually in play so a 26-vs-29 MPG difference is
  // visible -- but never so far that a 1 MPG spread fills the chart and reads as
  // a collapse. The floor scales with the readings themselves, so a steady
  // vehicle draws a steady row of bars.
  const max = Math.max(...values, avgMpg || 0);
  const min = Math.min(...values, avgMpg || Infinity);
  const span = Math.max(max - min, min * 0.12, 1);
  const top = max + span * 0.2;
  const bottom = Math.max(0, min - span * 0.8);
  const scaleY = (v) => height - padBottom - ((v - bottom) / (top - bottom)) * (height - padBottom - 4);

  const slot = width / points.length;
  const barWidth = Math.min(slot * 0.62, 26);

  const bars = points
    .map((point, i) => {
      const x = slot * i + (slot - barWidth) / 2;
      const excluded = point.counted === false;
      const y = Math.max(2, scaleY(point.mpg));
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}"
                height="${(height - padBottom - y).toFixed(1)}" rx="3"
                class="mpg-bar${excluded ? " excluded" : ""}" />`;
    })
    .join("");

  const avgY = avgMpg ? scaleY(avgMpg).toFixed(1) : null;
  const avgLine = avgY
    ? `<line x1="0" y1="${avgY}" x2="${width}" y2="${avgY}" class="mpg-avg-line" />`
    : "";

  const firstLabel = formatISO(points[0].on, { withYear: false });
  const lastLabel = formatISO(points[points.length - 1].on, { withYear: false });

  return `
    <svg class="mpg-chart" viewBox="0 0 ${width} ${height}" role="img"
         aria-label="Recent fuel economy, ${points.map((p) => `${formatMpg(p.mpg)}${p.counted === false ? " (not counted)" : ""}`).join(", ")} MPG">
      ${avgLine}
      ${bars}
      <text x="0" y="${height - 3}" class="mpg-axis-label">${escapeHtml(firstLabel)}</text>
      <text x="${width}" y="${height - 3}" text-anchor="end" class="mpg-axis-label">${escapeHtml(lastLabel)}</text>
    </svg>`;
}

// ---------------------------------------------------------------------------
// QR code, for sticking in the glovebox: scan it at the pump instead of hunting
// for the link.
// ---------------------------------------------------------------------------

export function openQrModal(url, title) {
  const hasCanvasQr = !!window.QRCode;
  // If the QR-generating script never loaded (blocked by a network filter, say),
  // fall back to a plain <img> from a public QR-image API -- images often get
  // through filters that block third-party <script> domains. If that fails too,
  // the onerror handler below drops to a copyable link.
  const fallbackImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(url)}`;

  const overlay = buildModal(`
    <div class="qr-wrap">
      <h2>${escapeHtml(title)}</h2>
      ${
        hasCanvasQr
          ? `<canvas id="qr-canvas"></canvas>`
          : `<img id="qr-fallback-img" width="240" height="240" alt="QR code" src="${fallbackImgUrl}" />
             <p class="hint" id="qr-fallback-hint" style="display:none">The QR code image couldn't load, but you can still copy the link below.</p>`
      }
      <div class="qr-link">${escapeHtml(url)}</div>
      <div class="qr-actions">
        <button class="secondary small" id="copy-link-btn">Copy link</button>
        ${hasCanvasQr ? `<button class="secondary small" id="download-btn">Download PNG</button>` : ""}
      </div>
    </div>
    <div class="modal-actions">
      <button id="modal-close">Close</button>
    </div>
  `);

  if (hasCanvasQr) {
    const canvas = overlay.querySelector("#qr-canvas");
    window.QRCode.toCanvas(canvas, url, { width: 240, margin: 2 }, (err) => {
      if (err) console.error(err);
    });
    overlay.querySelector("#download-btn").addEventListener("click", () => {
      const link = document.createElement("a");
      link.download = "garage-qr-code.png";
      link.href = canvas.toDataURL("image/png");
      link.click();
    });
  } else {
    const fallbackImgEl = overlay.querySelector("#qr-fallback-img");
    fallbackImgEl.addEventListener("error", () => {
      fallbackImgEl.style.display = "none";
      overlay.querySelector("#qr-fallback-hint").style.display = "block";
    });
  }

  overlay.querySelector("#copy-link-btn").addEventListener("click", async () => {
    await copyToClipboard(url);
    showToast("Link copied");
  });
  overlay.querySelector("#modal-close").addEventListener("click", () => overlay.remove());
}
