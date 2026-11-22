// Types for library.js (texts on the shelf, imports, reading time).
export const MAX_CHARS: number
export const MAX_EPUB_BYTES: number
export function getBook(id: string): Promise<any>
export function deleteBook(id: string): Promise<void>
export function saveProgress(id: string, pos: number, progress: number, opts?: { closing?: boolean }): Promise<void> | undefined
export function createBook(body: { title: string; content: string; format?: string; ttlDays?: number }): Promise<any>
export function updateBook(id: string, body: { title: string; content: string; format?: string; ttlDays?: number }): Promise<any>
export function importURL(url: string, title: string, ttlDays?: number): Promise<any>
export function importPage(page: { url: string; title: string; html: string; selection: string } | null): Promise<any>
export function importEPUB(file: File, title: string, ttlDays?: number): Promise<any>
export function markdownScore(content: string): number
export function wrapsBefore(line: string, next: string, width: number): boolean
export function wrapWidth(text: string): number
export function detectFormat(content: string): "markdown" | "text"
export function minutesLeft(book: { words: number; progress?: number }, level: string): number
export function readingStep(book: { words: number }, level: string): number
export function isFinished(book: { progress?: number }): boolean
export function tintFor(id: string): number
export function readLegacyData(): { books: any[]; wordbook: any[]; known: string[]; model: any }
export function hasLegacyData(): boolean
export function clearLegacyData(): void
