package main

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// eBird serves roughly 10 MB/s per connection, too slow to stream 250 GB inside GitHub's 6-hour
// job limit, so fetch downloads the archive's .gz member as a few parallel byte ranges and writes
// them to stdout in order. eBird answers bursts of requests with HTTP 429, so chunks are large
// (few requests) and 429s are retried after the delay it asks for.
const chunkSize = 256 << 20

func runFetch(args []string) error {
	if len(args) < 1 {
		return errors.New("usage: ebdagg fetch URL [connections] [limit-bytes]")
	}
	url, conns, limit := args[0], 2, int64(0)
	if len(args) > 1 {
		conns, _ = strconv.Atoi(args[1])
	}
	if len(args) > 2 {
		limit, _ = strconv.ParseInt(args[2], 10, 64)
	}

	// The .tar holds the .txt.gz first, then small metadata files we don't need
	header, _, err := getRange(url, 0, 512)
	if err != nil {
		return err
	}
	name := strings.TrimRight(string(header[:100]), "\x00")
	size := tarSize(header[124:136])
	if !strings.HasSuffix(name, ".gz") || size <= 0 {
		return fmt.Errorf("unexpected first tar member %q (%d bytes)", name, size)
	}
	if limit > 0 && limit < size {
		size = limit
	}
	log.Printf("fetch: %s, %.1f GB, %d connections", name, float64(size)/1e9, conns)

	type result struct {
		data []byte
		err  error
	}
	chunks := int((size + chunkSize - 1) / chunkSize)
	// One buffered slot per chunk in flight; writing in order bounds memory to ~2×conns chunks
	slots := make(chan chan result, conns*2)
	go func() {
		sem := make(chan struct{}, conns)
		for i := range chunks {
			start := 512 + int64(i)*chunkSize
			n := min(chunkSize, size-int64(i)*chunkSize)
			slot := make(chan result, 1)
			slots <- slot
			sem <- struct{}{}
			go func() {
				defer func() { <-sem }()
				var r result
				for attempt := 1; attempt <= 10; attempt++ {
					var wait time.Duration
					if r.data, wait, r.err = getRange(url, start, n); r.err == nil {
						break
					}
					wait = max(wait, time.Duration(attempt)*30*time.Second)
					log.Printf("fetch: chunk %d attempt %d: %v (retrying in %s)", i, attempt, r.err, wait)
					time.Sleep(wait)
				}
				slot <- r
			}()
		}
		close(slots)
	}()

	began, written, nextLog := time.Now(), int64(0), int64(10e9)
	for slot := range slots {
		r := <-slot
		if r.err != nil {
			return r.err
		}
		if _, err := os.Stdout.Write(r.data); err != nil {
			return err
		}
		written += int64(len(r.data))
		if written >= nextLog {
			nextLog += 10e9
			log.Printf("fetch: %.0f GB, %.0f MB/s", float64(written)/1e9, float64(written)/1e6/time.Since(began).Seconds())
		}
	}
	log.Printf("fetch: done, %.1f GB in %s", float64(written)/1e9, time.Since(began).Round(time.Second))
	return nil
}

var client = &http.Client{Timeout: 30 * time.Minute}

// getRange returns the bytes, or an error plus how long the server asked us to wait (Retry-After).
func getRange(url string, start, n int64) ([]byte, time.Duration, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, start+n-1))
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent {
		secs, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
		return nil, time.Duration(secs) * time.Second, fmt.Errorf("range %d+%d: HTTP %d", start, n, resp.StatusCode)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		return nil, 0, err
	}
	return buf, 0, nil
}

// tarSize decodes a tar header size field: octal text, or base-256 binary for files over 8 GB.
func tarSize(field []byte) int64 {
	if field[0]&0x80 != 0 {
		var v int64
		for _, b := range field[1:] {
			v = v<<8 | int64(b)
		}
		return v
	}
	v, _ := strconv.ParseInt(strings.Trim(string(field), " \x00"), 8, 64)
	return v
}
