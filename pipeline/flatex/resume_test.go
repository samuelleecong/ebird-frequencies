package flatex

import (
	"bufio"
	"bytes"
	"compress/flate"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"testing"
)

// Pausing anywhere and resuming from the checkpoint must reproduce the stream exactly.
func TestPauseResume(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	var plain bytes.Buffer
	words := []string{"Yellow-vented Bulbul", "L38405173", "species", "2024-11-15", "Pycnonotus goiavier", "1"}
	for i := 0; i < 400000; i++ {
		fmt.Fprintf(&plain, "%s\t%s\t%d\n", words[rng.Intn(len(words))], words[rng.Intn(len(words))], rng.Intn(1000))
	}
	for _, level := range []int{flate.BestSpeed, flate.DefaultCompression, flate.HuffmanOnly, flate.NoCompression} {
		var comp bytes.Buffer
		w, _ := flate.NewWriter(&comp, level)
		// Small writes with flushes make many blocks, including stored ones
		data := plain.Bytes()
		for i := 0; i < len(data); i += 70000 {
			w.Write(data[i:min(i+70000, len(data))])
			if i%3 == 0 {
				w.Flush()
			}
		}
		w.Close()

		for _, pauseAfter := range []int{1, 100000, 2500000, 5000000} {
			var out bytes.Buffer
			f := New(bufio.NewReader(bytes.NewReader(comp.Bytes())))
			buf := make([]byte, 4096)
			for out.Len() < pauseAfter {
				n, err := f.Read(buf)
				out.Write(buf[:n])
				if err != nil {
					t.Fatalf("level %d: early error %v", level, err)
				}
			}
			f.Pause()
			for {
				n, err := f.Read(buf)
				out.Write(buf[:n])
				if errors.Is(err, ErrPaused) || err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			cp := f.Checkpoint()
			rest := New(bufio.NewReader(bytes.NewReader(nil)))
			if cp.Consumed < int64(comp.Len()) {
				rest = Resume(bufio.NewReader(bytes.NewReader(comp.Bytes()[cp.Consumed:])), cp)
				if _, err := io.Copy(&out, rest); err != nil {
					t.Fatalf("level %d pause %d: resume: %v", level, pauseAfter, err)
				}
			}
			if !bytes.Equal(out.Bytes(), plain.Bytes()) {
				t.Fatalf("level %d pause %d: output differs (%d vs %d bytes)", level, pauseAfter, out.Len(), plain.Len())
			}
		}
	}
}
