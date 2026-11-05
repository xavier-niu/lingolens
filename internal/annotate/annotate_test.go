package annotate

import (
	"context"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/xavier-niu/lingolens/internal/levels"
	"github.com/xavier-niu/lingolens/internal/llm"
)

// js16 slices s by UTF-16 offsets, like JavaScript's String.prototype.slice.
func js16(s string, start, end int) string {
	u := utf16.Encode([]rune(s))
	return string(utf16.Decode(u[start:end]))
}

func TestAlignBasics(t *testing.T) {
	text := "We must take it into account. The art of starting is to start."
	got := Align(text, []Item{
		{Text: "take it into account", Kind: "phrase", Lemma: "take sth into account", ZH: "考虑"},
		{Text: "account", Kind: "word", ZH: "账户"},  // inside phrase -> dropped
		{Text: "art", Kind: "word", ZH: "艺术"},      // must not match inside "starting"
		{Text: "missing", Kind: "word", ZH: "不存在"}, // not in text -> dropped
		{Text: "start", Kind: "word", ZH: ""},      // empty gloss -> dropped
	})
	if len(got) != 2 {
		t.Fatalf("want 2 annotations, got %d: %+v", len(got), got)
	}
	if got[0].Text != "take it into account" || got[0].Kind != "phrase" {
		t.Errorf("phrase: %+v", got[0])
	}
	if got[1].Text != "art" || js16(text, got[1].Start, got[1].End) != "art" {
		t.Errorf("word: %+v", got[1])
	}
	if strings.Index(text, "art ") != got[1].Start {
		t.Errorf("art matched at wrong offset %d", got[1].Start)
	}
}

func TestAlignTolerance(t *testing.T) {
	text := "It doesn’t  make\nsense, and the well‑known COMPROMISE failed."
	got := Align(text, []Item{
		{Text: "doesn't", Kind: "word", ZH: "不"},
		{Text: "make sense", Kind: "phrase", ZH: "讲得通"},
		{Text: "well-known", Kind: "word", ZH: "著名的"},
		{Text: "compromise", Kind: "word", ZH: "妥协"},
	})
	if len(got) != 4 {
		t.Fatalf("want 4, got %d: %+v", len(got), got)
	}
	for _, a := range got {
		if js16(text, a.Start, a.End) != a.Text {
			t.Errorf("offset mismatch for %q: %q", a.Text, js16(text, a.Start, a.End))
		}
	}
	if got[1].Kind != "phrase" || got[1].Text != "make\nsense" {
		t.Errorf("phrase across whitespace: %+v", got[1])
	}
}

func TestAlignUTF16Offsets(t *testing.T) {
	text := "😀 Emoji précède the ubiquitous word."
	got := Align(text, []Item{{Text: "ubiquitous", Kind: "word", ZH: "无处不在的"}})
	if len(got) != 1 {
		t.Fatalf("got %+v", got)
	}
	if js16(text, got[0].Start, got[0].End) != "ubiquitous" {
		t.Fatalf("UTF-16 offsets wrong: %d..%d", got[0].Start, got[0].End)
	}
}

func TestAlignRepeatedWordsInOrder(t *testing.T) {
	text := "A bank by the river; a bank for money."
	got := Align(text, []Item{
		{Text: "bank", Kind: "word", ZH: "河岸"},
		{Text: "bank", Kind: "word", ZH: "银行"},
	})
	if len(got) != 2 || got[0].ZH != "河岸" || got[1].ZH != "银行" || got[0].Start >= got[1].Start {
		t.Fatalf("got %+v", got)
	}
}

func TestBuildChunks(t *testing.T) {
	segs := []Segment{{"a", strings.Repeat("x", 1000)}, {"b", strings.Repeat("x", 700)}, {"c", strings.Repeat("x", 500)}, {"d", "x"}}
	chunks := BuildChunks(segs, 1800)
	if len(chunks) != 2 || len(chunks[0]) != 2 || len(chunks[1]) != 2 {
		t.Fatalf("unexpected chunking: %v", chunks)
	}
}

func TestStreamFakeAndCache(t *testing.T) {
	svc := NewService()
	cfg := llm.Config{Kind: "fake"}
	client, err := llm.New(cfg, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	segs := []Segment{
		{"s0", "We should take into account the extraordinary circumstances."},
		{"s1", "   "},
		{"s2", "Nothing long here."},
	}
	run := func(lv string) map[string][]Annotation {
		out := map[string][]Annotation{}
		err := svc.Stream(context.Background(), client, cfg, levels.Get(lv), segs, func(r Result) error {
			if r.Error != "" {
				t.Fatalf("unexpected error: %s", r.Error)
			}
			out[r.ID] = r.Annotations
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	b1 := run("B1")
	if _, ok := b1["s1"]; ok {
		t.Error("blank segment should be skipped")
	}
	if len(b1["s0"]) < 2 {
		t.Errorf("expected phrase + long word at B1, got %+v", b1["s0"])
	}
	c2 := run("C2")
	if len(c2["s0"]) >= len(b1["s0"]) {
		t.Errorf("higher level should yield fewer annotations: B1=%d C2=%d", len(b1["s0"]), len(c2["s0"]))
	}
	if again := run("B1"); len(again["s0"]) != len(b1["s0"]) {
		t.Error("cached result differs")
	}
}

// stubLLM answers every completion with the same JSON.
type stubLLM struct{ answer string }

func (c stubLLM) CompleteJSON(context.Context, string, string, map[string]any) ([]byte, error) {
	return []byte(c.answer), nil
}

func (stubLLM) StreamChat(context.Context, string, []llm.Message, func(string) error) error {
	return nil
}

// However generous the model is, a word the level knows gets no gloss.
func TestStreamDropsWordsTheLevelKnows(t *testing.T) {
	text := "People took the simple table, and it made sense to the perfunctory clerk."
	client := stubLLM{`{"segments":[{"id":"s0","items":[
		{"text":"People","kind":"word","lemma":"people","pos":"n.","ipa":"","zh":"人们"},
		{"text":"took","kind":"word","lemma":"take","pos":"v.","ipa":"","zh":"拿"},
		{"text":"simple","kind":"word","lemma":"to simple","pos":"adj.","ipa":"","zh":"简单的"},
		{"text":"made sense","kind":"phrase","lemma":"make sense","pos":"phr.","ipa":"","zh":"讲得通"},
		{"text":"perfunctory","kind":"word","lemma":"perfunctory","pos":"adj.","ipa":"","zh":"敷衍的"}
	]}]}`}
	run := func(level string) []string {
		var got []string
		err := NewService().Stream(context.Background(), client, llm.Config{Kind: "stub"}, levels.Get(level),
			[]Segment{{"s0", text}}, func(r Result) error {
				for _, a := range r.Annotations {
					got = append(got, a.Text)
				}
				return nil
			})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	if got := strings.Join(run("C1"), ","); got != "made sense,perfunctory" {
		t.Errorf("C1 kept %q", got)
	}
	if got := run("A1"); len(got) != 3 { // "people" and "take" are known; "simple" isn't yet
		t.Errorf("A1 kept %q", got)
	}
}

func TestSystemPromptMentionsLevel(t *testing.T) {
	p := SystemPrompt(levels.Get("c1"))
	if !strings.Contains(p, "CEFR C1") || !strings.Contains(p, "phrase") {
		t.Fatal("prompt missing level or phrase instructions")
	}
}
