package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/xavier-niu/lingolens/internal/importer"
	"github.com/xavier-niu/lingolens/internal/store"
)

// POST /api/books/import/url {url, title?}: fetch a web page and shelve its article.
func (s *Server) handleImportURL(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL     string `json:"url"`
		Title   string `json:"title"`
		TTLDays *int   `json:"ttlDays"`
	}
	if !decode(w, r, &req) {
		return
	}
	if _, err := ttl(req.TTLDays); err != nil {
		writeError(w, http.StatusBadRequest, sentence(err))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	doc, err := s.fetcher.Article(ctx, req.URL)
	if err != nil {
		s.importError(w, err)
		return
	}
	s.shelve(w, r, doc, req.Title, req.TTLDays)
}

// POST /api/books/import/page {url, html, title?, selection?}: shelve a page the
// user's own browser loaded and sent through the bookmarklet, for sites that
// refuse requests from servers (HTTP 403 and the like). With a selection (HTML),
// only that part is kept; otherwise the article is found as for a fetched page.
// The bookmarklet can't call this from the page's own site (the CSRF guard turns
// cross-site requests away), so it hands the page to a LingoLens tab, which does.
func (s *Server) handleImportPage(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL       string `json:"url"`
		HTML      string `json:"html"`
		Title     string `json:"title"`
		Selection string `json:"selection"`
	}
	// JSON escaping can grow a page a little past its own size.
	if !decodeLimit(w, r, &req, importer.MaxPageBytes+importer.MaxPageBytes/2) {
		return
	}
	var doc *importer.Doc
	var err error
	if strings.TrimSpace(req.Selection) != "" {
		doc, err = importer.Selection(req.Selection, req.URL, req.Title)
	} else {
		doc, err = importer.PageArticle(req.HTML, req.URL)
	}
	if err != nil {
		s.importError(w, err)
		return
	}
	s.shelve(w, r, doc, "", nil)
}

// POST /api/books/import/epub?title=…&ttlDays=…, body: the .epub file (application/epub+zip).
func (s *Server) handleImportEPUB(w http.ResponseWriter, r *http.Request) {
	var days *int
	if v := r.URL.Query().Get("ttlDays"); v != "" {
		n, err := strconv.Atoi(v)
		if _, terr := ttl(&n); err != nil || terr != nil {
			writeError(w, http.StatusBadRequest, "The days to keep a text (ttlDays) must be 0 for forever, or 1 to 3650.")
			return
		}
		days = &n
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, importer.MaxEPUBBytes))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("That file is larger than %d MB.", importer.MaxEPUBBytes>>20))
			return
		}
		writeError(w, http.StatusBadRequest, "The upload didn't finish. Try again.")
		return
	}
	doc, err := importer.ReadEPUB(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		s.importError(w, err)
		return
	}
	s.shelve(w, r, doc, r.URL.Query().Get("title"), days)
}

func (s *Server) shelve(w http.ResponseWriter, r *http.Request, doc *importer.Doc, title string, ttlDays *int) {
	if strings.TrimSpace(title) == "" {
		title = doc.Title
	}
	if n := utf8.RuneCountInString(doc.Content); n > store.MaxBookChars {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"This is too long to import: %s characters, and the limit is %s.", thousands(n), thousands(store.MaxBookChars)))
		return
	}
	b, err := s.opts.Store.CreateBook(r.Context(), currentUser(r.Context()).ID, title, doc.Format, doc.Content)
	if err == nil {
		b, err = s.setTTL(r, b, ttlDays)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, sentence(err))
		return
	}
	writeJSON(w, http.StatusCreated, b)
}

func (s *Server) importError(w http.ResponseWriter, err error) {
	var ue *importer.Error
	if errors.As(err, &ue) {
		writeError(w, http.StatusUnprocessableEntity, ue.Msg)
		return
	}
	s.internalError(w, err)
}

func thousands(n int) string {
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
