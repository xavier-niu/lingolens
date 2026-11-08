package server

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/xavier-niu/lingolens/internal/store"
)

// ---------------------------------------------------------------- Ask AI history

// maxSavedMessages bounds a saved conversation. Only the latest
// maxChatMessages of it are sent to the model.
const maxSavedMessages = 120

// Conversation ids come from the browser, so it can save a conversation
// before the server has seen it.
var chatIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

type chatSave struct {
	BookID    string              `json:"bookId"`
	Selection string              `json:"selection"`
	Passage   string              `json:"passage"`
	Messages  []store.ChatMessage `json:"messages"`
}

func validateSavedChat(c *chatSave) string {
	c.Selection = strings.TrimSpace(c.Selection)
	if limit := maxSelection(c.Passage); c.Selection == "" || utf8.RuneCountInString(c.Selection) > limit {
		return fmt.Sprintf("The selection must be 1–%d characters.", limit)
	}
	c.Passage = clipAround(c.Passage, c.Selection, maxPassageChars)
	n := len(c.Messages)
	if n < 2 || n > maxSavedMessages || n%2 != 0 {
		return fmt.Sprintf("A saved chat needs 1–%d questions, each with its answer.", maxSavedMessages/2)
	}
	for i, m := range c.Messages {
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
	return ""
}

func (s *Server) handleListChats(w http.ResponseWriter, r *http.Request) {
	chats, err := s.opts.Store.ListChats(r.Context(), currentUser(r.Context()).ID, r.URL.Query().Get("book"))
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, chats)
}

func (s *Server) handleGetChat(w http.ResponseWriter, r *http.Request) {
	c, err := s.opts.Store.GetChat(r.Context(), currentUser(r.Context()).ID, r.PathValue("id"))
	if err != nil {
		s.chatError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handlePutChat(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !chatIDRe.MatchString(id) {
		writeError(w, http.StatusBadRequest, "Invalid chat id.")
		return
	}
	var req chatSave
	if !decode(w, r, &req) {
		return
	}
	if msg := validateSavedChat(&req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	c, err := s.opts.Store.PutChat(r.Context(), currentUser(r.Context()).ID, &store.Chat{
		ID: id, BookID: req.BookID, Selection: req.Selection, Passage: req.Passage, Messages: req.Messages,
	})
	if err != nil {
		s.internalError(w, err)
		return
	}
	c.Passage, c.Messages = "", nil
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleDeleteChat(w http.ResponseWriter, r *http.Request) {
	if err := s.opts.Store.DeleteChat(r.Context(), currentUser(r.Context()).ID, r.PathValue("id")); err != nil {
		s.chatError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) chatError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "Conversation not found.")
		return
	}
	s.internalError(w, err)
}
