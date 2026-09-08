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

## ✅ Déployer : `deploy.sh`, et pourquoi il refuse parfois

    bash /opt/vizyo-tracky/deploy/vps/deploy.sh              # pull + build + état des conteneurs
    bash /opt/vizyo-tracky/deploy/vps/deploy.sh --avec-demo  # et la démo dans la foulée
    bash /opt/vizyo-tracky/deploy/vps/deploy.sh --force      # même si un passage tourne

> ⛔ **Le script REFUSE de partir si l'automatisation des trajets tourne.** Elle part à HH:45 et
> dure de 2 à 54 min selon la charge ; recréer le conteneur de l'API pendant ce temps **tue le
> passage** — les trajets de l'heure ne sont ni analysés ni racontés jusqu'au passage suivant.
> Quatre passages ont été tués ainsi le 2026-09-07, sans que rien n'en garde trace.
>
> Depuis « la ligne au départ » (2026-09-08), un passage en cours porte `status='running'` dans
> `trip_automation_runs` : le script le lit. `--force` passe outre en le disant — le passage
> apparaîtra alors « Interrompu » dans l'historique et une alerte critique partira.

## Environnement de démonstration (2026-09)

Une pile séparée sur les MÊMES images que la prod (pas de `build:`). Après le déploiement de la
prod, **une ligne de plus** — c'est ce qui met la démo à jour :

    docker compose --env-file .env.demo -f docker-compose.demo.yml up -d      # démo

Installation, rafraîchissement (hebdomadaire + à la demande), comptes et procédure prospect :
`docs/environnement-demo/EXPLOITATION.md`. Plan et garanties : `docs/environnement-demo/PLAN-2026-09-07.md`.
