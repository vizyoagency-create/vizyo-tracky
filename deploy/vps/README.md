# Déploiement VPS Tracky

Voir `docs/DEPLOYMENT-VPS.md` pour la procédure complète.

## Commandes rapides

> ⚠️ **Toujours passer `--env-file .env.prod`** sur les commandes `up`/`build`.
> Compose lit `.env` par défaut pour l'interpolation (`${TRAEFIK_NETWORK}`,
> `${APP_DOMAIN}`, etc.) et `.env.prod` n'est PAS chargé tout seul, même si
> `env_file: .env.prod` est déclaré dans le service (cette directive s'applique
> au runtime du container, pas au parsing du compose). Sans le flag, le déploiement
> échoue avec `network <vide> declared as external, but could not be found`.

    # Déploiement complet : API, application Web et site marketing
    bash /opt/vizyo-tracky/deploy/vps/deploy.sh

    # Site marketing uniquement : ne recrée ni l'API ni l'application Web
    bash /opt/vizyo-tracky/deploy/vps/deploy.sh --marketing-seul

    # Logs
    docker logs -f tracky-api
    docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f

## ⛔ La production se déploie par `deploy.sh` — et par rien d'autre

> **Décision D1 du propriétaire (2026-09-13).** Jamais `docker compose up` à la main sur la pile
> de production. Le script est le seul chemin, et un contournement **se voit** : chaque
> déploiement inscrit dans `/opt/tracky-deploiements/journal.jsonl` l'identifiant du conteneur
> qu'il a créé ; l'API compare au démarrage son propre identifiant au dernier journalisé, et un
> conteneur que le script n'a pas créé produit une ligne « déploiement hors script » au centre
> d'alerte. L'audit du lendemain en fait une tâche.

    bash /opt/vizyo-tracky/deploy/vps/deploy.sh                 # refuse si un passage tourne ou va partir
    bash /opt/vizyo-tracky/deploy/vps/deploy.sh --attendre      # patiente (65 min au plus) au lieu de refuser
    bash /opt/vizyo-tracky/deploy/vps/deploy.sh --force         # déploie quand même, et le dit
    bash /opt/vizyo-tracky/deploy/vps/deploy.sh --avec-demo     # et la démo dans la foulée
    bash /opt/vizyo-tracky/deploy/vps/deploy.sh --marketing-seul # seulement tracky-lp
    bash /opt/vizyo-tracky/deploy/vps/deploy.sh --branche X     # une autre branche que main (recette)
    bash /opt/vizyo-tracky/deploy/vps/deploy.sh --repli avant-20260913-1130-a8f9575e
                                                                 # revenir aux images étiquetées, sans rebuild

### Ce que le script fait, dans l'ordre

1. **La garde** — un passage d'automatisation tourne-t-il ? (`status='running'` dans
   `trip_automation_runs`, « la ligne au départ » du 2026-09-08). Refus, attente ou passage
   en force selon l'option.
2. **Les repères de repli** — `tracky-api:avant-<date>-<sha>`, `tracky-web:…` et
   `tracky-lp:…`, posés AVANT de
   toucher au code (c'est ce qui tourne qu'on étiquette). Trois par image, les plus vieux
   s'élaguent seuls. `--repli <étiquette>` revient dessus par le même chemin, garde comprise.
3. **Le code** — `git checkout` + `git pull --ff-only`.
4. **La construction** — les images de la production applicative et du site marketing sont
   construites sans effet sur ce qui tourne.
5. **La garde, À NOUVEAU** — c'est maintenant que ça tue (TRK-077, ci-dessous).
6. **La recréation** — les piles applicative et marketing sont recréées, puis leur santé est
   attendue. Un échec remet automatiquement les trois images précédentes.
7. **Le journal** — date, sha, périmètre, identifiants API/Web/marketing, qui, d'où, options.

`--marketing-seul` applique les mêmes repères, contrôle de santé, journal et repli automatique,
mais uniquement à `tracky-lp`. Il ne lit pas la garde des trajets, ne joue aucune migration et
ne recrée ni `tracky-api` ni `tracky-web`. Il est incompatible avec `--avec-demo`.

Lors de la toute première livraison qui introduit cette option sur un VPS encore équipé de
l'ancien script, faire d'abord un simple `git pull --ff-only origin main` dans
`/opt/vizyo-tracky`, puis lancer `deploy.sh --marketing-seul`. Le pull ne recrée aucun conteneur ;
il rend seulement la nouvelle option disponible.

### Pourquoi il refuse parfois — et pourquoi deux fois

> L'automatisation des trajets part à **HH:45** et dure de 2 à 54 min selon la charge ; recréer
> le conteneur de l'API pendant ce temps **tue le passage** — les trajets de l'heure ne sont ni
> analysés ni racontés jusqu'au passage suivant. Quatre passages ont été tués ainsi le
> 2026-09-07, sans que rien n'en garde trace.
>
> **TRK-077 (2026-09-09)** : la garde était lue une fois, au départ, puis `git pull` et une
> construction de plusieurs minutes précédaient la recréation. Un déploiement lancé à 17:43
> franchissait la garde *à juste titre* et tuait le passage de 17:45. Elle protégeait de tout
> sauf du cas le plus probable. Désormais elle est **relue juste avant `up -d`**, et la
> recréation est **refusée de HH:42 à HH:46** : une API qui redémarre à cheval sur le tic de :45
> manque le tic *sans laisser de trace* — pire qu'un passage tué, qui lui est marqué « interrompu ».
>
> `--attendre` patiente 30 s par 30 s jusqu'à la fin du passage (65 min au plus). `--force`
> passe outre en le disant — le passage apparaîtra « Interrompu » dans l'historique et une
> alerte critique partira. Un correctif urgent vaut parfois un passage perdu, mais ce doit être
> un choix, pas une surprise.

Le script se teste à blanc, sans VPS : `pnpm verif:deploiement` (47 contrôles, `deploy.test.sh`).

## Environnement de démonstration (2026-09)

Une pile séparée sur les MÊMES images que la prod (pas de `build:`). Après le déploiement de la
prod, **une ligne de plus** — c'est ce qui met la démo à jour :

    docker compose --env-file .env.demo -f docker-compose.demo.yml up -d      # démo

Installation, rafraîchissement (hebdomadaire + à la demande), comptes et procédure prospect :
`docs/environnement-demo/EXPLOITATION.md`. Plan et garanties : `docs/environnement-demo/PLAN-2026-09-07.md`.
