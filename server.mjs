import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MetricsStore, validateMetricEvent } from './lib/metrics.mjs';

const PUBLIC_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8080;
const DEFAULT_GRAPH_API_VERSION = 'v23.0';
const DEFAULT_EVENT_SOURCE_URL = 'https://drrampinelli.com.br/consulta-medica-online/';
const DEFAULT_TRACKING_DATA_DIR = '/data/metrics';
const DOCTORALIA_HOSTS = new Set(['doctoralia.com.br', 'www.doctoralia.com.br']);
const DOCTORALIA_PROFILE_PATH = '/guilherme-rampinelli/medico-clinico-geral/sao-paulo';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_METRIC_BODY_BYTES = 2 * 1024;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENT_FUTURE_MS = 5 * 60 * 1000;
const META_TIMEOUT_MS = 10_000;
const META_RETRY_DELAYS_MS = [1_000, 4_000];
// Códigos de erro temporário documentados pela Graph API.
const META_TRANSIENT_CODES = new Set(['1', '2', '4', '17', '341']);
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_MAX_KEYS = 10_000;
const METRIC_ENDPOINTS = new Map([
  ['/api/public/site-metrics/visit', 'landing_visit'],
  ['/api/public/site-metrics/schedule-click', 'schedule_click']
]);
// Somente estes arquivos e diretórios são públicos. server.mjs, lib/, scripts/,
// test/, package.json, README, Dockerfile e dados de medição nunca são servidos.
const PUBLIC_ROOT_FILES = new Set([
  'index.html',
  'styles.css',
  'conteudos.css',
  'script.js',
  'analytics.js',
  'robots.txt',
  'sitemap.xml'
]);
const PUBLIC_PAGE_DIR_RE = /^(?:consulta-medica-online|sobre|privacidade|conteudos|conteudos\/[a-z0-9-]{1,80})$/;
const PUBLIC_ASSET_RE = /^assets\/[A-Za-z0-9][A-Za-z0-9_-]{0,120}\.(?:svg|png|jpe?g|webp|ico)$/;
const AUTOMATED_USER_AGENT_RE = new RegExp(
  [
    'meta-externalads',
    'facebookexternalhit',
    'facebot',
    'twitterbot',
    'linkedinbot',
    'googlebot',
    'bingbot',
    'yandexbot',
    'baiduspider',
    'duckduckbot',
    'applebot',
    'slackbot',
    'telegrambot',
    'discordbot',
    'pinterestbot'
  ].join('|'),
  'i'
);

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.xml', 'application/xml; charset=utf-8']
]);

function text(value, maxLength = 1000) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function isDisabled(value) {
  return ['0', 'false', 'no', 'off'].includes(text(value, 20).toLowerCase());
}

function safeLog(logger, level, payload) {
  const method = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : logger.log.bind(logger);
  method(JSON.stringify(payload));
}

function requestIp(req) {
  const forwarded = text(req.headers['x-forwarded-for'], 500).split(',')[0].trim();
  const candidate = forwarded || text(req.socket.remoteAddress, 200);
  if (net.isIP(candidate)) return candidate;
  const ipv4Mapped = candidate.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  return ipv4Mapped && net.isIP(ipv4Mapped) ? ipv4Mapped : '';
}

function normalizePagePath(value) {
  const raw = text(value, 500).split(/[?#]/, 1)[0];
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw.replace(/\/{2,}/g, '/');
}

function validDoctoraliaDestination(value) {
  try {
    const url = new URL(text(value, 1800));
    return (
      url.protocol === 'https:' &&
      DOCTORALIA_HOSTS.has(url.hostname.toLowerCase()) &&
      url.pathname.replace(/\/+$/, '') === DOCTORALIA_PROFILE_PATH
    );
  } catch {
    return false;
  }
}

function validEventId(value) {
  return /^[A-Za-z0-9_-]{16,160}$/.test(text(value, 180));
}

function validCtaLocation(value) {
  return /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(text(value, 100));
}

function validFbclid(value) {
  const normalized = text(value, 500);
  return /^[A-Za-z0-9._-]{6,500}$/.test(normalized) ? normalized : '';
}

function attributionTouch(attribution = {}) {
  if (!attribution || typeof attribution !== 'object' || Array.isArray(attribution)) return null;

  for (const touch of [attribution.last_touch, attribution.first_touch]) {
    if (!touch || typeof touch !== 'object' || Array.isArray(touch)) continue;
    const fbclid = validFbclid(touch.fbclid);
    if (!fbclid) continue;
    const capturedAt = new Date(text(touch.captured_at, 80));
    return {
      fbclid,
      capturedAt: Number.isNaN(capturedAt.getTime()) ? null : capturedAt
    };
  }
  return null;
}

export function validateContactEvent(value, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (text(value.event_type, 80) !== 'doctoralia_schedule_click') return null;
  if (!validEventId(value.event_id)) return null;
  if (!validCtaLocation(value.cta_location)) return null;
  if (!validDoctoraliaDestination(value.destination_url)) return null;

  const eventTime = new Date(text(value.event_time, 80));
  if (Number.isNaN(eventTime.getTime())) return null;
  const ageMs = now.getTime() - eventTime.getTime();
  if (ageMs > MAX_EVENT_AGE_MS || ageMs < -MAX_EVENT_FUTURE_MS) return null;

  return {
    eventId: text(value.event_id, 160),
    eventTime,
    pagePath: normalizePagePath(value.page_path),
    ctaLocation: text(value.cta_location, 80),
    attribution: value.attribution && typeof value.attribution === 'object' ? value.attribution : {}
  };
}

export function buildMetaContactPayload(event, { clientIp = '', clientUserAgent = '' } = {}) {
  const userData = {};
  const touch = attributionTouch(event.attribution);

  if (touch) {
    const capturedAt = touch.capturedAt || event.eventTime;
    userData.fbc = `fb.1.${capturedAt.getTime()}.${touch.fbclid}`;
  }
  if (net.isIP(clientIp)) userData.client_ip_address = clientIp;
  if (text(clientUserAgent, 1000)) userData.client_user_agent = text(clientUserAgent, 1000);

  return {
    data: [
      {
        event_name: 'Contact',
        event_time: Math.floor(event.eventTime.getTime() / 1000),
        event_id: event.eventId,
        action_source: 'website',
        // Nunca enviamos à Meta o artigo de saúde que o visitante acessou.
        event_source_url: DEFAULT_EVENT_SOURCE_URL,
        user_data: userData
      }
    ]
  };
}

function capiConfig(env) {
  return {
    enabled: !isDisabled(env.META_CAPI_ENABLED),
    datasetId: text(env.META_CAPI_DATASET_ID ?? env.META_PIXEL_ID, 100),
    accessToken: text(env.META_CAPI_ACCESS_TOKEN, 2000),
    apiVersion: text(env.META_GRAPH_API_VERSION, 30) || DEFAULT_GRAPH_API_VERSION,
    testEventCode: text(env.META_CAPI_TEST_EVENT_CODE, 200)
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transientMetaFailure(error) {
  if (!error?.providerStatus) return true; // rede ou timeout
  if (error.providerStatus === 429 || error.providerStatus >= 500) return true;
  return error.providerTransient === true || META_TRANSIENT_CODES.has(String(error.providerCode || ''));
}

export function metaErrorCode(error) {
  if (!error?.providerStatus) {
    return ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network';
  }
  const code = text(error.providerCode, 20).replace(/[^A-Za-z0-9_-]/g, '');
  return `http_${Number(error.providerStatus) || 0}${code ? `:${code}` : ''}`;
}

export async function sendMetaContact(event, {
  env = process.env,
  fetchImpl = fetch,
  clientIp = '',
  clientUserAgent = '',
  retryDelaysMs = META_RETRY_DELAYS_MS,
  sleepImpl = sleep
} = {}) {
  const config = capiConfig(env);
  if (!config.enabled || !config.datasetId || !config.accessToken) {
    return { configured: false, sent: false, eventsReceived: 0, attempts: 0 };
  }

  const payload = buildMetaContactPayload(event, { clientIp, clientUserAgent });
  if (config.testEventCode) payload.test_event_code = config.testEventCode;
  // Cada nova tentativa reenvia exatamente o mesmo corpo, com o mesmo event_id;
  // a Meta deduplica Contact por event_id, então o reenvio é idempotente.
  const body = JSON.stringify(payload);

  const url = new URL(
    `https://graph.facebook.com/${encodeURIComponent(config.apiVersion)}/${encodeURIComponent(config.datasetId)}/events`
  );
  url.searchParams.set('access_token', config.accessToken);

  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(META_TIMEOUT_MS)
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error('Meta CAPI recusou o evento Contact.');
        error.providerStatus = response.status;
        error.providerCode = text(responseBody?.error?.code, 100) || null;
        error.providerTransient = responseBody?.error?.is_transient === true;
        throw error;
      }

      return {
        configured: true,
        sent: true,
        eventsReceived: Number(responseBody?.events_received || 0),
        attempts: attempt
      };
    } catch (error) {
      error.attempts = attempt;
      if (attempt > retryDelaysMs.length || !transientMetaFailure(error)) throw error;
      await sleepImpl(retryDelaysMs[attempt - 1]);
    }
  }
}

function allowedRequestOrigin(req, env) {
  const origin = text(req.headers.origin, 500);
  if (!origin) return false;
  const configuredOrigins = text(env.TRACKING_ALLOWED_ORIGINS, 2000)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = new Set([
    'https://drrampinelli.com.br',
    'https://www.drrampinelli.com.br',
    'https://guilherme-production.up.railway.app',
    ...configuredOrigins
  ]);
  if (env.NODE_ENV !== 'production') {
    allowed.add('http://127.0.0.1:8080');
    allowed.add('http://localhost:8080');
  }
  return allowed.has(origin);
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    let settled = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (settled) return;
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > maxBytes) {
        settled = true;
        reject(Object.assign(new Error('Payload muito grande.'), { statusCode: 413 }));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (settled) return;
      try {
        settled = true;
        resolve(JSON.parse(body || '{}'));
      } catch {
        settled = true;
        reject(Object.assign(new Error('JSON inválido.'), { statusCode: 400 }));
      }
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

function noContent(res) {
  res.statusCode = 204;
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function jsonResponse(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

export function publicRelativePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  const relative = decoded.replace(/^\/+/, '');
  if (relative.split('/').some((segment) => segment === '..' || segment.startsWith('.'))) return null;
  if (!relative) return { file: 'index.html' };
  if (PUBLIC_ROOT_FILES.has(relative) || PUBLIC_ASSET_RE.test(relative)) return { file: relative };

  const directory = relative.replace(/\/(?:index\.html)?$/, '');
  if (!PUBLIC_PAGE_DIR_RE.test(directory)) return null;
  // Sem a barra final os caminhos relativos das páginas (../styles.css) quebram.
  if (relative === directory) return { redirect: `/${directory}/` };
  return { file: `${directory}/index.html` };
}

async function staticFileFor(pathname) {
  const match = publicRelativePath(pathname);
  if (!match?.file) return match;

  const resolved = path.resolve(PUBLIC_ROOT, match.file);
  if (!resolved.startsWith(`${PUBLIC_ROOT}${path.sep}`)) return null;
  try {
    const fileStat = await stat(resolved);
    return fileStat.isFile() ? { file: resolved } : null;
  } catch {
    return null;
  }
}

async function serveStatic(req, res, requestUrl) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    jsonResponse(res, 405, { error: 'Método não permitido.' });
    return;
  }
  const match = await staticFileFor(requestUrl.pathname);
  if (match?.redirect) {
    res.statusCode = 301;
    res.setHeader('Location', `${match.redirect}${requestUrl.search}`);
    res.setHeader('Cache-Control', 'no-cache');
    res.end();
    return;
  }
  if (!match?.file) {
    jsonResponse(res, 404, { error: 'Página não encontrada.' });
    return;
  }

  const filePath = match.file;
  const extension = path.extname(filePath).toLowerCase();
  const content = await readFile(filePath);
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME_TYPES.get(extension) || 'application/octet-stream');
  if (['.jpg', '.jpeg', '.png', '.svg', '.webp'].includes(extension)) {
    res.setHeader('Cache-Control', 'public, max-age=2592000');
  } else {
    res.setHeader('Cache-Control', 'no-cache');
  }
  res.setHeader('Content-Length', content.length);
  res.end(req.method === 'HEAD' ? undefined : content);
}

export function trackingDataDir(env = process.env) {
  const dataDir = path.resolve(text(env.TRACKING_DATA_DIR, 500) || DEFAULT_TRACKING_DATA_DIR);
  // Os dados de medição nunca podem ficar dentro da pasta pública.
  if (dataDir === PUBLIC_ROOT || dataDir.startsWith(`${PUBLIC_ROOT}${path.sep}`)) return null;
  return dataDir;
}

function createRateLimiter(max = RATE_LIMIT_MAX) {
  const salt = crypto.randomBytes(32);
  const buckets = new Map();

  return function rateLimited(ip, now = Date.now()) {
    if (buckets.size > RATE_LIMIT_MAX_KEYS) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.startedAt >= RATE_LIMIT_WINDOW_MS) buckets.delete(key);
      }
    }
    const key = crypto.createHmac('sha256', salt).update(ip || 'unknown').digest('hex');
    const current = buckets.get(key);
    if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
      buckets.set(key, { startedAt: now, count: 1 });
      return false;
    }
    current.count += 1;
    return current.count > max;
  };
}

function sameOriginFetch(req) {
  const site = text(req.headers['sec-fetch-site'], 40);
  return !site || site === 'same-origin';
}

export function createAppServer({
  env = process.env,
  fetchImpl = fetch,
  logger = console,
  metricsStore,
  metaRetryDelaysMs = META_RETRY_DELAYS_MS,
  sleepImpl = sleep
} = {}) {
  const contactRateLimited = createRateLimiter();
  const metricsRateLimited = createRateLimiter();
  let store = metricsStore;
  let ownsStore = false;
  const backgroundTasks = new Set();
  if (store === undefined) {
    const dataDir = trackingDataDir(env);
    store = dataDir ? new MetricsStore({ dataDir, logger }) : null;
    ownsStore = Boolean(store);
    if (!dataDir) safeLog(logger, 'error', { type: 'metrics_storage', status: 'invalid_data_dir' });
  }

  function recordCapi(result) {
    if (!store) return Promise.resolve();
    return store.recordCapi(result).catch(() => {});
  }

  async function handleMetric(req, res, eventType) {
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { error: 'Método não permitido.' });
      return;
    }
    if (!allowedRequestOrigin(req, env) || !sameOriginFetch(req)) {
      jsonResponse(res, 403, { error: 'Origem não permitida.' });
      return;
    }
    if (!text(req.headers['content-type'], 100).toLowerCase().startsWith('application/json')) {
      jsonResponse(res, 415, { error: 'Tipo de conteúdo não suportado.' });
      return;
    }
    if (metricsRateLimited(requestIp(req))) {
      jsonResponse(res, 429, { error: 'Muitas solicitações.' });
      return;
    }

    const userAgent = text(req.headers['user-agent'], 1000);
    let body;
    try {
      body = await readJsonBody(req, MAX_METRIC_BODY_BYTES);
    } catch (error) {
      jsonResponse(res, Number(error?.statusCode || 400), { error: 'Solicitação inválida.' });
      return;
    }
    const event = validateMetricEvent(body, eventType);
    if (!event) {
      jsonResponse(res, 400, { error: 'Evento inválido.' });
      return;
    }
    // Robôs conhecidos recebem 204 sem registro; o user agent não é armazenado.
    if (!userAgent || AUTOMATED_USER_AGENT_RE.test(userAgent)) {
      noContent(res);
      return;
    }
    if (!store) {
      jsonResponse(res, 503, { error: 'Medição indisponível.' });
      return;
    }

    const outcome = await store.record(event);
    if (outcome === 'unavailable') {
      // Inclui falha de gravação após o início: nada foi contado nem marcado como
      // visto, então o mesmo event_id pode ser reenviado.
      jsonResponse(res, 503, { error: 'Medição indisponível.' });
      return;
    }
    // 204 indica apenas que o evento foi gravado pela medição local (inclusive
    // duplicado ou acima do limite). Não envolve a Meta.
    noContent(res);
  }

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    const requestUrl = new URL(req.url || '/', 'http://localhost');

    if (requestUrl.pathname === '/healthz') {
      jsonResponse(res, 200, { status: 'ok' });
      return;
    }

    const metricType = METRIC_ENDPOINTS.get(requestUrl.pathname);
    if (metricType) {
      try {
        await handleMetric(req, res, metricType);
      } catch {
        if (!res.headersSent) jsonResponse(res, 500, { error: 'Erro interno.' });
      }
      return;
    }

    if (requestUrl.pathname === '/api/public/site-events/contact') {
      if (req.method !== 'POST') {
        jsonResponse(res, 405, { error: 'Método não permitido.' });
        return;
      }
      if (!allowedRequestOrigin(req, env)) {
        jsonResponse(res, 403, { error: 'Origem não permitida.' });
        return;
      }

      const clientIp = requestIp(req);
      if (contactRateLimited(clientIp)) {
        jsonResponse(res, 429, { error: 'Muitas solicitações.' });
        return;
      }

      const userAgent = text(req.headers['user-agent'], 1000);
      if (!userAgent || AUTOMATED_USER_AGENT_RE.test(userAgent)) {
        noContent(res);
        return;
      }

      try {
        const body = await readJsonBody(req);
        const event = validateContactEvent(body);
        if (!event) {
          jsonResponse(res, 400, { error: 'Evento inválido.' });
          return;
        }

        // A navegação para a Doctoralia não espera a resposta da Meta. O 204
        // significa somente "recebido pelo servidor", não confirmação da Meta.
        noContent(res);
        const task = sendMetaContact(event, {
          env,
          fetchImpl,
          clientIp,
          clientUserAgent: userAgent,
          retryDelaysMs: metaRetryDelaysMs,
          sleepImpl
        })
          .then(async (result) => {
            const status = !result.sent ? 'not_configured' : result.eventsReceived > 0 ? 'sent' : 'events_received_0';
            await recordCapi({ status, attempts: result.attempts });
            safeLog(logger, 'info', {
              type: 'meta_contact',
              event_id: event.eventId,
              status: result.sent ? 'sent' : 'not_configured',
              events_received: result.eventsReceived,
              attempts: result.attempts,
              has_fbc: Boolean(attributionTouch(event.attribution))
            });
          })
          .catch(async (error) => {
            const errorCode = metaErrorCode(error);
            await recordCapi({ status: 'failed', attempts: error?.attempts, errorCode });
            safeLog(logger, 'error', {
              type: 'meta_contact',
              event_id: event.eventId,
              status: 'failed',
              error_code: errorCode,
              attempts: Number(error?.attempts || 0) || null,
              provider_status: Number(error?.providerStatus || 0) || null,
              provider_code: text(error?.providerCode, 100) || null
            });
          });
        backgroundTasks.add(task);
        void task.finally(() => backgroundTasks.delete(task));
      } catch (error) {
        if (!res.headersSent) {
          jsonResponse(res, Number(error?.statusCode || 400), { error: 'Solicitação inválida.' });
        }
      }
      return;
    }

    try {
      await serveStatic(req, res, requestUrl);
    } catch {
      if (!res.headersSent) jsonResponse(res, 500, { error: 'Erro interno.' });
      else res.end();
    }
  });
  // Store criado aqui é encerrado junto com o servidor (timer de limpeza e gravações).
  server.drainBackground = async () => {
    while (backgroundTasks.size) await Promise.allSettled([...backgroundTasks]);
  };
  if (ownsStore) server.on('close', () => {
    void server.drainBackground().then(() => store.close()).catch(() => {});
  });
  return server;
}

// Aguarda as requisições já aceitas e a API Meta antes de fechar o armazenamento.
export async function shutdownAppServer(server, store) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
  });
  await server.drainBackground();
  await store?.close();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10) || DEFAULT_PORT;
  const dataDir = trackingDataDir(process.env);
  const metricsStore = dataDir ? new MetricsStore({ dataDir }) : null;
  const server = createAppServer({ metricsStore });
  server.listen(port, '0.0.0.0', async () => {
    const config = capiConfig(process.env);
    console.log(JSON.stringify({
      type: 'startup',
      port,
      meta_capi_configured: Boolean(config.enabled && config.datasetId && config.accessToken),
      metrics_storage_available: metricsStore ? await metricsStore.ready : false
    }));
  });

  // Railway envia SIGTERM no redeploy: para de aceitar conexões, conclui a
  // gravação pendente da medição e encerra.
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    const forceExit = setTimeout(() => {
      console.error(JSON.stringify({ type: 'shutdown', signal, status: 'deadline' }));
      process.exit(1);
    }, 9_000);
    forceExit.unref();
    shutdownAppServer(server, metricsStore)
      .then(() => {
        clearTimeout(forceExit);
        console.log(JSON.stringify({ type: 'shutdown', signal, status: 'drained' }));
        process.exit(0);
      })
      .catch(() => {
        clearTimeout(forceExit);
        console.error(JSON.stringify({ type: 'shutdown', signal, status: 'failed' }));
        process.exit(1);
      });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

export const __test__ = {
  attributionTouch,
  capiConfig,
  normalizePagePath,
  transientMetaFailure,
  validDoctoraliaDestination,
  validFbclid
};
