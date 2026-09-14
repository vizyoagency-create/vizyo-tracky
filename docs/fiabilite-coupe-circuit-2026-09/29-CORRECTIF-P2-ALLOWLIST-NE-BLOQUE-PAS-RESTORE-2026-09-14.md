# 29 — Correctif P2-9 (T52) : l'allowlist du relais ne bloque plus une remise en route

Date : 14 septembre 2026
Branche : Tracky `codex/tracky-cutoff-reliability-2026-09-12`
Production : **aucun changement** — code écrit, testé et committé, non déployé.

## Le défaut corrigé (document 19, P2-9)

Le relais refuse (`403`) tout destinataire hors de son allowlist — une garde anti-spam
nécessaire. Mais Tracky comptait ce `403` comme un refus de soumission ordinaire : trois fois,
puis plus aucun SMS. Un boîtier dont la SIM avait été saisie avant l'auto-synchronisation, ou
pendant une panne du relais, était donc **impossible à rallumer par SMS** — la garde d'un tiers
se retrouvait sur le chemin de la restauration.

## Ce qui change

| Où | Quoi |
|---|---|
| `SmsGatewayService.sendViaVizyoTexto` | Sur un `403` dont le message contient « allowlist », pour un envoi `priority = critical_restore` : le numéro du boîtier est **ajouté à l'allowlist** du relais (`AllowlistService.add`, motif « RESTORE <imei> — ajout automatique (T52) »), l'envoi est **retenté une fois**, et une ligne « Allowlist du relais incomplète : <numéro> ajouté à la volée… » (phase `allowlist-self-heal`) dit que la synchronisation avait manqué ce boîtier. Aucune ligne « failed » pour le `403` réparé. |
| Portée | Une **COUPURE** hors allowlist reste refusée (la garde garde son sens) ; un ajout impossible retombe sur l'échec ordinaire ; sans `AllowlistService` injecté (`@Optional`), comportement d'avant. |
| Santé par appareil (`deviceId`, `simCards`) | L'autre moitié de T52 est faite par T44 côté relais (document 23). |

Le relais ne change pas : c'est Tracky — seul détenteur de la clé d'allowlist — qui répare la
sienne.

## Ce que ce correctif garantit — et ne garantit pas

- Garanti : une RESTORE n'est jamais bloquée par l'allowlist du relais ; l'écart est réparé et
  signalé.
- Non garanti : un `403` d'une autre nature (jeton, IP) n'est pas réparé — il reste un échec
  ordinaire, alerté comme avant.

## Tests ajoutés (verts)

`sms-gateway.service.spec.ts` (+5) : 403 allowlist sur RESTORE → ajout + nouvel essai réussi,
une seule ligne d'information ; 403 sur CUT → refus inchangé ; ajout impossible → échec
ordinaire ; second 403 après ajout → échec (une seule relance) ; sans AllowlistService → échec
d'avant.
