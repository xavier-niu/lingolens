package annotate

import (
	"encoding/json"
	"fmt"

	"github.com/xavier-niu/lingolens/internal/levels"
)

// PromptVersion is part of the cache key; bump it when prompts change.
const PromptVersion = "v1"

// Schema is the structured-output schema for annotation responses.
var Schema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"segments": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"id": map[string]any{"type": "string"},
					"items": map[string]any{
						"type": "array",
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"text":  map[string]any{"type": "string"},
								"kind":  map[string]any{"type": "string", "enum": []string{"word", "phrase"}},
								"lemma": map[string]any{"type": "string"},
								"pos":   map[string]any{"type": "string"},
								"ipa":   map[string]any{"type": "string"},
								"zh":    map[string]any{"type": "string"},
							},
							"required":             []string{"text", "kind", "lemma", "pos", "ipa", "zh"},
							"additionalProperties": false,
						},
					},
				},
				"required":             []string{"id", "items"},
				"additionalProperties": false,
			},
		},
	},
	"required":             []string{"segments"},
	"additionalProperties": false,
}

func SystemPrompt(lv levels.Level) string {
	return fmt.Sprintf(`You annotate English reading material for a native Chinese speaker who is learning English.
Learner level: CEFR %s (roughly %s, ~%d known words).
%s

For every segment, list the items the learner should see a Chinese gloss for:
1. kind "word": single words likely unknown at this level. Skip words well inside the level, proper names (unless the name itself needs explaining), numbers, and easy derivatives of very common words.
2. kind "phrase": fixed collocations, phrasal verbs, idioms and set expressions whose meaning is not the plain sum of the words, or that are worth learning as a unit at this level (e.g. "take into account", "in terms of", "run out of", "make sense", "by and large"). Include these even when each word is easy. The higher the level, the fewer and more idiomatic the phrases.

Rules:
- "text" must be copied exactly from the segment (same spelling, inflection and capitalisation). A phrase must be one contiguous span of at most 6 words; if an object splits a phrasal verb, include the object in the span ("take it into account").
- Items must not overlap. If a word is part of an annotated phrase, do not list it separately.
- Annotate only the first occurrence of an item within a segment. List items in order of appearance.
- "zh": a concise Simplified Chinese gloss for the meaning in THIS context (usually 2-8 characters; no pinyin, no explanation).
- "lemma": dictionary form ("mitigated" -> "mitigate"; for phrases the base form, e.g. "take sth into account").
- "pos": short part of speech: n. / v. / adj. / adv. / prep. / conj. / phr. / idiom.
- "ipa": IPA of the dictionary form for single words, without slashes (e.g. "ˈmɪtɪɡeɪt"); empty string for phrases.
- Return every segment id you were given, with an empty "items" list if nothing needs annotation.

Respond only with JSON of the form:
{"segments": [{"id": "...", "items": [{"text": "...", "kind": "word", "lemma": "...", "pos": "...", "ipa": "...", "zh": "..."}]}]}`,
		lv.ID, lv.Hint, lv.Vocab, lv.Guidance)
}

func UserPrompt(segs []Segment) string {
	b, _ := json.MarshalIndent(segs, "", " ")
	return "Segments:\n" + string(b)
}
