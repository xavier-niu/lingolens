package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode/utf8"
)

// Agent tokens let a user's AI agents (Claude Code, scripts) add texts to their
// shelf over the API. They can do nothing else. Like sessions, only a hash is
// stored; the token itself is shown once, when it is created.

const (
	AgentTokenPrefix = "llat_"
	maxAgentTokens   = 20
)

var ErrTooManyTokens = errors.New("you have too many agent tokens; revoke one first")

type AgentToken struct {
	ID         int64   `json:"id"`
	Name       string  `json:"name"`
	Hint       string  `json:"hint"` // "llat_…1a2b", to tell tokens apart
	CreatedAt  string  `json:"created_at"`
	LastUsedAt *string `json:"last_used_at"`
}

// CreateAgentToken returns the new token (shown to the user once) and its record.
func (s *Store) CreateAgentToken(ctx context.Context, userID int64, name string) (string, *AgentToken, error) {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		name = "Agent"
	}
	if utf8.RuneCountInString(name) > 60 {
		name = string([]rune(name)[:60])
	}
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_tokens WHERE user_id = ?`, userID).Scan(&n); err != nil {
		return "", nil, err
	}
	if n >= maxAgentTokens {
		return "", nil, ErrTooManyTokens
	}
	token := AgentTokenPrefix + randomHex(24)
	hint := AgentTokenPrefix + "…" + token[len(token)-4:]
	res, err := s.db.ExecContext(ctx, `INSERT INTO agent_tokens (user_id, name, token_hash, hint, created_at) VALUES (?, ?, ?, ?, ?)`,
		userID, name, tokenHash(token), hint, now())
	if err != nil {
		return "", nil, err
	}
	id, _ := res.LastInsertId()
	tokens, err := s.ListAgentTokens(ctx, userID)
	if err != nil {
		return "", nil, err
	}
	for _, t := range tokens {
		if t.ID == id {
			return token, &t, nil
		}
	}
	return "", nil, ErrNotFound
}

func (s *Store) ListAgentTokens(ctx context.Context, userID int64) ([]AgentToken, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, hint, created_at, last_used_at FROM agent_tokens
		WHERE user_id = ? ORDER BY id DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AgentToken{}
	for rows.Next() {
		var t AgentToken
		var used sql.NullString
		if err := rows.Scan(&t.ID, &t.Name, &t.Hint, &t.CreatedAt, &used); err != nil {
			return nil, err
		}
		if used.Valid {
			t.LastUsedAt = &used.String
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) DeleteAgentToken(ctx context.Context, userID, id int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM agent_tokens WHERE user_id = ? AND id = ?`, userID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// UserByAgentToken returns the token's owner and records the use.
func (s *Store) UserByAgentToken(ctx context.Context, token string) (*User, error) {
	if !strings.HasPrefix(token, AgentTokenPrefix) {
		return nil, ErrNotFound
	}
	var id, userID int64
	err := s.db.QueryRowContext(ctx, `SELECT id, user_id FROM agent_tokens WHERE token_hash = ?`, tokenHash(token)).Scan(&id, &userID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	_, _ = s.db.ExecContext(ctx, `UPDATE agent_tokens SET last_used_at = ? WHERE id = ?`, now(), id)
	return s.GetUser(ctx, userID)
}
