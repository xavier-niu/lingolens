package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// ---------------------------------------------------------------- Ask AI history

// chatTime orders conversations saved within the same second; fixed width,
// so the text sorts like the time.
const chatTime = "2006-01-02T15:04:05.000000Z"

// MaxChats is how many conversations an account keeps; the oldest go first.
const MaxChats = 500

// ChatMessage is one turn of a conversation.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Chat is a saved Ask AI conversation about a selection in a text.
type Chat struct {
	ID        string        `json:"id"`
	BookID    string        `json:"bookId"`
	BookTitle string        `json:"bookTitle"`
	Selection string        `json:"selection"`
	Passage   string        `json:"passage,omitempty"`
	Messages  []ChatMessage `json:"messages,omitempty"`
	// In lists: the first question and how many questions were asked.
	Question  string `json:"question,omitempty"`
	Questions int    `json:"questions"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

func summarize(c *Chat) {
	c.Questions = 0
	for _, m := range c.Messages {
		if m.Role == "user" {
			if c.Questions == 0 {
				c.Question = m.Content
			}
			c.Questions++
		}
	}
}

const chatCols = `c.id, COALESCE(c.book_id, ''), COALESCE(b.title, ''), c.selection, c.passage, c.messages, c.created_at, c.updated_at`

func scanChat(row interface{ Scan(...any) error }) (*Chat, error) {
	var c Chat
	var msgs string
	if err := row.Scan(&c.ID, &c.BookID, &c.BookTitle, &c.Selection, &c.Passage, &msgs, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(msgs), &c.Messages); err != nil {
		return nil, err
	}
	summarize(&c)
	return &c, nil
}

// ListChats returns conversations newest first, without passages and
// messages; bookID limits them to one text.
func (s *Store) ListChats(ctx context.Context, userID int64, bookID string) ([]Chat, error) {
	q := `SELECT ` + chatCols + ` FROM chats c LEFT JOIN books b ON b.id = c.book_id
		WHERE c.user_id = ?`
	args := []any{userID}
	if bookID != "" {
		q += ` AND c.book_id = ?`
		args = append(args, bookID)
	}
	rows, err := s.db.QueryContext(ctx, q+` ORDER BY c.updated_at DESC, c.rowid DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Chat{}
	for rows.Next() {
		c, err := scanChat(rows)
		if err != nil {
			return nil, err
		}
		c.Passage, c.Messages = "", nil
		out = append(out, *c)
	}
	return out, rows.Err()
}

func (s *Store) GetChat(ctx context.Context, userID int64, id string) (*Chat, error) {
	c, err := scanChat(s.db.QueryRowContext(ctx, `SELECT `+chatCols+` FROM chats c
		LEFT JOIN books b ON b.id = c.book_id WHERE c.user_id = ? AND c.id = ?`, userID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return c, err
}

// PutChat saves a conversation under the client's id, creating or replacing
// it. A book that isn't the user's (or no longer exists) is not linked. Past
// MaxChats, the least recently used conversations are removed.
func (s *Store) PutChat(ctx context.Context, userID int64, c *Chat) (*Chat, error) {
	msgs, err := json.Marshal(c.Messages)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var book any
	if id := strings.TrimSpace(c.BookID); id != "" {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM books WHERE user_id = ? AND id = ?`, userID, id).Scan(&n); err != nil {
			return nil, err
		}
		if n > 0 {
			book = id
		}
	}
	t := time.Now().UTC().Format(chatTime)
	if _, err := tx.ExecContext(ctx, `INSERT INTO chats (id, user_id, book_id, selection, passage, messages, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id, id) DO UPDATE SET book_id = excluded.book_id, selection = excluded.selection,
			passage = excluded.passage, messages = excluded.messages, updated_at = excluded.updated_at`,
		c.ID, userID, book, c.Selection, c.Passage, string(msgs), t, t); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM chats WHERE user_id = ? AND rowid NOT IN
		(SELECT rowid FROM chats WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?)`,
		userID, userID, MaxChats); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetChat(ctx, userID, c.ID)
}

func (s *Store) DeleteChat(ctx context.Context, userID int64, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM chats WHERE user_id = ? AND id = ?`, userID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
