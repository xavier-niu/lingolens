package importer

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	readability "codeberg.org/readeck/go-readability/v2"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
	"golang.org/x/net/html/charset"
)

// Doc is an imported text, ready for the shelf.
type Doc struct {
	Title   string
	Format  string // "markdown" or "text"
	Content string
}

// Error is a problem worth showing to the user as is.
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

func userErr(format string, a ...any) error { return &Error{Msg: fmt.Sprintf(format, a...)} }

// MaxPageBytes is the largest web page LingoLens reads, fetched or sent by a browser.
const MaxPageBytes = 8 << 20

const (
	fetchTimeout  = 25 * time.Second
	maxRedirects  = 5
	chromeVersion = "141"
)

// browserHeaders are what Chrome on a desktop sends when you open a link. Many
// sites turn away anything that doesn't look like a browser (an unknown user
// agent, no Accept-Language, no Sec-Fetch-*), and the person importing could
// open the page themselves anyway. Accept-Encoding is left to Go's transport,
// which asks for gzip and decodes it.
var browserHeaders = map[string]string{
	"User-Agent":                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chromeVersion + ".0.0.0 Safari/537.36",
	"Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
	"Accept-Language":           "en-US,en;q=0.9",
	"Sec-Ch-Ua":                 `"Google Chrome";v="` + chromeVersion + `", "Chromium";v="` + chromeVersion + `", "Not_A Brand";v="24"`,
	"Sec-Ch-Ua-Mobile":          "?0",
	"Sec-Ch-Ua-Platform":        `"Windows"`,
	"Sec-Fetch-Dest":            "document",
	"Sec-Fetch-Mode":            "navigate",
	"Sec-Fetch-Site":            "none",
	"Sec-Fetch-User":            "?1",
	"Upgrade-Insecure-Requests": "1",
}

// Fetcher downloads web pages for import. Unless AllowPrivate is set it refuses to
// connect to loopback, private, link-local and other internal addresses, so a
// pasted link can't be used to probe the server's own network (SSRF). The check
// runs on the resolved IP at connect time, which covers redirects and DNS tricks.
type Fetcher struct {
	client *http.Client
}

func NewFetcher(allowPrivate bool) *Fetcher {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	if !allowPrivate {
		dialer.Control = func(network, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip, err := netip.ParseAddr(host)
			if err != nil || !PublicIP(ip) {
				return errBlockedAddr
			}
			return nil
		}
	}
	transport := &http.Transport{
		Proxy:                 nil, // a proxy would hide the destination from the address check
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
		MaxIdleConns:          10,
		IdleConnTimeout:       30 * time.Second,
		ForceAttemptHTTP2:     true,
	}
	return &Fetcher{client: &http.Client{
		Transport: transport,
		Timeout:   fetchTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return userErr("That link redirects too many times.")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return userErr("That link redirects somewhere that isn't a web page.")
			}
			return nil
		},
	}}
}

var errBlockedAddr = errors.New("address not allowed")

var blockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), // carrier-grade NAT
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), // benchmarking
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b:1::/48"), // local-use NAT64
}

// PublicIP reports whether ip is an ordinary internet address.
func PublicIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() ||
		ip.IsLinkLocalUnicast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, p := range blockedPrefixes {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

// NormalizeURL accepts what people paste ("example.com/post") and returns an
// absolute http(s) URL.
func NormalizeURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, userErr("Paste a link to a web page.")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, userErr("That doesn't look like a web address. Links start with https://")
	}
	if u.User != nil {
		return nil, userErr("Links with a username or password aren't supported.")
	}
	u.Fragment = ""
	return u, nil
}

// Article fetches a page and keeps its main text: the article, without menus,
// ads, comments and the like.
func (f *Fetcher) Article(ctx context.Context, raw string) (*Doc, error) {
	u, err := NormalizeURL(raw)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, userErr("That doesn't look like a web address.")
	}
	for k, v := range browserHeaders {
		req.Header.Set(k, v)
	}

	// A fresh cookie jar per fetch: some sites set a cookie and redirect, and loop
	// without it. Nothing is kept, so no cookie passes between fetches or users.
	client := *f.client
	client.Jar, _ = cookiejar.New(nil)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fetchError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, userErr("The site answered with an error (HTTP %d).", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxPageBytes+1))
	if err != nil {
		return nil, fetchError(err)
	}
	if len(body) > MaxPageBytes {
		return nil, userErr("That page is too large to import.")
	}

	ctype := resp.Header.Get("Content-Type")
	mt, _, _ := mime.ParseMediaType(ctype)
	if mt == "" {
		mt = http.DetectContentType(body)
		mt, _, _ = mime.ParseMediaType(mt)
	}
	switch mt {
	case "text/html", "application/xhtml+xml":
	case "text/plain", "text/markdown":
		text, err := decode(body, ctype)
		if err != nil {
			return nil, err
		}
		format := "text"
		if mt == "text/markdown" {
			format = "markdown"
		}
		return &Doc{Title: titleFromURL(resp.Request.URL), Format: format, Content: strings.TrimSpace(text)}, nil
	default:
		return nil, userErr("That link isn't a web page (%s). Try a link to an article.", mt)
	}

	r, err := charset.NewReader(bytes.NewReader(body), ctype)
	if err != nil {
		return nil, userErr("This page uses a text encoding LingoLens can't read.")
	}
	doc, err := html.Parse(r)
	if err != nil {
		return nil, userErr("This page couldn't be read.")
	}
	return extract(doc, resp.Request.URL)
}

// PageArticle keeps the main text of a page that the user's browser loaded and
// sent (the bookmarklet), for sites that refuse requests from servers. pageURL is
// the page's address: it names untitled pages and resolves relative links.
func PageArticle(page, pageURL string) (*Doc, error) {
	u, err := pageAddress(page, pageURL)
	if err != nil {
		return nil, err
	}
	doc, err := html.Parse(strings.NewReader(page))
	if err != nil {
		return nil, userErr("This page couldn't be read.")
	}
	return extract(doc, u)
}

// Selection keeps the part of a page the user selected before clicking the
// bookmarklet, all of it: for pages whose article LingoLens can't find itself.
// fragment is the selection as HTML; title is the page's own title.
func Selection(fragment, pageURL, title string) (*Doc, error) {
	u, err := pageAddress(fragment, pageURL)
	if err != nil {
		return nil, err
	}
	box := &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := html.ParseFragment(strings.NewReader(fragment), box)
	if err != nil {
		return nil, userErr("The selected text couldn't be read.")
	}
	for _, n := range nodes {
		box.AppendChild(n)
	}
	dropPortraits(box)
	content := strings.TrimSpace(pageMarkdown(box, u))
	if textless(content) {
		return nil, userErr("The selection has no text. Select the part to read, or nothing for the whole article.")
	}
	title = strings.TrimSpace(title)
	if title == "" {
		title = titleFromURL(u)
	}
	return &Doc{Title: title, Format: "markdown", Content: content}, nil
}

func pageAddress(page, pageURL string) (*url.URL, error) {
	if len(page) > MaxPageBytes {
		return nil, userErr("That page is too large to import.")
	}
	return NormalizeURL(pageURL)
}

// extract finds the article in a parsed page and converts it to Markdown, with
// its pictures.
func extract(doc *html.Node, u *url.URL) (*Doc, error) {
	dropPortraits(doc)
	shieldPictures(doc)
	idx := indexPage(doc)
	article, err := readability.FromDocument(doc, u)
	if err != nil || article.Node == nil {
		return nil, userErr("Couldn't find the article text on that page.")
	}
	addLeadPicture(article.Node, idx, u)
	content := strings.TrimSpace(pageMarkdown(article.Node, u))
	if textless(content) {
		return nil, userErr("Couldn't find the article text on that page.")
	}
	title := siteless(strings.TrimSpace(article.Title()), doc)
	if title == "" {
		title = titleFromURL(u)
	}
	return &Doc{Title: title, Format: "markdown", Content: content}, nil
}

// portraitRe matches the address or names of a writer's or user's portrait,
// which is no part of what they wrote: an avatar, a headshot, a byline photo.
var portraitRe = regexp.MustCompile(`(?i)avatar|gravatar|profile[_-]?(image|photo|pic)|headshot|byline|author[_-]?(bio|image|photo|pic)`)

// dropPortraits removes portraits: images whose address, alt text, class or id
// says so, or whose wrappers' class or id does (as in "author-bio__avatar").
// They can be as large as small photos, so their size doesn't give them away.
func dropPortraits(doc *html.Node) {
	var portraits []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.DataAtom == atom.Img {
			named := attr(n, "src") + " " + attr(n, "alt")
			for a, up := n, 0; a != nil && a.Type == html.ElementNode && up <= 3; a, up = a.Parent, up+1 {
				named += " " + attr(a, "class") + " " + attr(a, "id")
			}
			if portraitRe.MatchString(named) {
				portraits = append(portraits, n)
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	for _, n := range portraits {
		n.Parent.RemoveChild(n)
	}
}

// shieldPictures keeps readability from dropping a page's pictures for their
// wrappers' names. Readability removes elements whose class or id sounds like
// page furniture ("share", "media", "extra", "hidden", …), and sites give such
// names to the wrappers of article pictures: Apple's "image-sharesheet", or
// CNN's "image_large--eq-extra-small". So each wrapper that holds one picture
// and little text (a caption, a credit) loses its class and id. One that is
// mostly a link, like a related story's card, keeps them, and so does the
// picture itself: readability looks for "lazy" in its class.
func shieldPictures(doc *html.Node) {
	var pics []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if mayBePicture(n) {
			pics = append(pics, n)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	for _, img := range pics {
		for a := img.Parent; a != nil && a.Type == html.ElementNode; a = a.Parent {
			if a.DataAtom == atom.Body || a.DataAtom == atom.Html || a.DataAtom == atom.Main ||
				a.DataAtom == atom.Article || !wrapsOnePicture(a) {
				break
			}
			a.Attr = slices.DeleteFunc(a.Attr, func(at html.Attribute) bool { return at.Key == "class" || at.Key == "id" })
		}
	}
}

// mayBePicture reports whether n is an <img> that may be a picture worth
// keeping: it has an address to load, and isn't too small if it says its size.
func mayBePicture(n *html.Node) bool {
	if n.Type != html.ElementNode || n.DataAtom != atom.Img {
		return false
	}
	w, h := pixels(attr(n, "width")), pixels(attr(n, "height"))
	if (w > 0 && w < minPicture) || (h > 0 && h < minPicture) {
		return false
	}
	src := strings.TrimSpace(attr(n, "src"))
	return (src != "" && !strings.HasPrefix(strings.ToLower(src), "data:")) || attr(n, "srcset") != "" || attr(n, "data-src") != ""
}

// wrapsOnePicture reports whether n holds one picture and at most 300
// characters of text, not mostly in links.
func wrapsOnePicture(n *html.Node) bool {
	pics, text, linked := 0, 0, 0
	var walk func(n *html.Node, inLink bool) bool // false: stop, n is more than a wrapper
	walk = func(n *html.Node, inLink bool) bool {
		switch {
		case n.Type == html.TextNode:
			k := utf8.RuneCountInString(strings.TrimSpace(n.Data))
			text += k
			if inLink {
				linked += k
			}
			return text <= 300
		case n.Type != html.ElementNode || n.DataAtom == atom.Script || n.DataAtom == atom.Style:
			return true
		case mayBePicture(n):
			pics++
			return pics <= 1
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if !walk(c, inLink || n.DataAtom == atom.A) {
				return false
			}
		}
		return true
	}
	return walk(n, false) && !(text >= 25 && 2*linked > text)
}

// pageIndex is every element of a page in document order, each marked with
// its place (atKey), and how much text comes before each one.
type pageIndex struct {
	els    []*html.Node
	before []int // characters of text before each element
}

const atKey = "data-lingolens-at"

// indexPage numbers a page's elements, so the ones readability keeps (it keeps
// their attributes) can be found in the page again.
func indexPage(doc *html.Node) pageIndex {
	var idx pageIndex
	text := 0
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		switch n.Type {
		case html.TextNode:
			text += utf8.RuneCountInString(strings.TrimSpace(n.Data))
			return
		case html.ElementNode:
			if n.DataAtom == atom.Script || n.DataAtom == atom.Style {
				return
			}
			n.Attr = append(n.Attr, html.Attribute{Key: atKey, Val: strconv.Itoa(len(idx.els))})
			idx.els = append(idx.els, n)
			idx.before = append(idx.before, text)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return idx
}

// leadGap is the most text, in characters, between a lead picture and its
// article: a headline, a standfirst, a caption, a byline and dates.
const leadGap = 1000

// addLeadPicture puts back the picture an article opens with, between its
// headline and its text: readability leaves it out as a sibling of the text
// with no text of its own (the photo atop a Guardian or CNN story, an X
// article's cover, a blog's featured image). It's the nearest picture before
// where the article starts in the page, with little text between, large or in
// a <figure>, and not part of the page's furniture.
func addLeadPicture(article *html.Node, idx pageIndex, page *url.URL) {
	start := -1
	have := map[string]bool{}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if i, err := strconv.Atoi(attr(n, atKey)); err == nil && i < len(idx.els) && (start < 0 || i < start) {
				start = i
			}
			if n.DataAtom == atom.Img {
				have[pictureSource(n, page)] = true
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(article)
	if start <= 0 || opensWithPicture(article) {
		return
	}
	text := idx.els[start]
	for i := start - 1; i >= 0 && idx.before[start]-idx.before[i] <= leadGap; i-- {
		img := idx.els[i]
		if !mayBePicture(img) || !leadsArticle(img) {
			continue
		}
		if have[pictureSource(img, page)] {
			return // the article shows it already
		}
		// The picture with its caption: its wrappers that hold nothing else.
		block := img
		for a := img.Parent; a != nil && a.Type == html.ElementNode && !contains(a, text) && wrapsOnePicture(a); a = a.Parent {
			block = a
		}
		article.InsertBefore(cloneNode(block), article.FirstChild)
		return
	}
}

// opensWithPicture reports whether an article shows a picture before any text:
// it has its lead picture already.
func opensWithPicture(n *html.Node) bool {
	var first func(*html.Node) (found, pic bool)
	first = func(n *html.Node) (bool, bool) {
		if n.Type == html.TextNode && strings.TrimSpace(n.Data) != "" {
			return true, false
		}
		if mayBePicture(n) {
			return true, true
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if n.Type == html.ElementNode && (n.DataAtom == atom.Script || n.DataAtom == atom.Style) {
				break
			}
			if found, pic := first(c); found {
				return true, pic
			}
		}
		return false, false
	}
	_, pic := first(n)
	return pic
}

// leadsArticle reports whether a picture before an article may be its lead
// picture: large (or in a <figure> when the page doesn't say), shown, and not
// in navigation, a sidebar, a footer, a form or the page's own header.
func leadsArticle(img *html.Node) bool {
	inFigure := false
	for n := img; n != nil; n = n.Parent {
		if n.Type != html.ElementNode {
			continue
		}
		switch n.DataAtom {
		case atom.Nav, atom.Aside, atom.Footer, atom.Form, atom.Button:
			return false
		case atom.Header:
			if !within(n, atom.Article, atom.Main) {
				return false
			}
		case atom.Figure, atom.Picture:
			inFigure = true
		}
		switch attr(n, "role") {
		case "navigation", "banner", "complementary", "contentinfo", "dialog":
			return false
		}
		style := strings.ReplaceAll(strings.ToLower(attr(n, "style")), " ", "")
		if hasAttr(n, "hidden") || attr(n, "aria-hidden") == "true" ||
			strings.Contains(style, "display:none") || strings.Contains(style, "visibility:hidden") {
			return false
		}
	}
	w := pixels(attr(img, "width"))
	return w >= 300 || (w == 0 && inFigure)
}

func within(n *html.Node, tags ...atom.Atom) bool {
	for a := n.Parent; a != nil; a = a.Parent {
		if a.Type == html.ElementNode && slices.Contains(tags, a.DataAtom) {
			return true
		}
	}
	return false
}

func contains(a, n *html.Node) bool {
	for ; n != nil; n = n.Parent {
		if n == a {
			return true
		}
	}
	return false
}

func hasAttr(n *html.Node, key string) bool {
	return slices.ContainsFunc(n.Attr, func(a html.Attribute) bool { return a.Key == key })
}

// cloneNode copies n and everything in it, detached from its page.
func cloneNode(n *html.Node) *html.Node {
	c := &html.Node{Type: n.Type, DataAtom: n.DataAtom, Data: n.Data, Namespace: n.Namespace, Attr: slices.Clone(n.Attr)}
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		c.AppendChild(cloneNode(ch))
	}
	return c
}

// siteless drops the site name from a page title ("How Habits Form | The Daily
// Example"), but only when the rest is also a heading on the page, so titles
// that merely contain a dash stay whole.
func siteless(title string, doc *html.Node) string {
	for _, sep := range []string{" | ", " – ", " — ", " - ", " · ", " :: "} {
		// The site name usually comes last; some titles also name a section.
		last := strings.LastIndex(title, sep)
		if last < 0 {
			continue
		}
		for _, head := range []string{title[:last], title[:strings.Index(title, sep)]} {
			if head = strings.TrimSpace(head); head != "" && hasHeading(doc, head) {
				return head
			}
		}
	}
	return title
}

func hasHeading(n *html.Node, text string) bool {
	if n.Type == html.ElementNode && (n.DataAtom == atom.H1 || n.DataAtom == atom.H2) &&
		strings.EqualFold(strings.Join(strings.Fields(textContent(n)), " "), text) {
		return true
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if hasHeading(c, text) {
			return true
		}
	}
	return false
}

func decode(body []byte, ctype string) (string, error) {
	r, err := charset.NewReader(bytes.NewReader(body), ctype)
	if err != nil {
		return "", userErr("This page uses a text encoding LingoLens can't read.")
	}
	b, err := io.ReadAll(r)
	if err != nil {
		return "", userErr("This page couldn't be read.")
	}
	return string(b), nil
}

func titleFromURL(u *url.URL) string {
	if u == nil {
		return ""
	}
	return strings.TrimPrefix(u.Hostname(), "www.")
}

func fetchError(err error) error {
	var ue *Error
	if errors.As(err, &ue) {
		return ue
	}
	if errors.Is(err, errBlockedAddr) {
		return userErr("That address is on a private network, so it can't be imported.")
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return userErr("Couldn't find that website. Check the link.")
	}
	if errors.Is(err, context.DeadlineExceeded) || isTimeout(err) {
		return userErr("The website took too long to answer.")
	}
	return userErr("Couldn't reach that website.")
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}
