# Logos des marques de véhicules

Déposer ici les logos PNG des marques, **un fichier par marque**, nommés
exactement d'après le `slug` défini dans
[`vehicle-brands.ts`](../../../src/app/shared/utils/vehicle-brands.ts).

## Format attendu

- **PNG** à fond **transparent**
- carré, idéalement **256×256 px** (affiché de 16 à 64 px selon l'emplacement)
- logo centré avec une petite marge interne

## Noms de fichiers (slug.png)

| Marque         | Fichier               |
| -------------- | --------------------- |
| Alfa Romeo     | `alfa-romeo.png`      |
| Audi           | `audi.png`            |
| Audi RS3       | `audi-rs3.png`        |
| BMW            | `bmw.png`             |
| Citroën        | `citroen.png`         |
| Dacia          | `dacia.png`           |
| DS             | `ds.png`              |
| Fiat           | `fiat.png`            |
| Honda          | `honda.png`           |
| Hyundai        | `hyundai.png`         |
| Isuzu          | `isuzu.png`           |
| Iveco          | `iveco.png`           |
| Jeep           | `jeep.png`            |
| Kia            | `kia.png`             |
| Land Rover     | `land-rover.png`      |
| MAN            | `man.png`             |
| Mazda          | `mazda.png`           |
| Mercedes-Benz  | `mercedes.png`        |
| Mini           | `mini.png`            |
| Mitsubishi     | `mitsubishi.png`      |
| Nissan         | `nissan.png`          |
| Opel           | `opel.png`            |
| Peugeot        | `peugeot.png`         |
| Porsche        | `porsche.png`         |
| Renault        | `renault.png`         |
| Renault (ancien) | `renault-old.png`   |
| Renault Trucks | `renault-trucks.png`  |
| Scania         | `scania.png`          |
| SEAT           | `seat.png`            |
| Škoda          | `skoda.png`           |
| Suzuki         | `suzuki.png`          |
| Tesla          | `tesla.png`           |
| Toyota         | `toyota.png`          |
| Volkswagen     | `volkswagen.png`      |
| Volvo          | `volvo.png`           |

## Logos à tracé clair / blanc

Un logo dont le tracé est clair (ex. badge Audi RS3) serait invisible sur la
pastille blanche. Mettre `darkBg: true` sur la marque dans `vehicle-brands.ts` :
il s'affichera alors sur pastille **sombre**.

## Ajouter une nouvelle marque

1. Ajouter une ligne dans `VEHICLE_BRANDS` (`vehicle-brands.ts`).
2. Déposer le PNG ici en respectant le `slug` choisi.

Une marque sans fichier (ou un véhicule dont la marque est inconnue) retombe
automatiquement sur l'icône de type de véhicule — rien ne casse.
