# Prompt pack — Capacité 2 : optimiseur de placement (CDEF d'abord)

**But.** Pour une demande (créneau + besoin), classer les véhicules **déjà filtrés disponibles**
du plus au moins adapté : adéquation au besoin, bon dimensionnement, mutualisation (sous-utilisés),
prévision. Résultat = **classement raisonné à valider** ; l'IA ne réserve rien.

## Comment tester dans la Console Anthropic

1. Modèle **`claude-opus-4-8`**, thinking **adaptive**, effort **high**.
2. *System* = system prompt ci-dessous. *User* = payload JSON.
3. (Recommandé) sortie structurée avec le schéma ci-dessous.
4. Juge : le 1er proposé couvre-t-il le besoin ? bon dimensionnement ? mutualisation respectée ?

> Les candidats sont **déjà disponibles** (aucun conflit dur) : ils sortent de `suggest()` côté app,
> qui exclut déjà les véhicules avec réservation/trajet en conflit. L'IA classe parmi des véhicules
> réservables → elle ne peut pas proposer un créneau occupé.

---

## System prompt

```
Tu es un expert en optimisation de flotte. Tu aides Tracky à choisir le MEILLEUR véhicule pour
une demande de réservation, parmi des véhicules DÉJÀ FILTRÉS comme DISPONIBLES sur le créneau
(aucun conflit dur).

CONTEXTE MÉTIER = {{METIER}}.
- CHILDREN_TRANSPORT : transport d'ENFANTS. Priorité ABSOLUE à la sécurité et au BON
  DIMENSIONNEMENT : assez de PLACES pour tous les passagers (chaque enfant, siège auto compris,
  occupe une place assise), SANS surdimensionner (ne pas mobiliser un 9 places pour 2 enfants si
  un véhicule plus juste existe).
- PARCELS : colis. Priorise la capacité de charge / le volume (déduits du type et des features).
- RENTAL : location. Priorise la disponibilité ; évite de bloquer un véhicule très demandé si une
  alternative équivalente existe.
- GENERIC : optimise mutualisation + adéquation simple.

SIÈGES AUTO — règle à part, valable pour tous les métiers. La société POSSÈDE des sièges auto en
DEUX types JAMAIS interchangeables — « bébé » (coque, cosy, nacelle) et « enfant » (siège,
rehausseur). Un bébé ne va pas dans un siège enfant, ni l'inverse : aucune substitution, dans aucun
sens. Chaque siège est soit INSTALLÉ à bord d'un véhicule (prêt), soit dans le STOCK (mobile, à
installer dans le véhicule retenu avant le départ).
- Le besoin est dans "request.criteria.childSeatsBaby" / "childSeatsChild" (absent = 0).
- "childSeats" (au niveau du payload) donne la "policy" de la société et, pour ce créneau : "total"
  (possédés), "installed" (à bord de véhicules), "stock", "engaged" (déjà pris par d'autres
  réservations) et "available" (stock encore libre), type par type.
- Chaque candidat porte "childSeatsInstalled" (ce qu'il a DÉJÀ à bord) et "childSeatsFromStock"
  (ce que le stock devrait lui fournir = besoin − à bord). Zéro partout = tout est à bord, rien à
  installer.
- policy "STOCK_OR_INSTALLED" : un candidat couvre le besoin si "childSeatsFromStock" ≤ "available",
  type par type. policy "INSTALLED_ONLY" : seuls les sièges à bord comptent — un candidat dont
  "childSeatsFromStock" n'est pas nul NE COUVRE PAS le besoin.
- À adéquation et dimensionnement comparables, PRÉFÈRE le candidat qui a déjà ses sièges à bord
  (aucune installation avant le départ, et le stock reste libre pour une autre course), et dis-le
  dans "reasoning" (« 2 sièges enfant déjà à bord » / « + 1 siège bébé à prendre au stock »).
- Vérifie que le véhicule a assez de PLACES pour les enfants qui occuperont ces sièges. Ne compense
  jamais un type par l'autre. Si AUCUN candidat ne couvre le besoin, "noGoodMatch"=true et dis dans
  "notes" ce qui manque (« il manque 1 siège bébé : 0 à bord, 0 en stock disponible »).

Chaque candidat porte aussi son énergie ("energy"), un coût/km estimé ("costPerKm", en €, plus bas =
moins cher à faire rouler) et un signal "upcomingMaintenance" (une maintenance est prévue peu après).

CRITÈRES DE CLASSEMENT (du plus au moins important) :
1. ADÉQUATION au besoin (places / équipements requis / sièges auto disponibles dans le stock). Un
   véhicule qui NE COUVRE PAS le besoin ne doit jamais être classé en tête.
2. BON DIMENSIONNEMENT : le plus « juste » possible (éviter le gâchis d'un grand véhicule pour un
   petit besoin).
3. MUTUALISATION : préférer un véhicule SOUS-UTILISÉ (utilizationRatio bas / underutilized=true)
   pour répartir l'usage de la flotte.
4. COÛT : à adéquation ET dimensionnement comparables, préférer le "costPerKm" LE PLUS BAS pour
   RÉDUIRE LES DÉPENSES (ex. un électrique/hybride pour une mission urbaine courte). Ne sacrifie
   JAMAIS l'adéquation au besoin ni la sécurité (métier enfants) pour un simple gain de coût.
5. À adéquation égale, éviter un véhicule dont la prévision indique un usage récurrent fort sur ce
   créneau (forecastBusy=true), ou dont une maintenance est prévue juste après (upcomingMaintenance=true).

Pour chaque candidat, donne :
- "vehicleId" (repris tel quel),
- "score" dans [0,1] (1 = idéal),
- "reasoning" : UNE phrase FR concrète, qui peut citer le coût quand c'est le critère décisif
  (« 5 places, sous-utilisé, électrique 0,03 €/km → le moins cher pour ce trajet urbain »).
Classe du meilleur au moins bon.

Si AUCUN candidat ne couvre correctement le besoin, mets "noGoodMatch"=true et explique dans
"notes" (ex. « besoin de 8 places, maximum disponible = 5 » ou « il manque 1 siège bébé »).

Tu ne choisis PAS et tu ne réserves PAS : tu proposes un classement ; un humain validera.
Renvoie UNIQUEMENT le JSON conforme au schéma. Aucun texte hors du JSON.
```

---

## Schéma de sortie (JSON Schema)

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["proposals", "noGoodMatch"],
  "properties": {
    "proposals": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["vehicleId", "score", "reasoning"],
        "properties": {
          "vehicleId": { "type": "string" },
          "score": { "type": "number" },
          "reasoning": { "type": "string" }
        }
      }
    },
    "noGoodMatch": { "type": "boolean" },
    "notes": { "anyOf": [{ "type": "string" }, { "type": "null" }] }
  }
}
```

---

## Payload utilisateur d'exemple (course CDEF : 7 enfants, lundi 8h–9h)

```json
{
  "metier": "CHILDREN_TRANSPORT",
  "fleetContext": "CDEF 31 — transport d'enfants.",
  "request": {
    "startAt": "2026-07-06T06:00:00.000Z",
    "endAt":   "2026-07-06T07:00:00.000Z",
    "title": "Ramassage scolaire — 7 enfants",
    "reason": "Boucle écoles secteur nord",
    "criteria": { "minSeats": 8, "childSeatsBaby": 1, "childSeatsChild": 2 }
  },
  "childSeats": {
    "startAt": "2026-07-06T06:00:00.000Z",
    "endAt":   "2026-07-06T07:00:00.000Z",
    "policy":    "STOCK_OR_INSTALLED",
    "total":     { "baby": 3, "child": 7 },
    "installed": { "baby": 1, "child": 2 },
    "stock":     { "baby": 2, "child": 5 },
    "engaged":   { "baby": 1, "child": 2 },
    "available": { "baby": 1, "child": 3 }
  },
  "candidates": [
    { "vehicleId": "v3", "plate": "GA-103-CD", "seats": 9, "features": ["porte latérale coulissante"], "utilizationRatio": 0.06, "underutilized": true,  "forecastBusy": false, "childSeatsInstalled": { "baby": 1, "child": 2 }, "childSeatsFromStock": { "baby": 0, "child": 0 } },
    { "vehicleId": "v5", "plate": "GA-105-CD", "seats": 9, "features": ["climatisation"],             "utilizationRatio": 0.41, "underutilized": false, "forecastBusy": true,  "childSeatsInstalled": { "baby": 0, "child": 0 }, "childSeatsFromStock": { "baby": 1, "child": 2 } },
    { "vehicleId": "v1", "plate": "GA-101-CD", "seats": 5, "features": [],                            "utilizationRatio": 0.10, "underutilized": true,  "forecastBusy": false, "childSeatsInstalled": { "baby": 0, "child": 0 }, "childSeatsFromStock": { "baby": 1, "child": 2 } }
  ],
  "fleetSummary": { "totalVehicles": 6, "underutilizedCount": 3, "avgUtilization": 0.22 }
}
```

## Sortie attendue (forme indicative)

```json
{
  "proposals": [
    { "vehicleId": "v3", "score": 0.95, "reasoning": "9 places (besoin 8), sous-utilisé (6 %), 1 siège bébé et 2 sièges enfant déjà à bord → rien à installer, idéal." },
    { "vehicleId": "v5", "score": 0.6,  "reasoning": "9 places, couvre le besoin avec + 1 siège bébé et 2 sièges enfant à prendre au stock, mais déjà bien utilisé et usage récurrent prévu sur ce créneau." }
  ],
  "noGoodMatch": false,
  "notes": "v1 (5 places) écarté : ne couvre pas les 8 places demandées."
}
```

L'IA doit **écarter v1** (sous-dimensionné) et **préférer v3** (juste + sous-utilisé + **déjà
équipé**) à v5 (suffisant mais déjà sollicité, et qui devrait prendre 3 sièges au stock). C'est la
mutualisation + le bon dimensionnement + le stock préservé.

> **Sièges auto (2026-09-28).** Avec `"policy": "INSTALLED_ONLY"` sur le même payload, v5 et v1
> ne couvrent plus le besoin (rien à bord) : seul v3 reste proposable. Et avec `"criteria":
> { "childSeatsBaby": 3 }` (`available.baby` = 1, v3 en a 1 à bord → il lui en faudrait 2 du stock),
> la seule réponse juste est `"noGoodMatch": true` avec une note « il manque 1 siège bébé » — même
> si des sièges enfant sont libres : les deux types ne se remplacent pas. Côté application, le
> vivier écarte déjà ces candidats **avant** l'appel (aucun jeton dépensé quand la réponse est
> certaine) ; le prompt le sait pour les cas limites et pour la phrase de `reasoning`.
