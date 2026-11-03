// Package levels defines CEFR learner levels. A higher level means the learner
// knows more words, so fewer annotations are produced.
package levels

import "strings"

type Level struct {
	ID       string `json:"id"`
	Name     string `json:"name"`  // English name
	Label    string `json:"label"` // Chinese label
	Hint     string `json:"hint"`  // Chinese exam equivalent, shown in the UI
	Vocab    int    `json:"vocab"` // rough receptive vocabulary size
	Guidance string `json:"-"`     // how aggressively to annotate; sent to the LLM
}

var All = []Level{
	{"A1", "Beginner", "A1 入门", "小学", 600,
		"Knows only the most basic everyday words (the, have, go, big, family, eat). " +
			"Annotate almost every content word beyond the ~600 most frequent words."},
	{"A2", "Elementary", "A2 初级", "初中 / 中考", 1500,
		"Knows common everyday vocabulary (~1,500 words: weather, travel, school, buy, usually). " +
			"Annotate most words outside basic daily-life vocabulary."},
	{"B1", "Intermediate", "B1 中级", "高中 / 高考", 3500,
		"Knows high-school vocabulary (~3,500 words: environment, government, improve, although). " +
			"Annotate words beyond high-school level and any domain-specific terms."},
	{"B2", "Upper-intermediate", "B2 中高级", "四级 / 六级", 6000,
		"Knows CET-4/CET-6 vocabulary (~6,000 words: substantial, inevitable, comprehend, assess). " +
			"Annotate only less common, academic, or specialised words."},
	{"C1", "Advanced", "C1 高级", "雅思 7 / 托福 100 / 考研", 9000,
		"Knows advanced vocabulary (~9,000 words: ubiquitous, mitigate, scrutiny, nuance). " +
			"Annotate only rare, literary, technical, or slang words, and words used in an unusual sense."},
	{"C2", "Proficient", "C2 精通", "GRE / 专八", 14000,
		"Near-native vocabulary. Annotate only genuinely rare or obscure words, jargon, archaisms, " +
			"and idioms whose meaning a strong non-native reader might miss."},
}

const Default = "B1"

// Get returns the level with the given ID, or the default level.
func Get(id string) Level {
	id = strings.ToUpper(strings.TrimSpace(id))
	for _, lv := range All {
		if lv.ID == id {
			return lv
		}
	}
	return Get(Default)
}
