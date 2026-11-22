package web

import (
	"io/fs"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// The service worker keeps the files listed in APP_FILES for offline use. The
// build writes the list (ui/vite.config.ts); a file the app needs that is
// missing from it would break the app offline.
func TestServiceWorkerListsEveryAppFile(t *testing.T) {
	static, err := fs.Sub(files, "dist")
	if err != nil {
		t.Fatal(err)
	}
	if !Built(static) {
		t.Skip("the web app isn't built (make ui)")
	}
	sw, err := fs.ReadFile(static, "sw.js")
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)const APP_FILES = \[(.*?)\];`).FindSubmatch(sw)
	if block == nil {
		t.Fatal("APP_FILES not found in sw.js")
	}
	var listed []string
	for _, m := range regexp.MustCompile(`"([^"]+)"`).FindAllSubmatch(block[1], -1) {
		listed = append(listed, string(m[1]))
	}

	notCached := func(path string) bool {
		switch {
		// The page (cached as './'), the service worker itself, what keeps dist/
		// in git, and licences, which the page doesn't use.
		case path == "index.html", path == "sw.js", path == ".gitkeep",
			strings.HasSuffix(path, ".txt"), strings.HasSuffix(path, "LICENSE"):
			return true
		// pdf.js (1.8 MB) loads only when someone adds a PDF, and Atkinson only
		// when chosen; the service worker keeps them from then on, like any file
		// it fetches.
		case strings.HasPrefix(path, "vendor/pdfjs/"), strings.Contains(path, "atkinson"):
			return true
		}
		return false
	}
	var all []string
	err = fs.WalkDir(static, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || notCached(path) {
			return err
		}
		all = append(all, path)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range all {
		if !slices.Contains(listed, f) {
			t.Errorf("%s is not in sw.js APP_FILES", f)
		}
	}
	for _, f := range listed {
		if f == "./" {
			continue
		}
		if _, err := fs.Stat(static, f); err != nil {
			t.Errorf("sw.js lists %s, which doesn't exist", f)
		}
	}
	if !slices.Contains(listed, "./") {
		t.Error("sw.js should cache the page itself ('./')")
	}
	for _, f := range []string{"theme.js", "vendor/fonts/literata-latin.woff2", "vendor/fonts/inter-latin.woff2"} {
		if !slices.Contains(listed, f) {
			t.Errorf("sw.js should cache %s", f)
		}
	}
}

// Without a built UI the server still runs, and its page says how to build it.
func TestNotBuiltPage(t *testing.T) {
	page, err := fs.ReadFile(notBuilt, "index.html")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(page), "make build") {
		t.Error("the placeholder page should say how to build the UI")
	}
}
