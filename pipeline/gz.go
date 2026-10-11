package main

import (
	"bufio"
	"errors"
	"io"
	"time"

	"ebdagg/flatex"
)

// countingReader counts every byte the decoder takes, so a checkpoint knows exactly where the
// compressed input should restart.
type countingReader struct {
	r *bufio.Reader
	n int64
}

func (c *countingReader) ReadByte() (byte, error) {
	b, err := c.r.ReadByte()
	if err == nil {
		c.n++
	}
	return b, err
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// gzStream decodes a (possibly multi-member) gzip stream and, once the deadline passes, pauses at
// the next deflate block boundary (Read then returns flatex.ErrPaused).
type gzStream struct {
	in       *countingReader
	dec      *flatex.Decompressor
	deadline time.Time
	done     bool
}

// newGzStream reads src, which starts offset bytes into the .gz; cp is nil at the very start.
func newGzStream(src io.Reader, offset int64, cp *flatex.Checkpoint, deadline time.Time) (*gzStream, error) {
	g := &gzStream{in: &countingReader{r: bufio.NewReaderSize(src, 1<<20), n: offset}, deadline: deadline}
	if cp != nil {
		g.dec = flatex.Resume(g.in, *cp)
		return g, nil
	}
	if err := g.header(); err != nil {
		return nil, err
	}
	g.dec = flatex.New(g.in)
	return g, nil
}

// header skips a gzip member header (RFC 1952).
func (g *gzStream) header() error {
	var h [10]byte
	if _, err := io.ReadFull(g.in, h[:]); err != nil {
		return err
	}
	if h[0] != 0x1f || h[1] != 0x8b || h[2] != 8 {
		return errors.New("not a gzip stream")
	}
	flags := h[3]
	if flags&4 != 0 { // FEXTRA
		var xl [2]byte
		if _, err := io.ReadFull(g.in, xl[:]); err != nil {
			return err
		}
		if _, err := io.CopyN(io.Discard, g.in, int64(xl[0])|int64(xl[1])<<8); err != nil {
			return err
		}
	}
	for _, bit := range []byte{8, 16} { // FNAME, FCOMMENT: zero-terminated
		if flags&bit != 0 {
			for {
				b, err := g.in.ReadByte()
				if err != nil {
					return err
				}
				if b == 0 {
					break
				}
			}
		}
	}
	if flags&2 != 0 { // FHCRC
		_, err := io.CopyN(io.Discard, g.in, 2)
		return err
	}
	return nil
}

func (g *gzStream) Read(p []byte) (int, error) {
	for {
		if g.done {
			return 0, io.EOF
		}
		if !g.deadline.IsZero() && time.Now().After(g.deadline) {
			g.dec.Pause()
		}
		n, err := g.dec.Read(p)
		if err != io.EOF {
			return n, err // data, a real error, or flatex.ErrPaused
		}
		// End of a member: skip its trailer (CRC-32, size), then start the next member if any
		if _, err := io.CopyN(io.Discard, g.in, 8); err != nil {
			return n, err
		}
		if _, err := g.in.r.Peek(1); err == io.EOF {
			g.done = true
		} else if err != nil {
			return n, err
		} else if err := g.header(); err != nil {
			return n, err
		} else {
			g.dec = flatex.New(g.in)
		}
		if n > 0 {
			return n, nil
		}
	}
}

// checkpoint returns where to restart in the .gz and the decoder state; valid after ErrPaused.
func (g *gzStream) checkpoint() (int64, flatex.Checkpoint) {
	return g.in.n, g.dec.Checkpoint()
}
