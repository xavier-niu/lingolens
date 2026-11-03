// Package server exposes the HTTP API and serves the web UI.
package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/xavier-niu/lingolens/internal/annotate"
	"github.com/xavier-niu/lingolens/internal/importer"
	"github.com/xavier-niu/lingolens/internal/levels"
	"github.com/xavier-niu/lingolens/internal/llm"
	"github.com/xavier-niu/lingolens/internal/store"
)

const (
	maxBodyBytes     = 2 << 20  // 2 MiB
	maxBookBodyBytes = 12 << 20 // a 2M-character text, JSON-encoded
	maxTotalChars    = 150_000
	maxSegments      = 4000
	maxChatMessages  = 40
	maxChatMsgChars  = 8000
	maxPassageChars  = 6000
	maxSelectionChar = 2000
)

type Options struct {
	Store         *store.Store // users, sessions and their reading data
	Static        fs.FS        // web UI files
	AllowFake     bool         // enable the offline "fake" provider (development only)
	SecureCookies bool         // mark the session cookie Secure (set when served over HTTPS)
	// AllowPrivateFetch lets web-page import reach private and loopback addresses.
	// Off in production (it would let users probe the server's network); on in tests.
	AllowPrivateFetch bool
	// PublicURL is how people reach the app (e.g. https://read.example.com); used
	// in links returned to agents. Worked out from each request when empty.
	PublicURL string
	Logger    *slog.Logger
}

type Server struct {
	opts      Options
	annotator *annotate.Service
	http      *http.Client
	limiter   *loginLimiter
	fetcher   *importer.Fetcher
}

func New(opts Options) *Server {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Server{
		opts:      opts,
		annotator: annotate.NewService(),
		limiter:   newLoginLimiter(),
		fetcher:   importer.NewFetcher(opts.AllowPrivateFetch),
		// No overall timeout: chat responses stream. Contexts bound each request.
		http: &http.Client{Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			ResponseHeaderTimeout: 5 * time.Minute,
			IdleConnTimeout:       90 * time.Second,
			MaxIdleConnsPerHost:   16,
		}},
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("GET /api/config", s.handleConfig)

	// Accounts
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/me", s.requireUser(s.handleMe))
	mux.HandleFunc("PUT /api/me/prefs", s.requireUser(s.handlePrefs))
	mux.HandleFunc("PUT /api/me/password", s.requireUser(s.handleChangePassword))
	mux.HandleFunc("PUT /api/me/model", s.requireUser(s.handleSaveModel))
	mux.HandleFunc("GET /api/admin/users", s.requireAdmin(s.handleListUsers))
	mux.HandleFunc("POST /api/admin/users", s.requireAdmin(s.handleCreateUser))
	mux.HandleFunc("PUT /api/admin/users/{id}/password", s.requireAdmin(s.handleResetPassword))
	mux.HandleFunc("DELETE /api/admin/users/{id}", s.requireAdmin(s.handleDeleteUser))

	// The user's library
	mux.HandleFunc("GET /api/books", s.requireUser(s.handleListBooks))
	mux.HandleFunc("POST /api/books", s.requireUser(s.handleCreateBook))
	mux.HandleFunc("GET /api/me/tokens", s.requireUser(s.handleListTokens))
	mux.HandleFunc("POST /api/me/tokens", s.requireUser(s.handleCreateToken))
	mux.HandleFunc("DELETE /api/me/tokens/{id}", s.requireUser(s.handleDeleteToken))
	mux.HandleFunc("GET /skills/{file}", s.handleSkillZip)
	mux.HandleFunc("GET /api/agent/whoami", s.requireAgent(s.handleAgentWhoami))
	mux.HandleFunc("POST /api/agent/texts", s.requireAgent(s.handleAgentText))
	mux.HandleFunc("POST /api/books/import/url", s.requireUser(s.handleImportURL))
	mux.HandleFunc("POST /api/books/import/epub", s.requireUser(s.handleImportEPUB))
	mux.HandleFunc("GET /api/books/{id}", s.requireUser(s.handleGetBook))
	mux.HandleFunc("PUT /api/books/{id}", s.requireUser(s.handleUpdateBook))
	mux.HandleFunc("PUT /api/books/{id}/progress", s.requireUser(s.handleBookProgress))
	mux.HandleFunc("DELETE /api/books/{id}", s.requireUser(s.handleDeleteBook))
	mux.HandleFunc("GET /api/wordbook", s.requireUser(s.handleListWordbook))
	mux.HandleFunc("PUT /api/wordbook/{key}", s.requireUser(s.handlePutWordbook))
	mux.HandleFunc("DELETE /api/wordbook/{key}", s.requireUser(s.handleDeleteWordbook))
	mux.HandleFunc("GET /api/known", s.requireUser(s.handleListKnown))
	mux.HandleFunc("PUT /api/known/{lemma}", s.requireUser(s.handleSetKnown(true)))
	mux.HandleFunc("DELETE /api/known/{lemma}", s.requireUser(s.handleSetKnown(false)))
	mux.HandleFunc("DELETE /api/known", s.requireUser(s.handleClearKnown))

	// LLM features, using the signed-in user's provider and key
	mux.HandleFunc("POST /api/annotate", s.requireUser(s.handleAnnotate))
	mux.HandleFunc("POST /api/lookup", s.requireUser(s.handleLookup))
	mux.HandleFunc("POST /api/chat", s.requireUser(s.handleChat))

	if s.opts.Static != nil {
		mux.Handle("GET /", http.FileServerFS(s.opts.Static))
	}
	return s.logRequests(csrfGuard(mux))
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			s.opts.Logger.Info("request", "method", r.Method, "path", r.URL.Path, "dur", time.Since(start).Round(time.Millisecond))
		}
	})
}

// ---------------------------------------------------------------- handlers

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"levels":        levels.All,
		"default_level": levels.Default,
		"allow_fake":    s.opts.AllowFake,
		"needs_setup":   s.needsSetup(r),
	})
}

type annotateRequest struct {
	Level    string             `json:"level"`
	Segments []annotate.Segment `json:"segments"`
}

func (s *Server) handleAnnotate(w http.ResponseWriter, r *http.Request) {
	var req annotateRequest
	if !decode(w, r, &req) {
		return
	}
	if len(req.Segments) == 0 {
		writeError(w, http.StatusBadRequest, "No text to annotate.")
		return
	}
	if len(req.Segments) > maxSegments {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("Too many paragraphs (max %d).", maxSegments))
		return
	}
	total := 0
	for _, seg := range req.Segments {
		total += utf8.RuneCountInString(seg.Text)
	}
	if total > maxTotalChars {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("Text is too long (%d characters, max %d).", total, maxTotalChars))
		return
	}
	client, cfg, err := s.llmClient(r)
	if err != nil {
		writeLLMError(w, err)
		return
	}

	nd := newNDJSON(w)
	lv := levels.Get(req.Level)
	err = s.annotator.Stream(r.Context(), client, cfg, lv, req.Segments, func(res annotate.Result) error {
		if res.Error != "" {
			return nd.send(map[string]any{"type": "error", "ids": res.IDs, "error": res.Error, "status": res.Status})
		}
		return nd.send(map[string]any{"type": "segment", "id": res.ID, "annotations": res.Annotations})
	})
	if err != nil && r.Context().Err() == nil {
		_ = nd.send(map[string]any{"type": "error", "error": err.Error()})
	}
	_ = nd.send(map[string]any{"type": "done"})
}

type lookupRequest struct {
	Level    string `json:"level"`
	Term     string `json:"term"`
	Sentence string `json:"sentence"`
}

// handleLookup returns a detailed entry for a word the learner clicked.
func (s *Server) handleLookup(w http.ResponseWriter, r *http.Request) {
	var req lookupRequest
	if !decode(w, r, &req) {
		return
	}
	req.Term = strings.TrimSpace(req.Term)
	if req.Term == "" || utf8.RuneCountInString(req.Term) > 80 {
		writeError(w, http.StatusBadRequest, "Pick a word or short phrase to look up.")
		return
	}
	req.Sentence = clipAround(strings.TrimSpace(req.Sentence), req.Term, 600)
	client, cfg, err := s.llmClient(r)
	if err != nil {
		writeLLMError(w, err)
		return
	}
	entry, err := s.annotator.Lookup(r.Context(), client, cfg, levels.Get(req.Level), req.Term, req.Sentence)
	if err != nil {
		writeLLMError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

type chatRequest struct {
	Level     string        `json:"level"`
	Passage   string        `json:"passage"`
	Selection string        `json:"selection"`
	Messages  []llm.Message `json:"messages"`
}

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	var req chatRequest
	if !decode(w, r, &req) {
		return
	}
	if msg := validateChat(&req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	client, _, err := s.llmClient(r)
	if err != nil {
		writeLLMError(w, err)
		return
	}
	nd := newNDJSON(w)
	system := ChatSystemPrompt(levels.Get(req.Level), req.Passage, req.Selection)
	err = client.StreamChat(r.Context(), system, req.Messages, func(delta string) error {
		return nd.send(map[string]any{"type": "delta", "text": delta})
	})
	if err != nil && r.Context().Err() == nil {
		status := http.StatusBadGateway
		var le *llm.Error
		if errors.As(err, &le) {
			status = le.Status
		}
		_ = nd.send(map[string]any{"type": "error", "error": err.Error(), "status": status})
	}
	_ = nd.send(map[string]any{"type": "done"})
}

func validateChat(req *chatRequest) string {
	req.Selection = strings.TrimSpace(req.Selection)
	if req.Selection == "" {
		return "Select some text to ask about."
	}
	if utf8.RuneCountInString(req.Selection) > maxSelectionChar {
		return fmt.Sprintf("Selection is too long (max %d characters).", maxSelectionChar)
	}
	req.Passage = clipAround(req.Passage, req.Selection, maxPassageChars)
	if len(req.Messages) == 0 || len(req.Messages) > maxChatMessages {
		return fmt.Sprintf("A chat needs 1–%d messages.", maxChatMessages)
	}
	for i, m := range req.Messages {
		want := "user"
		if i%2 == 1 {
			want = "assistant"
		}
		if m.Role != want {
			return "Chat messages must alternate user/assistant, starting with user."
		}
		if strings.TrimSpace(m.Content) == "" || utf8.RuneCountInString(m.Content) > maxChatMsgChars {
			return fmt.Sprintf("Each message must be 1–%d characters.", maxChatMsgChars)
		}
	}
	if req.Messages[len(req.Messages)-1].Role != "user" {
		return "The last chat message must be from the user."
	}
	return ""
}

// clipAround trims passage to at most limit runes, keeping the selection in view.
func clipAround(passage, selection string, limit int) string {
	runes := []rune(passage)
	if len(runes) <= limit {
		return passage
	}
	center := 0
	if i := strings.Index(passage, selection); i >= 0 {
		center = utf8.RuneCountInString(passage[:i])
	}
	start := max(0, center-limit/2)
	end := min(len(runes), start+limit)
	start = max(0, end-limit)
	return "…" + string(runes[start:end]) + "…"
}

// needsSetup reports whether no accounts exist yet, so the sign-in page can say
// how to create the first admin.
func (s *Server) needsSetup(r *http.Request) bool {
	n, err := s.opts.Store.CountUsers(r.Context())
	return err == nil && n == 0
}

// ---------------------------------------------------------------- helpers

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	return decodeLimit(w, r, v, maxBodyBytes)
}

func decodeLimit(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "Request is too large.")
		} else {
			writeError(w, http.StatusBadRequest, "Invalid JSON body.")
		}
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

func writeLLMError(w http.ResponseWriter, err error) {
	var le *llm.Error
	if errors.As(err, &le) {
		writeError(w, le.Status, le.Msg)
		return
	}
	writeError(w, http.StatusBadGateway, err.Error())
}

// ndjson streams newline-delimited JSON, flushing after each line.
type ndjson struct {
	w       http.ResponseWriter
	rc      *http.ResponseController
	started bool
}

func newNDJSON(w http.ResponseWriter) *ndjson {
	return &ndjson{w: w, rc: http.NewResponseController(w)}
}

func (n *ndjson) send(v any) error {
	if !n.started {
		n.w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		n.w.Header().Set("Cache-Control", "no-store")
		n.w.Header().Set("X-Accel-Buffering", "no")
		n.w.WriteHeader(http.StatusOK)
		n.started = true
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if _, err := n.w.Write(append(b, '\n')); err != nil {
		return err
	}
	return n.rc.Flush()
}
