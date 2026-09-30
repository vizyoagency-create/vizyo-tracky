# Charte Tracky — les valeurs réelles du produit

> Extraites de `apps/web/src/styles.css`. Ce ne sont pas des suggestions : ce sont les couleurs
> et les polices que le client voit tous les jours dans l'application. La fiche doit avoir l'air
> de venir du même endroit.

## Police

**Manrope** — utilisée pour les titres comme pour le texte courant.

```html
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&display=swap" rel="stylesheet">
```

Graisses utilisées dans le produit : 400 (texte), 600 (accent), 700–800 (titres).

## Couleurs — thème CLAIR (celui de la fiche imprimée)

| Rôle | Valeur | Usage |
|---|---|---|
| Accent Tracky | `#0A9E6C` | titres de section, numéro, éléments actifs |
| Accent foncé | `#047857` | survol, texte sur fond clair accentué |
| Fond | `#FBFCFB` | fond de page (proche du blanc, jamais blanc pur) |
| Texte principal | `#0A1311` | titres et corps |
| Texte secondaire | `#56635E` | explications, mentions « pourquoi » |

## Couleurs — thème SOMBRE (pour la variante écran, plus tard)

| Rôle | Valeur |
|---|---|
| Accent Tracky | `#10e0a0` |
| Fond | `#080B0A` |
| Texte principal | `#EAEFED` |
| Texte secondaire | `#9BA5A1` |

## Pour l'encadré « ce qu'il ne faut pas faire »

Le produit n'a pas de rouge de marque. Utilise un **ambre sobre** plutôt qu'un rouge d'alerte :
la fiche met en garde, elle n'accuse personne. Suggestion : bordure `#B45309` à 35 %, fond à 7 %,
texte en `#0A1311`.

## Ton

L'application tutoie rarement et n'exagère jamais. Elle dit ce qui est, et pourquoi. Les textes
du produit expliquent la **raison** d'une consigne plutôt que de l'imposer — c'est la même voix
qu'il faut garder ici.

Pas de point d'exclamation. Pas de « Attention ! ». Pas de majuscules criées.

## Mot-symbole

Le logo vit dans `apps/web/src/app/shared/ui/brand-logo/`. Si tu n'en disposes pas, écris
simplement **Tracky** en Manrope 800, couleur accent, et ajoute en dessous *par Vizyo Agency* en
secondaire — c'est suffisant et c'est honnête.
