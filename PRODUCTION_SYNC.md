# Site e campanha — 14/10/2026

O Railway em produção executava Node com Conversions API, enquanto a fonte Git ainda
usava Nginx/GA4. O deploy desta alteração partiu de uma cópia dos arquivos reais de
produção. O código desta proposta inclui as mesmas correções e preserva o artigo de
semaglutida e seus links que já estavam no Git.

Antes de mesclar esta proposta, revisar a publicação desse conteúdo adicional e conferir
que o Railway permanece com uma réplica, volume /data, TRACKING_DATA_DIR=/data/metrics,
RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0 e RAILWAY_DEPLOYMENT_DRAINING_SECONDS=10.
Não incluir META_CAPI_TEST_EVENT_CODE nas variáveis de produção.

A campanha nova está desativada e usa Instagram Feed/Stories, 18+, SP/RJ, R$20/dia,
14–28/10/2026. Otimiza visualizações da página de destino; a medição privada acompanha
visita consentida → clique Agendar. Clique não comprova consulta agendada. A API de
Contact foi aceita em teste isolado; elegibilidade para otimização em produção não foi
comprovada. Não ativar anúncio ou mudar o objetivo automaticamente ao mesclar código.
