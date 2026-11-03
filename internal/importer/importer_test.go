package importer

import (
	"archive/zip"
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
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
		<img src="a.png" alt="picture">
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
		"Word · Meaning",
		"cat · 猫",
		"Loose text in a div",
	}, "\n\n")
	if got != want {
		t.Fatalf("got:\n%s\n\nwant:\n%s", got, want)
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
	if !strings.Contains(doc.Title, "How Habits Form") || doc.Format != "markdown" {
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
