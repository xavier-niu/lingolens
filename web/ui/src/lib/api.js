// JSON calls to the LingoLens server. A 401 means the session has ended; the app
// listens for "auth-required" and shows the sign-in page.
//
// `net.online` says whether the server was reachable on the last try. It turns
// false when a request can't reach the server, and true on any response; each
// change fires a "netchange" event on window.

import { t } from './i18n.js';

export class ApiError extends Error {
  constructor(message, status, { offline = false } = {}) {
    super(message);
    this.status = status;
    this.offline = offline; // the server couldn't be reached
  }
}

export const net = { online: navigator.onLine !== false };

export function setOnline(on) {
  if (net.online === on) return;
  net.online = on;
  window.dispatchEvent(new CustomEvent('netchange'));
}

export const offlineError = () => new ApiError(t('net.needsConnection'), 0, { offline: true });

// `body` is sent as JSON, or as is when `type` names its content type (file uploads).
export async function api(method, path, body, { keepalive = false, signal, type } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin', keepalive, signal };
  if (body !== undefined) {
    opts.headers['Content-Type'] = type || 'application/json';
    opts.body = type ? body : JSON.stringify(body);
  }
  if (navigator.onLine === false) {
    setOnline(false);
    throw offlineError();
  }
  let resp;
  try {
    resp = await fetch(path, opts);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    setOnline(false);
    throw offlineError();
  }
  setOnline(true);
  if (resp.status === 401 && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new CustomEvent('auth-required'));
  }
  if (!resp.ok) {
    let msg = `${resp.status} ${resp.statusText}`;
    try { msg = (await resp.json()).error || msg; } catch { /* not JSON */ }
    throw new ApiError(msg, resp.status);
  }
  const respType = resp.headers.get('Content-Type') || '';
  return respType.includes('application/json') ? resp.json() : resp;
}

// Streaming endpoints (annotate, chat) return NDJSON: one JSON object per line.
export async function* readNDJSON(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

export async function postStream(path, body, signal) {
  const resp = await api('POST', path, body, { signal });
  return readNDJSON(resp);
}
