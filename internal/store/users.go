package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

const MinPasswordLen = 8

// bcryptCost is a variable so tests can lower it.
var bcryptCost = 12

type User struct {
	ID        int64  `json:"id"`
	Email     string `json:"email"`
	Name      string `json:"name"`
	IsAdmin   bool   `json:"is_admin"`
	Prefs     Prefs  `json:"prefs"`
	CreatedAt string `json:"created_at"`
}

// Prefs is the user's profile: reading level and interface settings.
type Prefs struct {
	Level    string `json:"level"`
	Lang     string `json:"lang"`
	ReadSize string `json:"readSize"`
	Theme    string `json:"theme"` // "system" (follow the device), "light" or "dark"
}

func (p Prefs) withDefaults() Prefs {
	if p.Level == "" {
		p.Level = "B1"
	}
	if p.Lang == "" {
		p.Lang = "en"
	}
	if p.ReadSize == "" {
		p.ReadSize = "m"
	}
	if p.Theme == "" {
		p.Theme = "system"
	}
	return p
}

// A precomputed hash so failed logins for unknown emails cost the same as wrong passwords.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("lingolens-timing-equaliser"), bcryptCost)

func NormalizeEmail(email string) (string, error) {
	email = strings.TrimSpace(email)
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email || len(email) > 254 {
		return "", fmt.Errorf("%q is not a valid email address", email)
	}
	return strings.ToLower(email), nil
}

func ValidatePassword(pw string) error {
	if utf8.RuneCountInString(pw) < MinPasswordLen {
		return fmt.Errorf("password must be at least %d characters", MinPasswordLen)
	}
	if len(pw) > 72 { // bcrypt's input limit
		return errors.New("password must be at most 72 bytes")
	}
	return nil
}

func (s *Store) CreateUser(ctx context.Context, email, name, password string, admin bool) (*User, error) {
	if err := ValidatePassword(password); err != nil {
		return nil, err
	}
	return s.createUser(ctx, email, name, password, admin, false)
}

// CreateFirstAdmin creates an admin only while there are no accounts at all, in
// one statement, so two people racing through first-run setup can't both win.
// It returns ErrSetupDone once any account exists.
func (s *Store) CreateFirstAdmin(ctx context.Context, email, name, password string) (*User, error) {
	if err := ValidatePassword(password); err != nil {
		return nil, err
	}
	return s.createUser(ctx, email, name, password, true, true)
}

// CreateDemoUser is CreateUser without the minimum password length, for local
// demos and development only (the server allows it with LINGOLENS_DEV_FAKE=1).
func (s *Store) CreateDemoUser(ctx context.Context, email, name, password string, admin bool) (*User, error) {
	if password == "" {
		return nil, errors.New("password is empty")
	}
	if len(password) > 72 {
		return nil, errors.New("password must be at most 72 bytes")
	}
	return s.createUser(ctx, email, name, password, admin, false)
}

func (s *Store) createUser(ctx context.Context, email, name, password string, admin, onlyFirst bool) (*User, error) {
	email, err := NormalizeEmail(email)
	if err != nil {
		return nil, err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	ts := now()
	q := `INSERT INTO users (email, name, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
	if onlyFirst {
		q = `INSERT INTO users (email, name, password_hash, is_admin, created_at, updated_at)
			SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`
	}
	res, err := s.db.ExecContext(ctx, q, email, name, string(hash), admin, ts, ts)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return nil, ErrEmailTaken
		}
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrSetupDone
	}
	id, _ := res.LastInsertId()
	return s.GetUser(ctx, id)
}

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	var u User
	var prefs string
	if err := row.Scan(&u.ID, &u.Email, &u.Name, &u.IsAdmin, &prefs, &u.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	_ = json.Unmarshal([]byte(prefs), &u.Prefs)
	u.Prefs = u.Prefs.withDefaults()
	return &u, nil
}

const userCols = `id, email, name, is_admin, prefs, created_at`

func (s *Store) GetUser(ctx context.Context, id int64) (*User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE id = ?`, id))
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE email = ?`, strings.TrimSpace(email)))
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+userCols+` FROM users ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *u)
	}
	return out, rows.Err()
}

func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

func (s *Store) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE is_admin = 1`).Scan(&n)
	return n, err
}

// Authenticate checks an email/password pair. It takes the same time whether or
// not the email exists, and returns ErrInvalidCredentials for either failure.
func (s *Store) Authenticate(ctx context.Context, email, password string) (*User, error) {
	var id int64
	var hash string
	err := s.db.QueryRowContext(ctx, `SELECT id, password_hash FROM users WHERE email = ?`, strings.TrimSpace(email)).Scan(&id, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		return nil, ErrInvalidCredentials
	}
	if err != nil {
		return nil, err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return nil, ErrInvalidCredentials
	}
	return s.GetUser(ctx, id)
}

// SetPassword changes a password and signs the user out everywhere except keepToken.
func (s *Store) SetPassword(ctx context.Context, userID int64, password, keepToken string) error {
	if err := ValidatePassword(password); err != nil {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, string(hash), now(), userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`, userID, tokenHash(keepToken))
	return err
}

func (s *Store) SetAdmin(ctx context.Context, userID int64, admin bool) error {
	res, err := s.db.ExecContext(ctx, `UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?`, admin, now(), userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) UpdatePrefs(ctx context.Context, userID int64, p Prefs) (Prefs, error) {
	p = p.withDefaults()
	b, _ := json.Marshal(p)
	_, err := s.db.ExecContext(ctx, `UPDATE users SET prefs = ?, updated_at = ? WHERE id = ?`, string(b), now(), userID)
	return p, err
}

// DeleteUser removes a user and, through ON DELETE CASCADE, all their data.
func (s *Store) DeleteUser(ctx context.Context, userID int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---------------------------------------------------------------- sessions

// Sessions are random tokens held in an HttpOnly cookie; only their SHA-256
// is stored, so a leaked database can't be used to sign in.

func tokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func (s *Store) CreateSession(ctx context.Context, userID int64, ttl time.Duration) (string, error) {
	token := randomHex(32)
	t := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		tokenHash(token), userID, t.Format(time.RFC3339), t.Add(ttl).Format(time.RFC3339))
	return token, err
}

// UserBySession returns the session's user, extending the session when more than
// half of its lifetime has passed (so active users stay signed in).
func (s *Store) UserBySession(ctx context.Context, token string, ttl time.Duration) (*User, error) {
	if token == "" {
		return nil, ErrNotFound
	}
	var userID int64
	var expires string
	err := s.db.QueryRowContext(ctx, `SELECT user_id, expires_at FROM sessions WHERE token_hash = ?`, tokenHash(token)).Scan(&userID, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	exp, err := time.Parse(time.RFC3339, expires)
	n := time.Now().UTC()
	if err != nil || !n.Before(exp) {
		_, _ = s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash(token))
		return nil, ErrNotFound
	}
	if exp.Sub(n) < ttl/2 {
		_, _ = s.db.ExecContext(ctx, `UPDATE sessions SET expires_at = ? WHERE token_hash = ?`, n.Add(ttl).Format(time.RFC3339), tokenHash(token))
	}
	return s.GetUser(ctx, userID)
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash(token))
	return err
}

func (s *Store) PurgeExpiredSessions(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, now())
	return err
}
