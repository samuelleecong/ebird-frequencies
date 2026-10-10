# Lifer Map

**https://samuelleecong.github.io/ebird-frequencies/**

- **Find a bird**: pick any species and see the hotspots where it's reported on the highest share of complete
  checklists, ranked so spots with only a handful of checklists don't win on luck, plus an eBird-style
  month-by-month chart of when it's easiest.
- **Hotspot**: your target list for any hotspot: every bird you haven't seen, with its frequency and season.
- **Lifer hunt**: which hotspots in view give you the most new birds per visit, for the months you're travelling.
- Import your eBird life list (CSV); it stays in your browser. Months can be any set, e.g. Nov–Feb.

A monthly GitHub Actions job streams the World [eBird Basic Dataset](https://ebird.org/data/download)
(~250 GB compressed) straight from eBird through `pipeline/` (Go), which counts, per hotspot and month,
how many complete checklists there were and how many reported each species. The trimmed result is
published as static JSON alongside `public/index.html` on GitHub Pages; ranking happens in the browser.

- Page-only changes (`public/`) deploy in about a minute via "Deploy page changes", reusing the last build's data.
- Run manually: Actions → "Build site from eBird data" → Run workflow (`sample_gb` = 5 for a quick smoke test).
- Secret needed: `EBIRD_API_KEY` (for species codes from the eBird taxonomy).

Data: eBird Basic Dataset, Cornell Lab of Ornithology, Ithaca, New York. Only aggregated frequencies are
published here; the raw dataset is never stored in this repository.
