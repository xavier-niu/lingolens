package importer

import (
	"archive/zip"
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"testing"

	"golang.org/x/net/html"
)

func md(t *testing.T, src string) string {
	t.Helper()
	doc, err := html.Parse(strings.NewReader(src))
	if err != nil {
		t.Fatal(err)
	}
	return ToMarkdown(doc)
}

func TestToMarkdown(t *testing.T) {
	got := md(t, `<html><head><title>x</title><style>p{}</style></head><body>
		<nav>Home | About</nav>
		<h1>The   Title</h1>
		<p>Some <em>emphasis</em>, <strong>bold </strong>and a <a href="/x">link</a>.<sup><a href="#n1">1</a></sup></p>
		<p>Line one<br>line two</p>
		<ul><li>First</li><li>Second<ul><li>Nested</li></ul></li></ul>
		<ol><li>One</li><li>Two</li></ol>
		<blockquote><p>Quoted words.</p></blockquote>
		<pre><code>x := 1
y := 2</code></pre>
		<p>1984. A year to remember.</p>
		<p>Use * and _ and [brackets] carefully.</p>
		<img src="https://pics.example/a.png" alt="picture" width="600" height="400">
		<p>All aboard <img src="https://pics.example/1f686.svg" alt="🚆"> tonight.</p>
		<table><tr><th>Word</th><th>Meaning</th></tr><tr><td>cat</td><td>猫</td></tr></table>
		<div>Loose text in a div</div>
		<script>alert(1)</script>
	</body></html>`)
	want := strings.Join([]string{
		"# The Title",
		"Some *emphasis*, **bold** and a link.",
		"Line one\\\nline two",
		"- First\n- Second\n   - Nested",
		"1. One\n2. Two",
		"> Quoted words.",
		"```\nx := 1\ny := 2\n```",
		"1984\\. A year to remember.",
		"Use \\* and \\_ and \\[brackets\\] carefully.",
		"All aboard 🚆 tonight.",
		"Word · Meaning",
		"cat · 猫",
		"Loose text in a div",
	}, "\n\n")
	if got != want {
		t.Fatalf("got:\n%s\n\nwant:\n%s", got, want)
	}
}

// A web page's pictures stay, where they were, loaded from the site; icons,
// avatars, pixels and placeholders don't.
func TestPagePictures(t *testing.T) {
	doc, err := html.Parse(strings.NewReader(`<body>
		<figure><a href="/media/1"><img src="/img/chart.png" alt="Oil prices, 2026" width="687" height="465"></a>
			<figcaption>Oil prices</figcaption></figure>
		<p>Prices fell <img src="https://abs.example/emoji/1f4c9.svg" alt="📉"> again <img src="icon.svg"> this week.</p>
		<p>A map <img src="map.jpg" alt="Map" width="400px" height="300"> of the routes.</p>
		<div><picture><source srcset="map.avif"><img src="data:image/gif;base64,R0lGOD" srcset="small.jpg 480w, large.jpg 1200w" alt='Lazy "quoted"'></picture></div>
		<p><img src="avatar.jpg" width="40" height="40"> <img src="pixel.gif" width="1" height="1"> <img src="rule.png" width="900" height="4"></p>
		<p><img src="javascript:alert(1)"> <img src="data:image/png;base64,AAAA"> <img alt="no source"></p>
		<h2><img src="logo.png" width="200" height="80">Routes</h2>
		<ul><li><img src="dot.png" width="200" height="200">First stop</li></ul>
		<ol><li>Board the train <img src="step1.jpg" width="500" height="300" alt="Platform 3"><ul><li><img src="seat.jpg" width="400" height="300"></li></ul></li>
			<li><img src="check.svg"> Find your cabin</li>
			<li><img src="bunk.jpg" width="400" height="300"><ul><li>Pull the ladder down</li></ul></li></ol>
		<table><tr><th colspan="2">Nightjet</th></tr>
			<tr><td colspan="2"><img src="train.jpg" width="250" height="160" alt="A Nightjet"></td></tr>
			<tr><td>Operator</td><td><img src="flag.png" width="23" height="15"> ÖBB <img src="tick.svg"></td></tr>
			<tr><td><img src="map.png" width="120" height="120"></td><td>Routes</td></tr></table>
		<p><em>Look here <img src="photo.jpg" width="300" height="200"></em></p>
		<blockquote><p><img src="quote.png"></p></blockquote>
	</body>`))
	if err != nil {
		t.Fatal(err)
	}
	page, _ := url.Parse("https://news.example/a/story")
	got := pageMarkdown(doc, page)
	want := strings.Join([]string{
		`<img src="https://news.example/img/chart.png" alt="Oil prices, 2026" width="687" height="465">`,
		"Oil prices",
		"Prices fell 📉 again this week.",
		"A map",
		`<img src="https://news.example/a/map.jpg" alt="Map" width="400" height="300">`,
		"of the routes.",
		`<img src="https://news.example/a/large.jpg" alt="Lazy &#34;quoted&#34;">`,
		"## Routes",
		`- First stop <img src="https://news.example/a/dot.png" alt="" width="200" height="200">`,
		`1. Board the train <img src="https://news.example/a/step1.jpg" alt="Platform 3" width="500" height="300">` + "\n" +
			`   - <img src="https://news.example/a/seat.jpg" alt="" width="400" height="300">` + "\n" +
			"2. Find your cabin\n" +
			`3. <img src="https://news.example/a/bunk.jpg" alt="" width="400" height="300">` + "\n\n" +
			"   - Pull the ladder down",
		"Nightjet",
		`<img src="https://news.example/a/train.jpg" alt="A Nightjet" width="250" height="160">`,
		"Operator · ÖBB",
		"Routes",
		`<img src="https://news.example/a/map.png" alt="" width="120" height="120">`,
		"*Look here*",
		`<img src="https://news.example/a/photo.jpg" alt="" width="300" height="200">`,
		`> <img src="https://news.example/a/quote.png" alt="">`,
	}, "\n\n")
	if got != want {
		t.Fatalf("got:\n%s\n\nwant:\n%s", got, want)
	}
	if text := ToMarkdown(doc); strings.Contains(text, "<img") || !strings.Contains(text, "Prices fell 📉 again") {
		t.Errorf("ToMarkdown kept a picture, or lost an emoji:\n%s", text)
	}
	if !textless(`<img src="https://a.example/1.png" alt="">`+"\n\n> <img src=\"https://a.example/2.png\" alt=\"\">\n\n- <img src=\"https://a.example/3.png\" alt=\"\">\n  <img src=\"https://a.example/4.png\" alt=\"\">\n12. <img src=\"https://a.example/5.png\" alt=\"\">") ||
		textless("<img src=\"x\" alt=\"\">\n\nWords.") || textless("- Words <img src=\"x\" alt=\"\">") {
		t.Error("textless is wrong")
	}
}

// ---------------------------------------------------------------- EPUB

type epubFile struct{ name, body string }

func makeEPUB(t *testing.T, extra ...epubFile) []byte {
	t.Helper()
	files := []epubFile{
		{"mimetype", "application/epub+zip"},
		{"META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`},
		{"OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>A  Short   Book</dc:title><dc:creator>Someone</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c2" href="text/chapter%202.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine><itemref idref="nav"/><itemref idref="c1"/><itemref idref="c2"/><itemref idref="notes" linear="no"/><itemref idref="img"/></spine>
</package>`},
		{"OEBPS/nav.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol><li>Chapter 1</li></ol></nav></body></html>`},
		{"OEBPS/text/ch1.xhtml", `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c1</title></head>
<body><h2>Chapter One</h2><p>It was a bright cold day in April.</p><p class="x">The clocks were striking.</p></body></html>`},
		{"OEBPS/text/chapter 2.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><body><h2>Chapter Two</h2><p>He gave it a shot.</p></body></html>`},
		{"OEBPS/text/notes.xhtml", `<html><body><p>Back matter that isn't in the reading order.</p></body></html>`},
	}
	files = append(files, extra...)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range files {
		w, err := zw.Create(f.name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(f.body))
	}
	zw.Close()
	return buf.Bytes()
}

func TestReadEPUB(t *testing.T) {
	data := makeEPUB(t)
	doc, err := ReadEPUB(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if doc.Title != "A Short Book" || doc.Format != "markdown" {
		t.Fatalf("doc = %+v", doc)
	}
	want := "## Chapter One\n\nIt was a bright cold day in April.\n\nThe clocks were striking.\n\n## Chapter Two\n\nHe gave it a shot."
	if doc.Content != want {
		t.Fatalf("content:\n%s", doc.Content)
	}
}

func TestReadEPUBRejects(t *testing.T) {
	drm := makeEPUB(t, epubFile{"META-INF/encryption.xml", `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData><enc:CipherData><enc:CipherReference URI="OEBPS/text/ch1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`})
	fontsOnly := makeEPUB(t, epubFile{"META-INF/encryption.xml", `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData><enc:CipherData><enc:CipherReference URI="OEBPS/fonts/a.otf"/></enc:CipherData></enc:EncryptedData></encryption>`})

	for name, tc := range map[string]struct {
		data []byte
		want string
	}{
		"not a zip": {[]byte("hello"), "isn't a valid EPUB"},
		"drm":       {drm, "DRM"},
	} {
		_, err := ReadEPUB(bytes.NewReader(tc.data), int64(len(tc.data)))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if _, err := ReadEPUB(bytes.NewReader(fontsOnly), int64(len(fontsOnly))); err != nil {
		t.Errorf("obfuscated fonts are not DRM: %v", err)
	}

	// A chapter that inflates far past the limit (zip bomb) is refused.
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range []epubFile{
		{"META-INF/container.xml", `<container><rootfiles><rootfile full-path="a.opf"/></rootfiles></container>`},
		{"a.opf", `<package><manifest><item id="a" href="a.html" media-type="text/html"/></manifest><spine><itemref idref="a"/></spine></package>`},
	} {
		w, _ := zw.Create(f.name)
		w.Write([]byte(f.body))
	}
	w, _ := zw.Create("a.html")
	chunk := bytes.Repeat([]byte("a"), 1<<20)
	for i := 0; i < maxChapterBytes>>20+1; i++ {
		w.Write(chunk)
	}
	zw.Close()
	if _, err := ReadEPUB(bytes.NewReader(buf.Bytes()), int64(buf.Len())); err == nil {
		t.Error("oversized chapter accepted")
	}
}

// ---------------------------------------------------------------- web

const page = `<!doctype html><html><head><title>How Habits Form | The Daily Example</title>
<meta charset="utf-8"></head><body>
<header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/subscribe">Subscribe now</a></nav></header>
<aside class="sidebar"><h3>Trending</h3><ul><li><a href="/1">Ten tips</a></li><li><a href="/2">Celebrity news</a></li></ul></aside>
<article>
<h1>How Habits Form</h1>
<p>Habits are the small decisions you make and actions you perform every day. According to researchers, they account for a large share of our behaviour, and once a routine is established it can run almost automatically.</p>
<p>Every habit starts with a psychological pattern called a habit loop, which is a three-part process. First, there is a cue, or trigger, that tells your brain to go into automatic mode and let a behaviour unfold.</p>
<p>Then there is the routine, which is the behaviour itself. The third step is the reward: something your brain likes that helps it remember the habit loop in the future.</p>
<p>Understanding this loop makes it easier to change. Rather than fighting the cue, you can keep the cue and the reward and swap in a better routine, and over time the new behaviour takes hold.</p>
</article>
<footer>© 2026 The Daily Example. All rights reserved. Privacy · Terms · Cookies</footer>
</body></html>`

func TestFetchArticle(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/post":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte(page))
		case "/old":
			http.Redirect(w, r, "/post", http.StatusMovedPermanently)
		case "/notes.txt":
			w.Header().Set("Content-Type", "text/plain")
			w.Write([]byte("Plain notes.\n"))
		case "/file.pdf":
			w.Header().Set("Content-Type", "application/pdf")
			w.Write([]byte("%PDF-1.4"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	f := NewFetcher(true)
	ctx := context.Background()

	doc, err := f.Article(ctx, srv.URL+"/old")
	if err != nil {
		t.Fatal(err)
	}
	if doc.Title != "How Habits Form" || doc.Format != "markdown" {
		t.Fatalf("doc = %+v", doc)
	}
	if !strings.Contains(doc.Content, "habit loop") || !strings.Contains(doc.Content, "swap in a better routine") {
		t.Fatalf("article text missing:\n%s", doc.Content)
	}
	for _, junk := range []string{"Subscribe now", "Celebrity news", "All rights reserved"} {
		if strings.Contains(doc.Content, junk) {
			t.Errorf("page furniture kept: %q\n%s", junk, doc.Content)
		}
	}

	doc, err = f.Article(ctx, srv.URL+"/notes.txt")
	if err != nil || doc.Format != "text" || doc.Content != "Plain notes." {
		t.Fatalf("plain text: %+v %v", doc, err)
	}
	for path, want := range map[string]string{"/file.pdf": "isn't a web page", "/missing": "HTTP 404"} {
		if _, err := f.Article(ctx, srv.URL+path); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v", path, err)
		}
	}
}

func TestPageArticle(t *testing.T) {
	doc, err := PageArticle(page, "https://daily.example/habits")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(doc.Title, "How Habits Form") || doc.Format != "markdown" ||
		!strings.Contains(doc.Content, "swap in a better routine") || strings.Contains(doc.Content, "Subscribe now") {
		t.Fatalf("doc = %+v", doc)
	}
	if _, err := PageArticle(page, "javascript:alert(1)"); err == nil {
		t.Error("a page without a web address was accepted")
	}
	big := page + strings.Repeat(" ", MaxPageBytes)
	if _, err := PageArticle(big, "https://daily.example/"); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Errorf("huge page: err = %v", err)
	}
	if _, err := PageArticle("<html><body><nav>Home</nav></body></html>", "https://daily.example/"); err == nil {
		t.Error("a page without an article was accepted")
	}
}

// A news page's pictures, the way sites lay them out: the photo atop the story
// sits outside its text, the byline has the writer's portrait, a photo's wrapper
// is named like page furniture ("sharesheet"), and a related story's card has a
// picture too. The article gets its photos, once each, and nothing else.
func TestPageArticlePictures(t *testing.T) {
	para := func(s string) string {
		return "<p>" + s + " Sleeper trains are coming back across Europe, and the cabins are better than ever, with real beds, clean sheets, and a window onto the night.</p>"
	}
	page := `<!doctype html><html><head><title>Night Trains Return | The Rail Journal</title></head><body>
<header><nav><a href="/"><img src="/logo.png" width="320" height="120" alt="The Rail Journal"></a> <a href="/news">News</a> <a href="/travel">Travel</a></nav></header>
<main><div class="grid">
<h1>Night Trains Return</h1>
<p class="standfirst">Sleeper services are back on many routes, and booking one is easier than it was.</p>
<figure class="main-media"><img src="/img/hero.jpg" width="1200" height="800" alt="A sleeper train at dawn in the Alps"></figure>
<div class="meta"><img src="/img/writer.jpg" width="120" height="120" class="author-image" alt="A. Writer"><a href="/a-writer">A. Writer</a> · Fri 20 Nov 2026</div>
<div class="article-body">` + para("First,") + para("Second,") + `
<div class="image-sharesheet"><picture><img src="/img/cabin.jpg" width="800" height="500" alt="Inside a two-berth cabin"></picture><div class="sharesheet-options"><a href="#share">Share</a></div></div>
` + para("Third,") + `
<div class="related-story"><a href="/other"><img src="/img/other.jpg" width="300" height="200" alt=""><span>Another story about trains that you might like to read next</span></a></div>
` + para("Fourth,") + para("Fifth,") + `
<div class="author-bio"><div class="author-bio__avatar"><img src="/img/writer-big.jpg" width="160" height="160" alt="A. Writer"></div><p>A. Writer covers rail travel for the journal, from sleeper cabins to station cafés.</p></div></div>
</div></main><footer><p>© 2026 The Rail Journal</p></footer></body></html>`
	doc, err := PageArticle(page, "https://rail.example/news/night-trains")
	if err != nil {
		t.Fatal(err)
	}
	pics := regexp.MustCompile(`<img src="([^"]+)"`).FindAllStringSubmatch(doc.Content, -1)
	var got []string
	for _, p := range pics {
		got = append(got, p[1])
	}
	want := []string{"https://rail.example/img/hero.jpg", "https://rail.example/img/cabin.jpg"}
	if !slices.Equal(got, want) || !strings.HasPrefix(doc.Content, `<img src="https://rail.example/img/hero.jpg"`) {
		t.Fatalf("pictures = %q, want %q, the first leading:\n%s", got, want, doc.Content)
	}
	if !strings.Contains(doc.Content, "Fifth,") {
		t.Errorf("text lost:\n%s", doc.Content)
	}

	// An article that opens with its own photo gets no other picture before it.
	opening := strings.Replace(page, `<div class="article-body">`, `<div class="article-body"><figure><img src="/img/first.jpg" width="900" height="600" alt=""></figure>`, 1)
	doc, err = PageArticle(opening, "https://rail.example/news/night-trains")
	if err != nil || !strings.HasPrefix(doc.Content, `<img src="https://rail.example/img/first.jpg"`) || strings.Contains(doc.Content, "hero.jpg") {
		t.Fatalf("doc = %+v, err = %v", doc, err)
	}
}

// Pictures the converter keeps beside text, or not, and in wrappers that hold
// blocks.
func TestPicturesBesideText(t *testing.T) {
	page, _ := url.Parse("https://news.example/")
	doc, _ := html.Parse(strings.NewReader(`<body>
		<figure><picture><img src="lazy.jpg" alt=""><figcaption>Researchers at work.</figcaption></picture></figure>
		<div><img src="crowd.jpg" alt="Getty Images A crowd watches the screen"><span>Getty Images</span></div>
		<div><img src="pdf.png" alt="PDF"> <span>Download the report</span></div>
		<a href="/card"><div>Card title</div><div>Card text</div></a>
	</body>`))
	want := strings.Join([]string{
		`<img src="https://news.example/lazy.jpg" alt="">`,
		"Researchers at work.",
		`<img src="https://news.example/crowd.jpg" alt="Getty Images A crowd watches the screen">`,
		"Getty Images",
		"Download the report",
		"Card title",
		"Card text",
	}, "\n\n")
	if got := pageMarkdown(doc, page); got != want {
		t.Fatalf("got:\n%s\n\nwant:\n%s", got, want)
	}
}

// An article on X, shaped as the bookmarklet sends it (sizes as shown): its
// charts stay with their captions; avatars and emoji pictures don't, though an
// emoji's text does.
func TestPageArticleFromX(t *testing.T) {
	const x = `<!doctype html><html><head><title>The Letter on X: "Is This A Bubble?" / X</title></head><body>
<div id="react-root"><main role="main"><section aria-labelledby="h">
<article role="article" data-testid="tweet">
<div><a href="/TheLetter"><img alt="@TheLetter" src="https://pbs.twimg.com/profile_images/1/a_normal.jpg" width="40" height="40"></a>
<span>The Letter</span><span>@TheLetter</span></div>
<div class="x-article-body"><div data-article-body-html="">
<p><span>Our most common question right now: is there a bubble, and did it pop? Stocks have lost an average of $225 billion per day for 31 straight trading days.</span></p>
<p><span>Before we begin, it is important to understand how much has happened since October, the last time the index hit a record high </span><img alt="📈" src="https://abs-0.twimg.com/emoji/v2/svg/1f4c8.svg" width="17" height="17"><span>.</span></p>
<figure><div><a href="/TheLetter/article/1/media/2"><img alt="" src="https://pbs.twimg.com/media/chart1.png" width="566" height="383"></a></div><figcaption>The index and recent events, since October</figcaption></figure>
<p><span>Over the last 45 days, the market has seen countless headlines, an earnings season, concerns about spending and cash flow, a Fed meeting and an election.</span></p>
<figure><div><a href="/TheLetter/article/1/media/3"><img alt="" src="https://pbs.twimg.com/media/chart2.jpg" width="566" height="378"></a></div><figcaption>Spending and free cash flow</figcaption></figure>
<p><span>These are real concerns, and a lot of these fears are already priced in, but they will persist until there is more clarity on the return on this spending.</span></p>
</div></div>
</article></section></main></div></body></html>`
	doc, err := PageArticle(x, "https://x.com/TheLetter/status/1")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"record high 📈.",
		`<img src="https://pbs.twimg.com/media/chart1.png" alt="" width="566" height="383">` + "\n\nThe index and recent events, since October",
		`<img src="https://pbs.twimg.com/media/chart2.jpg" alt="" width="566" height="378">`,
	} {
		if !strings.Contains(doc.Content, want) {
			t.Errorf("missing %q in:\n%s", want, doc.Content)
		}
	}
	if strings.Contains(doc.Content, "profile_images") || strings.Contains(doc.Content, "emoji/v2") {
		t.Errorf("an avatar or an emoji's picture kept:\n%s", doc.Content)
	}
}

func TestSitelessTitle(t *testing.T) {
	body, _ := html.Parse(strings.NewReader(`<h1>Night  Trains</h1><h2>Why - and how</h2>`))
	for in, want := range map[string]string{
		"Night Trains | The Journal":   "Night Trains",
		"Night Trains – The Journal":   "Night Trains",
		"Why - and how - The Journal":  "Why - and how",
		"Night Trains | Travel | Site": "Night Trains",
		"Spider-Man - a review":        "Spider-Man - a review",
		"The Journal | Night Trains":   "The Journal | Night Trains",
		"Plain title":                  "Plain title",
	} {
		if got := siteless(in, body); got != want {
			t.Errorf("siteless(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSelection(t *testing.T) {
	doc, err := Selection(`<p>First <b>bold</b> line.</p><nav>Menu</nav><p>Second line with <a href="/x">a link</a>.</p><script>evil()</script>`,
		"https://www.forum.example/t/1", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if doc.Title != "forum.example" || doc.Content != "First **bold** line.\n\nSecond line with a link." {
		t.Fatalf("doc = %+v", doc)
	}
	doc, err = Selection("<span>Only this.</span>", "https://forum.example/t/1", "Thread Title")
	if err != nil || doc.Title != "Thread Title" || doc.Content != "Only this." {
		t.Fatalf("doc = %+v, err = %v", doc, err)
	}
	doc, err = Selection(`<p>Before.</p><a href="/p/1"><img src="/pics/a.jpg" width="500" height="300"></a><p>After.</p>`, "https://forum.example/t/1", "T")
	if err != nil || doc.Content != "Before.\n\n"+`<img src="https://forum.example/pics/a.jpg" alt="" width="500" height="300">`+"\n\nAfter." {
		t.Fatalf("selected picture: doc = %+v, err = %v", doc, err)
	}
	if _, err := Selection("<img src=x><script>1</script>", "https://forum.example/", "x"); err == nil {
		t.Error("a selection without text was accepted")
	}
}

// Sites that turn away anything unlike a browser, or that set a cookie and
// redirect to check it, still give up their articles.
func TestFetchLooksLikeABrowser(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ua := r.Header.Get("User-Agent")
		if !strings.Contains(ua, "Chrome/") || strings.Contains(ua, "Go-http-client") ||
			r.Header.Get("Accept-Language") == "" || r.Header.Get("Sec-Fetch-Mode") != "navigate" ||
			!strings.Contains(r.Header.Get("Accept"), "text/html") {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		if _, err := r.Cookie("checked"); err != nil {
			http.SetCookie(w, &http.Cookie{Name: "checked", Value: "1", Path: "/"})
			http.Redirect(w, r, r.URL.Path, http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(page))
	}))
	defer srv.Close()
	f := NewFetcher(true)
	for range 2 { // the second fetch starts without the first one's cookie
		doc, err := f.Article(context.Background(), srv.URL+"/post")
		if err != nil {
			t.Fatal(err)
		}
		if doc.Title != "How Habits Form" {
			t.Fatalf("doc = %+v", doc)
		}
	}
	if client := f.client; client.Jar != nil {
		t.Fatal("the shared client keeps cookies")
	}
}

func TestFetchBlocksPrivateAddresses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(page))
	}))
	defer srv.Close()
	_, err := NewFetcher(false).Article(context.Background(), srv.URL+"/post")
	if err == nil || !strings.Contains(err.Error(), "private network") {
		t.Fatalf("loopback fetch: err = %v", err)
	}
}

func TestPublicIP(t *testing.T) {
	for addr, want := range map[string]bool{
		"93.184.216.34": true, "2606:4700::6810:84e5": true,
		"127.0.0.1": false, "10.1.2.3": false, "172.16.0.1": false, "192.168.1.1": false,
		"169.254.169.254": false, "100.64.0.1": false, "0.0.0.0": false, "::1": false,
		"fe80::1": false, "fd00::1": false, "::ffff:127.0.0.1": false, "224.0.0.1": false,
	} {
		if got := PublicIP(netip.MustParseAddr(addr)); got != want {
			t.Errorf("PublicIP(%s) = %v", addr, got)
		}
	}
}

func TestNormalizeURL(t *testing.T) {
	for in, want := range map[string]string{
		"example.com/post":            "https://example.com/post",
		" http://example.com/a#frag ": "http://example.com/a",
	} {
		u, err := NormalizeURL(in)
		if err != nil || u.String() != want {
			t.Errorf("NormalizeURL(%q) = %v, %v", in, u, err)
		}
	}
	for _, bad := range []string{"", "ftp://example.com", "javascript:alert(1)", "https://user:pw@example.com/"} {
		if _, err := NormalizeURL(bad); err == nil {
			t.Errorf("NormalizeURL(%q) accepted", bad)
		}
	}
}
