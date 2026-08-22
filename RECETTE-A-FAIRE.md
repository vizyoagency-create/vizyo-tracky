# Recette manuelle — à faire à la main

> Ce qui ne peut pas être vérifié autrement qu'avec une vraie souris et de vrais yeux.
> Le reste est couvert par 2 528 tests automatiques et cinq gardes bloquants.

---

## Véhicule « Cas spécial » (accidenté / débranché / immobilisé)

**Où** : fiche d'un véhicule → carte **« Cas spécial · super-admin »**, sous le bloc conducteur.
**Qui** : connecté en super-admin.
**Durée** : 5 minutes.

*Tout a déjà été exercé par script en production — sélecteur, annulation, note, remise en service,
375 px, contrastes. Ce qui reste est le **vrai clic**, que l'outillage ne sait pas faire ici.*

### A. La carte s'affiche

- [ ] **A1** — La carte « Cas spécial » est visible sur la fiche.
- [ ] **A2** — Le sélecteur affiche **« En service »** et propose : Accidenté · Boîtier débranché · Immobilisé.
- [ ] **A3** — Le texte d'aide sous le sélecteur se lit sans effort.

### B. J'annule — rien ne doit bouger

- [ ] **B1** — Choisir **« Accidenté »**, puis **Annuler** la fenêtre de confirmation.
- [ ] **B2** — Le sélecteur est **revenu à « En service »**.
- [ ] **B3** — Recharger la page : toujours « En service ». *(rien n'a été enregistré)*

### C. Je déclare le véhicule hors service

- [ ] **C1** — Choisir **« Accidenté »** → **Confirmer**.
- [ ] **C2** — Une fenêtre demande une **précision facultative** : taper un texte, valider.
- [ ] **C3** — La carte passe en **orange**, une bannière affiche **« Hors service depuis <date> »**.
- [ ] **C4** — La note saisie s'affiche sous la bannière.
- [ ] **C5** — Un message de succès apparaît.
- [ ] **C6** — Recharger : tout est toujours là. *(c'est bien enregistré)*

### D. Je remets en service

- [ ] **D1** — Choisir **« En service »** → **Confirmer**.
- [ ] **D2** — **Aucune** demande de précision cette fois.
- [ ] **D3** — L'orange, la bannière et la note **disparaissent** ; le texte d'aide revient.
- [ ] **D4** — Recharger : toujours en service.

### E. Sur téléphone (ou fenêtre à 375 px)

- [ ] **E1** — Aucun **défilement horizontal** sur la page.
- [ ] **E2** — Le sélecteur se **touche facilement** du pouce.
- [ ] **E3** — La bannière et la note **ne débordent pas** de la carte.

### F. Un gestionnaire de flotte ne doit rien voir

- [ ] **F1** — Se connecter en **FLEET_ADMIN**, ouvrir une fiche véhicule.
- [ ] **F2** — La carte « Cas spécial » est **absente**.

---

## Ce qui se passe une fois un véhicule marqué — à contrôler dans la journée

Après avoir laissé un véhicule en « hors service » quelques heures :

- [ ] **G1** — **Agenda** : il n'est plus proposé à la réservation sur un créneau libre.
- [ ] **G2** — **Score de conduite** : il ne figure plus au classement (sa note reste consultable à part).
- [ ] **G3** — **Alertes** : plus d'alerte « GPS perdu » ni de veille accident le concernant.
- [ ] **G4** — Le remettre en service le fait **revenir partout**.

---

## Notifications « GPS perdu » — réservées aux super-admins

- [ ] **H1** — Sur quelques jours : **aucun client** ne reçoit plus de notification « Signal GPS perdu »
      pour un parking souterrain ou un passage sous un pont.
- [ ] **H2** — L'alerte reste **consultable** dans le centre d'alerte (elle est créée, seul l'envoi est retenu).
- [ ] **H3** — En super-admin, les notifications continuent d'arriver.

---

## En cas d'anomalie

Noter **ce qui était attendu**, **ce qui s'est passé**, et la **plaque** du véhicule.
Une capture d'écran vaut mieux qu'une description.
