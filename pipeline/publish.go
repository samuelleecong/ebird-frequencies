package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Output layout under -out (all JSON, sized to fit GitHub Pages' 1 GB limit):
//
//	meta.json               {release, generatedAt, hotspots, species}
//	species.json            [[code, common name, scientific name], ...]
//	countries.json          [[country code, hotspots], ...]
//	countries/CC.json       [[locId, name, lat, lng, [12 checklists], has targets 0/1], ...]
//	species/CODE.json       {"w": [[locId, name, lat, lng, CC, [12 checklists], [12 detections]], ...],
//	                         "c": {"CC": [[locId, [12 detections]], ...]}}
//	targets/LOCID.json      {"n": [12 checklists], "s": [[code, [12 detections]], ...]}
const (
	minChecklists   = 5   // hotspot-periods with fewer complete checklists are too noisy to rank
	worldTop        = 100 // per species, best hotspots worldwide (all year)…
	worldTopMonth   = 10  // …plus the best for each month
	countryTop      = 25  // per species and country, all year…
	countryTopMonth = 5   // …plus each month
	targetsBudget   = 350 << 20
)

type pair struct {
	hot    *Hotspot
	months *[12]uint32
	code   string
}

func publish(hotspots []Hotspot, d *Detections, taxonomyPath, out, release string) error {
	codes, err := speciesCodes(d, taxonomyPath)
	if err != nil {
		return err
	}
	byID := make(map[string]*Hotspot, len(hotspots))
	for i := range hotspots {
		if sum(&hotspots[i].Checklists) >= minChecklists {
			byID[hotspots[i].ID] = &hotspots[i]
		}
	}

	bySpecies := make([][]pair, len(d.Species))
	byHotspot := map[*Hotspot][]pair{}
	for i, key := range d.Keys {
		h := byID[d.Locs[key>>16]]
		if h == nil {
			continue
		}
		sp := key & 0xffff
		p := pair{h, &d.Months[i], codes[sp]}
		bySpecies[sp] = append(bySpecies[sp], p)
		byHotspot[h] = append(byHotspot[h], p)
	}

	w := &writer{root: out, sizes: map[string]int64{}}
	hasTargets := writeTargets(w, byHotspot)

	var speciesIndex [][3]string
	for sp, pairs := range bySpecies {
		if len(pairs) == 0 {
			continue
		}
		speciesIndex = append(speciesIndex, [3]string{codes[sp], d.Species[sp].Com, d.Species[sp].Sci})
		w.json("species/"+codes[sp]+".json", speciesFile(pairs))
	}
	sort.Slice(speciesIndex, func(i, j int) bool { return speciesIndex[i][1] < speciesIndex[j][1] })
	w.json("species.json", speciesIndex)

	byCountry := map[string][][]any{}
	for _, h := range byID {
		t := 0
		if hasTargets[h] {
			t = 1
		}
		byCountry[h.Country] = append(byCountry[h.Country], []any{h.ID, h.Name, round5(h.Lat), round5(h.Lng), h.Checklists, t})
	}
	var countries [][]any
	for cc, list := range byCountry {
		countries = append(countries, []any{cc, len(list)})
		w.json("countries/"+cc+".json", list)
	}
	sort.Slice(countries, func(i, j int) bool { return countries[i][0].(string) < countries[j][0].(string) })
	w.json("countries.json", countries)
	w.json("meta.json", map[string]any{
		"release": release, "generatedAt": time.Now().UTC().Format(time.RFC3339),
		"hotspots": len(byID), "species": len(speciesIndex),
	})

	if w.err != nil {
		return w.err
	}
	var total int64
	for dir, n := range w.sizes {
		log.Printf("publish: %-10s %7.1f MB", dir, float64(n)/1e6)
		total += n
	}
	log.Printf("publish: total %.1f MB, %d hotspots with targets", float64(total)/1e6, len(hasTargets))
	return nil
}

// speciesFile keeps, for one species, the hotspots worth ranking: the best worldwide and the
// best per country, each for the whole year and for every month.
func speciesFile(pairs []pair) map[string]any {
	world := topUnion(pairs, worldTop, worldTopMonth)
	wl := make([][]any, len(world))
	for i, p := range world {
		wl[i] = []any{p.hot.ID, p.hot.Name, round5(p.hot.Lat), round5(p.hot.Lng), p.hot.Country, p.hot.Checklists, *p.months}
	}
	byCountry := map[string][]pair{}
	for _, p := range pairs {
		byCountry[p.hot.Country] = append(byCountry[p.hot.Country], p)
	}
	cl := map[string][][]any{}
	for cc, ps := range byCountry {
		for _, p := range topUnion(ps, countryTop, countryTopMonth) {
			cl[cc] = append(cl[cc], []any{p.hot.ID, *p.months})
		}
	}
	return map[string]any{"w": wl, "c": cl}
}

func topUnion(pairs []pair, nYear, nMonth int) []pair {
	keep := map[*Hotspot]bool{}
	var result []pair
	take := func(score func(p pair) (float64, bool), n int) {
		var ranked []pair
		scores := map[*Hotspot]float64{}
		for _, p := range pairs {
			if s, ok := score(p); ok {
				ranked = append(ranked, p)
				scores[p.hot] = s
			}
		}
		sort.Slice(ranked, func(i, j int) bool { return scores[ranked[i].hot] > scores[ranked[j].hot] })
		for _, p := range ranked[:min(n, len(ranked))] {
			if !keep[p.hot] {
				keep[p.hot] = true
				result = append(result, p)
			}
		}
	}
	take(func(p pair) (float64, bool) {
		n, k := sum(&p.hot.Checklists), sum(p.months)
		return wilsonLower(k, n), n >= minChecklists && k > 0
	}, nYear)
	for m := range 12 {
		take(func(p pair) (float64, bool) {
			n, k := p.hot.Checklists[m], p.months[m]
			return wilsonLower(k, n), n >= minChecklists && k > 0
		}, nMonth)
	}
	return result
}

// writeTargets writes full species lists for the busiest hotspots until the size budget is used.
func writeTargets(w *writer, byHotspot map[*Hotspot][]pair) map[*Hotspot]bool {
	order := make([]*Hotspot, 0, len(byHotspot))
	for h := range byHotspot {
		order = append(order, h)
	}
	sort.Slice(order, func(i, j int) bool { return sum(&order[i].Checklists) > sum(&order[j].Checklists) })
	done := map[*Hotspot]bool{}
	var used int64
	for _, h := range order {
		ps := byHotspot[h]
		sort.Slice(ps, func(i, j int) bool { return sum(ps[i].months) > sum(ps[j].months) })
		s := make([][]any, len(ps))
		for i, p := range ps {
			s[i] = []any{p.code, *p.months}
		}
		n := w.json("targets/"+h.ID+".json", map[string]any{"n": h.Checklists, "s": s})
		if used += n; used > targetsBudget {
			break
		}
		done[h] = true
	}
	return done
}

var nonWord = regexp.MustCompile(`\W+`)

func speciesCodes(d *Detections, taxonomyPath string) ([]string, error) {
	raw, err := os.ReadFile(taxonomyPath)
	if err != nil {
		return nil, err
	}
	var taxa []struct{ SciName, SpeciesCode string }
	if err := json.Unmarshal(raw, &taxa); err != nil {
		return nil, fmt.Errorf("taxonomy: %w", err)
	}
	bySci := make(map[string]string, len(taxa))
	for _, t := range taxa {
		bySci[t.SciName] = t.SpeciesCode
	}
	codes := make([]string, len(d.Species))
	for i, s := range d.Species {
		if codes[i] = bySci[s.Sci]; codes[i] == "" {
			codes[i] = strings.Trim(nonWord.ReplaceAllString(strings.ToLower(s.Sci), "-"), "-")
		}
	}
	return codes, nil
}

type writer struct {
	root  string
	sizes map[string]int64
	err   error
}

func (w *writer) json(rel string, v any) int64 {
	if w.err != nil {
		return 0
	}
	b, err := json.Marshal(v)
	if err == nil {
		path := filepath.Join(w.root, rel)
		if err = os.MkdirAll(filepath.Dir(path), 0o755); err == nil {
			err = os.WriteFile(path, b, 0o644)
		}
	}
	w.err = err
	w.sizes[strings.SplitN(rel, "/", 2)[0]] += int64(len(b))
	return int64(len(b))
}

func sum(m *[12]uint32) uint32 {
	var s uint32
	for _, v := range m {
		s += v
	}
	return s
}

// wilsonLower is the lower bound of the 95% Wilson interval for k successes in n trials:
// it ranks 30 of 100 above 1 of 2, so tiny samples don't win on luck.
func wilsonLower(k, n uint32) float64 {
	if n == 0 {
		return 0
	}
	const z = 1.96
	nf, p := float64(n), float64(k)/float64(n)
	return (p + z*z/(2*nf) - z*math.Sqrt((p*(1-p)+z*z/(4*nf))/nf)) / (1 + z*z/nf)
}

func round5(x float64) float64 { return math.Round(x*1e5) / 1e5 }
