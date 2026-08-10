# Mapa do site — Dr. Guilherme Rampinelli

_Verificado em 9 de agosto de 2026._

## Visão geral

| Camada | Situação atual | Onde alterar |
| --- | --- | --- |
| Domínio público | `https://drrampinelli.com.br/` | DNS/domínio e configurações de domínio no Railway |
| Hospedagem | Railway, com deploy automático do GitHub | `LUMMEN` → `Guilherme` → `Guilherme` → `production` |
| Página | Landing page estática, em português | `index.html` |
| Aparência | CSS próprio e responsivo | `styles.css` |
| Interações e rastreamento | JavaScript no navegador | `script.js` |
| Imagens e logos | Arquivos locais, sem CDN próprio | `assets/` |
| Conteúdos educativos | Índice e artigos estáticos | `conteudos/` e `conteudos.css` |
| SEO e descoberta | Metadados, dados estruturados, sitemap e robots | HTML, `sitemap.xml` e `robots.txt` |
| Agendamento | Links externos da Doctoralia | URLs com `doctoralia.com.br` em `index.html` |
| Métricas | Google Analytics 4 `G-N3GMLBFNRH`, carregado após consentimento | `analytics.js` e `script.js` |

O site não tem banco de dados, painel administrativo ou API própria: é uma página estática. As alterações de texto, valor, foto, logo e links são feitas diretamente nos arquivos acima.

## Estrutura do projeto

```text
landing-page-premium/
├── index.html       conteúdo, SEO, links, GTM e estrutura da página
├── styles.css       cores, layout, responsividade e animações
├── script.js        UTMs, cliques na Doctoralia e eventos do GTM
├── conteudos.css     visual compartilhado da área de conteúdos
├── robots.txt        orientação de rastreamento e link do sitemap
├── sitemap.xml       lista das URLs que podem aparecer na busca
├── consulta-medica-online/
│   └── index.html    página de serviço para buscas de alta intenção
├── sobre/
│   └── index.html    perfil profissional e autoria médica
├── conteudos/
│   ├── index.html    índice de publicações
│   ├── check-up-exames/
│   ├── colesterol-alto/
│   ├── hemograma-completo/
│   └── glicemia-alta/
├── assets/
│   ├── dr-guilherme-profile.jpg
│   ├── gr-monograma.svg
│   ├── logo-horizontal.svg
│   ├── logo-horizontal-transparent.svg
│   ├── og-teleconsulta.png
│   └── og-clinico-geral-online.png
├── README.md        resumo técnico já existente
└── MAPA_DO_SITE.md  este guia
```

## Pontos mais frequentes de alteração

| O que mudar | Arquivo | Referências atuais |
| --- | --- | --- |
| Título, descrição, cartão de compartilhamento e endereço canônico | `<head>` de cada `index.html` | procure `description`, `canonical` e `og:` |
| Texto da capa | `index.html` | linhas 97–123 |
| Valor da consulta | `index.html` e `script.js` | procurar `R$ 70` e `lead_value: 70` / `value: 70` |
| Número de opiniões | `index.html` | procurar `60 opiniões` |
| Link de agendamento | `index.html` | procurar `doctoralia.com.br` (quatro CTAs) |
| Texto “Sobre”, CRM e formação | `index.html` | linhas 170–217 |
| Seções de funcionamento, demandas e FAQ | `index.html` | linhas 232–373 |
| Foto, logos ou monograma | `assets/` e respectivas referências no `index.html` |
| Cores, fontes, espaçamentos e visual | `styles.css` | variáveis no início do arquivo |
| Eventos de conversão/UTMs | `script.js` | `doctoralia_click` e `generate_lead` |
| Publicar um novo texto | `conteudos/` | crie uma nova pasta com `index.html` e adicione o cartão em `conteudos/index.html` |
| URLs enviadas aos buscadores | `sitemap.xml` | inclua cada nova página pública com uma data de atualização correta |

## Cuidados ao alterar

- Se o valor da consulta mudar, atualize todas as ocorrências de `R$ 70`, o valor da oferta no schema e os valores numéricos `70` em `script.js`; assim, o texto, o SEO e as métricas continuam coerentes.
- Ao trocar a URL da Doctoralia, atualize todos os links com `data-doctoralia-link="true"`. O JavaScript preserva as UTMs e os identificadores de campanha desses links.
- Mantenha `assets/` ao lado de `index.html`; os caminhos das imagens são relativos.
- Só altere o ID `G-N3GMLBFNRH` depois de confirmar a propriedade correta no Google Analytics.
- Depois de publicar, confira desktop e celular, cada CTA da Doctoralia e a página inicial em uma aba anônima.

## Publicação no Railway

A página em produção está respondendo normalmente (`HTTP 200`) e passa pelo Railway. A configuração abaixo foi lida pela API em modo somente leitura.

| Dado | Valor |
| --- | --- |
| Workspace | `LUMMEN` (`b2f67e88-0a54-42e3-9d71-0ac8dc00ccc6`) |
| Projeto | `Guilherme` (`612bf5a6-677b-4c39-8970-ca9d21278619`) |
| Serviço | `Guilherme` (`2078503e-623b-4a42-8589-918fbc022eb5`) |
| Ambiente | `production` (`f3ceb5be-16e9-4300-a440-ec03e4a7b797`) |
| Domínio público | `drrampinelli.com.br` |
| Repositório de origem | GitHub: `guirampinelli/Dr.-Guilherme-Rampinelli` |
| Branch publicada | `main` |
| Método de build | Railpack, sem comando de build, start ou diretório raiz personalizados |
| Último deploy confirmado | `SUCCESS`, em 8 de agosto de 2026 |

O token é limitado ao workspace LUMMEN. Ele não deve ser colocado no repositório GitHub, em arquivos do site, nem em mensagens. Para automações futuras, mantenha-o fora do projeto e use o cabeçalho `Authorization: Bearer ...`.

## Fluxo recomendado para uma alteração simples

1. Faça a alteração nesta pasta, conectada ao repositório GitHub `guirampinelli/Dr.-Guilherme-Rampinelli`, branch `main`.
2. Abra `index.html` localmente no navegador e valide a alteração antes do envio.
3. Envie o commit à branch `main`. O Railway inicia o deploy automaticamente pelo Railpack.
4. Aguarde o estado `SUCCESS` no serviço **Guilherme** do ambiente **production**.
5. Abra `https://drrampinelli.com.br/` em janela anônima e confira a versão publicada, incluindo os links da Doctoralia.
