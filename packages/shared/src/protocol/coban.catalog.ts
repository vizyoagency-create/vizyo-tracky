/**
 * Coban Command Catalog — V1
 *
 * 20 templates for GPS103/403 protocol family.
 *
 * IMPORTANT: engine_stop and engine_resume are INTENTIONALLY EXCLUDED.
 * Engine cut/restore is handled exclusively by EngineControlModule
 * which enforces critical safety guard rails (speed < 20 km/h, GPS valid,
 * position freshness < 60s, double UI confirmation, full audit trail).
 * Do NOT add engine commands here — redirect users to /engine-control.
 */

import { encodeCommand } from './coban.encoder';

export type CobanCommandCategory =
  | 'config_initial'
  | 'reporting'
  | 'alarm'
  | 'geofence'
  | 'power'
  | 'info'
  | 'custom';

export interface CommandParamSpec {
  name: string;
  label: string;
  type: 'number' | 'string' | 'select' | 'duration' | 'latlng';
  required: boolean;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  validate?: (value: unknown) => string | null;
}

export interface CobanCommandTemplate {
  id: string;
  category: CobanCommandCategory;
  label: string;
  description: string;
  requiresSuperAdmin: boolean;
  requiresConfirmation: boolean;
  dangerous: boolean;
  params: CommandParamSpec[];
  buildPayload: (imei: string, params: Record<string, unknown>) => string;
  /**
   * TRK-012 — enveloppe TCP quand elle diffère de la forme SMS. Les deux canaux n'ont
   * pas la même grammaire : `buildPayload` est la forme texte SMS (mot de passe inclus),
   * `buildTcpPayload` la trame `**,imei:<IMEI>,…;` que le parseur TCP du Coban lit.
   * Absent = `buildPayload` vaut pour les deux (cas des trames déjà en `**,imei:`).
   */
  buildTcpPayload?: (imei: string, params: Record<string, unknown>) => string;
  expectedAckPattern: RegExp;
  ackTimeoutMs: number;
  availableVia: ('tcp' | 'sms')[];
}

function tcpWrap(imei: string, code: string): string {
  return `**,imei:${imei},${code};`;
}

// V1.16 (audit D2/E1) — bornes de sanitisation du template `raw`.
const RAW_PAYLOAD_MAX_LEN = 120;
// Charset autorisé : alphanum + espace + , . * + - . Exclut ":" (donc pas
// d'override "imei:") et ";" / CR / LF (donc pas d'injection de trame).
const RAW_PAYLOAD_ALLOWED = /^[A-Za-z0-9 ,.*+\-]+$/;

// TRK-012 — '005m'/'030s' (forme SMS à trois chiffres) → secondes. L'enveloppe TCP
// repasse ensuite par formatFrequency (DEUX chiffres, fidèle au `%02d` de Traccar) :
// reprendre la forme du catalogue telle quelle dans la trame TCP reproduirait le
// défaut sous une autre forme (REFERENCE-ERREURS.md § TRK-012, 2026-08-11).
function intervalParamToSeconds(interval: string): number {
  const m = /^(\d{1,3})([sm])$/.exec(interval);
  if (!m) throw new Error(`Intervalle Coban illisible: "${interval}"`);
  return m[2] === 'm' ? Number(m[1]) * 60 : Number(m[1]);
}

export const COBAN_COMMAND_CATALOG: CobanCommandTemplate[] = [
  // ─── INFO ───
  {
    id: 'status',
    category: 'info',
    label: 'Statut',
    description: 'Demander le statut du tracker (batterie, GPS, GSM)',
    requiresSuperAdmin: false,
    requiresConfirmation: false,
    dangerous: false,
    params: [],
    buildPayload: (imei) => tcpWrap(imei, 'B'),
    expectedAckPattern: /imei:\d{15},(tracker|[A-Z])/i,
    ackTimeoutMs: 30000,
    availableVia: ['tcp', 'sms'],
  },
  {
    id: 'position_single',
    category: 'info',
    label: 'Position unique',
    description: 'Demander une position GPS immédiate',
    requiresSuperAdmin: false,
    requiresConfirmation: false,
    dangerous: false,
    params: [],
    buildPayload: (imei) => tcpWrap(imei, 'B'),
    expectedAckPattern: /imei:\d{15},/i,
    ackTimeoutMs: 30000,
    availableVia: ['tcp', 'sms'],
  },

  // ─── POWER ───
  {
    id: 'reset',
    category: 'power',
    label: 'Reset',
    description: 'Redémarrer le module GSM/GPS du tracker',
    requiresSuperAdmin: false,
    requiresConfirmation: true,
    dangerous: true,
    params: [],
    buildPayload: () => 'reset123456',
    expectedAckPattern: /reset\s*ok/i,
    ackTimeoutMs: 30000,
    availableVia: ['sms'],
  },
  {
    id: 'factory',
    category: 'power',
    label: 'Factory reset',
    description: 'Réinitialiser le tracker aux paramètres usine. ATTENTION: toute la config sera perdue!',
    requiresSuperAdmin: true,
    requiresConfirmation: true,
    dangerous: true,
    params: [],
    buildPayload: () => 'factory123456',
    expectedAckPattern: /factory\s*ok/i,
    ackTimeoutMs: 30000,
    availableVia: ['sms'],
  },
  {
    id: 'sleep_on',
    category: 'power',
    label: 'Mode veille ON',
    description: 'Activer le mode veille (économie batterie)',
    requiresSuperAdmin: false,
    requiresConfirmation: false,
    dangerous: false,
    params: [],
    buildPayload: () => 'sleep123456 on',
    expectedAckPattern: /sleep.*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },
  {
    id: 'sleep_off',
    category: 'power',
    label: 'Mode veille OFF',
    description: 'Désactiver le mode veille',
    requiresSuperAdmin: false,
    requiresConfirmation: false,
    dangerous: false,
    params: [],
    buildPayload: () => 'sleep123456 off',
    expectedAckPattern: /sleep.*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },

  // ─── REPORTING ───
  {
    id: 'fix_continuous',
    category: 'reporting',
    label: 'Position continue',
    description: 'Configurer l\'envoi continu de positions à intervalle fixe',
    requiresSuperAdmin: false,
    requiresConfirmation: false,
    dangerous: false,
    params: [
      {
        name: 'interval',
        label: 'Intervalle',
        type: 'select',
        required: true,
        options: [
          // V1.13 — 10s ajoute comme intervalle haute precision (MOVING par defaut).
          // Le minimum Coban officiel varie par modele : 10s pour GPS302/303/408/BN-311,
          // 20s pour TK104/GPS305/GPS403D. Le boitier rejettera la commande si trop bas
          // pour son modele — reconcile detectera et passera FAILING.
          //
          // ⚠️ TRK-045 (2026-08-24) — LES TROIS OPTIONS EN MINUTES ONT ETE RETIREES.
          // `2 minutes`, `5 minutes` et `10 minutes` partaient en `,C,02m;`, `,C,05m;` et
          // `,C,10m;`. Le firmware de ce parc lit DEUX CHIFFRES et JETTE la lettre
          // d'unite : l'operateur qui choisissait « 10 minutes » pour economiser la
          // batterie obtenait **10 SECONDES**, soit 60 fois plus de trafic. Mesure sur
          // 38 boitiers ; 28 d'entre eux etaient a 4-6 s le 2026-08-24.
          //
          // Le plafond exprimable est 99 s (TCP_MAX_FREQUENCY_S) : un troisieme chiffre
          // casse l'analyse du firmware, qui retombe alors sur son defaut de 60 s (mesure
          // au canari le 2026-08-24 avec `,C,300s;`). Ne RIEN ajouter ici au-dela de
          // `099s` — le test « ne propose plus AUCUN intervalle inexprimable » le verrouille.
          { value: '010s', label: '10 secondes' },
          { value: '020s', label: '20 secondes (minimum GPS403D)' },
          { value: '030s', label: '30 secondes' },
          { value: '060s', label: '1 minute' },
          { value: '099s', label: '99 secondes (maximum du boîtier)' },
        ],
      },
    ],
    buildPayload: (_imei, params) => `fix${params['interval'] as string}***n123456`,
    // TRK-012 — la trame TCP n'est PAS la forme SMS : 4 120 commandes au format texte
    // émises sur la socket depuis le 2026-04-27, 0 réponse. Le parseur TCP attend
    // `**,imei:<IMEI>,C,05m;` — fréquence sur DEUX chiffres (Traccar `%02d`).
    buildTcpPayload: (imei, params) =>
      encodeCommand(imei, {
        type: 'position_periodic',
        frequencySeconds: intervalParamToSeconds(params['interval'] as string),
      }),
    expectedAckPattern: /fix.*ok/i,
    ackTimeoutMs: 15000,
    // Disponible via TCP (canal descendant deja ouvert par le boitier) ET SMS.
    // Utilise par le pilotage adaptatif fix mode (Sprint H3).
    availableVia: ['sms', 'tcp'],
  },
  {
    id: 'fix_stop',
    category: 'reporting',
    label: 'Arrêter les positions',
    description: 'Arrêter l\'envoi automatique de positions',
    requiresSuperAdmin: false,
    requiresConfirmation: true,
    dangerous: false,
    params: [],
    buildPayload: () => 'nofix123456',
    expectedAckPattern: /nofix\s*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },
  {
    id: 'less_gprs_on',
    category: 'reporting',
    label: 'Less GPRS ON',
    description: 'Activer le mode économie GPRS (envoi réduit)',
    requiresSuperAdmin: false,
    requiresConfirmation: false,
    dangerous: false,
    params: [],
    buildPayload: () => 'less gprs123456 on',
    expectedAckPattern: /less gprs.*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },
  {
    id: 'less_gprs_off',
    category: 'reporting',
    label: 'Less GPRS OFF',
    description: 'Désactiver le mode économie GPRS',
    requiresSuperAdmin: false,
    requiresConfirmation: false,
    dangerous: false,
    params: [],
    buildPayload: () => 'less gprs123456 off',
    expectedAckPattern: /less gprs.*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },

  // ─── ALARM ───
  {
    id: 'speed_alarm',
    category: 'alarm',
    label: 'Alarme vitesse',
    description: 'Configurer une alarme de dépassement de vitesse',
    requiresSuperAdmin: false,
    requiresConfirmation: false,
    dangerous: false,
    params: [
      {
        name: 'speed_kmh',
        label: 'Vitesse max (km/h)',
        type: 'number',
        required: true,
        min: 20,
        max: 200,
      },
    ],
    buildPayload: (_imei, params) => {
      const speed = String(params['speed_kmh']).padStart(3, '0');
      return `speed123456 ${speed}`;
    },
    expectedAckPattern: /speed\s*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },
  {
    id: 'move_alarm',
    category: 'alarm',
    label: 'Alarme mouvement',
    description: 'Alerter si le véhicule bouge (mode parking)',
    requiresSuperAdmin: false,
    requiresConfirmation: false,
    dangerous: false,
    params: [],
    buildPayload: () => 'move123456',
    expectedAckPattern: /move\s*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },

  // ─── SURVEILLANCE MAX (V1.6) ───
  // Templates dédiés au module SurveillanceMax. Envoyés via SMS car les
  // commandes shock/sensitivity/noshock ne sont pas supportées sur le canal
  // TCP descendant de la famille GPS103/403 — les ACK reviennent par SMS.
  {
    id: 'shock_on',
    category: 'alarm',
    label: 'Activer détection vibration',
    description: 'Arme le capteur de choc. Le tracker émettra une alarme `vibration` lors d\'un secouage.',
    requiresSuperAdmin: false,
    requiresConfirmation: false,
    dangerous: false,
    params: [],
    buildPayload: () => 'shock123456',
    expectedAckPattern: /shock\s*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },
  {
    id: 'shock_off',
    category: 'alarm',
    label: 'Désactiver détection vibration',
    description: 'Désarme le capteur de choc.',
    requiresSuperAdmin: false,
    requiresConfirmation: false,
    dangerous: false,
    params: [],
    buildPayload: () => 'noshock123456',
    expectedAckPattern: /noshock\s*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },
  {
    id: 'sensitivity',
    category: 'alarm',
    label: 'Sensibilité capteur de choc',
    description: 'Niveau 1 = vibration légère, 2 = ~8 vibrations/2s, 3 = ~25 vibrations/5s.',
    requiresSuperAdmin: false,
    requiresConfirmation: false,
    dangerous: false,
    params: [
      {
        name: 'level',
        label: 'Niveau',
        type: 'select',
        required: true,
        options: [
          { value: '1', label: '1 — Faible (haute sensibilité)' },
          { value: '2', label: '2 — Moyen (recommandé)' },
          { value: '3', label: '3 — Élevé (basse sensibilité)' },
        ],
      },
    ],
    buildPayload: (_imei, params) => `sensitivity123456 ${params['level']}`,
    expectedAckPattern: /sensitivity\s*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },

  // ─── GEOFENCE ───
  {
    id: 'stockade_set',
    category: 'geofence',
    label: 'Geofence rectangulaire',
    description: 'Définir une zone rectangulaire (alerte si sortie)',
    requiresSuperAdmin: false,
    requiresConfirmation: false,
    dangerous: false,
    params: [
      { name: 'lat1', label: 'Latitude coin 1', type: 'number', required: true, min: -90, max: 90 },
      { name: 'lng1', label: 'Longitude coin 1', type: 'number', required: true, min: -180, max: 180 },
      { name: 'lat2', label: 'Latitude coin 2', type: 'number', required: true, min: -90, max: 90 },
      { name: 'lng2', label: 'Longitude coin 2', type: 'number', required: true, min: -180, max: 180 },
    ],
    buildPayload: (_imei, params) =>
      `stockade123456 ${params['lat1']},${params['lng1']};${params['lat2']},${params['lng2']}`,
    expectedAckPattern: /stockade\s*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },
  {
    id: 'stockade_clear',
    category: 'geofence',
    label: 'Supprimer geofence',
    description: 'Supprimer la geofence rectangulaire active',
    requiresSuperAdmin: false,
    requiresConfirmation: true,
    dangerous: false,
    params: [],
    buildPayload: () => 'nostockade123456',
    expectedAckPattern: /nostockade\s*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },

  // ─── CONFIG INITIAL ───
  {
    id: 'time_zone',
    category: 'config_initial',
    label: 'Fuseau horaire',
    description: 'Configurer le fuseau horaire du tracker',
    requiresSuperAdmin: false,
    requiresConfirmation: false,
    dangerous: false,
    params: [
      { name: 'offset', label: 'Offset UTC (-12 à +12)', type: 'number', required: true, min: -12, max: 12 },
    ],
    buildPayload: (_imei, params) => `time zone123456,${params['offset']}`,
    expectedAckPattern: /time zone\s*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },
  {
    id: 'apn',
    category: 'config_initial',
    label: 'APN',
    description: 'Configurer l\'APN de la carte SIM',
    requiresSuperAdmin: true,
    requiresConfirmation: true,
    dangerous: true,
    params: [
      { name: 'apn', label: 'Nom APN', type: 'string', required: true },
      { name: 'user', label: 'Utilisateur', type: 'string', required: false },
      { name: 'pass', label: 'Mot de passe', type: 'string', required: false },
    ],
    buildPayload: (_imei, params) => {
      const parts = [params['apn'] as string];
      if (params['user']) parts.push(params['user'] as string);
      if (params['pass']) parts.push(params['pass'] as string);
      return `apn123456 ${parts.join(',')}`;
    },
    expectedAckPattern: /APN\s*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },
  {
    id: 'adminip',
    category: 'config_initial',
    label: 'IP serveur',
    description: 'Configurer l\'adresse IP et le port du serveur Tracky',
    requiresSuperAdmin: true,
    requiresConfirmation: true,
    dangerous: true,
    params: [
      { name: 'ip', label: 'Adresse IP', type: 'string', required: true },
      { name: 'port', label: 'Port', type: 'number', required: true, min: 1, max: 65535 },
    ],
    buildPayload: (_imei, params) => `adminip123456 ${params['ip']} ${params['port']}`,
    expectedAckPattern: /adminip\s*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },
  {
    id: 'password_change',
    category: 'config_initial',
    label: 'Changer mot de passe',
    description: 'Changer le mot de passe du tracker (6 chiffres)',
    requiresSuperAdmin: true,
    requiresConfirmation: true,
    dangerous: true,
    params: [
      {
        name: 'new_pass',
        label: 'Nouveau mot de passe (6 chiffres)',
        type: 'string',
        required: true,
        validate: (v) => /^\d{6}$/.test(String(v)) ? null : 'Doit être exactement 6 chiffres',
      },
    ],
    buildPayload: (_imei, params) => `password123456 ${params['new_pass']}`,
    expectedAckPattern: /password\s*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },
  {
    id: 'protocol_18',
    category: 'config_initial',
    label: 'Protocol 18',
    description: 'Activer le protocole enrichi (ACC, porte, carburant, température)',
    requiresSuperAdmin: true,
    requiresConfirmation: false,
    dangerous: false,
    params: [],
    buildPayload: () => 'protocol123456 18',
    expectedAckPattern: /protocol18\s*ok/i,
    ackTimeoutMs: 15000,
    availableVia: ['sms'],
  },

  // ─── CUSTOM / RAW ───
  {
    id: 'raw',
    category: 'custom',
    label: 'Commande brute',
    description: 'Envoyer une commande brute. AUCUNE VALIDATION. Peut rendre le tracker inutilisable.',
    requiresSuperAdmin: true,
    requiresConfirmation: true,
    dangerous: true,
    params: [
      {
        name: 'raw_payload',
        label: 'Payload brut',
        type: 'string',
        required: true,
        // V1.16 (audit D2/E1) — sanitisation : pas d'override "imei:", pas de
        // ";"/saut de ligne (injection de trame), charset restreint, longueur cap.
        validate: (value: unknown) => {
          if (typeof value !== 'string') return 'raw_payload doit être une chaîne';
          const v = value.trim();
          if (v.length === 0) return 'raw_payload vide';
          if (v.length > RAW_PAYLOAD_MAX_LEN) return `raw_payload trop long (max ${RAW_PAYLOAD_MAX_LEN})`;
          if (/[;\r\n]/.test(v)) return 'raw_payload ne doit pas contenir ";" ni saut de ligne';
          if (/imei:/i.test(v)) return 'raw_payload ne peut pas surcharger "imei:" (toujours envoyé au tracker ciblé)';
          if (!RAW_PAYLOAD_ALLOWED.test(v)) return 'raw_payload contient des caractères non autorisés';
          return null;
        },
      },
      { name: 'ack_pattern', label: 'Pattern ACK (regex)', type: 'string', required: false },
    ],
    buildPayload: (imei, params) => {
      // V1.16 (audit D2/E1) — TOUJOURS ré-encapsuler sur l'IMEI résolu (jamais de
      // frame verbatim ni override "imei:"). Defense-in-depth : on re-nettoie même
      // si `validate` a déjà filtré le param en amont (cf. tracker-commands.service).
      const raw = String(params['raw_payload'] ?? '').replace(/[;\r\n]/g, '').trim();
      return tcpWrap(imei, raw);
    },
    expectedAckPattern: /.+/,
    ackTimeoutMs: 30000,
    availableVia: ['tcp', 'sms'],
  },
];

export function findTemplate(id: string): CobanCommandTemplate | undefined {
  return COBAN_COMMAND_CATALOG.find((t) => t.id === id);
}

export function getCatalogByCategory(): Record<string, CobanCommandTemplate[]> {
  const grouped: Record<string, CobanCommandTemplate[]> = {};
  for (const tpl of COBAN_COMMAND_CATALOG) {
    if (!grouped[tpl.category]) grouped[tpl.category] = [];
    grouped[tpl.category]!.push(tpl);
  }
  return grouped;
}

export const CATEGORY_LABELS: Record<CobanCommandCategory, string> = {
  info: 'Information',
  power: 'Alimentation',
  reporting: 'Reporting',
  alarm: 'Alarmes',
  geofence: 'Geofence',
  config_initial: 'Configuration',
  custom: 'Personnalisé',
};
