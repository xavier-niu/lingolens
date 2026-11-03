package server

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/xavier-niu/lingolens/internal/store"
)

const (
	sessionCookie = "lingolens_session"
	sessionTTL    = 30 * 24 * time.Hour
)

type ctxKey int

const (
	userKey ctxKey = iota
	tokenKey
)

func currentUser(ctx context.Context) *store.User {
	u, _ := ctx.Value(userKey).(*store.User)
	return u
}

func currentToken(ctx context.Context) string {
	t, _ := ctx.Value(tokenKey).(string)
	return t
}

// requireUser rejects requests without a valid session.
func (s *Server) requireUser(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "Sign in to continue.")
			return
		}
		u, err := s.opts.Store.UserBySession(r.Context(), c.Value, sessionTTL)
		if err != nil {
			s.clearSessionCookie(w, r)
			writeError(w, http.StatusUnauthorized, "Your session has ended. Sign in again.")
			return
		}
		ctx := context.WithValue(context.WithValue(r.Context(), userKey, u), tokenKey, c.Value)
		next(w, r.WithContext(ctx))
	}
}

func (s *Server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return s.requireUser(func(w http.ResponseWriter, r *http.Request) {
		if !currentUser(r.Context()).IsAdmin {
			writeError(w, http.StatusForbidden, "Only admins can manage accounts.")
			return
		}
		next(w, r)
	})
}

func (s *Server) secureCookie(r *http.Request) bool {
	return s.opts.SecureCookies || r.TLS != nil
}

func (s *Server) setSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", MaxAge: int(sessionTTL.Seconds()),
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: s.secureCookie(r),
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: s.secureCookie(r),
	})
}

// csrfGuard blocks cross-site writes. Session cookies are SameSite=Lax, and every
// state-changing request must either carry a JSON body (which a cross-site form
// can't send without a CORS preflight) or use a non-simple method; a present
// Origin header must match the host.
func csrfGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || !strings.EqualFold(u.Host, r.Host) {
				writeError(w, http.StatusForbidden, "Cross-site request blocked.")
				return
			}
		}
		// Cross-site forms can only send form encodings and text/plain; JSON (and the
		// EPUB upload's own type) need a CORS preflight, which this server never grants.
		ctype := r.Header.Get("Content-Type")
		epubUpload := r.URL.Path == "/api/books/import/epub" && ctype == "application/epub+zip"
		// Agent calls authenticate with a bearer token, never the cookie, so a
		// cross-site page can't make them on the user's behalf.
		agentCall := strings.HasPrefix(r.URL.Path, "/api/agent/")
		if r.Method == http.MethodPost && !strings.HasPrefix(ctype, "application/json") && !epubUpload && !agentCall {
			writeError(w, http.StatusUnsupportedMediaType, "Send JSON with Content-Type: application/json.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------- login throttling

// loginLimiter allows a few failed attempts per client IP and per email in a window.
type loginLimiter struct {
	mu       sync.Mutex
	failures map[string][]time.Time
}

const (
	loginWindow      = 15 * time.Minute
	loginMaxFailures = 8
)

func newLoginLimiter() *loginLimiter { return &loginLimiter{failures: map[string][]time.Time{}} }

func (l *loginLimiter) recent(key string, now time.Time) []time.Time {
	kept := l.failures[key][:0]
	for _, t := range l.failures[key] {
		if now.Sub(t) < loginWindow {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(l.failures, key)
	} else {
		l.failures[key] = kept
	}
	return kept
}

func (l *loginLimiter) blocked(keys ...string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	for _, k := range keys {
		if len(l.recent(k, now)) >= loginMaxFailures {
			return true
		}
	}
	return false
}

func (l *loginLimiter) fail(keys ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, k := range keys {
		l.failures[k] = append(l.failures[k], time.Now())
	}
}

func (l *loginLimiter) reset(keys ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, k := range keys {
		delete(l.failures, k)
	}
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---------------------------------------------------------------- handlers

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !decode(w, r, &req) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	keys := []string{"ip:" + clientIP(r), "email:" + email}
	if s.limiter.blocked(keys...) {
		writeError(w, http.StatusTooManyRequests, "Too many failed attempts. Wait 15 minutes and try again.")
		return
	}
	u, err := s.opts.Store.Authenticate(r.Context(), email, req.Password)
	if errors.Is(err, store.ErrInvalidCredentials) {
		s.limiter.fail(keys...)
		writeError(w, http.StatusUnauthorized, "Email or password is incorrect.")
		return
	}
	if err != nil {
		s.internalError(w, err)
		return
	}
	s.limiter.reset(keys...)
	token, err := s.opts.Store.CreateSession(r.Context(), u.ID, sessionTTL)
	if err != nil {
		s.internalError(w, err)
		return
	}
	s.setSessionCookie(w, r, token)
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
}

// handleSetup is first-run setup: while the server has no accounts, anyone who
// reaches it can create the first admin (and is signed in as it). Once any
// account exists it refuses, so it can't be used to add more admins.
func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if !decode(w, r, &req) {
		return
	}
	if !s.needsSetup(r) {
		writeError(w, http.StatusConflict, "This server is already set up. Sign in instead.")
		return
	}
	u, err := s.opts.Store.CreateFirstAdmin(r.Context(), req.Email, req.Name, req.Password)
	if errors.Is(err, store.ErrSetupDone) {
		writeError(w, http.StatusConflict, "This server is already set up. Sign in instead.")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, sentence(err))
		return
	}
	s.opts.Logger.Info("created the first admin through first-run setup", "email", u.Email, "ip", clientIP(r))
	token, err := s.opts.Store.CreateSession(r.Context(), u.ID, sessionTTL)
	if err != nil {
		s.internalError(w, err)
		return
	}
	s.setSessionCookie(w, r, token)
	writeJSON(w, http.StatusCreated, map[string]any{"user": u})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		_ = s.opts.Store.DeleteSession(r.Context(), c.Value)
	}
	s.clearSessionCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) internalError(w http.ResponseWriter, err error) {
	s.opts.Logger.Error("internal error", "err", err)
	writeError(w, http.StatusInternalServerError, "Something went wrong on the server. Try again.")
}
