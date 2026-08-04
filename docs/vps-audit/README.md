# Audit VPS — performances, données et sécurité

Dispositif mis en place le **2026-08-04**. Il répond à une question simple :
*qu'est-ce que la machine encaisse, et qu'est-ce qu'on en fait ?*

Le [centre d'alerte](../centre-alerte/README.md) dit ce que **l'application** casse.
Celui-ci dit ce que **la machine** subit — disque, mémoire, conteneurs, sécurité. Deux
questions, deux temporalités : une erreur applicative se voit à la seconde, un disque qui
se remplit se voit en semaines. Les mélanger noierait la seconde.

## Les pièces

| Fichier | Rôle |
|---|---|
| [`REFERENCE-CONSTATS.md`](./REFERENCE-CONSTATS.md) | **Le référentiel.** Une fiche par constat : mesure, cause, correctif, gain, statut. C'est la mémoire longue — elle survit à la rotation des logs système et au redémarrage des conteneurs. |
| [`PROCEDURE-AUDIT.md`](./PROCEDURE-AUDIT.md) | **La méthode.** Ce que l'audit collecte, dans quel ordre, avec les garde-fous et les pièges déjà payés. |
| [`collecte.sh`](./collecte.sh) | **Le collecteur.** Un instantané complet de la machine en une passe, **lecture seule**. |
| [`rapports/`](./rapports/) | Un rapport par passage. |
| `app/wiki.json` | **Le manifeste lu par l'application** : titres, sections, constats et journal des passages. |

## Où ça se lit

**Dans Tracky** : `/admin` → **Audit VPS**. Tout ce dossier y est consultable.
Servi par `GET /api/admin/vps/wiki` (SUPER_ADMIN), qui parcourt le dossier sur le disque.

L'écran répond à quatre questions, dans cet ordre :

| Bloc | Ce qu'il montre | D'où viennent les données |
|---|---|---|
| **Verdict** | l'état en une phrase | `passages[0].verdict` |
| **Prévisions** | remplissage du disque, **tendance**, et ce que chaque nettoyage rendrait | `previsions` + calcul de pente sur l'historique des `passages` |
| **Ordonnancement** | tout ce qui se déclenche seul, **les trois couches sur la même ligne de temps** | `ordonnancement` |
| **Constats** | pour chacun : *quand*, *quoi*, *quoi faire*, *ce que ça rend* | `fiches` |

> La **tendance** de remplissage demande au moins deux passages. Tant qu'il n'y en a qu'un,
> l'écran le dit franchement plutôt que d'afficher « 0 %/jour » — un zéro inventé se lit comme
> « rien ne bouge », l'exact contraire de « on ne sait pas encore ».

### Les trois couches de l'ordonnancement

C'est le seul endroit où l'on voit **ensemble** ce qui se déclenche tout seul :

- **VPS** — crons et timers systemd de la machine ;
- **Poste** — les agents planifiés (audits) ;
- **le permanent** — healthchecks, sondes, collecte `sysstat`.

Une collision ne se voit qu'en les regardant sur la même ligne de temps. C'est ainsi qu'ont été
trouvées les **deux sauvegardes de 5 h** ([VPS-003](./REFERENCE-CONSTATS.md)) : chaque journal
n'en montrait qu'une.

> ⚠️ La couche **application** (les 32 tâches `@Cron` de l'API) a déjà son écran dédié :
> `/admin/background-tasks`. Elle n'est pas reprise ici — deux catalogues du même objet
> divergeraient, et c'est le genre de doublon que cet audit existe pour trouver.

> ⚠️ Cet écran est distinct de `/admin/system`, qui montre l'**instant** (CPU, RAM, charge
> en direct). Celui-ci montre la **dérive** : ce qui se remplit, ce qui traîne, ce qui expose.

### Publier une mise à jour en production

L'API lit `/opt/tracky-vps-audit` sur le VPS, monté en lecture seule. Publier = copier les
fichiers, **sans rebuild ni redémarrage** :

```bash
ssh root@72.62.26.240 "mkdir -p /opt/tracky-vps-audit" && scp -r docs/vps-audit/. root@72.62.26.240:/opt/tracky-vps-audit/
```

⚠️ L'image Docker embarque aussi une copie (`deploy/vps/Dockerfile.api`), mais elle est
**figée**. Et si le dossier monté n'existe pas, Docker le crée vide et masque le contenu de
l'image — d'où le `mkdir -p`, qui n'est pas une précaution mais une obligation.

## Comment ça tourne

- **Automatique** — tâche planifiée `audit-vps`, une fois par jour. Une garde anti-doublon
  empêche deux rapports le même jour.
- **À la main** — `/audit-vps` dans Claude Code, à tout moment.

## Les quatre règles

1. **Lecture seule.** L'audit ne supprime rien, ne redémarre rien, n'installe rien. Il
   observe et il propose. Les commandes de remédiation sont **écrites dans le rapport**,
   pour qu'un humain les lise avant de les lancer.
2. **Un chiffre sans sa source n'est pas un constat.** Chaque mesure du rapport indique la
   commande qui l'a produite — sinon on ne peut ni la vérifier ni la reproduire.
3. **Ce qui va bien se dit aussi.** Un rapport qui ne liste que des problèmes ne permet pas
   de voir qu'un problème a disparu.
4. **L'agent se relit.** Chaque rapport se termine par une section *« Améliorer l'agent »* :
   ce que ce passage a révélé sur les angles morts de la collecte. C'est de là que vient la
   version suivante du collecteur.
