# Prompt à donner à Claude — mise en forme de la fiche

> Copiez tout ce qui suit la ligne de séparation, et **joignez les trois autres fichiers du
> dossier** (`02-CONTENU-FICHE.md`, `03-CHARTE-TRACKY.md`, `04-CONTEXTE.md`).

---

Tu vas mettre en forme une **fiche d'urgence d'une page**, destinée à être imprimée en A4 et
envoyée en PDF par courriel. Je te fournis trois fichiers : le texte final, la charte graphique
du produit, et le contexte d'usage. **Lis le contexte en premier** : il explique qui lit cette
fiche et dans quel état — c'est ce qui doit gouverner tes choix, pas l'esthétique.

## Ce que je veux

Un **document HTML autonome** (un seul fichier, CSS inclus, aucune dépendance externe sauf la
police Google Fonts Manrope), prêt à être imprimé en PDF depuis un navigateur.

- **Format A4 portrait, une seule page.** Si ça ne tient pas, réduis les marges et l'interlignage
  avant de couper du texte ; en dernier recours, coupe par le bas (§ 6 puis § 5).
- `@page { size: A4; margin: 12mm; }` et une feuille `@media print` propre : pas de fond sombre,
  pas d'ombres, pas de dégradés qui mangent l'encre.
- **Thème CLAIR**, toujours. Cette fiche finit imprimée et punaisée près des clés.

## Les règles non négociables

1. **Le numéro `06 52 07 70 38` est l'élément le plus gros de la page après le titre.** Il doit
   se lire à un mètre, sur une feuille punaisée, par quelqu'un qui n'a pas ses lunettes. C'est
   la seule information que la fiche existe pour transmettre.
2. **Le § 1 (« les véhicules sont volontairement immobilisés la nuit ») est en haut et encadré.**
   C'est l'information qui évite la panique et l'appel inutile : beaucoup de gens croiront à une
   panne mécanique.
3. **Le § 4 (ce qu'il ne faut pas faire) doit être visible sans être menaçant.** Ni rouge vif ni
   pictogramme d'interdiction agressif : le lecteur n'est pas un suspect, c'est un collègue
   fatigué. Un ton ferme et une raison donnée valent mieux qu'un panneau.
4. **N'invente aucun texte.** Pas de slogan, pas de « Nous sommes à votre écoute », pas de
   reformulation « plus fluide ». Le texte a été pesé mot à mot. Tu peux seulement : découper en
   blocs, hiérarchiser, choisir les icônes, mettre en gras.
5. **Aucune capture d'écran de l'application, aucune illustration décorative.** Des icônes
   simples et unies, à la rigueur.

## Hiérarchie visuelle souhaitée

```
┌──────────────────────────────────────────────┐
│  Logo/mot-symbole Tracky        petit, discret│
│                                              │
│  TITRE                          très visible │
│  sous-titre                                  │
│                                              │
│ ╔══════════════════════════════════════════╗ │
│ ║ § 1 — encadré : c'est normal, voici      ║ │
│ ║ pourquoi                                 ║ │
│ ╚══════════════════════════════════════════╝ │
│                                              │
│  § 2 — LE NUMÉRO, ÉNORME                     │
│         + les 3 choses à dire                │
│         + l'exemple de message               │
│                                              │
│  § 3 — si vous avez l'app    │  § 4 — à ne   │
│                              │  pas faire    │
│                                              │
│  § 5 — ce que la ligne n'est pas  (discret)  │
│  § 6 — tableau récapitulatif                 │
│  pied de page                                │
└──────────────────────────────────────────────┘
```

Deux colonnes pour §§ 3-4 si ça aide à tenir sur une page ; une seule colonne si c'est plus
lisible. Juge sur le rendu, pas sur le principe.

## Détails qui comptent

- Le **message d'exemple** du § 2 doit ressembler à un message, pas à un paragraphe : bulle,
  encadré léger, ou police à chasse fixe — quelque chose qui se recopie des yeux.
- Le tableau du § 6 doit rester lisible en noir et blanc (beaucoup d'imprimantes de bureau).
- Prévois un **QR code** à côté du numéro, pointant sur
  `https://wa.me/33652077038?text=Urgence%20v%C3%A9hicule%20%E2%80%94%20plaque%20%3A%20`
  — sur une feuille punaisée, c'est ce qui évite de recopier un numéro à la main. Génère-le en
  SVG inline (pas d'appel à une API externe : la fiche doit rester autonome et imprimable hors
  ligne).
- Les italiques du texte source (les explications « pourquoi ») sont **volontairement plus
  discrètes** : garde-les visuellement secondaires.

## Ce que je te demanderai après

Une **variante « écran »** du même document : même contenu, thème sombre autorisé, pensée pour
être lue sur un téléphone depuis l'application. Ne la fais pas tout de suite — d'abord la version
imprimable.

---

**Livre-moi le fichier HTML, et dis-moi en trois lignes ce que tu as tranché et pourquoi.**
