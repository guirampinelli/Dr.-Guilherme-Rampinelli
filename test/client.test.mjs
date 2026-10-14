// Executa analytics.js e script.js em um sandbox vm com DOM mínimo simulado.
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANALYTICS = readFileSync(path.join(SITE_ROOT, 'analytics.js'), 'utf8');
const SCRIPT = readFileSync(path.join(SITE_ROOT, 'script.js'), 'utf8');
const CONSENT_KEY = 'drg_campaign_measurement_consent_v1';
const ATTRIBUTION_KEY = 'drguilherme_attribution_v3';
const SESSION_KEY = 'drg_measurement_session_v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DOCTORALIA = 'https://www.doctoralia.com.br/guilherme-rampinelli/medico-clinico-geral/sao-paulo?utm_source=site';

function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

// Relógio controlável dentro do sandbox (Date e Date.now leem __clock.now).
const FAKE_DATE = `(function (global) {
  var RealDate = global.Date;
  function FakeDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!args.length) args = [global.__clock.now];
    return new (Function.prototype.bind.apply(RealDate, [null].concat(args)))();
  }
  FakeDate.now = function () { return global.__clock.now; };
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.prototype = RealDate.prototype;
  global.Date = FakeDate;
})(this);`;

function browser({
  consent,
  gpc = false,
  metricsPage = 'consulta_online',
  search = '',
  localData = {},
  sharedLocal,
  clock
} = {}) {
  // `sharedLocal` simula outra aba do mesmo site (localStorage compartilhado,
  // sessionStorage próprio da aba).
  const local = sharedLocal || storage({ ...(consent ? { [CONSENT_KEY]: consent } : {}), ...localData });
  const session = storage();
  const fetches = [];
  const listeners = {};
  const windowListeners = {};
  let banner = null;

  function createBanner() {
    const handlers = {};
    const button = (name) => ({ addEventListener: (type, fn) => (handlers[name] = fn) });
    const buttons = { '[data-cookie-accept]': button('accept'), '[data-cookie-reject]': button('reject') };
    return {
      dataset: {},
      innerHTML: '',
      handlers,
      setAttribute() {},
      querySelector: (selector) => buttons[selector] || null,
      remove() {
        banner = null;
      }
    };
  }

  const document = {
    body: {
      dataset: { pageType: 'medical_service', pageVariant: 'test', ...(metricsPage ? { metricsPage } : {}) },
      appendChild(element) {
        banner = element;
      }
    },
    documentElement: { classList: { add() {}, toggle() {} } },
    addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
    dispatchEvent: (event) => (listeners[event.type] || []).forEach((fn) => fn(event)),
    querySelector: (selector) => (selector === '[data-cookie-consent]' ? banner : null),
    querySelectorAll: () => [],
    createElement: () => createBanner()
  };

  const context = {
    document,
    navigator: { globalPrivacyControl: gpc },
    localStorage: local,
    sessionStorage: session,
    crypto: webcrypto,
    location: { protocol: 'https:', pathname: '/consulta-medica-online/', search },
    URLSearchParams,
    CustomEvent: class CustomEvent {
      constructor(type) {
        this.type = type;
      }
    },
    fetch(url, init) {
      fetches.push({ url, body: JSON.parse(init.body), init });
      return Promise.resolve({ ok: true, status: 204 });
    },
    addEventListener: (type, fn) => (windowListeners[type] ||= []).push(fn),
    __clock: clock
  };
  context.window = context;
  vm.createContext(context);
  if (clock) vm.runInContext(FAKE_DATE, context);
  vm.runInContext(ANALYTICS, context);
  vm.runInContext(SCRIPT, context);

  return {
    local,
    session,
    fetches,
    get banner() {
      return banner;
    },
    get consentState() {
      return context.__drMeasurementConsent;
    },
    // Evento disparado pelo navegador quando OUTRA aba altera o localStorage.
    storageEvent: (key = CONSENT_KEY) => (windowListeners.storage || []).forEach((fn) => fn({ key })),
    accept: () => banner.handlers.accept(),
    reject: () => banner.handlers.reject(),
    click(ctaLocation, extra = {}) {
      const link = { href: DOCTORALIA, dataset: { doctoraliaLink: 'true', ctaLocation, ...extra } };
      const target = { closest: (selector) => (selector.includes('data-doctoralia-link') ? link : null) };
      document.dispatchEvent({ type: 'click', target, preventDefault() {} });
    },
    openSettings() {
      const target = { closest: (selector) => (selector === '[data-privacy-settings]' ? {} : null) };
      document.dispatchEvent({ type: 'click', target, preventDefault() {} });
    },
    paths: () => fetches.map((item) => item.url)
  };
}

test('sem escolha: mostra aviso e não envia nada nem cria sessão', () => {
  const page = browser();
  assert.ok(page.banner, 'aviso de consentimento visível');
  page.click('service_hero');
  assert.equal(page.fetches.length, 0);
  assert.equal(page.session.map.size, 0);
});

test('aviso oferece Aceitar e Recusar com o mesmo estilo', () => {
  const html = ANALYTICS.match(/cookie-consent-actions[\s\S]*?"<\/div>"/)[0];
  const classes = [...html.matchAll(/class="([^"]+)" data-cookie-(accept|reject)/g)].map((match) => match[1]);
  assert.equal(classes.length, 2);
  assert.equal(classes[0], classes[1]);
});

test('aceitar: registra visita uma vez com UUID só no sessionStorage', () => {
  const page = browser();
  page.accept();
  assert.equal(page.local.getItem(CONSENT_KEY), 'accepted');
  assert.deepEqual(page.paths(), ['/api/public/site-metrics/visit']);
  const [visit] = page.fetches;
  assert.match(visit.body.session_id, UUID_RE);
  assert.equal(page.session.getItem(SESSION_KEY), visit.body.session_id);
  assert.ok(![...page.local.map.values()].some((value) => value.includes(visit.body.session_id)));
  assert.deepEqual(Object.keys(visit.body).sort(), ['attribution', 'event_id', 'page', 'session_id', 'type']);
  assert.equal(visit.init.credentials, 'same-origin');

  page.click('service_hero');
  assert.deepEqual(page.paths().slice(1), ['/api/public/site-events/contact', '/api/public/site-metrics/schedule-click']);
  const scheduleClick = page.fetches[2].body;
  assert.equal(scheduleClick.session_id, visit.body.session_id);
  assert.equal(scheduleClick.cta, 'service_hero');
  assert.notEqual(scheduleClick.event_id, page.fetches[1].body.event_id);
});

test('consentimento salvo: visita na carga e sessão reaproveitada', () => {
  const page = browser({ consent: 'accepted' });
  assert.equal(page.banner, null);
  assert.deepEqual(page.paths(), ['/api/public/site-metrics/visit']);
});

test('recusar: nada é enviado e nada é persistido', () => {
  const page = browser({ search: '?utm_source=meta&fbclid=IwAR123abc' });
  page.reject();
  page.click('service_hero');
  assert.equal(page.fetches.length, 0);
  assert.equal(page.local.getItem(CONSENT_KEY), 'rejected');
  assert.equal(page.local.getItem(ATTRIBUTION_KEY), null);
  assert.equal(page.session.map.size, 0);
});

test('recusar depois de aceitar apaga sessão e atribuição', () => {
  const page = browser({ search: '?utm_source=meta' });
  page.accept();
  assert.ok(page.session.getItem(SESSION_KEY));
  assert.ok(page.local.getItem(ATTRIBUTION_KEY));
  page.openSettings();
  assert.ok(page.banner, 'aviso reaberto por "Gerenciar cookies"');
  page.reject();
  assert.equal(page.session.getItem(SESSION_KEY), null);
  assert.equal(page.local.getItem(ATTRIBUTION_KEY), null);
  page.fetches.length = 0;
  page.click('service_hero');
  assert.equal(page.fetches.length, 0);
});

test('Global Privacy Control equivale a recusa', () => {
  const page = browser({ gpc: true });
  assert.equal(page.banner, null);
  page.click('service_hero');
  assert.equal(page.fetches.length, 0);
  assert.equal(page.local.getItem(CONSENT_KEY), 'rejected');
});

test('link "Ver perfil" (data-cta-kind="profile") não envia Contact nem conta como agendamento', () => {
  const page = browser({ consent: 'accepted' });
  page.click('reviews', { ctaKind: 'profile' });
  page.click('service_final', { ctaKind: 'profile' });
  assert.deepEqual(page.paths(), ['/api/public/site-metrics/visit']);
  // CTAs de agendamento sem ctaKind continuam enviando o Contact existente.
  page.click('profile_body');
  assert.deepEqual(page.paths(), ['/api/public/site-metrics/visit', '/api/public/site-events/contact']);
});

test('aceitar → recusar → aceitar: nova sessão recebe nova visita antes do clique', () => {
  const page = browser();
  page.accept();
  const firstSession = page.fetches[0].body.session_id;
  page.openSettings();
  page.reject();
  assert.equal(page.session.getItem(SESSION_KEY), null);
  page.openSettings();
  page.accept();
  page.click('service_hero');
  assert.deepEqual(page.paths(), [
    '/api/public/site-metrics/visit',
    '/api/public/site-metrics/visit',
    '/api/public/site-events/contact',
    '/api/public/site-metrics/schedule-click'
  ]);
  const secondSession = page.fetches[1].body.session_id;
  assert.match(secondSession, UUID_RE);
  assert.notEqual(secondSession, firstSession);
  assert.equal(page.fetches[3].body.session_id, secondSession);
});

test('consentimento sincroniza entre abas via evento storage', () => {
  const shared = storage();
  const tabA = browser({ sharedLocal: shared, search: '?utm_source=meta' });
  const tabB = browser({ sharedLocal: shared });
  assert.ok(tabB.banner);

  tabA.accept();
  tabB.storageEvent();
  assert.equal(tabB.consentState, 'granted');
  assert.equal(tabB.banner, null, 'aviso fechado na outra aba');
  assert.deepEqual(tabB.paths(), ['/api/public/site-metrics/visit']);
  const sessionB = tabB.session.getItem(SESSION_KEY);
  assert.match(sessionB, UUID_RE);

  tabA.openSettings();
  tabA.reject();
  tabB.storageEvent();
  assert.equal(tabB.consentState, 'denied');
  assert.equal(tabB.session.getItem(SESSION_KEY), null, 'sessão da outra aba apagada');
  assert.equal(shared.getItem(ATTRIBUTION_KEY), null);
  tabB.fetches.length = 0;
  tabB.click('service_hero');
  assert.equal(tabB.fetches.length, 0);

  // Evento de outra chave não altera o estado.
  tabA.openSettings();
  tabA.accept();
  tabB.storageEvent('outra_chave');
  assert.equal(tabB.consentState, 'denied');
  tabB.storageEvent();
  assert.equal(tabB.consentState, 'granted');
  assert.notEqual(tabB.fetches[0].body.session_id, sessionB, 'nova sessão após reconsentimento');
});

test('GPC prevalece sobre aceite anterior e desativa o Aceitar', () => {
  const page = browser({ consent: 'accepted', gpc: true, search: '?utm_source=meta', localData: { [ATTRIBUTION_KEY]: '{"first_touch":{}}' } });
  assert.equal(page.consentState, 'denied');
  assert.equal(page.local.getItem(CONSENT_KEY), 'rejected');
  assert.equal(page.local.getItem(ATTRIBUTION_KEY), null, 'atribuição anterior apagada');
  assert.equal(page.fetches.length, 0);

  page.openSettings();
  assert.match(page.banner.innerHTML, /data-cookie-gpc-notice/);
  assert.match(page.banner.innerHTML, /Global Privacy Control/);
  assert.match(page.banner.innerHTML, /data-cookie-accept disabled aria-disabled="true"/);
  page.accept();
  assert.equal(page.consentState, 'denied');
  assert.equal(page.local.getItem(CONSENT_KEY), 'rejected');
  page.click('service_hero');
  assert.equal(page.fetches.length, 0);
});

test('GPC em várias abas: aceite em outra aba não reativa a medição', () => {
  const shared = storage();
  const tabA = browser({ sharedLocal: shared });
  const tabB = browser({ sharedLocal: shared, gpc: true });
  shared.setItem(CONSENT_KEY, 'accepted');
  tabB.storageEvent();
  assert.equal(tabB.consentState, 'denied');
  tabB.click('service_hero');
  assert.equal(tabB.fetches.length, 0);
  assert.equal(tabB.session.map.size, 0);
  assert.ok(tabA);
});

test('sem GPC o aviso não mostra a nota e o Aceitar fica habilitado', () => {
  const page = browser();
  assert.doesNotMatch(page.banner.innerHTML, /data-cookie-gpc-notice|disabled/);
});

test('aba que atravessa a meia-noite de São Paulo envia a visita do novo dia antes do clique', () => {
  // 23:59 de 14/10 em São Paulo = 02:59 UTC de 15/10.
  const clock = { now: Date.parse('2026-10-15T02:59:00Z') };
  const page = browser({ consent: 'accepted', clock });
  page.click('service_hero');
  assert.deepEqual(page.paths(), [
    '/api/public/site-metrics/visit',
    '/api/public/site-events/contact',
    '/api/public/site-metrics/schedule-click'
  ]);

  clock.now = Date.parse('2026-10-15T03:01:00Z'); // 00:01 de 15/10 em São Paulo
  page.click('service_sticky');
  assert.deepEqual(page.paths().slice(3), [
    '/api/public/site-events/contact',
    '/api/public/site-metrics/visit',
    '/api/public/site-metrics/schedule-click'
  ]);
  const sessionId = page.fetches[0].body.session_id;
  assert.equal(page.fetches[4].body.session_id, sessionId);
  assert.equal(page.fetches[5].body.session_id, sessionId);
  assert.notEqual(page.fetches[4].body.event_id, page.fetches[0].body.event_id);

  // Mesmo dia: nenhum reenvio de visita.
  page.click('service_final');
  assert.deepEqual(page.paths().slice(6), ['/api/public/site-events/contact', '/api/public/site-metrics/schedule-click']);
});

test('fora da landing não há medição interna (artigos não são coletados)', () => {
  const page = browser({ consent: 'accepted', metricsPage: '' });
  page.click('glicemia_cta');
  assert.deepEqual(page.paths(), ['/api/public/site-events/contact']);
});

test('atribuição interna envia só códigos aprovados, nunca fbclid ou texto livre', () => {
  const page = browser({
    consent: 'accepted',
    search:
      '?utm_source=Meta&utm_medium=paid_social&utm_campaign=drg_ig_lpv_202610&utm_id=120212345678901234' +
      '&adset_id=11987654321&ad_id=120212345678909999&utm_content=Maria%20dor%20no%20peito&fbclid=IwAR123abc'
  });
  assert.deepEqual(page.fetches[0].body.attribution, {
    utm_source: 'meta',
    utm_medium: 'paid_social',
    utm_campaign: 'drg_ig_lpv_202610',
    campaign_id: '120212345678901234',
    ad_id: '120212345678909999'
  });

  const hostile = browser({ consent: 'accepted', search: '?utm_source=joao@example.com&utm_campaign=Consulta%20Maria' });
  assert.deepEqual(hostile.fetches[0].body.attribution, {});
});

test('parametrização da Meta: utm_id/utm_term/utm_content viram IDs de campanha/conjunto/anúncio', () => {
  const page = browser({
    consent: 'accepted',
    search:
      '?utm_source=instagram&utm_medium=paid_social&utm_campaign=drg_contact_sp_rj_202608' +
      '&utm_id=120211111111111111&utm_term=120222222222222222&utm_content=120233333333333333'
  });
  assert.deepEqual(page.fetches[0].body.attribution, {
    utm_source: 'instagram',
    utm_medium: 'paid_social',
    utm_campaign: 'drg_contact_sp_rj_202608',
    campaign_id: '120211111111111111',
    adset_id: '120222222222222222',
    ad_id: '120233333333333333'
  });
});

test('allowlist de campanhas fechada também no navegador', () => {
  for (const campaign of ['drg_maria_silva', 'drg_diabetes', 'drg_teleconsulta_sp_rj_2026_09']) {
    const page = browser({ consent: 'accepted', search: `?utm_source=meta&utm_campaign=${campaign}` });
    assert.deepEqual(page.fetches[0].body.attribution, { utm_source: 'meta' }, campaign);
  }
  const ok = browser({ consent: 'accepted', search: '?utm_campaign=drg_teleconsulta_sp_rj_2026_08' });
  assert.deepEqual(ok.fetches[0].body.attribution, { utm_campaign: 'drg_teleconsulta_sp_rj_2026_08' });
});

test('payload Contact existente permanece igual', () => {
  const page = browser({ consent: 'accepted', search: '?utm_source=meta&fbclid=IwAR123abc' });
  page.click('service_hero');
  const contact = page.fetches.find((item) => item.url === '/api/public/site-events/contact').body;
  assert.deepEqual(Object.keys(contact).sort(), [
    'attribution',
    'cta_location',
    'destination_url',
    'event_id',
    'event_time',
    'event_type',
    'page_path',
    'page_type',
    'page_variant'
  ]);
  assert.equal(contact.event_type, 'doctoralia_schedule_click');
  assert.equal(contact.attribution.last_touch.fbclid, 'IwAR123abc');
});
