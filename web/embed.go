// Package web embeds the browser UI so the server ships as a single binary.
//
// The UI's source is in ui/ (React and shadcn/ui); `make ui` (or `npm run
// build` there) writes it to dist/, which is embedded here. dist/ holds only a
// .gitkeep until then, so the server still builds and runs, and says how to
// build the UI instead of showing it.
package web

import (
	"embed"
	"io/fs"
	"testing/fstest"
)

//go:embed all:dist
var files embed.FS

// Static returns the UI files rooted at dist/.
func Static() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		panic(err)
	}
	if !Built(sub) {
		return notBuilt
	}
	return sub
}

// Built reports whether static holds a built UI.
func Built(static fs.FS) bool {
	_, err := fs.Stat(static, "index.html")
	return err == nil
}

var notBuilt = fstest.MapFS{
	"index.html": {Data: []byte(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LingoLens</title>
<body style="font: 16px/1.5 system-ui, sans-serif; max-width: 34em; margin: 4em auto; padding: 0 1em">
<h1>The web app isn’t built</h1>
<p>This LingoLens server was compiled without its web app. Build it, then the server:</p>
<pre style="background: #f4f4f5; padding: 1em; border-radius: 8px">make build</pre>
<p>That needs <a href="https://nodejs.org/">Node.js</a> 20 or later as well as Go. The Docker image has it built in.</p>
</body>
`)},
}
