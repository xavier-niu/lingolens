package web

import (
	"io/fs"
	"regexp"
	"slices"
	"testing"
)

// The service worker keeps the files listed in APP_FILES for offline use. A file
// added to web/static but missing from the list would break the app offline.
func TestServiceWorkerListsEveryAppFile(t *testing.T) {
	static := Static()
	sw, err := fs.ReadFile(static, "sw.js")
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)const APP_FILES = \[(.*?)\];`).FindSubmatch(sw)
	if block == nil {
		t.Fatal("APP_FILES not found in sw.js")
	}
	var listed []string
	for _, m := range regexp.MustCompile(`'([^']+)'`).FindAllSubmatch(block[1], -1) {
		listed = append(listed, string(m[1]))
	}

	notCached := map[string]bool{
		"index.html":           true, // cached as './'
		"sw.js":                true, // the service worker itself
		"vendor/fonts/OFL.txt": true, // the font licence, not used by the page
		"vendor/pdfjs/LICENSE": true, // pdf.js's licence
		// pdf.js (1.8 MB) loads only when someone adds a PDF; the service worker
		// keeps it from then on, like any file it fetches.
		"vendor/pdfjs/pdf.min.js":        true,
		"vendor/pdfjs/pdf.worker.min.js": true,
	}
	var files []string
	err = fs.WalkDir(static, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || notCached[path] {
			return err
		}
		files = append(files, path)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
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
}
