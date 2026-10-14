// Medição interna e privada da landing de consulta (somente com consentimento).
// Nada aqui é enviado à Meta. Não guardamos IP, user agent, fbclid, URL completa,
// páginas de artigos de saúde nem texto livre: apenas códigos de allowlist e hashes
// truncados de sessão/evento (deduplicação), apagados após 30 dias.
import crypto from 'node:crypto';
import path from 'node:path';
import * as nodeFs from 'node:fs/promises';

export const METRICS_FILE_NAME = 'metrics.json';
export const RETENTION_DAYS = 30;
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const METRICS_PAGES = new Set(['consulta_online']);
export const SCHEDULE_CTAS = new Set(['service_header', 'service_hero', 'service_final', 'service_sticky']);
// Allowlist FECHADA de campanhas: qualquer outro valor (inclusive drg_*) vira "other".
export const CAMPAIGN_CODES = new Set([
  'drg_ig_lpv_202610',
  'drg_ig_contact_202610',
  'drg_contact_sp_rj_202608',
  'drg_teleconsulta_sp_rj_2026_08'
]);

const SOURCE_CODES = new Set(['meta', 'facebook', 'instagram']);
const MEDIUM_CODES = new Set(['paid_social']);
const CAPI_STATUSES = new Set(['sent', 'events_received_0', 'failed', 'not_configured']);
const LIMITS = {
  sessionsPerDay: 5000,
  eventIdsPerDay: 20000,
  attributionKeysPerDay: 256,
  eventsPerSessionPerDay: 30,
  errorCodesPerDay: 20
};
const EVENT_KEYS = {
  landing_visit: new Set(['type', 'event_id', 'session_id', 'page', 'attribution']),
  schedule_click: new Set(['type', 'event_id', 'session_id', 'page', 'cta', 'attribution'])
};
const ATTRIBUTION_KEYS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'campaign_id', 'adset_id', 'ad_id']);
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_ID_RE = /^drg_[A-Za-z0-9_-]{16,80}$/;
// Somente as triplas verificadas das campanhas podem criar uma dimensão de IDs.
// Qualquer outra combinação vira um único grupo "other" (sem texto/números livres).
const APPROVED_META_IDS = {
  drg_ig_lpv_202610: {
    campaign_id: '120249610857750644',
    adset_id: '120249610857770644',
    ad_id: '120249610857760644'
  },
  drg_ig_contact_202610: {
    campaign_id: '120249611849970644',
    adset_id: '120249611850000644',
    ad_id: '120249611849990644'
  }
};
const META_ID_KEYS = ['campaign_id', 'adset_id', 'ad_id'];
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// Sobras de gravação interrompida e cópias de arquivo corrompido (versões anteriores).
const STRAY_FILE_RE = new RegExp(`^${METRICS_FILE_NAME.replace('.', '\\.')}\\.(?:.+\\.tmp|corrupt-.*)$`);
const UNAVAILABLE = 'unavailable';

const SAO_PAULO_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export function saoPauloDay(date = new Date()) {
  return SAO_PAULO_DAY.format(date);
}

// Primeiro dia (São Paulo) mantido numa janela de `days` dias terminando em `now`.
export function retentionCutoff(now = new Date(), days = RETENTION_DAYS) {
  return saoPauloDay(new Date(now.getTime() - (days - 1) * DAY_MS));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function codeOrOther(value, check) {
  if (value === undefined || value === null || value === '') return 'none';
  if (typeof value !== 'string' || value.length > 64) return 'other';
  return check(value) ? value : 'other';
}

// Retorna sempre um conjunto fechado de códigos; texto livre vira "other".
export function sanitizeAttribution(value) {
  const input = isPlainObject(value) ? value : {};
  const source = typeof input.utm_source === 'string' ? input.utm_source.toLowerCase() : input.utm_source;
  const medium = typeof input.utm_medium === 'string' ? input.utm_medium.toLowerCase() : input.utm_medium;
  const codes = {
    source: codeOrOther(source, (item) => SOURCE_CODES.has(item)),
    medium: codeOrOther(medium, (item) => MEDIUM_CODES.has(item)),
    campaign: codeOrOther(input.utm_campaign, (item) => CAMPAIGN_CODES.has(item))
  };
  const approvedIds = APPROVED_META_IDS[codes.campaign];
  const approved = codes.source === 'instagram' && codes.medium === 'paid_social' && approvedIds &&
    Object.entries(approvedIds).every(([key, id]) => input[key] === id);
  const hasIds = META_ID_KEYS.some((key) => input[key] !== undefined && input[key] !== null && input[key] !== '');
  const ids = approved ? approvedIds : Object.fromEntries(
    META_ID_KEYS.map((key) => [key, hasIds ? 'other' : 'none'])
  );
  // 5 fontes x 3 meios x 6 campanhas x 2 grupos de IDs + 2 triplas aprovadas = 182,
  // sempre abaixo do teto 256; IDs arbitrários não esgotam os grupos legítimos.
  return { ...codes, ...ids };
}

export function attributionKey(attribution) {
  return [
    attribution.source,
    attribution.medium,
    attribution.campaign,
    attribution.campaign_id,
    attribution.adset_id,
    attribution.ad_id
  ].join('|');
}

export function parseAttributionKey(key) {
  const [source, medium, campaign, campaign_id, adset_id, ad_id] = String(key).split('|');
  return { source, medium, campaign, campaign_id, adset_id, ad_id };
}

// Validação estrita: chaves extras, tipos errados ou valores fora da allowlist são recusados.
export function validateMetricEvent(value, expectedType) {
  if (!isPlainObject(value) || !EVENT_KEYS[expectedType]) return null;
  if (value.type !== expectedType) return null;
  for (const key of Object.keys(value)) {
    if (!EVENT_KEYS[expectedType].has(key)) return null;
  }
  if (typeof value.event_id !== 'string' || !EVENT_ID_RE.test(value.event_id)) return null;
  if (typeof value.session_id !== 'string' || !UUID_V4_RE.test(value.session_id)) return null;
  if (typeof value.page !== 'string' || !METRICS_PAGES.has(value.page)) return null;
  if (expectedType === 'schedule_click' && (typeof value.cta !== 'string' || !SCHEDULE_CTAS.has(value.cta))) {
    return null;
  }
  if (value.attribution !== undefined) {
    if (!isPlainObject(value.attribution)) return null;
    for (const key of Object.keys(value.attribution)) {
      if (!ATTRIBUTION_KEYS.has(key)) return null;
    }
  }
  return {
    type: expectedType,
    eventHash: shortHash(value.event_id),
    sessionHash: shortHash(value.session_id),
    page: value.page,
    cta: expectedType === 'schedule_click' ? value.cta : null,
    attribution: attributionKey(sanitizeAttribution(value.attribution))
  };
}

function emptyDay() {
  return {
    totals: { landing_visit: 0, schedule_click: 0 },
    cta: {},
    attribution: {},
    sessions: {},
    event_ids: [],
    dropped: { duplicate: 0, limit: 0 },
    capi: { attempted: 0, sent: 0, events_received_0: 0, failed: 0, not_configured: 0, retries: 0, error_codes: {} }
  };
}

function normalizeDay(raw) {
  const day = emptyDay();
  if (!isPlainObject(raw)) return day;
  for (const key of ['totals', 'dropped']) {
    if (isPlainObject(raw[key])) {
      for (const field of Object.keys(day[key])) day[key][field] = Number(raw[key][field]) || 0;
    }
  }
  if (isPlainObject(raw.cta)) {
    for (const [cta, count] of Object.entries(raw.cta)) {
      if (SCHEDULE_CTAS.has(cta)) day.cta[cta] = Number(count) || 0;
    }
  }
  if (isPlainObject(raw.attribution)) {
    for (const [key, counts] of Object.entries(raw.attribution).slice(0, LIMITS.attributionKeysPerDay + 1)) {
      if (!isPlainObject(counts)) continue;
      day.attribution[key] = {
        landing_visit: Number(counts.landing_visit) || 0,
        schedule_click: Number(counts.schedule_click) || 0
      };
    }
  }
  if (isPlainObject(raw.sessions)) {
    for (const [hash, session] of Object.entries(raw.sessions).slice(0, LIMITS.sessionsPerDay)) {
      if (!/^[0-9a-f]{24}$/.test(hash) || !isPlainObject(session)) continue;
      day.sessions[hash] = {
        a: String(session.a || 'overflow').slice(0, 200),
        v: session.v ? 1 : 0,
        c: session.c ? 1 : 0,
        n: Number(session.n) || 0
      };
    }
  }
  if (Array.isArray(raw.event_ids)) {
    day.event_ids = raw.event_ids.filter((item) => /^[0-9a-f]{24}$/.test(item)).slice(0, LIMITS.eventIdsPerDay);
  }
  if (isPlainObject(raw.capi)) {
    for (const field of ['attempted', 'sent', 'events_received_0', 'failed', 'not_configured', 'retries']) {
      day.capi[field] = Number(raw.capi[field]) || 0;
    }
    if (isPlainObject(raw.capi.error_codes)) {
      for (const [code, count] of Object.entries(raw.capi.error_codes).slice(0, LIMITS.errorCodesPerDay + 1)) {
        day.capi.error_codes[String(code).slice(0, 60)] = Number(count) || 0;
      }
    }
  }
  return day;
}

function safeErrorCode(value) {
  const code = String(value || '').slice(0, 60);
  return /^[a-z0-9_:.-]+$/i.test(code) ? code : 'unknown';
}

// Um único processo escritor por pasta (1 réplica no Railway). Todas as mudanças
// passam por uma fila serial: cada lote é aplicado a um rascunho, gravado de forma
// atômica e só então vira o estado em memória. Se a gravação falha, nada muda em
// memória (contadores e dedupe), o chamador recebe 'unavailable' e o reenvio do
// mesmo event_id é aceito na próxima tentativa.
export class MetricsStore {
  #queue = [];
  #draining = null;
  #timer = null;
  #closed = false;

  constructor({
    dataDir,
    now = () => new Date(),
    logger = console,
    fs = nodeFs,
    cleanupIntervalMs = CLEANUP_INTERVAL_MS
  } = {}) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, METRICS_FILE_NAME);
    this.now = now;
    this.logger = logger;
    this.fs = fs;
    this.available = false;
    this.data = { version: 1, days: {} };
    this.eventIndex = new Set();
    this.ready = this.#init();
    if (cleanupIntervalMs > 0) {
      this.#timer = setInterval(() => {
        void this.cleanup().catch(() => {});
      }, cleanupIntervalMs);
      this.#timer.unref?.();
    }
  }

  async #init() {
    try {
      await this.fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await this.#removeStrayFiles();
      let raw = null;
      try {
        raw = await this.fs.readFile(this.filePath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw);
          if (isPlainObject(parsed?.days)) {
            for (const [dayKey, day] of Object.entries(parsed.days)) {
              if (DAY_KEY_RE.test(dayKey)) this.data.days[dayKey] = normalizeDay(day);
            }
          }
        } catch {
          // Arquivo corrompido: não guardamos cópia do conteúdo; a medição recomeça
          // e a gravação abaixo substitui o arquivo.
          this.#log('error', { type: 'metrics_storage', status: 'corrupt_file_reset' });
        }
      }
      this.#prune(this.data.days);
      this.#rebuildIndex();
      // Garante que o diretório é gravável antes de aceitar eventos.
      await this.#writeNow(this.data);
      this.available = true;
    } catch (error) {
      this.available = false;
      this.#log('error', { type: 'metrics_storage', status: 'unavailable', code: safeErrorCode(error?.code) });
    }
    return this.available;
  }

  #log(level, payload) {
    const method = typeof this.logger?.[level] === 'function' ? this.logger[level].bind(this.logger) : null;
    if (method) method(JSON.stringify(payload));
  }

  async #removeStrayFiles() {
    let names = [];
    try {
      names = await this.fs.readdir(this.dataDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (STRAY_FILE_RE.test(name)) await this.fs.unlink(path.join(this.dataDir, name)).catch(() => {});
    }
  }

  // Remove dias fora da janela; retorna true se algo foi apagado.
  #prune(days) {
    const cutoff = retentionCutoff(this.now());
    let removed = false;
    for (const dayKey of Object.keys(days)) {
      if (dayKey < cutoff) {
        delete days[dayKey];
        removed = true;
      }
    }
    return removed;
  }

  #rebuildIndex() {
    this.eventIndex = new Set();
    for (const day of Object.values(this.data.days)) {
      for (const hash of day.event_ids) this.eventIndex.add(hash);
    }
  }

  // Enfileira uma mutação. `apply(tx)` roda sobre o rascunho; o resultado só é
  // entregue depois que o arquivo foi gravado. Em falha de escrita, resolve 'unavailable'.
  #mutate(apply, { sweep = false } = {}) {
    return new Promise((resolve) => {
      this.#queue.push({ apply, resolve, sweep });
      this.#drain();
    });
  }

  #drain() {
    if (this.#draining) return;
    this.#draining = (async () => {
      try {
        while (this.#queue.length) {
          const batch = this.#queue.splice(0);
          try {
            await this.#commit(batch);
          } catch (error) {
            this.#log('error', { type: 'metrics_storage', status: 'commit_failed', code: safeErrorCode(error?.code) });
            for (const item of batch) item.resolve(UNAVAILABLE);
          }
        }
      } finally {
        this.#draining = null;
      }
    })();
  }

  async #commit(batch) {
    // Dentro da fila não há gravação em andamento: é seguro apagar .tmp órfãos.
    if (batch.some((item) => item.sweep)) await this.#removeStrayFiles();
    const todayKey = saoPauloDay(this.now());
    // Cópia rasa dos dias; apenas o dia atual é mutável e por isso é clonado.
    const days = { ...this.data.days };
    const pruned = this.#prune(days);
    let today = null;
    const tx = {
      added: new Set(),
      changed: pruned,
      today: () => {
        if (!today) today = days[todayKey] ? structuredClone(days[todayKey]) : emptyDay();
        days[todayKey] = today;
        tx.changed = true;
        return today;
      },
      seen: (hash) => this.eventIndex.has(hash) || tx.added.has(hash)
    };
    const results = batch.map((item) => item.apply(tx));
    if (!tx.changed) {
      batch.forEach((item, index) => item.resolve(results[index]));
      return;
    }
    const draft = { version: 1, days };
    try {
      await this.#writeNow(draft);
    } catch (error) {
      this.#log('error', { type: 'metrics_storage', status: 'write_failed', code: safeErrorCode(error?.code) });
      for (const item of batch) item.resolve(UNAVAILABLE);
      return;
    }
    this.data = draft;
    if (pruned) this.#rebuildIndex();
    else for (const hash of tx.added) this.eventIndex.add(hash);
    batch.forEach((item, index) => item.resolve(results[index]));
  }

  // Retorna 'recorded', 'duplicate', 'limited' ou 'unavailable'.
  async record(event) {
    await this.ready;
    if (!this.available || this.#closed) return UNAVAILABLE;
    return this.#mutate((tx) => {
      const day = tx.today();

      if (tx.seen(event.eventHash)) {
        day.dropped.duplicate += 1;
        return 'duplicate';
      }

      let session = day.sessions[event.sessionHash];
      const sessionCount = Object.keys(day.sessions).length;
      if (
        day.event_ids.length >= LIMITS.eventIdsPerDay ||
        (!session && sessionCount >= LIMITS.sessionsPerDay) ||
        (session && session.n >= LIMITS.eventsPerSessionPerDay)
      ) {
        day.dropped.limit += 1;
        return 'limited';
      }

      if (!session) {
        let attribution = event.attribution;
        if (!day.attribution[attribution] && Object.keys(day.attribution).length >= LIMITS.attributionKeysPerDay) {
          attribution = 'overflow';
        }
        session = { a: attribution, v: 0, c: 0, n: 0 };
        day.sessions[event.sessionHash] = session;
      }

      // A sessão mantém a atribuição da primeira interação do dia.
      const counts = (day.attribution[session.a] ||= { landing_visit: 0, schedule_click: 0 });
      session.n += 1;
      day.event_ids.push(event.eventHash);
      tx.added.add(event.eventHash);
      day.totals[event.type] += 1;
      counts[event.type] += 1;
      if (event.type === 'landing_visit') session.v = 1;
      if (event.type === 'schedule_click') {
        session.c = 1;
        day.cta[event.cta] = (day.cta[event.cta] || 0) + 1;
      }
      return 'recorded';
    });
  }

  // Agregados da Conversions API: sem event_id, IP, user agent ou token.
  async recordCapi({ status, attempts = 0, errorCode = null }) {
    await this.ready;
    if (!this.available || this.#closed || !CAPI_STATUSES.has(status)) return;
    await this.#mutate((tx) => {
      const capi = tx.today().capi;
      capi.attempted += status === 'not_configured' ? 0 : 1;
      capi[status] += 1;
      capi.retries += Math.max(0, Number(attempts || 0) - 1);
      if (errorCode) {
        let code = safeErrorCode(errorCode);
        if (!(code in capi.error_codes) && Object.keys(capi.error_codes).length >= LIMITS.errorCodesPerDay) code = 'overflow';
        capi.error_codes[code] = (capi.error_codes[code] || 0) + 1;
      }
    });
  }

  // Apaga dias expirados e sobras de arquivos mesmo sem tráfego (timer ou chamada direta).
  async cleanup() {
    await this.ready;
    if (!this.available) return false;
    // tx.changed já reflete se o #commit removeu dias expirados.
    const result = await this.#mutate((tx) => tx.changed, { sweep: true });
    return result === true;
  }

  async #writeNow(data) {
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let created = false;
    try {
      const handle = await this.fs.open(tempPath, 'wx', 0o600);
      created = true;
      try {
        await handle.writeFile(JSON.stringify(data));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.fs.rename(tempPath, this.filePath);
    } catch (error) {
      if (created) await this.fs.unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  async flush() {
    await this.ready;
    while (this.#draining) await this.#draining;
  }

  // Para o timer de limpeza e espera gravações pendentes (testes e SIGTERM).
  async close() {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.flush();
  }
}

// Resumo diário sem identificadores (usado pelo script CLI interno). Sempre filtra
// pela janela relativa a `now`, mesmo que o arquivo ainda tenha dias expirados.
export function summarize(data, { days = RETENTION_DAYS, now = new Date() } = {}) {
  const span = Math.max(1, Math.min(RETENTION_DAYS, Number(days) || RETENTION_DAYS));
  const cutoff = retentionCutoff(now, span);
  const dayKeys = Object.keys(isPlainObject(data?.days) ? data.days : {})
    .filter((dayKey) => DAY_KEY_RE.test(dayKey) && dayKey >= cutoff)
    .sort();
  return dayKeys.map((dayKey) => {
    const day = normalizeDay(data.days[dayKey]);
    const sessions = Object.values(day.sessions);
    const visitSessions = sessions.filter((item) => item.v).length;
    const clickSessions = sessions.filter((item) => item.c).length;
    // Denominador = sessões com visita registrada; clique sem visita comprovada não entra.
    const visitThenClick = sessions.filter((item) => item.v && item.c).length;
    const byAttribution = Object.entries(day.attribution).map(([key, counts]) => {
      const attrSessions = sessions.filter((item) => item.a === key);
      return {
        ...(key === 'overflow' ? { overflow: true } : parseAttributionKey(key)),
        visit_sessions: attrSessions.filter((item) => item.v).length,
        click_sessions: attrSessions.filter((item) => item.c).length,
        visit_then_click_sessions: attrSessions.filter((item) => item.v && item.c).length,
        landing_visit_events: counts.landing_visit,
        schedule_click_events: counts.schedule_click
      };
    });
    return {
      day: dayKey,
      visit_sessions: visitSessions,
      click_sessions: clickSessions,
      visit_then_click_sessions: visitThenClick,
      click_without_visit_sessions: clickSessions - visitThenClick,
      visit_to_click_rate: visitSessions ? Number((visitThenClick / visitSessions).toFixed(4)) : null,
      landing_visit_events: day.totals.landing_visit,
      schedule_click_events: day.totals.schedule_click,
      clicks_by_cta: day.cta,
      dropped: day.dropped,
      by_attribution: byAttribution,
      capi: day.capi
    };
  });
}
