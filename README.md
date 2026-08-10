# Landing page premium - Dr. Guilherme Rampinelli

Esta pasta contem uma landing page estatica pronta para publicacao.

O projeto inclui um `Dockerfile` para publicacao no Railway e a area de conteudos
educativos em rotas proprias.

## Arquivos

- `index.html`: estrutura, conteudo, SEO, schema e links da Doctoralia.
- `styles.css`: identidade visual, responsividade e layout.
- `analytics.js`: consentimento de medicao e carregamento do Google Analytics 4.
- `script.js`: captura de atribuicao com consentimento, decoracao dos links da Doctoralia e eventos do GA4.
- `assets/`: monograma, logo horizontal com fundo, logo horizontal transparente e foto usada na pagina.
- `conteudos/`: pagina de publicacoes e artigos educativos.
- `consulta-medica-online/`: pagina focada em busca e conversao para consulta com clinico geral online.
- `sobre/`: perfil profissional e sinais de autoria medica.
- `privacidade/`: aviso de privacidade e controle da preferencia de cookies.
- `conteudos.css`: estilos compartilhados da area de conteudos.
- `robots.txt` e `sitemap.xml`: arquivos de descoberta para mecanismos de busca.

## Publicacao

Suba o conteudo desta pasta para a raiz do dominio, mantendo a pasta `assets` no mesmo nivel de `index.html`.

O `Dockerfile` ja inclui `robots.txt`, `sitemap.xml`, `analytics.js`, a pagina de privacidade e todos os arquivos da pasta `assets/` na imagem publicada.

O Google Analytics 4 usa o ID `G-N3GMLBFNRH` e so e carregado depois do aceite do visitante. Os recursos de publicidade e personalizacao permanecem desativados.

## Pontos faceis de atualizar

- Link da Doctoralia: procure por `doctoralia.com.br/guilherme-rampinelli`.
- Valor da consulta: procure por `R$ 70`.
- Quantidade de opinioes: procure por `60 opiniões`.
- Variante de rastreamento: procure por `premium_identity_doctoralia_v1`.
- Conteudos publicados: abra `conteudos/index.html`. O primeiro artigo esta em
  `conteudos/colesterol-alto/index.html`.
- URLs indexaveis: atualize `sitemap.xml` ao publicar uma nova pagina ou artigo.
- Imagem de compartilhamento: `assets/og-clinico-geral-online.png` e as meta tags Open Graph/Twitter
  de cada pagina.

## Observacao medica

A pagina evita promessas de resultado e inclui orientacao para procurar atendimento presencial em casos de urgencia ou emergencia.
