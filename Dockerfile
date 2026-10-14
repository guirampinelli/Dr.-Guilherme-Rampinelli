FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    TRACKING_DATA_DIR=/data/metrics

WORKDIR /app

# Cópia explícita: README, testes e arquivos de desenvolvimento ficam fora da imagem.
COPY package.json server.mjs ./
COPY lib ./lib
COPY scripts ./scripts
COPY index.html styles.css conteudos.css script.js analytics.js robots.txt sitemap.xml ./
COPY assets ./assets
COPY consulta-medica-online ./consulta-medica-online
COPY sobre ./sobre
COPY privacidade ./privacidade
COPY conteudos ./conteudos

EXPOSE 8080

# O volume do Railway é montado em /data como root no início do container, então o
# preparo precisa ocorrer em runtime: como root (usuário padrão da imagem base),
# cria somente a pasta de medição, entrega-a ao usuário node (1000:1000) com 0700 e
# troca de usuário com o su do BusyBox (já presente no Alpine). O exec final deixa o
# node como PID 1, recebendo o SIGTERM do Railway. O restante do volume não é alterado.
CMD ["/bin/sh", "-c", "set -eu; dir=\"${TRACKING_DATA_DIR:-/data/metrics}\"; mkdir -p \"$dir\"; chown 1000:1000 \"$dir\"; chmod 0700 \"$dir\"; exec su -s /bin/sh node -c 'exec /usr/local/bin/node /app/server.mjs'"]
