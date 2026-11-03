// Runs the browser suites against a fresh LingoLens server.
//
//   node run.mjs [suite ...]        all suites when none are named
//
// Starts the server binary (LINGOLENS_BIN, default .bin/lingolens) on a free port
// with a throwaway data directory and the Fake model, serves fixtures/ over HTTP
// for the import tests, then runs each suite as `node <suite>.mjs <out dir>`.
// Screenshots and server.log land in out/. Exits non-zero if any check fails or
// a suite crashes.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITES = ['auth', 'shelf', 'devices', 'header', 'theme', 'source', 'offline'];
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
  try {
    const body = await readFile(join(HERE, 'fixtures', name));
    res.writeHead(200, { 'Content-Type': TYPES[extname(name)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => site.listen(0, '127.0.0.1', ok));
const sitePort = site.address().port;

// ---- the server under test
const port = await freePort();
const data = await mkdtemp(join(tmpdir(), 'lingolens-e2e-'));
const log = createWriteStream(join(out, 'server.log'));
const server = spawn(bin, ['-addr', `127.0.0.1:${port}`, '-data', data], {
  env: {
    ...process.env,
    LINGOLENS_DEV_FAKE: '1',
    LINGOLENS_FETCH_ALLOW_PRIVATE: '1', // the fixtures are on 127.0.0.1
    LINGOLENS_ADMIN_EMAIL: ADMIN.email,
    LINGOLENS_ADMIN_PASSWORD: ADMIN.password,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.pipe(log);
server.stderr.pipe(log);
let serverExit = null;
server.on('exit', (code, sig) => { serverExit = sig || code; });
server.on('error', (e) => { serverExit = e.message; });

const base = `http://127.0.0.1:${port}/`;
let failed = 0;
let passed = 0;
const problems = [];
try {
  await waitHealthy(base);
  console.log(`server ${base} (data ${data}), fixtures http://127.0.0.1:${sitePort}/\n`);
  for (const name of suites) {
    const r = await runSuite(name);
    passed += r.pass;
    failed += r.fail;
    if (r.fail) problems.push(`${name}: ${r.fail} failed`);
    if (r.code !== 0) problems.push(`${name}: exited with ${r.code}`);
    console.log(`== ${name}: ${r.pass} passed, ${r.fail} failed${r.code !== 0 ? `, exit ${r.code}` : ''} (${r.secs}s)\n`);
  }
} catch (e) {
  problems.push(e.message);
} finally {
  server.kill();
  site.close();
  await rm(data, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed. Screenshots and server.log: ${out}`);
if (problems.length) {
  console.log('\nFAILED:\n  ' + problems.join('\n  '));
  process.exit(1);
}

function runSuite(name) {
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

async function waitHealthy(url) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (serverExit !== null) throw new Error(`server exited (${serverExit}); see ${join(out, 'server.log')}`);
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
