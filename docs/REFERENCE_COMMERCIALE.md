# Référence commerciale — les 58 modules de Vizyo Tracky (2026-07-21)

> Tâche 6.1. Une ligne par module backend (`apps/api/src/`), langage produit — support de la
> présentation commerciale. Plans : modèle TOUT INCLUS Sérénité/Liberté × Lite/Pro/Signature.

## Suivi & carte (socle)
| Module | Ce que ça fait pour le client |
|---|---|
| `positions` | Ingestion temps réel des trames GPS (anti-replay, anti-téléportation, échantillonnage adaptatif) |
| `tracker-tcp` / `socket-registry` | Liaison directe avec les boîtiers (TCP persistant, commandes instantanées) |
| `realtime` | Diffusion live vers la carte (WebSocket, coalescing anti-surcharge) |
| `trips` | Segmentation automatique des trajets (durée, km, adresses, rejeu) |
| `geocode` / `geocoding` | Adresses lisibles sur chaque position/trajet (géocodage inverse) |
| `tracker-fix-mode` | Fréquence du boîtier pilotée automatiquement (20 s en mouvement, éco à l'arrêt) |
| `trackers` / `unknown-trackers` | Parc de boîtiers : appairage, santé, détection d'inconnus |
| `gps-integrity` | Détection « GPS perdu » (boîtier vivant sans position) avec alerte calme |
| `gps-dead-zones` | Zones mortes apprises (parkings souterrains) — fini les fausses alertes récurrentes |

## Contrôle moteur (Pro)
| `engine-control` | Coupure/rétablissement moteur à distance, garde-fous vitesse/immobilité/confirmation |
| `vehicle-schedules` | Coupure planifiée par horaires (multi-plages, jours fériés, dates spéciales) |
| `tracker-commands` | Commandes programmées aux boîtiers (file, retries, ACK) |
| `driver-unlock` | Déverrouillage conducteur par QR + contrôle de proximité GPS |

## Alertes & surveillance
| `alerts` | Alertes vitesse/zone/batterie/remorquage, regroupées anti-spam |
| `notifications` | Notifications push + escalade (rappel si non lu) |
| `geofences` | Zones illimitées (chantiers, dépôts, secteurs interdits) |
| `surveillance` | Plages de veille programmées par véhicule (Signature) |
| `audio-monitoring` | Micro d'assistance embarqué, double opt-in légal, auto-désarmement (Signature) |

## Organisation & conducteurs (Pro)
| `vehicles` / `vehicle-groups` | Flotte organisée par sites/agences, QR de déverrouillage imprimables |
| `drivers` | Conducteurs : comptes, attribution des trajets, **export RGPD art. 15, anonymisation art. 17, registre du temps de travail 5 ans** |
| `users` / `invitations` | Multi-utilisateurs par e-mail, 6 rôles, permissions par périmètre (véhicule/groupe/flotte) |
| `vehicle-access` / `permissions` | Résolution fine des droits (« spécifique gagne »), anti-escalade |
| `privacy-mode` | **Vie privée usage mixte CNIL** : cadre de temps de travail, hors-travail non collecté, transparence conducteur |
| `consent` | Consentements (bandeau LP + app), traçés |
| `agenda` | Agenda unifié : maintenance, incidents, réservations + **agent IA nocturne** (option) |
| `reservation-booking` / `installation-booking` / `installations` | Réservations anti-conflit, liens publics de RDV, planning d'installation |
| `fleet-places` | Lieux clés (stations, parkings validés) enrichis OSM + analyse IA |
| `sims` | Parc SIM multi-opérateurs géré par Vizyo, visible dans la plateforme |

## Analyse & rapports
| `reports` | Rapports PDF/Excel/CSV + envoi hebdo automatique |
| `trip-analysis` | Scores de conduite, récits IA de trajets, carburant calibré « méthode du plein », €/km |
| `ai` / `ai-usage` | IA multi-fournisseurs avec gouvernance : opt-in, budgets, kill-switch, coûts tracés |

## Confiance & administration (argument sécurité)
| `auth` / `auth-client` / `security` | Connexion sécurisée, 2FA, vérification des nouveaux appareils, sessions révocables |
| `system-activity` / `user-activity` | Journal d'audit complet « qui fait quoi quand » + purges automatiques |
| `observability` / `api-traffic` / `system-metrics` / `backup-health` | Centre d'alerte, trafic API, métriques, santé des sauvegardes |
| `background-tasks` | Catalogue de TOUS les traitements de fond (« rien d'invisible ») |
| `email` / `sms` | E-mails transactionnels (centre d'aperçu) + passerelle SMS de secours boîtiers |
| `billing` | **Abonnements par flotte (plan/formule/options/cas spéciaux) + grille tarifaire pilotée depuis l'admin + option IA Stripe** |
| `leads` / `public-stats` | Formulaires LP (devis « bon pour accord », e-mail vidéo) + compteurs publics dynamiques |
| `fleets` / `internal` / `health` / `common` / `config` / `prisma` | Multi-tenant, santé, socle technique |

## Différenciateurs à marteler en rendez-vous
1. **Tout inclus** : boîtier + SIM + pose + garantie dans l'abonnement (149/199/269 €/an/véh)
2. **Coupure moteur** avec garde-fous réels (jamais en mouvement) + planning horaire
3. **Conducteurs QR + vie privée CNIL usage mixte** — unique sur le marché français à ce prix
4. **RGPD outillé** : export art. 15, anonymisation art. 17, registre du temps de travail, purges
5. **Transparence** : journal d'audit complet, catalogue des traitements, chiffres publics vérifiables
