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
  DIMENSIONNEMENT : assez de places-enfant pour le nombre d'enfants demandé, SANS surdimensionner
  (ne pas mobiliser un 9 places pour 2 enfants si un véhicule plus juste existe).
- PARCELS : colis. Priorise la capacité de charge / le volume (déduits du type et des features).
- RENTAL : location. Priorise la disponibilité ; évite de bloquer un véhicule très demandé si une
  alternative équivalente existe.
- GENERIC : optimise mutualisation + adéquation simple.

CRITÈRES DE CLASSEMENT (du plus au moins important) :
1. ADÉQUATION au besoin (places / places-enfant / équipements requis). Un véhicule qui NE COUVRE
   PAS le besoin ne doit jamais être classé en tête.
2. BON DIMENSIONNEMENT : le plus « juste » possible (éviter le gâchis d'un grand véhicule pour un
   petit besoin).
3. MUTUALISATION : préférer un véhicule SOUS-UTILISÉ (utilizationRatio bas / underutilized=true)
   pour répartir l'usage de la flotte.
4. À adéquation égale, éviter un véhicule dont la prévision indique un usage récurrent fort sur ce
   créneau (forecastBusy=true).

Pour chaque candidat, donne :
- "vehicleId" (repris tel quel),
- "score" dans [0,1] (1 = idéal),
- "reasoning" : UNE phrase FR concrète (« 8 places-enfant, sous-utilisé → idéal pour 7 enfants »).
Classe du meilleur au moins bon.

Si AUCUN candidat ne couvre correctement le besoin, mets "noGoodMatch"=true et explique dans
"notes" (ex. « besoin de 8 places-enfant, maximum disponible = 5 »).

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
    "criteria": { "minSeats": 8, "minChildSeats": 7 }
  },
  "candidates": [
    { "vehicleId": "v3", "plate": "GA-103-CD", "seats": 9, "childSeats": 8, "features": ["porte latérale coulissante"], "utilizationRatio": 0.06, "underutilized": true,  "forecastBusy": false },
    { "vehicleId": "v5", "plate": "GA-105-CD", "seats": 9, "childSeats": 8, "features": ["climatisation"],             "utilizationRatio": 0.41, "underutilized": false, "forecastBusy": true  },
    { "vehicleId": "v1", "plate": "GA-101-CD", "seats": 5, "childSeats": 3, "features": [],                            "utilizationRatio": 0.10, "underutilized": true,  "forecastBusy": false }
  ],
  "fleetSummary": { "totalVehicles": 6, "underutilizedCount": 3, "avgUtilization": 0.22 }
}
```

## Sortie attendue (forme indicative)

```json
{
  "proposals": [
    { "vehicleId": "v3", "score": 0.95, "reasoning": "8 places-enfant (besoin 7), sous-utilisé (6 %) → idéal et favorise la mutualisation." },
    { "vehicleId": "v5", "score": 0.7,  "reasoning": "8 places-enfant, couvre le besoin, mais déjà bien utilisé et usage récurrent prévu sur ce créneau." }
  ],
  "noGoodMatch": false,
  "notes": "v1 (3 places-enfant) écarté : ne couvre pas les 7 enfants."
}
```

L'IA doit **écarter v1** (sous-dimensionné) et **préférer v3** (juste + sous-utilisé) à v5
(suffisant mais déjà sollicité). C'est la mutualisation + le bon dimensionnement attendus.
