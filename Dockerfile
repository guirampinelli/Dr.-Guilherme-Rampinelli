FROM nginx:1.27-alpine

COPY index.html styles.css script.js conteudos.css /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/
COPY conteudos/ /usr/share/nginx/html/conteudos/

EXPOSE 80
