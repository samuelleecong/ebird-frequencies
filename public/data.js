// Static data published by the monthly pipeline (see pipeline/publish.go for the layout).
const local = ["localhost", "127.0.0.1"].includes(location.hostname);
const BASE = local ? "https://samuelleecong.github.io/ebird-frequencies/data/" : "data/";

const cache = new Map();

/** Fetches data/<path> once; resolves to null for files that don't exist (e.g. no target list). */
export function load(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(BASE + path).then((r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Couldn't load ${path} (HTTP ${r.status})`);
      return r.json();
    }).catch((e) => { cache.delete(path); throw e; }));
  }
  return cache.get(path);
}

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Sum of the chosen months (1-12) of a 12-month array, or the whole year when none are chosen. */
export function inMonths(arr, months) {
  if (!months.length) return arr.reduce((a, b) => a + b, 0);
  let s = 0;
  for (const m of months) s += arr[m - 1];
  return s;
}

/** Lower bound of the 95% Wilson interval: ranks 30 of 100 above 1 of 2. */
export function wilson(k, n) {
  if (!n) return 0;
  const z = 1.96, p = k / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

/** Bird-banding style 4-letter code: Lanceolated Warbler → LAWA, Black-capped Chickadee → BCCH. */
export function alphaCode(name) {
  const w = name.replace(/[’']/g, "").split(/[\s-]+/).filter(Boolean).map((x) => x.toUpperCase());
  if (w.length === 1) return w[0].slice(0, 4);
  if (w.length === 2) return w[0].slice(0, 2) + w[1].slice(0, 2);
  if (w.length === 3) return w[0][0] + w[1][0] + w[2].slice(0, 2);
  return w.slice(0, 4).map((x) => x[0]).join("");
}

let speciesPromise;
export function speciesIndex() {
  speciesPromise ??= load("species.json").then((rows) => {
    const list = rows.map(([code, com, sci]) => ({ code, com, sci, alpha: alphaCode(com), lc: com.toLowerCase(), lsci: sci.toLowerCase() }));
    return {
      list,
      byCode: new Map(list.map((s) => [s.code, s])),
      bySci: new Map(list.map((s) => [s.sci, s])),
      byCom: new Map(list.map((s) => [s.lc, s])),
    };
  });
  return speciesPromise;
}

export function searchSpecies(idx, query, limit = 8) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/);
  const scored = [];
  for (const s of idx.list) {
    let score = 0;
    if (s.alpha.toLowerCase() === q) score = 100;
    else if (s.lc === q) score = 99;
    else if (s.lc.startsWith(q)) score = 90;
    else if (tokens.every((t) => s.lc.split(/[\s-]+/).some((w) => w.startsWith(t)))) score = 75;
    else if (s.lc.includes(q)) score = 55;
    else if (s.lsci.includes(q)) score = 45;
    if (score) scored.push([score - s.com.length / 100, s]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, s]) => s);
}

/** Hotspot index for a country: Map id → {id, name, lat, lng, n[12], hasTargets, cc}. */
export async function countryIndex(cc) {
  const key = `country:${cc}`;
  if (!cache.has(key)) {
    cache.set(key, load(`countries/${cc}.json`).then((rows) =>
      new Map((rows || []).map(([id, name, lat, lng, n, t]) => [id, { id, name, lat, lng, n, hasTargets: !!t, cc }]))));
  }
  return cache.get(key);
}

/** Hotspots worth ranking for a species, in a country or ("") worldwide: [{id, name, lat, lng, cc, n[12], k[12]}]. */
export async function speciesSpots(code, cc) {
  const file = await load(`species/${code}.json`);
  if (!file) return [];
  if (!cc) return file.w.map(([id, name, lat, lng, c, n, k]) => ({ id, name, lat, lng, cc: c, n, k }));
  const spots = await countryIndex(cc);
  return (file.c[cc] || []).map(([id, k]) => ({ ...spots.get(id), k })).filter((h) => h.id);
}

export const hotspotTargets = (id) => load(`targets/${id}.json`);
