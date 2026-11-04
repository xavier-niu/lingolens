package store

import (
	"errors"
	"testing"
)

func TestChats(t *testing.T) {
	s := newTestStore(t)
	ctx := t.Context()
	u := mustUser(t, s, "chat@example.com", false)
	other := mustUser(t, s, "other@example.com", false)
	book, _ := s.CreateBook(ctx, u.ID, "Habits", "text", "Small habits compound over time.")
	theirs, _ := s.CreateBook(ctx, other.ID, "Theirs", "text", "Not yours.")
	turn := []ChatMessage{{"user", "Translate this"}, {"assistant", "习惯会累积。"}}

	c, err := s.PutChat(ctx, u.ID, &Chat{ID: "chat-0001", BookID: book.ID, Selection: "compound", Passage: "Small habits compound over time.", Messages: turn})
	if err != nil {
		t.Fatal(err)
	}
	if c.BookTitle != "Habits" || c.Question != "Translate this" || c.Questions != 1 {
		t.Fatalf("saved chat: %+v", c)
	}
	// Continuing replaces the messages and moves the chat to the top.
	more := append(turn, ChatMessage{"user", "Why compound?"}, ChatMessage{"assistant", "Because…"})
	if _, err := s.PutChat(ctx, u.ID, &Chat{ID: "chat-0002", BookID: book.ID, Selection: "habits", Messages: turn}); err != nil {
		t.Fatal(err)
	}
	if c, err = s.PutChat(ctx, u.ID, &Chat{ID: "chat-0001", BookID: book.ID, Selection: "compound", Messages: more}); err != nil || c.Questions != 2 {
		t.Fatalf("continue: %+v, %v", c, err)
	}
	list, _ := s.ListChats(ctx, u.ID, "")
	if len(list) != 2 || list[0].ID != "chat-0001" || list[0].Messages != nil || list[0].Passage != "" {
		t.Fatalf("list: %+v", list)
	}
	if got, _ := s.GetChat(ctx, u.ID, "chat-0001"); len(got.Messages) != 4 {
		t.Fatalf("get: %+v", got)
	}

	// Another account sees nothing, can't link to someone else's text, and
	// the same id is a separate chat.
	if _, err := s.GetChat(ctx, other.ID, "chat-0001"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other user read a chat: %v", err)
	}
	if list, _ := s.ListChats(ctx, other.ID, ""); len(list) != 0 {
		t.Fatalf("other user lists: %+v", list)
	}
	if c, _ := s.PutChat(ctx, u.ID, &Chat{ID: "chat-0003", BookID: theirs.ID, Selection: "x", Messages: turn}); c.BookID != "" {
		t.Fatalf("linked to another user's text: %+v", c)
	}
	if err := s.DeleteChat(ctx, other.ID, "chat-0001"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other user deleted a chat: %v", err)
	}

	if list, _ := s.ListChats(ctx, u.ID, book.ID); len(list) != 2 {
		t.Fatalf("by book: %+v", list)
	}
	// Chats go with their text.
	if err := s.DeleteBook(ctx, u.ID, book.ID); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.ListChats(ctx, u.ID, ""); len(list) != 1 || list[0].ID != "chat-0003" {
		t.Fatalf("after deleting the text: %+v", list)
	}
	if err := s.DeleteChat(ctx, u.ID, "chat-0003"); err != nil {
		t.Fatal(err)
	}
}
