# Adding texts

Choose **Add Source** on the shelf. A text can come from:

- **Text:** paste it. Markdown (headings, lists, emphasis, links) is detected automatically. Up to 2,000,000 characters.
- **Web page:** enter a link. LingoLens fetches the page and keeps just the article, without menus, ads or comments.
- **Book or PDF:** a DRM-free EPUB (each chapter keeps its heading, and the book gets a Contents list) or a PDF with selectable text. Up to 50 MB.

Each text can be set to **Delete automatically** after a day, a week, 30 or 90 days, or a year; by default texts are kept forever. Change it later with **Edit text**. The shelf shows the days left on each cover.

## PDFs

LingoLens reads the PDF in your browser and rebuilds the text: lines are joined into paragraphs (also across pages and hyphenated line breaks), larger type becomes headings, and running headers, footers and page numbers are left out. The title comes from the PDF, else its first big heading, else the file name. The file itself is never uploaded, only the text taken from it.

The PDF needs text you can select: scanned pages are pictures of text, so run them through OCR first. Password-protected PDFs must be saved without the password. Tables, sidebars and footnotes come out as plain paragraphs; tidy a text afterwards with **Edit text** if needed.

## Bookmarklet

Some sites refuse requests from servers (*HTTP 403*), and some pages are only visible when you're signed in. For those, add the page from your own browser:

1. Open **Settings → Bookmarklet** and drag the **LingoLens** button to your bookmarks bar. (Show the bar with Ctrl/Cmd+Shift+B in Chrome and Edge, or *View → Show Favorites Bar* in Safari.)
2. On an article, click **LingoLens** in the bookmarks bar. To keep only part of the page, select it first.
3. A LingoLens tab opens (sign in if asked), shows the page's title and site, and adds it when you choose **Add to Shelf**. *Cancel* closes the tab.

On a phone or tablet there's no bar to drag to: copy the code from the same section, bookmark any page, edit that bookmark (name it *LingoLens*, paste the code as its address), then on an article type *LingoLens* in the address bar and tap the bookmark.

The bookmarklet contains this server's address, so add it again if LingoLens moves. If nothing happens, allow pop-ups for that site. A few sites that isolate their windows (`Cross-Origin-Opener-Policy`) can't hand the page over; the new tab then says *No page arrived*. Select the text and paste it in **Add Source → Text** instead.

## From AI agents

AI agents such as Claude Code can save their replies to your shelf. See [AI agents](agents.md).
