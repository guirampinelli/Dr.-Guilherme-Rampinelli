import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import * as nodeFs from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { MetricsStore, summarize } from '../lib/metrics.mjs';
import { postJson, removeDir, silentLogger, startServer, tempDir } from './helpers.mjs';

const VISIT = '/api/public/site-metrics/visit';
const CLICK = '/api/public/site-metrics/schedule-click';

function eventId() {
  return `drg_${crypto.randomUUID()}`;
}

function visit(sessionId, extra = {}) {
  return { type: 'landing_visit', event_id: eventId(), session_id: sessionId, page: 'consulta_online', ...extra };
}

function click(sessionId, cta = 'service_hero', extra = {}) {
  return { type: 'schedule_click', event_id: eventId(), session_id: sessionId, page: 'consulta_online', cta, ...extra };
}

async function stored(app) {
  await app.store.flush();
  return JSON.parse(await readFile(path.join(app.store.dataDir, 'metrics.json'), 'utf8'));
}

describe('endpoints de medição interna', () => {
  let app;
  let fetchCalls;

  beforeEach(async () => {
    fetchCalls = 0;
    // Sem credenciais CAPI: a medição local precisa funcionar mesmo assim.
    app = await startServer({
      dataDir: await tempDir(),
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('rede proibida');
      }
    });
  });

  afterEach(async () => {
    await app.close();
    await removeDir(app.store.dataDir);
  });

  test('conta sessões visitantes, sessões com clique e eventos por dia sem chamar a Meta', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    for (const body of [visit(a), visit(a), visit(b), click(a), click(a, 'service_sticky')]) {
      const response = await postJson(app.port, body.type === 'landing_visit' ? VISIT : CLICK, body);
      assert.equal(response.status, 204);
    }
    const [day] = summarize(await stored(app));
    assert.equal(day.visit_sessions, 2);
    assert.equal(day.click_sessions, 1);
    assert.equal(day.visit_to_click_rate, 0.5);
    assert.equal(day.landing_visit_events, 3);
    assert.equal(day.schedule_click_events, 2);
    assert.deepEqual(day.clicks_by_cta, { service_hero: 1, service_sticky: 1 });
    assert.equal(fetchCalls, 0);
  });

  test('exige origem permitida, same-origin e JSON', async () => {
    const body = visit(crypto.randomUUID());
    assert.equal((await postJson(app.port, VISIT, body, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await postJson(app.port, VISIT, body, { Origin: '' })).status, 403);
    assert.equal((await postJson(app.port, VISIT, body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await postJson(app.port, VISIT, body, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await postJson(app.port, VISIT, 'x'.repeat(3000))).status, 413);
    assert.equal((await postJson(app.port, VISIT, '{nope')).status, 400);
    const [day] = summarize(await stored(app));
    assert.equal(day?.landing_visit_events ?? 0, 0);
  });

  test('recusa tipo, ids, página, CTA e chaves fora da allowlist', async () => {
    const sessionId = crypto.randomUUID();
    const invalid = [
      [VISIT, { ...visit(sessionId), type: 'schedule_click' }],
      [VISIT, { ...visit(sessionId), event_id: 'curto' }],
      [VISIT, { ...visit(sessionId), session_id: 'not-a-uuid' }],
      [VISIT, { ...visit(sessionId), page: '/conteudos/glicemia-alta/' }],
      [VISIT, { ...visit(sessionId), page_path: '/consulta-medica-online/?fbclid=abc' }],
      [VISIT, { ...visit(sessionId), attribution: { fbclid: 'abc123456' } }],
      [VISIT, { ...visit(sessionId), attribution: 'meta' }],
      [CLICK, click(sessionId, 'reviews')],
      [CLICK, click(sessionId, 'profile_body')],
      [CLICK, { ...click(sessionId), cta: undefined }],
      [CLICK, visit(sessionId)]
    ];
    for (const [endpoint, body] of invalid) {
      const response = await postJson(app.port, endpoint, body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    const data = await stored(app);
    assert.equal(Object.keys(data.days).length, 0);
  });

  test('deduplica event_id inclusive com requisições concorrentes', async () => {
    const body = visit(crypto.randomUUID());
    const responses = await Promise.all(Array.from({ length: 25 }, () => postJson(app.port, VISIT, body)));
    assert.ok(responses.every((response) => response.status === 204));

    const sessions = Array.from({ length: 20 }, () => crypto.randomUUID());
    await Promise.all(sessions.map((sessionId) => postJson(app.port, VISIT, visit(sessionId))));

    const data = await stored(app);
    const [day] = summarize(data);
    assert.equal(day.landing_visit_events, 21);
    assert.equal(day.visit_sessions, 21);
    assert.equal(day.dropped.duplicate, 24);
  });

  test('atribuição guarda apenas códigos aprovados e descarta PII/texto livre', async () => {
    const sessionId = crypto.randomUUID();
    await postJson(app.port, VISIT, visit(sessionId, {
      attribution: {
        utm_source: 'Meta',
        utm_medium: 'paid_social',
        utm_campaign: 'drg_teleconsulta_sp_rj_2026_08',
        campaign_id: '120212345678901234',
        adset_id: '11987654321',
        ad_id: 'joao@example.com'
      }
    }));
    await postJson(app.port, VISIT, visit(crypto.randomUUID(), {
      attribution: {
        utm_source: 'paciente com dor no peito',
        utm_medium: 'email',
        utm_campaign: 'drg_11987654321',
        campaign_id: '123.456.789-09'
      }
    }));
    const data = await stored(app);
    const raw = JSON.stringify(data);
    for (const forbidden of ['11987654321', 'joao', 'example.com', 'peito', 'email', '123.456', sessionId]) {
      assert.ok(!raw.includes(forbidden), `não deveria guardar ${forbidden}`);
    }
    const [day] = summarize(data);
    const sources = day.by_attribution.map((item) => item);
    assert.deepEqual(sources.find((item) => item.source === 'meta'), {
      source: 'meta',
      medium: 'paid_social',
      campaign: 'drg_teleconsulta_sp_rj_2026_08',
      campaign_id: 'other',
      adset_id: 'other',
      ad_id: 'other',
      visit_sessions: 1,
      click_sessions: 0,
      visit_then_click_sessions: 0,
      landing_visit_events: 1,
      schedule_click_events: 0
    });
    assert.ok(sources.some((item) => item.source === 'other' && item.campaign === 'other' && item.medium === 'other'));
  });

  test('robôs recebem 204 sem registro e user agent/IP não são guardados', async () => {
    await postJson(app.port, VISIT, visit(crypto.randomUUID()), { 'User-Agent': 'facebookexternalhit/1.1' });
    await postJson(app.port, VISIT, visit(crypto.randomUUID()), { 'X-Forwarded-For': '203.0.113.9' });
    const data = await stored(app);
    const raw = JSON.stringify(data);
    assert.ok(!raw.includes('203.0.113.9'));
    assert.ok(!raw.includes('Mozilla'));
    assert.equal(summarize(data)[0].landing_visit_events, 1);
  });

  test('limita eventos por sessão contra spam', async () => {
    const sessionId = crypto.randomUUID();
    for (let index = 0; index < 35; index += 1) {
      await postJson(app.port, CLICK, click(sessionId), { 'X-Forwarded-For': `198.51.100.${index}` });
    }
    const [day] = summarize(await stored(app));
    assert.equal(day.schedule_click_events, 30);
    assert.equal(day.dropped.limit, 5);
  });

  test('responde 503 quando o armazenamento não está disponível', async () => {
    const offline = await startServer({ metricsStore: null });
    const response = await postJson(offline.port, VISIT, visit(crypto.randomUUID()));
    assert.equal(response.status, 503);
    await offline.close();
  });

  test('campanha fora da allowlist fechada vira "other" (inclusive drg_*)', async () => {
    for (const campaign of ['drg_maria_silva', 'drg_diabetes']) {
      await postJson(app.port, VISIT, visit(crypto.randomUUID(), { attribution: { utm_source: 'instagram', utm_campaign: campaign } }));
    }
    const data = await stored(app);
    const raw = JSON.stringify(data);
    assert.ok(!raw.includes('maria') && !raw.includes('diabetes'));
    const [day] = summarize(data);
    assert.deepEqual(day.by_attribution.map((item) => item.campaign), ['other']);
    assert.equal(day.by_attribution[0].visit_sessions, 2);
  });
});

test('falha de gravação após o início responde 503 e o reenvio idêntico é contado uma vez', async () => {
  const dir = await tempDir();
  let failRename = 0;
  const fs = {
    ...nodeFs,
    async rename(from, to) {
      if (failRename) {
        failRename -= 1;
        throw Object.assign(new Error('falha simulada'), { code: 'EIO' });
      }
      return nodeFs.rename(from, to);
    }
  };
  const app = await startServer({ metricsStore: new MetricsStore({ dataDir: dir, logger: silentLogger, fs }) });
  try {
    const body = visit(crypto.randomUUID());
    failRename = 1;
    assert.equal((await postJson(app.port, VISIT, body)).status, 503);
    assert.equal((await postJson(app.port, VISIT, body)).status, 204);
    assert.equal((await postJson(app.port, VISIT, body)).status, 204);
    const [day] = summarize(await stored(app));
    assert.equal(day.landing_visit_events, 1);
    assert.equal(day.dropped.duplicate, 1);
  } finally {
    await app.close();
    await removeDir(dir);
  }
});
