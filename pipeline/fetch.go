package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// eBird serves each connection at 3–10 MB/s and answers bursts of requests with HTTP 429, so the
// archive's .gz member is downloaded over two connections in large byte ranges (few requests),
// reassembled in order, with 429s retried after the delay eBird asks for.
const (
	chunkSize   = 256 << 20
	connections = 2
)

// member is the first file inside an EBD .tar: the .txt.gz we want, followed by small metadata files.
type member struct {
	url, name string
	size      int64 // bytes of the .gz
}

func tarMember(url string) (member, error) {
	header, _, err := getRange(url, 0, 512)
	if err != nil {
		return member{}, err
	}
	m := member{url: url, name: strings.TrimRight(string(header[:100]), "\x00"), size: tarSize(header[124:136])}
	if !strings.HasSuffix(m.name, ".gz") || m.size <= 0 {
		return m, fmt.Errorf("unexpected first tar member %q (%d bytes)", m.name, m.size)
	}
	return m, nil
}

// open streams the member's bytes [from, end) in order; end <= 0 means to the end of the member.
func (m member) open(from, end int64) io.ReadCloser {
	if end <= 0 || end > m.size {
		end = m.size
	}
	pr, pw := io.Pipe()
	type result struct {
		data []byte
		err  error
	}
	slots := make(chan chan result, connections*2)
	go func() {
		defer close(slots)
		sem := make(chan struct{}, connections)
		for start := from; start < end; start += chunkSize {
			n := min(chunkSize, end-start)
			slot := make(chan result, 1)
			slots <- slot
			sem <- struct{}{}
			go func(start int64) {
				defer func() { <-sem }()
				var r result
				for attempt := 1; attempt <= 10; attempt++ {
					var wait time.Duration
					if r.data, wait, r.err = getRange(m.url, 512+start, n); r.err == nil {
						break
					}
					wait = max(wait, time.Duration(attempt)*30*time.Second)
					log.Printf("fetch: range at %d attempt %d: %v (retrying in %s)", start, attempt, r.err, wait)
					time.Sleep(wait)
				}
				slot <- r
			}(start)
		}
	}()
	go func() {
		began, written, nextLog := time.Now(), int64(0), int64(10e9)
		for slot := range slots {
			r := <-slot
			if r.err != nil {
				pw.CloseWithError(r.err)
				return
			}
			if _, err := pw.Write(r.data); err != nil {
				return // reader closed (e.g. paused): stop
			}
			written += int64(len(r.data))
			if written >= nextLog {
				nextLog += 10e9
				log.Printf("fetch: %s at %.0f of %.0f GB, %.1f MB/s", m.name, float64(from+written)/1e9, float64(m.size)/1e9, float64(written)/1e6/time.Since(began).Seconds())
			}
		}
		pw.Close()
	}()
	return pr
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
