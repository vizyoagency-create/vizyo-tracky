# 30 — Correctif P2-3 (T50) : la confirmation par glissement est un geste, pas un clic

Date : 14 septembre 2026
Branche : Tracky `codex/tracky-cutoff-reliability-2026-09-12`
Production : **aucun changement** — code écrit, testé et committé, non déployé.

## Le défaut corrigé (document 19, P2-3)

Le document 16 promettait qu'une coupure « ne peut pas être déclenchée accidentellement ». La
saisie de plaque le tenait ; le glissement, non : un `<input type="range">` natif **saute au point
cliqué**. Un clic en bout de piste, ou la touche `Fin` (`End`, `PageUp`), produisait `change` à
100 → `onConfirm()` — une coupure moteur sans le moindre geste continu. Le test du composant
fixait la valeur programmatiquement (`slider.value = '100'`) et ne pouvait pas le voir.

## Ce qui change (`confirm-modal.component.ts`)

| Quoi | Détail |
|---|---|
| `gesteVolontaire()` | La confirmation exige au moins **8 valeurs `input` strictement croissantes**, la première **sous 10**, la dernière **≥ 98**. Un doigt qui glisse en produit des dizaines ; une flèche droite **maintenue** aussi (une valeur par répétition) — le clavier reste un chemin valide. Un clic, un `Fin`, un `Page suivante` n'en produisent qu'une : rien ne part, le curseur revient à 0 (signal **et** contrôle natif). |
| Retours en arrière | Un pouce qui tremble (valeur qui recule) ne compte pas mais n'annule rien. |
| `keydown` | `End`, `Home`, `PageUp`, `PageDown` sont neutralisées (`preventDefault`). |
| Accessibilité | `aria-description` : « Faites glisser jusqu'au bout, ou maintenez la flèche droite ; les touches Fin et Page suivante sont sans effet. » |

Le document 19 proposait aussi d'exiger un `pointerdown` : écarté, parce qu'il aurait fermé le
chemin clavier ; la progression continue suffit à distinguer un geste d'un saut.

## Tests (verts, et rouges avant)

`confirm-modal.component.spec.ts` : le test existant devient un vrai geste
(`[2, 11, 23, 36, 48, 61, 74, 87, 95, 100]` → confirmé une fois) ; +5 : clic à 100 → rien, curseur
à `0` ; départ du milieu → rien ; `Fin/Début/Page` neutralisées ; flèche maintenue 1→100 →
confirmé une fois ; tremblement → confirmé une fois. **Rejoués contre l'ancien composant : 3
rouges** (clic à 100, départ du milieu, touches) — le défaut était bien là. Suite web : 732/732.
