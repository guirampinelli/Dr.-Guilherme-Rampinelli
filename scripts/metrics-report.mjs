#!/usr/bin/env node
// Resumo diário (dia de São Paulo) da medição interna e da Conversions API.
// Uso interno: node scripts/metrics-report.mjs [--days 7] [--json]
// Somente leitura; não imprime identificadores de sessão ou de evento.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { METRICS_FILE_NAME, summarize } from '../lib/metrics.mjs';

const args = process.argv.slice(2);
const daysIndex = args.indexOf('--days');
const days = daysIndex >= 0 ? Math.max(1, Math.min(30, Number.parseInt(args[daysIndex + 1], 10) || 7)) : 7;
const asJson = args.includes('--json');
const dataDir = path.resolve(process.env.TRACKING_DATA_DIR || '/data/metrics');

let data;
try {
  data = JSON.parse(await readFile(path.join(dataDir, METRICS_FILE_NAME), 'utf8'));
} catch (error) {
  console.error(`Não foi possível ler ${METRICS_FILE_NAME} em ${dataDir}: ${error.code || 'JSON inválido'}`);
  process.exit(1);
}

// Filtra pela janela relativa a agora (dia de São Paulo): dias expirados que ainda
// estejam no arquivo nunca aparecem no relatório.
const report = summarize(data, { days, now: new Date() });
if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

function percent(rate) {
  return rate === null ? '-' : `${(rate * 100).toFixed(1)}%`;
}

console.log('Medição interna (consentida) — /consulta-medica-online/');
console.table(
  report.map((day) => ({
    dia: day.day,
    sessoes_visita: day.visit_sessions,
    sessoes_clique: day.click_sessions,
    visita_e_clique: day.visit_then_click_sessions,
    clique_sem_visita: day.click_without_visit_sessions,
    // taxa = sessões com visita E clique ÷ sessões com visita (clique sem visita fica fora).
    taxa: percent(day.visit_to_click_rate),
    eventos_visita: day.landing_visit_events,
    cliques_agendar: day.schedule_click_events,
    duplicados: day.dropped.duplicate,
    limite: day.dropped.limit
  }))
);

console.log('Cliques por CTA');
console.table(report.map((day) => ({ dia: day.day, ...day.clicks_by_cta })));

console.log('Por atribuição (códigos aprovados; "other" = valor fora da allowlist)');
console.table(
  report.flatMap((day) =>
    day.by_attribution.map((item) => ({
      dia: day.day,
      origem: item.overflow ? 'overflow' : item.source,
      meio: item.medium ?? '',
      campanha: item.campaign ?? '',
      campaign_id: item.campaign_id ?? '',
      adset_id: item.adset_id ?? '',
      ad_id: item.ad_id ?? '',
      sessoes_visita: item.visit_sessions,
      sessoes_clique: item.click_sessions,
      visita_e_clique: item.visit_then_click_sessions,
      cliques: item.schedule_click_events
    }))
  )
);

console.log('Conversions API (Contact) — agregados, sem segredos');
console.table(
  report.map((day) => ({
    dia: day.day,
    tentativas: day.capi.attempted,
    enviados: day.capi.sent,
    events_received_0: day.capi.events_received_0,
    falhas: day.capi.failed,
    nao_configurado: day.capi.not_configured,
    reenvios: day.capi.retries,
    erros: Object.entries(day.capi.error_codes).map(([code, count]) => `${code}=${count}`).join(' ')
  }))
);
console.log('Observação: 204 no navegador indica apenas recebimento local; "enviados" depende da resposta da Meta. Agendamentos confirmados na Doctoralia não são medidos.');
