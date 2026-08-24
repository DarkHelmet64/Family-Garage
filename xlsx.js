// ---------------------------------------------------------------------------
// A small .xlsx reader for the browser.
//
// An .xlsx file is a zip of XML documents, so this walks the zip's central
// directory, inflates the parts it needs with the browser's own
// DecompressionStream, and pulls the cell values out of the sheet XML with
// regexes. That keeps the app dependency-free -- no build step, nothing to load
// from a CDN at the pump.
//
// What it deliberately doesn't do: formulas (the cached value is used),
// charts, or the old binary .xls format, which isn't a zip at all.
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

export class SpreadsheetError extends Error {}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

function findEndOfCentralDirectory(view) {
  // The end-of-central-directory record sits at the very end of the file, after
  // a comment of up to 64KB, so scan backwards for its signature.
  const start = Math.max(0, view.byteLength - 22 - 65535);
  for (let offset = view.byteLength - 22; offset >= start; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function readZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd === -1) {
    throw new SpreadsheetError("That doesn't look like an .xlsx file.");
  }

  const totalEntries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map();

  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_DIR_SIGNATURE) break;
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { compressionMethod, compressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, bytes, view };
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new SpreadsheetError(
      "This browser can't unpack .xlsx files. Save the sheet as CSV and import that instead."
    );
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) return null;

  const start = entry.localHeaderOffset;
  if (zip.view.getUint32(start, true) !== LOCAL_HEADER_SIGNATURE) {
    throw new SpreadsheetError(`That .xlsx file looks damaged (bad entry: ${name}).`);
  }
  // The local header repeats the name and extra fields at its own lengths,
  // which can differ from the central directory's -- so read them from here.
  const nameLength = zip.view.getUint16(start + 26, true);
  const extraLength = zip.view.getUint16(start + 28, true);
  const dataStart = start + 30 + nameLength + extraLength;
  const data = zip.bytes.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return new TextDecoder().decode(data);
  if (entry.compressionMethod === 8) return new TextDecoder().decode(await inflateRaw(data));
  throw new SpreadsheetError(`That .xlsx file uses a compression method this reader doesn't handle.`);
}

// ---------------------------------------------------------------------------
// XML bits
// ---------------------------------------------------------------------------

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  // Each <si> is one string, but a styled one is split across <r> runs, so
  // concatenate every <t> inside it.
  const siRegex = /<si\b[^>]*(?:\/>|>([\s\S]*?)<\/si>)/g;
  let si;
  while ((si = siRegex.exec(xml))) {
    let text = "";
    const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRegex.exec(si[1] || ""))) text += decodeXmlEntities(t[1]);
    strings.push(text);
  }
  return strings;
}

// Excel stores a date as a number and marks it a date only through the cell's
// number format, so reading dates means reading the style table too.
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function looksLikeDateFormat(code) {
  // Drop the parts of a format code that aren't field letters: [$-409] locale
  // tags, "literal" text, and \-escaped characters.
  const stripped = code
    .replace(/\[[^\]]*\]/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "");
  return /[dmyhs]/i.test(stripped);
}

function parseDateStyles(xml) {
  const dateStyles = new Set();
  if (!xml) return dateStyles;

  const customDateFormats = new Set();
  const numFmtRegex = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/>/g;
  let fmt;
  while ((fmt = numFmtRegex.exec(xml))) {
    if (looksLikeDateFormat(decodeXmlEntities(fmt[2]))) customDateFormats.add(Number(fmt[1]));
  }

  // A cell's `s` attribute indexes into cellXfs; each <xf> there names the
  // number format it uses.
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!cellXfs) return dateStyles;
  // Match every <xf>, not just the ones carrying a numFmtId: an xf without one
  // still occupies an index, and skipping it would shift every style after it.
  const xfRegex = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g;
  let xf;
  let index = 0;
  while ((xf = xfRegex.exec(cellXfs[1]))) {
    const attr = /numFmtId="(\d+)"/.exec(xf[1]);
    const id = attr ? Number(attr[1]) : 0;
    if (BUILTIN_DATE_FORMATS.has(id) || customDateFormats.has(id)) dateStyles.add(index);
    index++;
  }
  return dateStyles;
}

function columnLetterToIndex(letters) {
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

const pad2 = (n) => String(n).padStart(2, "0");

// Excel counts days from 1899-12-30 (or 1904-01-01 on the old Mac epoch).
// Reading the result back in UTC keeps the date from sliding a day depending on
// where the phone happens to be.
export function excelSerialToISO(serial, { date1904 = false } = {}) {
  const value = Number(serial);
  if (!Number.isFinite(value)) return null;

  let epochDays = 24107; // 1904-01-01
  if (!date1904) {
    // Excel counts a 29 February 1900 that never happened, so serials below 61
    // sit a day ahead of the real calendar and serial 60 is the phantom day
    // itself. Above that -- which is every date anyone logs fuel on -- the plain
    // 1899-12-30 epoch is right.
    if (value >= 60 && value < 61) return "1900-02-29";
    epochDays = value < 60 ? 25568 : 25569;
  }

  const date = new Date(Math.round((value - epochDays) * 86400000));
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

// Rows land at the index their r attribute says, and cells at the index their
// column letter says. Excel omits empty rows and cells entirely, so reading
// them positionally would slide everything after a gap up a line -- and then
// "row 14 is missing gallons" would point at the wrong row of someone's sheet.
function parseSheet(xml, { sharedStrings, dateStyles, date1904 }) {
  const rows = [];
  const rowRegex = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(xml))) {
    const rowRef = /r="(\d+)"/.exec(rowMatch[1]);
    const rowIndex = rowRef ? Number(rowRef[1]) - 1 : rows.length;
    const cells = [];
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    let autoIndex = 0;
    while ((cellMatch = cellRegex.exec(rowMatch[2] || ""))) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2] || "";
      const ref = /r="([A-Z]+)\d+"/.exec(attrs);
      const type = /t="([^"]+)"/.exec(attrs);
      const style = /s="(\d+)"/.exec(attrs);
      const columnIndex = ref ? columnLetterToIndex(ref[1]) : autoIndex;
      autoIndex = columnIndex + 1;

      cells[columnIndex] = readCell({
        type: type ? type[1] : null,
        styleIndex: style ? Number(style[1]) : null,
        inner,
        sharedStrings,
        dateStyles,
        date1904,
      });
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
    rows[rowIndex] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (rows[i] === undefined) rows[i] = [];
  return rows;
}

function readCell({ type, styleIndex, inner, sharedStrings, dateStyles, date1904 }) {
  if (type === "inlineStr") {
    const t = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
    return t ? decodeXmlEntities(t[1]) : null;
  }

  const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
  if (!v) return null;
  const raw = decodeXmlEntities(v[1]);

  switch (type) {
    case "s":
      return sharedStrings[Number(raw)] ?? "";
    case "b":
      return raw === "1";
    case "e":
      return null; // #N/A and friends
    case "d":
      return raw.slice(0, 10); // ISO date, written directly
    case "str":
      return raw;
    default: {
      const num = Number(raw);
      if (!Number.isFinite(num)) return raw;
      if (styleIndex !== null && dateStyles.has(styleIndex)) {
        return excelSerialToISO(num, { date1904 }) ?? num;
      }
      return num;
    }
  }
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

async function readSheetIndex(zip) {
  const workbookXml = await readZipEntry(zip, "xl/workbook.xml");
  const relsXml = await readZipEntry(zip, "xl/_rels/workbook.xml.rels");
  if (!workbookXml) throw new SpreadsheetError("That .xlsx file has no workbook in it.");

  const targetsById = new Map();
  const relRegex = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g;
  let rel;
  while ((rel = relRegex.exec(relsXml || ""))) {
    const target = rel[2].startsWith("/") ? rel[2].slice(1) : `xl/${rel[2].replace(/^\.\//, "")}`;
    targetsById.set(rel[1], target);
  }

  const sheets = [];
  const sheetRegex = /<sheet\b[^>]*\/>/g;
  let sheetTag;
  while ((sheetTag = sheetRegex.exec(workbookXml))) {
    const tag = sheetTag[0];
    const name = /name="([^"]*)"/.exec(tag);
    const relId = /r:id="([^"]+)"/.exec(tag);
    const path = relId ? targetsById.get(relId[1]) : null;
    if (path) sheets.push({ name: name ? decodeXmlEntities(name[1]) : `Sheet ${sheets.length + 1}`, path });
  }

  // Some generators omit the relationship ids; fall back to the files present.
  if (!sheets.length) {
    [...zip.entries.keys()]
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort()
      .forEach((path, i) => sheets.push({ name: `Sheet ${i + 1}`, path }));
  }
  if (!sheets.length) throw new SpreadsheetError("That .xlsx file has no worksheets in it.");

  const date1904 = /date1904="(1|true)"/.test(workbookXml);
  return { sheets, date1904 };
}

// Reads every sheet in the workbook into rows of plain values: numbers stay
// numbers, dates come back as "YYYY-MM-DD" strings, everything else is text.
export async function parseXlsx(arrayBuffer) {
  const zip = readZipEntries(new Uint8Array(arrayBuffer));
  const { sheets, date1904 } = await readSheetIndex(zip);

  const [sharedStringsXml, stylesXml] = await Promise.all([
    readZipEntry(zip, "xl/sharedStrings.xml"),
    readZipEntry(zip, "xl/styles.xml"),
  ]);
  const sharedStrings = parseSharedStrings(sharedStringsXml);
  const dateStyles = parseDateStyles(stylesXml);

  const out = [];
  for (const sheet of sheets) {
    const xml = await readZipEntry(zip, sheet.path);
    if (xml === null) continue;
    out.push({
      name: sheet.name,
      rows: parseSheet(xml, { sharedStrings, dateStyles, date1904 }),
    });
  }
  return out;
}
