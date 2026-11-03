package annotate

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/xavier-niu/lingolens/internal/levels"
	"github.com/xavier-niu/lingolens/internal/llm"
)

// Entry is a detailed, context-aware dictionary entry for one word or phrase,
// fetched on demand when the learner clicks a word.
type Entry struct {
	Lemma        string  `json:"lemma"`
	IPA          string  `json:"ipa"`
	POS          string  `json:"pos"`
	ZH           string  `json:"zh"`          // gloss for this context
	Explanation  string  `json:"explanation"` // usage note in Chinese
	Senses       []Sense `json:"senses"`
	Collocations []Pair  `json:"collocations"`
	Examples     []Pair  `json:"examples"`
}

type Sense struct {
	POS string `json:"pos"`
	ZH  string `json:"zh"`
	EN  string `json:"en"`
}

type Pair struct {
	EN string `json:"en"`
	ZH string `json:"zh"`
}

var pairSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"en": map[string]any{"type": "string"},
		"zh": map[string]any{"type": "string"},
	},
	"required":             []string{"en", "zh"},
	"additionalProperties": false,
}

var LookupSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"lemma":       map[string]any{"type": "string"},
		"ipa":         map[string]any{"type": "string"},
		"pos":         map[string]any{"type": "string"},
		"zh":          map[string]any{"type": "string"},
		"explanation": map[string]any{"type": "string"},
		"senses": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"pos": map[string]any{"type": "string"},
					"zh":  map[string]any{"type": "string"},
					"en":  map[string]any{"type": "string"},
				},
				"required":             []string{"pos", "zh", "en"},
				"additionalProperties": false,
			},
		},
		"collocations": map[string]any{"type": "array", "items": pairSchema},
		"examples":     map[string]any{"type": "array", "items": pairSchema},
	},
	"required":             []string{"lemma", "ipa", "pos", "zh", "explanation", "senses", "collocations", "examples"},
	"additionalProperties": false,
}

func lookupSystemPrompt(lv levels.Level) string {
	return fmt.Sprintf(`You are an English–Chinese learner's dictionary. The learner is a native Chinese speaker at CEFR %s (roughly %s).
Given a word or phrase and the sentence it appears in, return a concise, context-aware entry as JSON:
- "lemma": dictionary form ("ran" -> "run"; for phrases, the base form).
- "ipa": IPA of the lemma without slashes; empty string for multi-word phrases.
- "pos": part of speech in this sentence (n. / v. / adj. / adv. / prep. / conj. / phr. / idiom).
- "zh": the Simplified Chinese meaning in THIS sentence (2-10 characters).
- "explanation": 1-3 short sentences in Simplified Chinese on how it is used here (nuance, register, grammar pattern, or why it means this here). Pitch it at the learner's level.
- "senses": up to 3 other common senses, each {"pos", "zh", "en"} where "en" is a short English definition. Empty if there are none worth knowing.
- "collocations": up to 3 common collocations or set phrases with this word, each {"en", "zh"}.
- "examples": 2 natural example sentences at or slightly above the learner's level, each {"en", "zh"}.
Respond only with JSON.`, lv.ID, lv.Hint)
}

func lookupKey(cfg llm.Config, lv levels.Level, term, sentence string) string {
	return cacheKey(cfg, lv, "lookup\x1f"+strings.ToLower(term)+"\x1f"+sentence)
}

// Lookup returns a detailed entry for term as used in sentence.
func (s *Service) Lookup(ctx context.Context, client llm.Client, cfg llm.Config, lv levels.Level, term, sentence string) (*Entry, error) {
	key := lookupKey(cfg, lv, term, sentence)
	s.mu.Lock()
	cached, ok := s.entries[key]
	s.mu.Unlock()
	if ok {
		return cached, nil
	}

	var entry Entry
	if cfg.Kind == "fake" {
		entry = Entry{
			Lemma: strings.ToLower(term), POS: "n.", ZH: "〈" + term + "〉释义", IPA: "fæk",
			Explanation: "（开发用假模型）这里会显示该词在本句中的用法说明。",
			Senses:      []Sense{{POS: "v.", ZH: "另一义项", EN: "another sense"}},
			Examples:    []Pair{{EN: "This is an example with " + term + ".", ZH: "这是一个例句。"}},
		}
	} else {
		user, _ := json.Marshal(map[string]string{"term": term, "sentence": sentence})
		raw, err := client.CompleteJSON(ctx, lookupSystemPrompt(lv), string(user), LookupSchema)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &entry); err != nil || strings.TrimSpace(entry.ZH) == "" {
			return nil, &llm.Error{Msg: "The model returned an unexpected dictionary entry.", Status: http.StatusBadGateway}
		}
	}
	entry.IPA = strings.Trim(strings.TrimSpace(entry.IPA), "/[]")
	if entry.Lemma == "" {
		entry.Lemma = term
	}

	s.mu.Lock()
	if len(s.entries) > 20000 {
		clear(s.entries) // crude bound; lookups are cheap to redo
	}
	s.entries[key] = &entry
	s.mu.Unlock()
	return &entry, nil
}
