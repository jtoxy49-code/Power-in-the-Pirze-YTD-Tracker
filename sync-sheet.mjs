import { mkdtemp, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const feedFile = fileURLToPath(new URL("./tracker-data.js", import.meta.url));
const dayMs = 86400000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const subtotal = /^(January|February|March|April|May|June|July|August|September|October|November|December) total$/i;
const cappers = ["v1", "g"];

function parseDate(value) {
  const date = typeof value === "number" && Number.isInteger(value)
    ? new Date(Date.UTC(1899, 11, 30) + value * dayMs)
    : datePattern.test(value) ? new Date(value + "T00:00:00Z") : null;
  if (!date || !Number.isFinite(+date)) return null;
  const iso = date.toISOString().slice(0, 10);
  return typeof value === "number" || iso === value ? iso : null;
}

function parseResult(value, explicit, row, column) {
  if (value === undefined || value === null || value === "") return { units: 0, blank: true };
  if (typeof value === "string" && value.trim().toUpperCase() === "NP") return { units: 0, active: false };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expected a number, NP, or a blank in " + column + row + ".");
  }
  const units = Math.round(value * 100) / 100;
  return { units, active: value !== 0 || explicit ? true : undefined };
}

export function normalizeValues(values, explicitFrom) {
  if (!datePattern.test(explicitFrom ?? "") || parseDate(explicitFrom) !== explicitFrom) {
    throw new Error("Set --explicit-from to the first date using the 0/NP convention, in YYYY-MM-DD.");
  }
  const columns = values[0]?.slice(0, 3).map(value => String(value).trim().toLowerCase());
  if (columns?.join("|") !== "date|v1zons|ghost") {
    throw new Error("Expected Date, V1zons, and Ghost in the selected range.");
  }

  const dates = new Set();
  const rows = [];
  const pendingDates = [];
  values.slice(1).forEach(([day, outlaw, ghost], i) => {
    const rowNumber = i + 2;
    if (typeof day === "string" && subtotal.test(day.trim())) return;
    if ([day, outlaw, ghost].every(value => value === undefined || value === null || value === "")) return;

    const date = parseDate(day);
    if (!date) throw new Error("Invalid date in row " + rowNumber + ".");
    if (dates.has(date)) throw new Error("Duplicate date in the Sheet: " + date + ".");
    dates.add(date);

    const explicit = date >= explicitFrom;
    const results = [parseResult(outlaw, explicit, rowNumber, "B"), parseResult(ghost, explicit, rowNumber, "C")];
    if (results.every(result => result.blank)) return;
    if (explicit && results.some(result => result.blank)) {
      pendingDates.push(date);
      return;
    }

    const calendarDate = new Date(date + "T00:00:00Z");
    const m = calendarDate.getUTCMonth() + 1;
    const d = m + "/" + calendarDate.getUTCDate();
    const active = Object.fromEntries(cappers.flatMap((field, index) =>
      results[index].active === undefined ? [] : [[field, results[index].active]]));
    rows.push({ date, d, m, v1: results[0].units, g: results[1].units, active });
  });

  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { rows, pendingDates: pendingDates.sort() };
}

function isSubtotalFormula(cell, column, rowNumber) {
  const formula = cell?.userEnteredValue?.formulaValue ?? "";
  const pattern = new RegExp("^=\\s*SUM\\(\\s*\\$?" + column + "\\$?(\\d+)\\s*:\\s*\\$?" + column + "\\$?(\\d+)\\s*\\)$", "i");
  const match = formula.trim().match(pattern);
  return !!match && Number(match[1]) >= 2 && Number(match[1]) <= Number(match[2]) && Number(match[2]) < rowNumber;
}

export function valuesFromGrid(response) {
  const rows = response.sheets?.[0]?.data?.[0]?.rowData;
  if (!Array.isArray(rows)) throw new Error("Google Sheets returned no cells for Sheet1!A:C.");
  return rows.map(({ values: cells = [] }, index) => {
    const rowNumber = index + 1;
    const values = ["A", "B", "C"].map((column, position) => {
      const value = cells[position]?.effectiveValue;
      if (value?.errorValue) throw new Error("Spreadsheet formula error in " + column + rowNumber + ".");
      return value?.numberValue ?? value?.stringValue ?? value?.boolValue ?? null;
    });
    const [date, outlaw, ghost] = values;
    if ((date === null || date === "") && (outlaw !== null || ghost !== null)
      && ["B", "C"].every((column, idx) => values[idx + 1] === null || isSubtotalFormula(cells[idx + 1], column, rowNumber))) {
      return [null, null, null];
    }
    return values;
  });
}

async function loadValues(input) {
  if (input) {
    const raw = JSON.parse(await readFile(input, "utf8"));
    return Array.isArray(raw) ? raw : raw.values;
  }
  const sheetId = process.env.PWR_TRACKER_SHEET_ID?.trim();
  const token = process.env.PWR_GOOGLE_SHEETS_ACCESS_TOKEN;
  if (!sheetId || !token) throw new Error("Provide an exported values JSON file or authorized Sheets credentials.");
  const url = new URL("https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(sheetId));
  url.searchParams.set("ranges", "Sheet1!A:C");
  url.searchParams.set("fields", "sheets(data(rowData(values(userEnteredValue,effectiveValue))))");
  const result = await fetch(url, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(20000)
  });
  if (!result.ok) throw new Error("Google Sheets returned HTTP " + result.status + ".");
  return valuesFromGrid(await result.json());
}

function dateExistingRows(rows, seasonYear) {
  let previousMonth = 0;
  return rows.map(row => {
    const [month, day] = row.d.split("/").map(Number);
    if (month < previousMonth) seasonYear++;
    previousMonth = month;
    return { ...row, date: row.date ?? new Date(Date.UTC(seasonYear, month - 1, day)).toISOString().slice(0, 10) };
  });
}

export function checkOverlap(existing, next) {
  const byDate = new Map(next.map(row => [row.date, row]));
  const missing = [];
  const corrected = [];
  for (const old of existing) {
    const row = byDate.get(old.date);
    if (!row) missing.push(old.date);
    else if (cappers.some(capper => Math.round(old[capper] * 100) !== Math.round(row[capper] * 100))) corrected.push(old.date);
  }
  return { missing, corrected };
}

function readCurrentFeed(source) {
  // The first snapshot predates the importer and uses JavaScript object keys. Parse only its data.
  const raw = source.match(/const RAW = (\[[\s\S]*?\n\]);/);
  const year = source.match(/const SEASON_YEAR = (\d{4});/);
  if (!raw || !year) throw new Error("Unable to reconcile against the current tracker feed.");
  const array = JSON.parse(raw[1].replace(/([{,])\s*([A-Za-z0-9_]+):/g, '$1"$2":').replace(/,\s*(?=[}\]])/g, ""));
  return dateExistingRows(array, Number(year[1]));
}

function serializeFeed(rows, pendingDates, now, refreshMode) {
  const source = { label: "Google Sheets", syncedAt: now, refreshMode, pendingDates };
  const data = rows.map(row => "  " + JSON.stringify(row)).join(",\n");
  return "const SEASON_YEAR = " + rows[0].date.slice(0, 4) + ";\nconst TRACKER_SOURCE = "
    + JSON.stringify(source) + ";\nconst RAW = [\n" + data + "\n];\n";
}

export async function syncTracker(options, output = feedFile) {
  const values = await loadValues(options.input);
  if (!Array.isArray(values)) throw new Error("The source returned no rows.");

  const { rows, pendingDates } = normalizeValues(values, options["explicit-from"]);
  if (!rows.length) throw new Error("The source returned no complete results.");
  const existing = readCurrentFeed(await readFile(output, "utf8"));
  const { missing, corrected } = checkOverlap(existing, rows);
  const report = { previousDates: existing.length, completeDates: rows.length,
    resultsThrough: rows.at(-1).date, pendingDates, missing, corrected };
  if (!options.write) return report;
  if (missing.length) throw new Error("The import omits published dates. The previous feed was retained.");
  if (corrected.length && !options["accept-corrections"]) {
    throw new Error("Review the listed historical corrections before writing the new feed.");
  }

  const tempDir = await mkdtemp(join(dirname(output), ".tracker-import-"));
  const stagedFeed = join(tempDir, "tracker-data.js");
  try {
    const refreshMode = options.input ? "manual" : "scheduled";
    await writeFile(stagedFeed, serializeFeed(rows, pendingDates, new Date().toISOString(), refreshMode), "utf8");
    await rename(stagedFeed, output);
  } finally {
    await unlink(stagedFeed).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(tempDir);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: options } = parseArgs({
    options: {
      input: { type: "string" },
      output: { type: "string" },
      write: { type: "boolean" },
      "explicit-from": { type: "string" },
      "accept-corrections": { type: "boolean" }
    }
  });
  syncTracker(options, options.output ? resolve(options.output) : feedFile)
    .then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    console.error("Tracker import failed. " + error.message);
    process.exitCode = 1;
  });
}
