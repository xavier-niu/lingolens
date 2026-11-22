// Types for i18n.js.
export function getLang(): string
export function setLang(next: string): void
export function t(key: string, vars?: Record<string, unknown>): any
export function applyI18n(): void
