// ---------------------------------------------------------------------------
// CSV reader: quoted fields, "" escapes, and CRLF or LF line endings.
// Here because "save as CSV" is the escape hatch when an .xlsx won't open --
// and because a sheet exported from a European Excel is separated by
// semicolons, which is worth detecting rather than reading as one long column.
// ---------------------------------------------------------------------------

export function detectDelimiter(text) {
  const firstLine = text.slice(0, 4096).split(/\r?\n/).find((line) => line.trim()) || "";
  let best = ",";
  let bestCount = 0;
  for (const candidate of [",", ";", "\t", "|"]) {
    // Count only separators outside quotes, so "Smith, Dave's Auto" doesn't
    // make a comma look like the winner in a semicolon-separated file.
    let count = 0;
    let inQuotes = false;
    for (const char of firstLine) {
      if (char === '"') inQuotes = !inQuotes;
      else if (char === candidate && !inQuotes) count++;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(text, delimiter = detectDelimiter(text)) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  // A byte-order mark on the first field otherwise turns "Date" into "﻿Date"
  // and quietly breaks header matching.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\r") {
      // Newlines are handled on \n, so a CRLF file doesn't gain empty fields.
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Blank rows are kept, not filtered: row 14 of the file has to stay row 14
  // when the preview reports a problem with it.
  return rows.map((cells) => cells.map((cell) => cell.trim()));
}
