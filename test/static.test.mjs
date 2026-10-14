import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { publicRelativePath, trackingDataDir } from '../server.mjs';
import { request, startServer } from './helpers.mjs';

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('servidor estático com allowlist', () => {
  let app;
  before(async () => {
    app = await startServer();
  });
  after(() => app.close());

  for (const blocked of [
    '/server.mjs',
    '/package.json',
    '/lib/metrics.mjs',
    '/scripts/metrics-report.mjs',
    '/test/helpers.mjs',
    '/test/static.test.mjs',
    '/README.md',
    '/Dockerfile',
    '/metrics.json',
    '/data/metrics/metrics.json',
    '/.env',
    '/assets/.hidden.png',
    '/assets/logo-horizontal.svg.map',
    '/conteudos/../server.mjs',
    '/%2e%2e/server.mjs',
    '/assets/%2e%2e/server.mjs',
    '/assets/..%2fserver.mjs',
    '/assets%5c..%5cserver.mjs',
    '/consulta-medica-online/%00',
    '/%E0%A4%A'
  ]) {
    test(`bloqueia ${blocked}`, async () => {
      const response = await request(app.port, { path: blocked });
      assert.equal(response.status, 404);
      assert.doesNotMatch(response.body, /createAppServer|"scripts"|MetricsStore/);
    });
  }

  test('serve páginas, CSS, JS e imagens públicas', async () => {
    for (const [publicPath, type] of [
      ['/', 'text/html'],
      ['/consulta-medica-online/', 'text/html'],
      ['/conteudos/hemograma-completo/', 'text/html'],
      ['/privacidade/index.html', 'text/html'],
      ['/styles.css', 'text/css'],
      ['/script.js', 'application/javascript'],
      ['/assets/dr-guilherme-profile.jpg', 'image/jpeg'],
      ['/robots.txt', 'text/plain']
    ]) {
      const response = await request(app.port, { path: publicPath });
      assert.equal(response.status, 200, publicPath);
      assert.match(response.headers['content-type'], new RegExp(type));
      assert.match(response.headers['content-security-policy'], /default-src 'self'/);
    }
  });

  test('redireciona diretório sem barra final preservando a query', async () => {
    const response = await request(app.port, { path: '/consulta-medica-online?utm_source=meta' });
    assert.equal(response.status, 301);
    assert.equal(response.headers.location, '/consulta-medica-online/?utm_source=meta');
  });

  test('healthz não expõe configuração', async () => {
    const response = await request(app.port, { path: '/healthz' });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { status: 'ok' });
  });

  test('não há endpoint público de consulta das métricas', async () => {
    for (const method of ['GET', 'HEAD']) {
      for (const metricPath of ['/api/public/site-metrics/visit', '/api/public/site-metrics/schedule-click', '/api/public/site-metrics']) {
        const response = await request(app.port, { method, path: metricPath });
        assert.ok([404, 405].includes(response.status), `${method} ${metricPath} -> ${response.status}`);
      }
    }
  });
});

test('publicRelativePath recusa segmentos ocultos e traversal', () => {
  assert.equal(publicRelativePath('/../server.mjs'), null);
  assert.equal(publicRelativePath('/sobre/../../etc/passwd'), null);
  assert.equal(publicRelativePath('/.git/config'), null);
  assert.deepEqual(publicRelativePath('/sobre/'), { file: 'sobre/index.html' });
});

test('Dockerfile prepara o volume root em runtime e roda o Node sem root', () => {
  const dockerfile = readFileSync(path.join(SITE_ROOT, 'Dockerfile'), 'utf8');
  const instructions = dockerfile.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  const cmd = instructions.find((line) => line.startsWith('CMD '));
  assert.ok(cmd, 'CMD presente');
  const [shell, flag, script] = JSON.parse(cmd.slice(4));
  assert.deepEqual([shell, flag], ['/bin/sh', '-c']);
  // Somente a pasta de medição, nunca o volume inteiro.
  assert.match(script, /mkdir -p "\$dir"/);
  assert.match(script, /chown 1000:1000 "\$dir"/);
  assert.match(script, /chmod 0700 "\$dir"/);
  assert.match(script, /TRACKING_DATA_DIR:-\/data\/metrics/);
  assert.match(script, /exec su -s \/bin\/sh node -c 'exec \/usr\/local\/bin\/node \/app\/server\.mjs'$/);
  assert.doesNotMatch(dockerfile, /chown -R|RAILWAY_RUN_UID|ENTRYPOINT|apk add|^USER /m);
  // Sem arquivo de entrypoint separado; o init precisa rodar como root (padrão da imagem).
  assert.doesNotMatch(dockerfile, /COPY[^\n]*entrypoint/i);
});

test('HTML usa a versão nova de CSS/JS (sem cache antigo)', () => {
  const pages = [
    'index.html',
    'consulta-medica-online/index.html',
    'sobre/index.html',
    'privacidade/index.html',
    'conteudos/index.html',
    'conteudos/colesterol-alto/index.html',
    'conteudos/check-up-exames/index.html',
    'conteudos/hemograma-completo/index.html',
    'conteudos/glicemia-alta/index.html'
  ];
  for (const page of pages) {
    const html = readFileSync(path.join(SITE_ROOT, page), 'utf8');
    const refs = [...html.matchAll(/(?:styles|conteudos|analytics|script)\.(?:css|js)\?v=([\w-]+)/g)].map((match) => match[1]);
    assert.ok(refs.length >= 3, page);
    assert.ok(refs.every((version) => version === '20261014-contact'), `${page}: ${refs.join(',')}`);
  }
});

test('README descreve a allowlist fechada e a topologia de 1 réplica', () => {
  const readme = readFileSync(path.join(SITE_ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /no formato `drg_\[a-z0-9_\]`/);
  for (const code of ['drg_ig_lpv_202610', 'drg_contact_sp_rj_202608', 'drg_teleconsulta_sp_rj_2026_08']) {
    assert.ok(readme.includes(code), code);
  }
  assert.match(readme, /1 réplica/);
});

test('TRACKING_DATA_DIR nunca pode ficar dentro da pasta pública', () => {
  assert.equal(trackingDataDir({ TRACKING_DATA_DIR: SITE_ROOT }), null);
  assert.equal(trackingDataDir({ TRACKING_DATA_DIR: path.join(SITE_ROOT, 'assets') }), null);
  assert.equal(trackingDataDir({}), '/data/metrics');
  assert.equal(trackingDataDir({ TRACKING_DATA_DIR: '/data/custom' }), '/data/custom');
});
