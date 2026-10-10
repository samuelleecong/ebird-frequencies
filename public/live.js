// Recent eBird reports via our Vercel function (api/ebird.js). Where that isn't available
// (e.g. the GitHub Pages copy) every call resolves to null and the live bits simply don't show.
const cache = new Map();

export function live(kind, params) {
  const q = new URLSearchParams({ kind, ...params });
  const key = q.toString();
  if (!cache.has(key)) {
    cache.set(key, fetch(`/api/ebird?${q}`)
      .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : null))
      .catch(() => null));
  }
  return cache.get(key);
}

/** "today", "yesterday", "3 days ago", "2 weeks ago" from an eBird "YYYY-MM-DD HH:MM" date. */
export function ago(date) {
  const then = new Date(date.slice(0, 10) + "T12:00:00");
  const days = Math.max(0, Math.round((Date.now() - then) / 864e5));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return `${Math.round(days / 7)} weeks ago`;
}

export const freshness = (date) => {
  const days = (Date.now() - new Date(date.slice(0, 10) + "T12:00:00")) / 864e5;
  return days < 3 ? "hot" : days < 10 ? "warm" : "cool";
};
