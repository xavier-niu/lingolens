package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/xavier-niu/lingolens/internal/levels"
	"github.com/xavier-niu/lingolens/internal/llm"
	"github.com/xavier-niu/lingolens/internal/store"
)

// ---------------------------------------------------------------- me, profile, password

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r.Context())
	model, err := s.opts.Store.GetModelSettings(r.Context(), u.ID)
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u, "model": model})
}

func (s *Server) handlePrefs(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r.Context())
	var req store.Prefs
	if !decode(w, r, &req) {
		return
	}
	p := u.Prefs
	if req.Level != "" {
		p.Level = levels.Get(req.Level).ID
	}
	if req.Lang == "en" || req.Lang == "zh" {
		p.Lang = req.Lang
	}
	if req.ReadSize == "s" || req.ReadSize == "m" || req.ReadSize == "l" {
		p.ReadSize = req.ReadSize
	}
	if req.ReadWidth == "n" || req.ReadWidth == "m" || req.ReadWidth == "w" {
		p.ReadWidth = req.ReadWidth
	}
	if req.Theme == "system" || req.Theme == "light" || req.Theme == "dark" {
		p.Theme = req.Theme
	}
	switch req.ReadFont {
	case "literata", "classic", "sans", "legible":
		p.ReadFont = req.ReadFont
	}
	switch req.GlossFont {
	case "sans", "song", "kai":
		p.GlossFont = req.GlossFont
	}
	p, err := s.opts.Store.UpdatePrefs(r.Context(), u.ID, p)
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r.Context())
	var req struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if !decode(w, r, &req) {
		return
	}
	if _, err := s.opts.Store.Authenticate(r.Context(), u.Email, req.Current); err != nil {
		writeError(w, http.StatusBadRequest, "Your current password is incorrect.")
		return
	}
	if err := s.opts.Store.SetPassword(r.Context(), u.ID, req.New, currentToken(r.Context())); err != nil {
		writeError(w, http.StatusBadRequest, sentence(err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------------------------------------------------------------- model settings

type modelRequest struct {
	Preset  string  `json:"preset"`
	Kind    string  `json:"kind"`
	BaseURL string  `json:"base_url"`
	Model   string  `json:"model"`
	APIKey  *string `json:"api_key"` // omitted: keep the stored key; "": remove it
}

func (s *Server) handleSaveModel(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r.Context())
	var req modelRequest
	if !decode(w, r, &req) {
		return
	}
	switch req.Kind {
	case "openai", "anthropic":
	case "fake":
		if !s.opts.AllowFake {
			writeError(w, http.StatusBadRequest, "The fake provider is not enabled on this server.")
			return
		}
	default:
		writeError(w, http.StatusBadRequest, "Choose a provider.")
		return
	}
	conf := store.ProviderConf{Kind: req.Kind, BaseURL: strings.TrimSpace(req.BaseURL), Model: strings.TrimSpace(req.Model)}
	ms, err := s.opts.Store.SaveProvider(r.Context(), u.ID, req.Preset, conf, req.APIKey)
	if err != nil {
		writeError(w, http.StatusBadRequest, sentence(err))
		return
	}
	writeJSON(w, http.StatusOK, ms)
}

// llmClient builds a client from the signed-in user's saved provider and key.
func (s *Server) llmClient(r *http.Request) (llm.Client, llm.Config, error) {
	u := currentUser(r.Context())
	_, conf, key, err := s.opts.Store.ActiveProvider(r.Context(), u.ID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, llm.Config{}, &llm.Error{Msg: "Choose an AI model in Settings first.", Status: http.StatusBadRequest}
	}
	if err != nil {
		return nil, llm.Config{}, &llm.Error{Msg: sentence(err), Status: http.StatusInternalServerError}
	}
	cfg := llm.Config{Kind: conf.Kind, BaseURL: conf.BaseURL, Model: conf.Model, APIKey: key}
	client, err := llm.New(cfg, s.opts.AllowFake, s.http)
	return client, cfg, err
}

// ---------------------------------------------------------------- admin: accounts

type userRequest struct {
	Email    string `json:"email"`
	Name     string `json:"name"`
	Password string `json:"password"`
	IsAdmin  bool   `json:"is_admin"`
}

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.opts.Store.ListUsers(r.Context())
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, users)
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var req userRequest
	if !decode(w, r, &req) {
		return
	}
	u, err := s.opts.Store.CreateUser(r.Context(), req.Email, req.Name, req.Password, req.IsAdmin)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, store.ErrEmailTaken) {
			status = http.StatusConflict
		}
		writeError(w, status, sentence(err))
		return
	}
	writeJSON(w, http.StatusCreated, u)
}

func pathUserID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusNotFound, "No such account.")
		return 0, false
	}
	return id, true
}

func (s *Server) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUserID(w, r)
	if !ok {
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if !decode(w, r, &req) {
		return
	}
	keep := ""
	if id == currentUser(r.Context()).ID {
		keep = currentToken(r.Context())
	}
	if err := s.opts.Store.SetPassword(r.Context(), id, req.Password, keep); err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, sentence(err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUserID(w, r)
	if !ok {
		return
	}
	if id == currentUser(r.Context()).ID {
		writeError(w, http.StatusBadRequest, "You can't delete your own account while signed in to it.")
		return
	}
	if err := s.opts.Store.DeleteUser(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "No such account.")
			return
		}
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// sentence capitalises an error for display ("password must be…" -> "Password must be….").
func sentence(err error) string {
	msg := err.Error()
	if msg == "" {
		return msg
	}
	msg = strings.ToUpper(msg[:1]) + msg[1:]
	if !strings.HasSuffix(msg, ".") && !strings.HasSuffix(msg, "?") {
		msg += "."
	}
	return msg
}

// ---------------------------------------------------------------- library

func (s *Server) handleListBooks(w http.ResponseWriter, r *http.Request) {
	books, err := s.opts.Store.ListBooks(r.Context(), currentUser(r.Context()).ID)
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, books)
}

type bookRequest struct {
	Title   string `json:"title"`
	Format  string `json:"format"`
	Content string `json:"content"`
	// The device's own id for a text added offline; sending it again returns the
	// same book instead of a copy.
	ClientRef string `json:"clientRef"`
	// Days until the text deletes itself; 0 keeps it forever. Left out: forever
	// for a new text, unchanged for an edit.
	TTLDays *int `json:"ttlDays"`
}

// ttl reads a ttlDays value: nil is "not given".
func ttl(days *int) (time.Duration, error) {
	if days == nil {
		return 0, nil
	}
	if *days < 0 || time.Duration(*days)*24*time.Hour > store.MaxTTL {
		return 0, errors.New("the days to keep a text (ttlDays) must be 0 for forever, or 1 to 3650")
	}
	return time.Duration(*days) * 24 * time.Hour, nil
}

// setTTL applies a ttlDays given with a create or an edit.
func (s *Server) setTTL(r *http.Request, b *store.Book, days *int) (*store.Book, error) {
	d, err := ttl(days)
	if err != nil || days == nil {
		return b, err
	}
	return s.opts.Store.SetBookTTL(r.Context(), currentUser(r.Context()).ID, b.ID, d)
}

func (s *Server) handleCreateBook(w http.ResponseWriter, r *http.Request) {
	var req bookRequest
	if !decodeLimit(w, r, &req, maxBookBodyBytes) {
		return
	}
	if _, err := ttl(req.TTLDays); err != nil {
		writeError(w, http.StatusBadRequest, sentence(err))
		return
	}
	b, err := s.opts.Store.CreateBookRef(r.Context(), currentUser(r.Context()).ID, req.Title, req.Format, req.Content, req.ClientRef)
	if err == nil {
		b, err = s.setTTL(r, b, req.TTLDays)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, sentence(err))
		return
	}
	writeJSON(w, http.StatusCreated, b)
}

func (s *Server) bookError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "This text isn't on your shelf.")
		return
	}
	writeError(w, http.StatusBadRequest, sentence(err))
}

func (s *Server) handleGetBook(w http.ResponseWriter, r *http.Request) {
	b, err := s.opts.Store.GetBook(r.Context(), currentUser(r.Context()).ID, r.PathValue("id"))
	if err != nil {
		s.bookError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, b)
}

func (s *Server) handleUpdateBook(w http.ResponseWriter, r *http.Request) {
	var req bookRequest
	if !decodeLimit(w, r, &req, maxBookBodyBytes) {
		return
	}
	if _, err := ttl(req.TTLDays); err != nil {
		writeError(w, http.StatusBadRequest, sentence(err))
		return
	}
	b, err := s.opts.Store.UpdateBook(r.Context(), currentUser(r.Context()).ID, r.PathValue("id"), req.Title, req.Format, req.Content)
	if err == nil {
		b, err = s.setTTL(r, b, req.TTLDays)
	}
	if err != nil {
		s.bookError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, b)
}

func (s *Server) handleBookProgress(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Pos      float64   `json:"pos"`
		Progress float64   `json:"progress"`
		At       time.Time `json:"at"` // when the reading happened; a device syncing offline reading sends it
	}
	if !decode(w, r, &req) {
		return
	}
	if err := s.opts.Store.SaveProgressAt(r.Context(), currentUser(r.Context()).ID, r.PathValue("id"), req.Pos, req.Progress, req.At); err != nil {
		s.bookError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleDeleteBook(w http.ResponseWriter, r *http.Request) {
	if err := s.opts.Store.DeleteBook(r.Context(), currentUser(r.Context()).ID, r.PathValue("id")); err != nil {
		s.bookError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------------------------------------------------------------- wordbook & known words

func (s *Server) handleListWordbook(w http.ResponseWriter, r *http.Request) {
	entries, err := s.opts.Store.ListWordbook(r.Context(), currentUser(r.Context()).ID)
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handlePutWordbook(w http.ResponseWriter, r *http.Request) {
	var entry json.RawMessage
	if !decode(w, r, &entry) {
		return
	}
	if err := s.opts.Store.PutWordbook(r.Context(), currentUser(r.Context()).ID, r.PathValue("key"), entry); err != nil {
		writeError(w, http.StatusBadRequest, sentence(err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleDeleteWordbook(w http.ResponseWriter, r *http.Request) {
	if err := s.opts.Store.DeleteWordbook(r.Context(), currentUser(r.Context()).ID, r.PathValue("key")); err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleListKnown(w http.ResponseWriter, r *http.Request) {
	words, err := s.opts.Store.ListKnown(r.Context(), currentUser(r.Context()).ID)
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, words)
}

func (s *Server) handleSetKnown(known bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := s.opts.Store.SetKnown(r.Context(), currentUser(r.Context()).ID, r.PathValue("lemma"), known); err != nil {
			writeError(w, http.StatusBadRequest, sentence(err))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func (s *Server) handleClearKnown(w http.ResponseWriter, r *http.Request) {
	if err := s.opts.Store.ClearKnown(r.Context(), currentUser(r.Context()).ID); err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
