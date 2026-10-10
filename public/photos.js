// Bird photos: batched Wikipedia thumbnails for lists, an iNaturalist photo (with credit) for the hero.
const WIKI = "https://en.wikipedia.org/w/api.php";
const STORE = "thumbs-v1";

const thumbs = new Map(Object.entries(read(STORE) || {})); // scientific name → url ("" = none)
const pending = new Map(); // scientific name → promise
let saveTimer;

function read(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const entries = [...thumbs].slice(-3000);
      localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* storage full or blocked: thumbnails just refetch */ }
  }, 500);
}

async function fetchBatch(scis) {
  const url = `${WIKI}?action=query&format=json&formatversion=2&origin=*&redirects=1&prop=pageimages&piprop=thumbnail&pithumbsize=120&titles=${encodeURIComponent(scis.join("|"))}`;
  const res = await fetch(url);
  const q = (await res.json()).query || {};
  const hop = new Map();
  for (const n of q.normalized || []) hop.set(n.from, n.to);
  for (const r of q.redirects || []) hop.set(r.from, r.to);
  const byTitle = new Map((q.pages || []).map((p) => [p.title, p.thumbnail?.source || ""]));
  for (const sci of scis) {
    let t = sci;
    for (let i = 0; i < 3 && hop.has(t); i++) t = hop.get(t);
    thumbs.set(sci, byTitle.get(t) || "");
  }
  persist();
}

/** Resolves thumbnail URLs for many species, 50 per Wikipedia request. */
export async function loadThumbs(scis) {
  const missing = [...new Set(scis)].filter((s) => !thumbs.has(s) && !pending.has(s));
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    const p = fetchBatch(batch).catch(() => {}).finally(() => batch.forEach((s) => pending.delete(s)));
    batch.forEach((s) => pending.set(s, p));
  }
  await Promise.all(scis.map((s) => pending.get(s)).filter(Boolean));
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function thumbHTML(sci, cls = "thumb") {
  const url = thumbs.get(sci);
  return url ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy">` : `<span class="${cls} ph" data-sci="${esc(sci)}"></span>`;
}

/** Swaps placeholder thumbnails inside root for photos once they're known. */
export async function hydrateThumbs(root) {
  const holders = [...root.querySelectorAll(".ph[data-sci]")];
  if (!holders.length) return;
  await loadThumbs(holders.map((h) => h.dataset.sci));
  for (const h of holders) {
    const url = thumbs.get(h.dataset.sci);
    if (url && h.isConnected) {
      const img = document.createElement("img");
      img.className = h.className.replace(" ph", "");
      img.src = url;
      img.alt = "";
      h.replaceWith(img);
    }
  }
}

const heroes = new Map();
/** {photo: {url, credit}, extract, wiki} for one species; any part may be missing. */
export function heroInfo(sci) {
  if (!heroes.has(sci)) {
    const inat = fetch(`https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(sci)}&rank=species&per_page=1`)
      .then((r) => r.json())
      .then((d) => {
        const p = d.results?.[0]?.default_photo;
        return p ? { url: p.medium_url, credit: p.attribution } : null;
      })
      .catch(() => null);
    const wiki = fetch(`${WIKI}?action=query&format=json&formatversion=2&origin=*&redirects=1&prop=extracts&exintro=1&explaintext=1&exsentences=2&titles=${encodeURIComponent(sci)}`)
      .then((r) => r.json())
      .then((d) => {
        const p = d.query?.pages?.[0];
        return p && !p.missing ? { extract: p.extract, wiki: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}` } : {};
      })
      .catch(() => ({}));
    heroes.set(sci, Promise.all([inat, wiki]).then(([photo, w]) => ({ photo, ...w })));
  }
  return heroes.get(sci);
}
