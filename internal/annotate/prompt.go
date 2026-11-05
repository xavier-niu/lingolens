package annotate

import (
	"encoding/json"
	"fmt"

	"github.com/xavier-niu/lingolens/internal/levels"
)

// PromptVersion names the rules glosses are made by. It is part of the cache key
// and browsers drop glosses saved under another one (see gloss_version in
// /api/config), so bump it when the prompt or levels/words.txt change.
const PromptVersion = "v2"

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

A gloss interrupts reading, so add one only where this reader would otherwise have to stop and look something up. When in doubt, leave it out. An empty list is a good answer, and the higher the level, the more often it is the right one.

For every segment, list the items the learner should see a Chinese gloss for:
1. kind "word": single words this reader probably doesn't know. Skip anything well inside the level, proper names (unless the name itself needs explaining), numbers, and easy derivatives or compounds of words they know (carefully, unfriendly, long-term).
2. kind "phrase": phrasal verbs, idioms and set expressions whose meaning this reader can't get from the words. Follow the guidance above on how common a phrase may be.

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
