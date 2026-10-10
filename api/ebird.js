// Live eBird sightings for the page. The API key stays here on the server, and every answer is
// cached at Vercel's CDN, because eBird allows one key only 500 requests an hour.
const API = "https://api.ebird.org/v2/data/obs";
const REGION = /^[A-Z]{2}(-[A-Z0-9]{1,3}){0,2}$/;
const SPECIES = /^[a-z0-9]{3,12}$/;
const HOTSPOT = /^L\d{1,12}$/;

const QUERIES = {
  // Latest report of one species at each location in a region, last 30 days
  species: (q) => REGION.test(q.get("region")) && SPECIES.test(q.get("species")) && { path: `${q.get("region")}/recent/${q.get("species")}?back=30`, ttl: 3600 },
  // Latest report of each species at one hotspot, last 30 days
  hotspot: (q) => HOTSPOT.test(q.get("loc")) && { path: `${q.get("loc")}/recent?back=30`, ttl: 3600 },
  // Every species ever recorded at a hotspot (no counts), for hotspots too quiet to get a published list
  spplist: (q) => HOTSPOT.test(q.get("loc")) && { url: `https://api.ebird.org/v2/product/spplist/${q.get("loc")}`, ttl: 86400, raw: true },
  // Latest report of each species anywhere in a region, last 14 days
  region: (q) => REGION.test(q.get("region")) && { path: `${q.get("region")}/recent?back=14`, ttl: 1800 },
};

function reply(body, status, ttl) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=300, s-maxage=${ttl}, stale-while-revalidate=${ttl * 6}`,
    },
  });
}

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const query = QUERIES[q.get("kind")]?.(q);
  if (!query) return reply({ error: "unsupported query" }, 400, 86400);

  const res = await fetch(query.url || `${API}/${query.path}`, { headers: { "X-eBirdApiToken": process.env.EBIRD_API_KEY } });
  if (!res.ok) return reply({ error: `eBird answered HTTP ${res.status}` }, 502, 60);
  if (query.raw) return reply(await res.json(), 200, query.ttl);

  const obs = (await res.json()).map((o) => ({
    code: o.speciesCode,
    date: o.obsDt,
    count: o.howMany ?? null,
    // Personal locations are often someone's home: keep them anonymous and approximate
    loc: o.locationPrivate ? null : o.locId,
    name: o.locationPrivate ? null : o.locName,
    lat: o.locationPrivate ? Math.round(o.lat * 50) / 50 : o.lat,
    lng: o.locationPrivate ? Math.round(o.lng * 50) / 50 : o.lng,
  }));
  return reply(obs, 200, query.ttl);
}
