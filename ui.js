// ---------------------------------------------------------------------------
// Modals, toasts, QR codes, and the little SVG chart.
//
// Every dialog here is in-page rather than window.prompt/alert/confirm: iOS
// Safari silently disables the native ones once a page is opened from a
// home-screen icon, which is exactly how this app gets used at a gas pump.
// ---------------------------------------------------------------------------

import { formatMpg, formatISO } from "./format.js";

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
    const datalists = fields
      .filter((field) => field.suggestions)
      .map(
        (field) => `
          <datalist id="list-${escapeHtml(field.name)}">
            ${field.suggestions.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("")}
          </datalist>`
      )
      .join("");

    const overlay = buildModal(
      `
        <h2>${escapeHtml(title)}</h2>
        ${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ""}
        <div class="form-grid">${fieldHtml}</div>
        ${datalists}
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

    const readValues = () => {
      const values = {};
      for (const field of fields) {
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
    if (first && first.type !== "checkbox") first.focus();
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
             ${suggestions ? `list="list-${escapeHtml(name)}"` : ""}
             autocomplete="off" />`;

  return `
    <div class="field ${half ? "field-half" : ""}">
      <label for="field-${escapeHtml(name)}">${escapeHtml(label)}</label>
      ${control}
      ${hintHtml}
    </div>`;
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
