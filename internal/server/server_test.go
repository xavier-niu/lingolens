package server

import (
	"archive/zip"
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/xavier-niu/lingolens/internal/store"
)

const testPassword = "correct horse battery"

type env struct {
	srv *httptest.Server
	st  *store.Store
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"), bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	static := fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>LingoLens</title>")}}
	srv := httptest.NewServer(New(Options{Store: st, Static: static, AllowFake: true, AllowPrivateFetch: true}).Handler())
	t.Cleanup(srv.Close)
	return &env{srv, st}
}

// client returns an HTTP client with its own cookie jar (a separate browser).
func (e *env) client() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar}
}

// signIn creates an account, signs in, and selects the fake model.
func (e *env) signIn(t *testing.T, email string, admin bool) *http.Client {
	t.Helper()
	if _, err := e.st.CreateUser(t.Context(), email, "", testPassword, admin); err != nil {
		t.Fatal(err)
	}
	c := e.client()
	resp := e.do(t, c, "POST", "/api/auth/login", map[string]string{"email": email, "password": testPassword})
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("login %s: %d", email, resp.StatusCode)
	}
	resp = e.do(t, c, "PUT", "/api/me/model", map[string]string{"preset": "fake", "kind": "fake"})
	resp.Body.Close()
	return c
}

func (e *env) do(t *testing.T, c *http.Client, method, path string, body any) *http.Response {
	t.Helper()
	var r io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		r = strings.NewReader(b)
	default:
		buf, _ := json.Marshal(b)
		r = bytes.NewReader(buf)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, r)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func status(t *testing.T, resp *http.Response) int {
	t.Helper()
	resp.Body.Close()
	return resp.StatusCode
}

func decodeJSON[T any](t *testing.T, resp *http.Response) T {
	t.Helper()
	defer resp.Body.Close()
	var v T
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return v
}

func readEvents(t *testing.T, resp *http.Response) []map[string]any {
	t.Helper()
	defer resp.Body.Close()
	var out []map[string]any
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		var ev map[string]any
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatalf("bad ndjson line %q: %v", sc.Text(), err)
		}
		out = append(out, ev)
	}
	return out
}

// ---------------------------------------------------------------- accounts

func TestConfigAndStatic(t *testing.T) {
	e := newEnv(t)
	cfg := decodeJSON[struct {
		Levels     []struct{ ID string } `json:"levels"`
		NeedsSetup bool                  `json:"needs_setup"`
	}](t, e.do(t, e.client(), "GET", "/api/config", nil))
	if len(cfg.Levels) != 6 || !cfg.NeedsSetup {
		t.Fatalf("config = %+v", cfg)
	}
	if status(t, e.do(t, e.client(), "GET", "/", nil)) != 200 {
		t.Fatal("static index not served")
	}
}

func TestSignInAndOut(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	if status(t, e.do(t, c, "GET", "/api/me", nil)) != 401 {
		t.Fatal("me without a session should be 401")
	}
	if _, err := e.st.CreateUser(t.Context(), "a@example.com", "Ada", testPassword, false); err != nil {
		t.Fatal(err)
	}
	if status(t, e.do(t, c, "POST", "/api/auth/login", map[string]string{"email": "a@example.com", "password": "nope nope"})) != 401 {
		t.Fatal("wrong password accepted")
	}
	resp := e.do(t, c, "POST", "/api/auth/login", map[string]string{"email": "A@Example.com", "password": testPassword})
	cookie := resp.Header.Get("Set-Cookie")
	if status(t, resp) != 200 || !strings.Contains(cookie, "HttpOnly") || !strings.Contains(cookie, "SameSite=Lax") {
		t.Fatalf("login cookie = %q", cookie)
	}
	me := decodeJSON[struct {
		User store.User `json:"user"`
	}](t, e.do(t, c, "GET", "/api/me", nil))
	if me.User.Email != "a@example.com" || me.User.Name != "Ada" {
		t.Fatalf("me = %+v", me)
	}
	if status(t, e.do(t, c, "POST", "/api/auth/logout", map[string]string{})) != 200 {
		t.Fatal("logout failed")
	}
	if status(t, e.do(t, c, "GET", "/api/me", nil)) != 401 {
		t.Fatal("still signed in after logout")
	}
}

func TestFirstRunSetup(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	setup := func(c *http.Client, email, pw string) *http.Response {
		return e.do(t, c, "POST", "/api/auth/setup", map[string]string{"email": email, "password": pw})
	}
	if got := status(t, setup(c, "admin@example.com", "short")); got != 400 {
		t.Fatalf("short password: status %d, want 400", got)
	}
	if got := status(t, setup(c, "not an email", testPassword)); got != 400 {
		t.Fatalf("bad email: status %d, want 400", got)
	}
	if got := status(t, setup(c, "Admin@Example.com", testPassword)); got != 201 {
		t.Fatalf("setup: status %d, want 201", got)
	}
	me := decodeJSON[struct {
		User store.User `json:"user"`
	}](t, e.do(t, c, "GET", "/api/me", nil))
	if me.User.Email != "admin@example.com" || !me.User.IsAdmin {
		t.Fatalf("setup should sign in as the new admin, got %+v", me.User)
	}
	// Done once: nobody can use it again, signed in or not.
	if got := status(t, setup(e.client(), "intruder@example.com", testPassword)); got != 409 {
		t.Fatalf("second setup: status %d, want 409", got)
	}
	if got := status(t, setup(c, "intruder@example.com", testPassword)); got != 409 {
		t.Fatalf("setup while signed in: status %d, want 409", got)
	}
	cfg := decodeJSON[struct {
		NeedsSetup bool `json:"needs_setup"`
	}](t, e.do(t, e.client(), "GET", "/api/config", nil))
	if cfg.NeedsSetup {
		t.Fatal("config still says the server needs setup")
	}
	if n, _ := e.st.CountUsers(t.Context()); n != 1 {
		t.Fatalf("%d accounts, want 1", n)
	}
}

func TestPrefs(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "p@example.com", false)
	me := decodeJSON[struct {
		User store.User `json:"user"`
	}](t, e.do(t, c, "GET", "/api/me", nil))
	if got := me.User.Prefs; got != (store.Prefs{Level: "B1", Lang: "en", ReadSize: "m", ReadWidth: "m", Theme: "system", ReadFont: "literata", GlossFont: "sans"}) {
		t.Fatalf("default prefs = %+v", got)
	}
	got := decodeJSON[store.Prefs](t, e.do(t, c, "PUT", "/api/me/prefs", map[string]string{"theme": "dark", "level": "C1"}))
	if got.Theme != "dark" || got.Level != "C1" || got.Lang != "en" {
		t.Fatalf("after update = %+v", got)
	}
	got = decodeJSON[store.Prefs](t, e.do(t, c, "PUT", "/api/me/prefs", map[string]string{"readWidth": "w"}))
	if got.ReadWidth != "w" || got.Theme != "dark" {
		t.Fatalf("after width update = %+v", got)
	}
	got = decodeJSON[store.Prefs](t, e.do(t, c, "PUT", "/api/me/prefs", map[string]string{"readFont": "legible", "glossFont": "kai", "readSize": "sm"}))
	if got.ReadFont != "legible" || got.GlossFont != "kai" || got.ReadSize != "sm" || got.ReadWidth != "w" {
		t.Fatalf("after font update = %+v", got)
	}
	// Unknown values are ignored rather than stored.
	got = decodeJSON[store.Prefs](t, e.do(t, c, "PUT", "/api/me/prefs", map[string]string{"theme": "purple", "lang": "fr", "readWidth": "huge", "readFont": "comic", "glossFont": "x"}))
	if got.Theme != "dark" || got.Lang != "en" || got.ReadWidth != "w" || got.ReadFont != "legible" || got.GlossFont != "kai" {
		t.Fatalf("invalid values stored: %+v", got)
	}
	me = decodeJSON[struct {
		User store.User `json:"user"`
	}](t, e.do(t, c, "GET", "/api/me", nil))
	if me.User.Prefs.Theme != "dark" {
		t.Fatalf("theme not persisted: %+v", me.User.Prefs)
	}
}

func TestLoginIsThrottled(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	bad := map[string]string{"email": "x@example.com", "password": "wrong password"}
	for range loginMaxFailures {
		status(t, e.do(t, c, "POST", "/api/auth/login", bad))
	}
	if got := status(t, e.do(t, c, "POST", "/api/auth/login", bad)); got != 429 {
		t.Fatalf("after %d failures: %d, want 429", loginMaxFailures, got)
	}
}

func TestCrossSiteWritesBlocked(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "a@example.com", false)
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/books", strings.NewReader("title=x"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if resp, _ := c.Do(req); status(t, resp) != 415 {
		t.Fatal("form-encoded POST accepted")
	}
	req, _ = http.NewRequest("DELETE", e.srv.URL+"/api/known", nil)
	req.Header.Set("Origin", "https://evil.example")
	if resp, _ := c.Do(req); status(t, resp) != 403 {
		t.Fatal("cross-origin DELETE accepted")
	}
}

func TestUsersCannotSeeEachOthersData(t *testing.T) {
	e := newEnv(t)
	a := e.signIn(t, "a@example.com", false)
	b := e.signIn(t, "b@example.com", false)
	book := decodeJSON[store.Book](t, e.do(t, a, "POST", "/api/books", map[string]string{"content": "A private letter\n\nHello."}))
	if book.Title != "A private letter" {
		t.Fatalf("book = %+v", book)
	}
	if status(t, e.do(t, b, "GET", "/api/books/"+book.ID, nil)) != 404 {
		t.Fatal("b read a's book")
	}
	if status(t, e.do(t, b, "PUT", "/api/books/"+book.ID+"/progress", map[string]float64{"pos": .5, "progress": .5})) != 404 {
		t.Fatal("b wrote a's progress")
	}
	if status(t, e.do(t, b, "DELETE", "/api/books/"+book.ID, nil)) != 404 {
		t.Fatal("b deleted a's book")
	}
	if list := decodeJSON[[]store.Book](t, e.do(t, b, "GET", "/api/books", nil)); len(list) != 0 {
		t.Fatal("b sees a's books")
	}
	status(t, e.do(t, a, "PUT", "/api/wordbook/mitigate", map[string]string{"lemma": "mitigate"}))
	if wb := decodeJSON[[]json.RawMessage](t, e.do(t, b, "GET", "/api/wordbook", nil)); len(wb) != 0 {
		t.Fatal("b sees a's wordbook")
	}
	if list := decodeJSON[[]store.Book](t, e.do(t, a, "GET", "/api/books", nil)); len(list) != 1 {
		t.Fatal("a lost their book")
	}
}

func TestAPIKeyIsNeverSentBack(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "a@example.com", false)
	key := "sk-top-secret-value"
	resp := e.do(t, c, "PUT", "/api/me/model", map[string]any{"preset": "deepseek", "kind": "openai", "model": "deepseek-chat", "api_key": key})
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	me, _ := io.ReadAll(e.do(t, c, "GET", "/api/me", nil).Body)
	if bytes.Contains(body, []byte(key)) || bytes.Contains(me, []byte(key)) {
		t.Fatal("API key returned to the browser")
	}
	if !bytes.Contains(me, []byte(`"has_key":{"deepseek":true}`)) {
		t.Fatalf("me = %s", me)
	}
}

func TestAdminManagesAccounts(t *testing.T) {
	e := newEnv(t)
	admin := e.signIn(t, "admin@example.com", true)
	member := e.signIn(t, "m@example.com", false)
	if status(t, e.do(t, member, "GET", "/api/admin/users", nil)) != 403 {
		t.Fatal("member reached admin API")
	}
	created := decodeJSON[store.User](t, e.do(t, admin, "POST", "/api/admin/users",
		map[string]any{"email": "new@example.com", "password": testPassword}))
	if created.Email != "new@example.com" || created.IsAdmin {
		t.Fatalf("created = %+v", created)
	}
	if status(t, e.do(t, admin, "POST", "/api/admin/users", map[string]any{"email": "new@example.com", "password": testPassword})) != 409 {
		t.Fatal("duplicate email accepted")
	}
	if status(t, e.do(t, e.client(), "POST", "/api/auth/login", map[string]string{"email": "new@example.com", "password": testPassword})) != 200 {
		t.Fatal("new account can't sign in")
	}
	users := decodeJSON[[]store.User](t, e.do(t, admin, "GET", "/api/admin/users", nil))
	if len(users) != 3 {
		t.Fatalf("users = %d", len(users))
	}
	self := users[0].ID
	if status(t, e.do(t, admin, "DELETE", "/api/admin/users/"+itoa(self), nil)) != 400 {
		t.Fatal("admin deleted their own account")
	}
	if status(t, e.do(t, admin, "DELETE", "/api/admin/users/"+itoa(created.ID), nil)) != 200 {
		t.Fatal("admin couldn't delete an account")
	}
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

// ---------------------------------------------------------------- LLM features

func TestAnnotateStreamsSegments(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "a@example.com", false)
	resp := e.do(t, c, "POST", "/api/annotate", map[string]any{
		"level":    "B1",
		"segments": []map[string]string{{"id": "s0", "text": "By and large, extraordinary results take time."}, {"id": "s1", "text": "Short one."}},
	})
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/x-ndjson") {
		t.Fatalf("content-type %q", ct)
	}
	events := readEvents(t, resp)
	if events[len(events)-1]["type"] != "done" {
		t.Fatal("stream must end with done")
	}
	seen := map[string]int{}
	for _, ev := range events {
		if ev["type"] == "segment" {
			seen[ev["id"].(string)] = len(ev["annotations"].([]any))
		}
	}
	if seen["s0"] < 2 {
		t.Errorf("s0 annotations = %d, want phrase + word", seen["s0"])
	}
	if _, ok := seen["s1"]; !ok {
		t.Error("s1 should be reported (with zero annotations)")
	}
}

func TestAnnotateValidation(t *testing.T) {
	e := newEnv(t)
	if status(t, e.do(t, e.client(), "POST", "/api/annotate", map[string]any{"segments": []any{}})) != 401 {
		t.Fatal("annotate without a session should be 401")
	}
	c := e.signIn(t, "a@example.com", false)
	if got := status(t, e.do(t, c, "POST", "/api/annotate", "not json")); got != 400 {
		t.Errorf("bad json -> %d", got)
	}
	if got := status(t, e.do(t, c, "POST", "/api/annotate", map[string]any{"segments": []any{}})); got != 400 {
		t.Errorf("no segments -> %d", got)
	}
	// A user who hasn't chosen a model is told to.
	e.st.CreateUser(t.Context(), "nomodel@example.com", "", testPassword, false)
	n := e.client()
	status(t, e.do(t, n, "POST", "/api/auth/login", map[string]string{"email": "nomodel@example.com", "password": testPassword}))
	resp := e.do(t, n, "POST", "/api/annotate", map[string]any{"segments": []map[string]string{{"id": "a", "text": "hello there"}}})
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 400 || !bytes.Contains(body, []byte("Settings")) {
		t.Errorf("no model -> %d %s", resp.StatusCode, body)
	}
}

func TestChatStreams(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "a@example.com", false)
	events := readEvents(t, e.do(t, c, "POST", "/api/chat", map[string]any{
		"level": "B2", "passage": "The policy was, by and large, a success.", "selection": "by and large",
		"messages": []map[string]string{{"role": "user", "content": "这是什么意思？"}},
	}))
	var text strings.Builder
	for _, ev := range events {
		if ev["type"] == "delta" {
			text.WriteString(ev["text"].(string))
		}
	}
	if !strings.Contains(text.String(), "这是什么意思？") || events[len(events)-1]["type"] != "done" {
		t.Fatalf("unexpected chat output %q", text.String())
	}
}

func TestChatValidation(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "a@example.com", false)
	bad := []map[string]any{
		{"selection": "", "messages": []map[string]string{{"role": "user", "content": "q"}}},
		{"selection": "x", "messages": []any{}},
		{"selection": "x", "messages": []map[string]string{{"role": "assistant", "content": "q"}}},
		{"selection": "x", "messages": []map[string]string{{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}}},
	}
	for _, body := range bad {
		if got := status(t, e.do(t, c, "POST", "/api/chat", body)); got != 400 {
			t.Errorf("%v -> %d, want 400", body, got)
		}
	}
}

func TestLookup(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "a@example.com", false)
	resp := e.do(t, c, "POST", "/api/lookup", map[string]string{"level": "C1", "term": "harbour", "sentence": "Ships harbour here."})
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	entry := decodeJSON[struct {
		Lemma, ZH string
		Examples  []struct{ EN, ZH string }
	}](t, resp)
	if entry.Lemma != "harbour" || entry.ZH == "" || len(entry.Examples) == 0 {
		t.Fatalf("entry = %+v", entry)
	}
	if status(t, e.do(t, c, "POST", "/api/lookup", map[string]string{"term": "  "})) != 400 {
		t.Fatal("empty term accepted")
	}
}

func TestClipAround(t *testing.T) {
	passage := strings.Repeat("a", 5000) + "TARGET" + strings.Repeat("b", 5000)
	got := clipAround(passage, "TARGET", 1000)
	if !strings.Contains(got, "TARGET") || len([]rune(got)) > 1002 {
		t.Fatalf("clip lost selection or too long: %d", len([]rune(got)))
	}
}

// ---------------------------------------------------------------- imports

func TestImportWebPage(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "w@example.com", false)
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(`<html><head><title>A Quiet Morning</title></head><body><nav>Menu Login</nav><article>
			<h1>A Quiet Morning</h1>
			<p>The street was empty when she stepped outside, and the air still carried the cool smell of last night's rain on the pavement.</p>
			<p>She walked to the bakery on the corner, where the owner was just turning on the lights and stacking fresh loaves in the window.</p>
			<p>It was the kind of morning that made the whole city feel like a small town, if only for an hour or so before the traffic began.</p>
			</article></body></html>`))
	}))
	defer site.Close()

	resp := e.do(t, c, "POST", "/api/books/import/url", map[string]string{"url": site.URL + "/story"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("import: %d", status(t, resp))
	}
	b := decodeJSON[store.Book](t, resp)
	if b.Title != "A Quiet Morning" || b.Format != "markdown" || b.Words < 50 {
		t.Fatalf("book = %+v", b)
	}
	got := decodeJSON[store.Book](t, e.do(t, c, "GET", "/api/books/"+b.ID, nil))
	if !strings.Contains(got.Content, "the bakery on the corner") || strings.Contains(got.Content, "Login") {
		t.Fatalf("content = %q", got.Content)
	}

	resp = e.do(t, c, "POST", "/api/books/import/url", map[string]string{"url": "not a link at all", "title": "x"})
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("bad link: %d", status(t, resp))
	}
	msg := decodeJSON[map[string]string](t, resp)["error"]
	if !strings.Contains(msg, "web address") && !strings.Contains(msg, "website") {
		t.Fatalf("bad link message = %q", msg)
	}
}

func TestImportPageFromBrowser(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "p@example.com", false)
	page := `<!doctype html><html><head><title>Rain on the Coast | Weekly</title></head><body>
		<nav>Menu Login Subscribe</nav><article><h1>Rain on the Coast</h1>
		<p>The rain arrived in the afternoon, soft at first and then heavy enough to empty the beach of everyone but the gulls.</p>
		<p>Down by the harbour, fishermen pulled their boats higher onto the sand and tied them to the old iron rings in the wall.</p>
		<p>By evening the storm had passed, and the whole town came out to walk along the shining, washed-clean promenade.</p>
		</article><footer>All rights reserved</footer></body></html>`

	resp := e.do(t, c, "POST", "/api/books/import/page", map[string]string{"url": "https://weekly.example/rain", "html": page})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("import: %d", status(t, resp))
	}
	b := decodeJSON[store.Book](t, resp)
	got := decodeJSON[store.Book](t, e.do(t, c, "GET", "/api/books/"+b.ID, nil))
	if !strings.Contains(got.Title, "Rain on the Coast") || got.Format != "markdown" ||
		!strings.Contains(got.Content, "old iron rings") || strings.Contains(got.Content, "Subscribe") {
		t.Fatalf("book = %+v", got)
	}

	// With a selection, only that part is kept, under the page's title.
	resp = e.do(t, c, "POST", "/api/books/import/page", map[string]string{
		"url": "https://weekly.example/rain", "title": "Rain on the Coast | Weekly",
		"selection": "<p>By evening the storm had passed.</p>"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("selection: %d", status(t, resp))
	}
	b = decodeJSON[store.Book](t, resp)
	got = decodeJSON[store.Book](t, e.do(t, c, "GET", "/api/books/"+b.ID, nil))
	if got.Title != "Rain on the Coast | Weekly" || got.Content != "By evening the storm had passed." {
		t.Fatalf("selection book = %+v", got)
	}

	for name, body := range map[string]map[string]string{
		"no article":  {"url": "https://weekly.example/", "html": "<html><body><nav>Home</nav></body></html>"},
		"bad address": {"url": "file:///etc/passwd", "html": page},
	} {
		if code := status(t, e.do(t, c, "POST", "/api/books/import/page", body)); code != http.StatusUnprocessableEntity {
			t.Errorf("%s: %d", name, code)
		}
	}

	// Other sites can't post pages to the shelf with the reader's cookie.
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/books/import/page", strings.NewReader(`{"url":"https://x.example/","html":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://weekly.example")
	if resp, _ := c.Do(req); status(t, resp) != http.StatusForbidden {
		t.Fatal("cross-site page import accepted")
	}
	if code := status(t, e.do(t, http.DefaultClient, "POST", "/api/books/import/page", map[string]string{"url": "https://weekly.example/", "html": page})); code != http.StatusUnauthorized {
		t.Fatalf("signed out: %d", code)
	}
}

func TestImportEPUB(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "e@example.com", false)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range map[string]string{
		"META-INF/container.xml": `<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>`,
		"book.opf": `<package><metadata><title>Tiny Tales</title></metadata>
			<manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest>
			<spine><itemref idref="a"/></spine></package>`,
		"a.xhtml": `<html><body><h1>One</h1><p>Once upon a time there was a fox.</p></body></html>`,
	} {
		w, _ := zw.Create(name)
		w.Write([]byte(body))
	}
	zw.Close()

	upload := func(ctype, query string, body []byte) *http.Response {
		req, _ := http.NewRequest("POST", e.srv.URL+"/api/books/import/epub"+query, bytes.NewReader(body))
		req.Header.Set("Content-Type", ctype)
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	resp := upload("application/epub+zip", "", buf.Bytes())
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("upload: %d", status(t, resp))
	}
	b := decodeJSON[store.Book](t, resp)
	if b.Title != "Tiny Tales" || b.Format != "markdown" {
		t.Fatalf("book = %+v", b)
	}
	b = decodeJSON[store.Book](t, upload("application/epub+zip", "?title=My+Copy", buf.Bytes()))
	if b.Title != "My Copy" {
		t.Fatalf("title override = %q", b.Title)
	}
	if got := status(t, upload("application/epub+zip", "", []byte("not a zip"))); got != http.StatusUnprocessableEntity {
		t.Fatalf("junk upload: %d", got)
	}
	// Form encodings (what a cross-site form could send) are still refused.
	if got := status(t, upload("multipart/form-data; boundary=x", "", buf.Bytes())); got != http.StatusUnsupportedMediaType {
		t.Fatalf("multipart upload: %d", got)
	}
	// The EPUB content type is only accepted on the upload route.
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/books", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/epub+zip")
	resp, _ = c.Do(req)
	if status(t, resp) != http.StatusUnsupportedMediaType {
		t.Fatal("epub content type accepted elsewhere")
	}
	// Signed-out uploads are refused.
	req, _ = http.NewRequest("POST", e.srv.URL+"/api/books/import/epub", bytes.NewReader(buf.Bytes()))
	req.Header.Set("Content-Type", "application/epub+zip")
	resp, _ = http.DefaultClient.Do(req)
	if status(t, resp) != http.StatusUnauthorized {
		t.Fatal("anonymous upload accepted")
	}
}

func TestPastedMarkdownDetected(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "m@example.com", false)
	b := decodeJSON[store.Book](t, e.do(t, c, "POST", "/api/books", map[string]string{"content": "# Notes\n\nSome text.", "format": "auto"}))
	if b.Format != "markdown" {
		t.Fatalf("format = %q", b.Format)
	}
	b = decodeJSON[store.Book](t, e.do(t, c, "PUT", "/api/books/"+b.ID, map[string]string{"content": "Plain words now."}))
	if b.Format != "markdown" {
		t.Fatalf("edit without a format changed it to %q", b.Format)
	}
	b = decodeJSON[store.Book](t, e.do(t, c, "PUT", "/api/books/"+b.ID, map[string]string{"content": "Plain words now.", "format": "text"}))
	if b.Format != "text" {
		t.Fatalf("explicit format ignored: %q", b.Format)
	}
}

// ---------------------------------------------------------------- agent API

func TestAgentAPI(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "agent@example.com", false)
	other := e.signIn(t, "other@example.com", false)

	created := decodeJSON[struct {
		Token string           `json:"token"`
		Info  store.AgentToken `json:"info"`
	}](t, e.do(t, c, "POST", "/api/me/tokens", map[string]string{"name": "Claude Code"}))
	if !strings.HasPrefix(created.Token, "llat_") || created.Info.Name != "Claude Code" {
		t.Fatalf("created = %+v", created)
	}
	list := decodeJSON[[]map[string]any](t, e.do(t, c, "GET", "/api/me/tokens", nil))
	if len(list) != 1 || list[0]["token"] != nil {
		t.Fatalf("token list = %+v (the token itself must never be listed)", list)
	}

	agent := func(method, path, ctype, token string, body string) *http.Response {
		req, _ := http.NewRequest(method, e.srv.URL+path, strings.NewReader(body))
		if ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req) // no cookies: a script, not a browser
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	who := decodeJSON[map[string]any](t, agent("GET", "/api/agent/whoami", "", created.Token, ""))
	if who["user"] != "agent@example.com" {
		t.Fatalf("whoami = %+v", who)
	}

	// Raw Markdown.
	resp := agent("POST", "/api/agent/texts?title=Phrasal+Verbs", "text/markdown", created.Token, "# Phrasal verbs\n\n- **give up**: stop trying\n- **look into**: investigate\n")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("upload: %d", status(t, resp))
	}
	up := decodeJSON[map[string]any](t, resp)
	if up["title"] != "Phrasal Verbs" || up["format"] != "markdown" || !strings.HasPrefix(up["url"].(string), e.srv.URL+"/#/read/") {
		t.Fatalf("upload = %+v", up)
	}
	// JSON.
	up = decodeJSON[map[string]any](t, agent("POST", "/api/agent/texts", "application/json", created.Token, `{"markdown": "## Hello\n\nA short reply."}`))
	if up["title"] != "Hello" {
		t.Fatalf("json upload = %+v", up)
	}
	// Both are on the owner's shelf, not anyone else's.
	if books := decodeJSON[[]store.Book](t, e.do(t, c, "GET", "/api/books", nil)); len(books) != 2 {
		t.Fatalf("owner has %d books", len(books))
	}
	if books := decodeJSON[[]store.Book](t, e.do(t, other, "GET", "/api/books", nil)); len(books) != 0 {
		t.Fatal("another user sees the agent's texts")
	}

	// Refusals.
	for name, tc := range map[string]struct {
		resp *http.Response
		want int
	}{
		"no token":         {agent("POST", "/api/agent/texts", "text/markdown", "", "x"), 401},
		"wrong token":      {agent("POST", "/api/agent/texts", "text/markdown", "llat_nope", "x"), 401},
		"empty text":       {agent("POST", "/api/agent/texts", "text/markdown", created.Token, "  "), 400},
		"unsupported type": {agent("POST", "/api/agent/texts", "image/png", created.Token, "x"), 415},
		"token elsewhere":  {agent("GET", "/api/books", "", created.Token, ""), 401},
		"cookie on agent":  {e.do(t, c, "POST", "/api/agent/texts", map[string]string{"markdown": "x"}), 401},
	} {
		if got := status(t, tc.resp); got != tc.want {
			t.Errorf("%s: %d, want %d", name, got, tc.want)
		}
	}

	// Adding more to an agent's text: listed, appended after a --- line, same id.
	mine := decodeJSON[store.Book](t, e.do(t, c, "POST", "/api/books", map[string]string{"title": "My Notes", "content": "My own words."}))
	texts := decodeJSON[[]map[string]any](t, agent("GET", "/api/agent/texts", "", created.Token, ""))
	byTitle := map[any]map[string]any{}
	for _, x := range texts {
		byTitle[x["title"]] = x
	}
	if len(texts) != 2 || byTitle["Hello"] == nil || byTitle["Phrasal Verbs"] == nil || texts[0]["url"] == nil {
		t.Fatalf("agent texts = %+v (the user's own text must not be listed)", texts)
	}
	pv := byTitle["Phrasal Verbs"]["id"].(string)
	resp = agent("POST", "/api/agent/texts/"+pv+"/append?title=Ignored", "text/markdown", created.Token, "## More verbs\n\n- **put off**: delay\n")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("append: %d", status(t, resp))
	}
	if up = decodeJSON[map[string]any](t, resp); up["id"] != pv || up["title"] != "Phrasal Verbs" {
		t.Fatalf("append = %+v", up)
	}
	up = decodeJSON[map[string]any](t, agent("POST", "/api/agent/texts/"+pv+"/append", "application/json", created.Token, `{"markdown": "One more line."}`))
	book := decodeJSON[store.Book](t, e.do(t, c, "GET", "/api/books/"+pv, nil))
	if want := "investigate\n\n---\n\n## More verbs\n\n- **put off**: delay\n\n---\n\nOne more line."; !strings.HasSuffix(book.Content, want) {
		t.Fatalf("appended content = %q", book.Content)
	}
	otherTok := decodeJSON[struct {
		Token string `json:"token"`
	}](t, e.do(t, other, "POST", "/api/me/tokens", map[string]string{"name": "Other"})).Token
	if texts = decodeJSON[[]map[string]any](t, agent("GET", "/api/agent/texts", "", otherTok, "")); len(texts) != 0 {
		t.Fatalf("another user's agent sees %+v", texts)
	}
	for name, tc := range map[string]struct {
		resp *http.Response
		want int
	}{
		"the user's own text":  {agent("POST", "/api/agent/texts/"+mine.ID+"/append", "text/markdown", created.Token, "x"), 404},
		"another user's agent": {agent("POST", "/api/agent/texts/"+pv+"/append", "text/markdown", otherTok, "x"), 404},
		"no such text":         {agent("POST", "/api/agent/texts/nope/append", "text/markdown", created.Token, "x"), 404},
		"empty addition":       {agent("POST", "/api/agent/texts/"+pv+"/append", "text/markdown", created.Token, " "), 400},
		"no token":             {agent("POST", "/api/agent/texts/"+pv+"/append", "text/markdown", "", "x"), 401},
		"no token, list":       {agent("GET", "/api/agent/texts", "", "", ""), 401},
		"cookie on append":     {e.do(t, c, "POST", "/api/agent/texts/"+pv+"/append", map[string]string{"markdown": "x"}), 401},
		"too long together":    {agent("POST", "/api/agent/texts/"+pv+"/append", "text/markdown", created.Token, strings.Repeat("x", store.MaxBookChars)), 413},
	} {
		if got := status(t, tc.resp); got != tc.want {
			t.Errorf("%s: %d, want %d", name, got, tc.want)
		}
	}

	// Reading and rewriting an agent's text: same id and link, a title renames it.
	got := decodeJSON[map[string]any](t, agent("GET", "/api/agent/texts/"+pv, "", created.Token, ""))
	if got["id"] != pv || !strings.HasSuffix(got["markdown"].(string), "One more line.") || got["url"] == nil {
		t.Fatalf("get = %+v", got)
	}
	req, _ := http.NewRequest("GET", e.srv.URL+"/api/agent/texts/"+pv, nil)
	req.Header.Set("Authorization", "Bearer "+created.Token)
	req.Header.Set("Accept", "text/markdown")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/markdown") || string(raw) != got["markdown"] {
		t.Fatalf("markdown = %q (%s)", raw, resp.Header.Get("Content-Type"))
	}
	resp = agent("PUT", "/api/agent/texts/"+pv, "text/markdown", created.Token, "# Phrasal verbs\n\n- **give up**: stop trying\n")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("replace: %d", status(t, resp))
	}
	if up = decodeJSON[map[string]any](t, resp); up["id"] != pv || up["title"] != "Phrasal Verbs" || up["url"] != got["url"] {
		t.Fatalf("replace = %+v", up)
	}
	if book := decodeJSON[store.Book](t, e.do(t, c, "GET", "/api/books/"+pv, nil)); book.Content != "# Phrasal verbs\n\n- **give up**: stop trying\n" {
		t.Fatalf("replaced content = %q", book.Content)
	}
	up = decodeJSON[map[string]any](t, agent("PUT", "/api/agent/texts/"+pv, "application/json", created.Token, `{"title": "Verbs", "markdown": "Short now."}`))
	if up["title"] != "Verbs" {
		t.Fatalf("rename = %+v", up)
	}
	for name, tc := range map[string]struct {
		resp *http.Response
		want int
	}{
		"get the user's own text":     {agent("GET", "/api/agent/texts/"+mine.ID, "", created.Token, ""), 404},
		"replace the user's own text": {agent("PUT", "/api/agent/texts/"+mine.ID, "text/markdown", created.Token, "x"), 404},
		"another user's agent, get":   {agent("GET", "/api/agent/texts/"+pv, "", otherTok, ""), 404},
		"another user's agent, put":   {agent("PUT", "/api/agent/texts/"+pv, "text/markdown", otherTok, "x"), 404},
		"empty rewrite":               {agent("PUT", "/api/agent/texts/"+pv, "text/markdown", created.Token, " "), 400},
		"no token, get":               {agent("GET", "/api/agent/texts/"+pv, "", "", ""), 401},
		"cookie on get":               {e.do(t, c, "GET", "/api/agent/texts/"+pv, nil), 401},
		"cookie on put":               {e.do(t, c, "PUT", "/api/agent/texts/"+pv, map[string]string{"markdown": "x"}), 401},
		"too long":                    {agent("PUT", "/api/agent/texts/"+pv, "text/markdown", created.Token, strings.Repeat("x", store.MaxBookChars+1)), 413},
	} {
		if got := status(t, tc.resp); got != tc.want {
			t.Errorf("%s: %d, want %d", name, got, tc.want)
		}
	}
	if book := decodeJSON[store.Book](t, e.do(t, c, "GET", "/api/books/"+mine.ID, nil)); book.Content != "My own words." {
		t.Fatalf("the user's own text changed: %q", book.Content)
	}

	// Revoking stops it working; another user can't revoke it.
	id := strconv.FormatInt(created.Info.ID, 10)
	if status(t, e.do(t, other, "DELETE", "/api/me/tokens/"+id, nil)) != 404 {
		t.Fatal("another user revoked the token")
	}
	if status(t, e.do(t, c, "DELETE", "/api/me/tokens/"+id, nil)) != 200 {
		t.Fatal("revoke failed")
	}
	if status(t, agent("GET", "/api/agent/whoami", "", created.Token, "")) != 401 {
		t.Fatal("revoked token still works")
	}
}

func TestBookTTL(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "ttl@example.com", false)
	days := func(b store.Book) float64 {
		if b.ExpiresAt == "" {
			return 0
		}
		at, err := time.Parse(time.RFC3339, b.ExpiresAt)
		if err != nil {
			t.Fatal(err)
		}
		return math.Round(time.Until(at).Hours() / 24)
	}

	b := decodeJSON[store.Book](t, e.do(t, c, "POST", "/api/books", map[string]any{"content": "Forever."}))
	if b.ExpiresAt != "" {
		t.Fatalf("new text expires: %q", b.ExpiresAt)
	}
	b = decodeJSON[store.Book](t, e.do(t, c, "POST", "/api/books", map[string]any{"content": "A week.", "ttlDays": 7}))
	if days(b) != 7 {
		t.Fatalf("ttlDays 7 → %v days", days(b))
	}
	// Editing without ttlDays keeps it; with it, changes it.
	b = decodeJSON[store.Book](t, e.do(t, c, "PUT", "/api/books/"+b.ID, map[string]any{"content": "A week, edited."}))
	if days(b) != 7 {
		t.Fatalf("edit dropped the ttl: %q", b.ExpiresAt)
	}
	b = decodeJSON[store.Book](t, e.do(t, c, "PUT", "/api/books/"+b.ID, map[string]any{"content": "Kept.", "ttlDays": 0}))
	if b.ExpiresAt != "" {
		t.Fatalf("ttlDays 0 should keep it: %q", b.ExpiresAt)
	}
	b = decodeJSON[store.Book](t, e.do(t, c, "PUT", "/api/books/"+b.ID, map[string]any{"content": "Kept.", "ttlDays": 365}))
	if days(b) != 365 {
		t.Fatalf("ttlDays 365 → %v", days(b))
	}
	for name, body := range map[string]map[string]any{
		"negative": {"content": "x", "ttlDays": -1},
		"too long": {"content": "x", "ttlDays": 3651},
	} {
		if got := status(t, e.do(t, c, "POST", "/api/books", body)); got != 400 {
			t.Errorf("%s: %d, want 400", name, got)
		}
	}

	// Agents: 30 days unless they ask otherwise.
	tok := decodeJSON[struct {
		Token string `json:"token"`
	}](t, e.do(t, c, "POST", "/api/me/tokens", map[string]string{"name": "A"})).Token
	agent := func(path, body string) store.Book {
		req, _ := http.NewRequest("POST", e.srv.URL+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "text/markdown")
		req.Header.Set("Authorization", "Bearer "+tok)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return decodeJSON[store.Book](t, resp)
	}
	if b = agent("/api/agent/texts", "# Agent"); days(b) != 30 {
		t.Fatalf("agent text: %v days", days(b))
	}
	if b = agent("/api/agent/texts?ttlDays=0", "# Kept"); b.ExpiresAt != "" {
		t.Fatalf("agent ttlDays=0: %q", b.ExpiresAt)
	}
	if b = agent("/api/agent/texts?ttlDays=3", "# Short"); days(b) != 3 {
		t.Fatalf("agent ttlDays=3: %v", days(b))
	}
	if b = agent("/api/agent/texts/"+b.ID+"/append", "More."); days(b) != 30 {
		t.Fatalf("adding should renew to 30 days: %v", days(b))
	}
}

func TestSkillDownload(t *testing.T) {
	e := newEnv(t)
	resp := e.do(t, e.client(), "GET", "/skills/lingolens.zip", nil)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/zip" {
		t.Fatalf("skill zip: %d %s", status(t, resp), resp.Header.Get("Content-Type"))
	}
	data, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, f := range zr.File {
		found[f.Name] = true
		if f.Name == "lingolens/scripts/upload.sh" && f.Mode()&0o111 == 0 {
			t.Error("upload.sh is not executable")
		}
	}
	if !found["lingolens/SKILL.md"] || !found["lingolens/scripts/upload.sh"] {
		t.Fatalf("zip contents: %v", found)
	}
	if status(t, e.do(t, e.client(), "GET", "/skills/other.zip", nil)) != 404 {
		t.Fatal("unknown skill served")
	}
}

// Syncing offline changes: a retried create returns the first book, and a late
// reading position doesn't overwrite newer reading.
func TestOfflineSync(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "o@example.com", false)
	other := e.signIn(t, "p@example.com", false)
	body := map[string]string{"title": "On the Train", "content": "Written offline.", "clientRef": "local-abc123"}
	first := decodeJSON[store.Book](t, e.do(t, c, "POST", "/api/books", body))
	again := decodeJSON[store.Book](t, e.do(t, c, "POST", "/api/books", body))
	if again.ID != first.ID {
		t.Fatalf("retried create made a second book: %s, %s", first.ID, again.ID)
	}
	if books := decodeJSON[[]store.Book](t, e.do(t, c, "GET", "/api/books", nil)); len(books) != 1 {
		t.Fatalf("shelf has %d books", len(books))
	}
	theirs := decodeJSON[store.Book](t, e.do(t, other, "POST", "/api/books", body))
	if theirs.ID == first.ID {
		t.Fatal("another user's ref returned this user's book")
	}

	path := "/api/books/" + first.ID + "/progress"
	e.do(t, c, "PUT", path, map[string]any{"pos": .5, "progress": .5}).Body.Close()
	old := time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339)
	resp := e.do(t, c, "PUT", path, map[string]any{"pos": .9, "progress": .9, "at": old})
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("progress with at: %d", resp.StatusCode)
	}
	got := decodeJSON[store.Book](t, e.do(t, c, "GET", "/api/books/"+first.ID, nil))
	if got.Progress != .9 || got.Pos != .5 {
		t.Fatalf("late sync: progress %v pos %v", got.Progress, got.Pos)
	}
}

func TestChatHistory(t *testing.T) {
	e := newEnv(t)
	a := e.signIn(t, "a@example.com", false)
	b := e.signIn(t, "b@example.com", false)
	book := decodeJSON[map[string]any](t, e.do(t, a, "POST", "/api/books", map[string]string{"title": "Habits", "content": "Small habits compound over time."}))
	turn := []map[string]string{{"role": "user", "content": "Translate this"}, {"role": "assistant", "content": "习惯会累积。"}}
	save := map[string]any{"bookId": book["id"], "selection": "compound", "passage": "Small habits compound over time.", "messages": turn}

	c := decodeJSON[map[string]any](t, e.do(t, a, "PUT", "/api/chats/abcd1234", save))
	if c["bookTitle"] != "Habits" || c["question"] != "Translate this" || c["messages"] != nil {
		t.Fatalf("saved: %v", c)
	}
	list := decodeJSON[[]map[string]any](t, e.do(t, a, "GET", "/api/chats?book="+book["id"].(string), nil))
	if len(list) != 1 || list[0]["id"] != "abcd1234" {
		t.Fatalf("list: %v", list)
	}
	full := decodeJSON[map[string]any](t, e.do(t, a, "GET", "/api/chats/abcd1234", nil))
	if msgs, _ := full["messages"].([]any); len(msgs) != 2 || full["passage"] == "" {
		t.Fatalf("get: %v", full)
	}
	if got := status(t, e.do(t, b, "GET", "/api/chats/abcd1234", nil)); got != 404 {
		t.Fatalf("another account read the chat: %d", got)
	}
	if got := status(t, e.do(t, b, "DELETE", "/api/chats/abcd1234", nil)); got != 404 {
		t.Fatalf("another account deleted the chat: %d", got)
	}

	bad := []struct {
		id   string
		body map[string]any
	}{
		{"short", save},
		{"abcd1234", map[string]any{"selection": "x", "messages": turn[:1]}},                              // no answer yet
		{"abcd1234", map[string]any{"selection": "", "messages": turn}},                                   // no selection
		{"abcd1234", map[string]any{"selection": "x", "messages": []map[string]string{turn[1], turn[0]}}}, // wrong order
	}
	for _, tc := range bad {
		if got := status(t, e.do(t, a, "PUT", "/api/chats/"+tc.id, tc.body)); got != 400 {
			t.Errorf("PUT %s %v: %d, want 400", tc.id, tc.body, got)
		}
	}
	if got := status(t, e.do(t, a, "DELETE", "/api/chats/abcd1234", nil)); got != 200 {
		t.Fatalf("delete: %d", got)
	}
	if list := decodeJSON[[]map[string]any](t, e.do(t, a, "GET", "/api/chats", nil)); len(list) != 0 {
		t.Fatalf("after delete: %v", list)
	}
}
