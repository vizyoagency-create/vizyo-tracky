# SUIVI — le poste de commande

> **Ce fichier dit ce qu'on fait ensuite, et où on en est. Rien d'autre.**
> Le détail de chaque tâche vit dans [`centre-alerte/ROADMAP-CORRECTIFS.md`](./centre-alerte/ROADMAP-CORRECTIFS.md)
> (56 fiches, tenue chaque nuit par les audits). **On ne recopie pas** : ici l'ordre et l'état,
> là-bas le pourquoi et la preuve.
>
> **Règle de tenue :** après chaque tâche terminée, on coche ici **et** on met à jour sa ligne
> `T-nn` / `V-nn` dans la roadmap. Une tâche ne disparaît jamais : elle passe en ✅ avec sa date.

*Dernière mise à jour : 2026-09-10 · dépôt sur `main`*

---

## 🟢 Où on en est

L'application tourne. Le centre d'alerte est calme : **zéro erreur répétée depuis le 08/09 16:28**.
Les quatre correctifs de cette semaine ont été prouvés **en production**, dont un sur un incident
réel qu'on n'avait pas provoqué (déploiement pendant un passage d'automatisation, 09/09 19:46).

Deux mécaniques travaillent toutes seules et n'ont besoin de personne :

| Ce qui tourne | Où ça en est | Fin prévue |
|---|---|---|
| Rattrapage du recalage des tracés | 13 835 restants, ~15 par heure | ~38 jours |
| Reprise des analyses d'avant le 4 septembre | 25 par passage | s'éteint seule |

---

## 🤝 CE QUI T'ATTEND — rien ne peut avancer sans toi

*Huit gestes que le code ne peut pas faire. Le premier bloque toute la chaîne IA.*

| | # | Quoi | Fiche |
|:--:|:--:|---|---|
| ☐ | **T1** | 🔴🔴 Recharger **au moins un** des deux comptes IA | TRK-071 |
| ☐ | **T3** | 🔴 Trancher les **trois questions** du coupe-circuit | TRK-066 |
| ☐ | **T4** | Calibrer les notifications d'excès de vitesse | TRK-072 |
| ☐ | **T5** | Autoriser la migration `SENT_UNCONFIRMED` | TRK-062 |
| ☐ | **T6** | Prévenir `tyger.bcn@gmail.com` — **21 notifications perdues** | TRK-065 |
| ☐ | **T7** | Ouvrir la fenêtre de maintenance (rôle non-superutilisateur) | TRK-035 |
| ☐ | **T8** | Faire contrôler les antennes de **3 véhicules** | TRK-001 · 027 |
| ☐ | **T9** | Déclarer ou dépanner `GLA•KC•31` et `FG-669-DQ` | — |

### Et deux décisions courtes, posées le 10/09

| | Question | Ce que ça change |
|:--:|---|---|
| ☐ | **D1** — Le script qui refuse de déployer pendant un passage d'automatisation : **obligatoire, ou simple aide ?** | Il marche, mais la session qui a déployé le 09/09 ne l'a pas utilisé et a tué un passage. |
| ☐ | **D2** — Rattrapage du recalage : **rester à 15/heure (38 j) ou monter à 50 (11 j) ?** | Réglable sans redéployer. La seule retenue est la politesse envers OSRM, qui est gratuit. |

---

## 🔧 CE QUE JE PEUX CODER — par ordre d'utilité

| | # | Quoi | Fiche | Note |
|:--:|:--:|---|---|---|
| ☐ | **T28** | 🔴 **Redéfinir la mesure du recalage** : à la clôture, sur une fenêtre fermée | TRK-016 | Sans elle, T13 reste indécidable. J'ai déjà les chiffres qui la tranchent. |
| ☐ | **T25** | Résolution **automatique** du témoin des tâches de fond | TRK-074 | 4 `CRITICAL` traînent depuis 4 jours faute de clôture auto. |
| ☐ | **T12** | Déduplication **générique** des alarmes du boîtier | TRK-022 | Évite le retour du déluge de notifications. |
| ☐ | **R1** | Ranger les 13 `.md` de la racine + les roadmaps mortes | — | Plan écrit : [`REARCHITECTURE-ARBORESCENCE.md`](./REARCHITECTURE-ARBORESCENCE.md), lots 1 et 2. **Demande une fenêtre courte et annoncée** : un `git mv` de masse entre en conflit avec toute session ouverte. |

---

## 👁️ CE QU'ON GUETTE — rien à faire, la mesure tombe toute seule

| | # | Ce qui le prouvera | Quand |
|:--:|:--:|---|---|
| ☐ | **T17** | La ligne hebdomadaire tombe de 42 à ~21 et ne cite plus `system@tracky.local` | ~11/09 |
| ☐ | **T15** | Une ligne `system-metrics` en français, pas une pile de transport brute | au prochain incident DNS |
| ☐ | **T18** | La ligne `sms-gateway` nomme `vizyo-texto` **et garde le motif technique** | au prochain échec du relais |
| ☐ | **T27** | La carte survit à une perte de contexte WebGL | échéance 15/09 |

---

## 🖥️ CÔTÉ VPS — 28 constats, presque tous des gestes d'infrastructure

*Le détail est en [Partie II de la roadmap](./centre-alerte/ROADMAP-CORRECTIFS.md). Les plus lourds :*

| | # | Quoi |
|:--:|:--:|---|
| ☐ | **V1 · V2** | Porter les **6 IMEI muets** à l'exploitant, puis les sortir du parc |
| ☐ | **V4** | Planifier un redémarrage (noyau + 6 services) |
| ☐ | **V7** | Poser des limites mémoire — **30 conteneurs sur 33** n'en ont pas |
| ☐ | **V10** | Retirer `/opt/vizyo-leads` — **823 Mo** d'une pile supprimée le 04/08 |

---

## ✅ FAIT ET PROUVÉ — cette semaine

*« Prouvé » veut dire mesuré en production, pas déployé.*

| Date | Quoi | La preuve |
|---|---|---|
| 09/09 | **La sentinelle nomme des boîtiers, plus des flottes** | Passage de 06:30 : 4 véhicules nommés avec leur part, **silence pour cdef31** qui recevait un message la veille. Le rejeu SQL de la règle donne exactement les mêmes. |
| 09/09 | **La ligne au départ attrape un vrai incident** | Déploiement pendant le passage de 19:45 → marqué `interrupted`, e-mail livré à 19:50, travail rattrapé au passage suivant. |
| 08/09 | **L'alerte répétée est éteinte** | Un trajet criait une fois par heure depuis 27 h. **0 ligne depuis**, sur 30 h. |
| 08/09 | **Le recalage des tracés est réparé** | **224 trajets sur 224** clôturés depuis le correctif sont recalés. |
| 08/09 | **Une erreur critique suffit à prévenir** | 5 e-mails livrés en 2 jours, un par erreur, refroidissement respecté. |
| 08/09 | **Les fonds de carte ne dépendent plus de CARTO** | Plus aucune tuile « API KEY REQUIRED » : 0 URL `cartocdn` dans le paquet servi. |
| 07-08/09 | **Chantier cartes** — échelle de vitesse unique, traînées, légendes, repères non déplaçables | [`chantier-cartes/SUIVI-CARTES-2026-09-07.md`](./chantier-cartes/SUIVI-CARTES-2026-09-07.md) |

---

## 📍 Où vit quoi

L'index complet est dans [`README.md`](./README.md). L'essentiel :

- **Ce fichier** — ce qu'on fait ensuite.
- **[`centre-alerte/ROADMAP-CORRECTIFS.md`](./centre-alerte/ROADMAP-CORRECTIFS.md)** — les 56 fiches
  détaillées. ⚠️ Tenue **automatiquement** chaque nuit : ne pas la réécrire à la main sans raison.
- **`centre-alerte/` et `vps-audit/`** — 🔒 **artefacts servis par l'API**, pas de la documentation
  à lire. Ne rien y déplacer (chemins câblés en six endroits chacun).
- Tout `.md` portant un bandeau **⛔ ARCHIVE** décrit un chantier terminé. Il reste pour l'histoire.
