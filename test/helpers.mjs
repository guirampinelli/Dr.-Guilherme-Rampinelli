import http from 'node:http';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAppServer, shutdownAppServer } from '../server.mjs';
import { MetricsStore } from '../lib/metrics.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ORIGIN = 'https://drrampinelli.com.br';
export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';

// Nenhum teste pode acessar a rede: o fetch global falha sempre.
globalThis.fetch = async () => {
  throw new Error('Acesso à rede bloqueado nos testes.');
};

export async function tempDir() {
  return mkdtemp(path.join(TEST_DIR, '.tmp-'));
}

export async function removeDir(dir) {
  await rm(dir, { recursive: true, force: true });
}

export const silentLogger = { info() {}, error() {}, log() {} };

export function capturingLogger() {
  const lines = [];
  const push = (line) => lines.push(JSON.parse(line));
  return { lines, info: push, error: push, log: push };
}

export async function startServer({ env = {}, fetchImpl, dataDir, logger = silentLogger, metricsStore } = {}) {
  const store = metricsStore !== undefined ? metricsStore : dataDir ? new MetricsStore({ dataDir, logger }) : null;
  if (store) await store.ready;
  const server = createAppServer({
    env: { NODE_ENV: 'production', ...env },
    fetchImpl: fetchImpl || (async () => {
      throw new Error('fetchImpl não deveria ser chamado.');
    }),
    logger,
    metricsStore: store,
    metaRetryDelaysMs: [0, 0],
    sleepImpl: async () => {}
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    store,
    port: server.address().port,
    close: async () => {
      await shutdownAppServer(server, store);
    }
  };
}

export function request(port, { method = 'GET', path: requestPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

export function postJson(port, requestPath, body, headers = {}) {
  return request(port, {
    method: 'POST',
    path: requestPath,
    headers: {
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'User-Agent': BROWSER_UA,
      'Sec-Fetch-Site': 'same-origin',
      ...headers
    },
    body
  });
}
