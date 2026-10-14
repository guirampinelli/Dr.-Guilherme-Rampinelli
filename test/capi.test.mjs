import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { buildMetaContactPayload, sendMetaContact, validateContactEvent } from '../server.mjs';
import { summarize } from '../lib/metrics.mjs';
import { capturingLogger, postJson, removeDir, startServer, tempDir } from './helpers.mjs';

// Credenciais fictícias: nenhuma chamada sai do processo (fetch simulado).
const FAKE_ENV = {
  META_CAPI_DATASET_ID: '1390054242458309',
  META_CAPI_ACCESS_TOKEN: 'TOKEN_FICTICIO_DE_TESTE'
};
const DESTINATION = 'https://www.doctoralia.com.br/guilherme-rampinelli/medico-clinico-geral/sao-paulo?utm_source=site';

function contactBody(overrides = {}) {
  return {
    event_type: 'doctoralia_schedule_click',
    event_id: `drg_${crypto.randomUUID()}`,
    event_time: new Date().toISOString(),
    page_path: '/conteudos/glicemia-alta/',
    page_type: 'article',
    page_variant: 'v1',
    cta_location: 'service_hero',
    destination_url: DESTINATION,
    attribution: {
      last_touch: { utm_source: 'meta', utm_campaign: 'texto livre', fbclid: 'IwAR123abc', captured_at: '2026-10-14T12:00:00.000Z' }
    },
    ...overrides
  };
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('payload Contact contém somente os campos permitidos', () => {
  const event = validateContactEvent(contactBody());
  const payload = buildMetaContactPayload(event, { clientIp: '203.0.113.5', clientUserAgent: 'Mozilla/5.0' });
  assert.equal(payload.data.length, 1);
  const [item] = payload.data;
  assert.deepEqual(Object.keys(item).sort(), ['action_source', 'event_id', 'event_name', 'event_source_url', 'event_time', 'user_data']);
  assert.equal(item.event_name, 'Contact');
  assert.equal(item.event_source_url, 'https://drrampinelli.com.br/consulta-medica-online/');
  assert.deepEqual(Object.keys(item.user_data).sort(), ['client_ip_address', 'client_user_agent', 'fbc']);
  const raw = JSON.stringify(payload);
  for (const forbidden of ['glicemia', 'texto livre', 'service_hero', 'utm_', 'session']) {
    assert.ok(!raw.includes(forbidden), `payload não deveria conter ${forbidden}`);
  }
});

test('sem credenciais não chama a Meta', async () => {
  let calls = 0;
  const result = await sendMetaContact(validateContactEvent(contactBody()), {
    env: {},
    fetchImpl: async () => {
      calls += 1;
    }
  });
  assert.deepEqual(result, { configured: false, sent: false, eventsReceived: 0, attempts: 0 });
  assert.equal(calls, 0);
});

test('falha transitória é reenviada com corpo e event_id idênticos', async () => {
  const bodies = [];
  const replies = [response(503, { error: { code: 2 } }), response(200, { events_received: 1 })];
  const result = await sendMetaContact(validateContactEvent(contactBody()), {
    env: FAKE_ENV,
    fetchImpl: async (url, init) => {
      assert.equal(url.hostname, 'graph.facebook.com');
      bodies.push(init.body);
      return replies.shift();
    },
    retryDelaysMs: [0, 0],
    sleepImpl: async () => {}
  });
  assert.equal(result.sent, true);
  assert.equal(result.attempts, 2);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test('erro permanente não é reenviado e tentativas são limitadas', async () => {
  let calls = 0;
  await assert.rejects(
    sendMetaContact(validateContactEvent(contactBody()), {
      env: FAKE_ENV,
      fetchImpl: async () => {
        calls += 1;
        return response(400, { error: { code: 100 } });
      },
      sleepImpl: async () => {}
    }),
    (error) => error.providerStatus === 400 && error.attempts === 1
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    sendMetaContact(validateContactEvent(contactBody()), {
      env: FAKE_ENV,
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError('fetch failed');
      },
      retryDelaysMs: [0, 0],
      sleepImpl: async () => {}
    })
  );
  assert.equal(calls, 3);
});

test('endpoint Contact: 204 imediato e agregados CAPI sem segredos', async () => {
  const dir = await tempDir();
  const logger = capturingLogger();
  const replies = [
    response(200, { events_received: 1 }),
    response(200, { events_received: 0 }),
    response(400, { error: { code: 190, message: 'token TOKEN_FICTICIO_DE_TESTE inválido' } })
  ];
  const app = await startServer({ env: FAKE_ENV, dataDir: dir, logger, fetchImpl: async () => replies.shift() });
  try {
    for (let index = 0; index < 3; index += 1) {
      const result = await postJson(app.port, '/api/public/site-events/contact', contactBody());
      assert.equal(result.status, 204);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await app.store.flush();

    const [day] = summarize(JSON.parse(await readFile(path.join(dir, 'metrics.json'), 'utf8')));
    assert.deepEqual(
      { attempted: day.capi.attempted, sent: day.capi.sent, zero: day.capi.events_received_0, failed: day.capi.failed },
      { attempted: 3, sent: 1, zero: 1, failed: 1 }
    );
    assert.deepEqual(day.capi.error_codes, { 'http_400:190': 1 });
    // Contact não alimenta a medição interna de visitas/cliques.
    assert.equal(day.schedule_click_events, 0);

    const serialized = JSON.stringify(logger.lines) + JSON.stringify(day);
    assert.ok(!serialized.includes('TOKEN_FICTICIO_DE_TESTE'));
    assert.ok(!serialized.includes('203.0.113'));
  } finally {
    await app.close();
    await removeDir(dir);
  }
});

test('endpoint Contact sem credenciais registra not_configured', async () => {
  const dir = await tempDir();
  const app = await startServer({ dataDir: dir });
  try {
    assert.equal((await postJson(app.port, '/api/public/site-events/contact', contactBody())).status, 204);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.store.flush();
    const [day] = summarize(JSON.parse(await readFile(path.join(dir, 'metrics.json'), 'utf8')));
    assert.equal(day.capi.not_configured, 1);
    assert.equal(day.capi.attempted, 0);
  } finally {
    await app.close();
    await removeDir(dir);
  }
});
