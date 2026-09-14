# 26 — Correctif P2-2 (T49) : une coupe retenue n'est pas une panne par véhicule

Date : 14 septembre 2026
Branche : Tracky `codex/tracky-cutoff-reliability-2026-09-12`
Production : **aucun changement** — code écrit, testé et committé, non déployé.

## Le défaut corrigé (document 19, P2-2)

Le kill-switch (`ENGINE_AUTOMATIC_CUT_ENABLED ≠ true`) et l'interlock (chaîne de secours SMS non
prouvée) écrivaient un **CRITICAL à chaque appel refusé**. Le cron des horaires retente avec un
palier 2/5/15/30 min, la dédup d'ErrorLogger ne dure que 60 s, et la vigie envoie un courriel par
heure dès qu'un CRITICAL existe. Conséquence, le soir où un administrateur de flotte réactive ses
horaires (droit `schedules_manage`) sans savoir que le kill-switch est encore baissé : des
dizaines de lignes CRITICAL par nuit côté moteur de commande, **plus** une ligne « coupe/reprise
impossible sur <plaque> depuis N min » par véhicule côté cron (à 30 min, puis toutes les 3 h),
et des courriels — pour un état que le propriétaire a choisi.

## Ce qui change

| Où | Quoi |
|---|---|
| `AutomaticCutWithheldException` (`engine-control.service.ts`) | Le refus est **typé** (`cause: 'kill-switch' \| 'interlock'`, `reason`), hérite de `ServiceUnavailableException` : le cron le reconnaît par son **type**, jamais par son texte — la règle déjà posée par `PresumedParkedException`. |
| `signalWithheldCut` | **Une ligne par cause, espacée**, qui compte les refus et nomme les véhicules (plaques) depuis la ligne précédente. Kill-switch : niveau **DÉGRADATION** (le niveau du centre d'alerte pour « repli propre, perte bornée, contrepartie acceptée » — TRK-037 ; non compté comme erreur, ne réveille pas la vigie), au plus **une par heure**. Interlock : **CRITICAL**, une par **raison** et par **quart d'heure** — une raison nouvelle a sa ligne tout de suite. Le compteur est en mémoire : un redémarrage coûte au pire une ligne, jamais trente. Ne lève jamais. |
| `schedule-cron.service.ts` | Une coupe retenue n'est **pas** un blocage à alerter : pas de `trackDeferral`, ni sur le tick du refus, ni pendant le palier d'attente (`withheldCuts`) ; le palier habituel s'applique (on n'abandonne jamais de couper, on cesse de marteler) ; une ligne dans les journaux du conteneur, pas au centre d'alerte. Un refus d'une **autre** nature (boîtier hors ligne, vitesse) rouvre le compte du temps « bloqué » et garde son alerte. |
| Contexte de la ligne | `cause`, `reason`, `refusalsSinceLastLine`, `vehicles` (≤ 40 plaques), le véhicule déclencheur, `spacingMin`. |

Pourquoi **une ligne par cause** et non « par véhicule et par heure » comme le suggérait le
document 19 : trente lignes par heure disent trente fois la même chose ; une ligne qui compte
« 30 refus — véhicules : … » dit tout, et un exploitant la lit. Les véhicules non coupés se
lisent sur la page Horaires.

## Ce que ce correctif garantit — et ne garantit pas

- Garanti : avec le kill-switch baissé et 37 plannings réactivés, le centre d'alerte reçoit
  **une** ligne DÉGRADATION par heure (avec le compte et les plaques), zéro CRITICAL, zéro
  « coupe impossible » par véhicule, zéro courriel de vigie.
- Garanti : une chaîne SMS non prouvée (interlock) produit **une** ligne CRITICAL par raison et
  par quart d'heure — donc un courriel par heure au plus, ce qui est voulu : c'est une panne.
- Non garanti : la visibilité du kill-switch **sur la page Horaires** — elle n'existe pas encore
  (la ligne DÉGRADATION est la seule trace) ; à envisager dans T56/T3 si l'on veut que
  l'administrateur de flotte le voie sans ouvrir le centre d'alerte.

## Tests ajoutés (verts)

- `engine-control.service.spec.ts` (+4, 2 mis à jour) : 30 refus en une heure → une ligne, puis
  une seconde qui porte 30 refus et les plaques (sans celle déjà nommée) ; interlock : muet à 5 et
  14 min, ligne à 16 min avec le compte, raison nouvelle → ligne immédiate ; exception typée avec
  cause et raison ; centre d'alerte en panne → le refus tient quand même.
- `schedule-cron.service.spec.ts` (+4) : nuit entière de kill-switch → aucune ligne, palier
  respecté ; interlock idem ; une `ServiceUnavailableException` ordinaire garde son alerte ;
  kill-switch levé → la coupe suivante passe et rien ne reste en mémoire.
