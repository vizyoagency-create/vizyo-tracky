# A4 — Le partage : lien public temporaire

> **Le lot le plus sensible du bloc A.** Un lien public qui n'expire pas, ou qui expose plus que prévu, est une fuite de données permanente et indexable.

## Le besoin

Le dépôt reçoit lui-même des appels : son client final veut savoir quand la livraison arrive. Aujourd'hui il rappelle le transporteur, qui rappelle le conducteur.

Le partage résout la chaîne d'un coup : le dépôt envoie un lien, le client voit le camion arriver, personne n'appelle.

**Contrainte client, explicite : le lien est temporaire, 15 minutes par défaut.** Un lien de suivi qui reste valide indéfiniment finit dans un e-mail transféré, puis dans un moteur de recherche.

---

## Pages concernées

| Élément | Fichier | Action |
|---|---|---|
| Modèle | `apps/api/prisma/schema.prisma` | Créer `MissionShareLink` |
| API privée | `apps/api/src/depot/mission-share.controller.ts` | Créer |
| API publique | `apps/api/src/depot/public-mission-share.controller.ts` | Créer |
| Route publique web | `apps/web/src/app/app.routes.ts` | Ajouter `/s/:token` |
| Page publique | `features/public-tracking/` | Créer |
| Modale de partage | `features/depot/share-dialog/` | Créer |

Maquettes : `Espace Depot Refonte.dc.html` § 02 (modale PC), § 04 (feuille iOS), § 05 (FAB Android).

---

## 1. Le modèle

Calqué sur `ReservationBookingLink` (`schema.prisma:2011`), qui a fait ses preuves.

```prisma
model MissionShareLink {
  id              String    @id @default(uuid()) @db.Uuid
  missionId       String    @db.Uuid
  mission         Mission   @relation(fields: [missionId], references: [id], onDelete: Cascade)

  /// Opaque, imprévisible, 22 caractères base62. JAMAIS un uuid de mission.
  token           String    @unique

  /// Qui a généré le lien — un DEPOT, ou un gestionnaire du transporteur.
  createdByUserId String    @db.Uuid
  createdBy       User      @relation(fields: [createdByUserId], references: [id], onDelete: Cascade)

  /// L'expiration. Calculée à la création, jamais prolongeable.
  expiresAt       DateTime
  /// Mode : 15 min, 1 h, ou jusqu'à la fin de la mission.
  duration        ShareDuration

  revokedAt       DateTime?
  revokedByUserId String?   @db.Uuid

  /// Suivi d'usage — pour la révocation éclairée et l'audit.
  openCount       Int       @default(0)
  firstOpenedAt   DateTime?
  lastOpenedAt    DateTime?
  /// Empreintes tronquées, jamais l'IP complète (RGPD).
  lastOpenedFrom  String?

  createdAt       DateTime  @default(now())

  @@index([missionId, createdAt])
  @@index([expiresAt])
  @@map("mission_share_links")
}

enum ShareDuration {
  MIN_15
  HOUR_1
  UNTIL_MISSION_END
}
```

### Le token

- **22 caractères base62**, tirés d'un générateur cryptographique (`crypto.randomBytes`), pas d'un uuid ni d'un compteur.
- Espace de 62²² ≈ 10³⁹ : l'énumération est hors de portée.
- **Jamais dérivé de l'identifiant de mission.** Un token prévisible donne accès à toutes les missions.
- Non réutilisable : un nouveau partage crée un nouveau lien. Régénérer le même token pour la même mission permettrait à un ancien destinataire de revenir.

---

## 2. Ce que le lien expose

C'est la spécification la plus importante du document. Tout champ absent de cette liste **ne doit pas quitter le serveur**.

### Le DTO public

```ts
interface PublicTrackingDto {
  /// Ce qu'on montre
  status: 'IN_PROGRESS' | 'LATE' | 'DONE';
  position: { lat: number; lng: number } | null;
  etaAt: string | null;
  destinationLabel: string;        // "Muret" — la ville, pas l'adresse exacte
  carrierName: string;             // "MH CARS" — le transporteur assume sa livraison
  expiresAt: string;
  lastUpdateAt: string | null;
}
```

### Le tableau de décision

| Donnée | Exposée | Pourquoi |
|---|---|---|
| Position du camion | ✅ | C'est l'objet du lien |
| Heure d'arrivée estimée | ✅ | C'est ce que le client veut |
| Ville de destination | ✅ | Confirme qu'il s'agit de sa livraison |
| Nom du transporteur | ✅ | Le transporteur assume, et c'est sa vitrine |
| **Plaque** | ❌ | Identifie un véhicule et son propriétaire |
| **Nom du conducteur** | ❌ | Donnée personnelle, aucun motif |
| **Téléphone** | ❌ | idem |
| **Référence de mission** | ❌ | Permet de deviner le volume d'activité |
| **Adresse exacte** | ❌ | La ville suffit |
| **Trajet parcouru** | ❌ | Révèle les autres clients livrés avant |
| **Historique** | ❌ | Hors sujet |
| **Origine** | ❌ | Révèle l'implantation du dépôt |

⚠️ **Le tracé parcouru est le piège classique.** Afficher « d'où vient le camion » révèle les points de livraison précédents — donc les autres clients du dépôt. Le lien public montre **un point**, pas une ligne.

---

## 3. Les endpoints

### Côté dépôt (authentifié)

```
POST   /depot/missions/:id/share      { duration }  → { token, url, expiresAt }
GET    /depot/missions/:id/shares                   → liens actifs + usage
DELETE /depot/shares/:id                            → révocation immédiate
```

**Gardes** : `DepotScopeGuard` + `mission_share`. Un dépôt ne partage que ses propres missions.

**Limites** :
- 3 liens actifs maximum par mission (au-delà : révoquer avant de créer)
- 20 créations par heure et par compte (`@Throttle`)

Ces limites ne sont pas anti-abus théorique : elles empêchent qu'un dépôt génère un lien par client et transforme le suivi en flux public.

### Côté public (sans authentification)

```
GET  /public/track/:token          → PublicTrackingDto
```

Sur le modèle de `PublicReservationBookingController` : pas de `JwtAuthGuard`, débit borné par méthode.

```ts
@Controller('public/track')
export class PublicMissionShareController {
  @Get(':token')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  get(@Param('token') token: string) { ... }
}
```

**Comportement de rafraîchissement** : polling toutes les 20 s côté client. **Pas de WebSocket sur le lien public** — un socket non authentifié est une surface d'attaque disproportionnée pour un point sur une carte.

### En-têtes de la réponse publique

```
Cache-Control: no-store
X-Robots-Tag: noindex, nofollow
Referrer-Policy: no-referrer
```

Le `X-Robots-Tag` est indispensable : sans lui, un lien collé dans un message public finit indexé.

---

## 4. L'expiration

### Le calcul

| Durée | `expiresAt` |
|---|---|
| `MIN_15` | `now + 15 min` |
| `HOUR_1` | `now + 1 h` |
| `UNTIL_MISSION_END` | `mission.endAt + 30 min` |

La marge de 30 minutes sur le troisième mode couvre le retard : un lien qui expire pile à l'heure prévue meurt au moment où le client en a le plus besoin.

### Les règles

1. **Non prolongeable.** Pas d'endpoint qui repousse `expiresAt`. Pour prolonger, on crée un nouveau lien — et on le renvoie sciemment.
2. **Vérifiée à chaque requête**, à l'heure serveur.
3. **La fin de mission ferme tous les liens**, quelle que soit leur durée. Une mission `DONE` ou `CANCELLED` invalide ses liens immédiatement : suivre un camion après sa livraison, c'est suivre sa tournée suivante.
4. **Purge** : tâche quotidienne qui supprime les liens expirés depuis plus de 30 jours. On garde 30 jours pour l'audit.

### La révocation

Depuis la modale, un bouton « Révoquer » par lien actif, avec le nombre d'ouvertures : « ouvert 3 fois, dernière il y a 4 min ».

Effet immédiat, pas de cache. Le destinataire voit l'écran « lien fermé ».

---

## 5. La modale de partage

Maquette § 02 (PC), § 04 (iOS).

**Contenu** :
1. La mission concernée, en lecture seule
2. **Durée de validité** — 3 puces : `15 min` (actif par défaut) · `1 h` · `Fin de mission`
3. Le lien généré + bouton Copier
4. Un encart ambré : « Expire dans 14:52 · révocable à tout moment », avec un compte à rebours réel

**La phrase de périmètre**, sous le titre :

> Un lien public à envoyer à votre client final. Il n'affiche que la position et l'heure d'arrivée du camion de cette mission, et expire automatiquement.

Le dépôt doit savoir ce qu'il transmet avant de l'envoyer. C'est ce qui évite qu'il se sente responsable d'une fuite qu'il n'a pas comprise.

**Mobile** : feuille basse sur iOS avec un bouton pleine largeur « Copier et envoyer » qui ouvre la feuille de partage native. FAB « Partager » sur Android, snackbar « Lien copié » avec action ANNULER (qui révoque).

L'ANNULER du snackbar est plus qu'une commodité : c'est la sortie du geste raté, dans les 5 secondes, sans ouvrir de menu.

---

## 6. La page publique `/s/:token`

Une page unique, mobile d'abord — elle s'ouvre depuis un SMS ou WhatsApp dans 90 % des cas.

**Contenu** :
- Nom du transporteur en tête, discret
- Carte plein écran, camion centré, halo pulsé
- Bandeau bas : « Arrivée estimée **11:34** », et le statut (« en route », « en retard de 22 min »)
- Mention d'expiration : « Ce lien expire à 12:05 »
- Aucune navigation, aucun lien vers l'application, aucun formulaire

**Pas de compte, pas de cookie, pas d'analytics tiers.** La page ne pose rien sur l'appareil du destinataire.

### Les 4 états de la page

| État | Écran |
|---|---|
| **Actif** | Carte + arrivée estimée |
| **Expiré** | « Ce lien de suivi a expiré » + « Demandez-en un nouveau à votre expéditeur ». Pas de bouton de renouvellement — le destinataire n'a pas ce droit |
| **Révoqué** | Même écran que expiré. **Ne pas distinguer** : dire « révoqué » indique qu'il a existé et que quelqu'un l'a fermé |
| **Introuvable** | Même écran encore. Un token invalide et un token révoqué donnent la même réponse |

Les trois derniers états partagent le même écran et le même code HTTP (`410 Gone`). Cette uniformité est délibérée : elle empêche de distinguer un token inexistant d'un token fermé, donc d'énumérer.

---

## 7. Règles métier

1. Seul un compte avec `mission_share` génère un lien : le dépôt destinataire, ou un gestionnaire du transporteur.
2. Une mission `PLANNED` **peut** être partagée : le lien affiche « Le suivi démarrera à 08:15 » puis bascule seul.
3. Une mission `DONE` ou `CANCELLED` ne peut plus être partagée, et ses liens existants sont fermés.
4. Le lien ne donne accès qu'à **une** mission. Jamais un lien « toutes mes livraisons ».
5. Le transporteur peut révoquer n'importe quel lien de sa flotte, y compris ceux créés par un dépôt. C'est lui qui porte la responsabilité des données.
6. Toute création et toute révocation sont journalisées : qui, quand, quelle mission, quelle durée.

---

## 8. États et cas particuliers

| Cas | Comportement |
|---|---|
| Lien ouvert avant `startAt` | Carte centrée sur la destination, « Le suivi démarrera à 08:15 » |
| Position indisponible pendant le suivi | Dernier point grisé + « position indisponible depuis 6 min ». Jamais un point périmé présenté comme actuel |
| Mission terminée pendant la consultation | « Livraison effectuée à 11:34 », carte figée 30 s, puis écran de fin |
| Mission annulée pendant la consultation | « Cette livraison a été annulée. Contactez votre expéditeur. » |
| Lien ouvert 200 fois | Fonctionne, mais l'usage remonte au dépôt dans la modale — il décide de révoquer |
| Dépôt désactivé | Ses liens actifs sont révoqués automatiquement |
| Véhicule changé sur la mission | Le lien suit la mission, donc le nouveau véhicule. Transparent pour le destinataire |
| Deux liens sur la même mission | Autorisé (max 3), chacun avec sa propre expiration |
| Token dans une URL partagée publiquement | Expire seul en 15 min. C'est précisément le scénario qui justifie la durée courte |

---

## 9. Impacts

### Backend

- Migration : `MissionShareLink`, `ShareDuration`
- Deux contrôleurs : privé (garde + throttle) et public (throttle seul)
- Un service de génération de token cryptographique
- Tâche de purge quotidienne
- Fermeture en cascade à la clôture de mission
- Journal d'audit sur création et révocation

### Frontend

- Modale de partage (PC) + feuille (iOS) + FAB & snackbar (Android)
- Page publique `/s/:token`, sortie du shell authentifié (`auth-layout` ne s'applique pas : aucune marque Tracky imposée)
- Compte à rebours réel dans la modale et sur la page publique

### Sécurité — la liste de contrôle

- [ ] Token cryptographique, 22 caractères, non dérivé d'un identifiant
- [ ] `expiresAt` vérifié côté serveur à chaque requête
- [ ] `410` uniforme pour expiré / révoqué / introuvable
- [ ] `X-Robots-Tag: noindex, nofollow`
- [ ] `Cache-Control: no-store`
- [ ] `Referrer-Policy: no-referrer`
- [ ] Débit borné sur la route publique
- [ ] Aucune donnée personnelle dans le DTO public
- [ ] Aucun tracé, un point seulement
- [ ] Fermeture automatique à la fin de mission
- [ ] Journal d'audit complet
- [ ] IP tronquée, jamais complète

---

## 10. Critères de recette

| # | Scénario | Attendu |
|---|---|---|
| 1 | Générer un lien 15 min, l'ouvrir | Carte + arrivée estimée |
| 2 | Attendre 16 min, rouvrir | `410` + écran « expiré » |
| 3 | Révoquer, rouvrir | Écran identique à l'expiré, même code |
| 4 | Token inventé | Écran identique encore |
| 5 | Inspecter la réponse publique | Aucune plaque, aucun nom, aucun tracé |
| 6 | Terminer la mission | Tous les liens fermés immédiatement |
| 7 | Générer 4 liens sur une mission | Le 4ᵉ est refusé avec un message clair |
| 8 | 40 créations en une heure | Débit borné |
| 9 | Vérifier les en-têtes | `noindex`, `no-store`, `no-referrer` |
| 10 | Lien ouvert sur mobile 360 px | Carte lisible, arrivée estimée visible sans défilement |
| 11 | Dépôt désactivé | Ses liens actifs deviennent inopérants |
| 12 | Journal d'audit | Création et révocation tracées avec leur auteur |
