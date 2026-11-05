// Package levels defines CEFR learner levels. A higher level means the learner
// knows more words, so fewer annotations are produced.
package levels

import (
	_ "embed"
	"slices"
	"strings"
)

type Level struct {
	ID       string `json:"id"`
	Name     string `json:"name"`  // English name
	Label    string `json:"label"` // Chinese label
	Hint     string `json:"hint"`  // Chinese exam equivalent, shown in the UI
	Vocab    int    `json:"vocab"` // rough receptive vocabulary size
	Guidance string `json:"-"`     // what to gloss at this level; sent to the LLM
}

var All = []Level{
	{"A1", "Beginner", "A1 入门", "小学", 600,
		"Knows only the most basic everyday words (the, have, go, big, family, eat). " +
			"Gloss almost every content word beyond the ~600 most frequent words, " +
			"and any phrasal verb or set expression (look after, a lot of, in front of)."},
	{"A2", "Elementary", "A2 初级", "初中 / 中考", 1500,
		"Knows common everyday vocabulary (~1,500 words: weather, travel, school, buy, usually). " +
			"Gloss most words outside basic daily-life vocabulary, " +
			"and phrasal verbs and set expressions (run out of, take care of, on purpose)."},
	{"B1", "Intermediate", "B1 中级", "高中 / 高考", 3500,
		"Knows high-school vocabulary (~3,500 words: environment, government, improve, although). " +
			"Gloss words beyond high-school level and domain-specific terms, " +
			"and phrases whose meaning is not the plain sum of their words (take into account, by and large, make up for). " +
			"Skip the most basic phrases (a lot of, because of, as well as)."},
	{"B2", "Upper-intermediate", "B2 中高级", "四级 / 六级", 6000,
		"Knows CET-4/CET-6 vocabulary (~6,000 words: substantial, inevitable, comprehend, assess). " +
			"Gloss only less common, academic or specialised words. " +
			"For phrases, gloss only idioms and less common expressions (on the verge of, bear in mind, by and large); " +
			"everyday ones are known (make sense, in terms of, as well as, a number of, run out of, take into account). " +
			"Many paragraphs need only one or two items, and some need none."},
	{"C1", "Advanced", "C1 高级", "雅思 7 / 托福 100 / 考研", 9000,
		"Knows advanced vocabulary (~9,000 words), including ordinary news, academic and workplace language " +
			"(ubiquitous, mitigate, scrutiny, nuance). " +
			"Gloss only what a strong reader would have to look up: rare, literary or slang words, and specialist terms. " +
			"For phrases, gloss only idioms whose meaning can't be guessed from the words (a red herring, bite the bullet); " +
			"ordinary expressions are known (make sense, in terms of, by and large, on the verge of, take into account). " +
			"Most paragraphs need nothing, and a paragraph rarely needs more than two items."},
	{"C2", "Proficient", "C2 精通", "GRE / 专八", 14000,
		"Near-native vocabulary (~14,000 words). " +
			"Gloss only genuinely rare or obscure words, archaisms and jargon from outside general knowledge, " +
			"and idioms a strong non-native reader might miss. " +
			"Nearly all paragraphs need nothing."},
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

//go:embed words.txt
var wordsFile string

// knownFrom maps a word to the position in All of the lowest level that knows it.
var knownFrom = parseWords(wordsFile)

func parseWords(file string) map[string]int {
	words := map[string]int{}
	at := 0
	for line := range strings.Lines(file) {
		line = strings.TrimSpace(line)
		switch {
		case line == "" || line[0] == '#':
		case line[0] == '[':
			at = position(strings.Trim(line, "[]"))
		default:
			words[line] = at
		}
	}
	return words
}

func position(id string) int {
	return slices.IndexFunc(All, func(l Level) bool { return l.ID == id })
}

// Knows reports whether this level certainly knows a word, given in its dictionary
// form. It is deliberately cautious: a word it doesn't list can still be well known.
func (l Level) Knows(word string) bool {
	from, ok := knownFrom[strings.ToLower(strings.TrimSpace(word))]
	return ok && from <= position(l.ID)
}
