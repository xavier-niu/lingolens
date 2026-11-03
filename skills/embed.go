// Package skills ships the agent skills in this directory inside the binary, so a
// LingoLens server can hand them out (GET /skills/<name>.zip).
package skills

import (
	"archive/zip"
	"embed"
	"io"
	"io/fs"
	"path"
	"strings"
	"time"
)

//go:embed lingolens
var files embed.FS

// WriteZip writes the named skill as a zip whose top folder is the skill's name,
// ready to unpack into a skills directory (e.g. ~/.claude/skills).
func WriteZip(w io.Writer, name string) error {
	if _, err := fs.Stat(files, path.Join(name, "SKILL.md")); err != nil {
		return fs.ErrNotExist
	}
	zw := zip.NewWriter(w)
	err := fs.WalkDir(files, name, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := files.ReadFile(p)
		if err != nil {
			return err
		}
		h := &zip.FileHeader{Name: p, Method: zip.Deflate, Modified: time.Now()}
		mode := fs.FileMode(0o644)
		if strings.HasSuffix(p, ".sh") {
			mode = 0o755
		}
		h.SetMode(mode)
		f, err := zw.CreateHeader(h)
		if err != nil {
			return err
		}
		_, err = f.Write(data)
		return err
	})
	if err != nil {
		return err
	}
	return zw.Close()
}
