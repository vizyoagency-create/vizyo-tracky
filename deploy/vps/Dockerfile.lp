FROM nginx:alpine
# Seul le dossier servi est copié (les sources lp/src + build.mjs ne sont jamais exposés)
COPY lp/public/ /usr/share/nginx/html/
COPY deploy/vps/nginx.lp.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
