import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import * as nodeFs from 'node:fs/promises';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  CAMPAIGN_CODES,
  MetricsStore,
  sanitizeAttribution,
  saoPauloDay,
  summarize,
  validateMetricEvent
} from '../lib/metrics.mjs';
import { removeDir, silentLogger, tempDir } from './helpers.mjs';

function event(type = 'landing_visit', sessionId = crypto.randomUUID()) {
  return validateMetricEvent(
    {
      type,
      event_id: `drg_${crypto.randomUUID()}`,
      session_id: sessionId,
      page: 'consulta_online',
      ...(type === 'schedule_click' ? { cta: 'service_hero' } : {})
    },
    type
  );
}

test('dia de São Paulo, não UTC', () => {
  // 02:30 UTC de 15/10 ainda é 14/10 em São Paulo (UTC−3).
  assert.equal(saoPauloDay(new Date('2026-10-15T02:30:00Z')), '2026-10-14');
  assert.equal(saoPauloDay(new Date('2026-10-15T03:30:00Z')), '2026-10-15');
});

test('gravação atômica: JSON válido, permissões privadas e sem temporários', async () => {
  const dir = await tempDir();
  try {
    const store = new MetricsStore({ dataDir: dir, logger: silentLogger });
    await store.ready;
    await Promise.all(Array.from({ length: 50 }, () => store.record(event())));
    await store.flush();

    const files = await readdir(dir);
    assert.deepEqual(files, ['metrics.json']);
    const fileStat = await stat(path.join(dir, 'metrics.json'));
    assert.equal(fileStat.mode & 0o077, 0, 'arquivo não pode ser legível por outros usuários');
    const data = JSON.parse(await readFile(path.join(dir, 'metrics.json'), 'utf8'));
    assert.equal(summarize(data)[0].landing_visit_events, 50);

    // Um novo processo carrega o estado e continua deduplicando.
    const reopened = new MetricsStore({ dataDir: dir, logger: silentLogger });
    await reopened.ready;
    const first = event();
    assert.equal(await reopened.record(first), 'recorded');
    assert.equal(await reopened.record(first), 'duplicate');
    await reopened.flush();
  } finally {
    await removeDir(dir);
  }
});

test('retenção de 30 dias e deduplicação dentro da retenção', async () => {
  const dir = await tempDir();
  try {
    let now = new Date('2026-09-01T15:00:00Z');
    const store = new MetricsStore({ dataDir: dir, now: () => now, logger: silentLogger });
    await store.ready;
    const old = event();
    await store.record(old);

    now = new Date('2026-09-25T15:00:00Z');
    assert.equal(await store.record(old), 'duplicate', 'mesmo event_id dentro de 30 dias');

    now = new Date('2026-10-14T15:00:00Z');
    await store.record(event());
    await store.flush();
    const data = JSON.parse(await readFile(path.join(dir, 'metrics.json'), 'utf8'));
    assert.deepEqual(Object.keys(data.days).sort(), ['2026-09-25', '2026-10-14']);
  } finally {
    await removeDir(dir);
  }
});

test('arquivo corrompido é descartado sem cópia e sobras antigas são apagadas', async () => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, 'metrics.json'), '{corrompido');
    await writeFile(path.join(dir, 'metrics.json.corrupt-1700000000000'), '{dados antigos');
    await writeFile(path.join(dir, 'metrics.json.123.abcdef.tmp'), '{parcial');
    const store = new MetricsStore({ dataDir: dir, logger: silentLogger });
    assert.equal(await store.ready, true);
    assert.equal(await store.record(event()), 'recorded');
    await store.close();
    assert.deepEqual(await readdir(dir), ['metrics.json']);
  } finally {
    await removeDir(dir);
  }
});

test('diretório não gravável deixa a medição indisponível sem derrubar o servidor', async () => {
  const dir = await tempDir();
  try {
    const blocker = path.join(dir, 'arquivo');
    await writeFile(blocker, '');
    const store = new MetricsStore({ dataDir: path.join(blocker, 'metrics'), logger: silentLogger });
    assert.equal(await store.ready, false);
    assert.equal(await store.record(event()), 'unavailable');
  } finally {
    await removeDir(dir);
  }
});

test('IDs arbitrários não esgotam os grupos da campanha aprovada', async () => {
  const dir = await tempDir();
  try {
    const store = new MetricsStore({ dataDir: dir, logger: silentLogger });
    await store.ready;
    for (let index = 0; index < 60; index += 1) {
      const parsed = validateMetricEvent(
        {
          type: 'landing_visit',
          event_id: `drg_${crypto.randomUUID()}`,
          session_id: crypto.randomUUID(),
          page: 'consulta_online',
          attribution: { utm_campaign: 'drg_ig_lpv_202610', ad_id: String(120212345678900000n + BigInt(index)) }
        },
        'landing_visit'
      );
      await store.record(parsed);
    }
    const approved = validateMetricEvent({
      type: 'landing_visit', event_id: `drg_${crypto.randomUUID()}`,
      session_id: crypto.randomUUID(), page: 'consulta_online',
      attribution: { utm_source: 'instagram', utm_medium: 'paid_social',
        utm_campaign: 'drg_ig_lpv_202610', campaign_id: '120249610857750644',
        adset_id: '120249610857770644', ad_id: '120249610857760644' }
    }, 'landing_visit');
    await store.record(approved);
    await store.flush();
    const data = JSON.parse(await readFile(path.join(dir, 'metrics.json'), 'utf8'));
    const keys = Object.keys(Object.values(data.days)[0].attribution);
    assert.equal(keys.length, 2);
    assert.ok(!keys.includes('overflow'));
    assert.ok(keys.some((key) => key.includes('120249610857750644')));
    assert.ok(!JSON.stringify(data).includes('120212345678900000'));
  } finally {
    await removeDir(dir);
  }
});

test('sanitizeAttribution só aceita códigos conhecidos', () => {
  assert.deepEqual(sanitizeAttribution({ utm_source: 'instagram', utm_medium: 'PAID_SOCIAL', utm_campaign: 'drg_ig_lpv_202610' }), {
    source: 'instagram',
    medium: 'paid_social',
    campaign: 'drg_ig_lpv_202610',
    campaign_id: 'none',
    adset_id: 'none',
    ad_id: 'none'
  });
  const hostile = sanitizeAttribution({
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'DRG Maria (11) 98765-4321',
    campaign_id: '11987654321',
    adset_id: { nested: true },
    ad_id: 'x'.repeat(500)
  });
  assert.deepEqual(Object.values(hostile), ['other', 'other', 'other', 'other', 'other', 'other']);
  assert.equal(sanitizeAttribution({ utm_campaign: 'drg_123456789' }).campaign, 'other');
});

test('allowlist de campanhas é fechada', () => {
  for (const code of ['drg_ig_lpv_202610', 'drg_contact_sp_rj_202608', 'drg_teleconsulta_sp_rj_2026_08']) {
    assert.equal(sanitizeAttribution({ utm_campaign: code }).campaign, code);
  }
  for (const code of ['drg_maria_silva', 'drg_diabetes', 'drg_ig_lpv_202611', 'DRG_IG_LPV_202610', 'drg_ig_lpv_202610 ']) {
    assert.equal(sanitizeAttribution({ utm_campaign: code }).campaign, 'other', code);
  }
  assert.equal(CAMPAIGN_CODES.size, 3);
});

// fs com falhas injetáveis: cada chave em `fail` lança EIO na próxima chamada correspondente.
function flakyFs(fail) {
  return {
    ...nodeFs,
    async open(file, flags, mode) {
      const handle = await nodeFs.open(file, flags, mode);
      return {
        async writeFile(data) {
          if (fail.writeFile) {
            fail.writeFile -= 1;
            throw Object.assign(new Error('falha simulada'), { code: 'EIO' });
          }
          return handle.writeFile(data);
        },
        async sync() {
          if (fail.sync) {
            fail.sync -= 1;
            throw Object.assign(new Error('falha simulada'), { code: 'EIO' });
          }
          return handle.sync();
        },
        close: () => handle.close()
      };
    },
    async rename(from, to) {
      if (fail.rename) {
        fail.rename -= 1;
        throw Object.assign(new Error('falha simulada'), { code: 'EIO' });
      }
      return nodeFs.rename(from, to);
    }
  };
}

test('falha transitória de disco após gravação bem-sucedida: nada muda e o reenvio idêntico é aceito', async () => {
  const dir = await tempDir();
  const fail = {};
  try {
    const store = new MetricsStore({ dataDir: dir, logger: silentLogger, fs: flakyFs(fail) });
    await store.ready;
    const sessionId = crypto.randomUUID();
    assert.equal(await store.record(event('landing_visit', sessionId)), 'recorded');
    const before = await readFile(path.join(dir, 'metrics.json'), 'utf8');

    const click = event('schedule_click', sessionId);
    for (const step of ['writeFile', 'sync', 'rename']) {
      fail[step] = 1;
      assert.equal(await store.record(click), 'unavailable', `falha em ${step} não pode virar recorded`);
      assert.equal(await readFile(path.join(dir, 'metrics.json'), 'utf8'), before, 'arquivo intacto');
      assert.deepEqual(await readdir(dir), ['metrics.json'], `sem .tmp após falha em ${step}`);
      const [day] = summarize(store.data);
      assert.equal(day.schedule_click_events, 0, 'contador em memória intacto');
      assert.equal(day.dropped.duplicate, 0);
    }

    // Disco voltou: o mesmo evento é gravado (não é tratado como duplicado) e só uma vez.
    assert.equal(await store.record(click), 'recorded');
    assert.equal(await store.record(click), 'duplicate');
    await store.close();
    const [day] = summarize(JSON.parse(await readFile(path.join(dir, 'metrics.json'), 'utf8')));
    assert.equal(day.schedule_click_events, 1);
    assert.equal(day.visit_then_click_sessions, 1);
    assert.equal(day.dropped.duplicate, 1);

    // Um novo processo vê o mesmo estado e continua deduplicando.
    const reopened = new MetricsStore({ dataDir: dir, logger: silentLogger });
    assert.equal(await reopened.record(click), 'duplicate');
    await reopened.close();
  } finally {
    await removeDir(dir);
  }
});

test('falhas concorrentes no mesmo lote não deixam estado parcial', async () => {
  const dir = await tempDir();
  const fail = {};
  try {
    const store = new MetricsStore({ dataDir: dir, logger: silentLogger, fs: flakyFs(fail) });
    await store.ready;
    const events = Array.from({ length: 10 }, () => event());
    fail.rename = 1;
    const first = await Promise.all(events.map((item) => store.record(item)));
    // Algumas podem ter caído no lote que falhou; nenhuma delas pode ter sido contada.
    const failed = events.filter((_, index) => first[index] === 'unavailable');
    assert.ok(failed.length >= 1);
    const retried = await Promise.all(failed.map((item) => store.record(item)));
    assert.ok(retried.every((outcome) => outcome === 'recorded'));
    await store.close();
    const [day] = summarize(JSON.parse(await readFile(path.join(dir, 'metrics.json'), 'utf8')));
    assert.equal(day.landing_visit_events, 10);
  } finally {
    await removeDir(dir);
  }
});

test('limpeza periódica apaga dias expirados sem novo evento (now injetado)', async () => {
  const dir = await tempDir();
  try {
    let now = new Date('2026-09-01T15:00:00Z');
    const store = new MetricsStore({ dataDir: dir, now: () => now, logger: silentLogger, cleanupIntervalMs: 0 });
    await store.ready;
    await store.record(event());
    assert.equal(await store.cleanup(), false, 'nada a apagar ainda');

    now = new Date('2026-10-14T15:00:00Z');
    await writeFile(path.join(dir, 'metrics.json.999.deadbeef.tmp'), '{orfao');
    assert.equal(await store.cleanup(), true);
    const data = JSON.parse(await readFile(path.join(dir, 'metrics.json'), 'utf8'));
    assert.deepEqual(Object.keys(data.days), []);
    assert.deepEqual(await readdir(dir), ['metrics.json']);
    // O event_id expirado sai também do índice de dedupe.
    assert.equal(store.eventIndex.size, 0);
    await store.close();
  } finally {
    await removeDir(dir);
  }
});

test('timer de limpeza usa unref e close() o encerra', async () => {
  const dir = await tempDir();
  try {
    const store = new MetricsStore({ dataDir: dir, logger: silentLogger, cleanupIntervalMs: 5 });
    await store.ready;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.close();
    assert.equal(await store.record(event()), 'unavailable', 'store fechado não aceita eventos');
  } finally {
    await removeDir(dir);
  }
});

test('summarize filtra pela janela relativa a agora, não pelas últimas datas do arquivo', () => {
  const data = {
    days: {
      '2026-08-01': { totals: { landing_visit: 5 } },
      '2026-09-14': { totals: { landing_visit: 1 } },
      '2026-09-15': { totals: { landing_visit: 2 } },
      '2026-10-14': { totals: { landing_visit: 3 } }
    }
  };
  const now = new Date('2026-10-14T15:00:00Z');
  assert.deepEqual(summarize(data, { now }).map((day) => day.day), ['2026-09-15', '2026-10-14']);
  assert.deepEqual(summarize(data, { now, days: 7 }).map((day) => day.day), ['2026-10-14']);
  assert.deepEqual(summarize(data, { now: new Date('2026-12-31T15:00:00Z') }), []);
});

test('clique sem visita comprovada não entra no denominador', async () => {
  const dir = await tempDir();
  try {
    const store = new MetricsStore({ dataDir: dir, logger: silentLogger });
    const withVisit = crypto.randomUUID();
    await store.record(event('landing_visit', withVisit));
    await store.record(event('landing_visit', crypto.randomUUID()));
    await store.record(event('schedule_click', withVisit));
    await store.record(event('schedule_click', crypto.randomUUID()));
    await store.close();
    const [day] = summarize(store.data);
    assert.equal(day.visit_sessions, 2);
    assert.equal(day.click_sessions, 2);
    assert.equal(day.visit_then_click_sessions, 1);
    assert.equal(day.click_without_visit_sessions, 1);
    assert.equal(day.visit_to_click_rate, 0.5);
  } finally {
    await removeDir(dir);
  }
});
