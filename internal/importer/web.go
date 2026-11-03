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
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"

	readability "codeberg.org/readeck/go-readability/v2"
	"golang.org/x/net/html"
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

const (
	maxPageBytes  = 8 << 20
	fetchTimeout  = 25 * time.Second
	maxRedirects  = 5
	userAgent     = "Mozilla/5.0 (compatible; LingoLens/1.0; +https://github.com/xavier-niu/lingolens)"
	acceptHeaders = "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8"
)

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
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", acceptHeaders)
	req.Header.Set("Accept-Language", "en;q=1.0, *;q=0.5")

	resp, err := f.client.Do(req)
	if err != nil {
		return nil, fetchError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, userErr("The site answered with an error (HTTP %d).", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxPageBytes+1))
	if err != nil {
		return nil, fetchError(err)
	}
	if len(body) > maxPageBytes {
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
	article, err := readability.FromDocument(doc, resp.Request.URL)
	if err != nil || article.Node == nil {
		return nil, userErr("Couldn't find the article text on that page.")
	}
	content := strings.TrimSpace(ToMarkdown(article.Node))
	if content == "" {
		return nil, userErr("Couldn't find the article text on that page.")
	}
	title := strings.TrimSpace(article.Title())
	if title == "" {
		title = titleFromURL(resp.Request.URL)
	}
	return &Doc{Title: title, Format: "markdown", Content: content}, nil
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
