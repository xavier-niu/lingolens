package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/xavier-niu/lingolens/internal/store"
)

// MCP: the agent API as a Model Context Protocol server at /mcp, so agents that
// speak MCP (Claude Code, Codex, Cursor, …) get LingoLens as tools: create a
// book, show it, update it, delete it, and list the ones agents saved. Same
// token and same reach as the agent API (agent.go): an agent adds texts, and
// shows, changes and deletes texts agents added; the user's own texts stay out
// of its reach.
//
//   POST /mcp    Authorization: Bearer llat_…   (Settings → Agent Access)
//
// Streamable HTTP, without sessions: each request is a whole exchange,
// answered with JSON.

const mcpInstructions = `LingoLens is the user's English reading app: texts on their shelf are shown with short Chinese glosses above the words a reader at their level may not know, and they can ask about any sentence.

Save something for the user to read (an explanation, an article, notes, a reply worth keeping) with create_book, written in Markdown. Give it a note you can find it by later, such as your session or conversation id: list_books with that note finds the books you saved, so you can add to them instead of saving new ones. One conversation keeps one book: when this conversation already saved one, add each new reply to its end (update_book with mode append), even when the user just says to save it, and save a new book only when the user asks for a separate one. If its title then covers only the first part, rename it (show_book, then update_book with a title and the heading changed to match). list_books finds the texts agents saved, a page at a time (pass its nextCursor back for the next page); show_book reads one; update_book rewrites one or adds to its end (good for follow-ups); delete_book removes one. Only texts agents saved can be shown, changed or deleted: the user's own texts are private.

Texts agents save delete themselves after 30 days, and each update starts that again; pass ttlDays to choose (0 keeps a text for good).`

// What a tool says about a book.
type mcpBook struct {
	ID        string  `json:"id" jsonschema:"the book's id"`
	Title     string  `json:"title"`
	Format    string  `json:"format" jsonschema:"markdown or text"`
	Words     int     `json:"words"`
	Progress  float64 `json:"progress" jsonschema:"how much of it the reader has read, from 0 to 1"`
	UpdatedAt string  `json:"updatedAt"`
	ExpiresAt string  `json:"expiresAt,omitempty" jsonschema:"when it deletes itself (RFC 3339); missing when it's kept for good"`
	Note      string  `json:"note,omitempty" jsonschema:"the note it was saved with, to find it by"`
	URL       string  `json:"url" jsonschema:"where the reader opens it in LingoLens"`
}

// show_book: the same, with the text.
type mcpBookText struct {
	ID        string  `json:"id" jsonschema:"the book's id"`
	Title     string  `json:"title"`
	Format    string  `json:"format" jsonschema:"markdown or text"`
	Words     int     `json:"words"`
	Progress  float64 `json:"progress" jsonschema:"how much of it the reader has read, from 0 to 1"`
	UpdatedAt string  `json:"updatedAt"`
	ExpiresAt string  `json:"expiresAt,omitempty" jsonschema:"when it deletes itself (RFC 3339); missing when it's kept for good"`
	Note      string  `json:"note,omitempty" jsonschema:"the note it was saved with, to find it by"`
	URL       string  `json:"url" jsonschema:"where the reader opens it in LingoLens"`
	Markdown  string  `json:"markdown" jsonschema:"the whole text"`
}

type mcpCreateIn struct {
	Title    string `json:"title,omitempty" jsonschema:"the title; when left out, taken from the first heading or line"`
	Markdown string `json:"markdown" jsonschema:"the text, in Markdown"`
	TTLDays  *int   `json:"ttlDays,omitempty" jsonschema:"days to keep it before it deletes itself: 30 when left out, 0 to keep it for good"`
	Note     string `json:"note,omitempty" jsonschema:"a note to find it by later, such as your session or conversation id (up to 500 characters); not shown to the reader"`
}

type mcpUpdateIn struct {
	ID       string  `json:"id" jsonschema:"the book's id (from create_book or list_books)"`
	Markdown string  `json:"markdown" jsonschema:"replace: the whole new text; append: what to add at the end"`
	Mode     string  `json:"mode,omitempty" jsonschema:"replace (the default) rewrites the book; append adds the markdown at the end, after a dividing line, keeping the reader's place"`
	Title    string  `json:"title,omitempty" jsonschema:"a new title (replace only); when left out, the title stays"`
	Note     *string `json:"note,omitempty" jsonschema:"a new note to find it by; when left out, the note stays, and an empty one removes it"`
}

type mcpIDIn struct {
	ID string `json:"id" jsonschema:"the book's id (from create_book or list_books)"`
}

type mcpListIn struct {
	Note   string `json:"note,omitempty" jsonschema:"only the books whose note contains this, such as your session id"`
	Limit  int    `json:"limit,omitempty" jsonschema:"how many books to list on this page, 1 to 100 (20 when left out)"`
	Cursor string `json:"cursor,omitempty" jsonschema:"where to go on from: the nextCursor of the page before; left out for the first page"`
}

type mcpListOut struct {
	Books      []mcpBook `json:"books" jsonschema:"this page of the books agents saved, most recently changed first"`
	NextCursor string    `json:"nextCursor,omitempty" jsonschema:"pass this as cursor for the next page; missing on the last page"`
	Total      int       `json:"total" jsonschema:"how many books agents saved, on all pages"`
}

type mcpDeleteOut struct {
	ID      string `json:"id"`
	Deleted bool   `json:"deleted"`
}

// mcpHandler serves /mcp. Requests without a valid agent token get 401.
func (s *Server) mcpHandler() http.Handler {
	srv := mcp.NewServer(&mcp.Implementation{Name: "lingolens", Title: "LingoLens", Version: "1.0.0"},
		&mcp.ServerOptions{Instructions: mcpInstructions})
	yes, no := true, false

	mcp.AddTool(srv, &mcp.Tool{
		Name: "create_book",
		Description: "Save a Markdown text to the user's LingoLens shelf, to read with Chinese glosses. Give it a note to find it by later " +
			"(your session or conversation id, say). Returns its id and link.",
		Annotations: &mcp.ToolAnnotations{Title: "Create a book", DestructiveHint: &no, OpenWorldHint: &no},
	}, s.mcpCreate)
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "show_book",
		Description: "Show a book agents saved: its Markdown, title, length, link and how much the user has read.",
		Annotations: &mcp.ToolAnnotations{Title: "Show a book", ReadOnlyHint: true, OpenWorldHint: &no},
	}, s.mcpShow)
	mcp.AddTool(srv, &mcp.Tool{
		Name: "update_book",
		Description: "Change a book agents saved: rewrite it (mode replace, the default; a title renames it) or add to its end " +
			"(mode append, after a dividing line). The book keeps its id and link; the reader keeps their place. A note replaces its note.",
		Annotations: &mcp.ToolAnnotations{Title: "Update a book", DestructiveHint: &yes, OpenWorldHint: &no},
	}, s.mcpUpdate)
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "delete_book",
		Description: "Delete a book agents saved from the user's shelf. This can't be undone.",
		Annotations: &mcp.ToolAnnotations{Title: "Delete a book", DestructiveHint: &yes, IdempotentHint: true, OpenWorldHint: &no},
	}, s.mcpDelete)
	mcp.AddTool(srv, &mcp.Tool{
		Name: "list_books",
		Description: "List the books agents saved to the user's shelf (not the user's own texts), most recently changed first, without their text, " +
			"a page at a time: when nextCursor is given, pass it as cursor for the next page. With a note, only the books whose note contains it, " +
			"such as the ones you saved with your session id.",
		Annotations: &mcp.ToolAnnotations{Title: "List books", ReadOnlyHint: true, OpenWorldHint: &no},
	}, s.mcpList)

	h := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, &mcp.StreamableHTTPOptions{
		Stateless:    true,
		JSONResponse: true,
		// Its DNS-rebinding guard turns away requests that reach a local address
		// under another name, which is every request behind a reverse proxy on
		// the same machine (the recommended setup). The guard is for servers
		// that trust their callers; this one wants a token on every request,
		// which a page in someone's browser doesn't have.
		DisableLocalhostProtection: true,
		MaxRequestBodyBytes:        maxBookBodyBytes,
	})
	return auth.RequireBearerToken(s.verifyAgentToken, &auth.RequireBearerTokenOptions{AllowMissingExpiration: true})(h)
}

// verifyAgentToken accepts the user's agent tokens. The user, and the address
// for links to the shelf, go along with the request to the tools.
func (s *Server) verifyAgentToken(ctx context.Context, token string, r *http.Request) (*auth.TokenInfo, error) {
	u, err := s.opts.Store.UserByAgentToken(ctx, strings.TrimSpace(token))
	if errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("%w: this agent token is invalid or has been revoked; create one in Settings → Agent Access", auth.ErrInvalidToken)
	}
	if err != nil {
		return nil, err
	}
	return &auth.TokenInfo{UserID: strconv.FormatInt(u.ID, 10), Extra: map[string]any{"user": u, "base": s.publicURL(r)}}, nil
}

// mcpCaller is the user whose token made the request, and the shelf's address.
func mcpCaller(req *mcp.CallToolRequest) (*store.User, string, error) {
	if info := req.Extra.TokenInfo; info != nil {
		if u, ok := info.Extra["user"].(*store.User); ok {
			base, _ := info.Extra["base"].(string)
			return u, base, nil
		}
	}
	return nil, "", errors.New("send an agent token: Authorization: Bearer llat_…")
}

func mcpBookOf(b *store.Book, base string) mcpBook {
	return mcpBook{
		ID: b.ID, Title: b.Title, Format: b.Format, Words: b.Words, Progress: b.Progress,
		UpdatedAt: b.UpdatedAt, ExpiresAt: b.ExpiresAt, Note: b.Note, URL: base + "/#/read/" + b.ID,
	}
}

func (s *Server) mcpCreate(ctx context.Context, req *mcp.CallToolRequest, in mcpCreateIn) (*mcp.CallToolResult, mcpBook, error) {
	u, base, err := mcpCaller(req)
	if err != nil {
		return nil, mcpBook{}, err
	}
	keep := store.AgentTTL
	if in.TTLDays != nil {
		if keep, err = ttl(in.TTLDays); err != nil {
			return nil, mcpBook{}, errors.New(sentence(err))
		}
	}
	b, err := s.opts.Store.CreateAgentBook(ctx, u.ID, in.Title, "markdown", in.Markdown, in.Note, keep)
	if err != nil {
		return nil, mcpBook{}, errors.New(sentence(err))
	}
	return nil, mcpBookOf(b, base), nil
}

func (s *Server) mcpShow(ctx context.Context, req *mcp.CallToolRequest, in mcpIDIn) (*mcp.CallToolResult, mcpBookText, error) {
	u, base, err := mcpCaller(req)
	if err != nil {
		return nil, mcpBookText{}, err
	}
	b, err := s.opts.Store.GetAgentBook(ctx, u.ID, in.ID)
	if err != nil {
		return nil, mcpBookText{}, errors.New(agentTextMessage(err))
	}
	m := mcpBookOf(b, base)
	return nil, mcpBookText{
		ID: m.ID, Title: m.Title, Format: m.Format, Words: m.Words, Progress: m.Progress,
		UpdatedAt: m.UpdatedAt, ExpiresAt: m.ExpiresAt, Note: m.Note, URL: m.URL, Markdown: b.Content,
	}, nil
}

func (s *Server) mcpUpdate(ctx context.Context, req *mcp.CallToolRequest, in mcpUpdateIn) (*mcp.CallToolResult, mcpBook, error) {
	u, base, err := mcpCaller(req)
	if err != nil {
		return nil, mcpBook{}, err
	}
	var b *store.Book
	switch in.Mode {
	case "", "replace":
		b, err = s.opts.Store.ReplaceAgentBook(ctx, u.ID, in.ID, in.Title, "markdown", in.Markdown, in.Note)
	case "append":
		b, err = s.opts.Store.AppendAgentBook(ctx, u.ID, in.ID, in.Markdown, in.Note)
	default:
		return nil, mcpBook{}, fmt.Errorf("mode is %q: use replace or append", in.Mode)
	}
	if err != nil {
		return nil, mcpBook{}, errors.New(agentTextMessage(err))
	}
	return nil, mcpBookOf(b, base), nil
}

func (s *Server) mcpDelete(ctx context.Context, req *mcp.CallToolRequest, in mcpIDIn) (*mcp.CallToolResult, mcpDeleteOut, error) {
	u, _, err := mcpCaller(req)
	if err != nil {
		return nil, mcpDeleteOut{}, err
	}
	if err := s.opts.Store.DeleteAgentBook(ctx, u.ID, in.ID); err != nil {
		return nil, mcpDeleteOut{}, errors.New(agentTextMessage(err))
	}
	return nil, mcpDeleteOut{ID: in.ID, Deleted: true}, nil
}

func (s *Server) mcpList(ctx context.Context, req *mcp.CallToolRequest, in mcpListIn) (*mcp.CallToolResult, mcpListOut, error) {
	u, base, err := mcpCaller(req)
	if err != nil {
		return nil, mcpListOut{}, err
	}
	page, err := s.agentPage(ctx, u.ID, base, in.Note, in.Cursor, in.Limit)
	if err != nil {
		return nil, mcpListOut{}, errors.New(sentence(err))
	}
	return nil, mcpListOut{Books: page.Texts, NextCursor: page.NextCursor, Total: page.Total}, nil
}
