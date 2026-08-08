# Landing page premium - Dr. Guilherme Rampinelli

Esta pasta contem uma landing page estatica pronta para publicacao.

O projeto inclui um `Dockerfile` para publicacao no Railway e a area de conteudos
educativos em rotas proprias.

## Arquivos

- `index.html`: estrutura, conteudo, SEO, schema e links da Doctoralia.
- `styles.css`: identidade visual, responsividade e layout.
- `script.js`: captura de UTMs, decoracao dos links da Doctoralia e eventos para GTM/dataLayer.
- `assets/`: monograma, logo horizontal com fundo, logo horizontal transparente e foto usada na pagina.
- `conteudos/`: pagina de publicacoes e artigos educativos.
- `conteudos.css`: estilos compartilhados da area de conteudos.

## Publicacao

Suba o conteudo desta pasta para a raiz do dominio, mantendo a pasta `assets` no mesmo nivel de `index.html`.

O GTM atual foi preservado: `GTM-P64PFJRP`.

## Pontos faceis de atualizar

- Link da Doctoralia: procure por `doctoralia.com.br/guilherme-rampinelli`.
- Valor da consulta: procure por `R$ 70`.
- Quantidade de opinioes: procure por `60 opiniões`.
- Variante de rastreamento: procure por `premium_identity_doctoralia_v1`.
- Conteudos publicados: abra `conteudos/index.html`. O primeiro artigo esta em
  `conteudos/colesterol-alto/index.html`.

## Observacao medica

A pagina evita promessas de resultado e inclui orientacao para procurar atendimento presencial em casos de urgencia ou emergencia.
