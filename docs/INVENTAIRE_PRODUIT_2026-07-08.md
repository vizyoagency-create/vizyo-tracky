# Inventaire produit Tracky — la vérité du code

> ⚠️ **Instantané du 2026-07-08** *(note du 2026-08-22)*. Plusieurs constats ont bougé
> depuis : les purges RGPD sont armées (21/07, cf. `rgpd-retention-donnees.md` et
> `TACHES.md` § 4), et la refonte v2 d'août a retouché la quasi-totalité des écrans.
> Vérifier avant de citer un statut de ce fichier comme courant.

> **But** : base factuelle pour construire une présentation commerciale + une grille tarifaire.
> **Date** : 2026-07-08. **Périmètre** : `apps/api` (NestJS), `apps/web` (Angular), `packages/shared`, `apps/api/prisma/schema.prisma`, landing page `lp/`.
> **Méthode** : audit multi-agents (17 agents, ~2 M tokens, lecture réelle des fichiers) + passe critique de complétude et de vérification de statut. Rien n'est inventé : ce qui n'est pas dans le code est marqué « non trouvé dans le code ».
> **Convention de statut** : *implémenté* = câblé bout-en-bout (contrôleur backend + service + exposé côté web) ou logique complète utilisée en prod ; *partiel* = présent mais incomplet (backend sans front, derrière un flag OFF, ou effet réel non armé) ; *en cours* = stub / non branché.

---

## ⚠️ À lire avant de faire le pitch et la grille tarifaire (7 vérités du code)

Ces points sont vérifiés dans le code et ont un impact direct sur ce que tu peux promettre :

1. **Aucun moteur de facturation dans l'app.** Pas de table `Plan`/`Subscription`/`Tier`, pas de Stripe/Paddle, pas de prix de vente, pas de quota de véhicules. L'onglet « Facturation & options » est une **vitrine** (compteur de véhicules + « contactez votre conseiller »), le code le dit lui-même : *« pas encore de backend de paiement »* (`permissions.ts:99-105`). **Conséquence : toute offre par palier (Lite/Pro/Fleet, Live, Micro, rétention 1-3 ans) est aujourd'hui activée/désactivée À LA MAIN en interne, pas « débloquée à l'achat ».**
2. **« Identification conducteur par code PIN » = N'EXISTE PAS.** Le modèle `Driver` n'a aucun champ PIN/badge/RFID (`schema.prisma:713`). L'attribution du conducteur est **manuelle** (un gestionnaire affecte un conducteur « courant » à un véhicule). La LP le promet sur 3 pages → **à retirer ou reformuler** (« affectation du conducteur », pas « le conducteur s'identifie par PIN »).
3. **« Live temps réel 15 s » comme option payante = pas un verrou dans le code.** La fréquence vient du **boîtier** (fix réglable, borné **20 → 300 s**) ; rien ne lie la cadence à un add-on facturé. Le temps réel de base rediffuse déjà chaque position à son arrivée. C'est une **différenciation commerciale**, pas un cran technique.
4. **Rétention longue (1/2/3 ans) : la purge est en DRY-RUN en prod.** `POSITIONS_PURGE_ENABLED=false` par défaut → **rien n'est supprimé aujourd'hui** (`env.validation.ts:109`). La rétention est une **capacité prête, à armer sur GO**, pas « active ». De facto, l'historique est aujourd'hui illimité.
5. **Écoute audio (micro) : réelle mais TRIPLE verrou OFF par défaut.** Armement SMS réel confirmé, aucun clip stocké. Mais il faut : gate plateforme `AUDIO_MONITORING_ENABLED=true` + N1 super-admin éligibilise la flotte + N2 fleet-admin consent (attestation). À vendre comme **option encadrée**, pas comme fonction active.
6. **Coupure moteur : « confirmée par l'arrêt réel », pas ACK électrique.** Le boîtier n'a pas d'accusé fiable ; la preuve = la chute d'ignition. Si le véhicule était déjà à l'arrêt, la commande est marquée **« non vérifiable »**. Ne pas promettre « confirmation instantanée 100 % ».
7. **La matrice « 4 rôles » de la LP ne colle pas au code.** Les vrais rôles sont `SUPER_ADMIN`, `FLEET_ADMIN`, `FLEET_MANAGER`, `VIEWER`, `NIGHT_WATCHMAN` (pas de rôle « Agent »). Le seul rôle « terrain » (`NIGHT_WATCHMAN`) coupe le moteur mais n'a **pas** accès aux rapports — l'inverse de ce que la matrice LP laisse croire.

**En sens inverse — des fonctions réelles PAS (ou mal) vendues sur la LP** (matière commerciale) : scores de conduite A→E + classement/compétition, suivi carburant « méthode du plein » + passages en station avec prix réels, switch IA Claude/GPT + interrupteur maître IA par flotte, parc SIM & conso data, veilleur de nuit, liens publics de RDV/réservation (dont vocal), audit exhaustif (traçabilité secteur public), skin marque blanche « Baanool » par utilisateur, provisioning multi-tenant automatisé.

---

# Section 1 — Fonctionnalités métier

> Organisé en 11 domaines. Pour chaque fonctionnalité : nom produit · ce que ça fait · statut · fichiers de référence. Les seuils/limites et coûts techniques sont regroupés en §3 et §4.

## 1.1 Suivi temps réel & carte live

- **Position en direct (WebSocket)** — chaque véhicule remonte position, vitesse, cap, état de contact ; affichage live sur la carte sans rafraîchir la page, via un socket scopé à la société. **Implémenté.** `apps/api/src/realtime/realtime.gateway.ts:142`, `apps/api/src/positions/positions.service.ts`, `apps/web/src/app/core/services/realtime.service.ts`.
- **Réception boîtiers GPS (serveur TCP)** — serveur d'écoute permanent des boîtiers Coban, décodage des trames, mise à jour temps réel. **Implémenté.** `apps/api/src/tracker-tcp/tcp-server.service.ts`, `apps/api/src/socket-registry/socket-registry.service.ts`.
- **Regroupement des positions (batch 1 s)** — accumule 1 s et envoie un seul lot dédupliqué par boîtier (fluide à 30+ véhicules). **Implémenté.** `apps/api/src/realtime/position-broadcast-buffer.service.ts`.
- **Hydratation immédiate de la carte** — à l'ouverture, dernière position connue de chaque véhicule via REST (`/api/vehicles/snapshot`), le live prend le relais. **Implémenté.** `realtime.service.ts:637`, `apps/api/src/vehicles` (snapshot).
- **Marqueurs véhicules (MapLibre)** — marqueur positionné/réorienté en direct, clusters. **Implémenté.** `apps/web/src/app/features/map/map.component.ts`.
- **État de connectivité tri-état (badge)** — état unifié partout : ONLINE / AWAITING_GPS (« Recherche GPS ») / PARKED / OFFLINE / NOT_CONFIGURED (seuil fraîcheur 15 min). **Implémenté.** `packages/shared/src/utils/tracker-liveness.ts`, `connectivity-badge.component.ts`.
- **État « Recherche GPS » / no_fix** — boîtier connecté sans lock GPS (LBS, démarrage à froid) marqué « en attente GPS » au lieu d'être jeté. **Implémenté.** `tcp-server.service.ts:322`, `packages/shared/src/protocol/coban.parser.ts`.
- **Boîtiers non reconnus (aide au provisioning)** — vue admin des IMEI inconnus qui tentent de se connecter (nb tentatives, IP, dates), création en 1 clic. **Implémenté.** `apps/api/src/unknown-trackers/*`.
- **Alerte « connexion temps réel interrompue » (anti-faux-positif)** — incident remonté au centre d'alerte si le canal live reste coupé > 45 s au premier plan ; garde de visibilité anti-onglet-en-arrière-plan. **Implémenté.** `apps/api/src/realtime/realtime-incident.controller.ts`, `realtime.service.ts`.
- **Reconnexion robuste du live** — reconnexion auto, repli WebSocket→polling, refresh du jeton, coupure sous 60 s d'un utilisateur suspendu/supprimé. **Implémenté.** `realtime.service.ts`, `realtime.gateway.ts:98`.
- **Bandeau de statut live sur la carte** — HUD connecté / interrompu. **Implémenté.** `map.component.ts`.
- **Marqueurs stations-service (calque)** — stations fréquentées par la flotte (90 j) : cercle proportionnel à la fréquence, contour orange si visite récente (≤ 21 j), popup (marque, lieu, passages, véhicules, dernier prix). **Implémenté.** `map.component.ts:3450`, données `apps/api/src/trip-analysis/fuel-station.service.ts`.
- **Panneau Calques** — activer/désactiver Géofences, Trajets, Plaques, Arrêts > 5 min (24 h), Stations, Heatmap densité (24 h), marqueurs compacts + filtres d'état véhicule ; badge de calques actifs. **Implémenté.** `map.component.ts`.
- **Transition « en mouvement » (event sans position)** — `VEHICLE_MOVEMENT` diffusé même aux rôles sans position (veilleur), pour griser « Couper » quand ça roule. **Implémenté.** `realtime.gateway.ts:153`.
- **Diffusion live du statut boîtier & des commandes moteur** — `TRACKER_STATUS` + `ENGINE_COMMAND_UPDATED` poussés vers la carte. **Implémenté.** `realtime.gateway.ts`.
- **Émulateur de positions (démo/dev)** — générateur de positions factices. **Partiel** — forcé OFF en production (`MOCK_POSITIONS` ignoré si `NODE_ENV=production`). `mock-position-emitter.service.ts`.

## 1.2 Historique, trajets, analyse & carburant

- **Historique des trajets** — détection auto (démarrage confirmé ~30 s, clôture sur coupure d'ignition/arrêt prolongé/timeout), distance/durée/vitesses/tracé, liste paginée filtrable par véhicule/groupe/période. **Implémenté.** `apps/api/src/trips/trips.service.ts`, `trips.controller.ts`, front `reports.component.ts`.
- **Recalcul des trajets (« recompute »)** — re-segmentation a posteriori sur une plage (flux GPS désordonné), réservé SUPER_ADMIN/FLEET_ADMIN. **Implémenté.** `trips.service.ts:697`, `trip-segmenter.service.ts`.
- **Note libre & conducteur par trajet** — note texte + (ré)assignation de conducteur ; conducteur « snappé » à la clôture. **Implémenté.** `trips.service.ts:611`.
- **Replay carte du trajet** — rejoue le trajet (polyligne colorée par vitesse), arrêts + excès superposés, tracé calé sur route si dispo. **Implémenté.** `apps/web/src/app/features/reports/trip-replay.component.ts`, `period-replay.component.ts`.
- **Tracé calé sur les routes (map-matching OSRM)** — snap au réseau routier en arrière-plan. **Implémenté** (best-effort, OSRM public par défaut). `apps/api/src/trips/map-matching.service.ts`.
- **Analyse déterministe du trajet (sans IA)** — distance, temps roulant, vitesses, arrêts ≥ 4 min, qualité GPS, excès, à-coups, ralenti, éco-score 0-100, conso & CO₂ estimés, tracé simplifié ; persistée une fois, réutilisée partout. **Implémenté.** `apps/api/src/trip-analysis/trip-analysis.service.ts`, `trip-analysis.preprocessor.ts`.
- **Excès de vitesse certifiés par les limites OSM** — confrontation à la limite légale réelle (`maxspeed` OSM via Overpass, sinon inférence FR), fortement caché en base. **Implémenté** (best-effort). `trip-analysis/speed-limit.service.ts`.
- **Récit IA du trajet + conseils éco** — Claude/GPT (ou « Mixte » sur l'analyse trajet) transforme les chiffres en récit clair ; le LLM ne recalcule rien. **Implémenté** (perm `ai_narrate`, gate `Fleet.aiEnabled`). `trip-analysis-llm.service.ts`.
- **Tracky Trust Score (indice de confiance)** — note 0-100 de fiabilité de la donnée GPS, badge coloré. **Implémenté.** `trip-analysis-llm.service.ts:180`.
- **Marque blanche « agent Tracky »** — le moteur réel (Claude/GPT/Mixte) est masqué pour le client, seul le super-admin voit le vrai moteur. **Implémenté.** `trip-analysis.service.ts:94`.
- **Mode « Comparer » (Claude vs GPT)** — même trajet analysé par les 2 moteurs, INTERNE super-admin seulement. **Implémenté.** `trip-analysis.controller.ts:224`.
- **Notation A→E du score de conduite** — éco-score moyenné/agrégé par véhicule/conducteur/groupe, note lettrée (A ≥ 85… E), nb trajets, km, excès, à-coups, litres, CO₂. **Implémenté** (perm `trips_view`, page `/scores`). `driving-score.service.ts`, `driving-scores.component.ts`.
- **Compétition éco-conduite (score perso + podium/rang)** — note + rang dans le classement + écart à la moyenne, carte de score par entité. **Implémenté.** `driving-score.service.ts:127`, `driving-score-card.component.ts`.
- **Calibration conso réelle « méthode du plein »** — saisie des pleins (litres, €, plein complet, odomètre, station) → conso RÉELLE = litres / distance entre 2 pleins complets ; prime partout sur l'estimée ; indice de confiance selon le nb de pleins. **Implémenté** (perm `fuel_manage`). `fuel-calibration.service.ts`, `fuel-calibration-card.component.ts`.
- **Modèle de coût carburant (estimé vs réel)** — conso estimée/calibrée/effective, litres & coûts au prix constaté en station ET au prix flotte, écart %. **Implémenté.** `fuel-calibration.service.ts:51`.
- **Détection des passages en station-service** — pour chaque arrêt, match sur station connue via l'API FR gratuite `data.economie.gouv.fr` (rayon 160 m), marque enrichie via OSM ; passage enregistré avec le prix carburant du moment. **Implémenté** (best-effort). `fuel-station.service.ts`.
- **Capture & historique des prix carburants** — 6 carburants (gazole, sp95, sp98, e10, e85, gplc) historisés par station + date source. **Implémenté.** `fuel-station.service.ts:181`.
- **Rapport carburant par véhicule** — passages, fréquence (« tous les X jours »), stations classées, prix min/max/moy/dernier + courbe, litres/distance, coût constaté vs prix flotte. **Implémenté.** `fuel-report.service.ts`, `fuel-report-card.component.ts`.
- **Badges d'analyse réutilisables** — éco-score, excès, arrêts, à-coups, ralenti, litres/CO₂, passages station, Trust Score + boutons « Analyser » / « Récit IA », sur fiche véhicule/rapports/replay. **Implémenté.** `trip-analysis-badges.component.ts`.
- **Export Excel par véhicule (feuille « Passages station »)** — voir §1.8 Rapports.
- **Automatisation des trajets (pipeline planifié)** — cron horaire toutes flottes « recalcul → analyse → récit IA », bornes paramétrables, historique cliquable, verrou anti-chevauchement. **Implémenté** (réservé SUPER_ADMIN, **OFF par défaut**, page `/admin/trip-automation`). `trip-automation.service.ts`.

## 1.3 Géofences, zones, alertes, notifications & surveillance

**Géofences (zones)**
- **Zones circulaires** — centre + rayon (m), détection haversine. **Implémenté.** `apps/api/src/geofences/geofences.service.ts`.
- **Zones polygonales (formes libres)** — ≥ 3 sommets, ray-casting. **Implémenté.** `geofences.service.ts`, `create-geofence.dto.ts`.
- **Corridors (couloirs d'itinéraire)** — polyligne + largeur de buffer, alerte entrée/sortie du couloir. **Implémenté.** `corridor-geometry.ts`.
- **Règles de zone (Entrée / Sortie / Les deux)** — `GeofenceRule` ENTER/EXIT/BOTH. **Implémenté.**
- **Ciblage par véhicule** — zone limitée à une liste de véhicules (sinon toute la flotte). **Implémenté.** `geofences.service.ts:451`.
- **Import de zones en masse (GeoJSON)** — FeatureCollection → cercle/polygone/corridor, features malformées ignorées. **Implémenté** (FLEET_ADMIN/SUPER_ADMIN). `corridor-geometry.ts:109`.
- **Couleur personnalisée de zone** — défaut `#10e0a0`. **Implémenté.**
- **Anti-rebond des franchissements** — débounce 60 s par (tracker, zone, sens) contre le jitter GPS. **Implémenté.** `geofences.service.ts:57`.

**Alertes**
- **Centre d'alertes (24 types, 3 sévérités)** — SOS, coupure d'alimentation, accident, collision, remorquage, retrait tracker, démarrage non autorisé, batterie faible, excès de vitesse, entrée/sortie de zone, mouvement moteur éteint, capot/porte, vibration, freinage/accélération/virage brusque, fatigue, perte GPS, arrêt prolongé, maintenance due, surveillance déclenchée, inconnue ; INFO/WARNING/CRITICAL. **Implémenté.** `alerts.service.ts`, `alerts.component.ts`.
- **Mapping alarmes boîtier → alertes** — traduction des alarmes Coban en type + sévérité + titre FR + message contextuel. **Implémenté.** `alert-mapping.ts`.
- **Regroupement anti-spam (rafales)** — fusion front des alertes en rafale (même véhicule+type) en une carte ×N + dropdown + ack groupé. **Implémenté.** `alerts.component.ts`.
- **Acquittement (individuel / tout / compteur non-lu)** — + badge total & critiques. **Implémenté.**
- **Alerte de franchissement de zone** — entrée/sortie → alerte WARNING nommant la zone, temps réel + notifications. **Implémenté.**
- **Filtres & pagination** — type/sévérité/véhicule/ack, curseur. **Implémenté.**

**Notifications**
- **Règles de notification personnalisables (AlertRule)** — par flotte : (type ou `*`, véhicule optionnel) → canaux ; fusion des règles. **Implémenté.** `alert-rules.service.ts`.
- **Canaux multi-supports** — IN_APP (WebSocket, toujours), WEB_PUSH, EMAIL, WHATSAPP, SMS ; destinataires = FLEET_ADMIN actifs, filtrés par flotte. **Implémenté.** `notification-dispatch.service.ts`.
- **Notifications push web (PWA/VAPID)** — multi-devices avec dédup, purge auto (404/410), badge, vibration + persistance pour CRITICAL, options APNs iOS. **Implémenté** (no-op sans VAPID). `web-push.service.ts`.
- **E-mail d'alerte (charte 2026)** — + variante escalade. **Implémenté.**
- **SMS / WhatsApp d'alerte (vizyo-texto)** — SMS court E.164, WhatsApp via préfixe. **Implémenté.**
- **Anti-flood SMS** — 1 SMS/(destinataire, type)/5 min. **Implémenté.**
- **Escalade auto des CRITICAL non acquittées** — cron chaque minute : après délai (défaut 10 min), re-notification au contact d'escalade ; claim atomique. **Implémenté.** `escalation-cron.service.ts`.
- **Test de push (Observabilité, SUPER_ADMIN)** — notif de test à ses devices. **Implémenté.**

**Surveillance (antivol embarqué)**
- **Profil de surveillance par véhicule** — mode, sensibilité, déclencheurs, plage horaire, destinataires. **Implémenté.** `surveillance.service.ts`, `surveillance-panel.component.ts`.
- **Modes (Désactivé / Permanente / Plage horaire)** — OFF / FULL_TIME (24/7) / SCHEDULED (plage + jours, gère minuit). **Implémenté.** `surveillance-scheduler.service.ts`.
- **Sensibilité (Faible/Moyenne/Élevée)** — mappée au niveau de choc Coban. **Implémenté.**
- **Déclencheurs (Vibration/Mouvement/Porte)** — trame correspondante sur véhicule armé → CRITICAL `SURVEILLANCE_TRIGGERED`. **Implémenté.**
- **Armement/désarmement manuel** — envoi réel des commandes Coban ; échoue si tracker offline. **Implémenté.**
- **Armement/désarmement auto planifié** — cron chaque minute selon l'état attendu. **Implémenté.**
- **Journal des événements + qualification** — historique (lat/lng/vitesse/trigger), statuts PENDING / ACKNOWLEDGED / CONFIRMED_THEFT / FALSE_ALARM + notes. **Implémenté.**
- **Destinataires supplémentaires par véhicule** — opt-in (max 10 FLEET_ADMIN/MANAGER). **Implémenté.**

## 1.4 Coupure/restauration moteur, commandes tracker & écoute audio

- **Coupe-circuit moteur (coupure & rétablissement à distance)** — bouton « Couper / Rallumer » depuis carte/liste/fiche ; coupure autorisée seulement à faible vitesse, rétablissement toujours possible. **Implémenté.** `apps/api/src/engine-control/engine-control.controller.ts`, `engine-control.service.ts`, front `engine-control-button.component.ts`.
- **Garde-fous de coupure (anti-coupure en roulant)** — position fraîche, fix valide, vitesse ≤ 20 km/h, sinon refus (`REJECTED_SPEED`, 403). **Implémenté.** `engine-control.service.ts:156`.
- **Verrou « une seule coupure en vol » (409)** — anti double-clic/concurrence ; n'affecte ni RESTORE ni coupe auto. **Implémenté.**
- **Confirmation par chute d'ignition / « non vérifiable »** — pas d'ACK fiable ; preuve = chute d'ignition ; si déjà à l'arrêt → « non vérifiable » (jamais de faux succès). **Implémenté.** *(cf. vérité commerciale n°6.)*
- **Sentinelle « coupure non confirmée »** — coupe confirmable non confirmée dans la fenêtre (défaut 90 s) → tracée au centre d'alerte. **Implémenté.**
- **Coupe automatique par planning horaire** — source SCHEDULER ; jamais un véhicule en mouvement ni arrêté depuis trop peu (défaut 10 min). **Implémenté.**
- **Coupe « veilleur de nuit »** — coupe seulement à l'arrêt + immobilité min ; tient jusqu'à réactivation manuelle ; ne peut jamais désactiver un planning. **Implémenté.**
- **Neutralisation planning à la commande manuelle** — override 1 h (ou désactivation totale si droit horaires). **Implémenté.**
- **Canaux TCP + bascule SMS (moteur)** — socket TCP d'abord, sinon SMS `stop/resume`, sinon FAILED + alerte + 503. **Implémenté.**
- **Historique des commandes moteur** — statut/motif/erreur, scopé flotte. **Implémenté.**
- **Commandes tracker (catalogue Coban ~24 templates)** — statut, position immédiate, reset/factory, veille, position continue/fix, économie GPRS, alarmes vitesse/mouvement, détection choc + sensibilité, geofence rectangulaire, fuseau, APN, IP serveur, changement mot de passe, protocole 18, commande brute ; les commandes moteur en sont exclues (coupe-circuit dédié). **Implémenté.** `tracker-commands.controller.ts`, `coban.catalog.ts`, front `commands-panel.component.ts`.
- **Programmation différée de commandes** — `scheduledAt`, cron 30 s dépêche par lots. **Implémenté.**
- **Attente d'accusé (ACK) & latence** — écho attendu par template avec timeout ; ACK moteur J/K prioritaires. **Implémenté.**
- **Annulation de commande** — PENDING/SCHEDULED → CANCELLED. **Implémenté.**
- **Historique unifié moteur + tracker par véhicule** — timeline fusionnée. **Implémenté.**
- **Pilotage adaptatif du fix GPS (fix-mode)** — fréquence ajustée selon l'état (MOVING 20 s / IDLE 30 s / STOPPED >10 min 300 s), économie batterie/data. **Implémenté** (flag flotte `adaptiveFixModeEnabled`). `tracker-fix-mode.service.ts`.
- **Réconciliation & flag FAILING (+ correctif faux positif garé)** — confirme la cible, marque FAILING après 3 échecs, auto-guérison des véhicules garés. **Implémenté.**
- **Override admin fix-mode + timeline + état** — forcer un intervalle, bloquer les transitions, voir la timeline (90 j). **Implémenté.** `admin-fix-mode.controller.ts`.
- **Diagnostic automatique (hint) sur commande** — message concret en cas d'échec (offline, GPRS, firmware, antenne). **Implémenté.**
- **Centre d'alertes trackers** — FAILING / OFFLINE > 1 h / commandes en attente > 10 min + erreurs applicatives, export markdown. **Implémenté.** `admin-alerts.controller.ts`.
- **Écoute audio embarquée « Mode assistance » (micro)** — armement réel du micro Coban par SMS `monitor<pwd>` puis appel de la SIM pour entendre la cabine ; **aucun clip reçu/stocké**. **Implémenté** mais **triple verrou OFF** (voir vérité n°5 & §3). `audio-monitoring.service.ts`, front `audio-listen-button.component.ts`.
- **Désarmement micro + motif obligatoire** — renvoie `tracker<pwd>` (le mode monitor coupe le GPS). **Implémenté.**
- **Filet de sécurité auto-disarm (5 min)** — cron chaque minute désarme toute écoute trop longue (DB-driven, survit au reboot). **Implémenté.** `audio-auto-disarm.service.ts`.
- **Consentement à 2 niveaux (garde-fous légaux)** — N1 super-admin éligibilise + N2 fleet-admin consent (attestation) ; mail « obligations » à l'activation. **Implémenté.**
- **Audit des écoutes + vue éligibilité** — journal (qui/quand/véhicule/motif/statut/env), mail d'info à la demande. **Implémenté.**

## 1.5 Agenda, maintenance, réservation, installations & leads

- **Agenda multi-types (calendrier de flotte)** — `VehicleEventType` MAINTENANCE/INCIDENT/RESERVATION ; liste sur fenêtre, filtres, CRUD, carte de synthèse ; un événement peut « immobiliser » le véhicule. **Implémenté.** `agenda.controller.ts`, `vehicle-events.service.ts`, `agenda.component.ts`.
- **Signalement d'incident** — INCIDENT OPEN qui immobilise + déclenche l'agent. **Implémenté.**
- **Estimation kilométrage (odomètre GPS)** — dernier relevé + distance GPS cumulée, pour les échéances « tous les X km ». **Implémenté.**
- **Visibilité flotte / disponibilité réelle** — activité réelle (trajets) + heatmap d'utilisation + sous-utilisation. **Implémenté.** `fleet-insights.service.ts`.
- **Prévision d'usage (créneaux prévus)** — apprend par véhicule × jour sur 10 semaines les créneaux habituels, projetés en INFORMATIF (jamais bloquant). **Implémenté.** `forecast.service.ts`.
- **Plans de maintenance récurrents (CT/vidange « tous les X mois/km »)** — intervalle mois/km, dernier fait, préavis ; matérialise un événement PLANNED ; « enregistrer un entretien réalisé ». **Implémenté.** `maintenance-plans.service.ts`.
- **Rappels d'échéance de maintenance** — cron quotidien 7 h, notif web-push au préavis, dédup. **Implémenté.** `maintenance-reminder.service.ts`.
- **Réservation de véhicule (demande → validation)** — REQUESTED (non bloquant) → CONFIRMED (bloquant) / CANCELLED, édition avec re-check ; placement direct si `reservations_manage` ; 3 permissions (voir/demander/gérer). **Implémenté.** `reservations.controller.ts`, `reservations.service.ts`.
- **Anti-double-réservation (concurrence)** — pré-check 409 + contrainte Postgres EXCLUDE `no_overlap_reservation`. **Implémenté.**
- **Auto-complétion / suggestion de véhicules libres** — véhicules libres conformes aux critères (places, sièges-enfant, équipements), triés par sous-utilisation. **Implémenté.**
- **Réservation déjà effectuée (consignation rétroactive)** — consigner une réservation passée (gestionnaires). **Implémenté.**
- **Agent nocturne d'optimisation d'agenda** — détecte les trajets récurrents (10 semaines, ≥ 4 observées, 100 % déterministe), projette (horizon 14 j) et propose des suggestions OU crée des réservations fermes (auto au-dessus d'un seuil). **Implémenté** (opt-in par flotte, cron horaire). `agenda-agent-runner.service.ts`, `recurrence-detector.service.ts`.
- **Couche IA de jugement/explication** — LLM juge « garder/écarter » + « pourquoi » vulgarisé (métier, itinéraire réel, géofences) ; échec sans conséquence. **Implémenté.**
- **Réglages de l'agent (par flotte)** — activation, heure nocturne, fréquence, autonomie (suggest/auto), seuil confiance, déclencheurs (incident/maintenance/réservation/nocturne), coût IA du mois. **Implémenté.** `agenda-agent-settings.service.ts`.
- **Déclencheurs événementiels** — relance auto sur incident/maintenance/réservation (throttle 5 min, anti-boucle). **Implémenté.**
- **Lien public de demande de réservation** — lien à société fixe ; un tiers non authentifié décrit son besoin ; le serveur choisit lui-même les véhicules libres (anti-fuite de capacité) → demandes REQUESTED ; contact obligatoire, suivi d'ouverture, accusés e-mail. **Implémenté.** `reservation-booking/*`, front `public-reservation.component.ts`.
- **Analyse vocale du besoin (dictée → champs)** — extraction places/destination/créneau ; repli déterministe (regex + parsing FR), affiné par LLM si IA activée ; best-effort. **Implémenté.**
- **Prise de RDV d'installation en ligne (lien public)** — lien `/book/:token` paramétrable (durée créneau, plage, jours ouvrés, horizon, usage unique, expiration) ; créneaux libres DST-safe ; validation/refus admin. **Implémenté.** `installation-booking/*`.
- **Anti-double-booking des créneaux d'installation** — correspondance exacte + EXCLUDE `no_overlap_installation_booking`. **Implémenté.**
- **Validation → création automatique de la pose** — crée/réutilise le planning + ajoute une pose datée (plaque/marque/modèle/énergie), e-mails, lien à usage unique refermé. **Implémenté.**
- **Plannings d'installation (poses)** — planning par flotte (client, adresse, statut) + tâches ordonnées (date, plaque, IMEI, SIM, notes, statut). **Implémenté** (CRUD SUPER_ADMIN, lecture FLEET_ADMIN). `installations/*`.
- **Réordonnancement des poses (ouvert au fleet-admin)** — vue client dédiée. **Implémenté.**
- **Pose + provisioning auto véhicule/tracker** — à la complétion, capture IMEI/SIM et provisionne Vehicle + Tracker en transaction ; retry/resync. **Implémenté.**
- **Formulaire de contact (leads landing page)** — endpoint public rate-limité, enregistre le prospect, notification interne. **Implémenté backend.** `leads/*`. *Note : la gestion des leads se fait dans Vizyo Manager, pas dans l'app Tracky (pas de page front leads).*

## 1.6 Véhicules, groupes, accès, horaires & conducteurs

- **Gestion des véhicules (fiche + parc)** — CRUD (plaque, type, marque, modèle, année, couleur, énergie, places, sièges-enfant, équipements) ; recherche, filtre boîtier, vues tableau/groupée ; plaque unique par flotte. **Implémenté** (perms `vehicles_view/create/edit/delete`). `vehicles.controller.ts`, front `vehicles-list.component.ts`. Types : Voiture, Camion, Fourgon, Moto, Vélo, Bus, Engin de chantier, Autre.
- **KPI parc (dashboard)** — total, en mouvement, à l'arrêt, alertes critiques non ack, nouveaux ce mois. **Implémenté.** `vehicles.service.ts:541`.
- **Carte / snapshot flotte** — véhicules + dernière position + état coupe moteur tri-état + planning actif + mode vie privée + groupe (cache 15 s + push WS). **Implémenté.**
- **Groupes de véhicules** — CRUD + affectation ; badge « groupe » ; 1 groupe/véhicule (M2M borné à 1). **Implémenté.** `vehicle-groups.controller.ts`.
- **Matrice d'accès par périmètre** — sous-utilisateur scopé à TOUT / GROUPE / VÉHICULE ; filtre partout ; fail-closed (sans flotte → rien). **Implémenté.** `vehicle-access.service.ts`.
- **Horaires de service par véhicule** — plages autorisées jour par jour ; hors plage → coupe moteur auto ; multi-plages (jusqu'à 3/jour), nuit passant minuit, jours désactivés, jours fériés par pays, dates spéciales, fuseau. **Implémenté** (perm `schedules_manage`). `vehicle-schedules.service.ts`, `schedule-evaluator.ts`.
- **Coupe / rallumage automatique horaire** — cron chaque minute, garde anti-chevauchement, override respecté, report si roule/arrêt récent/hors ligne ; historisé. **Implémenté.** `schedule-cron.service.ts`.
- **Historique des coupures/rallumages horaires** — timeline 90 j. **Implémenté.**
- **Page flotte « Horaires »** — tous les véhicules + état live : fenêtre courante, compte-à-rebours « dans combien de temps coupé/rendu », badge « roule encore ⚠️ » + motif d'attente. **Implémenté.** `fleet-schedules.controller.ts`, route `/fleet-schedules`.
- **Pose d'horaires en masse (bulk) + aperçu** — même planning sur toute la flotte/sélection avec aperçu (coupés maintenant / différés / hors ligne) ; défaut 8h-22h semaine, week-end off ; super-admin doit choisir une flotte. **Implémenté.** `fleet-schedules.service.ts`.
- **Parc & capacités** — 3e onglet `/vehicles` : tableau éditable (places, sièges-enfant, énergie, équipements) + source planning + champs divergents. **Implémenté.** `vehicle-capacity-table.component.ts`. Énergies : Diesel, Essence, Électrique, Hybride, Autre.
- **Synchronisation depuis le planning d'installation** — recopie marque/modèle/énergie depuis la tâche liée (ne vide jamais un champ). **Implémenté.**
- **Conducteurs** — CRUD/archivage (nom, téléphone, e-mail, n° permis, couleur, notes) ; compteurs véhicules/trajets ; archivage = soft-delete. **Implémenté.** `drivers.controller.ts`, `drivers-list.component.ts`.
- **Conducteur courant d'un véhicule** — affecter/retirer ; snappé auto (`AUTO`) sur les trajets, modifiable (`MANUAL`) ; même flotte, actif. **Implémenté** (perm `drivers_manage`). *(⚠️ pas de PIN — affectation manuelle, voir vérité n°2.)*

## 1.7 Copilote IA, optimisation & coûts IA

- **Moteur IA multi-fournisseurs (Claude / GPT / Mixte)** — routeur unique ; Claude (`claude-opus-4-8`) ou GPT (Responses API, défaut `gpt-4.1`) ; chaque appel renvoie le moteur réellement utilisé ; repli auto sur le moteur configuré. **Implémenté.** `ai-router.service.ts`, `anthropic.client.ts`, `openai.client.ts`.
- **Choix du moteur IA global (page « Coûts IA »)** — super-admin bascule Claude ↔ GPT ↔ Mixte ; badges Actif / Clé manquante / 2 clés requises ; défaut Claude. **Implémenté.** `ai-provider-settings.service.ts`.
- **Mode « Mixte » (les 2 IA)** — GPT + Claude puis synthèse. **Partiel** : n'a de sens que pour l'analyse de trajets (duo + synthèse) ; pour un appel simple, retombe sur Claude (`ai-router.service.ts:74`).
- **Interrupteur maître IA par flotte** — `Fleet.aiEnabled` coupe TOUTE l'IA cliente ; l'app reste fonctionnelle sans IA (l'analyse déterministe n'est jamais coupée). **Implémenté.** `ai-availability.service.ts`, `ai-status.controller.ts`.
- **État IA pour le front (masquage des actions)** — `GET /api/ai/status` (configured + enabled). **Implémenté.**
- **Copilote de capacité (compléter les caractéristiques)** — l'IA propose places / sièges-enfant / équipements par véhicule (conscient du métier), DRY-RUN, un humain valide → `applyCapacity`. **Implémenté.** `ai-optimization.service.ts`.
- **Optimiseur de placement conscient des coûts (€/km)** — classe les véhicules disponibles (adéquation, dimensionnement, mutualisation, coût/km, évite « souvent pris » et maintenance imminente) ; score [0,1] + « pourquoi » ; DRY-RUN. **Implémenté.**
- **Coût/km estimé par énergie** — calcul déterministe (prix carburant FR moyens, consos par défaut, électrique forfait 0,03 €/km) ; classement relatif, pas facturation. **Implémenté.**
- **Métier de la flotte (objectif d'optimisation)** — CHILDREN_TRANSPORT / PARCELS / RENTAL / GENERIC. **Implémenté.**
- **Aperçu du payload IA (« Console »)** — endpoints preview qui renvoient le payload exact sans appel LLM. **Implémenté.**
- **Agent IA d'agenda + autonomie configurable + déclenchements** — voir §1.5. **Implémenté.**
- **Suivi des coûts IA + budget €** — chaque appel journalisé (tokens in/out/cache, coût $/€, latence, modèle, action, flotte, user) ; KPIs, répartitions, budget mensuel € (ok/warn ≥80 %/over ≥100 %) ; fleet-admin voit sa société scopée. **Implémenté.** `ai-usage.service.ts`, `admin-ai-usage.component.ts`.
- **Grille tarifaire des modèles (source serveur)** — prix USD/1M tokens figés (Opus 4.8 : 5/25/6,25/0,5 ; GPT-4.1 : 2/8/–/0,5 ; mini ; 4o) ; repli = Opus (jamais sous-estimer) ; USD→€ via `AI_USD_TO_EUR` (0,92). **Implémenté.**
- **Anti-hallucination & garde-fous** — « l'IA propose, l'app valide » : DRY-RUN, IDs inconnus ignorés, valeurs bornées, sortie JSON forcée, détection refus/tronqué/vide. **Implémenté.**
- **Échecs IA → centre d'alerte** — anti-spam (1/clé/5 min), clé invalide = CRITICAL. **Implémenté.**
- **Suivi visuel des opérations IA « en arrière-plan »** — pastille 3 états (en cours/prêt/erreur). **Implémenté.** `ai-job-pill.component.ts`.
- **Masquage owner plateforme dans les coûts IA** — appels de l'owner exclus des agrégats pour un non-owner. **Implémenté.**

## 1.8 Rapports, activité, observabilité & santé système

- **Rapport de flotte PDF** — en-tête + période, cartes KPI (véhicules actifs, trajets, km, durée, vitesses, conso, coût carburant estimé + constaté), Alertes, Top véhicules, Trajets récents (30 défaut, ≤ 500) ; variante POST (choix sections, `maxTrips`, `topN`, périmètre). **Implémenté** (perm `reports_export`). `report-pdf.service.ts`.
- **KPIs de flotte (JSON)** — stats consolidées agrégées en SQL, alimentent PDF + écran. **Implémenté** (perm `reports_view`). `reports-stats.service.ts`.
- **Export Excel soigné par véhicule** — classeur mis en forme, jusqu'à 4 feuilles : Synthèse, Trajets, Par jour, **Passages station** (daté + prix du moment) ; cap 5000 trajets. **Implémenté.** `report-excel.service.ts`.
- **Export CSV brut** — positions / trips / alerts / commands, format Excel-FR ; caps (positions 100 000, trips/alerts 50 000, commands 20 000) + suffixe `-PARTIEL` si tronqué. **Implémenté.** `report-csv.service.ts`.
- **Rapport d'analyse de vitesse (dossier juridique)** — HTML « CONFIDENTIEL » : couverture, KPI, profil de vitesse, chronologie point par point, fiabilité GPS (Doppler), cadre juridique (RGPD, CNIL 2015-165, jurisprudence). **Implémenté** (SUPER_ADMIN + FLEET_ADMIN). `speed-report.service.ts`.
- **E-mail hebdomadaire automatique du rapport PDF** — chaque lundi 08:00 UTC, PDF semaine S-1 en pièce jointe (skip si `-` ou 0 trajet). **Implémenté.** `reports-cron.service.ts`.
- **Capture d'activité utilisateur (parcours front)** — pages vues, clics, scroll, soumissions, sessions, présence (heartbeat 30 s) ; batch, rétention 90 j. **Implémenté.** `user-activity.service.ts`, `activity-tracker.service.ts`.
- **Supervision d'activité en direct (SUPER_ADMIN)** — utilisateurs en ligne, flux chronologique, analytics agrégées (7 j : uniques, sessions, pages, durée, top pages/clics/formulaires). **Implémenté.**
- **Audit des commandes moteur** — historique filtrable (CUT/RESTORE, statut), demandeur résolu (utilisateur / Planning / Boîtier / Système). **Implémenté.**
- **Rapports IA d'observation d'activité** — agent Claude lit l'activité d'utilisateurs ciblés → rapport structuré (parcours, friction, adoption, reco) ; à la demande ou planifié ; historique (cap 100). **Implémenté.** `activity-report.service.ts`.
- **Journal des actions système / automatiques** — feed lisible (e-mails, SMS, push, moteur, purges, IA, EXPORTS de rapports) ; catégories EMAIL/SMS/PUSH/ENGINE/RETENTION/AI_REPORT/AI/EXPORT/MUTATION/INTERNAL. **Implémenté.** `system-activity.service.ts`.
- **Audit des mutations HTTP (« qui a fait quoi »)** — intercepteur global : toute mutation (POST/PUT/PATCH/DELETE) → catégorie MUTATION (route + user + statut + durée) ; rétention 365 j. **Implémenté.** `mutation-audit.interceptor.ts`.
- **Centre d'alerte erreurs (ErrorLog)** — journalisation centrale ERROR/CRITICAL toutes sources + erreurs frontend ; liste filtrable + détail. **Implémenté.** `error-logger.service.ts`, `admin-logs.controller.ts`.
- **Journal « wire » boîtiers + timeline tracker** — trames brutes IN/OUT + timeline par IMEI (wire + error). **Implémenté.**
- **Monitoring serveur (VPS)** — load/CPU/RAM/taille DB en live + historique agrégé + stats DB (15 plus grosses tables, nb positions, croissance Mo/jour) ; collecte 60 s, rétention 30 j. **Implémenté.** `system-metrics/*`.
- **Santé des sauvegardes (backup health)** — chaque backup reporte son résultat ; contrôle quotidien 06:00 (CRITICAL si aucun backup < 30 h). **Implémenté.** `backup-health/*`.
- **Inventaire des tâches de fond (26 traitements)** — catalogue des crons/@Interval/setInterval : libellé, cadence, but, criticité, prochain lancement, drift via SchedulerRegistry. **Implémenté.** `background-tasks/*`, `/admin/background-tasks`.
- **Tableau de bord Coûts IA** — voir §1.7. **Implémenté.**

## 1.9 Authentification, utilisateurs, invitations, multi-tenant & vie privée

- **Connexion sécurisée (SSO Vizyo Auth)** — email + mot de passe délégués à « Vizyo Auth » (HMAC) ; Tracky ne stocke jamais le mot de passe ; jetons en cookies httpOnly (`tracky_at` ~15 min, `tracky_rt` ~30 j). **Implémenté.** `auth.controller.ts`, `auth.service.ts`, `auth-client.service.ts`.
- **Vérification du jeton (garde d'accès)** — cookie prioritaire sinon Bearer ; vérifie signature/émetteur/audience/type/appId ; refus si non provisionné/suspendu. **Implémenté.** `jwt-auth.guard.ts`.
- **« Qui suis-je » (profil de session)** — identité + rôle + `isOwner` + `fleetId`. **Implémenté.**
- **Mot de passe oublié (self-service)** — e-mail de reset via Vizyo Auth ; réponse toujours `{ ok: true }` (anti-énumération). **Implémenté.**
- **Réinitialisation par un admin** — FLEET_ADMIN/SUPER_ADMIN déclenche un reset (tracé). **Implémenté.**
- **Invitation avec matrice d'accès dès l'envoi** — rôle + flotte + scopes (TOUS/GROUPE/VÉHICULE) + permissions par case ; e-mail signé 24 h ; à l'acceptation → compte Vizyo Auth + Tracky + `UserVehicleAccess`. **Implémenté.** `invitations.service.ts`.
- **Gestion des invitations** — liste, renvoi (auto-révoque), modification d'une PENDING, révocation. **Implémenté.**
- **Garde anti-escalade des invitations** — un inviteur ne peut jamais dépasser son autorité (clamp à l'intersection). **Implémenté.**
- **Gestion des utilisateurs** — création directe, édition, archivage (suspension Auth + détachement des accès) ; garde-fous FLEET_ADMIN. **Implémenté.**
- **Mon compte / mon profil** — prénom/nom, téléphone E.164, contact d'escalade, préférences UI (dont `uiMode` tracky|baanool). **Implémenté.** `account.component.ts`, route `/account`.
- **Assistant de démarrage (onboarding)** — wizard de première prise en main marqué complété. **Implémenté.** `onboarding-wizard.component.ts`.
- **Matrice « Accès & Permissions » par véhicule/groupe** — lire/réécrire les scopes (TOUS/GROUPE/VÉHICULE) + permissions par case ; résolution « spécifique gagne » (VEHICLE > GROUP > ALL) ; anti-IDOR + clamp. **Implémenté.** `access-matrix-editor.component.ts`.
- **Vue panorama utilisateurs/groupes/permissions** — croise users × accès × groupes. **Implémenté.**
- **Système de rôles & permissions granulaires** — 5 rôles, ~35 permissions, source unique partagée api/web. **Implémenté.** *(détail en §2.)*
- **Multi-tenant (isolation par flotte)** — chaque user rattaché à une flotte ; non-SA filtrés au `fleetId` ; cross-flotte → 404. **Implémenté.**
- **Provisioning & suspension de flotte (M2M)** — endpoints internes (secret partagé, appelés par Vizyo Manager) : créer une flotte + son FLEET_ADMIN, suspendre/réactiver (kill-switch client), CRUD users, chaque acte tracé. **Implémenté.** `internal/internal.controller.ts`.
- **Liste des flottes (sélecteur)** — toutes pour SA, sinon la sienne. **Implémenté.**
- **Filtre société global (SUPER_ADMIN)** — sélecteur top-bar ; les listes s'y abonnent (client-side, localStorage) ; rapports passent `?fleetId=`. **Implémenté.** `fleet-filter.service.ts`.
- **Métier de la flotte** — CHILDREN_TRANSPORT/PARCELS/RENTAL/GENERIC → objectif IA. **Implémenté.**
- **Interrupteur maître IA par société** — voir §1.7. **Implémenté.**
- **Mode vie privée conducteur (RGPD, par véhicule)** — perm `privacy_manage` : (1) à l'ingestion, toutes les trames jetées → **0 position collectée** ; (2) historique masqué partout, RÉVERSIBLE (pas de suppression) ; idempotent, tracé, motif optionnel. **Implémenté.** `privacy-mode/*`, `positions.service.ts`.
- **Historique & état du mode vie privée** — état courant + historique des bascules. **Implémenté.**
- **Compte owner caché (au-dessus des super-admins)** — `User.isOwner` : reste SUPER_ADMIN mais INVISIBLE aux autres SA (listes, activité, coûts IA, auteur d'action masqué) ; owner voit tout, non-owner ne voit pas les owners. **Implémenté.** `common/owner-visibility.service.ts`.
- **Synchro Auth ↔ Tracky (SUPER_ADMIN)** — réconciliation directe avec la base Vizyo Auth (présents des 2 côtés / seulement Auth / seulement Tracky) + suppression ciblée. **Implémenté.**

## 1.10 SIM, SMS & e-mail (connectivité & communications)

- **Parc SIM (cartes M2M)** — inventaire synchronisé depuis WhereverSIM (ICCID, MSISDN, IMSI, statut, APN, IP, opérateur, conso mois, plafond data, session) ; recherche, filtre « non assignées », rattachement flotte, libellé/notes ; vue client (fleet-admin) restreinte. **Implémenté.** `sims.controller.ts`, `sims.service.ts`, `/sims` + `/admin/sims`.
- **Synchronisation opérateur automatique** — cache rafraîchi toutes les 30 min + à la demande ; ne réécrit que les champs miroir ; dégrade proprement. **Implémenté.** `sims-sync.service.ts`.
- **Assignation SIM ↔ traceur** — pose/dépose, renseigne le n° SMS, resync allowlist, écrit l'IMEI côté WhereverSIM. **Implémenté** (perm `sims_assign`).
- **Cycle de vie SIM (actions opérateur, facturables)** — statut (activer/suspendre/résilier), plafond data, SMS à la carte, création unitaire/masse, conso journalière, journal d'événements ; admin seulement, tracé (ICCID masqué). **Implémenté.**
- **Configuration boîtier GPS par SMS (provisioning Coban)** — séquence SMS (reset, APN, admin/SOS, IP+port, GPRS, intervalle, ACC/batterie) + attente ACK via webhook ; stepper temps réel ; admin seulement. **Implémenté.** `tracker-provisioning.service.ts`, onglet « Configuration boîtier ».
- **Confirmation par reconnexion (fiabilité provisioning)** — succès réel confirmé par la reconnexion TCP même sans ACK ; alerte si ni ACK ni reconnexion après délai de grâce. **Implémenté.**
- **Passerelle SMS (envoi & réception)** — 3 modes en cascade : **vizyo-texto** (maison, prioritaire) > **Twilio** (repli) > **no-op** (dev) ; chaque SMS journalisé. **Implémenté** (alerte CRITICAL si no-op en prod).
- **Webhook SMS entrant (ACK boîtier)** — POST signé HMAC + anti-replay 5 min ; fail-closed en prod sans secret ; fait avancer la state-machine. **Implémenté.**
- **Allowlist des numéros (vizyo-texto)** — liste blanche (SIM des traceurs + téléphones users actifs) ; auto-resync sur changement de SIM ; réconciliation. **Implémenté.**
- **Preuve de vie SMS (heartbeat)** — SMS de test chaque lundi 09:00 Paris aux admins pour détecter une chaîne SMS cassée ; échec → CRITICAL. **Implémenté.** `sms-heartbeat.service.ts`.
- **Diagnostic SMS & test de secours** — statut passerelle, envoi arbitraire, test « SMS de secours » sur un traceur, journal SMS (≤ 500). **Implémenté.** `/admin/sms`.
- **E-mails transactionnels (Resend + charte 2026)** — 11 modèles (invitation, reset MDP, rapport hebdo + PDF, alerte, lead, activation/info audio, créneau installation, réservation) ; no-op sans clé ; journalisés `EmailLog`. **Implémenté.** `email.service.ts`.
- **Centre e-mails (suivi & délivrabilité)** — `/admin/emails` : KPI (envoyés, délivraison, ouverture, échecs, suppressions), histogramme 14 j, volume par modèle, journal filtrable, fiche par modèle, aperçu HTML + test, santé délivrabilité (SPF/DKIM/DMARC, bounces, suppression list). **Implémenté.** `email-admin/*`.
- **Webhook de délivrabilité (Resend/Svix)** — events sent/delivered/opened/clicked/bounced/failed/complained ; met à jour le statut sans régresser ; fail-closed en prod. **Implémenté.**

## 1.11 Modules complémentaires (relevés par la passe de complétude)

- **Provisioning multi-tenant automatisé (canal machine-à-machine `internal`)** — ouverture de flotte + comptes + kill-switch client déclenchés par Vizyo Manager via secret partagé (`InternalSecretGuard`). **Implémenté.** `internal/internal.controller.ts`. *Argument commercial « on vous ouvre votre espace clé en main » non listé ailleurs.*
- **Adresses lisibles partout (reverse-geocoding OSM/Nominatim)** — DEUX modules distincts : `geocode` (adresse « dernière position » de la liste véhicules, cache mémoire) et `geocoding` (nommage des destinations de l'agent IA, cache en base). **Implémenté** (doublon technique = 1 seule promesse client « adresses en clair »). `geocode/*`, `geocoding/*`.
- **Skin marque blanche « Baanool » par utilisateur** — thème alternatif de la carte (look concurrent Baanool) activé par `User.uiMode = tracky|baanool`. **Implémenté** (branché `dashboard-layout.component.ts`). `features/baanool/baanool-map-overlay.component.ts`.
- **Assistant d'onboarding première connexion** — wizard 593 lignes branché. **Implémenté.** `features/onboarding/*`.
- **Espace « Mon compte » self-service** — page `/account` (distincte de `/settings` admin). **Implémenté.** `features/account/account.component.ts`.
- **Page publique « Installer Vizyo Tracky » (PWA)** — guide d'installation de l'app (≠ poses physiques). **Implémenté.** `features/install/install-page.component.ts`.
- **Health check** — `GET /health` public (ping DB + uptime + version `1.3.0`). **Implémenté.** `health/*`.
- **⚠️ `placeholder.component`** — écran « bientôt disponible » **NON routé, code mort** : ne pas présenter comme livré. `features/placeholder/*`.

---

# Section 2 — Rôles & permissions

> Source unique : `packages/shared/src/permissions/permissions.ts` (502 l.). Enforcement backend réel via `PermissionsGuard` (`apps/api/src/auth/guards/permissions.guard.ts`) + `PermissionsResolverService`. **⚠️ `PERMISSIONS_AUDIT.md` (racine repo) est PÉRIMÉ** (décrit un ancien modèle 13 perms UI-only) — ne pas s'y fier.

## 2.1 Les 5 rôles (`enum UserRole`, `schema.prisma:12`)

| Rôle | Nom produit | Ce qu'il peut faire | Restrictions / périmètre |
|---|---|---|---|
| `SUPER_ADMIN` | Administrateur plateforme (Vizyo) | **Tout, sur toutes les flottes.** Bypass total des permissions + sélecteur de société global. | Aucun plafond. Peut être `isOwner` (compte caché). |
| `FLEET_ADMIN` | Administrateur de flotte (client) | **Tout dans SA flotte** (véhicules, groupes, géofences, alertes+config, rapports+export, trajets/scores, carburant, users, conducteurs, SIM, audio, agenda, réservations, IA + interrupteur maître, facturation). | Bypass de permissions mais **borné à sa flotte** (`fleetId`). |
| `FLEET_MANAGER` | Gestionnaire de flotte | Véhicules (CRUD), groupes & géofences, voir + **acquitter** alertes, voir + **exporter** rapports, trajets/scores, **gérer les pleins**, voir SIM, conducteurs, horaires, **récits IA** de trajet. | PAS admin (soumis au guard). Interdits par défaut : `engine_control`, `privacy_manage`, `alerts_configure`, `users_*`, `sims_assign`, `audio_monitoring`, `agenda_*`, `reservations_*`, `ai_optimize`, `ai_configure`, `billing_manage`. Personnalisable par toggles. |
| `VIEWER` | Observateur (lecture seule) | Voir véhicules, géofences, alertes, rapports, trajets/scores, conducteurs. | Lecture seule ; ne crée/modifie/exporte/acquitte rien par défaut. Fallback le plus restrictif. |
| `NIGHT_WATCHMAN` | Veilleur de nuit | **Rôle restreint** : voir les véhicules + couper/redémarrer le moteur, rien d'autre. UI = page Véhicules + Mon compte. | Tout à `false` sauf `vehicles_view` + `engine_control`. Coupe **seulement à l'arrêt** (≤ 5 km/h + immobilité min), **ne peut jamais désactiver un planning** (gate `schedules_manage` non contournable). |

*(Le rôle `DRIVER` apparaît en commentaire « Phase 3 futur » mais **n'existe pas** dans l'enum.)*

## 2.2 Les ~35 permissions granulaires et leurs défauts

`✅` = accordé par défaut · `❌` = refusé par défaut. ADMIN = SUPER_ADMIN + FLEET_ADMIN (bypass effectif).

| Permission | Libellé | VIEWER | MANAGER | ADMIN | VEILLEUR |
|---|---|:--:|:--:|:--:|:--:|
| `vehicles_view` | Voir les véhicules | ✅ | ✅ | ✅ | ✅ |
| `vehicles_create` | Ajouter un véhicule | ❌ | ✅ | ✅ | ❌ |
| `vehicles_edit` | Modifier un véhicule | ❌ | ✅ | ✅ | ❌ |
| `vehicles_delete` | Supprimer un véhicule | ❌ | ✅ | ✅ | ❌ |
| `engine_control` | Couper / redémarrer le moteur | ❌ | ❌ | ✅ | ✅ |
| `privacy_manage` | Gérer le mode vie privée | ❌ | ❌ | ✅ | ❌ |
| `schedules_manage` | Gérer les horaires marche/coupure | ❌ | ✅ | ✅ | ❌ |
| `groups_view` | Voir les groupes | ❌ | ✅ | ✅ | ❌ |
| `groups_manage` | Gérer les groupes | ❌ | ✅ | ✅ | ❌ |
| `geofences_view` | Voir les géofences | ✅ | ✅ | ✅ | ❌ |
| `geofences_manage` | Gérer les géofences | ❌ | ✅ | ✅ | ❌ |
| `alerts_view` | Voir les alertes | ✅ | ✅ | ✅ | ❌ |
| `alerts_acknowledge` | Acquitter les alertes | ❌ | ✅ | ✅ | ❌ |
| `alerts_configure` | Configurer règles/seuils/canaux/escalade | ❌ | ❌ | ✅ | ❌ |
| `reports_view` | Voir les rapports | ✅ | ✅ | ✅ | ❌ |
| `reports_export` | Exporter (PDF/Excel/CSV) | ❌ | ✅ | ✅ | ❌ |
| `trips_view` | Voir l'analyse des trajets & les scores | ✅ | ✅ | ✅ | ❌ |
| `fuel_manage` | Renseigner les pleins (calibration) | ❌ | ✅ | ✅ | ❌ |
| `users_view` | Voir les utilisateurs | ❌ | ❌ | ✅ | ❌ |
| `users_manage` | Gérer les utilisateurs | ❌ | ❌ | ✅ | ❌ |
| `drivers_view` | Voir les conducteurs | ✅ | ✅ | ✅ | ❌ |
| `drivers_manage` | Gérer les conducteurs | ❌ | ✅ | ✅ | ❌ |
| `sims_view` | Voir les cartes SIM | ❌ | ✅ | ✅ | ❌ |
| `sims_assign` | Assigner une SIM | ❌ | ❌ | ✅ | ❌ |
| `audio_monitoring` | Écouter l'audio (micro) | ❌ | ❌ | ✅ | ❌ |
| `agenda_view` | Voir l'agenda + signaler un incident | ❌ | ❌ | ✅ | ❌ |
| `agenda_manage` | Gérer la maintenance | ❌ | ❌ | ✅ | ❌ |
| `reservations_view` | Voir réservations & disponibilités | ❌ | ❌ | ✅ | ❌ |
| `reservations_request` | Demander une réservation | ❌ | ❌ | ✅ | ❌ |
| `reservations_manage` | Gérer les réservations | ❌ | ❌ | ✅ | ❌ |
| `ai_optimize` | Lancer les propositions IA | ❌ | ❌ | ✅ | ❌ |
| `ai_narrate` | Générer les récits IA de trajet | ❌ | ✅ | ✅ | ❌ |
| `ai_configure` | Configurer l'IA de la flotte (interrupteur) | ❌ | ❌ | ✅ | ❌ |
| `billing_manage` | Facturation & options *(onglet vitrine, pas de paiement)* | ❌ | ❌ | ✅ | ❌ |

**Personnalisation** : à l'invitation/édition, chaque toggle est activable par utilisateur, mais **jamais au-delà de ce que détient le granter** (invariant anti-escalade `clampPermissions`).

## 2.3 Périmètre d'accès (ALL / GROUPE / VÉHICULE)

`UserVehicleAccess` (`schema.prisma:930`) + `enum AccessType` (ALL/GROUP/VEHICLE). Un non-admin a ≥ 1 ligne d'accès :
- **Action per-véhicule** (couper le moteur, etc.) : « spécifique gagne » VEHICLE > GROUP > ALL ; aucune ligne couvrant le véhicule → refus.
- **Action globale** (créer, /reports) : union de tous les scopes.
- **Fallback de permissions** par scope : scope → `User.permissions` → défauts du rôle.
- **Conséquence** : le périmètre restreint **visibilité ET actions**, et le niveau peut différer d'un scope à l'autre. Éditable dès l'invitation. *(Note sécu : le live WebSocket est aujourd'hui scopé par flotte — durcissement au backlog.)*

## 2.4 Compte owner caché (`isOwner`)

Un `SUPER_ADMIN` marqué `isOwner` reste tout-puissant mais **invisible aux autres super-admins** : exclu des listes users, de l'activité, des rapports & coûts IA, masqué comme auteur d'action. Owner voit tout ; non-owner ne voit pas les owners. Service central `OwnerVisibilityService` (cache 30 s), réversible. 17 fichiers backend l'appliquent.

---

# Section 3 — Options / add-ons / paliers activables

> **« Option » = techniquement séparable/activable dans le code** (flag `Fleet`/`Vehicle`, env var, singleton, ou permission). **Aucun prix ni palier tarifaire n'existe en base** — la modularité passe par ces leviers, pas par une facturation.

## A. Options pilotées par un champ sur la flotte (`Fleet`) — par société, sans redéploiement

| Option (nom produit) | Ce que ça active | Levier | Défaut |
|---|---|---|---|
| **Assistant IA Tracky** | Toute l'IA cliente (récit trajet, agent agenda, optimiseur, parsing vocal) | `Fleet.aiEnabled` (`schema.prisma:202`) + clé provider serveur | **ON** (si clé présente) |
| **Traçage GPS continu / conformité** | Force l'enregistrement de TOUTES les positions (sinon sampling adaptatif = économie) | `Fleet.adaptiveSamplingEnabled` (`:186`) → passer à `false` | ON (économique) |
| **Mode fix batterie/SIM** vs fix permanent | Fix adaptatif (20 s roule / 300 s arrêté) vs 30 s permanent | `Fleet.adaptiveFixModeEnabled` (`:190`) | ON |
| **Profil métier** | Objectif de l'optimiseur IA | `Fleet.metier` (CHILDREN_TRANSPORT/PARCELS/RENTAL/GENERIC) | GENERIC |
| Prix carburant flotte / e-mail rapport hebdo | Paramètres (pas des options vendables) | `Fleet.fuelPriceEurL` (1.85), `Fleet.weeklyReportEmail` | — |

## B. Options pilotées par une config dédiée (opt-in explicite)

| Option | Ce que ça active | Levier | Défaut |
|---|---|---|---|
| **Écoute audio (Mode assistance)** | Armement micro Coban par SMS | `FleetAudioConfig.superAdminEnabled` (N1) + `.assistanceEnabled` (N2) + attestation + env `AUDIO_*` + perm `audio_monitoring` | **OFF partout** (le plus verrouillé) |
| **Agent IA d'agenda (nocturne)** | Analyse nocturne + propositions/réservations auto | `AgendaAgentSettings.enabled` (défaut `false`), `autonomy` (`suggest`/`auto_high_confidence`), `confidenceThreshold` (80) | **OFF** (opt-in) |
| **Surveillance antivol (Surveillance Max)** | Antivol embarqué par véhicule | `SurveillanceProfile.mode` (OFF/FULL_TIME/SCHEDULED) + `sensitivity` (LOW/MED/HIGH) + triggers | **OFF** |
| **Mode vie privée (RGPD)** | 0 position collectée + masquage réversible, par véhicule | `Vehicle.privacyModeEnabled` + perm `privacy_manage` | OFF |
| **Suivi carburant précis (méthode du plein)** | Conso réelle qui prime partout | pleins `FuelFillUp` + perm `fuel_manage` | non calibré |

## C. Leviers pilotés par variable d'environnement plateforme (global instance)

| Levier | Rôle | Défaut |
|---|---|---|
| **Rétention & purge positions** | `POSITIONS_RETENTION_DAYS` (365, 0=infini), `POSITIONS_ARCHIVE_DAYS` (30), `POSITIONS_PURGE_ENABLED` | rétention 365/30, **purge OFF = dry-run (n'efface rien)** |
| **Coupure horaire auto** | `SCHEDULE_CUT_MIN_STOPPED_S` (immobilité min avant coupe hors plage) | 600 s (10 min) |
| **Écoute audio (gates plateforme)** | `AUDIO_MONITORING_ENABLED`, `AUDIO_SUPERADMIN_ENABLED`, `AUDIO_RETENTION_DAYS` (7), `AUDIO_DEVICE_PASSWORD`, `AUDIO_AUTO_DISARM_MINUTES` (5) | OFF |
| **Rétention logs/audit** | wire 7 j, error 30 j, mutation audit **365 j**, sampling 7 j | — |
| **Passerelle SMS** | vizyo-texto (prioritaire) / Twilio (repli) / no-op | selon env |
| **E-mails (Resend)** | `RESEND_API_KEY` vide ⇒ no-op | — |
| **Web Push** | `VAPID_PUBLIC_KEY` vide ⇒ désactivé | — |
| **Parc SIM (WhereverSIM)** | `WHEREVER_SIM_TOKEN` vide ⇒ module no-op | — |
| **Provider IA** | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` ; singleton `AiProviderSettings.provider` | défaut Claude |
| **Positions simulées (démo)** | `MOCK_POSITIONS` (démo commerciale) | OFF |

## D. Quotas / budgets / paliers chiffrés

- **Budget IA mensuel (€)** — `AiBudget.monthlyBudgetEur` (défaut 0 = aucun plafond) : **garde-fou de coût interne**, pas un prix de vente.
- **Automatisation trajets** — `TripAutomationSettings.enabled` (défaut OFF), cadence hourly/daily, bornes de charge.
- **Compte owner masqué** — `User.isOwner` (défaut OFF), gouvernance interne.

## E. Modules gouvernés par permission (surface modulaire par utilisateur)

Chaque permission de §2.2 est un levier on/off packageable : `engine_control`, `privacy_manage`, `schedules_manage`, `reports_export`, `trips_view`, `fuel_manage`, `sims_view/assign`, `audio_monitoring`, `agenda_*`, `reservations_*`, `ai_optimize`, `ai_narrate`, `ai_configure`, `billing_manage`.

## F. Marque blanche (pas un toggle vendable, mais notable)

- **« Agent Tracky »** — le moteur IA réel est masqué pour le client (codé en dur selon le rôle, `trip-analysis.service.ts:90`).
- **Skin « Baanool »** — thème UI alternatif par utilisateur (`User.uiMode`).

## G. Synthèse SOCLE vs OPTION (d'après le code uniquement)

| Capacité | Défaut | Classement |
|---|---|---|
| Live temps réel + carte + historique positions | ON | **SOCLE** |
| Analyse déterministe trajets / scores / stations | ON | **SOCLE** (jamais coupée par `aiEnabled`) |
| Rapports (lecture) | ON | **SOCLE** |
| Sampling adaptatif / fix adaptatif | ON | **SOCLE** (option = passer en continu) |
| Rétention 365 j + archive 30 j (dry-run) | 365/30, purge OFF | **SOCLE** (rétention longue = réglage, pas facturé) |
| Assistance IA (récits, agent, optimiseur, vocal) | ON si clé | **OPTION** (coupable par société) |
| Export rapports (PDF/Excel/CSV) | OFF viewer / ON manager+ | **OPTION** (par utilisateur) |
| Écoute audio embarquée | OFF partout | **OPTION** (la plus verrouillée) |
| Surveillance Max (antivol) | OFF | **OPTION** (par véhicule, paliers) |
| Agent IA d'agenda | OFF | **OPTION** (opt-in société) |
| Réservations / Agenda-maintenance | OFF sauf admin | **OPTION** (par utilisateur) |
| Mode vie privée (RGPD) | OFF | **OPTION** (par véhicule) |
| Calibration carburant | non calibré | **OPTION** (par véhicule) |
| Parc SIM M2M | OFF sans token | **OPTION** |
| Coupe-circuit horaire auto | 600 s, perm OFF viewer | **OPTION** (par utilisateur) |
| Marque blanche « agent Tracky » | actif clients | **SOCLE** (non paramétrable) |
| Onglet Facturation & options | OFF sauf admin | **PARTIEL** — UI sans backend de paiement |

> **Non trouvé dans le code** : table/modèle d'abonnement, plans tarifaires, prix par option, quota d'utilisateurs/véhicules, limite de nombre de véhicules.

---

# Section 4 — Contraintes techniques à coût

## A. APIs tierces (payantes ou à quota)

| API | Usage | Nature du coût | Où |
|---|---|---|---|
| **Anthropic (Claude)** | Récits, agent, optimiseur, rapports IA — modèle `claude-opus-4-8` | **Par requête, au token** (in/out/cache). Grille en dur : 5/25/6,25/0,5 USD/M tokens. Le + cher. | `ai/anthropic.client.ts` |
| **OpenAI (GPT)** | Idem si moteur = GPT/Mixte — `gpt-4.1` défaut | Par token (2/8/–/0,5). Mode « Mixte » = ×3 (2 appels + synthèse) sur l'analyse trajet | `ai/openai.client.ts` |
| **Resend** | E-mails transactionnels (invitation, reset, hebdo, alerte…) | **Par e-mail** ; scale avec alertes + flottes + users. No-op sans clé | `email/email.service.ts` |
| **SMS : vizyo-texto (repli Twilio)** | Provisioning, armement audio, commandes moteur de secours, alertes SMS, heartbeat | **Par SMS sortant** ; passerelle maison sur SIM Android physique (capcom6) → chaîne cassable (d'où le heartbeat) | `sms/sms-gateway.service.ts` |
| **Web Push (VAPID)** | Notifications navigateur | Gratuit (passe par FCM/APNs), par device × notification | `notifications/web-push.service.ts` |
| **Nominatim / OSM (géocodage inverse)** | Adresse « dernière position » + destinations agenda | Gratuit mais **quota strict ≤ 1 req/s/instance** ; cache agressif (mémoire + base) | `geocode/*`, `geocoding/*` |
| **Overpass / OSM** | Limites de vitesse (`maxspeed`) + marque station | Gratuit, **borné à 12 appels/analyse** ; instance publique « flaky » | `trip-analysis/speed-limit.service.ts` |
| **`data.economie.gouv.fr` (prix carburants FR)** | Détection passage station + prix | **Gratuite, sans clé**, bornée 12 lookups/analyse. **France uniquement** (positions démo Casablanca hors périmètre) | `trip-analysis/fuel-station.service.ts` |
| **OSRM (map-matching)** | Tracé calé sur route | Démo publique par défaut, surchargeable `OSRM_BASE_URL` | `trips/map-matching.service.ts` |
| **WhereverSIM (GraphQL)** | Parc SIM M2M | Lectures + **mutations facturables** (statut, plafond, SMS) chez l'opérateur ; **la data SIM elle-même = coût récurrent par véhicule connecté** | `sims/whereversim.client.ts` |
| **Vizyo Auth** | SSO (login/refresh/reset) + accès direct base Auth | Service interne (HMAC) | `auth-client/*` |

## B. Temps réel / WebSocket

- Passerelle socket.io (`realtime.gateway.ts`), revalidation connexions @Interval 60 s.
- Buffer de diffusion (`position-broadcast-buffer.service.ts`) : 1 émission `POSITIONS_BATCH`/s/flotte, dédupliqué par tracker (désactivable `WS_BATCH_COALESCING_ENABLED`).
- **Ce qui scale** : nb véhicules actifs × nb clients connectés (chaque client reçoit le batch de sa room `pos:fleet:*`).
- **Redis** (`@socket.io/redis-adapter` + `ioredis`) : requis seulement pour le **scale horizontal multi-instances** (sinon memory adapter mono-instance, fallback sans crash).

## C. Stockage / rétention (croît avec temps × nb véhicules)

- **Positions GPS = moteur de croissance de la base.** Écriture batchée (`setInterval(100 ms)`, `createMany`). Purge (`data-retention.service.ts`, cron 3h30) par lots de 10 000 (max ~500k/nuit) — **mais `POSITIONS_PURGE_ENABLED=false` par défaut ⇒ DRY-RUN, ne supprime rien**.
- **Audio : AUCUN stockage** (écoute live, pas de clip). Coût stockage = nul.
- **Logs** (cron 3h00) : wire 7 j, error 30 j, système 30 j, **audit MUTATION 365 j**.
- **Autres** : activité users 90 j (cron 4h15), métriques 30 j (4h30). **Non purgés (non trouvé dans le code)** : `AiUsageLog`, `EmailLog`, `SmsLog`, historiques prix carburant.

## D. Jobs planifiés / workers (26 traitements catalogués)

| Job | Fréquence | Consomme |
|---|---|---|
| Horaires véhicules (coupe/reprise) | chaque min | DB + **SMS** |
| Auto-désarmement audio | chaque min | DB + **SMS** |
| Armement auto surveillances | chaque min | DB |
| Envoi commandes programmées | */30 s | DB + **SMS** |
| Clôture trajets en cours | */60 s | DB |
| **Automatisation trajets (analyse + récit IA)** | horaire (si réglé, OFF défaut) | **IA** + Overpass + API carburants + DB |
| **Rapport IA d'activité** | horaire à échéance | **IA** + DB |
| **Agent nocturne agenda** | horaire (par flotte, nuit) | **IA** + Nominatim + DB |
| E-mail hebdo rapport PDF | lundi 08:00 | **Resend** + pdfkit + DB |
| Purge des journaux | quotidien 03:00 | DB |
| Rétention positions GPS | 03:30 | DB (snapshot ; DELETE si armé) |
| Clôture sessions inactives | */2 min | DB |
| Purge activité > 90 j | 04:15 | DB |
| Synchro parc SIM | 30 min | **WhereverSIM** + DB |
| Purge/collecte métriques VPS | 04:30 / continu 60 s | CPU/mém + DB |
| Contrôle santé sauvegardes | quotidien 06:00 | DB + alerte |
| Escalade alertes critiques | chaque min | DB + **Email/Push/SMS** |
| Rappels maintenance | quotidien 07:00 | DB + notifications |
| Heartbeat SMS | lundi 09:00 Paris | **SMS** |
| Diffusion positions / revalidation live | @Interval 1 s / 60 s | WS |
| Enregistrement groupé positions | setInterval 100 ms | DB |

**Les 3 jobs IA** (trip-automation, activity-report, agenda-agent) sont les seuls générateurs de **coût token récurrent automatique**, tous désactivables.

## E. Dépendances de génération / files

- **BullMQ + ioredis** : déclarés en dépendances ; `ioredis` sert l'adapter WS Redis, mais **BullMQ n'est pas branché** (aucun `Processor`/`Queue`) — la planification passe par `@nestjs/schedule`. *(partiel / non utilisé.)*
- **pdfkit** (PDF), **exceljs** (Excel), **date-holidays** (jours fériés, local), **papaparse** (CSV) : CPU local.

## F. Vrais leviers de coût récurrent (synthèse)

1. **IA (tokens)** — seul coût € **variable et non borné a priori** (volume de trajets × crons IA × mode ; « Mixte » ×3). Défaut Opus = le plus cher. Tracé + budgété.
2. **SMS** — par message (audio, provisioning, moteur, alertes, heartbeat).
3. **Data SIM opérateur** — récurrent **par véhicule connecté** (hors code, suivi WhereverSIM).
4. **Stockage positions** — linéaire avec véhicules × fréquence ; purge prête mais **en dry-run**.
5. **Nominatim/Overpass/carburants** — gratuits mais à quota (goulot de débit, pas de facture).
6. **Redis** — seulement pour le scale horizontal WS.
7. **VPS** — 2 vCPU, contrainte matérielle récurrente citée partout.

---

# Section 5 — Tarifs dans le code applicatif

**Aucun tarif de VENTE (prix d'abonnement, prix par véhicule, prix d'option, montant facturable) n'existe dans le code applicatif** (`apps/api`, `apps/web`, `packages`). Aucun moteur de facturation, aucun catalogue de prix, aucune intégration de paiement (Stripe/Paddle/checkout/invoice), aucun modèle Prisma d'abonnement/plan vendable.

**Le SEUL pricing du dépôt est dans la landing page** (`lp/src/data/pricing.mjs`, non chargé par l'app — voir §6).

Détails vérifiés :
- **Onglet « Facturation & options »** (`settings.component.ts`) : gardé par `billing_manage`, affiche un **compteur** de véhicules + « facturation gérée par votre conseiller Vizyo » + mailto + grille d'ÉTAT (Inclus / Éligible / Activé) **sans aucun prix**. Commentaire du code : *« pas de faux moyen de paiement »*, permission *« (à terme) gérer le moyen de paiement »*.
- **Budget IA en €** (`AiBudget.monthlyBudgetEur`) = **coût interne** de consommation IA (facturation Anthropic/OpenAI → Vizyo), converti via `AI_USD_TO_EUR` — **pas un prix client**.
- **« price » ailleurs** = **prix du carburant** (`FuelStationPrice`, feature stations) — faux positif.
- **Faux positifs écartés** : `MaintenancePlan`, `InstallationPlan`, `PushSubscription`, `FleetMetier`.
- **Non trouvé** : Stripe/Paddle/invoice/checkout, modèle d'abonnement/plan/facture, `maxVehicles`/`vehicleLimit`/`quota`/`tier`.

---

# Section 6 — Landing page

> Site vitrine statique généré (`lp/build.mjs` → `lp/public/*.html`), données dans `lp/src/data/*.mjs`. `https://tracky.vizyoagency.com`, app `https://app-tracky.vizyoagency.com`, contact `contact@vizyoagency.com`, tél `06 52 07 70 38`.

## 6.1 Arguments commerciaux / accroches (verbatim)

**Hero** : « Suivez et sécurisez votre flotte, **en temps réel.** » · « Géolocalisation live, coupure moteur à distance, alertes et rapports — sur une plateforme française que **nous installons et gérons** pour vous. » · réassurance « Installation sous 48h · Application française · Conforme RGPD ».

**Bandeau preuve** : « Déjà au service des flottes d'Occitanie » — « **850+ véhicules suivis** », « **13 départements d'Occitanie** », « **48h délai d'installation** », « **<2h réponse du support** ». *(chiffres déclaratifs, non vérifiables dans le code.)*

**Problème → solution** : « Gérer une flotte à l'aveugle coûte cher. » → Carte temps réel · Coupure moteur · Rapports automatisés.

**Différenciation** : « **Pas un boîtier chinois rebrandé.** » · « Un vrai éditeur français : le boîtier *et* l'application sont les nôtres. » · tableau comparatif (Installation par nos techniciens, Application française & propriétaire, Support humain en Occitanie, Données UE·RGPD, Coupure moteur incluse & programmable, Agenda & optimisation IA inclus).

**Cas d'usage** : « **5 véhicules, 3 tournées. L'IA compose le meilleur planning.** » · « −18 % de km à vide » · « Qui a pris quel véhicule ? » · « Un véhicule disparaît la nuit ? … volé, il ne redémarre pas. »

**ROI** : « **Tracky se rembourse tout seul.** » · « dès le premier mois, l'abonnement est remboursé » · « La vitesse sous contrôle = moins de carburant » · « Les excès… peuvent gonfler la consommation de 15 % » · « 4 véhicules sous-utilisés ? L'IA en garde 2. »

**Tarifs (accueil)** : « Un tarif clair, bloqué à la souscription. » · « SIM & data incluses. Engagement annuel renouvelable, sans augmentation surprise. » · badge « Tarif de lancement — garanti à vie jusqu'au 30 sept. 2026 ».

**FAQ** : « Faut-il un abonnement par véhicule ? » · « L'installation est-elle comprise ? » · « Mes données sont-elles… RGPD ? » · « La coupure moteur à distance est-elle légale ? → n'agit qu'à l'arrêt, jamais en roulant. »

**Sécurité** : « Vos données restent en France… Hébergement souverain, chiffrement de bout en bout, conformité CNIL. » · « TLS 1.3… chiffrement au repos » · « DPA fourni et signable » · « Mode vie privée CNIL ».

**Secteur public** : « Conformité CNIL véhicules de service » · « Conducteurs multiples identifiés — Identification par PIN sécurisé » · « Données souveraines » · « contrats pluriannuels (2 à 4 ans) ».

**Pages villes (SEO)** : « Installé partout en Haute-Garonne. » · « pose discrète en -30 min par véhicule » · « couverture nationale (SIM & data incluses) » (13 villes, contenu unique dans `cities.mjs`).

## 6.2 Features mises en avant

Géolocalisation temps réel (« jusqu'à toutes les 15 s en mode Live ») · Coupure moteur (manuelle + horaire) · Alertes intelligentes (vitesse/zone/batterie/remorquage) · Historique & rapports (replay, hebdo, **CSV/PDF**) · Groupes de véhicules · Multi-utilisateurs & rôles (« 6 capacités · 4 rôles ») · Agenda & réservations (badge « Nouveau », « suggestion du véhicule par l'IA ») · Agent IA (optimisation) · **Identification conducteur par PIN** · Mode vie privée (CNIL) · Géofences illimitées · Micro d'assistance (option) · Rétention historique jusqu'à 3 ans · Accès web et mobile.

## 6.3 Formules / plans / prix (verbatim `pricing.mjs` + `tarifs.html`)

Devise €, **HT**, par véhicule/mois sauf mention.

| Produit | Annuel (mis en avant) | Mensuel (sans engagement) | Boîtier | Rétention incluse |
|---|---|---|---|---|
| **Tracky Lite** — « Géolocalisation simple — sans coupe-circuit » | **22,90 €** | 32,90 € | **99 €** | 90 jours |
| **Tracky Pro** — « Contrôle total — coupure moteur incluse » *(popular)* | **29,90 €** | 42,90 € | **189 €** | 90 jours |
| **Tracky Fleet** — « Sur-mesure (10+ véhicules) » | **Sur devis** | Sur devis | — | — |

- Lite inclut : géoloc temps réel (suivi standard), historique 90 j, alertes vitesse & zone, SIM & data ; **PAS de coupure moteur**.
- Pro : tout Lite + coupure moteur manuelle + par plage horaire + alerte batterie/remorquage + support prioritaire.
- Fleet : tout Pro + dashboard multi-flottes + rapports auto PDF + account manager + **installation offerte**.
- Fréquence socle : « Suivi standard (30–60 s / sur événement) ».

**Options / add-ons** :
- **Live temps réel (15 s)** : **+9,90 €**/véh/mois.
- **Micro d'assistance** : **+6,90 €**/véh/mois.
- **Agent IA (optimisation)** : **+14,90 €**/véh/mois.
- **Rétention** : 90 j **inclus (0 €)** · 1 an **+3,90 €** · 2 ans **+6,90 €** · 3 ans **+9,90 €**.

**Installation** : base **49 €**/véhicule · **29 €** dès 5 · **offerte dès 10**.

**Offre de lancement** : active, « garanti à vie », fin `2026-09-30`, 12 places affichées.

**ROI / économies** — ⚠️ **incohérence interne** : le simulateur utilise `savingsPerVehYear = 200–400 €/an` (~17–33 €/mois) tandis que la page d'accueil affiche en dur **60 €/véh/mois** (720 €/an) et « ~3 600 € net/an sur 10 véhicules ». Deux estimations très différentes (≈2× à 3,6×) — **à aligner avant diffusion**.

**Simulateur** : plan (Lite/Pro), 1–50 véhicules, engagement annuel/mensuel, toggles options, rétention → « par jour/véhicule », « mensuel total », « coût 1re année », « années suivantes », « économies » (calcul dans `lp/public/assets/vt.js`).

## 6.4 Vocabulaire marketing (mots exacts)

« Traçage GPS & gestion de flotte » · « Éditeur français / application française & propriétaire / conçu en France » · « Boîtier » (jamais « tracker ») · « Coupure moteur / coupe-circuit / par plage horaire / immobiliser à l'arrêt » · « Live temps réel (15 s) / suivi standard / à la seconde près » · « Mode vie privée CNIL / conforme RGPD / hébergement souverain / données hébergées en UE » · « Agent IA / l'IA compose / réaffecte / mutualise / km à vide » · « Agenda & réservations » · « Micro d'assistance (légal) / activation sur événement » · « Identification conducteur par PIN » · « Géofences illimitées » · « Tarif bloqué à la souscription / garanti à vie / SIM & data incluses » · « Installation sous 48h en Occitanie / support humain, pas de chatbot / réponse en moins de 2h » · « Vous ne payez que ce que vous consommez / socle inclus + options / Tracky se rembourse tout seul » · « Pas un boîtier chinois rebrandé ». Produits : **Tracky Lite / Pro / Fleet**.

## 6.5 ⚠️ Écarts LP vs code

**A. Promesses LP à corriger**
1. **« Identification conducteur par code PIN » — NON IMPLÉMENTÉ** (répété sur 3 pages). `Driver` n'a aucun champ PIN ; l'affectation est manuelle. **L'écart le plus important à corriger dans le discours.**
2. **Matrice « 4 rôles » (Admin/gestionnaire/agent/lecture seule)** — ne colle pas : rôles réels = SUPER_ADMIN/FLEET_ADMIN/FLEET_MANAGER/VIEWER/NIGHT_WATCHMAN, pas de « Agent ». Le rôle terrain réel coupe le moteur mais n'a pas les rapports.
3. **Grille tarifaire / abonnements / options — aucun backend de facturation** : tout est activé/désactivé à la main en interne, pas enforced par l'app.
4. **« Live 15 s » comme option payante distincte — non gated** : c'est un paramètre de flux (min technique 20 s), pas un verrou d'add-on.
5. **Incohérence des chiffres d'économies** (simulateur 200–400 €/an vs accueil 60 €/mois).
6. **Rétention 1/2/3 ans — purge en dry-run** : rien n'est supprimé aujourd'hui, le palier n'est pas différenciant en l'état.
7. **« Accès web et mobile »** = web-app / PWA (pas d'app native store trouvée) → formuler « application web responsive / PWA ».

**B. Fonctions du code SOUS-vendues sur la LP** (matière commerciale)
- Scores de conduite A→E + classement/compétition + Trust Score.
- Suivi carburant « méthode du plein » + passages station (prix réels, coût vs prix flotte, marqueurs carte).
- Switch IA Claude↔GPT + interrupteur maître IA par flotte (souveraineté / marché public).
- Parc SIM + conso data · rôle Veilleur de nuit.
- Liens publics RDV installation + réservation vocale.
- Audit exhaustif (mutations, activité, centre d'alerte) — argument conformité secteur public.

**C. Éléments LP correctement adossés au code** ✔
Coupure à l'arrêt (< 20 km/h, fix GPS) · coupure/horaire · mode vie privée · géofences (« illimitées » = pas de quota) · agenda/maintenance/réservations · agent IA (propose, l'app valide) · micro « activation sur événement, pas d'écoute permanente », OFF par défaut · exports CSV/PDF (+ Excel en plus) · multi-utilisateurs & rôles avec périmètre + anti-escalade · PDF conformité réellement téléchargeables.

**D. Défauts mineurs de page** : footer accueil (« Mentions légales », « Conformité RGPD », « Fiche sécurité PDF », lien agence) et CTA « Discuter sur WhatsApp » du hero pointent vers `#` alors que les vraies pages/PDF existent.

---

# Annexe A — Modèle de données (Prisma)

> `apps/api/prisma/schema.prisma` : **62 models, 27 enums**, PostgreSQL + `postgis`/`pgcrypto`/`uuid-ossp`.

## A.1 Les 62 models par domaine

- **Organisation & comptes (7)** : `Fleet` (société/tenant), `User`, `Invitation`, `UserVehicleAccess` (accès par périmètre), `UserSession`, `UserActivity` (purge 90 j), `PushSubscription`.
- **Véhicules & parc (7)** : `Vehicle`, `VehicleGroup`, `VehicleGroupAssignment`, `Driver`, `VehicleSchedule`, `ScheduleHistory`, `PrivacyModeEvent`.
- **Boîtiers GPS & télématique (7)** : `Tracker`, `Position` (+ PostGIS), `PositionSamplingDecision` (audit sampling 7 j), `TrackerCommand`, `TrackerProvisioning`, `WireLog`, `Sim`.
- **Trajets & analyse (6)** : `Trip`, `TripAnalysis`, `SpeedLimitCache`, `GeocodeCache`, `TripAutomationSettings`, `TripAutomationRun`.
- **Carburant & stations (4)** : `FuelStation`, `FuelStationPrice`, `TripFuelStop`, `FuelFillUp`.
- **Géofences & alertes (4)** : `Geofence`, `GeofenceVehicle`, `Alert`, `AlertRule`.
- **Surveillance (2)** : `SurveillanceProfile`, `SurveillanceEvent`.
- **Coupe-circuit & audio (3)** : `EngineControlCommand`, `AudioMonitoringCommand` (append-only), `FleetAudioConfig` (gating 2 étages).
- **Agenda, maintenance & réservations (5)** : `VehicleEvent`, `MaintenancePlan`, `AgendaAgentSettings`, `AgendaAgentProposal`, `ReservationBookingLink`.
- **Installation (RDV) (4)** : `InstallationPlan`, `InstallationTask`, `InstallationBookingLink`, `InstallationBooking`.
- **IA — coûts & rapports (5)** : `AiUsageLog`, `AiBudget`, `AiProviderSettings`, `ActivityReport`, `ActivityReportSchedule`.
- **Communication (3)** : `EmailLog`, `SmsLog`, `Lead`.
- **Observabilité & rétention (5)** : `SystemActivityLog`, `ErrorLog`, `SystemMetric`, `BackupRun`, `RetentionSnapshot`.

## A.2 Les 27 enums

`UserRole` (SUPER_ADMIN, FLEET_ADMIN, FLEET_MANAGER, VIEWER, NIGHT_WATCHMAN) · `TrackerStatus` (ONLINE, OFFLINE, IDLE) · `GeofenceType` (CIRCLE, POLYGON, CORRIDOR) · `GeofenceRule` (ENTER, EXIT, BOTH) · `AlertType` (24 valeurs) · `SurveillanceMode` (OFF, FULL_TIME, SCHEDULED) · `SurveillanceSensitivity` (LOW, MEDIUM, HIGH) · `SurveillanceEventTrigger` (VIBRATION, MOVEMENT, DOOR) · `SurveillanceEventStatus` (PENDING, ACKNOWLEDGED, CONFIRMED_THEFT, FALSE_ALARM) · `AlertSeverity` (INFO, WARNING, CRITICAL) · `VehicleType` (CAR, TRUCK, VAN, MOTORCYCLE, BICYCLE, BUS, CONSTRUCTION, OTHER) · `AccessType` (ALL, GROUP, VEHICLE) · `EngineAction` (CUT, RESTORE) · `CommandStatus` (PENDING, SENT, ACKNOWLEDGED, FAILED, REJECTED_SPEED) · `InstallationPlanStatus` (DRAFT, PUBLISHED, IN_PROGRESS, COMPLETED, CANCELLED) · `InstallationTaskStatus` (PENDING, DONE, SKIPPED) · `InstallationEnergy` (DIESEL, ESSENCE, ELECTRIQUE, HYBRIDE, AUTRE) · `InstallationBookingStatus` (PENDING, CONFIRMED, REJECTED, CANCELLED) · `FleetMetier` (CHILDREN_TRANSPORT, PARCELS, RENTAL, GENERIC) · `VehicleEventType` (MAINTENANCE, INCIDENT, RESERVATION) · `VehicleEventStatus` (PLANNED, OPEN, IN_PROGRESS, DONE, CANCELLED, REQUESTED, CONFIRMED) · `TrackerCommandStatus` (+SCHEDULED) · `TrackerProvisioningStatus` · `TrackerCommandChannel` (TCP, SMS) · `ActivityReportStatus` (PENDING, READY, FAILED) · `EmailStatus` (QUEUED→...→FAILED) · `AudioCommandStatus`.

## A.3 Flags de configuration (matière options/add-ons)

- **`Fleet`** : `metier` (GENERIC), `adaptiveSamplingEnabled` (true), `adaptiveFixModeEnabled` (true), `fuelPriceEurL` (1.85), `weeklyReportEmail`, `aiEnabled` (true).
- **`Vehicle`** : `energy`, `fuelConsumptionL100km`, `calibratedConsumptionL100km` / `calibratedTanks` / `calibratedAt`, `seats`, `childSeats`, `features[]`, `privacyModeEnabled` (false) + since/by/note.
- **`Tracker`** : `desiredFixIntervalS` (30), `fixCommandFailing`, `fixModeOverrideUntil`, `accConnected` (true), `verboseUntil`.
- **`User`** : `role` (VIEWER), `permissions`, `isActive`, `isOwner` (false), `preferences` (uiMode), `escalationContactUserId`, `onboardingCompletedAt`.
- **Configs opt-in** : `FleetAudioConfig.superAdminEnabled`/`.assistanceEnabled` (false), `AgendaAgentSettings.enabled` (false)/`.autonomy`, `TripAutomationSettings.enabled` (false), `ActivityReportSchedule.enabled` (false), `SurveillanceProfile.mode` (OFF), `VehicleSchedule.enabled` (false), `MaintenancePlan.enabled` (true), `Geofence.active` (true).

## A.4 Rétention / purge

Durées dans le code/env, pas dans le schéma. Ancrages : `Position.createdAt` (+ `RetentionSnapshot`), `PositionSamplingDecision` (7 j), `SystemMetric` (30 j), `UserActivity` (90 j), `SystemActivityLog`/`ErrorLog` (env), `SmsLog` (90 j commenté), `WireLog` (cron), `AudioMonitoringCommand` (append-only, pas de clip), expirations (`Invitation`, liens publics).

---

# Annexe B — Complétude & vérifications de statut

**Modules initialement hors périmètre, ajoutés au §1.11** : `internal` (provisioning multi-tenant), `geocode` + `geocoding` (reverse-geocoding, doublon), `baanool` (skin marque blanche), `onboarding`, `account`, page publique `install`. **`placeholder` = code mort** (non routé).

**Vérifications de statut à fort enjeu commercial** (passe critique, preuve à l'appui) :

| Affirmation | Verdict | Détail |
|---|---|---|
| Écoute audio câblée bout-en-bout | **CONFIRMÉ** | Armement SMS réel, mock supprimé, aucun clip stocké — **mais triple verrou OFF par défaut**. |
| Coupure moteur « vérifiable » | **NUANCÉ** | Confirmée par la chute d'ignition ; sans écho la commande reste `SENT` ; « non vérifiable » si déjà à l'arrêt. |
| IA branchée Claude ET GPT | **CONFIRMÉ** | 2 clients réels + routeur ; nuance : `both` retombe sur Claude pour un appel unitaire (vrai duo seulement sur l'analyse trajet). |
| Rétention purge-t-elle ? | **DRY-RUN par défaut** | `POSITIONS_PURGE_ENABLED=false` → n'efface rien. |
| « Live 10-15 s » mode distinct | **FAUX** | Pas de mode/flag ; cadence device bornée 20–300 s (adaptatif), rediffusion WS. |
| PIN conducteur | **FAUX** | `model Driver` sans champ PIN ; affectation manuelle. |

**Sur-affirmations à surveiller** : audio (verrou OFF), rétention (dry-run), « Live » payant (pas un mode), PIN (inexistant), `placeholder` (mort), add-ons LP (aucun moteur de facturation/quota), « Mixte » IA (retombe sur Claude en générique).

---

*Fin de l'inventaire. Tous les statuts et chiffres sont sourcés dans le code aux fichiers cités. Sections détaillées d'origine conservées dans le scratchpad de la session.*
