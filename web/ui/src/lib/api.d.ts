// Types for api.js (the JSON client shared with offline.js).
export class ApiError extends Error {
  status: number
  offline: boolean
  constructor(message: string, status: number, opts?: { offline?: boolean })
}
export const net: { online: boolean; pending: number; syncing: boolean }
export function setOnline(on: boolean): void
export function offlineError(): ApiError
export function api(method: string, path: string, body?: unknown, opts?: { keepalive?: boolean; signal?: AbortSignal; type?: string }): Promise<any>
export function readNDJSON(resp: Response): AsyncGenerator<any>
export function postStream(path: string, body: unknown, signal?: AbortSignal): Promise<AsyncGenerator<any>>
