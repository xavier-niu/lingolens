// Package annotate turns English text segments into level-aware Chinese annotations.
//
// Flow: segments -> cache lookup -> chunks -> LLM JSON -> Align each item to exact
// offsets in its segment -> annotations the browser wraps in <ruby>.
package annotate

import (
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"

	"github.com/xavier-niu/lingolens/internal/levels"
	"github.com/xavier-niu/lingolens/internal/llm"
)

const (
	ChunkChars     = 1800
	MaxConcurrency = 4
)

type Segment struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

// Result is one streamed outcome: annotations for a segment, or an error for a chunk.
type Result struct {
	ID          string       `json:"id,omitempty"`
	Annotations []Annotation `json:"annotations,omitempty"`
	IDs         []string     `json:"ids,omitempty"`
	Error       string       `json:"error,omitempty"`
	Status      int          `json:"status,omitempty"`
}

// BuildChunks groups consecutive segments so each LLM call gets a reasonable amount of text.
func BuildChunks(segs []Segment, maxChars int) [][]Segment {
	var chunks [][]Segment
	var cur []Segment
	size := 0
	for _, s := range segs {
		if len(cur) > 0 && size+len(s.Text) > maxChars {
			chunks = append(chunks, cur)
			cur, size = nil, 0
		}
		cur = append(cur, s)
		size += len(s.Text)
	}
	if len(cur) > 0 {
		chunks = append(chunks, cur)
	}
	return chunks
}

// ---------------------------------------------------------------- cache

type lru struct {
	mu    sync.Mutex
	cap   int
	ll    *list.List
	items map[string]*list.Element
}

type entry struct {
	key string
	val []Annotation
}

func newLRU(capacity int) *lru {
	return &lru{cap: capacity, ll: list.New(), items: map[string]*list.Element{}}
}

func (c *lru) get(k string) ([]Annotation, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.items[k]; ok {
		c.ll.MoveToFront(e)
		return e.Value.(*entry).val, true
	}
	return nil, false
}

func (c *lru) set(k string, v []Annotation) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.items[k]; ok {
		e.Value.(*entry).val = v
		c.ll.MoveToFront(e)
		return
	}
	c.items[k] = c.ll.PushFront(&entry{k, v})
	for c.ll.Len() > c.cap {
		last := c.ll.Back()
		c.ll.Remove(last)
		delete(c.items, last.Value.(*entry).key)
	}
}

// ---------------------------------------------------------------- service

type Service struct {
	cache *lru

	mu      sync.Mutex
	entries map[string]*Entry // word lookups
}

func NewService() *Service {
	return &Service{cache: newLRU(20000), entries: map[string]*Entry{}}
}

func cacheKey(cfg llm.Config, lv levels.Level, text string) string {
	h := sha256.Sum256([]byte(strings.Join(
		[]string{PromptVersion, cfg.Kind, cfg.BaseURL, cfg.Model, lv.ID, text}, "\x1f")))
	return hex.EncodeToString(h[:])
}

func (s *Service) annotateChunk(ctx context.Context, client llm.Client, cfg llm.Config, lv levels.Level, chunk []Segment) (map[string][]Item, error) {
	if cfg.Kind == "fake" {
		out := map[string][]Item{}
		for _, seg := range chunk {
			out[seg.ID] = fakeItems(seg.Text, lv)
		}
		return out, nil
	}
	raw, err := client.CompleteJSON(ctx, SystemPrompt(lv), UserPrompt(chunk), Schema)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Segments []struct {
			ID    string `json:"id"`
			Items []Item `json:"items"`
		} `json:"segments"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &llm.Error{Msg: "The model returned JSON in an unexpected shape.", Status: http.StatusBadGateway}
	}
	out := make(map[string][]Item, len(resp.Segments))
	for _, sg := range resp.Segments {
		out[sg.ID] = dropKnown(sg.Items, lv)
	}
	return out, nil
}

// dropKnown removes single words this level certainly knows, so a simple word can't
// get a gloss however generous the model is. Phrases stay: easy words can make a
// hard phrase.
func dropKnown(items []Item, lv levels.Level) []Item {
	return slices.DeleteFunc(items, func(it Item) bool {
		if len(strings.Fields(it.Text)) != 1 {
			return false
		}
		lemma := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(it.Lemma)), "to ")
		return lv.Knows(it.Text) || lv.Knows(lemma)
	})
}

// Stream annotates segments and calls emit for each result, in completion order.
// emit is always called from the calling goroutine.
func (s *Service) Stream(ctx context.Context, client llm.Client, cfg llm.Config, lv levels.Level, segs []Segment, emit func(Result) error) error {
	var pending []Segment
	for _, seg := range segs {
		if strings.TrimSpace(seg.Text) == "" {
			continue
		}
		if anns, ok := s.cache.get(cacheKey(cfg, lv, seg.Text)); ok {
			if err := emit(Result{ID: seg.ID, Annotations: anns}); err != nil {
				return err
			}
			continue
		}
		pending = append(pending, seg)
	}
	if len(pending) == 0 {
		return nil
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	type chunkResult struct {
		chunk []Segment
		items map[string][]Item
		err   error
	}
	chunks := BuildChunks(pending, ChunkChars)
	results := make(chan chunkResult, len(chunks))
	sem := make(chan struct{}, MaxConcurrency)
	for _, c := range chunks {
		go func(chunk []Segment) {
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				results <- chunkResult{chunk: chunk, err: ctx.Err()}
				return
			}
			defer func() { <-sem }()
			items, err := s.annotateChunk(ctx, client, cfg, lv, chunk)
			results <- chunkResult{chunk, items, err}
		}(c)
	}

	for range chunks {
		r := <-results
		if r.err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			res := Result{Error: r.err.Error(), Status: http.StatusBadGateway}
			var le *llm.Error
			if errors.As(r.err, &le) {
				res.Status = le.Status
			}
			for _, seg := range r.chunk {
				res.IDs = append(res.IDs, seg.ID)
			}
			if err := emit(res); err != nil {
				return err
			}
			continue
		}
		for _, seg := range r.chunk {
			anns := Align(seg.Text, r.items[seg.ID])
			s.cache.set(cacheKey(cfg, lv, seg.Text), anns)
			if err := emit(Result{ID: seg.ID, Annotations: anns}); err != nil {
				return err
			}
		}
	}
	return nil
}
