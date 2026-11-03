// Package store persists users, sessions and each user's reading data in SQLite.
//
// Every query that touches user data is scoped by user_id; nothing here returns
// another user's rows. API keys are sealed with AES-256-GCM (see crypto.go).
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver: keeps the binary CGO-free
)

var (
	ErrNotFound           = errors.New("not found")
	ErrEmailTaken         = errors.New("an account with this email already exists")
	ErrInvalidCredentials = errors.New("email or password is incorrect")
	ErrSetupDone          = errors.New("this server already has accounts")
)

type Store struct {
	db     *sql.DB
	sealer *sealer
}

// Open opens (creating if needed) the database at path and applies migrations.
// secret is the 32-byte key used to encrypt stored API keys.
func Open(path string, secret []byte) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	sl, err := newSealer(secret)
	if err != nil {
		return nil, err
	}
	dsn := "file:" + path + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	s := &Store{db: db, sealer: sl}
	if err := s.migrate(context.Background()); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Migrations run in order; PRAGMA user_version records how many have been applied.
var migrations = []string{
	`CREATE TABLE users (
		id            INTEGER PRIMARY KEY,
		email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
		name          TEXT NOT NULL DEFAULT '',
		password_hash TEXT NOT NULL,
		is_admin      INTEGER NOT NULL DEFAULT 0,
		prefs         TEXT NOT NULL DEFAULT '{}',
		created_at    TEXT NOT NULL,
		updated_at    TEXT NOT NULL
	);
	CREATE TABLE sessions (
		token_hash TEXT PRIMARY KEY,
		user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL
	);
	CREATE INDEX sessions_user ON sessions(user_id);
	CREATE TABLE model_settings (
		user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
		active    TEXT NOT NULL DEFAULT '',
		providers TEXT NOT NULL DEFAULT '{}',
		sealed_keys BLOB
	);
	CREATE TABLE books (
		id           TEXT PRIMARY KEY,
		user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		title        TEXT NOT NULL,
		format       TEXT NOT NULL,
		content      TEXT NOT NULL,
		words        INTEGER NOT NULL,
		progress     REAL NOT NULL DEFAULT 0,
		pos          REAL NOT NULL DEFAULT 0,
		created_at   TEXT NOT NULL,
		updated_at   TEXT NOT NULL,
		last_read_at TEXT NOT NULL DEFAULT ''
	);
	CREATE INDEX books_user ON books(user_id);
	CREATE TABLE wordbook (
		user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		key      TEXT NOT NULL,
		entry    TEXT NOT NULL,
		added_at TEXT NOT NULL,
		PRIMARY KEY (user_id, key)
	);
	CREATE TABLE known_words (
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		lemma   TEXT NOT NULL,
		PRIMARY KEY (user_id, lemma)
	);`,
	// 2: tokens that let a user's AI agents add texts to their shelf.
	`CREATE TABLE agent_tokens (
		id           INTEGER PRIMARY KEY,
		user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name         TEXT NOT NULL,
		token_hash   TEXT NOT NULL UNIQUE,
		hint         TEXT NOT NULL,
		created_at   TEXT NOT NULL,
		last_used_at TEXT
	);
	CREATE INDEX agent_tokens_user ON agent_tokens(user_id);`,
	// 3: texts created offline carry the device's reference for them, so a create
	// that is retried (the reply was lost) doesn't add the text twice.
	`ALTER TABLE books ADD COLUMN client_ref TEXT NOT NULL DEFAULT '';
	CREATE UNIQUE INDEX books_client_ref ON books(user_id, client_ref) WHERE client_ref != '';`,
	// 4: who added a text. Agents may add to texts that agents added ('agent'),
	// never to the user's own.
	`ALTER TABLE books ADD COLUMN origin TEXT NOT NULL DEFAULT '';`,
	// 5: when a text is deleted on its own (RFC 3339, UTC); '' keeps it forever.
	`ALTER TABLE books ADD COLUMN expires_at TEXT NOT NULL DEFAULT '';
	CREATE INDEX books_expires ON books(expires_at) WHERE expires_at != '';`,
}

func (s *Store) migrate(ctx context.Context) error {
	var version int
	if err := s.db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	for i := version; i < len(migrations); i++ {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if _, err := tx.ExecContext(ctx, fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
