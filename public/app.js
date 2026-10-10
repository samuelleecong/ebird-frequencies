import { MONTHS, MONTHS_LONG, alphaCode, countryIndex, hotspotTargets, inMonths, load, searchSpecies, speciesIndex, speciesSpots, wilson } from "./data.js";
import { heroInfo, hydrateThumbs, loadThumbs, thumbHTML } from "./photos.js";
import * as life from "./lifelist.js";
import { ago, freshness, live } from "./live.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const MIN_CHECKLISTS = 5;
const NOW_MONTH = new Date().getMonth() + 1;

const state = {
  tab: "find",
  cc: "SG", // "" = World
  months: [], // [] = all year, else 1-12
  species: null,
  spot: null,
  spotFrom: null, // species code we came from, for the back link
  showAll: false,
};

let idx; // species index
let countries = []; // [[cc, hotspots]]
let renderToken = 0;

/* ---------------- helpers ---------------- */

function pct(f) {
  if (f >= 0.1) return `${Math.round(f * 100)}%`;
  if (f >= 0.01) return `${(f * 100).toFixed(1)}%`;
  return `${(f * 100).toFixed(2)}%`;
}

function odds(f) {
  if (f >= 0.9) return "on nearly every checklist";
  if (f >= 0.5) return "on most checklists";
  return `on ~1 in ${Math.round(1 / f).toLocaleString()} checklists`;
}

/** ●●● data confidence from how many checklists sit behind a number. */
function dots(n) {
  const on = n >= 200 ? 3 : n >= 40 ? 2 : 1;
  const label = ["", "Few checklists: treat with care", "A decent number of checklists", "Lots of checklists: reliable"][on];
  return `<span class="dots" title="${label} (${n.toLocaleString()})">${"●".repeat(on)}<span class="off">${"●".repeat(3 - on)}</span></span>`;
}

const flag = (cc) => (cc && cc.length === 2 ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : "🌍");
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const countryName = (cc) => { try { return cc ? regionNames.of(cc) : "the world"; } catch { return cc; } };
const placeName = () => (state.cc ? countryName(state.cc) : "the world");

/** "Nov–Feb", "May", "Jan, Mar" or "all year". */
function monthsLabel(months = state.months, long = false) {
  if (!months.length || months.length === 12) return "all year";
  const names = long ? MONTHS_LONG : MONTHS;
  if (months.length === 1) return names[months[0] - 1];
  const set = new Set(months);
  const starts = months.filter((m) => !set.has(((m + 10) % 12) + 1));
  if (starts.length === 1) {
    let end = starts[0];
    while (set.has((end % 12) + 1)) end = (end % 12) + 1;
    return `${MONTHS[starts[0] - 1]}–${MONTHS[end - 1]}`;
  }
  return [...months].sort((a, b) => a - b).map((m) => MONTHS[m - 1]).join(", ");
}
const inWhen = () => (state.months.length ? `in ${monthsLabel(state.months, true)}` : "year-round");

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
}

function setLoading(on) { document.body.classList.toggle("loading", on); }

/* ---------------- map ---------------- */

const map = L.map("map", { zoomControl: false, preferCanvas: true, worldCopyJump: true }).setView([1.35, 103.82], 11);
L.control.zoom({ position: "topright" }).addTo(map);
// OpenStreetMap shows the trails and paths birders walk; CSS softens it to match the page (and inverts it in dark mode)
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
  className: "osm-tiles",
}).addTo(map);

// "Where am I?" for birders out in the field
const LocateControl = L.Control.extend({
  onAdd() {
    const b = L.DomUtil.create("button", "locate-btn");
    b.type = "button";
    b.title = "Show hotspots around me";
    b.setAttribute("aria-label", b.title);
    b.textContent = "◎";
    L.DomEvent.on(b, "click", (e) => { L.DomEvent.stop(e); b.classList.add("busy"); map.locate({ setView: true, maxZoom: 13 }); });
    return b;
  },
});
new LocateControl({ position: "topright" }).addTo(map);
let youAreHere;
map.on("locationfound", (e) => {
  document.querySelector(".locate-btn")?.classList.remove("busy");
  youAreHere?.remove();
  youAreHere = L.circleMarker(e.latlng, { radius: 8, weight: 3, color: "#fff", fillColor: "#3b82f6", fillOpacity: 1 }).bindTooltip("You are here").addTo(map);
});
map.on("locationerror", () => {
  document.querySelector(".locate-btn")?.classList.remove("busy");
  toast("Couldn't get your location");
});

const dotsLayer = L.layerGroup().addTo(map);
const resultLayer = L.layerGroup().addTo(map);
const liveLayer = L.layerGroup().addTo(map); // recent eBird reports
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function mapPadding() {
  const panel = $("#panel");
  return innerWidth > 720
    ? { paddingTopLeft: [panel.offsetWidth + 40, 40], paddingBottomRight: [40, 40] }
    : { paddingTopLeft: [20, 20], paddingBottomRight: [20, panel.offsetHeight + 20] };
}

function fitTo(points, maxZoom = 14) {
  if (!points.length) return;
  map.flyToBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng])), { ...mapPadding(), maxZoom, duration: 0.8 });
}

/** Centres a point in the part of the map the panel doesn't cover. */
function flyToSpot(h, zoom = 14) {
  const z = Math.max(map.getZoom(), zoom);
  const p = mapPadding();
  const target = map.project([h.lat, h.lng], z);
  const offset = innerWidth > 720 ? L.point(-(p.paddingTopLeft[0] - 40) / 2, 0) : L.point(0, ($("#panel").offsetHeight) / 2);
  map.flyTo(map.unproject(target.add(offset), z), z, { duration: 0.8 });
}

/** Region hotspots as small dots (busiest first, only what's in view) so any of them can be tapped. */
let regionSpots = [];
function drawDots() {
  dotsLayer.clearLayers();
  if (!state.cc || state.tab === "find" && state.species) return;
  const b = map.getBounds().pad(0.2);
  const moss = css("--moss");
  let shown = 0;
  for (const h of regionSpots) {
    if (!b.contains([h.lat, h.lng])) continue;
    const total = h.total;
    L.circleMarker([h.lat, h.lng], {
      radius: Math.min(9, 2.5 + Math.log10(total + 1) * 1.6), weight: 1, color: "#fff", fillColor: moss, fillOpacity: 0.55,
    }).bindTooltip(`${esc(h.name)} · ${total.toLocaleString()} checklists`).on("click", () => openSpot(h.id)).addTo(dotsLayer);
    if (++shown >= 2500) break;
  }
}
map.on("moveend", drawDots);

function pinIcon(i, cls = "") {
  return L.divIcon({ className: "", html: `<div class="pin ${cls}" style="--i:${i}"><span>${i + 1}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 36] });
}

/** Ranked results: numbered pins for the top 10, circles sized by value for the rest. */
function drawResults(items, value, { color = "--moss", pinClass = "", onClick, label }) {
  resultLayer.clearLayers();
  const max = Math.max(...items.map(value), 1e-9);
  const fill = css(color);
  items.slice(10).reverse().forEach((h) => {
    const v = value(h) / max;
    L.circleMarker([h.lat, h.lng], { radius: 5 + 11 * Math.sqrt(v), weight: 1.5, color: "#fff", fillColor: fill, fillOpacity: 0.35 + 0.55 * v })
      .bindTooltip(label(h)).on("click", () => onClick(h)).addTo(resultLayer);
  });
  items.slice(0, 10).reverse().forEach((h) => {
    const i = items.indexOf(h);
    L.marker([h.lat, h.lng], { icon: pinIcon(i, i === 0 ? "gold" : pinClass), zIndexOffset: 1000 - i, riseOnHover: true })
      .bindTooltip(label(h), { offset: [0, -30], direction: "top" }).on("click", () => onClick(h)).addTo(resultLayer);
  });
}

/* ---------------- controls ---------------- */

function renderMonths() {
  const sel = new Set(state.months);
  const label = monthsLabel(state.months, true);
  $("#months-summary").textContent = label === "all year" ? "All year" : label;
  $("#months").innerHTML =
    `<button class="all" data-all aria-pressed="${!sel.size}">All</button>` +
    MONTHS.map((m, i) => `<button data-m="${i + 1}" class="${i + 1 === NOW_MONTH ? "now" : ""}" aria-pressed="${sel.has(i + 1)}" title="${MONTHS_LONG[i]}${i + 1 === NOW_MONTH ? " (this month)" : ""}">${m[0]}</button>`).join("");
}

// Tap toggles a month; dragging paints a run of months (e.g. Nov → Feb for winter migrants)
let painting = null;
$("#months").addEventListener("pointerdown", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  e.preventDefault();
  if (b.dataset.all !== undefined) { state.months = []; renderMonths(); return changed(); }
  const m = +b.dataset.m;
  painting = { add: !state.months.includes(m), touched: new Set() };
  paint(m);
});
addEventListener("pointermove", (e) => {
  if (!painting) return;
  const b = document.elementFromPoint(e.clientX, e.clientY)?.closest("#months [data-m]");
  if (b) paint(+b.dataset.m);
});
addEventListener("pointerup", () => {
  if (!painting) return;
  painting = null;
  changed();
});
function paint(m) {
  if (painting.touched.has(m)) return;
  painting.touched.add(m);
  const set = new Set(state.months);
  painting.add ? set.add(m) : set.delete(m);
  state.months = set.size === 12 ? [] : [...set].sort((a, b) => a - b);
  renderMonths();
}

function renderRegions() {
  const opts = countries
    .map(([cc, n]) => [cc, countryName(cc), n])
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([cc, name, n]) => `<option value="${cc}">${flag(cc)} ${esc(name)} · ${n.toLocaleString()} hotspots</option>`);
  $("#region").innerHTML = `<option value="">🌍 Whole world</option>` + opts.join("");
  $("#region").value = state.cc;
}
$("#region").addEventListener("change", async (e) => {
  state.cc = e.target.value;
  store("region", state.cc);
  state.spot = null;
  await loadRegion(true);
  changed();
});

async function loadRegion(fly) {
  if (!state.cc) {
    regionSpots = [];
    dotsLayer.clearLayers();
    if (fly) map.flyTo([20, 10], 2, { duration: 0.8 });
    return;
  }
  setLoading(true);
  try {
    const spots = await countryIndex(state.cc);
    regionSpots = [...spots.values()].map((h) => ({ ...h, total: inMonths(h.n, []) })).sort((a, b) => b.total - a.total);
    if (fly && regionSpots.length) {
      // Fit the busiest hotspots so far-flung islands don't zoom the map right out
      const core = regionSpots.slice(0, Math.max(30, Math.ceil(regionSpots.length * 0.5)));
      fitTo(core, 12);
    }
    drawDots();
  } finally {
    setLoading(false);
  }
}

function renderChip() {
  const chip = $("#lifelist-chip");
  if (life.hasList()) {
    chip.className = "lifelist-chip";
    chip.innerHTML = `🐦 <span class="count">${life.seenCount().toLocaleString()}</span> seen`;
    chip.title = "Your life list";
  } else {
    chip.className = "lifelist-chip empty";
    chip.innerHTML = "＋ Add my life list";
    chip.title = "Import your eBird life list to see your targets";
  }
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  state.tab = b.dataset.tab;
  if (state.tab !== "spot") state.spotFrom = null;
  changed();
}));

/* ---------------- routing ---------------- */

function writeHash() {
  const id = state.tab === "find" ? state.species : state.tab === "spot" ? state.spot : null;
  const q = new URLSearchParams();
  q.set("r", state.cc || "world");
  if (state.months.length) q.set("m", state.months.join(","));
  const hash = `#${state.tab}${id ? "/" + id : ""}?${q}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function readHash() {
  const m = location.hash.match(/^#(find|spot|hunt)(?:\/([\w-]+))?(?:\?(.*))?$/);
  if (!m) return false;
  const q = new URLSearchParams(m[3] || "");
  state.tab = m[1];
  if (m[1] === "find") state.species = m[2] || null;
  if (m[1] === "spot") state.spot = m[2] || null;
  const r = q.get("r");
  if (r) state.cc = r === "world" ? "" : r.toUpperCase();
  state.months = (q.get("m") || "").split(",").map(Number).filter((x) => x >= 1 && x <= 12);
  return true;
}

function changed() {
  writeHash();
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
  render();
}

$("#home").addEventListener("click", (e) => {
  e.preventDefault();
  Object.assign(state, { tab: "find", species: null, spot: null, spotFrom: null });
  changed();
});

/* ---------------- views ---------------- */

const view = $("#view");

function render() {
  const token = ++renderToken;
  resultLayer.clearLayers();
  liveLayer.clearLayers();
  drawDots();
  if (state.tab === "find") return renderFind(token);
  if (state.tab === "spot") return renderSpot(token);
  return renderHunt(token);
}

function searchBox(placeholder, value = "") {
  return `<div class="search"><input id="q" type="search" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" value="${esc(value)}" aria-label="${esc(placeholder)}"><div class="suggest" id="suggest" hidden role="listbox"></div></div>`;
}

/** Autocomplete over species (or hotspot names) with arrow-key navigation. */
function wireSearch(getItems, renderItem, choose) {
  const input = $("#q"), box = $("#suggest");
  let items = [], active = 0;
  const show = () => {
    items = getItems(input.value);
    active = 0;
    box.hidden = !items.length;
    box.innerHTML = items.map((it, i) => `<button type="button" role="option" data-i="${i}" aria-selected="${i === active}">${renderItem(it)}</button>`).join("");
    hydrateThumbs(box);
  };
  const move = (d) => {
    active = (active + d + items.length) % items.length;
    box.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-selected", String(i === active)));
    box.children[active]?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", show);
  input.addEventListener("focus", () => {
    if (input.value) show();
    if (innerWidth <= 720) setSheet("expanded");
  });
  input.addEventListener("keydown", (e) => {
    if (box.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter" && items[active]) { e.preventDefault(); box.hidden = true; choose(items[active]); }
    else if (e.key === "Escape") box.hidden = true;
  });
  box.addEventListener("mousedown", (e) => {
    const b = e.target.closest("button");
    if (b) { e.preventDefault(); box.hidden = true; choose(items[+b.dataset.i]); }
  });
  input.addEventListener("blur", () => setTimeout(() => (box.hidden = true), 150));
}

function speciesOption(s) {
  const tag = life.hasList() ? (life.isSeen(s.code) ? `<span class="chip seen">✓ seen</span>` : `<span class="chip lifer">lifer</span>`) : "";
  return `${thumbHTML(s.sci)}<span style="flex:1;min-width:0"><span class="name">${esc(s.com)}</span> ${tag}<br><span class="meta sci">${esc(s.sci)}</span></span><span class="chip code">${s.alpha}</span>`;
}

function chooseSpecies(code) {
  state.tab = "find";
  state.species = code;
  const recent = (store("recent") || []).filter((c) => c !== code);
  store("recent", [code, ...recent].slice(0, 8));
  changed();
  view.scrollTop = 0;
}

/* ---- Find a bird ---- */

async function renderFind(token) {
  const s = state.species && idx.byCode.get(state.species);
  view.innerHTML = searchBox("Search any bird… e.g. “lanceolated” or LAWA", s ? s.com : "") + `<div id="find-body"></div>`;
  wireSearch((q) => searchSpecies(idx, q), speciesOption, (it) => chooseSpecies(it.code));
  const body = $("#find-body");

  if (!s) {
    const recent = (store("recent") || []).map((c) => idx.byCode.get(c)).filter(Boolean);
    const examples = ["lanwar", "bkhpit1", "grearg1", "orphor1", "manduc", "atlpuf"].map((c) => idx.byCode.get(c)).filter(Boolean);
    const chips = (list) => list.map((x) => `<button class="btn" data-species="${x.code}">${thumbHTML(x.sci, "thumb mini")}${esc(x.com)}</button>`).join("");
    body.innerHTML = `
      <div class="empty-state"><span class="big">🔭</span>
        <h2>Which bird are you after?</h2>
        <p>See where it turns up on the most checklists in ${esc(placeName())}, and in which months.</p>
      </div>
      ${recent.length ? `<h3>Recently searched</h3><div class="btn-row">${chips(recent)}</div>` : ""}
      <h3>Try one</h3><div class="btn-row">${chips(examples)}</div>`;
    hydrateThumbs(body);
    return;
  }

  body.innerHTML = `<div class="skeleton" style="height:110px;margin-top:14px"></div><div class="skeleton" style="margin-top:10px"></div><div class="skeleton" style="margin-top:8px"></div>`;
  setLoading(true);
  let spots;
  try { spots = await speciesSpots(s.code, state.cc); } finally { setLoading(false); }
  if (token !== renderToken) return;

  const rows = spots
    .map((h) => {
      const N = inMonths(h.n, state.months), K = inMonths(h.k, state.months);
      return { ...h, N, K, f: N ? K / N : 0, score: wilson(K, N) };
    })
    .filter((h) => h.K > 0 && h.N >= MIN_CHECKLISTS)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);
  rows.forEach((h) => spotMeta.set(h.id, h));

  // Seasonality across these hotspots, eBird bar-chart style
  const season = MONTHS.map((_, m) => {
    let k = 0, n = 0;
    for (const h of spots) { k += h.k[m]; n += h.n[m]; }
    return n ? k / n : 0;
  });
  const peak = Math.max(...season);
  const best = peak ? season.map((v, i) => (v >= peak * 0.6 ? i + 1 : 0)).filter(Boolean) : [];
  const seen = life.hasList() ? (life.isSeen(s.code) ? `<span class="chip seen">✓ On your life list</span>` : `<span class="chip lifer">★ Lifer for you</span>`) : "";

  body.innerHTML = `
    <div class="hero" style="margin-top:14px">
      <figure class="hero-photo-wrap" style="margin:0"><img class="hero-photo" id="hero-photo" alt="${esc(s.com)}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><figcaption id="hero-credit"></figcaption></figure>
      <div>
        <h2>${esc(s.com)}</h2>
        <div class="sci">${esc(s.sci)}</div>
        <div class="badges">${seen} <span id="live-badge"></span> <span class="chip code" title="4-letter code">${alphaCode(s.com)}</span>
          <a class="chip code" href="https://ebird.org/species/${s.code}" target="_blank" rel="noopener">eBird ↗</a></div>
      </div>
    </div>
    <p class="blurb" id="blurb"></p>
    <div class="season card">
      <div class="season-bars">${season.map((v, i) => `<i style="--h:${peak ? v / peak : 0};--i:${i}" class="${!state.months.length || state.months.includes(i + 1) ? "on" : ""}" title="${MONTHS_LONG[i]}: ${pct(v)}"></i>`).join("")}</div>
      <div class="season-labels">${MONTHS.map((m) => `<span>${m[0]}</span>`).join("")}</div>
      <div class="season-note">${peak ? `Best ${best.length === 12 ? "all year round" : `in <b>${monthsLabel(best)}</b>`} at these hotspots · peak ${pct(peak)} of checklists` : "No reports here yet"}</div>
    </div>
    <h3>Best spots in ${esc(placeName())} <small>${esc(inWhen())}</small></h3>
    ${rows.length ? `<ol class="list" id="ranked">${rows.map((h, i) => `
      <li class="row" style="--i:${i}" data-spot="${h.id}" data-from="${s.code}">
        <span class="rank">${i + 1}</span>
        <span class="row-main"><div class="row-title">${esc(h.name)}</div>
          <div class="row-sub">${dots(h.N)} ${h.K.toLocaleString()} of ${h.N.toLocaleString()} checklists${state.cc ? "" : ` · ${flag(h.cc)}`} <span data-live-loc="${h.id}" hidden></span></div></span>
        <span class="pct">${pct(h.f)}<small>${odds(h.f).replace("on ", "")}</small></span>
        <span class="bar"><i style="--w:${h.f / rows[0].f}"></i></span>
      </li>`).join("")}</ol>
      <p class="hint">Ranked by frequency, with spots that have only a handful of checklists pulled down. Tap one for everything else you could see there.</p>`
    : `<div class="empty-state"><span class="big">🍃</span>No ${esc(s.com)} reports in ${esc(placeName())} ${esc(inWhen())}.
        <div class="btn-row" style="justify-content:center">
          ${state.months.length ? `<button class="btn" data-act="allyear">Try all year</button>` : ""}
          ${state.cc ? `<button class="btn primary" data-act="world">Search the whole world</button>` : ""}
        </div></div>`}
    <div id="live-species"></div>`;

  drawResults(rows, (h) => h.f, {
    label: (h) => `${esc(h.name)} · ${pct(h.f)}`,
    onClick: (h) => openSpot(h.id, s.code),
  });
  if (rows.length) fitTo(rows.slice(0, 15));

  heroInfo(s.sci).then((info) => {
    if (token !== renderToken) return;
    const img = $("#hero-photo");
    if (info.photo && img) { img.src = info.photo.url; $("#hero-credit").textContent = info.photo.credit; }
    if (info.extract) $("#blurb").innerHTML = `${esc(info.extract)} <a href="${info.wiki}" target="_blank" rel="noopener">More</a>`;
  });
  fillSpeciesLive(token, s);
}

/** Where the species has actually been reported in the last 30 days. */
async function fillSpeciesLive(token, s) {
  if (!state.cc) return;
  const obs = await live("species", { region: state.cc, species: s.code });
  if (token !== renderToken || !obs?.length) return;
  obs.sort((a, b) => b.date.localeCompare(a.date));
  $("#live-badge").innerHTML = `<span class="chip live ${freshness(obs[0].date)}" title="Latest eBird report in ${esc(placeName())}">● Seen ${ago(obs[0].date)}</span>`;
  const byLoc = new Map();
  for (const o of obs) if (o.loc && !byLoc.has(o.loc)) byLoc.set(o.loc, o);
  document.querySelectorAll("[data-live-loc]").forEach((el) => {
    const o = byLoc.get(el.dataset.liveLoc);
    if (o) Object.assign(el, { hidden: false, className: `live-chip ${freshness(o.date)}`, textContent: `● ${ago(o.date)}`, title: "Latest report here" });
  });
  $("#live-species").innerHTML = `<h3>Reported lately <small>last 30 days · ${obs.length} location${obs.length > 1 ? "s" : ""}</small></h3>
    <ol class="list">${obs.slice(0, 6).map((o, i) => liveRow(o, i, o.name || "Private location", o.count ? `${o.count} seen` : "")).join("")}</ol>`;
  drawLive(obs, (o) => `${esc(o.name || "Private location")} · ${ago(o.date)}`);
}

function liveRow(o, i, title, extra) {
  const target = o.loc && regionSpots.some((h) => h.id === o.loc) ? `data-spot="${o.loc}"` : `data-fly="${o.lat},${o.lng}"`;
  return `<li class="row live-row" style="--i:${i}" ${target}>
    <span class="live-dot ${freshness(o.date)}"></span>
    <span class="row-main"><div class="row-title">${esc(title)}</div><div class="row-sub">${esc(ago(o.date))}${extra ? ` · ${esc(extra)}` : ""}</div></span>
    <span class="muted">${esc(o.date.slice(5, 10).replace("-", "/"))}</span></li>`;
}

function drawLive(obs, label) {
  liveLayer.clearLayers();
  for (const o of obs.slice(0, 200)) {
    L.marker([o.lat, o.lng], { icon: L.divIcon({ className: "", html: `<span class="pulse ${freshness(o.date)}"></span>`, iconSize: [14, 14], iconAnchor: [7, 7] }), zIndexOffset: -100 })
      .bindTooltip(label(o)).addTo(liveLayer);
  }
}

/* ---- Hotspot ---- */

const spotMeta = new Map(); // id → hotspot details seen in results (covers World mode)

async function findSpot(id) {
  if (spotMeta.has(id)) return spotMeta.get(id);
  if (state.cc) {
    const h = (await countryIndex(state.cc)).get(id);
    if (h) return h;
  }
  return null;
}

function openSpot(id, from = null) {
  state.tab = "spot";
  state.spot = id;
  state.spotFrom = from;
  state.showMore = false;
  changed();
  view.scrollTop = 0;
}

function favorites() { return store("favs") || {}; }

async function renderSpot(token) {
  if (!state.spot) return renderSpotSearch();
  view.innerHTML = `<div class="skeleton" style="height:120px"></div><div class="skeleton" style="margin-top:10px"></div><div class="skeleton" style="margin-top:8px"></div>`;
  setLoading(true);
  let h, t;
  try { [h, t] = await Promise.all([findSpot(state.spot), hotspotTargets(state.spot)]); } finally { setLoading(false); }
  if (token !== renderToken) return;
  if (!h) {
    view.innerHTML = `<div class="empty-state"><span class="big">🧭</span>Couldn't find that hotspot in ${esc(placeName())}.</div>`;
    return;
  }
  flyToSpot(h);
  resultLayer.clearLayers();
  L.marker([h.lat, h.lng], { icon: L.divIcon({ className: "", html: `<div class="pin gold" style="--i:0"><span>★</span></div>`, iconSize: [30, 30], iconAnchor: [15, 36] }) }).addTo(resultLayer);

  const n = inMonths(t ? t.n : h.n, state.months);
  const birds = t ? t.s
    .map(([code, k]) => {
      const sp = idx.byCode.get(code);
      const K = inMonths(k, state.months);
      const monthly = k.map((v, m) => (t.n[m] ? v / t.n[m] : 0));
      return sp && { ...sp, monthly, f: n ? K / n : 0, seen: life.isSeen(code) };
    })
    .filter((b) => b && b.f > 0)
    .sort((a, b) => b.f - a.f) : [];
  const hasList = life.hasList();
  const targets = birds.filter((b) => !b.seen);
  const showTargets = hasList && !state.showAll;
  const list = showTargets ? targets : birds;
  const expected = targets.reduce((sum, b) => sum + b.f, 0);
  const fav = !!favorites()[h.id];
  const back = state.spotFrom && idx.byCode.get(state.spotFrom);

  view.innerHTML = `
    ${back ? `<button class="back" data-species="${back.code}">← ${esc(back.com)}</button>` : ""}
    <div class="spot-head">
      <h2>${esc(h.name)}</h2>
      <div class="muted">${flag(h.cc)} ${esc(countryName(h.cc))} · ${n.toLocaleString()} checklists ${esc(inWhen())}</div>
      <div class="btn-row">
        <a class="btn" href="https://ebird.org/hotspot/${h.id}" target="_blank" rel="noopener">eBird ↗</a>
        <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}" target="_blank" rel="noopener">🧭 Directions</a>
        <button class="btn" data-act="fav" aria-pressed="${fav}">${fav ? "♥ Saved" : "♡ Save"}</button>
      </div>
      ${t ? `<div class="stats">
        <div class="stat"><b>${birds.length}</b><span>species reported</span></div>
        <div class="stat coral"><b>${hasList ? targets.length : "—"}</b><span>${hasList ? "of them lifers" : "add life list"}</span></div>
        <div class="stat coral"><b>${hasList ? expected.toFixed(1) : "—"}</b><span>lifers per visit</span></div>
      </div>` : ""}
      <div id="live-spot"></div>
    </div>
    ${!t ? `<div id="spplist"><div class="skeleton" style="margin-top:14px"></div><div class="skeleton" style="margin-top:8px"></div></div>`
    : `
    <h3>${showTargets ? "Your targets" : "Birds here"} <span class="seg">
      <button data-act="targets" aria-pressed="${showTargets}" ${hasList ? "" : "disabled title='Add your life list first'"}>My targets</button>
      <button data-act="all" aria-pressed="${!showTargets}">All birds</button></span></h3>
    ${!hasList ? `<div class="callout">Add your eBird life list and this becomes <b>your</b> target list, with every bird you still need.</div>` : ""}
    ${showTargets && !targets.some((b) => b.f >= 0.01) ? `<div class="celebrate"><span class="big">🎉</span>You've seen every species above 1% here${state.months.length ? ` ${esc(inWhen())}` : ""}!</div>` : ""}
    <ol class="list targets">${list.slice(0, state.showMore ? 400 : 60).map((b, i) => targetRow(b, i)).join("")}</ol>
    ${list.length > 60 && !state.showMore ? `<div class="btn-row" style="justify-content:center"><button class="btn" data-act="more">Show all ${list.length}</button></div>` : ""}
    <p class="hint">Frequency = share of complete checklists ${esc(inWhen())} that reported the bird. Tap a bird to see where else it's easiest; tap ○ to tick it off.</p>`}`;
  hydrateThumbs(view);
  if (t) fillSpotLive(token, h);
  else fillSpeciesList(token, h);
}

/**
 * Quiet hotspots have no published frequencies, so fall back to eBird's list of every species
 * ever recorded there, with the ones reported in the last 30 days first.
 */
async function fillSpeciesList(token, h) {
  const [codes, recent] = await Promise.all([live("spplist", { loc: h.id }), live("hotspot", { loc: h.id })]);
  const box = $("#spplist");
  if (token !== renderToken || !box) return;
  if (!codes) {
    box.innerHTML = `<div class="empty-state"><span class="big">📒</span>Too few checklists here for frequencies. <a href="https://ebird.org/hotspot/${h.id}" target="_blank" rel="noopener">See it on eBird</a>.</div>`;
    return;
  }
  const latest = new Map();
  for (const o of recent || []) if (!latest.has(o.code) || latest.get(o.code) < o.date) latest.set(o.code, o.date);
  const hasList = life.hasList();
  const birds = codes.map((code, order) => {
    const sp = idx.byCode.get(code);
    return sp && { ...sp, order, seen: life.isSeen(code), date: latest.get(code) };
  }).filter(Boolean)
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.order - b.order);
  const targets = birds.filter((b) => !b.seen);
  const showTargets = hasList && !state.showAll;
  const list = showTargets ? targets : birds;
  box.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${birds.length}</b><span>species ever recorded</span></div>
      <div class="stat coral"><b>${hasList ? targets.length : "—"}</b><span>${hasList ? "of them lifers" : "add life list"}</span></div>
      <div class="stat"><b>${latest.size}</b><span>reported in last 30 days</span></div>
    </div>
    <div class="callout" style="margin-top:12px">Only ${inMonths(h.n, []).toLocaleString()} complete checklists here, too few for reliable percentages, so this is <b>every species ever recorded</b> on eBird. Ones reported in the last 30 days come first.</div>
    <h3>${showTargets ? "Your targets" : "Birds recorded here"} <span class="seg">
      <button data-act="targets" aria-pressed="${showTargets}" ${hasList ? "" : "disabled title='Add your life list first'"}>My targets</button>
      <button data-act="all" aria-pressed="${!showTargets}">All birds</button></span></h3>
    ${showTargets && !targets.length ? `<div class="celebrate"><span class="big">🎉</span>You've seen every species ever recorded here!</div>` : ""}
    <ol class="list targets">${list.slice(0, state.showMore ? 1000 : 60).map((b, i) => `
      <li class="row ${b.seen ? "is-seen" : ""}" style="--i:${Math.min(i, 20)}" data-species="${b.code}">
        ${thumbHTML(b.sci)}
        <span class="row-main"><div class="row-title">${esc(b.com)}</div>
          <div class="row-sub">${b.date ? `<span class="live-chip ${freshness(b.date)}">● here ${ago(b.date)}</span>` : "recorded here"}${hasList && !b.seen ? ` <span class="chip lifer">lifer</span>` : ""}</div></span>
        <span class="row-end"><button class="seen-btn ${b.seen ? "on" : ""}" data-seen="${b.code}" aria-label="${b.seen ? "Seen" : "Mark as seen"}">${b.seen ? "✓" : "○"}</button></span>
      </li>`).join("")}</ol>
    ${list.length > 60 && !state.showMore ? `<div class="btn-row" style="justify-content:center"><button class="btn" data-act="more">Show all ${list.length}</button></div>` : ""}`;
  hydrateThumbs(box);
}

/** Which birds were actually reported here in the last 30 days. */
async function fillSpotLive(token, h) {
  const obs = await live("hotspot", { loc: h.id });
  if (token !== renderToken || !obs?.length) return;
  const latest = new Map();
  for (const o of obs) if (!latest.has(o.code) || latest.get(o.code) < o.date) latest.set(o.code, o.date);
  document.querySelectorAll("[data-live-code]").forEach((el) => {
    const d = latest.get(el.dataset.liveCode);
    if (d) Object.assign(el, { hidden: false, className: `live-chip ${freshness(d)}`, textContent: `● here ${ago(d)}`, title: "Latest eBird report at this hotspot" });
  });
  const newest = [...latest.values()].sort().pop();
  const lifers = life.hasList() ? [...latest.keys()].filter((c) => !life.isSeen(c) && idx.byCode.has(c)) : [];
  $("#live-spot").innerHTML = `<div class="live-banner"><span class="live-dot ${freshness(newest)}"></span>
    <span><b>${latest.size} species</b> reported here in the last 30 days, latest ${ago(newest)}${lifers.length ? `, including <b>${lifers.length} of your targets</b>` : ""}.</span></div>`;
}

function targetRow(b, i) {
  const peak = Math.max(...b.monthly) || 1;
  const spark = b.monthly.map((v, m) => `<i style="--h:${v / peak}" class="${!state.months.length || state.months.includes(m + 1) ? "on" : ""}"></i>`).join("");
  return `<li class="row ${b.seen ? "is-seen" : ""}" style="--i:${Math.min(i, 20)}" data-species="${b.code}">
    ${thumbHTML(b.sci)}
    <span class="row-main"><div class="row-title">${esc(b.com)}</div>
      <div class="row-sub"><span class="spark" title="Reports by month">${spark}</span> ${odds(b.f)} <span data-live-code="${b.code}" hidden></span></div></span>
    <span class="row-end"><span class="pct">${pct(b.f)}</span>
      <button class="seen-btn ${b.seen ? "on" : ""}" data-seen="${b.code}" aria-label="${b.seen ? "Seen" : "Mark as seen"}" title="${b.seen ? "On your life list" : "Tick off as seen"}">${b.seen ? "✓" : "○"}</button></span>
    <span class="bar ${b.seen ? "" : "coral"}"><i style="--w:${Math.min(1, b.f / 0.6)}"></i></span>
  </li>`;
}

async function renderSpotSearch() {
  const favs = Object.entries(favorites());
  view.innerHTML = (state.cc ? searchBox(`Search ${regionSpots.length.toLocaleString()} hotspots in ${countryName(state.cc)}…`) : "") + `
    <div class="empty-state"><span class="big">📍</span>
      <h2>Pick a hotspot</h2>
      <p>${state.cc ? "Tap any dot on the map, or search by name." : "Choose a country above to browse its hotspots."}</p></div>
    ${favs.length ? `<h3>Saved hotspots</h3><ol class="list">${favs.map(([id, f], i) => `<li class="row" style="--i:${i};grid-template-columns:30px 1fr" data-spot="${id}" data-cc="${f.cc}"><span class="rank">♥</span><span class="row-main"><div class="row-title">${esc(f.name)}</div><div class="row-sub">${flag(f.cc)} ${esc(countryName(f.cc))}</div></span></li>`).join("")}</ol>` : ""}`;
  if (state.cc) {
    wireSearch((q) => {
      const s = q.trim().toLowerCase();
      if (!s) return [];
      return regionSpots.filter((h) => h.name.toLowerCase().includes(s)).slice(0, 10);
    }, (h) => `<span style="flex:1"><span class="name">${esc(h.name)}</span><br><span class="meta muted">${h.total.toLocaleString()} checklists</span></span>`, (h) => openSpot(h.id));
  }
}

/* ---- Lifer hunt ---- */

const huntCache = new Map();

async function renderHunt(token) {
  if (!state.cc) {
    view.innerHTML = `<div class="empty-state"><span class="big">✨</span><h2>Where are your next lifers?</h2><p>Choose a country above and I'll rank its hotspots by how many new birds you'd expect to see in one visit.</p></div>`;
    return;
  }
  const hasList = life.hasList();
  const candidates = regionSpots.filter((h) => h.hasTargets && map.getBounds().contains([h.lat, h.lng])).slice(0, 80);
  const pool = candidates.length >= 5 ? candidates : regionSpots.filter((h) => h.hasTargets).slice(0, 80);
  const inView = pool === candidates;

  view.innerHTML = `
    ${!hasList ? `<div class="callout"><b>Tip:</b> add your eBird life list and this ranks hotspots by birds <i>you</i> haven't seen. For now it counts every species.</div>` : ""}
    <div id="live-hunt"></div>
    <h2>Lifer hunt ${esc(inWhen())}</h2>
    <p class="muted" style="margin:4px 0 0">Expected ${hasList ? "new birds" : "species"} per visit: the sum of each ${hasList ? "unseen " : ""}bird's frequency, across the ${pool.length} busiest hotspots ${inView ? "in this map view" : `in ${esc(countryName(state.cc))}`}.</p>
    <div class="btn-row"><button class="btn" data-act="hunt-area">🔄 Search this map area</button></div>
    <div class="progress" id="hunt-progress"><i style="--p:0"></i></div>
    <ol class="list" id="hunt-list"></ol>`;

  if (hasList) fillHuntLive(token);
  const key = `${state.cc}|${state.months}|${life.version()}|${pool.map((h) => h.id).join(",")}`;
  let results = huntCache.get(key);
  if (!results) {
    results = [];
    let done = 0;
    const queue = [...pool];
    const update = () => {
      const p = $("#hunt-progress i");
      if (p) p.style.setProperty("--p", done / pool.length);
      showHunt(results, false);
    };
    const throttled = throttle(update, 400);
    setLoading(true);
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const h = queue.shift();
        const t = await hotspotTargets(h.id).catch(() => null);
        if (token !== renderToken) return;
        done++;
        if (t) {
          const r = scoreHunt(h, t);
          if (r) results.push(r);
        }
        throttled();
      }
    }));
    setLoading(false);
    if (token !== renderToken) return;
    huntCache.set(key, results);
  }
  $("#hunt-progress")?.remove();
  showHunt(results, true);
}

/** Birds you still need that someone reported in the region in the last two weeks. */
async function fillHuntLive(token) {
  const obs = await live("region", { region: state.cc });
  if (token !== renderToken || !obs) return;
  const fresh = obs.filter((o) => !life.isSeen(o.code) && idx.byCode.has(o.code)).sort((a, b) => b.date.localeCompare(a.date));
  const box = $("#live-hunt");
  if (!box) return;
  if (!fresh.length) {
    box.innerHTML = `<div class="live-banner"><span class="live-dot cool"></span><span>None of the ${obs.length} species reported in ${esc(countryName(state.cc))} in the last 2 weeks are new for you.</span></div>`;
    return;
  }
  const shown = state.showAllFresh ? fresh : fresh.slice(0, 5);
  box.innerHTML = `<h2>Fresh lifers <small class="muted" style="font:500 13px var(--sans)">reported in the last 2 weeks</small></h2>
    <ol class="list" style="margin:10px 0 6px">${shown.map((o, i) => {
      const sp = idx.byCode.get(o.code);
      return `<li class="row targets-row" style="--i:${i};grid-template-columns:44px 1fr auto" data-species="${o.code}">
        ${thumbHTML(sp.sci)}<span class="row-main"><div class="row-title">${esc(sp.com)}</div>
        <div class="row-sub"><span class="live-chip ${freshness(o.date)}">● ${ago(o.date)}</span> ${esc(o.name || "a private location")}</div></span>
        <span class="chip lifer">lifer</span></li>`;
    }).join("")}</ol>
    ${fresh.length > 5 && !state.showAllFresh ? `<button class="btn" data-act="fresh">Show all ${fresh.length}</button>` : ""}
    <hr class="divider">`;
  hydrateThumbs(box);
  drawLive(fresh, (o) => `${esc(idx.byCode.get(o.code).com)} · ${ago(o.date)}`);
}

function scoreHunt(h, t) {
  const n = inMonths(t.n, state.months);
  if (n < MIN_CHECKLISTS) return null;
  let expected = 0;
  const lifers = [];
  for (const [code, k] of t.s) {
    if (life.isSeen(code)) continue;
    const f = inMonths(k, state.months) / n;
    if (f <= 0) continue;
    expected += f;
    lifers.push([code, f]);
  }
  lifers.sort((a, b) => b[1] - a[1]);
  return { ...h, n, expected, likely: lifers.filter(([, f]) => f >= 0.1).length, top: lifers.slice(0, 4) };
}

function showHunt(results, final) {
  const list = $("#hunt-list");
  if (!list) return;
  const ranked = [...results].sort((a, b) => b.expected - a.expected).slice(0, 30);
  ranked.forEach((h) => spotMeta.set(h.id, h));
  const max = ranked[0]?.expected || 1;
  list.innerHTML = ranked.map((h, i) => {
    const top = h.top.map(([c]) => idx.byCode.get(c)).filter(Boolean);
    return `<li class="row" style="--i:${final ? i : 0}" data-spot="${h.id}">
      <span class="rank">${i + 1}</span>
      <span class="row-main"><div class="row-title">${esc(h.name)}</div>
        <div class="row-sub"><span class="avatars">${top.slice(0, 3).map((s) => thumbHTML(s.sci, "av")).join("")}</span>
        ${top.length ? esc(top.slice(0, 2).map((s) => s.com).join(", ")) : "nothing new here"}${h.likely ? ` · ${h.likely} at ≥10%` : ""}</div></span>
      <span class="pct">${h.expected.toFixed(1)}<small>${life.hasList() ? "lifers" : "species"} / visit</small></span>
      <span class="bar coral"><i style="--w:${h.expected / max}"></i></span>
    </li>`;
  }).join("");
  hydrateThumbs(list);
  if (final) {
    drawResults(ranked, (h) => h.expected, {
      color: "--coral", pinClass: "coral",
      label: (h) => `${esc(h.name)} · ${h.expected.toFixed(1)} per visit`,
      onClick: (h) => openSpot(h.id),
    });
    if (!ranked.length) list.innerHTML = `<div class="empty-state"><span class="big">🏆</span>No new birds expected around here ${esc(inWhen())}. Time to travel!</div>`;
  }
}

function throttle(fn, ms) {
  let last = 0, timer;
  return () => {
    const now = Date.now();
    clearTimeout(timer);
    if (now - last > ms) { last = now; fn(); } else timer = setTimeout(() => { last = Date.now(); fn(); }, ms);
  };
}

/* ---------------- view actions (delegated) ---------------- */

view.addEventListener("click", async (e) => {
  const seenBtn = e.target.closest("[data-seen]");
  if (seenBtn) {
    e.stopPropagation();
    const code = seenBtn.dataset.seen;
    const added = life.toggle(code, idx);
    const name = idx.byCode.get(code)?.com;
    toast(added ? `🎉 ${name} added to your life list` : `${name} removed from your life list`);
    render();
    return;
  }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "allyear") { state.months = []; renderMonths(); return changed(); }
  if (act === "world") { state.cc = ""; $("#region").value = ""; await loadRegion(true); return changed(); }
  if (act === "targets" || act === "all") { state.showAll = act === "all"; state.showMore = false; return render(); }
  if (act === "more") { state.showMore = true; return render(); }
  if (act === "hunt-area") { huntCache.clear(); return render(); }
  if (act === "fresh") { state.showAllFresh = true; return render(); }
  if (act === "fav") {
    const favs = favorites();
    const h = await findSpot(state.spot);
    if (favs[state.spot]) delete favs[state.spot];
    else favs[state.spot] = { name: h.name, cc: h.cc };
    store("favs", favs);
    toast(favs[state.spot] ? "♥ Saved" : "Removed from saved");
    return render();
  }
  const fly = e.target.closest("[data-fly]");
  if (fly) { const [lat, lng] = fly.dataset.fly.split(",").map(Number); return flyToSpot({ lat, lng }, 13); }
  const sp = e.target.closest("[data-species]");
  if (sp) return chooseSpecies(sp.dataset.species);
  const spot = e.target.closest("[data-spot]");
  if (spot) {
    if (spot.dataset.cc && spot.dataset.cc !== state.cc) {
      state.cc = spot.dataset.cc;
      $("#region").value = state.cc;
      await loadRegion(false);
    }
    openSpot(spot.dataset.spot, spot.dataset.from || null);
  }
});

/* ---------------- life list dialog ---------------- */

const dialog = $("#lifelist-dialog");
$("#lifelist-chip").addEventListener("click", () => { renderLifeDialog(); dialog.showModal(); });

function renderLifeDialog(justImported = 0) {
  const body = $("#lifelist-body");
  const m = life.meta();
  if (life.hasList() && !justImported) {
    body.innerHTML = `
      <h2>Your life list</h2>
      <div class="counter">${life.seenCount().toLocaleString()}</div><div class="muted">species seen</div>
      <p class="hint">${m.file ? `Imported from ${esc(m.file)} on ${new Date(m.importedAt).toLocaleDateString()}` : "Built from your ticks"}${m.manual ? ` · ${m.manual} manual change${m.manual > 1 ? "s" : ""}` : ""}. Stored only in this browser.</p>
      ${dropZone("Drop a newer CSV to update")}
      <div class="btn-row"><button class="btn" data-life="clear">Clear life list</button></div>`;
  } else if (justImported) {
    body.innerHTML = `<h2>Welcome back, birder 🐦</h2><div class="counter" id="count-up">0</div><div class="muted">species on your life list</div>
      <p>Hotspot cards now show <b>your targets</b>, and Lifer hunt ranks places by birds you still need.</p>
      <div class="btn-row"><button class="btn primary" data-life="hunt">✨ Find my lifers</button><button class="btn" data-life="close">Done</button></div>`;
    countUp($("#count-up"), justImported);
  } else {
    body.innerHTML = `
      <h2>Bring your life list</h2>
      <p class="muted">Then every hotspot shows just the birds you still need.</p>
      <ol class="steps">
        <li><span>Sign in to eBird and <a href="https://ebird.org/lifelist?r=world&time=life&fmt=csv" target="_blank" rel="noopener"><b>download your life list (CSV)</b></a>.</span></li>
        <li><span>Drop the file here. It never leaves your browser.</span></li>
      </ol>
      ${dropZone("Drop your eBird CSV here, or tap to choose")}`;
  }
  wireDrop();
}

const dropZone = (label) => `<label class="drop" id="drop"><span style="font-size:26px">🪶</span><b>${label}</b><span class="muted">ebird_world_life_list.csv</span><input type="file" accept=".csv,text/csv" id="csv"></label>`;

function wireDrop() {
  const drop = $("#drop");
  if (!drop) return;
  const handle = async (file) => {
    if (!file) return;
    try {
      const count = life.importCsv(await file.text(), file.name, idx);
      huntCache.clear();
      renderLifeDialog(count);
    } catch (err) {
      toast(err.message);
    }
  };
  $("#csv").addEventListener("change", (e) => handle(e.target.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); handle(e.dataTransfer.files[0]); });
}

$("#lifelist-body").addEventListener("click", (e) => {
  const a = e.target.closest("[data-life]")?.dataset.life;
  if (a === "clear") { life.clear(idx); huntCache.clear(); renderLifeDialog(); toast("Life list cleared"); }
  if (a === "close") dialog.close();
  if (a === "hunt") { dialog.close(); state.tab = "hunt"; changed(); }
});

function countUp(el, to) {
  const start = performance.now(), dur = 1100;
  const step = (t) => {
    const p = Math.min(1, (t - start) / dur);
    el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))).toLocaleString();
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

life.onChange(() => { renderChip(); });

/* ---------------- mobile sheet ---------------- */

function setSheet(mode) {
  const p = $("#panel");
  p.classList.remove("collapsed", "expanded");
  if (mode !== "normal") p.classList.add(mode);
  setTimeout(() => map.invalidateSize(), 320);
}
$("#sheet-handle").addEventListener("click", () => {
  const p = $("#panel");
  setSheet(p.classList.contains("collapsed") ? "normal" : p.classList.contains("expanded") ? "collapsed" : "expanded");
});

/* ---------------- start ---------------- */

function defaultRegion() {
  const saved = store("region");
  if (saved !== null && saved !== undefined) return saved;
  const known = new Set(countries.map(([cc]) => cc));
  for (const lang of navigator.languages || []) {
    const cc = lang.split("-")[1]?.toUpperCase();
    if (cc && known.has(cc)) return cc;
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const byTz = { "Asia/Singapore": "SG", "Asia/Kuala_Lumpur": "MY", "Europe/London": "GB", "Australia/Sydney": "AU", "Asia/Kolkata": "IN", "Asia/Tokyo": "JP", "Asia/Hong_Kong": "HK", "Asia/Bangkok": "TH", "America/New_York": "US", "America/Los_Angeles": "US", "America/Chicago": "US", "America/Toronto": "CA" };
  return byTz[tz] && known.has(byTz[tz]) ? byTz[tz] : "SG";
}

(async function start() {
  setLoading(true);
  try {
    const [species, list, meta] = await Promise.all([speciesIndex(), load("countries.json"), load("meta.json")]);
    idx = species;
    countries = list || [];
    $("#release").textContent = meta ? `${meta.release.replace("rel", "release ")} · ${meta.hotspots.toLocaleString()} hotspots` : "";
    life.resolve(idx);
    renderChip();
    const fromLink = readHash();
    if (!fromLink) state.cc = defaultRegion();
    renderRegions();
    renderMonths();
    await loadRegion(!fromLink || !state.species && !state.spot);
    changed();
  } catch (err) {
    view.innerHTML = `<div class="empty-state"><span class="big">🪹</span>Couldn't load the bird data. ${esc(err.message)}</div>`;
  } finally {
    setLoading(false);
  }
})();

addEventListener("hashchange", () => {
  if (readHash()) { $("#region").value = state.cc; renderMonths(); loadRegion(false).then(changed); }
});
