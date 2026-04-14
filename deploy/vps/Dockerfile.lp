FROM nginx:alpine
COPY lp/ /usr/share/nginx/html/
COPY deploy/vps/nginx.lp.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
