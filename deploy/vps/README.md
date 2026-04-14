# Déploiement VPS Tracky

Voir `docs/DEPLOYMENT-VPS.md` pour la procédure complète.

## Commandes rapides

    # Depuis /opt/vizyo-tracky/deploy/vps/
    docker compose -f docker-compose.lp.yml up -d --build   # Landing page
    docker compose -f docker-compose.prod.yml up -d --build # App prod

    # Logs
    docker logs -f tracky-api
    docker compose -f docker-compose.prod.yml logs -f

    # Redéploiement après git pull
    cd /opt/vizyo-tracky && git pull origin main
    cd deploy/vps && docker compose -f docker-compose.prod.yml up -d --build
