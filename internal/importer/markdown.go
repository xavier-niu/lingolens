// Package importer turns web pages and EPUB books into Markdown texts for the shelf.
package importer

import (
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// ToMarkdown converts an HTML subtree into the Markdown subset the reader renders:
// headings, paragraphs, lists, quotes, code, emphasis and line breaks. Links keep
// their text only (the reader is for reading, and links would fight word clicks),
// and images, scripts and page furniture are dropped.
func ToMarkdown(n *html.Node) string {
	var c converter
	c.blocks(n, 0)
	return strings.Join(c.out, "\n\n")
}

type converter struct {
	out []string
}

// Elements whose content never belongs in the text.
var skipped = map[atom.Atom]bool{
	atom.Script: true, atom.Style: true, atom.Noscript: true, atom.Template: true,
	atom.Head: true, atom.Nav: true, atom.Button: true, atom.Form: true, atom.Input: true,
	atom.Select: true, atom.Textarea: true, atom.Svg: true, atom.Math: true, atom.Img: true,
	atom.Picture: true, atom.Video: true, atom.Audio: true, atom.Iframe: true, atom.Object: true,
	atom.Canvas: true, atom.Rt: true, atom.Rp: true,
}

var blockTags = map[atom.Atom]bool{
	atom.P: true, atom.Div: true, atom.Section: true, atom.Article: true, atom.Main: true,
	atom.Body: true, atom.Header: true, atom.Footer: true, atom.Aside: true, atom.Figure: true,
	atom.Figcaption: true, atom.Blockquote: true, atom.Pre: true, atom.Ul: true, atom.Ol: true,
	atom.Li: true, atom.Dl: true, atom.Dt: true, atom.Dd: true, atom.Table: true, atom.Thead: true,
	atom.Tbody: true, atom.Tfoot: true, atom.Tr: true, atom.Hr: true, atom.Address: true,
	atom.Details: true, atom.Summary: true, atom.Center: true, atom.Html: true,
	atom.H1: true, atom.H2: true, atom.H3: true, atom.H4: true, atom.H5: true, atom.H6: true,
}

func isBlock(n *html.Node) bool {
	return n.Type == html.ElementNode && (blockTags[n.DataAtom] || n.Data == "hgroup")
}

func hasBlockChild(n *html.Node) bool {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if isBlock(c) {
			return true
		}
	}
	return false
}

func (c *converter) add(block string) {
	if strings.TrimSpace(block) != "" {
		c.out = append(c.out, block)
	}
}

// blocks walks block-level content; runs of inline content become paragraphs.
func (c *converter) blocks(n *html.Node, depth int) {
	if depth > 200 { // pathological nesting
		return
	}
	var run []*html.Node
	flush := func() {
		if len(run) > 0 {
			c.add(paragraph(inlineNodes(run)))
			run = run[:0]
		}
	}
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		if ch.Type == html.ElementNode && skipped[ch.DataAtom] {
			continue
		}
		if !isBlock(ch) {
			if ch.Type == html.TextNode || ch.Type == html.ElementNode {
				run = append(run, ch)
			}
			continue
		}
		flush()
		c.block(ch, depth+1)
	}
	flush()
}

func (c *converter) block(n *html.Node, depth int) {
	switch n.DataAtom {
	case atom.H1, atom.H2, atom.H3, atom.H4, atom.H5, atom.H6:
		if text := oneLine(inline(n)); text != "" {
			level := int(n.Data[1] - '0')
			c.add(strings.Repeat("#", level) + " " + text)
		}
	case atom.P, atom.Dt, atom.Dd, atom.Figcaption, atom.Summary, atom.Address:
		if hasBlockChild(n) {
			c.blocks(n, depth)
		} else {
			c.add(paragraph(inline(n)))
		}
	case atom.Hr:
		c.add("---")
	case atom.Pre:
		code := strings.Trim(textContent(n), "\n")
		if strings.TrimSpace(code) != "" {
			fence := "```"
			for strings.Contains(code, fence) {
				fence += "`"
			}
			c.add(fence + "\n" + code + "\n" + fence)
		}
	case atom.Ul, atom.Ol:
		c.add(strings.Join(listLines(n, 0), "\n"))
	case atom.Blockquote:
		var inner converter
		inner.blocks(n, depth)
		if len(inner.out) > 0 {
			quoted := strings.Join(inner.out, "\n\n")
			lines := strings.Split(quoted, "\n")
			for i, l := range lines {
				if l == "" {
					lines[i] = ">"
				} else {
					lines[i] = "> " + l
				}
			}
			c.add(strings.Join(lines, "\n"))
		}
	case atom.Table:
		c.table(n)
	default: // containers
		c.blocks(n, depth)
	}
}

// Tables become one paragraph per row, cells separated by " · ": readable prose
// rather than a grid that wouldn't fit a phone.
func (c *converter) table(n *html.Node) {
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			if ch.Type != html.ElementNode {
				continue
			}
			if ch.DataAtom == atom.Tr {
				var cells []string
				for td := ch.FirstChild; td != nil; td = td.NextSibling {
					if td.Type == html.ElementNode && (td.DataAtom == atom.Td || td.DataAtom == atom.Th) {
						if s := oneLine(inline(td)); s != "" {
							cells = append(cells, s)
						}
					}
				}
				c.add(escapeLeading(strings.Join(cells, " · ")))
				continue
			}
			walk(ch)
		}
	}
	walk(n)
}

func listLines(list *html.Node, depth int) []string {
	var lines []string
	indent := strings.Repeat("   ", depth)
	num := 1
	for li := list.FirstChild; li != nil; li = li.NextSibling {
		if li.Type != html.ElementNode || li.DataAtom != atom.Li {
			continue
		}
		marker := "- "
		if list.DataAtom == atom.Ol {
			marker = strconv.Itoa(num) + ". "
			num++
		}
		// The item's own text, then any nested lists.
		var own []*html.Node
		var nested []*html.Node
		for ch := li.FirstChild; ch != nil; ch = ch.NextSibling {
			if ch.Type == html.ElementNode && (ch.DataAtom == atom.Ul || ch.DataAtom == atom.Ol) {
				nested = append(nested, ch)
			} else {
				own = append(own, ch)
			}
		}
		text := oneLine(inlineNodes(own))
		if text != "" {
			lines = append(lines, indent+marker+escapeLeading(text))
		}
		for _, sub := range nested {
			lines = append(lines, listLines(sub, depth+1)...)
		}
	}
	return lines
}

// ---------------------------------------------------------------- inline

const hardBreak = "\x00br\x00"

func inline(n *html.Node) string {
	var nodes []*html.Node
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		nodes = append(nodes, ch)
	}
	return inlineNodes(nodes)
}

func inlineNodes(nodes []*html.Node) string {
	var b strings.Builder
	for _, n := range nodes {
		writeInline(&b, n)
	}
	return b.String()
}

var spaceRe = regexp.MustCompile(`[ \t\r\n\f\v\x{00a0}]+`)

func writeInline(b *strings.Builder, n *html.Node) {
	switch n.Type {
	case html.TextNode:
		b.WriteString(escapeText(spaceRe.ReplaceAllString(n.Data, " ")))
		return
	case html.ElementNode:
	default:
		return
	}
	if skipped[n.DataAtom] {
		return
	}
	switch n.DataAtom {
	case atom.Br:
		b.WriteString(hardBreak)
	case atom.Em, atom.I, atom.Cite, atom.Dfn, atom.Var:
		b.WriteString(wrap(inline(n), "*"))
	case atom.Strong, atom.B:
		b.WriteString(wrap(inline(n), "**"))
	case atom.Code, atom.Kbd, atom.Samp, atom.Tt:
		code := spaceRe.ReplaceAllString(textContent(n), " ")
		if strings.TrimSpace(code) != "" {
			tick := "`"
			if strings.Contains(code, "`") {
				tick = "``"
				code = " " + code + " "
			}
			b.WriteString(tick + code + tick)
		}
	case atom.Sup:
		// Footnote markers ("¹", "[3]", linked numbers) are noise in running text.
		t := strings.Trim(strings.TrimSpace(textContent(n)), "[]()*†‡")
		if t == "" || isDigits(t) || findLink(n) {
			return
		}
		b.WriteString(inline(n))
	default: // a, span, small, mark, abbr, u, s, q, …: keep the text
		if n.DataAtom == atom.Q {
			b.WriteString("“" + inline(n) + "”")
			return
		}
		b.WriteString(inline(n))
	}
}

func wrap(s, mark string) string {
	t := strings.TrimSpace(s)
	if t == "" || strings.Trim(t, hardBreak) == "" {
		return s
	}
	lead, trail := "", ""
	if strings.HasPrefix(s, " ") {
		lead = " "
	}
	if strings.HasSuffix(s, " ") {
		trail = " "
	}
	return lead + mark + t + mark + trail
}

// paragraph tidies inline output into one Markdown paragraph.
func paragraph(s string) string {
	parts := strings.Split(s, hardBreak)
	var lines []string
	for _, p := range parts {
		p = strings.TrimSpace(spaceRe.ReplaceAllString(p, " "))
		if p != "" {
			lines = append(lines, p)
		}
	}
	if len(lines) == 0 {
		return ""
	}
	for i := range lines {
		lines[i] = escapeLeading(lines[i])
	}
	return strings.Join(lines, "\\\n") // a backslash at line end is a hard break
}

func oneLine(s string) string {
	return strings.TrimSpace(spaceRe.ReplaceAllString(strings.ReplaceAll(s, hardBreak, " "), " "))
}

var mdSpecial = strings.NewReplacer(`\`, `\\`, "*", `\*`, "_", `\_`, "`", "\\`", "[", `\[`, "]", `\]`, "<", `\<`)

func escapeText(s string) string { return mdSpecial.Replace(s) }

var leadingMarker = regexp.MustCompile(`^(#{1,6}\s|>|[-+]\s|={3,}|-{3,}|\d+[.)]\s)`)

// escapeLeading stops prose that happens to start like Markdown ("1984. The year…",
// "- quoted") from turning into a list or heading.
func escapeLeading(s string) string {
	if m := leadingMarker.FindStringIndex(s); m != nil {
		if i := strings.IndexAny(s, ".)"); i > 0 && i < m[1] && isDigits(s[:i]) {
			return s[:i] + `\` + s[i:]
		}
		return `\` + s
	}
	return s
}

func textContent(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		if n.Type == html.ElementNode && (n.DataAtom == atom.Script || n.DataAtom == atom.Style) {
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		if n.Type == html.ElementNode && n.DataAtom == atom.Br {
			b.WriteString("\n")
		}
	}
	walk(n)
	return b.String()
}

func findLink(n *html.Node) bool {
	if n.Type == html.ElementNode && n.DataAtom == atom.A {
		return true
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if findLink(c) {
			return true
		}
	}
	return false
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
