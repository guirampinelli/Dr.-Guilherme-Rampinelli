FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html styles.css script.js analytics.js conteudos.css robots.txt sitemap.xml /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/
COPY conteudos/ /usr/share/nginx/html/conteudos/
COPY privacidade/ /usr/share/nginx/html/privacidade/
COPY consulta-medica-online/ /usr/share/nginx/html/consulta-medica-online/
COPY sobre/ /usr/share/nginx/html/sobre/

EXPOSE 8080
