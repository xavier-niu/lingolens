// Package importer turns web pages and EPUB books into Markdown texts for the shelf.
package importer

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// ToMarkdown converts an HTML subtree into the Markdown subset the reader renders:
// headings, paragraphs, lists, quotes, code, emphasis and line breaks. Links keep
// their text only (the reader is for reading, and links would fight word clicks),
// and scripts and page furniture are dropped. So are images, except emoji drawn
// as images, which keep their text; pageMarkdown also keeps a page's pictures.
func ToMarkdown(n *html.Node) string { return convert(n, nil) }

// pageMarkdown is ToMarkdown for a web page at page, keeping its pictures
// (photos, charts, diagrams) as <img> lines that load them from where they are.
// An <img> keeps the picture's size, which Markdown's ![alt](src) can't, so the
// text doesn't move while pictures load and a saved place still lands right.
func pageMarkdown(n *html.Node, page *url.URL) string { return convert(n, page) }

func convert(n *html.Node, page *url.URL) string {
	c := converter{page: page}
	c.blocks(n, 0)
	return strings.Join(c.out, "\n\n")
}

type converter struct {
	out  []string
	page *url.URL  // where the text came from; nil drops pictures
	pics []picture // pictures met in inline content, marked there by picMark
}

type picture struct {
	line      string // the <img> line
	sized     bool   // the page says how large it is
	described bool   // its alt text describes it, in a few words at least
}

// Elements whose content never belongs in the text.
var skipped = map[atom.Atom]bool{
	atom.Script: true, atom.Style: true, atom.Noscript: true, atom.Template: true,
	atom.Head: true, atom.Nav: true, atom.Button: true, atom.Form: true, atom.Input: true,
	atom.Select: true, atom.Textarea: true, atom.Svg: true, atom.Math: true,
	atom.Video: true, atom.Audio: true, atom.Iframe: true, atom.Object: true,
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

// holdsBlock reports whether an element has blocks inside, as a link around a
// card's <div>s or a <picture> holding its <figcaption> does. Such an element
// is walked as a container, so its blocks stay apart.
func holdsBlock(n *html.Node) bool {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && !skipped[c.DataAtom] && (isBlock(c) || holdsBlock(c)) {
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
			c.para(c.inlineNodes(run))
			run = run[:0]
		}
	}
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		if ch.Type == html.ElementNode && skipped[ch.DataAtom] {
			continue
		}
		if !isBlock(ch) && (ch.Type != html.ElementNode || !holdsBlock(ch)) {
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
		if text := oneLine(c.inline(n)); text != "" {
			level := int(n.Data[1] - '0')
			c.add(strings.Repeat("#", level) + " " + text)
		}
	case atom.P, atom.Dt, atom.Dd, atom.Figcaption, atom.Summary, atom.Address:
		if hasBlockChild(n) {
			c.blocks(n, depth)
		} else {
			c.para(c.inline(n))
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
		c.add(strings.Join(c.listLines(n, 0), "\n"))
	case atom.Blockquote:
		inner := converter{page: c.page}
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
// rather than a grid that wouldn't fit a phone. A row's pictures follow it.
func (c *converter) table(n *html.Node) {
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			if ch.Type != html.ElementNode {
				continue
			}
			if ch.DataAtom == atom.Tr {
				var cells []string
				var pics []picture
				for td := ch.FirstChild; td != nil; td = td.NextSibling {
					if td.Type == html.ElementNode && (td.DataAtom == atom.Td || td.DataAtom == atom.Th) {
						s := c.inline(td)
						pics = append(pics, c.picsIn(s)...)
						if s := oneLine(s); s != "" {
							cells = append(cells, s)
						}
					}
				}
				c.add(escapeLeading(strings.Join(cells, " · ")))
				for _, p := range pics {
					if p.keep(len(cells) > 0) {
						c.add(p.line)
					}
				}
				continue
			}
			walk(ch)
		}
	}
	walk(n)
}

func (c *converter) listLines(list *html.Node, depth int) []string {
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
		// Its pictures stay in it, after its text on the same line: an <img>
		// alone on a line would start an HTML block, which runs to the next
		// blank line and so would swallow a nested list.
		s := c.inlineNodes(own)
		text := oneLine(s)
		var parts []string
		if text != "" {
			parts = append(parts, escapeLeading(text))
		}
		for _, p := range c.picsIn(s) {
			if p.keep(text != "") {
				parts = append(parts, p.line)
			}
		}
		if len(parts) > 0 {
			lines = append(lines, indent+marker+strings.Join(parts, " "))
			if text == "" && len(parts) == 1 && len(nested) > 0 {
				lines = append(lines, "") // the lone <img> did start one: end it
			}
		}
		for _, sub := range nested {
			lines = append(lines, c.listLines(sub, depth+1)...)
		}
	}
	return lines
}

// ---------------------------------------------------------------- inline

// Inline content marks line breaks and pictures with NULs, which parsed HTML
// never has: a picture's mark is picMark, its index in c.pics, and a NUL.
const (
	hardBreak = "\x00br\x00"
	picMark   = "\x00pic"
)

var picRe = regexp.MustCompile(`\x00pic(\d+)\x00`)

func (c *converter) inline(n *html.Node) string {
	var nodes []*html.Node
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		nodes = append(nodes, ch)
	}
	return c.inlineNodes(nodes)
}

func (c *converter) inlineNodes(nodes []*html.Node) string {
	var b strings.Builder
	for _, n := range nodes {
		c.writeInline(&b, n)
	}
	return b.String()
}

var spaceRe = regexp.MustCompile(`[ \t\r\n\f\v\x{00a0}]+`)

func (c *converter) writeInline(b *strings.Builder, n *html.Node) {
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
	case atom.Img:
		b.WriteString(c.image(n))
	case atom.Em, atom.I, atom.Cite, atom.Dfn, atom.Var:
		b.WriteString(wrap(c.inline(n), "*"))
	case atom.Strong, atom.B:
		b.WriteString(wrap(c.inline(n), "**"))
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
		b.WriteString(c.inline(n))
	default: // a, span, small, mark, abbr, u, s, q, picture, …: keep the text
		if n.DataAtom == atom.Q {
			b.WriteString("“" + c.inline(n) + "”")
			return
		}
		b.WriteString(c.inline(n))
	}
}

// wrap puts emphasis marks around s; pictures in it move out, after it.
func wrap(s, mark string) string {
	pics := strings.Join(picRe.FindAllString(s, -1), "")
	s = picRe.ReplaceAllString(s, "")
	t := strings.TrimSpace(s)
	if t == "" || strings.Trim(t, hardBreak) == "" {
		return s + pics
	}
	lead, trail := "", ""
	if strings.HasPrefix(s, " ") {
		lead = " "
	}
	if strings.HasSuffix(s, " ") {
		trail = " "
	}
	return lead + mark + t + mark + trail + pics
}

// para adds inline output as a paragraph, and the pictures in it as blocks of
// their own, where they were.
func (c *converter) para(s string) {
	text := hasText(s)
	last := 0
	for _, m := range picRe.FindAllStringSubmatchIndex(s, -1) {
		i, _ := strconv.Atoi(s[m[2]:m[3]])
		if !c.pics[i].keep(text) {
			continue // paragraph drops its mark
		}
		c.add(paragraph(s[last:m[0]]))
		c.add(c.pics[i].line)
		last = m[1]
	}
	c.add(paragraph(s[last:]))
}

// keep reports whether a picture stays. One beside text (in a paragraph, list
// item or table row, or with a credit beside it) stays only when the page gives
// its size or describes it: icons and checkmarks in text rarely have either,
// while photos and charts on their own stay whatever they have.
func (p picture) keep(besideText bool) bool { return !besideText || p.sized || p.described }

// picsIn lists the pictures marked in inline output s, in order.
func (c *converter) picsIn(s string) []picture {
	var pics []picture
	for _, m := range picRe.FindAllStringSubmatch(s, -1) {
		i, _ := strconv.Atoi(m[1])
		pics = append(pics, c.pics[i])
	}
	return pics
}

func hasText(s string) bool {
	return strings.TrimSpace(strings.ReplaceAll(picRe.ReplaceAllString(s, ""), hardBreak, "")) != ""
}

// minPicture is the least width and height, in CSS pixels, of a picture worth
// keeping: smaller images are icons, avatars, spacers and tracking pixels.
const minPicture = 100

// image is what an <img> leaves in inline output: an emoji's text, a picture's
// mark, or nothing.
func (c *converter) image(n *html.Node) string {
	alt := strings.TrimSpace(spaceRe.ReplaceAllString(attr(n, "alt"), " "))
	if isSymbol(alt) {
		return escapeText(alt) // an emoji drawn as an image, as on X
	}
	if c.page == nil {
		return ""
	}
	src := pictureSource(n, c.page)
	w, h := pixels(attr(n, "width")), pixels(attr(n, "height"))
	if src == "" || (w > 0 && w < minPicture) || (h > 0 && h < minPicture) {
		return ""
	}
	line := `<img src="` + html.EscapeString(src) + `" alt="` + html.EscapeString(alt) + `"`
	sized := w > 0 && h > 0
	if sized {
		line += ` width="` + strconv.Itoa(w) + `" height="` + strconv.Itoa(h) + `"`
	}
	c.pics = append(c.pics, picture{line: line + ">", sized: sized, described: len(strings.Fields(alt)) >= 3})
	return picMark + strconv.Itoa(len(c.pics)-1) + "\x00"
}

// isSymbol reports whether an image's alt text is a symbol, like an emoji,
// rather than a description.
func isSymbol(alt string) bool {
	if alt == "" || len([]rune(alt)) > 10 {
		return false
	}
	for _, r := range alt {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return false
		}
	}
	return true
}

// pictureSource is the web address of an image: its src, else the largest in
// its srcset, resolved against the page. data: URIs don't count: they're mostly
// placeholders for pictures that load later.
func pictureSource(n *html.Node, page *url.URL) string {
	raw := strings.TrimSpace(attr(n, "src"))
	if raw == "" || strings.HasPrefix(strings.ToLower(raw), "data:") {
		raw = largestInSrcset(attr(n, "srcset"))
	}
	ref, err := url.Parse(raw)
	if raw == "" || err != nil {
		return ""
	}
	u := page.ResolveReference(ref)
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return u.String()
}

var descriptorRe = regexp.MustCompile(`^(\d+(?:\.\d+)?)[wx],?$`)

// largestInSrcset picks the candidate with the largest width or density from a
// srcset such as "a.jpg 480w, b.jpg 960w".
func largestInSrcset(set string) string {
	best, bestSize, size := "", -1.0, 0.0
	cand := ""
	done := func() {
		if cand != "" && size > bestSize {
			best, bestSize = cand, size
		}
	}
	for _, f := range strings.Fields(set) {
		if m := descriptorRe.FindStringSubmatch(f); m != nil && cand != "" {
			size, _ = strconv.ParseFloat(m[1], 64)
			continue
		}
		done()
		cand, size = strings.TrimSuffix(f, ","), 1
	}
	done()
	return best
}

// pixels reads a width or height attribute ("640", "640px"); 0 if it says no size.
func pixels(v string) int {
	n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimSpace(v), "px"))
	if err != nil || n <= 0 || n > 100000 {
		return 0
	}
	return n
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Namespace == "" && a.Key == key {
			return a.Val
		}
	}
	return ""
}

// picLineRe matches a picture's line in the output, in a quote or list too.
var picLineRe = regexp.MustCompile(`(?m)^[> ]*(?:(?:-|\d+\.) +)?<img [^\n]*>$`)

// textless reports whether Markdown from pageMarkdown has nothing to read but
// pictures. Text never starts a line with "<img ": escapeText escapes "<".
func textless(md string) bool {
	return strings.TrimSpace(picLineRe.ReplaceAllString(md, "")) == ""
}

// paragraph tidies inline output into one Markdown paragraph.
func paragraph(s string) string {
	s = picRe.ReplaceAllString(s, "")
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

// oneLine tidies inline output into one line, for headings, list items and
// table cells; pictures in them are left out.
func oneLine(s string) string {
	s = picRe.ReplaceAllString(s, "")
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
