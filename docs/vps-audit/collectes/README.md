# Sorties brutes de collecte

Une sortie par passage, telle que `collecte.sh` l'a produite, sans retouche.

## Pourquoi ce dossier existe

Angle mort n° 1 du rapport du **2026-08-07**, et il avait déjà coûté : le collecteur affichait
`wire_logs` à 242 Mo **à chaque passage** depuis le premier jour, et aucun rapport ne l'avait
commentée. Le jour où la question s'est posée — *depuis quand pèse-t-elle 242 Mo ?* — la réponse
était perdue, parce que **seuls les rapports étaient archivés, jamais les mesures**.

Une mesure affichée mais non commentée n'est pas une mesure perdue : c'est une mesure qu'on
pourra relire quand la bonne question se posera. Encore faut-il l'avoir gardée.

## Le coût

~30 Ko par passage, **zéro** pour le VPS : le fichier existe déjà côté poste à la fin de la
collecte, on le copie. Trente passages tiennent dans un mégaoctet.

## Rétention

Garder les **30 derniers**. Au-delà, la tendance longue vit dans les `chiffres` des `passages`
du manifeste (`app/wiki.json`), qui sont faits pour ça.

## À lire avec la même prudence que le reste

Une sortie de collecte porte les défauts du collecteur **du jour où elle a été prise**. Les
lignes d'un vieux fichier peuvent donc être fausses d'une manière déjà corrigée depuis — le
référentiel `VPS-M*` dit laquelle. Deux exemples qui concernent les fichiers de ce dossier :

- avant le 2026-08-08, la colonne `vivantes` était présentée comme un comptage alors que c'est
  un **estimé** à ±2 % (VPS-M20) ;
- avant le 2026-08-08, la section « processus de l'HÔTE » incluait en réalité les processus des
  **conteneurs** (VPS-M19).
