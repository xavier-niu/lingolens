package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/xavier-niu/lingolens/internal/importer"
	"github.com/xavier-niu/lingolens/internal/store"
)

// POST /api/books/import/url {url, title?}: fetch a web page and shelve its article.
func (s *Server) handleImportURL(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL   string `json:"url"`
		Title string `json:"title"`
	}
	if !decode(w, r, &req) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	doc, err := s.fetcher.Article(ctx, req.URL)
	if err != nil {
		s.importError(w, err)
		return
	}
	s.shelve(w, r, doc, req.Title)
}

// POST /api/books/import/epub?title=…, body: the .epub file (application/epub+zip).
func (s *Server) handleImportEPUB(w http.ResponseWriter, r *http.Request) {
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
	s.shelve(w, r, doc, r.URL.Query().Get("title"))
}

func (s *Server) shelve(w http.ResponseWriter, r *http.Request, doc *importer.Doc, title string) {
	if strings.TrimSpace(title) == "" {
		title = doc.Title
	}
	if n := utf8.RuneCountInString(doc.Content); n > store.MaxBookChars {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"This is too long to import: %s characters, and the limit is %s.", thousands(n), thousands(store.MaxBookChars)))
		return
	}
	b, err := s.opts.Store.CreateBook(r.Context(), currentUser(r.Context()).ID, title, doc.Format, doc.Content)
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
