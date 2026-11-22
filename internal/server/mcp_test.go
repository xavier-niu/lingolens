package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/xavier-niu/lingolens/internal/store"
)

// bearer adds an agent token to every request, as an MCP client configured
// with an Authorization header does.
type bearer string

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+string(b))
	return http.DefaultTransport.RoundTrip(r)
}

func (e *env) mcpSession(t *testing.T, token string) (*mcp.ClientSession, error) {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "test-agent", Version: "1"}, nil)
	return client.Connect(t.Context(), &mcp.StreamableClientTransport{
		Endpoint:   e.srv.URL + "/mcp",
		HTTPClient: &http.Client{Transport: bearer(token)},
	}, nil)
}

// call runs a tool and decodes what it returned; failed reports a tool error.
func call[T any](t *testing.T, s *mcp.ClientSession, name string, args map[string]any) (out T, failed string) {
	t.Helper()
	res, err := s.CallTool(t.Context(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if res.IsError {
		var msg []string
		for _, c := range res.Content {
			if tc, ok := c.(*mcp.TextContent); ok {
				msg = append(msg, tc.Text)
			}
		}
		return out, strings.Join(msg, " ")
	}
	raw, _ := json.Marshal(res.StructuredContent)
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("%s: %v in %s", name, err, raw)
	}
	return out, ""
}

func TestMCP(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "mcp@example.com", false)
	token := decodeJSON[struct {
		Token string `json:"token"`
	}](t, e.do(t, c, "POST", "/api/me/tokens", map[string]string{"name": "Claude Code"})).Token
	own := decodeJSON[map[string]any](t, e.do(t, c, "POST", "/api/books", map[string]string{"title": "Mine", "content": "My own notes about the harbour."}))
	ownID := own["id"].(string)

	s, err := e.mcpSession(t, token)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	tools, err := s.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
	}
	slices.Sort(names)
	if want := []string{"create_book", "delete_book", "list_books", "show_book", "update_book"}; !slices.Equal(names, want) {
		t.Fatalf("tools = %v, want %v", names, want)
	}
	if inst := s.InitializeResult().Instructions; !strings.Contains(inst, "Chinese glosses") {
		t.Errorf("instructions = %q", inst)
	}

	// Create: titled from its heading, kept 30 days, with a link to the reader.
	type book struct {
		ID, Title, Format, URL, ExpiresAt, Markdown string
		Words                                       int
		Progress                                    float64
	}
	b, failed := call[book](t, s, "create_book", map[string]any{"markdown": "# Phrasal Verbs\n\n- **give up**: stop trying\n"})
	if failed != "" || b.Title != "Phrasal Verbs" || b.Format != "markdown" || b.ExpiresAt == "" || !strings.HasSuffix(b.URL, "/#/read/"+b.ID) {
		t.Fatalf("create_book = %+v %s", b, failed)
	}
	forever, _ := call[book](t, s, "create_book", map[string]any{"title": "Keep", "markdown": "Kept for good.", "ttlDays": 0})
	if forever.ExpiresAt != "" {
		t.Errorf("ttlDays 0: expiresAt = %q", forever.ExpiresAt)
	}
	if _, failed = call[book](t, s, "create_book", map[string]any{"markdown": "  "}); failed == "" {
		t.Error("an empty text was saved")
	}

	// Show, then add to its end, then rewrite and rename it.
	shown, _ := call[book](t, s, "show_book", map[string]any{"id": b.ID})
	if shown.Markdown != "# Phrasal Verbs\n\n- **give up**: stop trying\n" {
		t.Fatalf("show_book markdown = %q", shown.Markdown)
	}
	call[book](t, s, "update_book", map[string]any{"id": b.ID, "mode": "append", "markdown": "- **put off**: delay"})
	shown, _ = call[book](t, s, "show_book", map[string]any{"id": b.ID})
	if !strings.HasSuffix(shown.Markdown, store.AgentSeparator+"- **put off**: delay") || shown.Title != "Phrasal Verbs" {
		t.Fatalf("after append: %+v", shown)
	}
	renamed, failed := call[book](t, s, "update_book", map[string]any{"id": b.ID, "title": "Verbs", "markdown": "Rewritten."})
	if failed != "" || renamed.Title != "Verbs" || renamed.ID != b.ID {
		t.Fatalf("update_book replace = %+v %s", renamed, failed)
	}
	if _, failed = call[book](t, s, "update_book", map[string]any{"id": b.ID, "mode": "prepend", "markdown": "x"}); !strings.Contains(failed, "replace or append") {
		t.Errorf("unknown mode: %q", failed)
	}

	// The user's own text is out of reach: not listed, not shown, not changed, not deleted.
	list, _ := call[struct{ Books []book }](t, s, "list_books", nil)
	var listed []string
	for _, x := range list.Books {
		listed = append(listed, x.ID)
	}
	if len(listed) != 2 || slices.Contains(listed, ownID) || listed[0] != b.ID {
		t.Fatalf("list_books = %v (own %s)", listed, ownID)
	}
	for _, tc := range []struct {
		tool string
		args map[string]any
	}{
		{"show_book", map[string]any{"id": ownID}},
		{"update_book", map[string]any{"id": ownID, "markdown": "taken over"}},
		{"update_book", map[string]any{"id": ownID, "mode": "append", "markdown": "more"}},
		{"delete_book", map[string]any{"id": ownID}},
	} {
		if _, failed := call[book](t, s, tc.tool, tc.args); !strings.Contains(failed, "No text with this id was added by an agent") {
			t.Errorf("%s on the user's own text: %q", tc.tool, failed)
		}
	}
	if mine := decodeJSON[map[string]any](t, e.do(t, c, "GET", "/api/books/"+ownID, nil)); mine["content"] != "My own notes about the harbour." {
		t.Fatalf("the user's own text changed: %+v", mine)
	}

	// Delete: gone from the shelf too.
	del, failed := call[struct {
		ID      string
		Deleted bool
	}](t, s, "delete_book", map[string]any{"id": b.ID})
	if failed != "" || !del.Deleted {
		t.Fatalf("delete_book = %+v %s", del, failed)
	}
	if _, failed = call[book](t, s, "show_book", map[string]any{"id": b.ID}); failed == "" {
		t.Error("a deleted book is still shown")
	}
	if code := status(t, e.do(t, c, "GET", "/api/books/"+b.ID, nil)); code != http.StatusNotFound {
		t.Errorf("deleted book on the shelf: %d", code)
	}

	// Another user's token sees none of it; no token, or a bad one, gets nowhere.
	other := e.signIn(t, "other@example.com", false)
	otherToken := decodeJSON[struct {
		Token string `json:"token"`
	}](t, e.do(t, other, "POST", "/api/me/tokens", map[string]string{"name": "x"})).Token
	os, err := e.mcpSession(t, otherToken)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Close()
	if theirs, _ := call[struct{ Books []book }](t, os, "list_books", nil); len(theirs.Books) != 0 {
		t.Fatalf("another user's agent lists %+v", theirs.Books)
	}
	if _, failed = call[book](t, os, "show_book", map[string]any{"id": forever.ID}); failed == "" {
		t.Error("another user's agent read the text")
	}
	if _, err := e.mcpSession(t, "llat_nope"); err == nil {
		t.Error("a bad token connected")
	}
	req, _ := http.NewRequest("POST", e.srv.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("no token: %d", resp.StatusCode)
	}
	// A browser session isn't enough either.
	if code := status(t, e.do(t, c, "POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/list"})); code != http.StatusUnauthorized {
		t.Errorf("cookie on /mcp: %d", code)
	}
}

// list_books pages through the books agents saved, newest change first: each
// book once, with a cursor to the next page until the last.
func TestMCPListPages(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "pages@example.com", false)
	token := decodeJSON[struct {
		Token string `json:"token"`
	}](t, e.do(t, c, "POST", "/api/me/tokens", map[string]string{"name": "x"})).Token
	e.do(t, c, "POST", "/api/books", map[string]string{"title": "Mine", "content": "Not an agent's."}).Body.Close()
	s, err := e.mcpSession(t, token)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i := range 25 {
		if _, failed := call[map[string]any](t, s, "create_book", map[string]any{"title": "Book " + itoa(int64(i)), "markdown": "Some text."}); failed != "" {
			t.Fatal(failed)
		}
	}
	type page struct {
		Books []struct {
			ID, Title, UpdatedAt string
		}
		NextCursor string
		Total      int
	}
	seen := map[string]bool{}
	var sizes []int
	last := ""
	args := map[string]any{"limit": 10}
	for range 5 {
		p, failed := call[page](t, s, "list_books", args)
		if failed != "" {
			t.Fatal(failed)
		}
		if p.Total != 25 {
			t.Fatalf("total = %d (the user's own text doesn't count)", p.Total)
		}
		sizes = append(sizes, len(p.Books))
		for _, b := range p.Books {
			if seen[b.ID] {
				t.Fatalf("%s listed twice", b.Title)
			}
			seen[b.ID] = true
			if last != "" && b.UpdatedAt > last {
				t.Fatalf("not newest change first: %s after %s", b.UpdatedAt, last)
			}
			last = b.UpdatedAt
		}
		if p.NextCursor == "" {
			break
		}
		args = map[string]any{"limit": 10, "cursor": p.NextCursor}
	}
	if fmt.Sprint(sizes) != "[10 10 5]" || len(seen) != 25 {
		t.Fatalf("pages of %v, %d books", sizes, len(seen))
	}
	if p, _ := call[page](t, s, "list_books", nil); len(p.Books) != 20 || p.NextCursor == "" {
		t.Errorf("default page: %d books, cursor %q", len(p.Books), p.NextCursor)
	}
	if p, _ := call[page](t, s, "list_books", map[string]any{"limit": 500}); len(p.Books) != 25 || p.NextCursor != "" {
		t.Errorf("a limit over 100 lists at most 100: %d books, cursor %q", len(p.Books), p.NextCursor)
	}
	if _, failed := call[page](t, s, "list_books", map[string]any{"cursor": "not-a-cursor"}); !strings.Contains(failed, "without a cursor") {
		t.Errorf("bad cursor: %q", failed)
	}
}

// An agent notes its session id on the books it saves, and finds them again by
// it: over MCP and over the agent API.
func TestAgentNotes(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "notes@example.com", false)
	token := decodeJSON[struct {
		Token string `json:"token"`
	}](t, e.do(t, c, "POST", "/api/me/tokens", map[string]string{"name": "x"})).Token
	s, err := e.mcpSession(t, token)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	type book struct {
		ID, Title, Note, Markdown string
	}
	a, failed := call[book](t, s, "create_book", map[string]any{"title": "Coffee", "markdown": "Part one.", "note": "session: s-111"})
	if failed != "" || a.Note != "session: s-111" {
		t.Fatalf("create_book with a note = %+v %s", a, failed)
	}
	call[book](t, s, "create_book", map[string]any{"title": "Tea", "markdown": "Part one.", "note": "session: s-222"})
	call[book](t, s, "create_book", map[string]any{"title": "No note", "markdown": "Part one."})

	type page struct {
		Books []book
		Total int
	}
	mine, _ := call[page](t, s, "list_books", map[string]any{"note": "s-111"})
	if mine.Total != 1 || len(mine.Books) != 1 || mine.Books[0].ID != a.ID || mine.Books[0].Note != "session: s-111" {
		t.Fatalf("list_books by note = %+v", mine)
	}
	if all, _ := call[page](t, s, "list_books", nil); all.Total != 3 {
		t.Fatalf("without a note, all %d", all.Total)
	}
	if shown, _ := call[book](t, s, "show_book", map[string]any{"id": a.ID}); shown.Note != "session: s-111" {
		t.Fatalf("show_book note = %q", shown.Note)
	}
	// Adding keeps the note; a new note replaces it; an empty one removes it.
	if b, _ := call[book](t, s, "update_book", map[string]any{"id": a.ID, "mode": "append", "markdown": "Part two."}); b.Note != "session: s-111" {
		t.Fatalf("append kept note %q", b.Note)
	}
	if b, _ := call[book](t, s, "update_book", map[string]any{"id": a.ID, "markdown": "Rewritten.", "note": "session: s-333"}); b.Note != "session: s-333" {
		t.Fatalf("replace with a note: %q", b.Note)
	}
	if b, _ := call[book](t, s, "update_book", map[string]any{"id": a.ID, "mode": "append", "markdown": "More.", "note": ""}); b.Note != "" {
		t.Fatalf("an empty note: %q", b.Note)
	}
	if _, failed := call[book](t, s, "create_book", map[string]any{"markdown": "x", "note": strings.Repeat("n", 501)}); !strings.Contains(failed, "note is too long") {
		t.Errorf("a long note: %q", failed)
	}

	// The agent API: ?note= on raw Markdown, "note" in JSON, ?note= on the list.
	agent := func(method, path, ctype, body string) *http.Response {
		req, _ := http.NewRequest(method, e.srv.URL+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		if ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	raw := decodeJSON[map[string]any](t, agent("POST", "/api/agent/texts?title=Raw&note=run%2042", "text/markdown", "Some text."))
	js := decodeJSON[map[string]any](t, agent("POST", "/api/agent/texts", "application/json", `{"title": "JSON", "markdown": "Some text.", "note": "run 42, part 2"}`))
	if raw["note"] != "run 42" || js["note"] != "run 42, part 2" {
		t.Fatalf("notes: %v / %v", raw["note"], js["note"])
	}
	if found := decodeJSON[[]map[string]any](t, agent("GET", "/api/agent/texts?note=run+42", "", "")); len(found) != 2 {
		t.Fatalf("?note= finds %d", len(found))
	}
	if found := decodeJSON[struct{ Texts []map[string]any }](t, agent("GET", "/api/agent/texts?limit=10&note=part+2", "", "")); len(found.Texts) != 1 || found.Texts[0]["id"] != js["id"] {
		t.Fatalf("?limit=&note= finds %+v", found.Texts)
	}
	// A rewrite without a note keeps it.
	if kept := decodeJSON[map[string]any](t, agent("PUT", "/api/agent/texts/"+raw["id"].(string), "text/markdown", "New text.")); kept["note"] != "run 42" {
		t.Fatalf("rewrite kept note %v", kept["note"])
	}
}

// GET /api/agent/texts?limit=: the agent API lists in pages too; without a
// limit it lists everything, as before.
func TestAgentListPages(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "rest-pages@example.com", false)
	token := decodeJSON[struct {
		Token string `json:"token"`
	}](t, e.do(t, c, "POST", "/api/me/tokens", map[string]string{"name": "x"})).Token
	get := func(path string) *http.Response {
		req, _ := http.NewRequest("GET", e.srv.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	for _, title := range []string{"One", "Two", "Three"} {
		req, _ := http.NewRequest("POST", e.srv.URL+"/api/agent/texts?title="+title, strings.NewReader("Some text."))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "text/markdown")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	type page struct {
		Texts      []map[string]any `json:"texts"`
		NextCursor string           `json:"nextCursor"`
		Total      int              `json:"total"`
	}
	first := decodeJSON[page](t, get("/api/agent/texts?limit=2"))
	if len(first.Texts) != 2 || first.NextCursor == "" || first.Total != 3 {
		t.Fatalf("first page = %+v", first)
	}
	second := decodeJSON[page](t, get("/api/agent/texts?limit=2&cursor="+first.NextCursor))
	if len(second.Texts) != 1 || second.NextCursor != "" || second.Texts[0]["id"] == first.Texts[0]["id"] || second.Texts[0]["id"] == first.Texts[1]["id"] {
		t.Fatalf("second page = %+v", second)
	}
	if all := decodeJSON[[]map[string]any](t, get("/api/agent/texts")); len(all) != 3 {
		t.Fatalf("without a limit: %d texts", len(all))
	}
	if code := status(t, get("/api/agent/texts?limit=2&cursor=nope")); code != http.StatusBadRequest {
		t.Errorf("bad cursor: %d", code)
	}
	if code := status(t, get("/api/agent/texts?limit=many")); code != http.StatusBadRequest {
		t.Errorf("bad limit: %d", code)
	}
}

// The skill's script (skills/lingolens/scripts/upload.sh) against a server:
// save, list a page at a time, read, add to, rewrite and delete.
func TestSkillScript(t *testing.T) {
	for _, tool := range []string{"bash", "curl"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("needs %s", tool)
		}
	}
	e := newEnv(t)
	c := e.signIn(t, "skill@example.com", false)
	token := decodeJSON[struct {
		Token string `json:"token"`
	}](t, e.do(t, c, "POST", "/api/me/tokens", map[string]string{"name": "x"})).Token
	run := func(stdin string, args ...string) (string, error) {
		t.Helper()
		cmd := exec.CommandContext(t.Context(), "bash", append([]string{"../../skills/lingolens/scripts/upload.sh"}, args...)...)
		// A home of its own: the script reads settings from shell startup files.
		cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + t.TempDir(), "LINGOLENS_URL=" + e.srv.URL, "LINGOLENS_TOKEN=" + token}
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	must := func(stdin string, args ...string) string {
		t.Helper()
		out, err := run(stdin, args...)
		if err != nil {
			t.Fatalf("upload.sh %v: %v\n%s", args, err, out)
		}
		return out
	}

	if out := must("", "--check"); !strings.Contains(out, "skill@example.com") {
		t.Fatalf("--check: %s", out)
	}
	if out := must("", "--list"); !strings.Contains(out, "No texts saved by agents yet") {
		t.Fatalf("empty --list: %s", out)
	}
	saved := must("# Coffee Notes\n\nA short text.\n", "-")
	id := saved[strings.LastIndex(saved, "/#/read/")+len("/#/read/"):]
	id = id[:strings.IndexByte(id, '\n')]
	if !strings.Contains(saved, `Saved "Coffee Notes"`) {
		t.Fatalf("upload: %s", saved)
	}
	for i := range 21 {
		must("Some text.", "-", "--title", "Book "+itoa(int64(i)))
	}

	// 22 texts: a page of 20, then the rest, each once.
	first := must("", "--list")
	lines := strings.Split(strings.TrimSpace(first), "\n")
	more := lines[len(lines)-1]
	if len(lines) != 21 || !strings.HasPrefix(more, "More: 22 texts in all. Next page: ") {
		t.Fatalf("first page (%d lines): %s", len(lines), first)
	}
	cursor := more[strings.LastIndex(more, " ")+1:]
	second := must("", "--list", "--cursor", cursor)
	rows := append(lines[:20], strings.Split(strings.TrimSpace(second), "\n")...)
	ids := map[string]bool{}
	for _, row := range rows {
		ids[strings.Split(row, "\t")[0]] = true
	}
	if len(rows) != 22 || len(ids) != 22 || !ids[id] || strings.Contains(second, "More:") {
		t.Fatalf("pages: %d rows, %d ids\n%s\n%s", len(rows), len(ids), first, second)
	}

	must("## More\n\nAdded later.\n", "-", "--append", id)
	if md := must("", "--get", id); !strings.Contains(md, "A short text.") || !strings.Contains(md, "Added later.") {
		t.Fatalf("--get after --append: %s", md)
	}
	if out := must("Rewritten.\n", "-", "--replace", id, "--title", "Coffee"); !strings.Contains(out, `Rewrote "Coffee"`) {
		t.Fatalf("--replace: %s", out)
	}
	if out := must("", "--delete", id); !strings.Contains(out, `Deleted "Coffee"`) {
		t.Fatalf("--delete: %s", out)
	}
	if out, err := run("", "--get", id); err == nil || !strings.Contains(out, "404") {
		t.Fatalf("--get after --delete: %v %s", err, out)
	}

	// A note to find a text by: saved with it, listed in its own column, and
	// what --list --note looks for.
	noted := must("# Tea\n\nGreen tea.\n", "-", "--note", "session s-9")
	if !strings.Contains(noted, "Note: session s-9") {
		t.Fatalf("upload with --note: %s", noted)
	}
	teaID := noted[strings.LastIndex(noted, "/#/read/")+len("/#/read/"):]
	teaID = teaID[:strings.IndexByte(teaID, '\n')]
	found := strings.Split(strings.TrimSpace(must("", "--list", "--note", "s-9")), "\n")
	if len(found) != 1 || !strings.HasPrefix(found[0], teaID+"\t") || !strings.HasSuffix(found[0], "\tTea\tsession s-9") {
		t.Fatalf("--list --note: %q", found)
	}
	must("## Oolong\n\nMore tea.\n", "-", "--append", teaID)
	if again := must("", "--list", "--note", "s-9"); !strings.Contains(again, teaID) {
		t.Fatalf("--append kept the note? %s", again)
	}
	must("Rewritten.\n", "-", "--replace", teaID, "--note", "")
	if out := must("", "--list", "--note", "s-9"); !strings.Contains(out, `No texts with a note containing "s-9"`) {
		t.Fatalf("--replace --note \"\" removes it: %s", out)
	}
}

// DELETE /api/agent/texts/{id}: the agent API can delete what agents added, and
// nothing else.
func TestAgentDelete(t *testing.T) {
	e := newEnv(t)
	c := e.signIn(t, "del@example.com", false)
	token := decodeJSON[struct {
		Token string `json:"token"`
	}](t, e.do(t, c, "POST", "/api/me/tokens", map[string]string{"name": "x"})).Token
	ownID := decodeJSON[map[string]any](t, e.do(t, c, "POST", "/api/books", map[string]string{"title": "Mine", "content": "My own notes."}))["id"].(string)
	agent := func(method, path, body string) *http.Response {
		req, _ := http.NewRequest(method, e.srv.URL+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		if body != "" {
			req.Header.Set("Content-Type", "text/markdown")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	saved := decodeJSON[map[string]any](t, agent("POST", "/api/agent/texts", "# Saved\n\nBy an agent."))["id"].(string)
	if code := status(t, agent("DELETE", "/api/agent/texts/"+ownID, "")); code != http.StatusNotFound {
		t.Errorf("deleting the user's own text: %d", code)
	}
	if code := status(t, agent("DELETE", "/api/agent/texts/"+saved, "")); code != http.StatusNoContent {
		t.Errorf("delete: %d", code)
	}
	if code := status(t, agent("DELETE", "/api/agent/texts/"+saved, "")); code != http.StatusNotFound {
		t.Errorf("delete again: %d", code)
	}
	if code := status(t, e.do(t, c, "GET", "/api/books/"+ownID, nil)); code != http.StatusOK {
		t.Errorf("the user's own text: %d", code)
	}
}
