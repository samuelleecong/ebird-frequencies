// ebdagg turns the eBird Basic Dataset into per-hotspot, per-month species frequencies
// and writes them as static JSON for the map page.
//
//	ebdagg build -release relAug-2026 -state state/ [-stop-after 5h20m] [-limit-gb 5]
//	ebdagg publish -state state/ -taxonomy taxonomy.json -out site/data -release relAug-2026
//
// build streams the World EBD (~250 GB compressed) straight from eBird, decompressing and
// counting as it goes, so nothing large touches disk. eBird's download speed varies between
// runs, so build can stop at a deadline: it pauses the decompressor at a block boundary, saves
// its counts and position in -state, and the next run carries on from there.
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/gob"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"ebdagg/flatex"
)

const defaultBase = "https://download.ebird.org/ebd/prepackaged"

func main() {
	log.SetFlags(log.Ltime)
	if len(os.Args) < 2 {
		log.Fatal("usage: ebdagg build|publish [flags]")
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	state := fs.String("state", "state", "directory holding progress between runs")
	release := fs.String("release", "", "EBD release, e.g. relAug-2026")
	var err error
	switch os.Args[1] {
	case "build":
		base := fs.String("base", defaultBase, "where the EBD .tar files are")
		stopAfter := fs.Duration("stop-after", 0, "save progress and stop after this long (0 = run to the end)")
		limitGB := fs.Float64("limit-gb", 0, "smoke test: only read this many GB of the observations .gz")
		fs.Parse(os.Args[2:])
		err = runBuild(*base, *release, *state, *stopAfter, *limitGB)
	case "publish":
		taxonomy := fs.String("taxonomy", "", "eBird taxonomy JSON from api.ebird.org/v2/ref/taxonomy/ebird")
		out := fs.String("out", "", "output directory")
		fs.Parse(os.Args[2:])
		err = runPublish(*state, *taxonomy, *out, *release)
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		log.Fatal(err)
	}
}

/* ---------------- build ---------------- */

type progress struct {
	Release    string
	Done       bool
	Partial    bool  // a -limit-gb smoke test, not the whole dataset
	Offset     int64 // where to restart in the observations .gz
	Checkpoint *flatex.Checkpoint
	Header     string // the file's header line, needed to find columns after a restart
	Carry      []byte // the unfinished line at the pause
	Runs       int
}

func runBuild(base, release, dir string, stopAfter time.Duration, limitGB float64) error {
	if release == "" {
		return errors.New("build needs -release")
	}
	var deadline time.Time
	if stopAfter > 0 {
		deadline = time.Now().Add(stopAfter)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var prog progress
	if err := readJSON(filepath.Join(dir, "progress.json"), &prog); err != nil && !os.IsNotExist(err) {
		return err
	}
	if prog.Release != "" && prog.Release != release {
		return fmt.Errorf("state is for %s, not %s", prog.Release, release)
	}
	if prog.Done {
		log.Printf("build: %s already complete", release)
		return nil
	}
	prog.Release = release
	prog.Runs++

	hotPath := filepath.Join(dir, "hotspots.gob")
	if _, err := os.Stat(hotPath); os.IsNotExist(err) {
		if err := samplingPass(base+"/ebd_sampling_"+release+".tar", hotPath); err != nil {
			return err
		}
	}

	m, err := tarMember(base + "/ebd_" + release + ".tar")
	if err != nil {
		return err
	}
	var end int64
	if limitGB > 0 {
		end = int64(limitGB * 1e9)
	}
	d, err := loadDetections(dir)
	if err != nil {
		return err
	}
	agg := newAggregator(d)
	log.Printf("observations: run %d, starting at %.1f of %.1f GB", prog.Runs, float64(prog.Offset)/1e9, float64(m.size)/1e9)

	src := m.open(prog.Offset, end)
	gz, err := newGzStream(src, prog.Offset, prog.Checkpoint, deadline)
	if err != nil {
		src.Close()
		return err
	}
	header, carry, paused, err := scanRows(io.MultiReader(bytes.NewReader(prog.Carry), gz), prog.Header, "observations", obsColumns, agg.row, limitGB > 0)
	src.Close()
	if err != nil {
		return err
	}
	if paused {
		off, cp := gz.checkpoint()
		prog.Offset, prog.Checkpoint, prog.Header, prog.Carry = off, &cp, header, carry
		log.Printf("observations: paused at %.1f of %.1f GB; the next run carries on from here", float64(off)/1e9, float64(m.size)/1e9)
	} else {
		prog.Done, prog.Partial, prog.Checkpoint, prog.Carry = true, limitGB > 0, nil, nil
		log.Printf("observations: complete")
	}
	log.Printf("observations: %d hotspots, %d taxa, %d hotspot-species pairs so far", len(d.Locs), len(d.Species), len(d.Keys))
	agg.release()
	if err := saveDetections(dir, d); err != nil {
		return err
	}
	return writeJSON(filepath.Join(dir, "progress.json"), prog)
}

/* ---------------- publish ---------------- */

func runPublish(dir, taxonomy, out, release string) error {
	if taxonomy == "" || out == "" {
		return errors.New("publish needs -taxonomy and -out")
	}
	var prog progress
	if err := readJSON(filepath.Join(dir, "progress.json"), &prog); err != nil {
		return err
	}
	if !prog.Done {
		return fmt.Errorf("build of %s isn't finished (stopped at %.1f GB)", prog.Release, float64(prog.Offset)/1e9)
	}
	if prog.Partial {
		log.Printf("publish: note, this is a partial (smoke test) build")
	}
	var hotspots []Hotspot
	if err := readGob(filepath.Join(dir, "hotspots.gob"), &hotspots); err != nil {
		return err
	}
	d, err := loadDetections(dir)
	if err != nil {
		return err
	}
	if release == "" {
		release = prog.Release
	}
	return publish(hotspots, d, taxonomy, out, release)
}

/* ---------------- reading the TSV ---------------- */

// scanRows calls fn with the requested columns of every complete row (the field slices are only
// valid during the call). header is the file's header line, or "" to read it from r. If r stops
// with flatex.ErrPaused, the unfinished last line is returned as carry. With truncatedOK, an
// unexpected end of input (a smoke test reading part of the file) counts as the end.
func scanRows(r io.Reader, header, label string, columns []string, fn func(f [][]byte), truncatedOK bool) (string, []byte, bool, error) {
	br := bufio.NewReaderSize(r, 16<<20)
	if header == "" {
		h, err := br.ReadString('\n')
		if err != nil {
			return "", nil, false, fmt.Errorf("%s: reading header: %w", label, err)
		}
		header = h
	}
	names := bytes.Split(bytes.TrimRight([]byte(header), "\r\n"), []byte("\t"))
	slot := make([]int, len(names))
	for i := range slot {
		slot[i] = -1
	}
	maxCol := 0
	for s, want := range columns {
		found := false
		for i, n := range names {
			if string(n) == want {
				slot[i], found, maxCol = s, true, max(maxCol, i)
				break
			}
		}
		if !found {
			return "", nil, false, fmt.Errorf("%s: column %q missing", label, want)
		}
	}

	fields := make([][]byte, len(columns))
	var long []byte
	rows, read := 0, int64(0)
	start := time.Now()
	for {
		line, err := br.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			long = append(long[:0], line...)
			for err == bufio.ErrBufferFull {
				line, err = br.ReadSlice('\n')
				long = append(long, line...)
			}
			line = long
		}
		read += int64(len(line))
		if errors.Is(err, flatex.ErrPaused) {
			log.Printf("%s: %d rows, %.1f GB this run in %s", label, rows, float64(read)/1e9, time.Since(start).Round(time.Second))
			return header, append([]byte(nil), line...), true, nil
		}
		if n := splitInto(line, slot, maxCol, fields); n == len(columns) {
			fn(fields)
			rows++
			if rows%100_000_000 == 0 {
				log.Printf("%s: %dM rows, %.0f GB, %.0f MB/s", label, rows/1_000_000, float64(read)/1e9, float64(read)/1e6/time.Since(start).Seconds())
			}
		}
		if err == io.EOF || truncatedOK && errors.Is(err, io.ErrUnexpectedEOF) {
			break
		}
		if err != nil {
			return "", nil, false, fmt.Errorf("%s: %w", label, err)
		}
	}
	log.Printf("%s: done, %d rows, %.1f GB in %s", label, rows, float64(read)/1e9, time.Since(start).Round(time.Second))
	return header, nil, false, nil
}

func splitInto(line []byte, slot []int, maxCol int, fields [][]byte) int {
	found, pos := 0, 0
	for col := 0; col <= maxCol; col++ {
		j := bytes.IndexByte(line[pos:], '\t')
		end := pos + j
		if j < 0 {
			end = len(line)
			for end > pos && (line[end-1] == '\n' || line[end-1] == '\r') {
				end--
			}
		}
		if s := slot[col]; s >= 0 {
			fields[s] = line[pos:end]
			found++
		}
		if j < 0 {
			break
		}
		pos = end + 1
	}
	return found
}

func monthOf(date []byte) (int, bool) {
	if len(date) < 7 {
		return 0, false
	}
	m := int(date[5]-'0')*10 + int(date[6]-'0') - 1
	return m, m >= 0 && m < 12
}

/* ---------------- sampling: checklists per hotspot ---------------- */

type Hotspot struct {
	ID, Name, Country string
	Lat, Lng          float64
	Checklists        [12]uint32 // complete checklists per month
}

func samplingPass(url, out string) error {
	m, err := tarMember(url)
	if err != nil {
		return err
	}
	src := m.open(0, 0)
	defer src.Close()
	gz, err := gzip.NewReader(src)
	if err != nil {
		return err
	}
	byID := map[string]*Hotspot{}
	_, _, _, err = scanRows(gz, "", "sampling",
		[]string{"LOCALITY ID", "LOCALITY TYPE", "LOCALITY", "LATITUDE", "LONGITUDE", "COUNTRY CODE", "OBSERVATION DATE", "ALL SPECIES REPORTED"},
		func(f [][]byte) {
			if string(f[1]) != "H" || string(f[7]) != "1" {
				return
			}
			m, ok := monthOf(f[6])
			if !ok {
				return
			}
			h := byID[string(f[0])]
			if h == nil {
				lat, _ := strconv.ParseFloat(string(f[3]), 64)
				lng, _ := strconv.ParseFloat(string(f[4]), 64)
				h = &Hotspot{ID: string(f[0]), Name: string(f[2]), Country: string(f[5]), Lat: lat, Lng: lng}
				byID[h.ID] = h
			}
			h.Checklists[m]++
		}, false)
	if err != nil {
		return err
	}
	list := make([]Hotspot, 0, len(byID))
	for _, h := range byID {
		list = append(list, *h)
	}
	log.Printf("sampling: %d hotspots", len(list))
	return writeGob(out, list)
}

/* ---------------- observations: detections per hotspot and species ---------------- */

var obsColumns = []string{"LOCALITY ID", "LOCALITY TYPE", "OBSERVATION DATE", "ALL SPECIES REPORTED", "CATEGORY", "SCIENTIFIC NAME", "COMMON NAME", "SAMPLING EVENT IDENTIFIER"}

// Detections holds, for each (hotspot, species) pair seen, how many complete checklists
// reported the species in each month.
type Detections struct {
	Locs    []string
	Species []struct{ Sci, Com string }
	Keys    []uint64 // loc index << 16 | species index, parallel to Months
	Months  [][12]uint32
}

type aggregator struct {
	d      *Detections
	locIdx map[string]uint32
	spIdx  map[string]uint16
	pairs  map[uint64]uint32
	// Last species (index+1) counted per checklist number, so a species reported on several rows of
	// one checklist (e.g. two subspecies) counts once. Repeats are usually adjacent; on a real EBD
	// sample the few this misses inflate counts by ~0.003%.
	lastSpecies []uint16
}

func newAggregator(d *Detections) *aggregator {
	a := &aggregator{d: d, locIdx: make(map[string]uint32, len(d.Locs)), spIdx: map[string]uint16{},
		pairs: make(map[uint64]uint32, len(d.Keys)), lastSpecies: make([]uint16, 500_000_000)}
	for i, l := range d.Locs {
		a.locIdx[l] = uint32(i)
	}
	for i, s := range d.Species {
		a.spIdx[s.Sci] = uint16(i)
	}
	for i, k := range d.Keys {
		a.pairs[k] = uint32(i)
	}
	return a
}

// release frees the lookup tables before the counts are saved.
func (a *aggregator) release() { a.locIdx, a.spIdx, a.pairs, a.lastSpecies = nil, nil, nil, nil }

func (a *aggregator) row(f [][]byte) {
	d := a.d
	if string(f[1]) != "H" || string(f[3]) != "1" {
		return
	}
	switch string(f[4]) {
	case "species", "issf", "form": // species-level; issf/form rows carry the species' scientific name
	default:
		return
	}
	m, ok := monthOf(f[2])
	if !ok {
		return
	}
	sp, ok := a.spIdx[string(f[5])]
	if !ok {
		if len(d.Species) == 0xffff {
			log.Fatal("more than 65535 taxa")
		}
		sp = uint16(len(d.Species))
		a.spIdx[string(f[5])] = sp
		d.Species = append(d.Species, struct{ Sci, Com string }{string(f[5]), string(f[6])})
	}
	if len(f[7]) > 1 {
		if id, err := strconv.Atoi(string(f[7][1:])); err == nil && id >= 0 {
			for id >= len(a.lastSpecies) {
				a.lastSpecies = append(a.lastSpecies, make([]uint16, len(a.lastSpecies)/2)...)
			}
			if a.lastSpecies[id] == sp+1 {
				return
			}
			a.lastSpecies[id] = sp + 1
		}
	}
	loc, ok := a.locIdx[string(f[0])]
	if !ok {
		loc = uint32(len(d.Locs))
		a.locIdx[string(f[0])] = loc
		d.Locs = append(d.Locs, string(f[0]))
	}
	key := uint64(loc)<<16 | uint64(sp)
	i, ok := a.pairs[key]
	if !ok {
		i = uint32(len(d.Months))
		a.pairs[key] = i
		d.Keys = append(d.Keys, key)
		d.Months = append(d.Months, [12]uint32{})
	}
	d.Months[i][m]++
}

/* ---------------- state files ---------------- */

// Detections are saved as a small gob (names) plus raw little-endian counts, since the counts run
// to tens of millions of rows and gob would hold a second copy in memory while encoding.
func saveDetections(dir string, d *Detections) error {
	if err := writeGob(filepath.Join(dir, "names.gob"), struct {
		Locs    []string
		Species []struct{ Sci, Com string }
	}{d.Locs, d.Species}); err != nil {
		return err
	}
	tmp := filepath.Join(dir, "counts.bin.tmp")
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 4<<20)
	buf := binary.LittleEndian.AppendUint64(nil, uint64(len(d.Keys)))
	for i, k := range d.Keys {
		buf = binary.LittleEndian.AppendUint64(buf, k)
		for _, v := range d.Months[i] {
			buf = binary.LittleEndian.AppendUint32(buf, v)
		}
		if len(buf) > 1<<20 {
			if _, err := w.Write(buf); err != nil {
				return err
			}
			buf = buf[:0]
		}
	}
	if _, err := w.Write(buf); err != nil {
		return err
	}
	if err := w.Flush(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "counts.bin"))
}

func loadDetections(dir string) (*Detections, error) {
	d := &Detections{}
	var names struct {
		Locs    []string
		Species []struct{ Sci, Com string }
	}
	if err := readGob(filepath.Join(dir, "names.gob"), &names); os.IsNotExist(err) {
		return d, nil
	} else if err != nil {
		return nil, err
	}
	d.Locs, d.Species = names.Locs, names.Species
	f, err := os.Open(filepath.Join(dir, "counts.bin"))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 4<<20)
	var n uint64
	if err := binary.Read(r, binary.LittleEndian, &n); err != nil {
		return nil, err
	}
	d.Keys = make([]uint64, n)
	d.Months = make([][12]uint32, n)
	rec := make([]byte, 8+12*4)
	for i := range d.Keys {
		if _, err := io.ReadFull(r, rec); err != nil {
			return nil, err
		}
		d.Keys[i] = binary.LittleEndian.Uint64(rec)
		for m := range 12 {
			d.Months[i][m] = binary.LittleEndian.Uint32(rec[8+4*m:])
		}
	}
	return d, nil
}

func writeGob(path string, v any) error {
	return writeFile(path, func(w io.Writer) error { return gob.NewEncoder(w).Encode(v) })
}

func readGob(path string, v any) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return gob.NewDecoder(bufio.NewReader(f)).Decode(v)
}

func writeJSON(path string, v any) error {
	return writeFile(path, func(w io.Writer) error { return json.NewEncoder(w).Encode(v) })
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// writeFile writes via a temporary file so a crash never leaves half a state file behind.
func writeFile(path string, write func(io.Writer) error) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	w := bufio.NewWriter(f)
	if err := write(w); err != nil {
		f.Close()
		return err
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
