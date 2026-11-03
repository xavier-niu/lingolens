package importer

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"io"
	"net/url"
	"path"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

const (
	MaxEPUBBytes      = 50 << 20  // upload size
	maxEPUBFiles      = 20_000    // entries in the archive
	maxChapterBytes   = 16 << 20  // one chapter, uncompressed
	maxEPUBTextBytes  = 128 << 20 // all chapters, uncompressed
	maxSmallFileBytes = 4 << 20   // container.xml, the package document, encryption.xml
)

type epubContainer struct {
	Rootfiles []struct {
		FullPath  string `xml:"full-path,attr"`
		MediaType string `xml:"media-type,attr"`
	} `xml:"rootfiles>rootfile"`
}

type epubPackage struct {
	Titles []string `xml:"metadata>title"`
	Items  []struct {
		ID         string `xml:"id,attr"`
		Href       string `xml:"href,attr"`
		MediaType  string `xml:"media-type,attr"`
		Properties string `xml:"properties,attr"`
	} `xml:"manifest>item"`
	Spine []struct {
		IDRef  string `xml:"idref,attr"`
		Linear string `xml:"linear,attr"`
	} `xml:"spine>itemref"`
}

type epubEncryption struct {
	Data []struct {
		Ref struct {
			URI string `xml:"URI,attr"`
		} `xml:"CipherData>CipherReference"`
	} `xml:"EncryptedData"`
}

// ReadEPUB extracts a DRM-free EPUB's text, chapter by chapter in reading order.
func ReadEPUB(r io.ReaderAt, size int64) (*Doc, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, userErr("That file isn't a valid EPUB book.")
	}
	if len(zr.File) > maxEPUBFiles {
		return nil, userErr("That EPUB has too many files inside to import.")
	}
	files := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		files[f.Name] = f
	}

	var container epubContainer
	if err := readXML(files, "META-INF/container.xml", &container); err != nil || len(container.Rootfiles) == 0 {
		return nil, userErr("That file isn't a valid EPUB book.")
	}
	if protected(files) {
		return nil, userErr("This EPUB is protected by DRM, so it can't be imported. Use a DRM-free copy.")
	}

	opfPath := container.Rootfiles[0].FullPath
	for _, rf := range container.Rootfiles {
		if rf.MediaType == "application/oebps-package+xml" {
			opfPath = rf.FullPath
			break
		}
	}
	var pkg epubPackage
	if err := readXML(files, opfPath, &pkg); err != nil {
		return nil, userErr("That EPUB's table of contents couldn't be read.")
	}
	base := path.Dir(opfPath)

	byID := make(map[string]int, len(pkg.Items))
	for i, it := range pkg.Items {
		byID[it.ID] = i
	}
	var chapters []string
	total := 0
	for _, ref := range pkg.Spine {
		i, ok := byID[ref.IDRef]
		if !ok || ref.Linear == "no" {
			continue
		}
		it := pkg.Items[i]
		if it.MediaType != "application/xhtml+xml" && it.MediaType != "text/html" {
			continue
		}
		if hasProp(it.Properties, "nav") {
			continue // the built-in table of contents page
		}
		name := resolve(base, it.Href)
		f := files[name]
		if f == nil {
			continue
		}
		data, err := readFile(f, maxChapterBytes)
		if err != nil {
			return nil, userErr("A chapter of that EPUB couldn't be read.")
		}
		total += len(data)
		if total > maxEPUBTextBytes {
			return nil, userErr("That EPUB is too large to import.")
		}
		if md := chapterMarkdown(data); md != "" {
			chapters = append(chapters, md)
		}
	}
	if len(chapters) == 0 {
		return nil, userErr("Couldn't find any readable text in that EPUB.")
	}

	title := ""
	if len(pkg.Titles) > 0 {
		title = strings.Join(strings.Fields(pkg.Titles[0]), " ")
	}
	return &Doc{Title: title, Format: "markdown", Content: strings.Join(chapters, "\n\n")}, nil
}

func chapterMarkdown(data []byte) string {
	doc, err := html.Parse(bytes.NewReader(data))
	if err != nil {
		return ""
	}
	body := find(doc, atom.Body)
	if body == nil {
		body = doc
	}
	return strings.TrimSpace(ToMarkdown(body))
}

func find(n *html.Node, a atom.Atom) *html.Node {
	if n.Type == html.ElementNode && n.DataAtom == a {
		return n
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if f := find(c, a); f != nil {
			return f
		}
	}
	return nil
}

// protected reports DRM: encrypted content other than fonts. (Publishers often
// obfuscate embedded fonts in otherwise DRM-free books; that's fine to ignore.)
func protected(files map[string]*zip.File) bool {
	if files["META-INF/rights.xml"] != nil {
		return true
	}
	var enc epubEncryption
	if err := readXML(files, "META-INF/encryption.xml", &enc); err != nil {
		return false
	}
	for _, d := range enc.Data {
		ext := strings.ToLower(path.Ext(d.Ref.URI))
		switch ext {
		case ".ttf", ".otf", ".woff", ".woff2":
		default:
			return true
		}
	}
	return false
}

func hasProp(props, want string) bool {
	for _, p := range strings.Fields(props) {
		if p == want {
			return true
		}
	}
	return false
}

// resolve turns a manifest href (relative to the package document, URL-encoded)
// into an archive path.
func resolve(base, href string) string {
	if i := strings.IndexByte(href, '#'); i >= 0 {
		href = href[:i]
	}
	if u, err := url.PathUnescape(href); err == nil {
		href = u
	}
	return strings.TrimPrefix(path.Join(base, href), "/")
}

func readXML(files map[string]*zip.File, name string, v any) error {
	f := files[name]
	if f == nil {
		return io.ErrUnexpectedEOF
	}
	data, err := readFile(f, maxSmallFileBytes)
	if err != nil {
		return err
	}
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = false
	dec.Entity = xml.HTMLEntity
	return dec.Decode(v)
}

// readFile reads one entry, refusing to inflate past limit (zip bombs).
func readFile(f *zip.File, limit int64) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, userErr("A file inside that EPUB is too large.")
	}
	return data, nil
}
