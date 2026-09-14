# 27 — Correctif P2-1 · P2-4 (T48) : une preuve ne se rétrograde jamais, une CUT orpheline est dispatchée

Date : 14 septembre 2026
Branche : Tracky `codex/tracky-cutoff-reliability-2026-09-12`
Production : **aucun changement** — code écrit, testé et committé, non déployé.

## Les défauts corrigés (document 19, P2-1 et P2-4)

**P2-1 — l'écriture « envoyée » écrasait une preuve.** Les trois écritures « envoyée » (SMS
initial, TCP, SMS du worker) passaient par `update({ where: { id } })` sans condition. Un écho
`K` arrivé pendant l'envoi du SMS de secours, ou une supplantation survenue entre la création et
le dispatch, étaient recouverts : la ligne repassait `SENT` avec `ackedAt` renseigné, l'écran
disait « rallumage non confirmé » alors que le boîtier avait acquitté — et le SMS parti pour rien
restait en file sur le téléphone.

**P2-4 — une CUT créée puis jamais transmise gardait sa clé.** Après un arrêt de l'API entre
`create` et l'envoi, l'intention restait `PENDING` avec son `activeKey`. La coupure antivol
suivante tombait sur l'unicité, recevait `201` avec cette vieille ligne… et rien ne partait.

## Ce qui change

| Où | Quoi |
|---|---|
| `writeSent` (`engine-control.service.ts`) | Les trois écritures « envoyée » deviennent **conditionnelles** : `updateMany` sous `ackedAt IS NULL AND status IN (PENDING, SENT)`. Si la condition ne tient plus, la ligne est **relue** et rendue telle quelle (jamais fabriquée), et le SMS accepté pour rien est **annulé au relais** (chemin T41, best-effort). |
| Acquittement par écho TCP | Conditionnel lui aussi (`ackedAt IS NULL`) : un second écho ne réécrit pas `ackedAt`, un acquittement posé par un autre chemin (accusé SMS, ignition) n'est pas horodaté deux fois. L'état émis au frontal est celui **relu en base**. |
| `isOrphanPending` | À la collision d'unicité, une intention `PENDING`, non acquittée, **hors bail** et **plus vieille que le bail de dispatch** (60 s) est **dispatchée** au lieu d'être rendue telle quelle. Un clic concurrent (jeune) ou une intention **sous bail** (le worker la traite) restent rendus tels quels : ce n'est pas un orphelin, c'est un travail en cours. |

Pourquoi « plus vieille que le bail » et pas « plus vieille que 5 s » : le bail est la seule
durée pendant laquelle quelqu'un peut légitimement être en train de dispatcher la ligne ; au-delà,
personne ne la tient plus, par construction.

## Ce que ce correctif garantit — et ne garantit pas

- Garanti : une commande acquittée ne redevient jamais « envoyée », quel que soit l'ordre
  d'arrivée des écritures ; un SMS devenu inutile est demandé en annulation.
- Garanti : une CUT orpheline est transmise à la demande suivante, pas rendue comme un succès.
- Non garanti : l'annulation effective du SMS côté téléphone dépend de la version du serveur
  capcom6 (≥ 1.45.0, document 25 §2) — avant, l'annulation est refusée et le SMS part ; il est
  alors sans effet sur un boîtier déjà rallumé (`resume` idempotent).

## Tests ajoutés (verts)

`engine-control.service.spec.ts` (+5, 3 assertions migrées vers `updateMany`) : ACK arrivé
pendant l'envoi SMS → aucune écriture aveugle, SMS annulé, état émis = acquittée ; orpheline
dispatchée ; concurrente rendue telle quelle ; sous bail rendue telle quelle ; second écho
conditionnel.
