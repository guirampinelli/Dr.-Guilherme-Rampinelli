import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { shutdownAppServer } from '../server.mjs';
import { summarize } from '../lib/metrics.mjs';
import { BROWSER_UA, ORIGIN, postJson, removeDir, startServer, tempDir } from './helpers.mjs';

test('shutdown espera corpo HTTP em andamento, CAPI pendente e gravação antes de fechar o store', async () => {
  const dir = await tempDir();
  let releaseMeta;
  const metaReply = new Promise((resolve) => { releaseMeta = resolve; });
  const app = await startServer({ dataDir: dir,
    env: { META_CAPI_DATASET_ID: '1390054242458309', META_CAPI_ACCESS_TOKEN: 'TOKEN_FICTICIO' },
    fetchImpl: async () => { await metaReply; return { ok: true, status: 200, json: async () => ({ events_received: 1 }) }; }
  });
  try {
    const contact = await postJson(app.port, '/api/public/site-events/contact', {
      event_type: 'doctoralia_schedule_click', event_id: `drg_${crypto.randomUUID()}`,
      event_time: new Date().toISOString(), page_path: '/consulta-medica-online/',
      page_type: 'teleconsulta_landing', page_variant: 'v1', cta_location: 'service_hero',
      destination_url: 'https://www.doctoralia.com.br/guilherme-rampinelli/medico-clinico-geral/sao-paulo'
    });
    assert.equal(contact.status, 204);
    const body = JSON.stringify({ type: 'landing_visit', event_id: `drg_${crypto.randomUUID()}`,
      session_id: crypto.randomUUID(), page: 'consulta_online' });
    const requestStarted = once(app.server, 'request');
    let resolveResponse;
    const response = new Promise((resolve) => { resolveResponse = resolve; });
    const req = http.request({ host: '127.0.0.1', port: app.port, method: 'POST',
      path: '/api/public/site-metrics/visit', headers: { Origin: ORIGIN, 'User-Agent': BROWSER_UA,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { res.resume(); res.on('end', () => resolveResponse(res.statusCode)); });
    req.write(body.slice(0, 30));
    await requestStarted;
    let completed = false;
    const draining = shutdownAppServer(app.server, app.store).then(() => { completed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false, 'não fecha com corpo HTTP incompleto');
    req.end(body.slice(30));
    assert.equal(await response, 204);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false, 'HTTP fechado ainda espera a CAPI');
    releaseMeta();
    await draining;
    const [day] = summarize(JSON.parse(await readFile(path.join(dir, 'metrics.json'), 'utf8')));
    assert.equal(day.landing_visit_events, 1);
    assert.equal(day.capi.sent, 1);
  } finally {
    releaseMeta();
    if (app.server.listening) await app.close();
    await removeDir(dir);
  }
});
