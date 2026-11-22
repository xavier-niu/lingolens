// Types for offline.js (this browser's copy of the account, the outbox, sync).
export const LOCAL_ID: string
export function cachedUserId(): string | null
export function openUser(id: string | number): Promise<void>
export function forgetUser(opts: { serverLoggedOut: boolean }): Promise<void>
export function finishPendingLogout(): Promise<void>
export function logoutPending(): boolean
export function rememberMe(me: unknown): Promise<void>
export function cachedMe(): Promise<any>
export function hash(str: string): string
export function useGlossVersion(version?: string): void
export function cachedAnns(level: string, texts: string[]): Promise<Map<string, any>>
export function saveAnns(level: string, text: string, anns: unknown): void
export function saveLookup(level: string, term: string, sentence: string, entry: unknown): void
export function cachedLookup(level: string, term: string, sentence: string, opts?: { anySentence?: boolean }): Promise<any>
export function loadData(name: string): Promise<any>
export function expiresFor(ttlDays: number, from?: number): string
export function saveProgress(id: string, pos: number, progress: number, opts?: { closing?: boolean }): Promise<void> | undefined
export function savePrefs(patch: Record<string, unknown>): Promise<void>
export function setKnown(lemma: string, known: boolean): Promise<void>
export function clearKnown(): Promise<void>
export function createText(body: unknown): Promise<any>
export function updateText(id: string, body: unknown): Promise<any>
export function deleteText(id: string): Promise<void>
export function getText(id: string): Promise<any>
export function flush(): Promise<void>
export function sync(): Promise<void>
