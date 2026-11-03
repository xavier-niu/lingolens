package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

var ctx = context.Background()

func newTestStore(t *testing.T) *Store {
	t.Helper()
	bcryptCost = bcrypt.MinCost
	s, err := Open(filepath.Join(t.TempDir(), "test.db"), bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func mustUser(t *testing.T, s *Store, email string, admin bool) *User {
	t.Helper()
	u, err := s.CreateUser(ctx, email, "", "correct horse", admin)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestUsersAndAuth(t *testing.T) {
	s := newTestStore(t)
	u := mustUser(t, s, "Ada@Example.com", true)
	if u.Email != "ada@example.com" || !u.IsAdmin || u.Prefs.Level != "B1" {
		t.Fatalf("user = %+v", u)
	}
	if _, err := s.CreateUser(ctx, "ADA@example.com", "", "another password", false); !errors.Is(err, ErrEmailTaken) {
		t.Fatalf("duplicate email: %v", err)
	}
	if _, err := s.CreateUser(ctx, "not-an-email", "", "long enough", false); err == nil {
		t.Fatal("invalid email accepted")
	}
	if _, err := s.CreateUser(ctx, "b@example.com", "", "short", false); err == nil {
		t.Fatal("short password accepted")
	}
	if _, err := s.Authenticate(ctx, "ada@EXAMPLE.com", "correct horse"); err != nil {
		t.Fatalf("auth (case-insensitive email): %v", err)
	}
	for _, c := range [][2]string{{"ada@example.com", "wrong password"}, {"nobody@example.com", "correct horse"}} {
		if _, err := s.Authenticate(ctx, c[0], c[1]); !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("auth %v: %v", c, err)
		}
	}
}

func TestSessions(t *testing.T) {
	s := newTestStore(t)
	u := mustUser(t, s, "a@example.com", false)
	tok, err := s.CreateSession(ctx, u.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.UserBySession(ctx, tok, time.Hour)
	if err != nil || got.ID != u.ID {
		t.Fatalf("session lookup: %v %v", got, err)
	}
	if _, err := s.UserBySession(ctx, tok+"x", time.Hour); !errors.Is(err, ErrNotFound) {
		t.Fatal("tampered token accepted")
	}
	// Changing the password ends other sessions but keeps the current one.
	other, _ := s.CreateSession(ctx, u.ID, time.Hour)
	if err := s.SetPassword(ctx, u.ID, "new password!", tok); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UserBySession(ctx, other, time.Hour); err == nil {
		t.Fatal("other session survived password change")
	}
	if _, err := s.UserBySession(ctx, tok, time.Hour); err != nil {
		t.Fatal("current session ended by password change")
	}
	expired, _ := s.CreateSession(ctx, u.ID, -time.Minute)
	if _, err := s.UserBySession(ctx, expired, time.Hour); err == nil {
		t.Fatal("expired session accepted")
	}
	_ = s.DeleteSession(ctx, tok)
	if _, err := s.UserBySession(ctx, tok, time.Hour); err == nil {
		t.Fatal("deleted session accepted")
	}
}

func TestBooksAreScopedToTheirOwner(t *testing.T) {
	s := newTestStore(t)
	a := mustUser(t, s, "a@example.com", false)
	b := mustUser(t, s, "b@example.com", false)
	book, err := s.CreateBook(ctx, a.ID, "", "text", "\n\nThe First Line\nmore words here")
	if err != nil {
		t.Fatal(err)
	}
	if book.Title != "The First Line" || book.Words != 6 {
		t.Fatalf("book = %+v", book)
	}
	if _, err := s.GetBook(ctx, b.ID, book.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("user b can read user a's book")
	}
	if err := s.DeleteBook(ctx, b.ID, book.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("user b can delete user a's book")
	}
	if err := s.SaveProgress(ctx, b.ID, book.ID, .5, .5); !errors.Is(err, ErrNotFound) {
		t.Fatal("user b can write user a's progress")
	}
	if list, _ := s.ListBooks(ctx, b.ID); len(list) != 0 {
		t.Fatal("user b sees user a's books")
	}

	_ = s.SaveProgress(ctx, a.ID, book.ID, .6, .6)
	_ = s.SaveProgress(ctx, a.ID, book.ID, .2, .2) // scrolling back keeps the furthest progress
	got, _ := s.GetBook(ctx, a.ID, book.ID)
	if got.Progress != .6 || got.Pos != .2 || got.LastReadAt == "" {
		t.Fatalf("progress = %v pos = %v", got.Progress, got.Pos)
	}
	// Reading done offline an hour ago syncs late: it raises progress but doesn't
	// move the position back to where that device was.
	_ = s.SaveProgressAt(ctx, a.ID, book.ID, .9, .9, time.Now().Add(-time.Hour))
	got, _ = s.GetBook(ctx, a.ID, book.ID)
	if got.Progress != .9 || got.Pos != .2 {
		t.Fatalf("late sync: progress = %v pos = %v", got.Progress, got.Pos)
	}
	_ = s.SaveProgressAt(ctx, a.ID, book.ID, .7, .7, time.Now().Add(time.Hour)) // a clock running ahead counts as now
	got, _ = s.GetBook(ctx, a.ID, book.ID)
	if got.Pos != .7 || got.LastReadAt > time.Now().UTC().Format(time.RFC3339) {
		t.Fatalf("future sync: pos = %v at %v", got.Pos, got.LastReadAt)
	}
	got, _ = s.UpdateBook(ctx, a.ID, book.ID, "Renamed", "", got.Content)
	if got.Title != "Renamed" || got.Progress != .9 {
		t.Fatal("renaming should keep progress")
	}
	got, _ = s.UpdateBook(ctx, a.ID, book.ID, "Renamed", "", "Different text")
	if got.Progress != 0 {
		t.Fatal("rewriting the text should reset progress")
	}
	if list, _ := s.ListBooks(ctx, a.ID); len(list) != 1 || list[0].Content != "" {
		t.Fatal("list should omit content")
	}
	// Deleting the user removes their books.
	_ = s.DeleteUser(ctx, a.ID)
	if _, err := s.GetBook(ctx, a.ID, book.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("book survived its owner")
	}
}

func TestWordbookAndKnown(t *testing.T) {
	s := newTestStore(t)
	u := mustUser(t, s, "a@example.com", false)
	_ = s.PutWordbook(ctx, u.ID, "Mitigate", json.RawMessage(`{"lemma":"mitigate"}`))
	_ = s.PutWordbook(ctx, u.ID, "mitigate", json.RawMessage(`{"lemma":"mitigate","zh":"减轻"}`))
	list, _ := s.ListWordbook(ctx, u.ID)
	if len(list) != 1 || !bytes.Contains(list[0], []byte("减轻")) {
		t.Fatalf("wordbook = %s", list)
	}
	if err := s.PutWordbook(ctx, u.ID, "x", json.RawMessage(`not json`)); err == nil {
		t.Fatal("invalid entry accepted")
	}
	_ = s.SetKnown(ctx, u.ID, "Apple", true)
	_ = s.SetKnown(ctx, u.ID, "banana", true)
	_ = s.SetKnown(ctx, u.ID, "banana", false)
	if k, _ := s.ListKnown(ctx, u.ID); len(k) != 1 || k[0] != "apple" {
		t.Fatalf("known = %v", k)
	}
}

func TestModelSettingsKeepKeysSecret(t *testing.T) {
	s := newTestStore(t)
	a := mustUser(t, s, "a@example.com", false)
	b := mustUser(t, s, "b@example.com", false)
	key := "sk-secret-123"
	ms, err := s.SaveProvider(ctx, a.ID, "deepseek", ProviderConf{Kind: "openai", BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-chat"}, &key)
	if err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(ms)
	if bytes.Contains(out, []byte(key)) || !ms.HasKey["deepseek"] || ms.Active != "deepseek" {
		t.Fatalf("settings leak or wrong: %s", out)
	}
	// The key is encrypted at rest.
	var sealed []byte
	_ = s.db.QueryRow(`SELECT sealed_keys FROM model_settings WHERE user_id = ?`, a.ID).Scan(&sealed)
	if bytes.Contains(sealed, []byte(key)) {
		t.Fatal("key stored in plaintext")
	}
	// nil keeps the key; "" removes it.
	_, _ = s.SaveProvider(ctx, a.ID, "deepseek", ProviderConf{Kind: "openai", Model: "deepseek-reasoner"}, nil)
	_, conf, got, _ := s.ActiveProvider(ctx, a.ID)
	if got != key || conf.Model != "deepseek-reasoner" {
		t.Fatalf("key = %q conf = %+v", got, conf)
	}
	// A sealed blob copied to another user's row does not decrypt.
	_, _ = s.db.Exec(`INSERT INTO model_settings (user_id, active, providers, sealed_keys) VALUES (?, 'deepseek', '{}', ?)`, b.ID, sealed)
	if _, _, _, err := s.ActiveProvider(ctx, b.ID); err == nil {
		t.Fatal("another user's sealed keys decrypted")
	}
	empty := ""
	_, _ = s.SaveProvider(ctx, a.ID, "deepseek", conf, &empty)
	if _, _, got, _ := s.ActiveProvider(ctx, a.ID); got != "" {
		t.Fatal("key not removed")
	}
}

func TestLoadSecret(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret.key")
	a, err := LoadSecret("", path)
	if err != nil || len(a) != 32 {
		t.Fatal(err)
	}
	b, _ := LoadSecret("", path)
	if !bytes.Equal(a, b) {
		t.Fatal("secret file not reused")
	}
	if _, err := LoadSecret("too-short", path); err == nil {
		t.Fatal("bad env secret accepted")
	}
}

func TestDetectFormat(t *testing.T) {
	for text, want := range map[string]string{
		"# Title\n\nSome prose.":                                   "markdown",
		"Intro\n\n```go\nx := 1\n```":                              "markdown",
		"| a | b |\n|---|---|\n| 1 | 2 |":                          "markdown",
		"Read [the docs](https://example.com) and [more](/x).":     "markdown",
		"Shopping:\n- milk\n- eggs\n\nThis is **important**.":      "markdown",
		"Just a letter.\n\nDear friend, I hope you are well.":      "text",
		"Chapter 1\n\nIt was 5 p.m. and #hashtags are not titles.": "text",
		"Two reasons:\n1. It's cheap.\n2. It's fast.":              "text",
		"He said *maybe* and left.":                                "text",
	} {
		if got := DetectFormat(text); got != want {
			t.Errorf("DetectFormat(%q) = %s, want %s", text, got, want)
		}
	}
}

func TestAgentTokens(t *testing.T) {
	s := newTestStore(t)
	ctx := t.Context()
	a, _ := s.CreateUser(ctx, "a@example.com", "", "password one", false)
	b, _ := s.CreateUser(ctx, "b@example.com", "", "password two", false)

	token, rec, err := s.CreateAgentToken(ctx, a.ID, "  Claude   Code ")
	if err != nil || !strings.HasPrefix(token, AgentTokenPrefix) || rec.Name != "Claude Code" || !strings.HasSuffix(rec.Hint, token[len(token)-4:]) {
		t.Fatalf("create: %q %+v %v", token, rec, err)
	}
	u, err := s.UserByAgentToken(ctx, token)
	if err != nil || u.ID != a.ID {
		t.Fatalf("lookup: %+v %v", u, err)
	}
	list, _ := s.ListAgentTokens(ctx, a.ID)
	if len(list) != 1 || list[0].LastUsedAt == nil {
		t.Fatalf("list = %+v", list)
	}
	if _, err := s.UserByAgentToken(ctx, token+"x"); err == nil {
		t.Fatal("wrong token accepted")
	}
	if err := s.DeleteAgentToken(ctx, b.ID, rec.ID); err == nil {
		t.Fatal("another user revoked the token")
	}
	if err := s.DeleteAgentToken(ctx, a.ID, rec.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UserByAgentToken(ctx, token); err == nil {
		t.Fatal("revoked token still works")
	}
}

func TestCreateBookRef(t *testing.T) {
	s := newTestStore(t)
	ctx := t.Context()
	u, _ := s.CreateUser(ctx, "r@example.com", "", "password 12345", false)
	a, err := s.CreateBookRef(ctx, u.ID, "", "text", "First words.", "local-1")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := s.CreateBookRef(ctx, u.ID, "", "text", "First words.", "local-1")
	c, _ := s.CreateBookRef(ctx, u.ID, "", "text", "Other words.", "local-2")
	d, _ := s.CreateBook(ctx, u.ID, "", "text", "No ref.")
	e, _ := s.CreateBook(ctx, u.ID, "", "text", "No ref.")
	if a.ID != b.ID || a.ID == c.ID || d.ID == e.ID {
		t.Fatalf("ids: %s %s %s %s %s", a.ID, b.ID, c.ID, d.ID, e.ID)
	}
	if _, err := s.CreateBookRef(ctx, u.ID, "", "text", "x", strings.Repeat("r", 65)); err == nil {
		t.Fatal("a very long ref was accepted")
	}
}
