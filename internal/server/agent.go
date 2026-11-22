package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/xavier-niu/lingolens/internal/store"
	"github.com/xavier-niu/lingolens/skills"
)

// Agent API: an AI agent (or any script) holding one of the user's agent tokens
// can add Markdown texts to their shelf, and read, rewrite and add more to the
// texts agents added. That is all a token can do: it can't read or touch the
// texts the user added. Browser sessions don't work here and tokens don't work
// anywhere else.
//
//   POST /api/agent/texts            Authorization: Bearer llat_…
//     Content-Type: text/markdown    raw Markdown body; ?title= optional
//                                    ?note= optional: kept with the text, to find
//                                    it by (the agent's session id, say)
//                                    ?ttlDays= optional: deleted after (default 30, 0 never)
//     Content-Type: application/json {"title": "...", "markdown": "...", "note": "..."}
//   GET  /api/agent/texts            texts agents added: id, title, words, note, url
//                                    ?note=: those whose note contains it
//                                    ?limit= (and &cursor=): a page of them, as
//                                    {"texts", "nextCursor", "total"}
//   GET  /api/agent/texts/{id}       one of them, with its Markdown
//   PUT  /api/agent/texts/{id}       rewrite it: same bodies; a title renames it
//   POST /api/agent/texts/{id}/append  add to one of them, after a --- line
//   DELETE /api/agent/texts/{id}     delete one of them
//   GET  /api/agent/whoami           check a token
//
// The same is offered as an MCP server at /mcp (mcp.go).

func (s *Server) requireAgent(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok {
			w.Header().Set("WWW-Authenticate", `Bearer realm="lingolens"`)
			writeError(w, http.StatusUnauthorized, "Send an agent token: Authorization: Bearer llat_… (create one in Settings → Agent Access).")
			return
		}
		u, err := s.opts.Store.UserByAgentToken(r.Context(), strings.TrimSpace(token))
		if err != nil {
			w.Header().Set("WWW-Authenticate", `Bearer realm="lingolens", error="invalid_token"`)
			writeError(w, http.StatusUnauthorized, "This agent token is invalid or has been revoked.")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userKey, u)))
	}
}

func (s *Server) handleAgentWhoami(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r.Context())
	name := u.Name
	if name == "" {
		name = u.Email
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "user": name, "shelf": s.publicURL(r) + "/#/"})
}

func (s *Server) handleAgentText(w http.ResponseWriter, r *http.Request) {
	in, ok := readAgentText(w, r)
	if !ok {
		return
	}
	keep := store.AgentTTL
	if in.TTLDays != nil {
		var err error
		if keep, err = ttl(in.TTLDays); err != nil {
			writeError(w, http.StatusBadRequest, sentence(err))
			return
		}
	}
	var note string
	if in.Note != nil {
		note = *in.Note
	}
	b, err := s.opts.Store.CreateAgentBook(r.Context(), currentUser(r.Context()).ID, in.Title, in.Format, in.Content, note, keep)
	if err != nil {
		writeError(w, http.StatusBadRequest, sentence(err))
		return
	}
	writeJSON(w, http.StatusCreated, s.agentBook(r, b))
}

// GET /api/agent/texts: the texts agents added, newest change first, so an agent
// can find the one to add to. Texts the user added aren't listed. With ?limit=,
// a page of them (see agentPage); without, all of them, as skills installed
// before there were pages expect.
func (s *Server) handleAgentListTexts(w http.ResponseWriter, r *http.Request) {
	if q := r.URL.Query(); q.Has("limit") || q.Has("cursor") {
		limit, err := strconv.Atoi(q.Get("limit"))
		if q.Get("limit") != "" && err != nil {
			writeError(w, http.StatusBadRequest, "limit must be a whole number, 1 to 100.")
			return
		}
		page, err := s.agentPage(r.Context(), currentUser(r.Context()).ID, s.publicURL(r), q.Get("note"), q.Get("cursor"), limit)
		if err != nil {
			if errors.Is(err, errBadCursor) {
				writeError(w, http.StatusBadRequest, sentence(err))
			} else {
				s.internalError(w, err)
			}
			return
		}
		writeJSON(w, http.StatusOK, page)
		return
	}
	books, err := s.opts.Store.ListAgentBooks(r.Context(), currentUser(r.Context()).ID, r.URL.Query().Get("note"))
	if err != nil {
		s.internalError(w, err)
		return
	}
	out := make([]map[string]any, len(books))
	for i := range books {
		out[i] = s.agentBook(r, &books[i])
	}
	writeJSON(w, http.StatusOK, out)
}

// A page of the texts agents added, for GET /api/agent/texts?limit= and the
// list_books tool.
type agentPageOut struct {
	Texts      []mcpBook `json:"texts"`
	NextCursor string    `json:"nextCursor,omitempty"`
	Total      int       `json:"total"`
}

const (
	agentPageSize    = 20
	agentMaxPageSize = 100
)

var errBadCursor = errors.New("this cursor isn't one a list of texts gave; list again without a cursor to start from the first page")

// agentPage lists up to limit texts (20 for 0, at most 100) whose note contains
// note (all of them for ""), after cursor, the
// nextCursor of the page before ("" for the first page). A cursor names the
// last text of its page: when it last changed, and its id.
func (s *Server) agentPage(ctx context.Context, userID int64, base, note, cursor string, limit int) (*agentPageOut, error) {
	var afterUpdated, afterID string
	if cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		var ok bool
		afterUpdated, afterID, ok = strings.Cut(string(raw), "\n")
		if err != nil || !ok || afterUpdated == "" || afterID == "" {
			return nil, errBadCursor
		}
	}
	limit = min(max(limit, 0), agentMaxPageSize)
	if limit == 0 {
		limit = agentPageSize
	}
	books, more, err := s.opts.Store.ListAgentBooksPage(ctx, userID, note, afterUpdated, afterID, limit)
	if err != nil {
		return nil, err
	}
	total, err := s.opts.Store.CountAgentBooks(ctx, userID, note)
	if err != nil {
		return nil, err
	}
	out := &agentPageOut{Texts: make([]mcpBook, len(books)), Total: total}
	for i := range books {
		out.Texts[i] = mcpBookOf(&books[i], base)
	}
	if more {
		last := out.Texts[len(out.Texts)-1]
		out.NextCursor = base64.RawURLEncoding.EncodeToString([]byte(last.UpdatedAt + "\n" + last.ID))
	}
	return out, nil
}

// POST /api/agent/texts/{id}/append: add more to the end of a text an agent
// added, after a separator line (---). Same bodies as a new text; a title is
// ignored. The text keeps its id, title and link.
func (s *Server) handleAgentAppend(w http.ResponseWriter, r *http.Request) {
	in, ok := readAgentText(w, r)
	if !ok {
		return
	}
	b, err := s.opts.Store.AppendAgentBook(r.Context(), currentUser(r.Context()).ID, r.PathValue("id"), in.Content, in.Note)
	if err != nil {
		s.agentTextError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.agentBook(r, b))
}

// GET /api/agent/texts/{id}: a text an agent added, with its Markdown, so an
// agent can revise it. With Accept: text/markdown, just the Markdown.
func (s *Server) handleAgentGetText(w http.ResponseWriter, r *http.Request) {
	b, err := s.opts.Store.GetAgentBook(r.Context(), currentUser(r.Context()).ID, r.PathValue("id"))
	if err != nil {
		s.agentTextError(w, err)
		return
	}
	if strings.Contains(r.Header.Get("Accept"), "text/markdown") {
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		io.WriteString(w, b.Content)
		return
	}
	out := s.agentBook(r, b)
	out["markdown"] = b.Content
	writeJSON(w, http.StatusOK, out)
}

// PUT /api/agent/texts/{id}: rewrite a text an agent added. Same bodies as a
// new text; a title renames it, no title keeps the old one. The text keeps its
// id and link.
func (s *Server) handleAgentReplace(w http.ResponseWriter, r *http.Request) {
	in, ok := readAgentText(w, r)
	if !ok {
		return
	}
	b, err := s.opts.Store.ReplaceAgentBook(r.Context(), currentUser(r.Context()).ID, r.PathValue("id"), in.Title, in.Format, in.Content, in.Note)
	if err != nil {
		s.agentTextError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.agentBook(r, b))
}

// DELETE /api/agent/texts/{id}: delete a text an agent added.
func (s *Server) handleAgentDelete(w http.ResponseWriter, r *http.Request) {
	if err := s.opts.Store.DeleteAgentBook(r.Context(), currentUser(r.Context()).ID, r.PathValue("id")); err != nil {
		s.agentTextError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// agentTextError answers for a failed read or change of an agent's text.
func (s *Server) agentTextError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, agentTextMessage(err))
	case errors.Is(err, store.ErrTooLong):
		writeError(w, http.StatusRequestEntityTooLarge, agentTextMessage(err))
	default:
		writeError(w, http.StatusBadRequest, agentTextMessage(err))
	}
}

// agentTextMessage says what went wrong with an agent's text, for the agent
// API and the MCP tools.
func agentTextMessage(err error) string {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return "No text with this id was added by an agent. Agents can only read and change texts agents added; save a new text instead."
	case errors.Is(err, store.ErrTooLong):
		return fmt.Sprintf("The text would be longer than %s characters. Save the rest as a new text.", thousands(store.MaxBookChars))
	default:
		return sentence(err)
	}
}

func (s *Server) agentBook(r *http.Request, b *store.Book) map[string]any {
	return map[string]any{
		"id": b.ID, "title": b.Title, "format": b.Format, "words": b.Words, "updatedAt": b.UpdatedAt, "expiresAt": b.ExpiresAt,
		"note": b.Note, "url": s.publicURL(r) + "/#/read/" + b.ID,
	}
}

// agentText is what an agent sent: a text, and what goes with it.
type agentText struct {
	Title, Content, Format string
	TTLDays                *int
	// The agent's note on the text (its session id, say), to find it by; nil
	// when not given, which keeps the note a changed text has.
	Note *string
}

// readAgentText reads an agent's text: raw Markdown (?title=, ?ttlDays= and
// ?note= optional), plain text, or JSON {title, markdown, ttlDays, note}. On a
// bad request it has answered already.
func readAgentText(w http.ResponseWriter, r *http.Request) (t agentText, ok bool) {
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	switch mt {
	case "application/json":
		var req struct {
			Title    string  `json:"title"`
			Markdown string  `json:"markdown"`
			Content  string  `json:"content"`
			Format   string  `json:"format"`
			TTLDays  *int    `json:"ttlDays"`
			Note     *string `json:"note"`
		}
		if !decodeLimit(w, r, &req, maxBookBodyBytes) {
			return t, false
		}
		t = agentText{Title: req.Title, Content: req.Markdown, Format: "markdown", TTLDays: req.TTLDays, Note: req.Note}
		if t.Content == "" {
			t.Content, t.Format = req.Content, req.Format
		}
	case "text/markdown", "text/x-markdown", "text/plain":
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBookBodyBytes))
		if err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				writeError(w, http.StatusRequestEntityTooLarge, "Request is too large.")
			} else {
				writeError(w, http.StatusBadRequest, "The upload didn't finish.")
			}
			return t, false
		}
		q := r.URL.Query()
		t = agentText{Title: q.Get("title"), Content: string(body), Format: "markdown"}
		if q.Has("note") {
			note := q.Get("note")
			t.Note = &note
		}
		if v := r.URL.Query().Get("ttlDays"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				writeError(w, http.StatusBadRequest, "The days to keep a text (ttlDays) must be a whole number (0 for forever).")
				return t, false
			}
			t.TTLDays = &n
		}
		if mt == "text/plain" {
			t.Format = "auto"
		}
	default:
		writeError(w, http.StatusUnsupportedMediaType, "Send Markdown (Content-Type: text/markdown) or JSON {\"title\", \"markdown\"}.")
		return t, false
	}
	return t, true
}

// GET /skills/lingolens.zip: the agent skill, ready to unpack into ~/.claude/skills.
// Public: it holds instructions and a script, nothing about the user.
func (s *Server) handleSkillZip(w http.ResponseWriter, r *http.Request) {
	name, ok := strings.CutSuffix(r.PathValue("file"), ".zip")
	if !ok || name != "lingolens" {
		http.NotFound(w, r)
		return
	}
	var buf bytes.Buffer
	if err := skills.WriteZip(&buf, name); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="lingolens-skill.zip"`)
	w.Write(buf.Bytes())
}

// ---------------------------------------------------------------- token management (signed in)

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	list, err := s.opts.Store.ListAgentTokens(r.Context(), currentUser(r.Context()).ID)
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &req) {
		return
	}
	token, rec, err := s.opts.Store.CreateAgentToken(r.Context(), currentUser(r.Context()).ID, req.Name)
	if errors.Is(err, store.ErrTooManyTokens) {
		writeError(w, http.StatusBadRequest, sentence(err))
		return
	}
	if err != nil {
		s.internalError(w, err)
		return
	}
	// The only time the token is ever sent: the browser shows it once.
	writeJSON(w, http.StatusCreated, map[string]any{"token": token, "info": rec, "endpoint": s.publicURL(r)})
}

func (s *Server) handleDeleteToken(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err == nil {
		err = s.opts.Store.DeleteAgentToken(r.Context(), currentUser(r.Context()).ID, id)
	}
	if err != nil {
		writeError(w, http.StatusNotFound, "That token doesn't exist.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// publicURL is the address people use to reach LingoLens: LINGOLENS_PUBLIC_URL
// when set (behind a proxy), otherwise worked out from the request.
func (s *Server) publicURL(r *http.Request) string {
	if s.opts.PublicURL != "" {
		return strings.TrimRight(s.opts.PublicURL, "/")
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s", scheme, r.Host)
}
