package skills

import (
	"io/fs"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// install.sh downloads the skill file by file, so its FILES list must name every
// file in skills/lingolens.
func TestInstallScriptListsEveryFile(t *testing.T) {
	src, err := os.ReadFile("install.sh")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^FILES=\(([^)]*)\)`).FindSubmatch(src)
	if m == nil {
		t.Fatal("no FILES=(...) line in install.sh")
	}
	listed := strings.Fields(string(m[1]))
	var have []string
	err = fs.WalkDir(files, "lingolens", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			have = append(have, strings.TrimPrefix(p, "lingolens/"))
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(listed)
	slices.Sort(have)
	if !slices.Equal(listed, have) {
		t.Fatalf("install.sh FILES = %v, skills/lingolens has %v", listed, have)
	}
}
