// Runs the browser suites against a fresh LingoLens server.
//
//   node run.mjs [suite ...]        all suites when none are named
//
// Starts the server binary (LINGOLENS_BIN, default .bin/lingolens) on a free port
// with a throwaway data directory and the Fake model, serves fixtures/ over HTTP
// for the import tests, then runs each suite as `node <suite>.mjs <out dir>`.
// Most suites share one server with an admin from the environment; "setup" gets
// its own server with no accounts. Screenshots and server logs land in out/.
// Exits non-zero if any check fails or a suite crashes.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITES = ['setup', 'auth', 'shelf', 'devices', 'header', 'theme', 'source', 'clip', 'offline'];
const OWN_SERVER = new Set(['setup']); // these need a server with an empty database
const SUITE_TIMEOUT = 5 * 60_000;
const ADMIN = { email: 'admin@example.com', password: 'admin password 1' };

const only = process.argv.slice(2);
const unknown = only.filter((s) => !SUITES.includes(s));
if (unknown.length) {
  console.error(`unknown suite: ${unknown.join(', ')} (have: ${SUITES.join(', ')})`);
  process.exit(2);
}
const suites = only.length ? only : SUITES;
const bin = resolve(HERE, process.env.LINGOLENS_BIN || '.bin/lingolens');
const out = join(HERE, 'out');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// ---- fixtures: a tiny static server, standing in for "a web page" and "an EPUB link"
const TYPES = { '.html': 'text/html; charset=utf-8', '.epub': 'application/epub+zip', '.txt': 'text/plain; charset=utf-8' };
const site = createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  if (!name || name.includes('/') || name.startsWith('.')) { res.writeHead(404).end(); return; }
  // Like sites that see through browser headers (by IP range or TLS fingerprint):
  // browsers get the page, the LingoLens server gets 403. Go's client asks only
  // for gzip; browsers also offer deflate.
  if (name === 'blocked.html' && !/deflate/.test(req.headers['accept-encoding'] || '')) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(join(HERE, 'fixtures', name));
    res.writeHead(200, { 'Content-Type': TYPES[extname(name)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => site.listen(0, '127.0.0.1', ok));
const sitePort = site.address().port;

// ---- the servers under test
const servers = [];
let failed = 0;
let passed = 0;
const problems = [];
try {
  const shared = suites.some((n) => !OWN_SERVER.has(n)) ? await startServer('server', { admin: true }) : null;
  if (shared) console.log(`server ${shared.base}, fixtures http://127.0.0.1:${sitePort}/\n`);
  for (const name of suites) {
    const target = OWN_SERVER.has(name) ? await startServer(`server-${name}`, { admin: false }) : shared;
    const r = await runSuite(name, target.base);
    if (target !== shared) await target.stop();
    passed += r.pass;
    failed += r.fail;
    if (r.fail) problems.push(`${name}: ${r.fail} failed`);
    if (r.code !== 0) problems.push(`${name}: exited with ${r.code}`);
    console.log(`== ${name}: ${r.pass} passed, ${r.fail} failed${r.code !== 0 ? `, exit ${r.code}` : ''} (${r.secs}s)\n`);
  }
} catch (e) {
  problems.push(e.message);
} finally {
  for (const s of servers) await s.stop();
  site.close();
}

console.log(`${passed} passed, ${failed} failed. Screenshots and server logs: ${out}`);
if (problems.length) {
  console.log('\nFAILED:\n  ' + problems.join('\n  '));
  process.exit(1);
}

// A LingoLens server on a free port with its own throwaway data directory.
async function startServer(label, { admin }) {
  const port = await freePort();
  const data = await mkdtemp(join(tmpdir(), 'lingolens-e2e-'));
  const log = createWriteStream(join(out, `${label}.log`));
  const env = {
    ...process.env,
    LINGOLENS_DEV_FAKE: '1',
    LINGOLENS_FETCH_ALLOW_PRIVATE: '1', // the fixtures are on 127.0.0.1
    LINGOLENS_ADMIN_EMAIL: admin ? ADMIN.email : '',
    LINGOLENS_ADMIN_PASSWORD: admin ? ADMIN.password : '',
  };
  const child = spawn(bin, ['-addr', `127.0.0.1:${port}`, '-data', data], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  let exit = null;
  const exited = new Promise((done) => child.on('close', done));
  child.on('exit', (code, sig) => { exit = sig || code; });
  child.on('error', (e) => { exit = e.message; });
  let stopped = false;
  const server = {
    base: `http://127.0.0.1:${port}/`,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (exit === null) child.kill();
      await exited;
      await rm(data, { recursive: true, force: true });
    },
  };
  servers.push(server);
  await waitHealthy(server.base, () => exit, label);
  return server;
}

function runSuite(name, base) {
  console.log(`== ${name}`);
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(HERE, `${name}.mjs`), out], {
      cwd: HERE,
      env: {
        ...process.env,
        E2E_BASE: base,
        E2E_SITE: `http://127.0.0.1:${sitePort}/`,
        E2E_ADMIN_EMAIL: ADMIN.email,
        E2E_ADMIN_PASSWORD: ADMIN.password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pass = 0;
    let fail = 0;
    let buf = '';
    child.stdout.on('data', (d) => {
      process.stdout.write(d);
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        if (l.startsWith('PASS ')) pass++;
        else if (l.startsWith('FAIL ')) fail++;
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    const timer = setTimeout(() => {
      console.log(`!! ${name} timed out after ${SUITE_TIMEOUT / 1000}s`);
      child.kill('SIGKILL');
    }, SUITE_TIMEOUT);
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (buf.startsWith('PASS ')) pass++;
      else if (buf.startsWith('FAIL ')) fail++;
      // A suite that never reported a check didn't really run.
      const ok = code === 0 && pass + fail > 0;
      done({ pass, fail, code: ok ? 0 : (sig || code || 'no checks'), secs: Math.round((Date.now() - started) / 1000) });
    });
  });
}

async function waitHealthy(url, exitStatus, label) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (exitStatus() !== null) throw new Error(`${label} exited (${exitStatus()}); see ${join(out, `${label}.log`)}`);
    try {
      if ((await fetch(url + 'api/health')).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not become healthy within 30s');
}

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => ok(p)); });
  });
}
