// ebdagg turns the eBird Basic Dataset into per-hotspot, per-month species frequencies
// and writes them as static JSON for the map page.
//
//	ebdagg fetch URL [connections] [limit-bytes] | igzip -dc | …   (parallel download of the .tar's .gz)
//	<sampling.txt  ebdagg sampling hotspots.gob
//	<ebd.txt       ebdagg observations -hotspots hotspots.gob -taxonomy taxonomy.json -out site/data
//
// Both commands read the decompressed tab-separated file on stdin in a single pass, so the
// multi-hundred-GB World files can be streamed straight from eBird without touching disk.
package main

import (
	"bufio"
	"bytes"
	"encoding/gob"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"strconv"
	"time"
)

func main() {
	log.SetFlags(log.Ltime)
	if len(os.Args) < 2 {
		log.Fatal("usage: ebdagg sampling OUT.gob | ebdagg observations -hotspots IN.gob -taxonomy TAX.json -out DIR")
	}
	var err error
	switch os.Args[1] {
	case "sampling":
		if len(os.Args) != 3 {
			log.Fatal("usage: ebdagg sampling OUT.gob")
		}
		err = runSampling(os.Stdin, os.Args[2])
	case "observations":
		fs := flag.NewFlagSet("observations", flag.ExitOnError)
		hotspots := fs.String("hotspots", "", "hotspots .gob written by the sampling command (waited for if not there yet)")
		taxonomy := fs.String("taxonomy", "", "eBird taxonomy JSON from api.ebird.org/v2/ref/taxonomy/ebird")
		out := fs.String("out", "", "output directory")
		release := fs.String("release", "", "EBD release name, recorded in meta.json")
		fs.Parse(os.Args[2:])
		err = runObservations(os.Stdin, *hotspots, *taxonomy, *out, *release)
	case "fetch":
		err = runFetch(os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		log.Fatal(err)
	}
}

// scanRows calls fn with the requested columns of every complete row. The field slices
// point into a reused buffer and are only valid during the call.
func scanRows(r io.Reader, label string, columns []string, fn func(f [][]byte)) (int, error) {
	br := bufio.NewReaderSize(r, 16<<20)
	header, err := br.ReadString('\n')
	if err != nil {
		return 0, fmt.Errorf("%s: reading header: %w", label, err)
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
			return 0, fmt.Errorf("%s: column %q missing", label, want)
		}
	}

	fields := make([][]byte, len(columns))
	var long []byte
	rows, read := 0, int64(len(header))
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
		if n := splitInto(line, slot, maxCol, fields); n == len(columns) {
			fn(fields)
			rows++
			if rows%100_000_000 == 0 {
				secs := time.Since(start).Seconds()
				log.Printf("%s: %dM rows, %.0f GB, %.0f MB/s", label, rows/1_000_000, float64(read)/1e9, float64(read)/1e6/secs)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			// A truncated stream (e.g. a smoke test reading only part of the file) ends here too
			log.Printf("%s: stopped reading: %v", label, err)
			break
		}
	}
	log.Printf("%s: done, %d rows, %.1f GB in %s", label, rows, float64(read)/1e9, time.Since(start).Round(time.Second))
	return rows, nil
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

type Hotspot struct {
	ID, Name, Country string
	Lat, Lng          float64
	Checklists        [12]uint32 // complete checklists per month
}

func runSampling(r io.Reader, out string) error {
	byID := map[string]*Hotspot{}
	_, err := scanRows(r, "sampling",
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
		})
	if err != nil {
		return err
	}
	list := make([]Hotspot, 0, len(byID))
	for _, h := range byID {
		list = append(list, *h)
	}
	// Written under a temporary name so a concurrently running observations pass never reads half a file
	tmp := out + ".tmp"
	file, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if err := gob.NewEncoder(file).Encode(list); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	log.Printf("sampling: %d hotspots", len(list))
	return os.Rename(tmp, out)
}

// Detections holds, for each (hotspot, species) pair seen, how many complete checklists
// reported the species in each month.
type Detections struct {
	Locs    []string
	Species []struct{ Sci, Com string }
	Keys    []uint64 // loc index << 16 | species index, parallel to Months
	Months  [][12]uint32
}

func runObservations(r io.Reader, hotspotsPath, taxonomyPath, out, release string) error {
	if hotspotsPath == "" || taxonomyPath == "" || out == "" {
		return fmt.Errorf("observations needs -hotspots, -taxonomy and -out")
	}
	d := &Detections{}
	locIdx := map[string]uint32{}
	spIdx := map[string]uint16{}
	pairs := map[uint64]uint32{}
	// Last species (index+1) counted per checklist number, so a species reported on several rows of
	// one checklist (e.g. two subspecies) counts once. Repeats are usually adjacent; on a real EBD
	// sample the few this misses inflate counts by ~0.003%.
	lastSpecies := make([]uint16, 500_000_000)

	_, err := scanRows(r, "observations",
		[]string{"LOCALITY ID", "LOCALITY TYPE", "OBSERVATION DATE", "ALL SPECIES REPORTED", "CATEGORY", "SCIENTIFIC NAME", "COMMON NAME", "SAMPLING EVENT IDENTIFIER"},
		func(f [][]byte) {
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
			sp, ok := spIdx[string(f[5])]
			if !ok {
				if len(d.Species) == 0xffff {
					log.Fatal("more than 65535 taxa")
				}
				sp = uint16(len(d.Species))
				spIdx[string(f[5])] = sp
				d.Species = append(d.Species, struct{ Sci, Com string }{string(f[5]), string(f[6])})
			}
			if len(f[7]) > 1 {
				if id, err := strconv.Atoi(string(f[7][1:])); err == nil && id >= 0 {
					for id >= len(lastSpecies) {
						lastSpecies = append(lastSpecies, make([]uint16, len(lastSpecies)/2)...)
					}
					if lastSpecies[id] == sp+1 {
						return
					}
					lastSpecies[id] = sp + 1
				}
			}
			loc, ok := locIdx[string(f[0])]
			if !ok {
				loc = uint32(len(d.Locs))
				locIdx[string(f[0])] = loc
				d.Locs = append(d.Locs, string(f[0]))
			}
			key := uint64(loc)<<16 | uint64(sp)
			i, ok := pairs[key]
			if !ok {
				i = uint32(len(d.Months))
				pairs[key] = i
				d.Keys = append(d.Keys, key)
				d.Months = append(d.Months, [12]uint32{})
			}
			d.Months[i][m]++
		})
	if err != nil {
		return err
	}
	lastSpecies, pairs, locIdx, spIdx = nil, nil, nil, nil
	log.Printf("observations: %d hotspots, %d taxa, %d hotspot-species pairs", len(d.Locs), len(d.Species), len(d.Keys))

	hotspots, err := waitForHotspots(hotspotsPath)
	if err != nil {
		return err
	}
	return publish(hotspots, d, taxonomyPath, out, release)
}

func waitForHotspots(path string) ([]Hotspot, error) {
	deadline := time.Now().Add(3 * time.Hour)
	for {
		file, err := os.Open(path)
		if err == nil {
			defer file.Close()
			var list []Hotspot
			return list, gob.NewDecoder(file).Decode(&list)
		}
		if !os.IsNotExist(err) || time.Now().After(deadline) {
			return nil, err
		}
		if _, err := os.Stat(path + ".failed"); err == nil {
			return nil, fmt.Errorf("sampling pass failed (%s.failed exists)", path)
		}
		log.Printf("waiting for %s from the sampling pass…", path)
		time.Sleep(time.Minute)
	}
}
