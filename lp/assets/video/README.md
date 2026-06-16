# Vidéos de l'interface — specs & mode d'emploi

Place ici tes vidéos de démo de l'app. Le site les affiche dans des cadres déjà prévus.

## Format recommandé
- **Ratio** : 16:9 (desktop) → 1920×1080. Vue mobile → 9:16 (1080×1920).
- **Durée** : 15–30 s, en boucle (pas de son nécessaire, les vidéos sont muettes).
- **Encodage** : fournir **2 fichiers** par vidéo pour la compatibilité :
  - `.webm` (VP9 ou AV1) — léger, navigateurs modernes
  - `.mp4` (H.264 + AAC) — universel
- **Poids** : viser **≤ 3–5 Mo** par fichier (compresser ; ce ne sont pas des films).
- **Poster** : une image `.jpg` (1ʳᵉ frame) affichée avant lecture.

## Fichiers attendus (un jeu .webm + .mp4 + .jpg par emplacement)
| Emplacement (page) | `data-video` | Ce qu'on doit voir |
|---|---|---|
| Accueil — démo | `feat-demo` | Tour rapide de l'app (carte + dashboard) |
| Fonctionnalités | `feat-temps-reel` | Carte qui suit un véhicule en direct |
| Fonctionnalités | `feat-coupure` | Coupure moteur / réglage des plages horaires |
| Fonctionnalités | `feat-historique` | Rejeu d'un trajet, arrêts, kilomètres |
| Fonctionnalités | `feat-alertes` | Réception d'une alerte (vitesse / zone) |
| Fonctionnalités | `feat-dashboard` | Dashboard multi-véhicules + rapport |

Exemple de noms : `feat-temps-reel.webm`, `feat-temps-reel.mp4`, `feat-temps-reel.jpg`.

## Activer une vidéo sur le site
Dans le fichier source de la page (`pages/<page>.html`), remplace le bloc poster :

```html
<img class="vposter" src="screen-map.png" ...>
```
par le lecteur vidéo :
```html
<video class="vposter" poster="assets/video/feat-temps-reel.jpg" muted loop playsinline preload="none">
  <source src="assets/video/feat-temps-reel.webm" type="video/webm">
  <source src="assets/video/feat-temps-reel.mp4" type="video/mp4">
</video>
```
puis lance `node build.mjs`. Le bouton ▶ lira la vidéo ; tant qu'aucune vidéo n'est posée, le clic ouvre le formulaire de démo.
