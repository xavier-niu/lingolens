// Types for pdftext.js (PDF → Markdown, in the browser).
export class PDFError extends Error {
  key: string
  constructor(key: string)
}
export function isPDF(file: File): boolean
export function readPDF(file: File, opts?: { onPage?: (i: number, n: number) => void }): Promise<{ title: string; content: string }>
