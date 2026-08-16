# A5 — Comptes dépôt : invitation et gestion

## Le besoin

Le transporteur crée les comptes dépôt lui-même, depuis `/users`, avec le mécanisme d'invitation existant. Aucun parcours d'inscription publique : un dépôt ne s'auto-déclare pas.

---

## Pages concernées

| Élément | Fichier | Action |
|---|---|---|
| Liste des utilisateurs | `features/users/users-list.component.ts` | Ajouter le rôle |
| Tiroir d'édition | `features/users/user-drawer.component.ts` | Ajouter le rôle |
| Matrice de permissions | `features/users/access-matrix-editor.component.ts` | 6ᵉ colonne |
| Vue d'ensemble | `features/users/permissions-overview.component.ts` | Intégrer les dépôts |
| Invitations | `apps/api/src/invitations/` | Étendre |
| E-mail | `apps/api/src/email/email.service.ts` | Adapter `invitation` |

Maquette : `Utilisateurs Refonte.dc.html` — liste PC, matrice § 02, feuille iOS, écrans Android.

---

## 1. Le parcours

```
Fleet Admin → /users → Inviter → rôle « Dépôt » → e-mail + nom du dépôt
   ↓
E-mail d'invitation → /accept-invite?token=…
   ↓
Le dépôt choisit son mot de passe et complète ses informations
   ↓
Première connexion → /depot → modale d'onboarding animée
```

Rien de nouveau dans le mécanisme : c'est le flux d'invitation existant, avec un rôle de plus. **Ne pas créer un second système d'invitation.**

---

## 2. Le formulaire d'invitation

Champs quand le rôle est `DEPOT` :

| Champ | Obligatoire | Note |
|---|---|---|
| E-mail | ✅ | Clé d'invitation |
| Nom du dépôt | ✅ | « Dépôt Fenouillet » — affiché dans la liste et dans la modale de mission |
| Nom du contact | — | Complété par le dépôt à l'activation |
| Téléphone | — | idem |

**Les champs de périmètre disparaissent.** Un `DEPOT` n'a pas de scope véhicule ni groupe : son périmètre est calculé depuis les missions. Afficher un sélecteur de groupes serait un mensonge d'interface — et une invitation à créer une ligne `UserVehicleAccess` interdite (A1 § 7).

À la place, une ligne d'explication :

> Ce compte verra uniquement les missions que vous lui assignerez, pendant leur créneau. Aucun accès à votre flotte.

---

## 3. Dans la liste des utilisateurs

Une ligne de dépôt, avec deux différences par rapport aux autres rôles :

| Colonne | Contenu pour un dépôt |
|---|---|
| Utilisateur | Nom + e-mail, avatar violet |
| Rôle | Pastille « Dépôt » avec l'icône camion |
| Périmètre | **Pas un groupe** : « 4 missions en cours » ou « Aucune mission » |
| Membre depuis | Date d'activation |

La colonne Périmètre porte l'activité plutôt qu'un scope — c'est l'information utile : un dépôt sans mission depuis trois mois est un compte à fermer.

---

## 4. Dans la matrice de permissions

6ᵉ colonne, après Conducteur. Une section nouvelle en bas de la matrice :

**MISSIONS & DÉPÔTS**

| Permission | Admin | Gest. | Lect. | Veil. | Cond. | Dépôt |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Créer / modifier une mission | ✅ | ✅ | — | — | — | — |
| Voir les missions | ✅ | ✅ | ✅ | — | ✅ | ◆ |
| Suivre la position en mission | ✅ | ✅ | ✅ | ✅ | — | ◆ |
| Voir le déroulé des trajets | ✅ | ✅ | ✅ | — | — | ◆ |
| Contacter le conducteur | ✅ | ✅ | — | ✅ | — | ◆ |
| Partager un suivi (lien 15 min) | ✅ | ✅ | — | — | — | ◆ |

**◆ = accordé, mais limité à ses propres missions.** Marqueur violet, distinct de la coche verte, avec une légende sous la matrice :

> ◆ Limité à ses propres missions — le dépôt n'a aucun droit d'action : son accès est en lecture seule, borné à la fenêtre horaire de chaque mission.

Cette distinction visuelle est ce qui permet à un Fleet Admin de comprendre en trois secondes qu'ouvrir un accès dépôt n'ouvre pas sa flotte. Une coche verte identique aux autres rôles produirait l'inquiétude inverse.

**Les cases d'un dépôt ne sont pas modifiables.** Le rôle est fermé : on ne peut pas accorder `vehicles_view` à un dépôt depuis l'interface. Cases grisées avec une infobulle : « Le périmètre d'un dépôt est fixé par ses missions. »

---

## 5. Gestion du compte

| Action | Effet |
|---|---|
| Suspendre | Déconnexion immédiate, liens de partage actifs révoqués, missions conservées |
| Réactiver | Retrouve ses missions, y compris celles créées pendant la suspension |
| Supprimer | `Mission.depotUserId` → `null` (les missions deviennent internes). Les liens sont détruits. Le gestionnaire est prévenu du nombre de missions affectées |
| Renvoyer l'invitation | Nouveau token, ancien invalidé |
| Changer de rôle | **Interdit dans les deux sens.** Un dépôt ne devient pas gestionnaire, et l'inverse non plus |

Le dernier point mérite d'être bloqué explicitement : passer un dépôt en gestionnaire lui donnerait accès à toute la flotte d'un clic, depuis un écran qui ne le dit pas.

---

## 6. L'e-mail d'invitation

Adapter le gabarit `invitation` existant. Un dépôt n'est pas un collègue : il ne connaît ni Tracky ni le vocabulaire de la flotte.

| Élément | Version dépôt |
|---|---|
| Sous-nom d'expéditeur | « Accès » |
| Sujet | « MH CARS vous ouvre le suivi de ses livraisons » |
| Preheader | « Suivez vos livraisons en direct, sans compte à créer côté logistique » |
| Corps | Ce que le compte permet, ce qu'il ne permet pas, le lien d'activation en clair |
| Signature | Le transporteur, « propulsé par Vizyo Tracky » en pied |

Le sujet nomme le transporteur, pas Tracky : c'est de lui que le dépôt attend un e-mail.

Règles héritées de la refonte des e-mails (`Emails Refonte.dc.html`) : clair par défaut, pas de crochets dans le sujet, preheader renseigné, accents corrects, aucune information portée uniquement par une image.

---

## 7. États et cas particuliers

| Cas | Comportement |
|---|---|
| Invitation en attente | Ligne « En attente · relancer », comme les autres rôles |
| Invitation expirée | « Expirée · renvoyer » |
| Dépôt invité, jamais connecté, mission créée | La mission attend. À l'activation, il voit tout son historique |
| E-mail déjà utilisé dans une autre flotte | Refus explicite : un compte appartient à une flotte |
| Dépôt supprimé avec des missions en cours | Confirmation qui annonce le nombre : « 3 missions en cours perdront leur destinataire » |
| Fleet Admin qui tente d'inviter en dépôt un collègue interne | Autorisé techniquement, mais l'écran prévient : « Un compte dépôt ne voit pas votre flotte » |

---

## 8. Impacts

### Backend

- `Invitation` accepte `role: 'DEPOT'`
- Refus des scopes véhicule/groupe pour ce rôle, à la création comme à la modification
- Blocage du changement de rôle depuis et vers `DEPOT`
- Suspension → révocation en cascade des liens de partage
- Suppression → `SetNull` sur `Mission.depotUserId`
- Gabarit e-mail adapté

### Frontend

- Rôle dans le sélecteur d'invitation (PC, feuille iOS, dialogue Android)
- Champs de périmètre masqués quand le rôle est `DEPOT`
- 6ᵉ colonne dans la matrice + légende + cases non modifiables
- Colonne Périmètre qui affiche l'activité pour les dépôts
- Confirmations enrichies sur suspension et suppression

---

## 9. Critères de recette

| # | Scénario | Attendu |
|---|---|---|
| 1 | Inviter un dépôt | E-mail reçu, sujet au nom du transporteur |
| 2 | Activer l'invitation | Redirection vers `/depot`, onboarding affiché une fois |
| 3 | Formulaire d'invitation, rôle Dépôt | Aucun champ de périmètre |
| 4 | Tenter d'accorder `vehicles_view` à un dépôt | Impossible depuis l'interface, refusé par l'API |
| 5 | Suspendre un dépôt | Déconnecté, liens révoqués |
| 6 | Supprimer un dépôt | Missions conservées, destinataire vidé, compteur annoncé |
| 7 | Changer le rôle d'un dépôt | Refusé |
| 8 | Matrice | 6ᵉ colonne, marqueur ◆, légende présente |
| 9 | Liste | Colonne Périmètre = activité, pas un groupe |
