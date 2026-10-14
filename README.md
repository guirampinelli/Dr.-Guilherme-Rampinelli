# Site Dr. Guilherme Rampinelli

Site estático servido por `server.mjs` (Node 22, sem dependências externas).

## Executar

```sh
npm start              # porta 8080 (PORT para alterar)
npm test               # node:test, sem rede e sem credenciais
npm run metrics:report # resumo diário da medição interna (uso interno)
```

## Variáveis de ambiente

| Variável | Uso |
|---|---|
| `PORT` | Porta HTTP (padrão 8080). |
| `TRACKING_DATA_DIR` | Pasta privada da medição interna (padrão `/data/metrics`). Precisa ficar **fora** da pasta do site; caso contrário a medição é desativada. Em Railway, montar um volume persistente em `/data`. |
| `META_CAPI_ENABLED`, `META_CAPI_DATASET_ID`, `META_CAPI_ACCESS_TOKEN`, `META_GRAPH_API_VERSION`, `META_CAPI_TEST_EVENT_CODE` | Envio do evento `Contact` pela Conversions API (inalterado). |
| `TRACKING_ALLOWED_ORIGINS` | Origens extras aceitas pelos endpoints de evento (separadas por vírgula). |

## O que é medido

Somente após consentimento ("Aceitar" no aviso de privacidade):

1. **Contact → Meta (já existente; payload inalterado).** Clique em link de agendamento
   envia `POST /api/public/site-events/contact`. Links "Ver perfil"
   (`data-cta-kind="profile"`) não enviam mais Contact, para a Meta otimizar só intenção
   de agendar. O servidor manda à Meta apenas
   `event_name=Contact`, `event_time`, `event_id`, `action_source`, `event_source_url`
   fixo da landing e `user_data` com IP, user agent e `fbc` (se houver `fbclid`).
2. **Medição interna (nova, nunca enviada à Meta).** Somente na landing
   `/consulta-medica-online/`:
   - `POST /api/public/site-metrics/visit` — visita da sessão;
   - `POST /api/public/site-metrics/schedule-click` — clique em CTA de agendamento
     (`service_header`, `service_hero`, `service_final`, `service_sticky`). Links de perfil
     (`data-cta-kind="profile"`) não contam como agendamento.

   A sessão é um UUID aleatório guardado só em `sessionStorage` e criado apenas após o
   consentimento. A visita é ligada a sessão + dia de São Paulo: cada clique consentido
   garante antes uma visita da mesma sessão no dia (inclusive se a aba atravessar a
   meia-noite ou após aceitar → recusar → aceitar). O servidor guarda hashes truncados de
   sessão/evento (deduplicação, até 30 dias), contagens por dia de São Paulo, CTA e
   atribuição em códigos de allowlist **fechada**:
   `utm_source` ∈ {meta, facebook, instagram}, `utm_medium` = paid_social, `utm_campaign`
   ∈ {`drg_ig_lpv_202610`, `drg_contact_sp_rj_202608`, `drg_teleconsulta_sp_rj_2026_08`}
   (qualquer outra campanha, mesmo com prefixo `drg_`, vira `other`; o navegador nem envia)
   e a tripla de IDs verificada do anúncio novo; combinações desconhecidas viram `other`. No navegador, os parâmetros de IDs numéricos da Meta (15–20 dígitos) são mapeados: campanha = `campaign_id`/`utm_id`
   (`{{campaign.id}}`), conjunto = `adset_id`/`utm_term` (`{{adset.id}}`), anúncio =
   `ad_id`/`utm_content` (`{{ad.id}}`). Não guarda IP, user agent, fbclid, URL, páginas de
   artigos nem texto livre.

   Taxa: `visit_to_click_rate` = sessões com visita **e** clique ÷ sessões com visita
   (`visit_then_click_sessions`). Cliques sem visita registrada aparecem à parte
   (`click_without_visit_sessions`) e nunca entram no denominador.

   Limites: retenção de 30 dias; dedupe de `event_id` em toda a retenção; 5.000 sessões,
   20.000 eventos e 256 combinações de atribuição por dia; 30 eventos por sessão/dia; rate
   limit por IP em memória (o IP não é persistido).

   Gravação: mudanças são serializadas e aplicadas a um rascunho; só depois da gravação
   atômica (`.tmp` + `fsync` + `rename`) entram no estado em memória. Se a gravação falhar,
   o endpoint responde `503`, nada é contado nem marcado como visto, o `.tmp` é removido e
   o reenvio do mesmo `event_id` é aceito. Uma limpeza periódica (1 h, timer `unref`)
   apaga dias expirados mesmo sem tráfego, além de `.tmp` órfãos; arquivo corrompido é
   descartado sem cópia. O relatório sempre filtra pela janela relativa a agora.

   Consentimento: GPC ativo prevalece sobre aceite anterior (o botão Aceitar fica
   desativado com aviso). Mudanças feitas em outra aba são aplicadas via evento
   `storage`; ao revogar, sessão e atribuição da aba são apagadas.

3. **Agregados da Conversions API** no mesmo arquivo: tentativas, enviados,
   `events_received_0`, falhas, não configurado, reenvios e códigos de erro
   (`http_<status>:<código>`, `network`, `timeout`). Sem token, IP ou event_id.
   Falhas transitórias (rede, timeout, 429, 5xx, `is_transient`) são reenviadas até 2 vezes
   com o mesmo corpo e o mesmo `event_id` (a Meta deduplica).

O `204` dos endpoints significa apenas "recebido pelo servidor". Não confirma entrega à
Meta nem agendamento na Doctoralia (que não é inferido).

## Relatório

```sh
TRACKING_DATA_DIR=/data/metrics node scripts/metrics-report.mjs --days 7
TRACKING_DATA_DIR=/data/metrics node scripts/metrics-report.mjs --days 30 --json
```

Não existe endpoint público de consulta. O servidor só entrega arquivos de uma allowlist
explícita (páginas, CSS/JS públicos, `robots.txt`, `sitemap.xml` e imagens em `assets/`);
`server.mjs`, `lib/`, `scripts/`, `test/`, `package.json`, README e Dockerfile retornam 404.

## Docker

`Dockerfile` usa `node:22-alpine` e copia só os arquivos necessários. O Railway monta o
volume em `/data` como root, então o `CMD` (sem arquivo de entrypoint separado) roda em
runtime como root: cria apenas `TRACKING_DATA_DIR` (`/data/metrics`), faz
`chown 1000:1000` e `chmod 0700` só nessa pasta (nunca no volume inteiro) e troca para o
usuário `node` com o `su` do BusyBox, terminando em `exec node /app/server.mjs`. Não usa
`RAILWAY_RUN_UID=0`. O log de startup mostra `metrics_storage_available`.

**Topologia obrigatória:** 1 réplica, 1 processo escritor por volume. O volume do Railway
não suporta réplicas; o arquivo `metrics.json` não tem trava entre processos. No
redeploy, o `SIGTERM` conclui a gravação pendente antes de sair.

## Sincronização de fonte

Esta proposta preserva o artigo de semaglutida e seus links já presentes no repositório.
O deploy de 14/10/2026 usa a cópia verificada do site que estava em produção, sem publicar esse artigo adicional.
A proposta reconcilia o runtime Node/Conversions API e a medição com a fonte Git; não foi mesclada.
