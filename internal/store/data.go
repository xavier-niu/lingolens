package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// ---------------------------------------------------------------- books

type Book struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	Format     string  `json:"format"`
	Content    string  `json:"content,omitempty"`
	Words      int     `json:"words"`
	Progress   float64 `json:"progress"`
	Pos        float64 `json:"pos"`
	CreatedAt  string  `json:"createdAt"`
	UpdatedAt  string  `json:"updatedAt"`
	LastReadAt string  `json:"lastReadAt"`
}

const MaxBookChars = 2_000_000 // a long novel

var wordRe = regexp.MustCompile(`[A-Za-z]+(?:['’-][A-Za-z]+)*`)

func CountWords(text string) int { return len(wordRe.FindAllStringIndex(text, -1)) }

var (
	mdStrong = []*regexp.Regexp{ // each one alone is a clear sign
		regexp.MustCompile(`(?m)^#{1,6}[ \t]+\S`),                                               // heading
		regexp.MustCompile("(?m)^(```|~~~)"),                                                    // code fence
		regexp.MustCompile(`(?m)^\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$`), // table rule
	}
	mdLink = regexp.MustCompile(`\[[^\]\n]+\]\((https?://|/|#)[^)\s]*\)`)
	mdWeak = []*regexp.Regexp{ // common in plain text too; they only count together
		regexp.MustCompile(`(?m)^[ \t]*([-*+]|\d{1,3}[.)])[ \t]+\S`), // list item
		regexp.MustCompile(`(?m)^>[ \t]?\S`),                         // quote
		regexp.MustCompile(`\*\*[^*\n]+\*\*|__[^_\n]+__`),            // bold
		regexp.MustCompile("`[^`\n]+`"),                              // code span
	}
)

// DetectFormat guesses whether pasted text is Markdown. web/static/app.js
// (looksLikeMarkdown) applies the same rules for the live hint in the dialog.
func DetectFormat(content string) string {
	if len(content) > 200_000 {
		content = content[:200_000]
	}
	score := 0
	for _, re := range mdStrong {
		if re.MatchString(content) {
			score += 3
		}
	}
	score += 2 * min(2, len(mdLink.FindAllStringIndex(content, 2)))
	for _, re := range mdWeak {
		score += min(2, len(re.FindAllStringIndex(content, 2)))
	}
	if score >= 3 {
		return "markdown"
	}
	return "text"
}

// DeriveTitle takes the first non-empty line, trimmed to about 60 characters.
func DeriveTitle(content string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(strings.TrimLeft(line, "#>*- \t"))
		if line == "" {
			continue
		}
		if utf8.RuneCountInString(line) <= 60 {
			return line
		}
		r := []rune(line)[:60]
		cut := string(r)
		if i := strings.LastIndex(cut, " "); i > 30 {
			cut = cut[:i]
		}
		return cut + "…"
	}
	return "Untitled"
}

func ValidateBook(title, format, content string) (string, string, error) {
	if strings.TrimSpace(content) == "" {
		return "", "", errors.New("the text is empty")
	}
	if utf8.RuneCountInString(content) > MaxBookChars {
		return "", "", errors.New("the text is too long")
	}
	if format != "text" && format != "markdown" {
		format = DetectFormat(content)
	}
	title = strings.TrimSpace(title)
	if title == "" {
		title = DeriveTitle(content)
	}
	if utf8.RuneCountInString(title) > 200 {
		title = string([]rune(title)[:200])
	}
	return title, format, nil
}

const bookCols = `id, title, format, words, progress, pos, created_at, updated_at, last_read_at`

func scanBook(row interface{ Scan(...any) error }, withContent bool) (*Book, error) {
	var b Book
	dest := []any{&b.ID, &b.Title, &b.Format, &b.Words, &b.Progress, &b.Pos, &b.CreatedAt, &b.UpdatedAt, &b.LastReadAt}
	if withContent {
		dest = append(dest, &b.Content)
	}
	if err := row.Scan(dest...); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &b, nil
}

// ListBooks returns the user's books without their content, most recently used first.
func (s *Store) ListBooks(ctx context.Context, userID int64) ([]Book, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+bookCols+` FROM books WHERE user_id = ?
		ORDER BY COALESCE(NULLIF(last_read_at, ''), updated_at) DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Book{}
	for rows.Next() {
		b, err := scanBook(rows, false)
		if err != nil {
			return nil, err
		}
		out = append(out, *b)
	}
	return out, rows.Err()
}

func (s *Store) GetBook(ctx context.Context, userID int64, id string) (*Book, error) {
	return scanBook(s.db.QueryRowContext(ctx, `SELECT `+bookCols+`, content FROM books WHERE user_id = ? AND id = ?`, userID, id), true)
}

func (s *Store) CreateBook(ctx context.Context, userID int64, title, format, content string) (*Book, error) {
	return s.CreateBookRef(ctx, userID, title, format, content, "")
}

// CreateBookRef creates a book; `ref` is the creating device's own id for it (from
// a text added offline). Creating again with the same ref returns the first book.
func (s *Store) CreateBookRef(ctx context.Context, userID int64, title, format, content, ref string) (*Book, error) {
	title, format, err := ValidateBook(title, format, content)
	if err != nil {
		return nil, err
	}
	if len(ref) > 64 {
		return nil, errors.New("the client reference is too long")
	}
	if ref != "" {
		var id string
		err := s.db.QueryRowContext(ctx, `SELECT id FROM books WHERE user_id = ? AND client_ref = ?`, userID, ref).Scan(&id)
		if err == nil {
			return s.GetBook(ctx, userID, id)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}
	id, ts := randomHex(8), now()
	_, err = s.db.ExecContext(ctx, `INSERT INTO books (id, user_id, title, format, content, words, created_at, updated_at, client_ref)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, userID, title, format, content, CountWords(content), ts, ts, ref)
	if err != nil {
		return nil, err
	}
	return s.GetBook(ctx, userID, id)
}

// UpdateBook replaces title and content; a rewritten text starts over at 0%.
// An empty format keeps the current one.
func (s *Store) UpdateBook(ctx context.Context, userID int64, id, title, format, content string) (*Book, error) {
	old, err := s.GetBook(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	if format == "" {
		format = old.Format
	}
	title, format, err = ValidateBook(title, format, content)
	if err != nil {
		return nil, err
	}
	progress, pos := old.Progress, old.Pos
	if content != old.Content {
		progress, pos = 0, 0
	}
	_, err = s.db.ExecContext(ctx, `UPDATE books SET title = ?, format = ?, content = ?, words = ?, progress = ?, pos = ?, updated_at = ?
		WHERE user_id = ? AND id = ?`, title, format, content, CountWords(content), progress, pos, now(), userID, id)
	if err != nil {
		return nil, err
	}
	return s.GetBook(ctx, userID, id)
}

// SaveProgress records the reading position now; progress only ever increases.
func (s *Store) SaveProgress(ctx context.Context, userID int64, id string, pos, progress float64) error {
	return s.SaveProgressAt(ctx, userID, id, pos, progress, time.Now())
}

// SaveProgressAt records the reading position as of `at`, which can be in the past
// when a device syncs reading it did offline. Progress only ever increases; the
// position is kept only if nothing newer has been recorded (say, by another device).
func (s *Store) SaveProgressAt(ctx context.Context, userID int64, id string, pos, progress float64, at time.Time) error {
	clamp := func(v float64) float64 { return min(1, max(0, v)) }
	if t := time.Now(); at.IsZero() || at.After(t) {
		at = t
	}
	ts := at.UTC().Format(time.RFC3339)
	res, err := s.db.ExecContext(ctx, `UPDATE books SET
		pos = CASE WHEN last_read_at <= ?1 THEN ?2 ELSE pos END,
		progress = MAX(progress, ?3),
		last_read_at = MAX(last_read_at, ?1)
		WHERE user_id = ?4 AND id = ?5`, ts, clamp(pos), clamp(progress), userID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteBook(ctx context.Context, userID int64, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM books WHERE user_id = ? AND id = ?`, userID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---------------------------------------------------------------- wordbook & known words

const maxEntryBytes = 8 << 10

// ListWordbook returns saved entries (opaque JSON from the client), newest first.
func (s *Store) ListWordbook(ctx context.Context, userID int64) ([]json.RawMessage, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT entry FROM wordbook WHERE user_id = ? ORDER BY added_at DESC, rowid DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, err
		}
		out = append(out, json.RawMessage(e))
	}
	return out, rows.Err()
}

func (s *Store) PutWordbook(ctx context.Context, userID int64, key string, entry json.RawMessage) error {
	key = strings.ToLower(strings.TrimSpace(key))
	if key == "" || len(key) > 200 {
		return errors.New("invalid word")
	}
	if len(entry) > maxEntryBytes || !json.Valid(entry) {
		return errors.New("invalid wordbook entry")
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO wordbook (user_id, key, entry, added_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (user_id, key) DO UPDATE SET entry = excluded.entry`, userID, key, string(entry), now())
	return err
}

func (s *Store) DeleteWordbook(ctx context.Context, userID int64, key string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM wordbook WHERE user_id = ? AND key = ?`, userID, strings.ToLower(strings.TrimSpace(key)))
	return err
}

func (s *Store) ListKnown(ctx context.Context, userID int64) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT lemma FROM known_words WHERE user_id = ? ORDER BY lemma`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var l string
		if err := rows.Scan(&l); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (s *Store) SetKnown(ctx context.Context, userID int64, lemma string, known bool) error {
	lemma = strings.ToLower(strings.TrimSpace(lemma))
	if lemma == "" || len(lemma) > 200 {
		return errors.New("invalid word")
	}
	var err error
	if known {
		_, err = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO known_words (user_id, lemma) VALUES (?, ?)`, userID, lemma)
	} else {
		_, err = s.db.ExecContext(ctx, `DELETE FROM known_words WHERE user_id = ? AND lemma = ?`, userID, lemma)
	}
	return err
}

func (s *Store) ClearKnown(ctx context.Context, userID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM known_words WHERE user_id = ?`, userID)
	return err
}

// ---------------------------------------------------------------- model settings

// ProviderConf is a user's configuration for one provider preset (no key).
type ProviderConf struct {
	Kind    string `json:"kind"`
	BaseURL string `json:"base_url"`
	Model   string `json:"model"`
}

// ModelSettings is what the browser may see: never the keys, only whether one is set.
type ModelSettings struct {
	Active    string                  `json:"active"`
	Providers map[string]ProviderConf `json:"providers"`
	HasKey    map[string]bool         `json:"has_key"`
}

func (s *Store) loadModel(ctx context.Context, userID int64) (string, map[string]ProviderConf, map[string]string, error) {
	var active, providers string
	var sealed []byte
	err := s.db.QueryRowContext(ctx, `SELECT active, providers, sealed_keys FROM model_settings WHERE user_id = ?`, userID).
		Scan(&active, &providers, &sealed)
	confs, keys := map[string]ProviderConf{}, map[string]string{}
	if errors.Is(err, sql.ErrNoRows) {
		return "", confs, keys, nil
	}
	if err != nil {
		return "", nil, nil, err
	}
	_ = json.Unmarshal([]byte(providers), &confs)
	if len(sealed) > 0 {
		plain, err := s.sealer.open(sealed, userID)
		if err != nil {
			return "", nil, nil, errors.New("stored API keys can't be decrypted; was LINGOLENS_SECRET changed?")
		}
		_ = json.Unmarshal(plain, &keys)
	}
	return active, confs, keys, nil
}

func (s *Store) GetModelSettings(ctx context.Context, userID int64) (ModelSettings, error) {
	active, confs, keys, err := s.loadModel(ctx, userID)
	if err != nil {
		return ModelSettings{}, err
	}
	has := map[string]bool{}
	for k, v := range keys {
		has[k] = v != ""
	}
	return ModelSettings{Active: active, Providers: confs, HasKey: has}, nil
}

// ActiveProvider returns the user's selected provider configuration and its key.
func (s *Store) ActiveProvider(ctx context.Context, userID int64) (string, ProviderConf, string, error) {
	active, confs, keys, err := s.loadModel(ctx, userID)
	if err != nil {
		return "", ProviderConf{}, "", err
	}
	if active == "" {
		return "", ProviderConf{}, "", ErrNotFound
	}
	return active, confs[active], keys[active], nil
}

// SaveProvider stores a preset's configuration and makes it the active one.
// key == nil keeps the stored key; a pointer to "" removes it.
func (s *Store) SaveProvider(ctx context.Context, userID int64, preset string, conf ProviderConf, key *string) (ModelSettings, error) {
	preset = strings.TrimSpace(preset)
	if preset == "" || len(preset) > 40 {
		return ModelSettings{}, errors.New("invalid provider")
	}
	_, confs, keys, err := s.loadModel(ctx, userID)
	if err != nil {
		return ModelSettings{}, err
	}
	confs[preset] = conf
	if key != nil {
		if k := strings.TrimSpace(*key); k == "" {
			delete(keys, preset)
		} else {
			keys[preset] = k
		}
	}
	pj, _ := json.Marshal(confs)
	kj, _ := json.Marshal(keys)
	_, err = s.db.ExecContext(ctx, `INSERT INTO model_settings (user_id, active, providers, sealed_keys) VALUES (?, ?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET active = excluded.active, providers = excluded.providers, sealed_keys = excluded.sealed_keys`,
		userID, preset, string(pj), s.sealer.seal(kj, userID))
	if err != nil {
		return ModelSettings{}, err
	}
	return s.GetModelSettings(ctx, userID)
}
