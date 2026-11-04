package server

import (
	"bytes"
	"context"
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
//                                    ?ttlDays= optional: deleted after (default 30, 0 never)
//     Content-Type: application/json {"title": "...", "markdown": "..."}
//   GET  /api/agent/texts            texts agents added: id, title, words, url
//   GET  /api/agent/texts/{id}       one of them, with its Markdown
//   PUT  /api/agent/texts/{id}       rewrite it: same bodies; a title renames it
//   POST /api/agent/texts/{id}/append  add to one of them, after a --- line
//   GET  /api/agent/whoami           check a token

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
	title, content, format, days, ok := readAgentText(w, r)
	if !ok {
		return
	}
	keep := store.AgentTTL
	if days != nil {
		var err error
		if keep, err = ttl(days); err != nil {
			writeError(w, http.StatusBadRequest, sentence(err))
			return
		}
	}
	b, err := s.opts.Store.CreateAgentBook(r.Context(), currentUser(r.Context()).ID, title, format, content, keep)
	if err != nil {
		writeError(w, http.StatusBadRequest, sentence(err))
		return
	}
	writeJSON(w, http.StatusCreated, s.agentBook(r, b))
}

// GET /api/agent/texts: the texts agents added, newest change first, so an agent
// can find the one to add to. Texts the user added aren't listed.
func (s *Server) handleAgentListTexts(w http.ResponseWriter, r *http.Request) {
	books, err := s.opts.Store.ListAgentBooks(r.Context(), currentUser(r.Context()).ID)
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

// POST /api/agent/texts/{id}/append: add more to the end of a text an agent
// added, after a separator line (---). Same bodies as a new text; a title is
// ignored. The text keeps its id, title and link.
func (s *Server) handleAgentAppend(w http.ResponseWriter, r *http.Request) {
	_, content, _, _, ok := readAgentText(w, r)
	if !ok {
		return
	}
	b, err := s.opts.Store.AppendAgentBook(r.Context(), currentUser(r.Context()).ID, r.PathValue("id"), content)
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
	title, content, format, _, ok := readAgentText(w, r)
	if !ok {
		return
	}
	b, err := s.opts.Store.ReplaceAgentBook(r.Context(), currentUser(r.Context()).ID, r.PathValue("id"), title, format, content)
	if err != nil {
		s.agentTextError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.agentBook(r, b))
}

// agentTextError answers for a failed read or change of an agent's text.
func (s *Server) agentTextError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "No text with this id was added by an agent. Agents can only read and change texts agents added; save a new text instead.")
	case errors.Is(err, store.ErrTooLong):
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("The text would be longer than %s characters. Save the rest as a new text.", thousands(store.MaxBookChars)))
	default:
		writeError(w, http.StatusBadRequest, sentence(err))
	}
}

func (s *Server) agentBook(r *http.Request, b *store.Book) map[string]any {
	return map[string]any{
		"id": b.ID, "title": b.Title, "format": b.Format, "words": b.Words, "updatedAt": b.UpdatedAt, "expiresAt": b.ExpiresAt,
		"url": s.publicURL(r) + "/#/read/" + b.ID,
	}
}

// readAgentText reads an agent's text: raw Markdown (?title= and ?ttlDays=
// optional), plain text, or JSON {title, markdown, ttlDays}. On a bad request
// it has answered already.
func readAgentText(w http.ResponseWriter, r *http.Request) (title, content, format string, ttlDays *int, ok bool) {
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	switch mt {
	case "application/json":
		var req struct {
			Title    string `json:"title"`
			Markdown string `json:"markdown"`
			Content  string `json:"content"`
			Format   string `json:"format"`
			TTLDays  *int   `json:"ttlDays"`
		}
		if !decodeLimit(w, r, &req, maxBookBodyBytes) {
			return "", "", "", nil, false
		}
		title, content, format, ttlDays = req.Title, req.Markdown, "markdown", req.TTLDays
		if content == "" {
			content, format = req.Content, req.Format
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
			return "", "", "", nil, false
		}
		title, content, format = r.URL.Query().Get("title"), string(body), "markdown"
		if v := r.URL.Query().Get("ttlDays"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				writeError(w, http.StatusBadRequest, "The days to keep a text (ttlDays) must be a whole number (0 for forever).")
				return "", "", "", nil, false
			}
			ttlDays = &n
		}
		if mt == "text/plain" {
			format = "auto"
		}
	default:
		writeError(w, http.StatusUnsupportedMediaType, "Send Markdown (Content-Type: text/markdown) or JSON {\"title\", \"markdown\"}.")
		return "", "", "", nil, false
	}
	return title, content, format, ttlDays, true
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
