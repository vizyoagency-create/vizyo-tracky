/**
 * ═══ LISTE BLANCHE DE L'IMPORT — ce que la démo COPIE, et pourquoi le reste ne l'est pas ═══
 *
 * Le schéma compte plus de cent modèles et en gagne chaque semaine. Copier la base de production
 * puis « nettoyer » condamnerait à courir après chaque nouvelle table qui contient un e-mail, un
 * numéro ou une adresse IP — et la première oubliée fuirait chez un prospect. On fait l'inverse :
 * l'importeur ne copie QUE les modèles nommés ici, champ par champ, et `allowlist.spec.ts`
 * exige que CHAQUE modèle du schéma soit soit ici, soit dans `EXCLUS` avec une raison. Un modèle
 * ou un champ ajouté au schéma casse le test : il faut décider, en une ligne, et en connaissance
 * de cause. *Un vide se remarque ; une fuite se découvre par le client.*
 *
 * Trois sorts possibles pour un champ :
 *   · `copies`      — recopié tel quel (un réglage, une mesure, une date) ;
 *   · `transformes` — réécrit : pseudonymisé (plaque, IMEI, nom), remappé vers un identifiant
 *                     de démo, ou assaini (texte où une plaque ou un nom pourrait apparaître) ;
 *   · `imposes`     — l'import lui IMPOSE une valeur (null le plus souvent), quelle que soit la
 *                     source : coordonnées, notes libres, auteurs (des comptes), identifiants
 *                     de facturation.
 *
 * `transformations.ts` réalise ces règles ; `transformations.spec.ts` vérifie que ses sorties
 * ont exactement les champs listés ici. Les deux ne peuvent pas dériver l'un de l'autre.
 */
export interface RegleModele {
  pourquoi: string;
  copies: readonly string[];
  transformes: readonly string[];
  imposes: readonly string[];
}

const JOURS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const CHAMPS_JOURS = JOURS.flatMap((j) => [`${j}Enabled`, `${j}Start`, `${j}End`]);
const CHAMPS_CRENEAUX = JOURS.map((j) => `${j}Slots`);

export const ALLOWLIST: Readonly<Record<string, RegleModele>> = {
  Fleet: {
    pourquoi: 'la société de démo : ses réglages viennent de la première société source, son identité est neuve',
    copies: [
      'metier', 'adaptiveSamplingEnabled', 'adaptiveFixModeEnabled', 'fuelPriceEurL',
      'speedAlertEnabled', 'speedAlertOverKmh', 'speedAlertAbsoluteKmh', 'speedAlertUpdatedAt',
      'createdAt', 'updatedAt',
    ],
    transformes: ['id', 'name'],
    imposes: ['clientId', 'weeklyReportEmail', 'aiEnabled', 'speedAlertUpdatedById', 'stripeCustomerId'],
  },
  FleetSubscription: {
    pourquoi: 'abonnement SIGNATURE offert : toutes les options visibles, rien de facturé — pas une copie',
    copies: [],
    transformes: ['id', 'fleetId'],
    imposes: [
      'plan', 'formule', 'optLive', 'optMicro', 'optAgent', 'retentionKey', 'isComp',
      'customPriceEurYear', 'notes', 'updatedByUserId', 'createdAt', 'updatedAt',
    ],
  },
  FleetReportSchedule: {
    pourquoi: 'rapport hebdomadaire COUPÉ par défaut : le courrier du lundi ne doit pas partir tout seul depuis la démo',
    copies: [],
    transformes: ['fleetId'],
    imposes: [
      'enabled', 'weekday', 'hour', 'recipients', 'sections', 'vehicleIds', 'maxTrips', 'topN',
      'lastRunAt', 'lastStatus', 'lastError', 'updatedAt', 'updatedByUserId',
    ],
  },
  Vehicle: {
    pourquoi:
      "le parc : plaque régénérée, MARQUE ET MODÈLE remplacés (l'accord porte sur « les trajets seuls »), réglages conservés, auteurs et notes libres effacés",
    copies: [
      'type', 'energy', 'year', 'color', 'fuelConsumptionL100km',
      'calibratedConsumptionL100km', 'calibratedTanks', 'calibratedAt', 'lastOdometerKm', 'lastOdometerAt',
      'seats', 'childSeats', 'features', 'mixedUseEnabled', 'speedAlertEnabled', 'speedAlertOverKmh',
      'outOfServiceReason', 'outOfServiceSince', 'privacyModeEnabled', 'privacyModeSince', 'workOverrideUntil',
      'createdAt', 'updatedAt',
    ],
    transformes: ['id', 'fleetId', 'plate', 'brand', 'model', 'currentDriverId'],
    imposes: ['outOfServiceById', 'outOfServiceNote', 'privacyModeById', 'privacyModeNote'],
  },
  Tracker: {
    pourquoi: 'les boîtiers : IMEI régénéré (15 chiffres, Luhn), état de liveness conservé pour que la carte soit peuplée dès le démarrage, numéro de SIM effacé',
    copies: [
      'model', 'status', 'lastSeenAt', 'lastKnownIgnition', 'lastIgnitionChangeAt', 'lastLat', 'lastLng',
      'lastSpeedKmh', 'lastHeading', 'lastIgnition', 'lastValid', 'lastPositionAt', 'lastNoFixAt',
      'lastWriteAt', 'lastSampledState', 'lastPowerNoticeAt', 'lastPowerNotice', 'powerLossSuspectAt',
      'powerLossSuspectBattery', 'lastBatteryPercent', 'lastBatteryAt', 'desiredFixIntervalS',
      'currentFixIntervalS', 'recentFixIntervalsS', 'lastFixIntervalSyncAt', 'fixCommandFailureCount',
      'fixCommandFailing', 'lastValidFrameAt', 'accConnected', 'createdAt', 'updatedAt',
    ],
    transformes: ['id', 'imei', 'vehicleId'],
    imposes: ['verboseUntil', 'fixModeOverrideUntil', 'simPhoneNumber'],
  },
  Sim: {
    pourquoi:
      "les cartes SIM des boîtiers. Tout ce qui identifie un abonnement est régénéré : ICCID, " +
      "numéro d'appel, IMSI. L'IMEI et le « nom d'appareil » recopient celui du boîtier de démo, " +
      "sinon la fiche se contredirait. L'IP publique, le payload brut de l'opérateur et l'identifiant " +
      "chez l'opérateur sont effacés : ils portent des données d'infrastructure réelles que rien " +
      "n'oblige à montrer. L'APN aussi, qui nommerait notre fournisseur de SIM devant un prospect. " +
      "Les compteurs de volume et les états d'activation sont copiés : c'est ce qui rend l'écran vivant.",
    copies: [
      'provider', 'statusId', 'statusLabel', 'networkOperator', 'monthlyDataVolumeBytes',
      'monthlyDataLimitBytes', 'prevMonthDataVolumeBytes', 'inSessionSince', 'activationAt',
      'externalSyncedAt', 'createdAt', 'updatedAt',
    ],
    transformes: ['id', 'iccid', 'msisdn', 'imsi', 'imei', 'customField1', 'fleetId', 'trackerId'],
    imposes: ['providerId', 'apn', 'ipAddress', 'label', 'notes', 'rawProvider'],
  },

  Driver: {
    pourquoi: 'les conducteurs : identité tirée de listes, coordonnées et permis effacés ; le lien vers un compte est préservé côté démo, jamais copié',
    copies: ['color', 'isActive', 'createdAt', 'updatedAt'],
    transformes: ['id', 'fleetId', 'firstName', 'lastName'],
    imposes: ['phone', 'email', 'licenseNumber', 'notes', 'userId'],
  },
  VehicleGroup: {
    pourquoi:
      "les groupes de véhicules : la structure est conservée, le nom est REMPLACÉ — un nom de groupe est un nom de client (les dix-sept groupes de la société source sont les noms de ses foyers)",
    copies: ['createdAt'],
    transformes: ['id', 'name', 'fleetId'],
    imposes: [],
  },
  VehicleGroupAssignment: {
    pourquoi: 'appartenance véhicule → groupe',
    copies: [],
    transformes: ['vehicleId', 'groupId'],
    imposes: [],
  },
  Geofence: {
    pourquoi: 'les zones : géométrie et règles conservées, nom remplacé (un nom de zone désigne un site du client)',
    copies: [
      'type', 'rule', 'centerLat', 'centerLng', 'radiusMeters', 'polygonPoints', 'corridorPoints',
      'corridorWidthM', 'color', 'active', 'createdAt', 'updatedAt',
    ],
    transformes: ['id', 'fleetId', 'name'],
    imposes: [],
  },
  GeofenceVehicle: {
    pourquoi: 'rattachement zone → véhicule',
    copies: ['createdAt'],
    transformes: ['geofenceId', 'vehicleId'],
    imposes: [],
  },
  FleetPlace: {
    pourquoi: 'les lieux de la flotte : position conservée, nom remplacé (« Dépôt 1 »), note libre et auteur effacés',
    copies: ['kind', 'lat', 'lng', 'radiusM', 'createdAt', 'updatedAt'],
    transformes: ['id', 'fleetId', 'name', 'stationId'],
    imposes: ['note', 'createdById'],
  },
  VehicleSchedule: {
    pourquoi: 'plannings horaires du coupe-circuit : conservés — le planning coupe et rallume les faux boîtiers, comme en réel',
    copies: ['enabled', 'timezone', ...CHAMPS_JOURS, ...CHAMPS_CRENEAUX, 'countryCode', 'cutOnHolidays', 'customDates', 'createdAt', 'updatedAt'],
    transformes: ['id', 'vehicleId'],
    imposes: ['lastEvaluatedAt', 'lastEvaluatedState', 'overrideUntil'],
  },
  VehicleWorkSchedule: {
    pourquoi: 'cadres de temps de travail (usage mixte) : des réglages, conservés',
    copies: ['enabled', 'timezone', ...CHAMPS_JOURS, ...CHAMPS_CRENEAUX, 'countryCode', 'customDates', 'createdAt', 'updatedAt'],
    transformes: ['id', 'vehicleId'],
    imposes: [],
  },
  SurveillanceProfile: {
    pourquoi: 'profils de surveillance : réglages conservés, désarmés, destinataires (des comptes) effacés, auteur = compte système',
    copies: [
      'mode', 'sensitivity', 'scheduleStartTime', 'scheduleEndTime', 'scheduleDays', 'weekendPermanent',
      'triggerVibration', 'triggerMovement', 'triggerDoor', 'lastArmedAt', 'lastDisarmedAt', 'createdAt', 'updatedAt',
    ],
    transformes: ['id', 'vehicleId', 'fleetId'],
    imposes: ['additionalNotifyUserIds', 'currentlyArmed', 'createdBy'],
  },
  Trip: {
    pourquoi: "l'historique des trajets (fenêtre DEMO_TRIPS_MONTHS) : mesures et tracés conservés, notes et mission effacées",
    copies: [
      'startedAt', 'endedAt', 'durationSeconds', 'startLat', 'startLng', 'endLat', 'endLng', 'distanceKm',
      'distanceMeters', 'maxSpeed', 'avgSpeed', 'movingSeconds', 'positionCount', 'segmentationSource',
      'polyline', 'polylineMatched', 'driverSource', 'createdAt',
    ],
    transformes: ['id', 'vehicleId', 'trackerId', 'fleetId', 'driverId'],
    imposes: ['missionId', 'notes', 'notesUpdatedAt', 'notesUpdatedById'],
  },
  TripAnalysis: {
    pourquoi: "l'analyse de chaque trajet : chiffres conservés ; récit, conseil et détail assainis (une plaque ou un nom pourrait s'y glisser)",
    copies: [
      'distanceKm', 'durationSec', 'movingSec', 'avgSpeedKmh', 'maxSpeedKmh', 'stopCount', 'idleSec',
      'gpsPoints', 'gpsValidRatio', 'gpsLostCount', 'speedingCount', 'speedingSec', 'maxOverKmh',
      'limitsKnown', 'limitsCoverage', 'harshAccel', 'harshBrake', 'ecoScore', 'fuelLiters', 'co2Kg',
      'provider', 'trustScore', 'narratedAt', 'computedAt', 'updatedAt',
    ],
    transformes: ['id', 'tripId', 'fleetId', 'vehicleId', 'detail', 'narrative', 'advice'],
    imposes: [],
  },
  TripFuelStop: {
    pourquoi: 'passages en station détectés : la matière du rapport carburant',
    copies: ['arrivedAt', 'durationSec', 'lat', 'lng', 'distanceM', 'fuelType', 'unitPriceEur', 'createdAt'],
    transformes: ['id', 'tripId', 'fleetId', 'vehicleId', 'stationId'],
    imposes: [],
  },
  FuelFillUp: {
    pourquoi: 'pleins saisis : la calibration « méthode du plein » ; note et auteur effacés',
    copies: ['filledAt', 'litersFilled', 'amountPaidEur', 'fullTank', 'odometerKm', 'fuelType', 'createdAt', 'updatedAt'],
    transformes: ['id', 'fleetId', 'vehicleId', 'stationId'],
    imposes: ['note', 'createdByUserId'],
  },
  FuelStation: {
    pourquoi: 'stations-service : données PUBLIQUES (API carburant du gouvernement, OSM), copiées telles quelles, identifiants conservés',
    copies: ['id', 'source', 'externalId', 'brand', 'name', 'address', 'city', 'postalCode', 'lat', 'lng', 'createdAt', 'updatedAt'],
    transformes: [],
    imposes: [],
  },
  FuelStationPrice: {
    pourquoi: 'prix relevés en station : données publiques, copiées telles quelles',
    copies: ['id', 'stationId', 'fuelType', 'priceEur', 'sourceUpdatedAt', 'capturedAt'],
    transformes: [],
    imposes: [],
  },
  Alert: {
    pourquoi:
      "les alertes (fenêtre DEMO_TRIPS_MONTHS) : titre, message et charge utile assainis (ils citent la plaque ET la zone), l'acquitteur effacé, et l'acquittement REMIS À ZÉRO sur les sept derniers jours — sinon le centre d'alerte est vide, la source ayant tout acquitté",
    copies: ['type', 'severity', 'latitude', 'longitude', 'escalatedAt', 'createdAt'],
    transformes: ['id', 'fleetId', 'vehicleId', 'trackerId', 'tripId', 'title', 'message', 'payload', 'acknowledgedAt'],
    imposes: ['acknowledgedBy'],
  },
  Position: {
    pourquoi: 'les positions (fenêtre DEMO_POSITIONS_DAYS) : la matière du replay des trajets — un point GPS ne porte pas de nom',
    copies: ['lat', 'lng', 'speedKmh', 'heading', 'altitude', 'satellites', 'valid', 'ignition', 'timestamp', 'createdAt'],
    transformes: ['id', 'trackerId'],
    imposes: [],
  },
  DemoReplayFrame: {
    pourquoi: 'PRODUIT par l\'import, pas copié : la dernière semaine de positions, réindexée par jour de semaine et seconde locale',
    copies: [],
    transformes: ['id', 'imei', 'weekday', 'secondOfDay', 'lat', 'lng', 'speedKmh', 'heading', 'altitude', 'ignition', 'valid'],
    imposes: [],
  },
};

function exclure(raison: string, ...modeles: string[]): Record<string, string> {
  return Object.fromEntries(modeles.map((m) => [m, raison]));
}

/**
 * Tout ce qui n'est PAS copié, avec sa raison. Un modèle absent d'ici ET de l'allowlist fait
 * échouer `allowlist.spec.ts` — c'est voulu.
 */
export const EXCLUS: Readonly<Record<string, string>> = {
  ...exclure(
    "comptes et sécurité : jamais copiés — les comptes de démo sont créés à part (seed-demo) ; un prospect n'a pas à hériter des sessions, appareils, connexions ou consentements de qui que ce soit",
    'User', 'PushSubscription', 'Invitation', 'UserSession', 'UserActivity', 'UserConsent', 'LpConsent',
    'UserPermission', 'TrustedDevice', 'LoginEvent', 'UserVehicleAccess', 'NotificationPreference',
    'NotificationDelivery',
  ),
  ...exclure(
    'temps de travail des conducteurs : des données RH, nominatives par construction',
    'WorkTimeEntry',
  ),
  ...exclure(
    "journaux d'exploitation : trames brutes, erreurs, trafic, courriers, SMS, métriques — numéros, adresses IP et adresses e-mail ; la démo produit les siens",
    'WireLog', 'ErrorLog', 'DisparitionLignes', 'RefroidissementAlerte', 'SystemActivityLog', 'ApiTrafficLog',
    'SmsLog', 'PushLog', 'EmailLog', 'SystemMetric', 'RetentionSnapshot', 'BackupRun',
    'PositionSamplingDecision', 'PassageAgentLocal', 'TravailIaLocal', 'FleetReportDispatch',
  ),
  ...exclure(
    "IA : réglages, budgets, traces et conversations — les échanges d'assistance portent sur des données réelles, les analyses de lieux nomment des sites, les rapports d'activité nomment des comptes",
    'AiUsageLog', 'AiBudget', 'AiProviderSettings', 'AiSubscription', 'AiFeatureFlags', 'AiAgentTrace',
    'AssistanceConversation', 'AssistanceMessage', 'AgendaAgentSettings', 'AgendaAgentProposal', 'AgendaAgentRun',
    'PlaceAnalysis', 'PlaceAutomationSettings', 'PlaceAutomationRun', 'TripAutomationSettings', 'TripAutomationRun',
    'ActivityReport', 'ActivityReportSchedule',
  ),
  ...exclure(
    'caches de données publiques (géocodage inverse, limites de vitesse OSM) : la démo les reconstitue elle-même',
    'GeocodeCache', 'SpeedLimitCache',
  ),
  ...exclure(
    "commandes et boîtiers : historique des commandes, écoute audio, provisionnement SMS, diagnostics GPS — du matériel réel et des numéros ; la démo n'a ni l'un ni l'autre. La SIM, elle, est désormais importée pseudonymisée (cf. entrée `Sim`) : son absence faisait afficher « SIM manquante » sur les trente-sept véhicules, ce qu'un prospect lit comme une installation ratée.",
    'TrackerCommand', 'EngineControlCommand', 'AudioMonitoringCommand', 'FleetAudioConfig', 'TrackerProvisioning',
    'GpsDeadZone', 'GpsLossEvent', 'GpsZoneDiagnostic', 'ScheduleHistory', 'PrivacyModeEvent',
  ),
  ...exclure(
    'agenda, entretien et événements véhicule : hors périmètre v1 (décision du 2026-09-07, § 9 point 7)',
    'VehicleEvent', 'MaintenancePlan',
  ),
  ...exclure(
    'espace dépôt, missions et partages : hors périmètre v1 (décision du 2026-09-07, § 9 point 7) — noms de dépôts, adresses de livraison, devis, liens publics',
    'Mission', 'MissionShareLink', 'TripShareLink', 'MissionRequest', 'MissionStop', 'MissionStopRevision',
    'MissionQuoteRound', 'MissionPricingSettings', 'MissionPricingTier', 'ReservationBookingLink',
  ),
  ...exclure(
    'commercial et partenaires : tarifs, facturation, prospects, liens partenaires, installations — noms et coordonnées de clients',
    'PricingSettings', 'BillingSettings', 'Lead', 'PartnerLink', 'PartnerLinkEvent', 'PartnerAccessToken',
    'PartnerOutboxEvent', 'PartnerInvitation', 'InstallationPlan', 'InstallationTask', 'InstallationBookingLink',
    'InstallationBooking', 'InstallationSlotWatcher',
  ),
  ...exclure(
    "surveillance : événements horodatés et règles d'alerte propres à la société — la démo produit les siens",
    'SurveillanceEvent', 'AlertRule',
  ),
};
