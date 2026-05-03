# Déploiement VPS Tracky

Voir `docs/DEPLOYMENT-VPS.md` pour la procédure complète.

## Commandes rapides

> ⚠️ **Toujours passer `--env-file .env.prod`** sur les commandes `up`/`build`.
> Compose lit `.env` par défaut pour l'interpolation (`${TRAEFIK_NETWORK}`,
> `${APP_DOMAIN}`, etc.) et `.env.prod` n'est PAS chargé tout seul, même si
> `env_file: .env.prod` est déclaré dans le service (cette directive s'applique
> au runtime du container, pas au parsing du compose). Sans le flag, le déploiement
> échoue avec `network <vide> declared as external, but could not be found`.

    # Depuis /opt/vizyo-tracky/deploy/vps/
    docker compose --env-file .env.prod -f docker-compose.lp.yml   up -d --build  # Landing page
    docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build  # App prod

    # Logs
    docker logs -f tracky-api
    docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f

    # Redéploiement après git pull
    cd /opt/vizyo-tracky && git pull origin main
    cd deploy/vps && docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
