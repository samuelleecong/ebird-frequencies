// The birder's life list, kept only in this browser: an imported eBird CSV plus manual ticks.
const KEY = "lifelist-v1";

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
let data = { sci: [], added: [], removed: [], file: "", importedAt: "", ...read() };
let seenCodes = new Set();
let listeners = [];

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* private mode: lasts for this visit */ }
}

/** Resolves imported scientific names to species codes; call once the species index is loaded. */
export function resolve(idx) {
  const codes = new Set();
  for (const name of data.sci) {
    // Subspecies or groups ("Larus argentatus smithsonianus") count as their species
    const s = idx.bySci.get(name) || idx.bySci.get(name.split(" ").slice(0, 2).join(" "));
    if (s) codes.add(s.code);
  }
  data.added.forEach((c) => codes.add(c));
  data.removed.forEach((c) => codes.delete(c));
  seenCodes = codes;
  listeners.forEach((fn) => fn());
}

export const onChange = (fn) => listeners.push(fn);
export const hasList = () => data.sci.length > 0 || data.added.length > 0;
export const isSeen = (code) => seenCodes.has(code);
export const seenCount = () => seenCodes.size;
export const meta = () => ({ file: data.file, importedAt: data.importedAt, manual: data.added.length + data.removed.length });
/** Changes whenever the list does, for caching results that depend on it. */
export const version = () => `${data.importedAt}|${data.added.length}|${data.removed.length}|${seenCodes.size}`;

export function toggle(code, idx) {
  const add = !seenCodes.has(code);
  data.added = data.added.filter((c) => c !== code);
  data.removed = data.removed.filter((c) => c !== code);
  (add ? data.added : data.removed).push(code);
  save();
  resolve(idx);
  return add;
}

export function clear(idx) {
  data = { sci: [], added: [], removed: [], file: "", importedAt: "" };
  save();
  resolve(idx);
}

/** Parses an eBird life list CSV (or a full "My eBird data" download) and stores it. Returns the species count. */
export function importCsv(text, fileName, idx) {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const head = rows.shift() || [];
  const col = (name) => head.findIndex((h) => h.trim().toLowerCase() === name);
  const sci = col("scientific name"), cat = col("category"), countable = col("countable");
  if (sci < 0) throw new Error("That file has no “Scientific Name” column. Download your life list from eBird as CSV and try again.");

  const names = new Set();
  for (const r of rows) {
    const name = (r[sci] || "").trim();
    if (!name || /\bsp\.|\/| x |\(hybrid\)|Domestic/.test(name)) continue;
    // Life list export: countable species, plus undescribed forms (which eBird treats as species)
    if (cat >= 0 && countable >= 0 && !((r[countable] === "1" && r[cat] === "species") || r[cat] === "form")) continue;
    names.add(name);
  }
  if (!names.size) throw new Error("Couldn't find any species in that file.");
  data = { sci: [...names], added: data.added, removed: data.removed, file: fileName, importedAt: new Date().toISOString() };
  save();
  resolve(idx);
  return seenCodes.size;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
