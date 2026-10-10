# eBird hotspot frequencies

Pick a bird, see the hotspots where it's reported on the highest share of complete checklists.

A monthly GitHub Actions job streams the World [eBird Basic Dataset](https://ebird.org/data/download)
(~250 GB compressed) straight from eBird through `pipeline/` (Go), which counts, per hotspot and month,
how many complete checklists there were and how many reported each species. The trimmed result is
published as static JSON alongside `public/index.html` on GitHub Pages; ranking happens in the browser.

- Run manually: Actions → "Build site from eBird data" → Run workflow (`sample_gb` = 5 for a quick smoke test).
- Secret needed: `EBIRD_API_KEY` (for species codes from the eBird taxonomy).

Data: eBird Basic Dataset, Cornell Lab of Ornithology, Ithaca, New York. Only aggregated frequencies are
published here; the raw dataset is never stored in this repository.
