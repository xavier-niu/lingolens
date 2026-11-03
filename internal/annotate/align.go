package annotate

import (
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// Item is one annotation as returned by the LLM (unverified).
type Item struct {
	Text  string `json:"text"`
	Kind  string `json:"kind"`
	Lemma string `json:"lemma"`
	POS   string `json:"pos"`
	IPA   string `json:"ipa"`
	ZH    string `json:"zh"`
}

// Annotation is an Item located in its segment. Start/End are UTF-16 offsets,
// matching JavaScript string indexing in the browser.
type Annotation struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Text  string `json:"text"`
	Kind  string `json:"kind"`
	Lemma string `json:"lemma"`
	POS   string `json:"pos,omitempty"`
	IPA   string `json:"ipa,omitempty"`
	ZH    string `json:"zh"`
}

// needlePattern builds a regexp for needle that tolerates whitespace runs and
// quote/dash variants. Word boundaries are checked separately (RE2 has no lookbehind).
func needlePattern(needle string) string {
	var b strings.Builder
	lastSpace := false
	for _, r := range strings.TrimSpace(needle) {
		switch {
		case unicode.IsSpace(r):
			if !lastSpace {
				b.WriteString(`\s+`)
			}
			lastSpace = true
			continue
		case strings.ContainsRune("'’‘", r):
			b.WriteString(`['’‘]`)
		case strings.ContainsRune("-‐‑–", r):
			b.WriteString(`[-‐‑–]`)
		default:
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
		lastSpace = false
	}
	return b.String()
}

func isWordRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }

func onBoundary(text string, start, end int) bool {
	if start > 0 {
		if r, _ := utf8.DecodeLastRuneInString(text[:start]); isWordRune(r) {
			return false
		}
	}
	if end < len(text) {
		if r, _ := utf8.DecodeRuneInString(text[end:]); isWordRune(r) {
			return false
		}
	}
	return true
}

// utf16Offsets maps byte offsets (at rune boundaries) to UTF-16 code-unit offsets.
func utf16Offsets(text string) map[int]int {
	out := make(map[int]int, len(text)+1)
	n := 0
	for i, r := range text {
		out[i] = n
		n += utf16.RuneLen(r)
	}
	out[len(text)] = n
	return out
}

type span struct {
	start, end int
	item       Item
}

// Align locates each item in text, dropping items that cannot be found or that
// overlap an earlier one. Phrases are placed before words so a phrase wins over
// a word inside it.
func Align(text string, items []Item) []Annotation {
	var spans []span
	overlaps := func(s, e int) bool {
		for _, sp := range spans {
			if s < sp.end && sp.start < e {
				return true
			}
		}
		return false
	}

	ordered := make([]Item, 0, len(items))
	for _, it := range items {
		if it.Kind == "phrase" {
			ordered = append(ordered, it)
		}
	}
	for _, it := range items {
		if it.Kind != "phrase" {
			ordered = append(ordered, it)
		}
	}

	cursor := map[string]int{"phrase": 0, "word": 0}
	for _, it := range ordered {
		needle := strings.TrimSpace(it.Text)
		zh := strings.TrimSpace(it.ZH)
		if needle == "" || zh == "" || len(needle) > 80 {
			continue
		}
		kind := "word"
		if it.Kind == "phrase" || strings.ContainsFunc(needle, unicode.IsSpace) {
			kind = "phrase"
		}
		pat := needlePattern(needle)
		var found []int
		for _, prefix := range []string{"", "(?i)"} {
			rx, err := regexp.Compile(prefix + pat)
			if err != nil {
				break
			}
			matches := rx.FindAllStringIndex(text, -1)
			// Prefer the first free match after the previous item of this kind
			// (items arrive in reading order); otherwise take any free match.
			pick := func(after int) []int {
				for _, m := range matches {
					if m[0] >= after && onBoundary(text, m[0], m[1]) && !overlaps(m[0], m[1]) {
						return m
					}
				}
				return nil
			}
			if found = pick(cursor[kind]); found == nil {
				found = pick(0)
			}
			if found != nil {
				break
			}
		}
		if found == nil {
			continue
		}
		cursor[kind] = found[1]
		lemma := strings.TrimSpace(it.Lemma)
		if lemma == "" {
			lemma = needle
		}
		spans = append(spans, span{found[0], found[1], Item{
			Kind:  kind,
			Lemma: lemma,
			POS:   strings.TrimSpace(it.POS),
			IPA:   strings.Trim(strings.TrimSpace(it.IPA), "/[]"),
			ZH:    zh,
		}})
	}

	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	u16 := utf16Offsets(text)
	out := make([]Annotation, 0, len(spans))
	for _, sp := range spans {
		out = append(out, Annotation{
			Start: u16[sp.start], End: u16[sp.end], Text: text[sp.start:sp.end],
			Kind: sp.item.Kind, Lemma: sp.item.Lemma, POS: sp.item.POS, IPA: sp.item.IPA, ZH: sp.item.ZH,
		})
	}
	return out
}
