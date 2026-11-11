package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

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

func TestCreateFirstAdmin(t *testing.T) {
	s := newTestStore(t)
	// Several people race through first-run setup: exactly one becomes admin.
	const racers = 8
	errs := make(chan error, racers)
	for i := range racers {
		go func() {
			_, err := s.CreateFirstAdmin(ctx, fmt.Sprintf("admin%d@example.com", i), "", "correct horse")
			errs <- err
		}()
	}
	won := 0
	for range racers {
		switch err := <-errs; {
		case err == nil:
			won++
		case !errors.Is(err, ErrSetupDone):
			t.Fatalf("racer: %v", err)
		}
	}
	if n, _ := s.CountUsers(ctx); won != 1 || n != 1 {
		t.Fatalf("%d setups succeeded, %d accounts; want 1 and 1", won, n)
	}
	if _, err := s.CreateFirstAdmin(ctx, "late@example.com", "", "correct horse"); !errors.Is(err, ErrSetupDone) {
		t.Fatalf("setup after the first admin: %v", err)
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
	// Adding to the end keeps the place: the same spot, a smaller share.
	before, more := got.Content, got.Content+"\n\n---\n\nA few more words at the end."
	share := float64(utf8.RuneCountInString(before)) / float64(utf8.RuneCountInString(more))
	got, _ = s.UpdateBook(ctx, a.ID, book.ID, "Renamed", "", more)
	if math.Abs(got.Progress-.9*share) > 1e-9 || math.Abs(got.Pos-.7*share) > 1e-9 {
		t.Fatalf("appended: progress = %v pos = %v, want %v and %v", got.Progress, got.Pos, .9*share, .7*share)
	}
	got, _ = s.UpdateBook(ctx, a.ID, book.ID, "Renamed", "", "Different text")
	if got.Progress != 0 || got.Pos != 0 {
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
		// What chat apps and notes give: bold titles, links, images, …
		"**Small Habits**\r\n\r\nMost people think *big* goals need big changes.":                          "markdown",
		"Note: do **not** skip this step.":                                                                 "markdown",
		"See [the guide](guide.md) first.":                                                                 "markdown",
		"A walk\n\n![The gate](gate.jpg)\n\nWe left early.":                                                "markdown",
		"Morning Routines\n================\n\nMost people check their phones.":                            "markdown",
		"  # Coffee\n\n  Coffee grows in many countries.":                                                  "markdown",
		"#\u00a0Coffee\n\nCoffee grows in many countries.":                                                 "markdown",
		"| a | b |\n|--|--|\n| 1 | 2 |":                                                                    "markdown",
		"It was *never* calm. It was _always_ loud. It was ~~quiet~~ mad.":                                 "markdown",
		"Read the [guide][1] and the [notes][2].\n\n[1]: /guide\n[2]: /notes":                              "markdown",
		"The test:\n1. It sends requests.\n2. It checks:\n   - they all succeed\n   - the kill came first": "markdown",
		// … and plain text that only looks a little like it.
		"The woods are *lovely*, dark and deep,\nBut I have promises to keep.": "text",
		"The letter [sic](1990) was lost.":                                     "text",
		"In Python, 5**2 is 25 and 3**4 is 81.":                                "text",
		"Use snake_case names like user_id and book_id.":                       "text",
		"Part one.\n\n---\n\nPart two.\n\n---\n\nPart three.":                  "text",
		"* * * * *\n\nThe study found a 20% rise* in sales.":                   "text",
		"- Where are you going?\n- Home.\n\nShe turned away.":                  "text",
		"Bring:\n  - a map\n  - a coat":                                        "text",
	} {
		if got := DetectFormat(text); got != want {
			t.Errorf("DetectFormat(%q) = %s, want %s", text, got, want)
		}
	}
}

// Text wrapped at a fixed width, as copied from a terminal (with its margin)
// or a Project Gutenberg book, and texts whose line breaks mean something.
const (
	wrappedTerminal = "The kill is the test ending the target sandbox through the\n" +
		"  public API. It calls the client, which then sends the request\n" +
		"  through the SDK. That is the same API a user calls to kill a\n" +
		"  sandbox.\n\n" +
		"  - The control requests all succeeded. If they failed as well,\n" +
		"    the gateway path is broken.\n" +
		"  - Every target request succeeded, after waiting the full four\n" +
		"    seconds."
	wrappedProse = "It is a truth universally acknowledged, that a single man in\n" +
		"possession of a good fortune, must be in want of a wife. However\n" +
		"little known the feelings or views of such a man may be on his\n" +
		"first entering a neighbourhood, this truth is so well fixed."
	wrappedItalics = "It is a truth _universally_ acknowledged, that a single man in\n" +
		"possession of a good fortune, must be in want of a _wife_. However\n" +
		"little known the feelings or views of such a man may be on his\n" +
		"first entering a neighbourhood, this truth is so well fixed."
	wrappedVerse = wrappedItalics + "\n\n" +
		"    The woods are lovely, dark and deep,\n    But I have promises to keep."
	poem = "Whose woods these are I think I know, his house is in the village though;\n" +
		"He will not see me stopping here to watch his woods fill up with snow.\n" +
		"My little horse must think it queer to stop without a farmhouse near\n" +
		"Between the woods and frozen lake, the darkest evening of the year."
	paragraphPerLine = "The first paragraph of an article goes on for a while about coffee and tea.\n" +
		"A second one is short.\n" +
		"The third paragraph is long as well, and covers the history of the drink.\n" +
		"Fourth."
)

func TestWrapWidth(t *testing.T) {
	for name, c := range map[string]struct {
		text    string
		wrapped bool
	}{
		"terminal":           {wrappedTerminal, true},
		"book":               {wrappedProse, true},
		"book with verse":    {wrappedVerse, true},
		"poem":               {poem, false},
		"paragraph per line": {paragraphPerLine, false},
		"address":            {"Dear Sam,\n\n12 Hill Road\nLondon\n\nBest, Ann", false},
	} {
		if got := wrapWidth(c.text) > 0; got != c.wrapped {
			t.Errorf("%s: wrapped = %v, want %v", name, got, c.wrapped)
		}
	}
	// Wrapped, Markdown's joining of lines costs nothing, so a few marks do.
	for text, want := range map[string]string{
		wrappedTerminal: "markdown", // two list items, wrapped
		wrappedItalics:  "markdown", // two _italics_, wrapped
		wrappedProse:    "text",     // wrapped, but no marks
		wrappedVerse:    "text",     // two _italics_, but the verse would be code
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

func TestAppendAgentBook(t *testing.T) {
	s := newTestStore(t)
	ctx := t.Context()
	u, _ := s.CreateUser(ctx, "ag@example.com", "", "password 12345", false)
	other, _ := s.CreateUser(ctx, "ot@example.com", "", "password 12345", false)
	mine, _ := s.CreateBook(ctx, u.ID, "Mine", "markdown", "My own notes.")
	a, err := s.CreateAgentBook(ctx, u.ID, "Coffee", "markdown", "# Coffee\n\nPart one.\n\n", AgentTTL)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SaveProgress(ctx, u.ID, a.ID, 1, 1); err != nil {
		t.Fatal(err)
	}

	b, err := s.AppendAgentBook(ctx, u.ID, a.ID, "\n## More\n\nPart two.\n")
	if err != nil {
		t.Fatal(err)
	}
	if want := "# Coffee\n\nPart one.\n\n---\n\n## More\n\nPart two."; b.Content != want {
		t.Fatalf("content = %q, want %q", b.Content, want)
	}
	if b.Title != "Coffee" || b.Words != CountWords(b.Content) {
		t.Fatalf("book = %+v", b)
	}
	if c, _ := s.AppendAgentBook(ctx, u.ID, a.ID, "Part three."); c.UpdatedAt <= b.UpdatedAt || b.UpdatedAt <= a.UpdatedAt {
		t.Fatalf("updatedAt %s → %s → %s: devices wouldn't refetch", a.UpdatedAt, b.UpdatedAt, c.UpdatedAt)
	}
	if b.Pos <= 0.4 || b.Pos >= 0.8 || b.Progress != b.Pos {
		t.Fatalf("pos %v, progress %v: should still point at the end of part one", b.Pos, b.Progress)
	}

	list, _ := s.ListAgentBooks(ctx, u.ID)
	if len(list) != 1 || list[0].ID != a.ID || list[0].Content != "" {
		t.Fatalf("agent books = %+v", list)
	}
	for name, err := range map[string]error{
		"the user's own text": func() error { _, err := s.AppendAgentBook(ctx, u.ID, mine.ID, "x"); return err }(),
		"another user's text": func() error { _, err := s.AppendAgentBook(ctx, other.ID, a.ID, "x"); return err }(),
		"no such text":        func() error { _, err := s.AppendAgentBook(ctx, u.ID, "nope", "x"); return err }(),
	} {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: %v, want not found", name, err)
		}
	}
	if _, err := s.AppendAgentBook(ctx, u.ID, a.ID, "  \n"); err == nil {
		t.Error("empty addition accepted")
	}
	if _, err := s.AppendAgentBook(ctx, u.ID, a.ID, strings.Repeat("x", MaxBookChars)); !errors.Is(err, ErrTooLong) {
		t.Errorf("too long: %v", err)
	}
}

func TestReplaceAgentBook(t *testing.T) {
	s := newTestStore(t)
	ctx := t.Context()
	u, _ := s.CreateUser(ctx, "rp@example.com", "", "password 12345", false)
	other, _ := s.CreateUser(ctx, "ro@example.com", "", "password 12345", false)
	mine, _ := s.CreateBook(ctx, u.ID, "Mine", "markdown", "My own notes.")
	a, _ := s.CreateAgentBook(ctx, u.ID, "Coffee", "markdown", "# Coffee\n\nPart one has a mistaek.", AgentTTL)
	if err := s.SaveProgress(ctx, u.ID, a.ID, 0.5, 0.4); err != nil {
		t.Fatal(err)
	}
	s.db.ExecContext(ctx, `UPDATE books SET expires_at = ? WHERE id = ?`, expiry(24*time.Hour), a.ID)

	got, err := s.GetAgentBook(ctx, u.ID, a.ID)
	if err != nil || got.Content != a.Content || got.Content == "" {
		t.Fatalf("get = %+v, %v", got, err)
	}
	b, err := s.ReplaceAgentBook(ctx, u.ID, a.ID, "", "", "# Coffee\n\nPart one has no mistake.")
	if err != nil {
		t.Fatal(err)
	}
	if b.ID != a.ID || b.Title != "Coffee" || b.Content != "# Coffee\n\nPart one has no mistake." || b.Words != 6 {
		t.Fatalf("replaced = %+v", b)
	}
	if b.Pos != got.Pos || b.Progress != got.Progress || b.Pos == 0 {
		t.Fatalf("pos %v, progress %v: the reader should keep their place", b.Pos, b.Progress)
	}
	if b.UpdatedAt <= a.UpdatedAt {
		t.Fatalf("updatedAt %s → %s: devices wouldn't refetch", a.UpdatedAt, b.UpdatedAt)
	}
	if at, _ := time.Parse(time.RFC3339, b.ExpiresAt); time.Until(at) < AgentTTL-time.Minute {
		t.Fatalf("rewriting should renew to 30 days: %s", b.ExpiresAt)
	}
	if b, _ = s.ReplaceAgentBook(ctx, u.ID, a.ID, "  Coffee Basics ", "", b.Content); b.Title != "Coffee Basics" {
		t.Fatalf("renamed to %q", b.Title)
	}
	for name, err := range map[string]error{
		"get the user's own text":     func() error { _, err := s.GetAgentBook(ctx, u.ID, mine.ID); return err }(),
		"replace the user's own text": func() error { _, err := s.ReplaceAgentBook(ctx, u.ID, mine.ID, "", "", "x"); return err }(),
		"another user's text":         func() error { _, err := s.ReplaceAgentBook(ctx, other.ID, a.ID, "", "", "x"); return err }(),
		"another user's get":          func() error { _, err := s.GetAgentBook(ctx, other.ID, a.ID); return err }(),
		"no such text":                func() error { _, err := s.ReplaceAgentBook(ctx, u.ID, "nope", "", "", "x"); return err }(),
	} {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: %v, want not found", name, err)
		}
	}
	if _, err := s.ReplaceAgentBook(ctx, u.ID, a.ID, "", "", " \n"); err == nil {
		t.Error("empty text accepted")
	}
	if _, err := s.ReplaceAgentBook(ctx, u.ID, a.ID, "", "", strings.Repeat("x", MaxBookChars+1)); !errors.Is(err, ErrTooLong) {
		t.Errorf("too long: %v", err)
	}
	if b, _ := s.GetBook(ctx, u.ID, mine.ID); b.Content != "My own notes." {
		t.Fatalf("the user's own text changed: %q", b.Content)
	}
}

func TestBookTTL(t *testing.T) {
	s := newTestStore(t)
	ctx := t.Context()
	u, _ := s.CreateUser(ctx, "ttl@example.com", "", "password 12345", false)
	in := func(b *Book) time.Duration {
		at, err := time.Parse(time.RFC3339, b.ExpiresAt)
		if err != nil {
			t.Fatalf("expiresAt %q: %v", b.ExpiresAt, err)
		}
		return time.Until(at)
	}
	near := func(d, want time.Duration) bool { return d > want-time.Minute && d <= want }

	mine, _ := s.CreateBook(ctx, u.ID, "Mine", "text", "Kept forever.")
	if mine.ExpiresAt != "" {
		t.Fatalf("a new text expires by default: %q", mine.ExpiresAt)
	}
	b, err := s.SetBookTTL(ctx, u.ID, mine.ID, 7*24*time.Hour)
	if err != nil || !near(in(b), 7*24*time.Hour) {
		t.Fatalf("ttl 7 days: %+v, %v", b, err)
	}
	if b, _ = s.SetBookTTL(ctx, u.ID, mine.ID, 0); b.ExpiresAt != "" {
		t.Fatalf("ttl 0 should keep it forever: %q", b.ExpiresAt)
	}
	if _, err := s.SetBookTTL(ctx, u.ID, mine.ID, -time.Hour); err == nil {
		t.Fatal("negative ttl accepted")
	}
	if _, err := s.SetBookTTL(ctx, u.ID, "nope", time.Hour); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing text: %v", err)
	}

	// Agents' texts: 30 days, renewed by an addition, never shortened or added to a kept text.
	a, _ := s.CreateAgentBook(ctx, u.ID, "Agent", "markdown", "Part one.", AgentTTL)
	if !near(in(a), AgentTTL) {
		t.Fatalf("agent text expires in %v", in(a))
	}
	s.db.ExecContext(ctx, `UPDATE books SET expires_at = ? WHERE id = ?`, expiry(24*time.Hour), a.ID)
	if a, _ = s.AppendAgentBook(ctx, u.ID, a.ID, "Part two."); !near(in(a), AgentTTL) {
		t.Fatalf("adding should renew to 30 days, got %v", in(a))
	}
	s.SetBookTTL(ctx, u.ID, a.ID, 90*24*time.Hour)
	if a, _ = s.AppendAgentBook(ctx, u.ID, a.ID, "Part three."); !near(in(a), 90*24*time.Hour) {
		t.Fatalf("adding shortened a 90-day ttl to %v", in(a))
	}
	s.SetBookTTL(ctx, u.ID, a.ID, 0)
	if a, _ = s.AppendAgentBook(ctx, u.ID, a.ID, "Part four."); a.ExpiresAt != "" {
		t.Fatalf("adding gave a kept text a ttl: %q", a.ExpiresAt)
	}

	// Expired: gone from every read at once, deleted by the sweep.
	old, _ := s.CreateAgentBook(ctx, u.ID, "Old", "markdown", "Old news.", AgentTTL)
	s.db.ExecContext(ctx, `UPDATE books SET expires_at = ? WHERE id = ?`, time.Now().Add(-time.Minute).UTC().Format(time.RFC3339), old.ID)
	if _, err := s.GetBook(ctx, u.ID, old.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired text still readable: %v", err)
	}
	for _, list := range [][]Book{must(s.ListBooks(ctx, u.ID)), must(s.ListAgentBooks(ctx, u.ID))} {
		for _, b := range list {
			if b.ID == old.ID {
				t.Fatal("expired text still listed")
			}
		}
	}
	if _, err := s.AppendAgentBook(ctx, u.ID, old.ID, "more"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("added to an expired text: %v", err)
	}
	if n, err := s.DeleteExpiredBooks(ctx); err != nil || n != 1 {
		t.Fatalf("sweep deleted %d, %v", n, err)
	}
	if list, _ := s.ListBooks(ctx, u.ID); len(list) != 2 {
		t.Fatalf("sweep left %d texts, want 2", len(list))
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
