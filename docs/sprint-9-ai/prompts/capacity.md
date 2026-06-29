# Prompt pack — Capacité 1 : enrichissement de capacité (CDEF d'abord)

**But.** Pour chaque véhicule (marque / modèle / énergie / type), l'IA **propose** le nombre de
places, le nombre de places-enfant et des équipements probables — avec **confiance + justification**.
C'est ce qui débloque CDEF (« Jumpy 9 vs 2 places »). Résultat **à valider par un humain**.

## Comment tester dans la Console Anthropic

1. Modèle : **`claude-opus-4-8`**. Thinking : **adaptive**. Effort : **high**.
2. Colle le **System prompt** ci-dessous dans le champ *System*.
3. Colle le **payload utilisateur** (JSON) comme message *User*.
4. (Optionnel mais recommandé) active la **sortie structurée** avec le *schéma JSON* ci-dessous,
   sinon le prompt demande déjà du JSON pur que tu peux relire à l'œil.
5. Juge la qualité (places correctes ? incertitude bien signalée ?), itère le system prompt.

> Le system prompt et le schéma ci-dessous sont la **source unique** : ils seront repris tels quels
> par le backend (`apps/api/src/ai/prompts.ts`).

---

## System prompt

```
Tu es un expert du parc automobile français. Tu aides une société de gestion de flotte
(Tracky) à compléter les CARACTÉRISTIQUES DE CAPACITÉ de ses véhicules.

Pour chaque véhicule fourni (marque, modèle, énergie, type), propose :
- "seats"      : nombre TOTAL de places assises homologuées, CONDUCTEUR INCLUS ;
- "childSeats" : nombre de places où l'on peut installer un siège/rehausseur enfant
                 (places arrière à ceinture 3 points ; jamais la place conducteur ;
                 un utilitaire 2 places sans banquette arrière = 0) ;
- "features"   : étiquettes courtes et utiles, déductibles du modèle
                 (ex. "climatisation", "porte latérale coulissante", "plancher bas", "PMR") ;
- "confidence" : ta certitude dans [0,1] ;
- "reasoning"  : UNE phrase en français qui justifie (modèle → version → places).

CONTEXTE MÉTIER de la flotte = {{METIER}}.
- CHILDREN_TRANSPORT : la flotte TRANSPORTE DES ENFANTS. Le nombre de places et surtout de
  places-enfant est CRITIQUE (sécurité). Un même modèle peut exister en version « fourgon »
  (2–3 places) ou « navette / Traveller / Combi / Life » (8–9 places) : sers-toi de l'énergie,
  du type et du contexte pour trancher, et BAISSE ta confiance si c'est ambigu.
- PARCELS : transport de colis. Les places importent peu ; déduis plutôt le volume utile.
- RENTAL / GENERIC : véhicules standards.

RÈGLES IMPORTANTES :
1. Raisonne par modèle réel du marché français (Citroën Jumpy/ë-Jumpy, Peugeot Expert/Traveller,
   Renault Kangoo/Trafic/Master, Citroën C3, Renault Clio, etc.).
2. Si la variante est AMBIGUË (fourgon vs navette), propose l'hypothèse la plus probable POUR CE
   MÉTIER, mais mets "confidence" ≤ 0.5 et explique l'incertitude dans "reasoning".
3. confidence : 1.0 = modèle non ambigu ; ~0.5 = variante incertaine ; < 0.3 = simple supposition.
4. N'invente PAS d'équipement non déductible du modèle. Pas d'option spécifique inconnue.
5. Une incertitude HONNÊTE vaut mieux qu'un chiffre faux : l'humain validera tes propositions.
6. Réponds pour chaque "vehicleId" reçu, sans en omettre ni en inventer.

Renvoie UNIQUEMENT un objet JSON conforme au schéma. Aucun texte hors du JSON.
```

`{{METIER}}` est remplacé par le métier de la flotte (ex. `CHILDREN_TRANSPORT`).

---

## Schéma de sortie (JSON Schema — pour la sortie structurée)

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["proposals"],
  "properties": {
    "proposals": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["vehicleId", "seats", "childSeats", "features", "confidence", "reasoning"],
        "properties": {
          "vehicleId": { "type": "string" },
          "seats": { "anyOf": [{ "type": "integer" }, { "type": "null" }] },
          "childSeats": { "anyOf": [{ "type": "integer" }, { "type": "null" }] },
          "features": { "type": "array", "items": { "type": "string" } },
          "confidence": { "type": "number" },
          "reasoning": { "type": "string" }
        }
      }
    }
  }
}
```

---

## Payload utilisateur d'exemple (parc CDEF réaliste)

```json
{
  "metier": "CHILDREN_TRANSPORT",
  "fleetContext": "CDEF 31 — transport d'enfants (placements, écoles, rendez-vous).",
  "vehicles": [
    { "vehicleId": "v1", "plate": "GA-101-CD", "type": "CAR", "brand": "Renault",  "model": "Kangoo",            "energy": "DIESEL" },
    { "vehicleId": "v2", "plate": "GA-102-CD", "type": "CAR", "brand": "Renault",  "model": "Clio IV",           "energy": "ESSENCE" },
    { "vehicleId": "v3", "plate": "GA-103-CD", "type": "VAN", "brand": "Citroën",  "model": "ë-Jumpy",           "energy": "ELECTRIQUE" },
    { "vehicleId": "v4", "plate": "GA-104-CD", "type": "VAN", "brand": "Citroën",  "model": "Jumpy II (HDi)",    "energy": "DIESEL" },
    { "vehicleId": "v5", "plate": "GA-105-CD", "type": "VAN", "brand": "Peugeot",  "model": "Expert/Traveller III","energy": "DIESEL" },
    { "vehicleId": "v6", "plate": "GA-106-CD", "type": "CAR", "brand": "Citroën",  "model": "C3 III (PureTech)", "energy": "ESSENCE" }
  ]
}
```

## Sortie attendue (forme indicative — à juger à l'œil)

```json
{
  "proposals": [
    { "vehicleId": "v1", "seats": 5, "childSeats": 3, "features": ["porte latérale coulissante"], "confidence": 0.8, "reasoning": "Kangoo familial : 5 places, banquette arrière 3 places-enfant." },
    { "vehicleId": "v2", "seats": 5, "childSeats": 3, "features": ["climatisation"], "confidence": 0.9, "reasoning": "Clio IV : citadine 5 places, 3 places-enfant à l'arrière." },
    { "vehicleId": "v3", "seats": 9, "childSeats": 6, "features": ["porte latérale coulissante", "plancher bas"], "confidence": 0.5, "reasoning": "ë-Jumpy électrique : probable navette 8–9 places, mais existe en fourgon — confiance modérée." },
    { "vehicleId": "v4", "seats": 3, "childSeats": 0, "features": ["porte latérale coulissante"], "confidence": 0.45, "reasoning": "Jumpy II HDi : très probablement fourgon 2–3 places (0 place-enfant) ; à confirmer." },
    { "vehicleId": "v5", "seats": 9, "childSeats": 6, "features": ["climatisation"], "confidence": 0.55, "reasoning": "Expert/Traveller : si version Traveller, 8–9 places ; si fourgon Expert, 3 places — confiance modérée." },
    { "vehicleId": "v6", "seats": 5, "childSeats": 3, "features": ["climatisation"], "confidence": 0.9, "reasoning": "C3 : citadine 5 places, 3 places-enfant à l'arrière." }
  ]
}
```

Les valeurs exactes dépendent du modèle ; ce qui compte = **bonnes places quand c'est clair**, et
**confiance basse + raison explicite quand c'est ambigu** (Jumpy/Expert). L'humain tranche ensuite.
