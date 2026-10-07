#!/usr/bin/env node
/**
 * ÉCOUTE TELTONIKA — outil de terrain JETABLE
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * Écouteur TCP autonome pour valider, depuis le véhicule, qu'un boîtier Teltonika FMB/FMC
 * traverse toute la chaîne : APN → réseau opérateur → pare-feu → TCP → handshake → AVL.
 *
 *   node outils/ecoute-teltonika.mjs --port 5027
 *   node outils/ecoute-teltonika.mjs --port 5027 --host 0.0.0.0 --hex-max 2048
 *
 * ⚠️ CE N'EST PAS DU CODE DE PRODUCTION.
 *   - ZÉRO dépendance npm, UN SEUL fichier, rien d'importé depuis Tracky et rien qui
 *     importe ce fichier.
 *   - Il n'écrit dans AUCUNE base, n'ouvre AUCUN port partagé avec Tracky.
 *   - Il ne plante jamais sur une trame malformée : il journalise et continue.
 *   - Priorité à la lisibilité et à la robustesse, pas à l'élégance.
 *
 * Ce qu'il fait, et rien d'autre :
 *   1. accepte le handshake  : 2 octets de longueur + IMEI ASCII  → répond 1 octet 0x01
 *   2. accepte les paquets AVL Codec 8 (0x08) et Codec 8 Extended (0x8E)
 *                                                → répond 4 octets BE = nb d'enregistrements
 *   3. déballe chaque enregistrement et imprime tout ce qu'il contient
 *
 * Référence protocole : https://wiki.teltonika-gps.com/view/Codec
 * Structures et CRC vérifiés le 2026-09-27 contre les trames d'exemple officielles
 * (Codec 12 « getinfo » → CRC 0x4312 ; Codec 8E → CRC 0x2994).
 */

import net from 'node:net';

// ─────────────────────────────────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────────────────────────────────

const arg = (nom, defaut) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
};

const PORT = Number(arg('port', ''));
const HOTE = arg('host', '0.0.0.0');
/** Nombre max d'octets imprimés dans le dump hexadécimal d'une trame (0 = tout). */
const HEX_MAX = Number(arg('hex-max', '512'));

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('Usage : node outils/ecoute-teltonika.mjs --port <1-65535> [--host 0.0.0.0] [--hex-max 512]');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Journalisation
// ─────────────────────────────────────────────────────────────────────────────────────────

const horodate = () => {
  const d = new Date();
  const p = (x, n = 2) => String(x).padStart(n, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

let compteurConnexion = 0;

/** Chaque ligne porte l'heure et l'étiquette de la session : deux boîtiers restent lisibles. */
const journal = (session, ...morceaux) => {
  console.log(`[${horodate()}] [${session}]`, ...morceaux);
};

/** Dump hexadécimal classique : offset | 16 octets | colonne ASCII. */
function dumpHex(buffer, prefixe = '    ') {
  const limite = HEX_MAX > 0 ? Math.min(buffer.length, HEX_MAX) : buffer.length;
  const lignes = [];
  for (let i = 0; i < limite; i += 16) {
    const tranche = buffer.subarray(i, Math.min(i + 16, limite));
    const hex = [...tranche].map((o) => o.toString(16).padStart(2, '0')).join(' ');
    const texte = [...tranche].map((o) => (o >= 0x20 && o <= 0x7e ? String.fromCharCode(o) : '.')).join('');
    lignes.push(`${prefixe}${String(i).padStart(4, '0')}  ${hex.padEnd(47)}  |${texte}|`);
  }
  if (limite < buffer.length) {
    lignes.push(`${prefixe}… ${buffer.length - limite} octet(s) de plus (--hex-max pour en voir davantage)`);
  }
  return lignes.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// CRC-16/ARC (dit aussi CRC-16/IBM dans la doc Teltonika)
// polynôme 0xA001 (réfléchi), init 0x0000, sans XOR final.
// Vérifié sur les deux trames d'exemple officielles.
// ─────────────────────────────────────────────────────────────────────────────────────────

function crc16Arc(buffer) {
  let crc = 0x0000;
  for (const octet of buffer) {
    crc ^= octet;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Annotation des IO elements
//
// ⚠️ HONNÊTETÉ SUR CE TABLEAU : seuls les identifiants ci-dessous ont été confirmés sur le
// wiki Teltonika le 2026-09-27. Le tableau complet des IO du CAN-CONTROL n'est PAS exposé
// publiquement. C'est pourquoi la détection du VIN plus bas se fait PAR LA FORME de la
// valeur (17 caractères du jeu VIN) et non par un identifiant : elle fonctionne même si
// l'ID diffère, et elle AFFICHE l'ID trouvé — c'est précisément ce que cette sortie
// terrain doit nous apprendre pour la suite du chantier.
// ─────────────────────────────────────────────────────────────────────────────────────────

const IO_CONNUS = {
  16: 'Odomètre total',
  21: 'Qualité du signal GSM',
  24: 'Vitesse',
  68: 'Courant batterie',
  113: 'Niveau de batterie (%)',
  239: 'Contact (ignition)',
  240: 'Mouvement',
  241: 'Opérateur GSM actif',
  833: 'CAN — distance totale',
  835: 'CAN — vitesse véhicule',
  949: 'CAN — régime moteur',
  1002: 'CAN — température liquide de refroidissement',
};

/** Plages d'identifiants où vivent les données de bus CAN (wiki Teltonika, 27/09/2026). */
const PLAGES_CAN = [
  [801, 838, 'CAN BOSCH'],
  [900, 929, 'CAN manuel'],
  [930, 1012, 'CAN J1939'],
  [1100, 1125, 'CAN BOSCH (suite)'],
];

function annoterIo(id) {
  if (IO_CONNUS[id]) return IO_CONNUS[id];
  for (const [bas, haut, nom] of PLAGES_CAN) {
    if (id >= bas && id <= haut) return `${nom} (identifiant non nommé ici)`;
  }
  return null;
}

const estDansPlageCan = (id) => PLAGES_CAN.some(([bas, haut]) => id >= bas && id <= haut);

/**
 * Un VIN fait 17 caractères, en majuscules et chiffres, SANS les lettres I, O et Q
 * (exclues par la norme ISO 3779 justement pour éviter la confusion avec 1 et 0).
 * On le reconnaît donc sans connaître son identifiant.
 */
function ressembleAUnVin(valeur) {
  if (!Buffer.isBuffer(valeur) || valeur.length !== 17) return false;
  const texte = valeur.toString('latin1');
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(texte);
}

/** Rend le texte si la valeur est entièrement imprimable, sinon null. */
function commeTexte(valeur) {
  const texte = valeur.toString('latin1');
  return /^[\x20-\x7e]+$/.test(texte) ? texte : null;
}

/** Entier non signé big-endian, pour les tailles 1/2/4/8. Rendu en BigInt pour le 8 octets. */
function entierNonSigne(valeur) {
  if (valeur.length === 0 || valeur.length > 8) return null;
  let n = 0n;
  for (const octet of valeur) n = (n << 8n) | BigInt(octet);
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Lecteur borné : toute lecture hors limites lève une erreur NOMMÉE plutôt que de rendre
// des octets faux. C'est ce qui garantit qu'une trame tronquée se journalise au lieu de
// produire une position absurde.
// ─────────────────────────────────────────────────────────────────────────────────────────

class Lecteur {
  constructor(buffer) {
    this.buf = buffer;
    this.pos = 0;
  }

  verifier(n, quoi) {
    if (this.pos + n > this.buf.length) {
      throw new Error(`trame tronquée : ${n} octet(s) attendu(s) pour « ${quoi} » à l'offset ${this.pos}, ` +
        `il n'en reste que ${this.buf.length - this.pos}`);
    }
  }

  u8(quoi) { this.verifier(1, quoi); return this.buf[this.pos++]; }
  u16(quoi) { this.verifier(2, quoi); const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  u32(quoi) { this.verifier(4, quoi); const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
  i16(quoi) { this.verifier(2, quoi); const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  i32(quoi) { this.verifier(4, quoi); const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  u64(quoi) { this.verifier(8, quoi); const v = this.buf.readBigUInt64BE(this.pos); this.pos += 8; return v; }
  octets(n, quoi) { this.verifier(n, quoi); const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  get reste() { return this.buf.length - this.pos; }
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Décodage d'un enregistrement AVL
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Codec 8 vs Codec 8 Extended — LA source d'erreur classique :
 *   passent de 1 à 2 octets : Event IO ID, Total IO, CHAQUE compteur N1/N2/N4/N8 et
 *                             CHAQUE identifiant d'IO ;
 *   la catégorie NX (valeurs de longueur variable) n'existe QUE en 8E — c'est là
 *   qu'arrivent le VIN et les valeurs CAN longues ;
 *   restent à 1 octet : le Codec ID, et Number of Data 1 / 2 (le nombre d'enregistrements).
 */
function lireEnregistrement(lecteur, estEtendu) {
  const msDepuisEpoch = lecteur.u64('horodatage');
  const priorite = lecteur.u8('priorité');

  const longitude = lecteur.i32('longitude') / 1e7;
  const latitude = lecteur.i32('latitude') / 1e7;
  const altitude = lecteur.i16('altitude');
  const cap = lecteur.u16('cap');
  const satellites = lecteur.u8('satellites');
  const vitesse = lecteur.u16('vitesse');

  const evenementIoId = estEtendu ? lecteur.u16('event IO id') : lecteur.u8('event IO id');
  const totalIo = estEtendu ? lecteur.u16('total IO') : lecteur.u8('total IO');

  const ios = [];
  for (const taille of [1, 2, 4, 8]) {
    const nb = estEtendu ? lecteur.u16(`compteur N${taille}`) : lecteur.u8(`compteur N${taille}`);
    for (let i = 0; i < nb; i += 1) {
      const id = estEtendu ? lecteur.u16(`id IO (N${taille})`) : lecteur.u8(`id IO (N${taille})`);
      ios.push({ id, taille, valeur: lecteur.octets(taille, `valeur IO ${id}`), variable: false });
    }
  }

  // Catégorie NX : exclusive au Codec 8 Extended.
  if (estEtendu) {
    const nbX = lecteur.u16('compteur NX');
    for (let i = 0; i < nbX; i += 1) {
      const id = lecteur.u16('id IO (NX)');
      const longueur = lecteur.u16(`longueur IO ${id}`);
      ios.push({ id, taille: longueur, valeur: lecteur.octets(longueur, `valeur IO ${id}`), variable: true });
    }
  }

  return {
    date: new Date(Number(msDepuisEpoch)),
    priorite,
    latitude,
    longitude,
    altitude,
    cap,
    satellites,
    vitesse,
    evenementIoId,
    totalIo,
    ios,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Impression d'un enregistrement
// ─────────────────────────────────────────────────────────────────────────────────────────

function imprimerEnregistrement(session, index, total, enr) {
  const fix = enr.satellites > 0;
  journal(session, `  ── enregistrement ${index + 1}/${total} ──`);
  journal(session, `     horodatage boîtier : ${enr.date.toISOString()} (UTC)  · priorité ${enr.priorite}`);
  journal(session, `     position           : lat ${enr.latitude.toFixed(6)}  lng ${enr.longitude.toFixed(6)}`);
  journal(session, `     altitude ${enr.altitude} m · cap ${enr.cap}° · vitesse ${enr.vitesse} km/h · ${enr.satellites} satellite(s)`);

  if (!fix) {
    // Ce cas mérite d'être crié : la trame d'exemple de la doc officielle est exactement
    // celle-là. « vitesse 0 » sans satellite ne veut PAS dire « véhicule à l'arrêt », ça
    // veut dire « je ne sais pas ». Confondre les deux, c'est autoriser un blocage moteur
    // sur un véhicule en mouvement.
    journal(session, '     ⚠️  AUCUN FIX GPS (0 satellite) — la vitesse 0 et la position 0/0 ne');
    journal(session, '         signifient PAS « à l\'arrêt », elles signifient « inconnu ».');
  }
  if (enr.evenementIoId !== 0) {
    journal(session, `     déclencheur        : IO ${enr.evenementIoId}` +
      (annoterIo(enr.evenementIoId) ? ` (${annoterIo(enr.evenementIoId)})` : ''));
  }

  journal(session, `     ${enr.ios.length} IO element(s) sur ${enr.totalIo} annoncé(s) :`);
  if (enr.ios.length !== enr.totalIo) {
    journal(session, `     ⚠️  écart entre le nombre annoncé (${enr.totalIo}) et le nombre lu (${enr.ios.length})`);
  }

  const trouves = { vin: [], can: [], variables: [] };

  for (const io of enr.ios) {
    const hex = io.valeur.toString('hex');
    const entier = entierNonSigne(io.valeur);
    const note = annoterIo(io.id);
    const texte = commeTexte(io.valeur);

    const morceaux = [`       IO ${String(io.id).padStart(5)} · ${String(io.taille).padStart(3)} o · 0x${hex}`];
    if (entier !== null && !io.variable) morceaux.push(`= ${entier}`);
    if (io.taille === 1 && (io.valeur[0] === 0 || io.valeur[0] === 1)) {
      morceaux.push(io.valeur[0] === 1 ? '(actif)' : '(inactif)');
    }
    if (texte && (io.variable || io.taille > 4)) morceaux.push(`« ${texte} »`);
    if (note) morceaux.push(`— ${note}`);
    if (io.variable) morceaux.push('— [NX, longueur variable]');
    journal(session, morceaux.join(' '));

    if (ressembleAUnVin(io.valeur)) trouves.vin.push({ id: io.id, vin: io.valeur.toString('latin1') });
    if (estDansPlageCan(io.id)) trouves.can.push(io.id);
    if (io.variable) trouves.variables.push(io.id);
  }

  // ── Ce que l'installateur attend de voir ───────────────────────────────────────────────
  if (trouves.vin.length > 0) {
    for (const { id, vin } of trouves.vin) {
      journal(session, `     ✅ VIN DÉTECTÉ : ${vin}   (identifiant IO ${id})`);
      journal(session, `        → noter cet identifiant : c'est celui du FMC130 + CAN-CONTROL sur ce véhicule.`);
    }
  } else {
    journal(session, '     ⭕ aucun VIN dans cet enregistrement (17 caractères du jeu VIN recherchés).');
  }

  if (trouves.can.length > 0) {
    journal(session, `     ✅ DONNÉES CAN DÉTECTÉES : IO ${[...new Set(trouves.can)].join(', ')}`);
  } else {
    journal(session, '     ⭕ aucun IO dans les plages CAN connues (801-838, 900-929, 930-1012, 1100-1125).');
  }

  if (trouves.variables.length > 0) {
    journal(session, `     ℹ️  ${trouves.variables.length} IO de longueur variable (catégorie NX, exclusive au Codec 8E) :`);
    journal(session, `        IO ${[...new Set(trouves.variables)].join(', ')} — c'est là que vivent VIN, codes défaut et CAN long.`);
  } else if (enr.ios.length > 0) {
    journal(session, "     ℹ️  aucun IO de longueur variable. Si le VIN manque, vérifier que le boîtier est");
    journal(session, '        bien en Codec 8 EXTENDED (0x8E) et que le CAN-CONTROL a le bon numéro de programme.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Traitement d'un paquet AVL complet
// ─────────────────────────────────────────────────────────────────────────────────────────

/** @returns {number} le nombre d'enregistrements à acquitter (0 = ne pas acquitter). */
function traiterPaquetAvl(session, trame, longueurChamp) {
  const couvert = trame.subarray(8, 8 + longueurChamp);
  const crcLu = trame.readUInt32BE(8 + longueurChamp) & 0xffff;
  const crcCalcule = crc16Arc(couvert);
  const crcBon = crcLu === crcCalcule;

  const codecId = couvert[0];
  const nomCodec =
    codecId === 0x08 ? 'Codec 8' : codecId === 0x8e ? 'Codec 8 Extended' : `INCONNU (0x${codecId.toString(16)})`;
  const nbAnnonce = couvert[1];

  journal(session, `paquet AVL : ${trame.length} octets · ${nomCodec} · ${nbAnnonce} enregistrement(s) annoncé(s)`);
  journal(session, `  CRC-16 : lu 0x${crcLu.toString(16).padStart(4, '0')} / calculé 0x${crcCalcule.toString(16).padStart(4, '0')} — ` +
    (crcBon ? '✅ concorde' : '❌ DIVERGE'));
  journal(session, `  trame brute :\n${dumpHex(trame)}`);

  if (!crcBon) {
    journal(session, '  ❌ CRC faux : paquet REFUSÉ (acquittement 0). Le boîtier le réémettra — c\'est voulu.');
    return 0;
  }
  if (codecId !== 0x08 && codecId !== 0x8e) {
    journal(session, `  ❌ codec non géré par cet outil (0x${codecId.toString(16)}) : paquet refusé.`);
    return 0;
  }

  const estEtendu = codecId === 0x8e;
  const lecteur = new Lecteur(couvert);
  lecteur.u8('codec id');
  lecteur.u8('nombre de données 1');

  let lus = 0;
  for (let i = 0; i < nbAnnonce; i += 1) {
    try {
      const enr = lireEnregistrement(lecteur, estEtendu);
      imprimerEnregistrement(session, i, nbAnnonce, enr);
      lus += 1;
    } catch (erreur) {
      // On ne peut plus se repositionner dans le flux : le reste du paquet est perdu.
      journal(session, `  ❌ enregistrement ${i + 1}/${nbAnnonce} illisible : ${erreur.message}`);
      journal(session, '     (les suivants du même paquet sont abandonnés : la position de lecture est perdue)');
      break;
    }
  }

  if (lecteur.reste > 1) {
    journal(session, `  ⚠️  ${lecteur.reste - 1} octet(s) non consommé(s) avant le compteur final — décodage incomplet.`);
  }
  const nbFinal = couvert[couvert.length - 1];
  if (nbFinal !== nbAnnonce) {
    journal(session, `  ⚠️  compteur de fin (${nbFinal}) différent du compteur de tête (${nbAnnonce}).`);
  }

  // On acquitte ce que le boîtier a annoncé dès lors que le CRC est bon : c'est le
  // protocole. Acquitter moins le ferait réémettre en boucle.
  journal(session, `  → acquittement de ${nbAnnonce} enregistrement(s) (${lus} décodé(s) intégralement)`);
  return nbAnnonce;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Une connexion
// ─────────────────────────────────────────────────────────────────────────────────────────

function gererConnexion(socket) {
  compteurConnexion += 1;
  const session = `#${compteurConnexion} ${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`;

  let tampon = Buffer.alloc(0);
  let etat = 'attente-handshake';
  let imei = null;
  let nbPaquets = 0;
  const debut = Date.now();

  journal(session, '━━━ connexion entrante ━━━');
  socket.setKeepAlive(true, 30_000);
  socket.setNoDelay(true);

  /** Consomme le tampon tant qu'une unité complète y tient. Ne lève jamais. */
  const consommer = () => {
    for (;;) {
      if (etat === 'attente-handshake') {
        if (tampon.length < 2) return;

        const longueurImei = tampon.readUInt16BE(0);

        // Garde de désynchronisation : un IMEI fait 15 caractères. Au-delà de 64, ce
        // n'est pas un handshake Teltonika — et on le dit plutôt que de bloquer.
        if (longueurImei < 5 || longueurImei > 64) {
          const tete = tampon.subarray(0, Math.min(16, tampon.length));
          journal(session, `❌ ce n'est pas un handshake Teltonika : longueur annoncée = ${longueurImei}`);
          journal(session, `   premiers octets :\n${dumpHex(tete)}`);
          if (tete[0] === 0x23 || (tete[0] >= 0x30 && tete[0] <= 0x39) || tete[0] === 0x69) {
            journal(session, "   → ces octets sont de l'ASCII imprimable : c'est un boîtier COBAN, pas un Teltonika.");
            journal(session, '     Un Coban parle en texte (##,imei:…) et doit aller sur le port 5023.');
          }
          socket.destroy();
          return;
        }

        if (tampon.length < 2 + longueurImei) return;

        const brut = tampon.subarray(2, 2 + longueurImei);
        tampon = tampon.subarray(2 + longueurImei);
        imei = brut.toString('ascii');

        journal(session, `handshake : ${longueurImei} octet(s) → IMEI « ${imei} »`);
        journal(session, `  brut :\n${dumpHex(Buffer.concat([Buffer.from([longueurImei >> 8, longueurImei & 0xff]), brut]))}`);

        if (!/^\d{15}$/.test(imei)) {
          journal(session, `  ⚠️  ce n'est pas un IMEI à 15 chiffres — accepté quand même (outil de terrain).`);
        }

        // 0x01 = accepté. (0x00 = refusé ; cet outil accepte tout le monde, c'est le but.)
        socket.write(Buffer.from([0x01]));
        journal(session, '  ← réponse 0x01 (ACCEPTÉ)');
        etat = 'attente-avl';
        continue;
      }

      // ── attente-avl ──────────────────────────────────────────────────────────────────
      if (tampon.length < 8) return;

      const preambule = tampon.readUInt32BE(0);
      const longueurChamp = tampon.readUInt32BE(4);

      if (preambule !== 0) {
        journal(session, `❌ préambule non nul (0x${preambule.toString(16)}) — flux désynchronisé, connexion fermée.`);
        journal(session, `   tampon :\n${dumpHex(tampon.subarray(0, Math.min(64, tampon.length)))}`);
        socket.destroy();
        return;
      }
      // Garde anti-absurdité : 1 Mo est déjà démesuré pour un paquet AVL.
      if (longueurChamp < 3 || longueurChamp > 1_048_576) {
        journal(session, `❌ longueur de champ aberrante (${longueurChamp}) — flux désynchronisé, connexion fermée.`);
        journal(session, `   tampon :\n${dumpHex(tampon.subarray(0, Math.min(64, tampon.length)))}`);
        socket.destroy();
        return;
      }

      const tailleTotale = 8 + longueurChamp + 4;
      if (tampon.length < tailleTotale) return; // paquet incomplet : on attend la suite

      const trame = tampon.subarray(0, tailleTotale);
      tampon = tampon.subarray(tailleTotale);
      nbPaquets += 1;

      let aAcquitter = 0;
      try {
        aAcquitter = traiterPaquetAvl(session, trame, longueurChamp);
      } catch (erreur) {
        // Filet de dernier recours : rien ne doit remonter jusqu'au processus.
        journal(session, `❌ erreur inattendue au traitement du paquet : ${erreur?.message ?? erreur}`);
        aAcquitter = 0;
      }

      const accuse = Buffer.alloc(4);
      accuse.writeUInt32BE(aAcquitter >>> 0, 0);
      socket.write(accuse);
      journal(session, `  ← accusé 0x${accuse.toString('hex')} (${aAcquitter})`);
    }
  };

  socket.on('data', (morceau) => {
    try {
      tampon = Buffer.concat([tampon, morceau]);
      consommer();
    } catch (erreur) {
      journal(session, `❌ erreur inattendue sur données reçues : ${erreur?.message ?? erreur}`);
    }
  });

  socket.on('error', (erreur) => journal(session, `socket en erreur : ${erreur.message}`));

  socket.on('close', () => {
    const duree = Math.round((Date.now() - debut) / 1000);
    journal(session, `━━━ connexion fermée · IMEI ${imei ?? '(jamais annoncé)'} · ` +
      `${nbPaquets} paquet(s) AVL · ${duree} s · ${tampon.length} octet(s) inutilisés dans le tampon ━━━`);
    if (tampon.length > 0) {
      journal(session, `  reliquat :\n${dumpHex(tampon.subarray(0, Math.min(64, tampon.length)))}`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────────────────────────────────────────────────

const serveur = net.createServer(gererConnexion);

serveur.on('error', (erreur) => {
  if (erreur.code === 'EADDRINUSE') {
    console.error(`[${horodate()}] ❌ le port ${PORT} est DÉJÀ UTILISÉ sur cette machine. Choisir un autre port.`);
  } else if (erreur.code === 'EACCES') {
    console.error(`[${horodate()}] ❌ permission refusée sur le port ${PORT} (les ports < 1024 exigent root).`);
  } else {
    console.error(`[${horodate()}] ❌ erreur du serveur : ${erreur.message}`);
  }
  process.exit(1);
});

serveur.listen(PORT, HOTE, () => {
  console.log('════════════════════════════════════════════════════════════════════════');
  console.log(' ÉCOUTE TELTONIKA — outil de terrain jetable (aucun lien avec Tracky)');
  console.log('════════════════════════════════════════════════════════════════════════');
  console.log(`[${horodate()}] à l'écoute sur ${HOTE}:${PORT} (TCP)`);
  console.log(`[${horodate()}] accepte : handshake IMEI, Codec 8 (0x08) et Codec 8 Extended (0x8E)`);
  console.log(`[${horodate()}] à configurer dans le boîtier : Protocol = TCP, Codec = 8 Extended`);
  console.log(`[${horodate()}] Ctrl+C pour arrêter. En attente d'un boîtier…`);
  console.log('');
});

// Un outil de terrain ne meurt pas. Quoi qu'il arrive, il journalise et continue.
process.on('uncaughtException', (erreur) => {
  console.error(`[${horodate()}] ❌ exception non capturée (ignorée) : ${erreur?.stack ?? erreur}`);
});
process.on('unhandledRejection', (raison) => {
  console.error(`[${horodate()}] ❌ promesse rejetée (ignorée) : ${raison}`);
});
process.on('SIGINT', () => {
  console.log(`\n[${horodate()}] arrêt demandé — fermeture du serveur.`);
  serveur.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
