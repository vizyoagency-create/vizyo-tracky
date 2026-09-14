# 35 — Correctif T62 : une SIM injoignable par SMS met le véhicule en « TCP seul » — et pourquoi deux boîtiers sur dix restent sourds

Date : 14 septembre 2026
Branche : Tracky `codex/tracky-cutoff-reliability-2026-09-12`
Production : **aucun changement** — code écrit, testé et committé, non déployé.

## 1. La question du propriétaire : pourquoi ça marche pour les autres et pas pour ces deux-là ?

Ce que l'on **sait** (mesuré le 14/09, document 33) :

| Fait | HD-584-BF (…621099) et BP-434-RD (…621103) | Les 8 autres, revenues |
|---|---|---|
| Résultat d'un `check123456` envoyé par le S21 via le relais | **`failed` au départ**, 8 s et 30 s après des envois réussis vers leurs voisines | delivered en quelques secondes, réponse du boîtier |
| Même série de numéros, même fournisseur (IMSI 214074), même statut « Activée », même profil | oui | oui |
| Boîtier en ligne en TCP, positions fraîches, session data active | oui (positions à 09:36) | oui |
| L'IMEI vu par le fournisseur = l'IMEI du boîtier (la SIM est bien dans ce boîtier) | oui | oui |
| Ces SIM ont déjà **émis** des SMS vers le S21 | non, jamais (aucun entrant depuis juin) | oui pour la plupart |
| Historique | …621103 : **une** remise le 29/08, puis 4 échecs ; …621099 : jamais remise | échecs jusqu'au 11/09, puis remises le 14/09 |

Ce que l'on **ne sait pas**, et qu'aucune donnée de Tracky, du relais ou du fournisseur ne permet de trancher depuis le
bureau : *où* le refus se produit. « `RESULT_ERROR_GENERIC_FAILURE` » est le verdict du modem du S21 quand le réseau
(Free) refuse la **soumission** — le SMS n'est jamais accepté par le centre de messages. Pour un numéro international,
Free consulte le réseau de destination avant d'accepter. Trois explications restent possibles, et elles ne se
distinguent que par un test que Tracky ne peut pas faire seul :

1. **Chez WhereverSIM / Telefónica** : le service « SMS entrant » (mobile-terminated) n'est pas provisionné, ou est
   provisionné différemment, sur ces deux cartes — ce qui expliquerait aussi qu'elles n'aient jamais émis de SMS. Le
   fait que …621103 ait reçu un SMS le 29/08 rend cette hypothèse moins nette, mais un profil peut changer.
2. **Chez Free** : un refus de routage propre à ces deux numéros (table de routage, filtre anti-fraude sur destination).
3. **Un défaut de ces deux cartes** (ou de leur inscription réseau) qui ne se voit ni dans la session data ni côté
   TCP — la carte échange des données mais n'est pas joignable pour un SMS.

Le premier test qui tranche coûte **un SMS** : `check123456` vers la SIM de HD-584-BF (numéro dans Tracky, fiche du boîtier) depuis une SIM d'un **autre
opérateur** (Orange, SFR, Bouygues). S'il est remis, c'est Free (2) ; s'il échoue aussi, c'est la carte ou son
provisionnement (1 ou 3) → ticket WhereverSIM avec les deux ICCID, ou remplacement des deux SIM par deux cartes du
stock (24 « Prête à activer » dans Tracky) et mise à jour du numéro sur les deux boîtiers.

Rien de tout cela ne dépend du code. Ce qui en dépend, c'est que **le système sache** qu'un véhicule n'a pas de
secours SMS et se comporte en conséquence — au lieu de le découvrir un matin à 07:00. C'est T62.

## 2. Ce qui change (T62, `engine-control.service.ts`)

| Où | Quoi |
|---|---|
| `smsReachability(numéro)` | Verdict lu dans `sms_logs` : les **3 derniers sortants à issue connue** vers ce numéro (`ENGINE_SMS_UNREACHABLE_STREAK`, fenêtre 30 jours) sont tous `failed` → **injoignable**. Les `queued` (issue inconnue) ne comptent pas ; `sent`, `delivered`, `received` rompent la série. Sans numéro, ou base illisible : joignable (on ne bloque pas toutes les coupes sur une panne de lecture). Cache 60 s. |
| Coupe **automatique** (`requestCommand`, SCHEDULER + CUT) | Si la SIM est injoignable, la coupe n'est émise que si le boîtier est **vivant en TCP maintenant** (socket présente et trame de moins de 5 min). Sinon `ForbiddenException` — le même **report** que « boîtier muet » : le cron retente avec son palier, et la coupe part quand le boîtier est connecté. Une coupe MANUELLE n'est pas concernée. |
| `trySmsFallback` | Une coupe **automatique** ne dépense pas un SMS vers une SIM injoignable (si la socket disparaît entre la garde et l'envoi : `FAILED` avec la raison, `ServiceUnavailableException` → report côté cron). Une action **manuelle** (antivol) tente sa chance — et, si elle passe, rompt la série d'échecs. |
| Worker RESTORE | Sur une SIM injoignable, sans SMS en vol : `K` renvoyée en TCP **toutes les 5 min** (`ENGINE_TCP_ONLY_RETRY_MIN`, au lieu de 30) et à chaque reconnexion (T42), **sans SMS** ; et **un SMS-sonde au plus toutes les 6 h** — s'il passe, la série est rompue et le secours SMS redevient normal. Coût borné : quatre SMS par jour et par véhicule bloqué, au pire. |
| Centre d'alerte | **Une ligne DÉGRADATION par véhicule et par jour** (`engine-control-tcp-only`) : « Véhicule X en TCP seul : sa SIM est injoignable par SMS (N échecs, dernier le …) — à traiter : test autre opérateur, ticket WhereverSIM, ou remplacement de la SIM ». |

Variables : `ENGINE_SMS_UNREACHABLE_STREAK=3`, `ENGINE_TCP_ONLY_RETRY_MIN=5` (`env.validation.ts`, `.env.example`,
`deploy/vps/.env.prod.example`, documents 13 et 25).

## 3. Ce que ce correctif garantit — et ne garantit pas

- Garanti : un véhicule dont la SIM ne reçoit pas les SMS **n'est jamais coupé automatiquement hors de portée du TCP**.
  S'il est coupé, c'est qu'il était connecté ; sa remise en route repart par TCP toutes les 5 min et dès la reconnexion.
- Garanti : plus un SMS dépensé pour rien par le planificateur vers ces SIM ; une sonde toutes les 6 h au plus.
- Garanti : le propriétaire le voit — une ligne par jour et par véhicule au centre d'alerte, avec les gestes à faire.
- **Non garanti** : un véhicule TCP seul dont le boîtier perd le réseau data **après** la coupe reste coupé jusqu'à sa
  reconnexion. C'est exactement le risque que le test « autre opérateur » puis le remplacement de SIM doivent fermer :
  T62 rend le risque visible et borné, il ne le supprime pas.
- Le verdict dépend de `sms_logs` **à jour** : il l'est dès que le relais pousse ses statuts (T45, cette même fusion).
  Avant T45, les statuts restaient `queued` et aucune SIM n'aurait été jugée injoignable — le correctif est donc inerte
  sans le relais du chantier, et c'est voulu (jamais « injoignable » sur une donnée absente).

## 4. Tests ajoutés (verts) — `engine-control.service.spec.ts` (+9, 148 au total)

Verdict (3 échecs = injoignable, un succès rompt, 2 échecs ne suffisent pas, `queued` exclus, sans numéro = joignable) ;
coupe automatique hors TCP → reportée, rien de persisté, une ligne DÉGRADATION par jour ; boîtier vivant → coupe en TCP
sans SMS ; socket disparue entre la garde et l'envoi → `FAILED` + report, aucun SMS ; coupe manuelle → tente le SMS ;
worker : TCP toutes les 5 min sans SMS, `K` immédiate à la reconnexion, sonde SMS après 6 h ; base illisible → joignable.
