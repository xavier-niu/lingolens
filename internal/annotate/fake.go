package annotate

import (
	"regexp"
	"strings"

	"github.com/xavier-niu/lingolens/internal/levels"
)

// fakeItems is an offline stand-in for the LLM (LINGOLENS_DEV_FAKE=1). It does not
// translate: it marks long words and a few collocations so the UI can be exercised.

var fakePhrases = []struct{ en, zh string }{
	{"in terms of", "就……而言"},
	{"take into account", "考虑到"},
	{"as well as", "以及"},
	{"run out of", "用完"},
	{"make sense", "讲得通"},
	{"by and large", "总的来说"},
	{"a number of", "许多"},
}

// Higher level -> only longer words are "unknown".
var fakeMinLen = map[string]int{"A1": 5, "A2": 6, "B1": 8, "B2": 10, "C1": 12, "C2": 14}

var wordRe = regexp.MustCompile(`[A-Za-z]+`)

func fakeItems(text string, lv levels.Level) []Item {
	var items []Item
	lower := strings.ToLower(text)
	for _, p := range fakePhrases {
		if i := strings.Index(lower, p.en); i >= 0 {
			items = append(items, Item{Text: text[i : i+len(p.en)], Kind: "phrase", Lemma: p.en, POS: "phr.", ZH: p.zh})
		}
	}
	seen := map[string]bool{}
	for _, w := range wordRe.FindAllString(text, -1) {
		lw := strings.ToLower(w)
		if len(w) >= fakeMinLen[lv.ID] && !seen[lw] {
			seen[lw] = true
			items = append(items, Item{Text: w, Kind: "word", Lemma: lw, POS: "n.", IPA: "fæk", ZH: "〈" + lw[:3] + "〉释义"})
		}
	}
	return items
}
