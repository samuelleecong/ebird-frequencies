package flatex

import "errors"

// ErrPaused is returned by Read once a requested Pause reaches a block boundary.
// Everything decoded before the boundary has been returned by then.
var ErrPaused = errors.New("flatex: paused at a block boundary")

// Checkpoint is all the state needed to carry on decoding from a block boundary.
type Checkpoint struct {
	Consumed int64  // input bytes this reader consumed (the bits below came from them)
	Bits     uint32 // input bits read but not yet used
	NBits    uint
	Window   []byte // the last (up to) 32 KB of output, which later blocks can refer back to
}

// Decompressor is the stdlib decompressor plus Pause, Checkpoint and Resume.
type Decompressor = decompressor

// New starts decoding a raw DEFLATE stream from r.
func New(r Reader) *Decompressor {
	fixedHuffmanDecoderInit()
	f := &decompressor{r: r, step: (*decompressor).nextBlock}
	f.bits = new([maxNumLit + maxNumDist]int)
	f.codebits = new([numCodes]int)
	f.dict.init(maxMatchOffset, nil)
	return f
}

// Resume carries on from cp; r must be positioned cp.Consumed bytes after where the paused reader started.
func Resume(r Reader, cp Checkpoint) *Decompressor {
	f := New(r)
	f.dict.init(maxMatchOffset, cp.Window)
	f.b, f.nb = cp.Bits, cp.NBits
	return f
}

// Pause asks Read to stop with ErrPaused at the next block boundary.
func (f *decompressor) Pause() { f.pause = true }

// Checkpoint returns the state after Read has returned ErrPaused.
func (f *decompressor) Checkpoint() Checkpoint {
	dd := &f.dict
	var w []byte
	if dd.full {
		w = append(append(w, dd.hist[dd.wrPos:]...), dd.hist[:dd.wrPos]...)
	} else {
		w = append(w, dd.hist[:dd.wrPos]...)
	}
	return Checkpoint{Consumed: f.roffset, Bits: f.b, NBits: f.nb, Window: w}
}
