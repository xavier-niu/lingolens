// Command lingolens runs the LingoLens web server and manages its accounts.
//
//	lingolens [serve] [-addr host:port] [-data dir] [-static dir]
//	lingolens user add -email you@example.com [-name "Your Name"] [-admin]
//	lingolens user list
//	lingolens user passwd -email you@example.com
//	lingolens user delete -email you@example.com
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"golang.org/x/term"

	"github.com/xavier-niu/lingolens/internal/server"
	"github.com/xavier-niu/lingolens/internal/store"
	"github.com/xavier-niu/lingolens/web"
)

func main() {
	args := os.Args[1:]
	cmd := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	var err error
	switch cmd {
	case "serve":
		err = serve(args)
	case "user":
		err = userCmd(args)
	case "help", "-h", "--help":
		usage()
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `Usage:
  lingolens [serve] [-addr host:port] [-data dir] [-static dir]
  lingolens user add -email EMAIL [-name NAME] [-admin]
  lingolens user list
  lingolens user passwd -email EMAIL
  lingolens user delete -email EMAIL

Environment:
  LINGOLENS_ADDR            listen address (default 127.0.0.1:8080)
  LINGOLENS_DATA            data directory holding lingolens.db and secret.key (default ./data)
  LINGOLENS_SECRET          32-byte key (hex or base64) for encrypting stored API keys;
                            if unset, one is generated in the data directory
  LINGOLENS_ADMIN_EMAIL     with LINGOLENS_ADMIN_PASSWORD: create this admin on first start
  LINGOLENS_SECURE_COOKIES  set to 1 when served over HTTPS (e.g. behind a TLS proxy)
  LINGOLENS_PASSWORD        password for "user add" / "user passwd" instead of a prompt
`)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func openStore(dataDir string) (*store.Store, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	secret, err := store.LoadSecret(os.Getenv("LINGOLENS_SECRET"), filepath.Join(dataDir, "secret.key"))
	if err != nil {
		return nil, err
	}
	return store.Open(filepath.Join(dataDir, "lingolens.db"), secret)
}

// ---------------------------------------------------------------- serve

func serve(args []string) error {
	fl := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fl.String("addr", envOr("LINGOLENS_ADDR", "127.0.0.1:8080"), "listen address")
	dataDir := fl.String("data", envOr("LINGOLENS_DATA", "data"), "data directory")
	staticDir := fl.String("static", os.Getenv("LINGOLENS_STATIC_DIR"), "serve the UI from this directory instead of the embedded copy (frontend development)")
	_ = fl.Parse(args)

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	st, err := openStore(*dataDir)
	if err != nil {
		return err
	}
	defer st.Close()
	allowFake := os.Getenv("LINGOLENS_DEV_FAKE") == "1"
	if err := bootstrapAdmin(st, logger, allowFake); err != nil {
		return err
	}

	var static fs.FS = web.Static()
	if *staticDir != "" {
		static = os.DirFS(*staticDir)
		logger.Info("serving UI from disk", "dir", *staticDir)
	}
	if allowFake {
		logger.Warn("fake LLM provider enabled (LINGOLENS_DEV_FAKE=1); for development only")
	}

	srv := &http.Server{
		Addr: *addr,
		Handler: server.New(server.Options{
			Store: st, Static: static, AllowFake: allowFake, Logger: logger,
			SecureCookies:     os.Getenv("LINGOLENS_SECURE_COOKIES") == "1",
			AllowPrivateFetch: os.Getenv("LINGOLENS_FETCH_ALLOW_PRIVATE") == "1",
			PublicURL:         os.Getenv("LINGOLENS_PUBLIC_URL"),
		}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go purgeExpired(ctx, st, logger)
	errc := make(chan error, 1)
	go func() {
		logger.Info("LingoLens listening", "url", "http://"+*addr, "data", *dataDir)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
	}()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

// bootstrapAdmin creates the first admin from env vars, or explains how to.
// In development mode (devMode) a short password is accepted, for quick demos.
func bootstrapAdmin(st *store.Store, logger *slog.Logger, devMode bool) error {
	ctx := context.Background()
	n, err := st.CountUsers(ctx)
	if err != nil {
		return err
	}
	email, pw := os.Getenv("LINGOLENS_ADMIN_EMAIL"), os.Getenv("LINGOLENS_ADMIN_PASSWORD")
	if n > 0 {
		// The env admin is only for a fresh database; say so if it was expected.
		if email != "" {
			if _, err := st.GetUserByEmail(ctx, email); err != nil {
				logger.Warn("LINGOLENS_ADMIN_EMAIL ignored: the database already has accounts, and none with this email "+
					"(use another data directory, or add it with: lingolens user add -admin -email ...)", "email", email)
			}
		}
		return nil
	}
	if email == "" || pw == "" {
		logger.Warn("no accounts yet: open the app in a browser to create the first admin " +
			"(or run: lingolens user add -admin -email you@example.com). Until then, anyone who " +
			"reaches this server can do it, so finish setup now or set LINGOLENS_ADMIN_EMAIL and LINGOLENS_ADMIN_PASSWORD")
		return nil
	}
	create := st.CreateUser
	if devMode && store.ValidatePassword(pw) != nil {
		create = st.CreateDemoUser
		logger.Warn("demo admin has a short password; fine on your own machine, never on a shared server")
	}
	u, err := create(ctx, email, "", pw, true)
	if err != nil {
		return fmt.Errorf("create admin from LINGOLENS_ADMIN_EMAIL: %w", err)
	}
	logger.Info("created the first admin", "email", u.Email)
	return nil
}

// purgeExpired deletes expired sessions and texts whose time to live ran out, hourly.
func purgeExpired(ctx context.Context, st *store.Store, logger *slog.Logger) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		_ = st.PurgeExpiredSessions(ctx)
		if n, err := st.DeleteExpiredBooks(ctx); err == nil && n > 0 {
			logger.Info("deleted expired texts", "count", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// ---------------------------------------------------------------- user management

func userCmd(args []string) error {
	if len(args) == 0 {
		usage()
		return errors.New("missing user subcommand")
	}
	sub, args := args[0], args[1:]
	fl := flag.NewFlagSet("user "+sub, flag.ExitOnError)
	dataDir := fl.String("data", envOr("LINGOLENS_DATA", "data"), "data directory")
	email := fl.String("email", "", "account email")
	name := fl.String("name", "", "display name")
	admin := fl.Bool("admin", false, "make the account an admin")
	_ = fl.Parse(args)

	st, err := openStore(*dataDir)
	if err != nil {
		return err
	}
	defer st.Close()
	ctx := context.Background()

	needEmail := func() error {
		if *email == "" {
			return fmt.Errorf("user %s needs -email", sub)
		}
		return nil
	}
	switch sub {
	case "add":
		if err := needEmail(); err != nil {
			return err
		}
		pw, err := readPassword("Password for " + *email)
		if err != nil {
			return err
		}
		u, err := st.CreateUser(ctx, *email, *name, pw, *admin)
		if err != nil {
			return err
		}
		role := "member"
		if u.IsAdmin {
			role = "admin"
		}
		fmt.Printf("Created %s (%s).\n", u.Email, role)
	case "list":
		users, err := st.ListUsers(ctx)
		if err != nil {
			return err
		}
		tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\tEMAIL\tNAME\tROLE\tCREATED")
		for _, u := range users {
			role := "member"
			if u.IsAdmin {
				role = "admin"
			}
			fmt.Fprintf(tw, "%d\t%s\t%s\t%s\t%s\n", u.ID, u.Email, u.Name, role, u.CreatedAt)
		}
		return tw.Flush()
	case "passwd":
		if err := needEmail(); err != nil {
			return err
		}
		u, err := st.GetUserByEmail(ctx, *email)
		if err != nil {
			return fmt.Errorf("no account for %s", *email)
		}
		pw, err := readPassword("New password for " + u.Email)
		if err != nil {
			return err
		}
		if err := st.SetPassword(ctx, u.ID, pw, ""); err != nil {
			return err
		}
		fmt.Printf("Changed the password for %s and signed them out everywhere.\n", u.Email)
	case "delete":
		if err := needEmail(); err != nil {
			return err
		}
		u, err := st.GetUserByEmail(ctx, *email)
		if err != nil {
			return fmt.Errorf("no account for %s", *email)
		}
		if err := st.DeleteUser(ctx, u.ID); err != nil {
			return err
		}
		fmt.Printf("Deleted %s and all of their data.\n", u.Email)
	default:
		usage()
		return fmt.Errorf("unknown user subcommand %q", sub)
	}
	return nil
}

// readPassword takes LINGOLENS_PASSWORD, prompts without echo on a terminal, or
// reads one line from stdin when piped.
func readPassword(prompt string) (string, error) {
	if pw := os.Getenv("LINGOLENS_PASSWORD"); pw != "" {
		return pw, store.ValidatePassword(pw)
	}
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && line == "" {
			return "", errors.New("no password on stdin")
		}
		pw := strings.TrimRight(line, "\r\n")
		return pw, store.ValidatePassword(pw)
	}
	fmt.Fprintf(os.Stderr, "%s: ", prompt)
	first, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	if err := store.ValidatePassword(string(first)); err != nil {
		return "", err
	}
	fmt.Fprint(os.Stderr, "Repeat it: ")
	second, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	if string(first) != string(second) {
		return "", errors.New("the passwords don't match")
	}
	return string(first), nil
}
