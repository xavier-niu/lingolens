package server

import (
	"fmt"
	"strings"

	"github.com/xavier-niu/lingolens/internal/levels"
)

// ChatSystemPrompt frames a tutor conversation: about a selection in the passage
// being read (Ask AI), or, with no passage, about text the learner pasted (Chat).
func ChatSystemPrompt(lv levels.Level, passage, selection string) string {
	context := fmt.Sprintf(`The learner is reading the passage below and has selected part of it to ask about.

<passage>
%s
</passage>

<selection>
%s
</selection>`, passage, selection)
	ground := `- Ground every answer in how the selection is used in this passage.
- If the question is open-ended, cover: what the selection means here, a natural Chinese translation, key words and collocations (with brief glosses), and any grammar point worth noticing.`
	if pasted(passage) {
		context = fmt.Sprintf(`The learner has pasted the text below to talk about. It may be something they are reading or something they wrote.

<text>
%s
</text>`, selection)
		ground = `- Ground every answer in this text.
- If the question is open-ended, cover: what the text means, a natural Chinese translation, key words and collocations (with brief glosses), and any grammar point worth noticing.
- When asked to check the grammar, list each mistake with its correction and a short reason, then give the corrected text in full. If there are no mistakes, say so, and suggest more natural wording only where it clearly helps.`
	}
	return fmt.Sprintf(`You are a patient, precise English tutor for a native Chinese speaker.
Learner level: CEFR %s (roughly %s, ~%d known words). Explain vocabulary and grammar above this level; don't belabour what they already know.

%s

How to answer:
- Write explanations in Simplified Chinese. Keep English words, phrases and example sentences in English.
%s
- Be concise and well structured: short paragraphs or lists in Markdown, bold for key terms. No filler.
- When giving example sentences, keep them at or slightly above the learner's level.`,
		lv.ID, lv.Hint, lv.Vocab, context, ground)
}

// pasted reports whether a chat is about pasted text (Chat) rather than a
// selection in a text being read (Ask AI): there is no passage around it.
func pasted(passage string) bool { return strings.TrimSpace(passage) == "" }

// maxSelection is how long the text a chat is about may be. Pasted text has no
// passage around it, so it may be as long as one.
func maxSelection(passage string) int {
	if pasted(passage) {
		return maxPassageChars
	}
	return maxSelectionChar
}
