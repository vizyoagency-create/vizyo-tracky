#!/usr/bin/env node
/**
 * Faux boîtier Coban — pour éprouver la mise en service SANS matériel.
 *
 * Rejoue fidèlement ce que fait un vrai boîtier : ouverture de session `##,imei:…,A`,
 * puis trames de position `imei:…,tracker,…`. Le serveur répond `LOAD` quand l'IMEI est
 * connu, et ferme la connexion sinon — c'est exactement ce comportement qu'on veut
 * pouvoir provoquer à volonté.
 *
 *   node scripts/faux-boitier-coban.mjs --imei 864035054756409 [--port 5023] [--host 127.0.0.1]
 *                                       [--positions 3] [--intervalle 5]
 *
 * Sans `--positions`, il se contente de frapper à la porte en boucle : c'est le mode qui
 * alimente la liste des « boîtiers non reconnus », donc la voie TCP prioritaire.
 */
import net from 'node:net';

const arg = (nom, defaut) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
};

const IMEI = arg('imei', '');
const HOTE = arg('host', '127.0.0.1');
const PORT = Number(arg('port', '5023'));
const NB_POSITIONS = Number(arg('positions', '0'));
const INTERVALLE_S = Number(arg('intervalle', '5'));
const LAT = Number(arg('lat', '43.6045'));
const LNG = Number(arg('lng', '1.4442'));

if (!/^\d{15}$/.test(IMEI)) {
  console.error('Usage : --imei <15 chiffres> [--port 5023] [--positions N]');
  process.exit(1);
}

/** Coban encode en degrés-minutes : 43.6045 -> "4336.27000" (43° 36.270'). */
function degresMinutes(valeur, taille) {
  const abs = Math.abs(valeur);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return String(deg).padStart(taille, '0') + min.toFixed(5).padStart(8, '0');
}

function tramePosition(n) {
  const d = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const dateLocale = `${p2(d.getFullYear() % 100)}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const heureUtc = `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
  // Petite dérive pour que les positions ne soient pas toutes identiques.
  const lat = LAT + n * 0.0004;
  const lng = LNG + n * 0.0004;
  return (
    `imei:${IMEI},tracker,${dateLocale},,F,${heureUtc},A,` +
    `${degresMinutes(lat, 2)},${lat >= 0 ? 'N' : 'S'},` +
    `${degresMinutes(lng, 3)},${lng >= 0 ? 'E' : 'W'},0.00,0;`
  );
}

const horodate = () => new Date().toISOString().slice(11, 19);
let accepte = false;
let envoyees = 0;

function connecter() {
  const socket = net.createConnection({ host: HOTE, port: PORT }, () => {
    console.log(`[${horodate()}] connecté à ${HOTE}:${PORT} — ouverture de session…`);
    socket.write(`##,imei:${IMEI},A;`);
  });

  socket.setEncoding('utf8');

  socket.on('data', (d) => {
    const rep = d.toString().trim();
    console.log(`[${horodate()}] <- ${JSON.stringify(rep)}`);
    if (rep.includes('LOAD') && !accepte) {
      accepte = true;
      console.log(`[${horodate()}] ✅ IMEI ACCEPTÉ par le serveur.`);
      if (NB_POSITIONS > 0) envoyerPositions(socket);
      else console.log(`[${horodate()}] (aucune position demandée — --positions N pour en envoyer)`);
    }
  });

  socket.on('close', () => {
    if (!accepte) {
      // C'est le comportement attendu face à un IMEI non déclaré : le serveur coupe.
      console.log(`[${horodate()}] ❌ session refusée (IMEI inconnu) — nouvelle tentative dans 5 s`);
      setTimeout(connecter, 5000);
    } else {
      console.log(`[${horodate()}] connexion fermée.`);
      process.exit(0);
    }
  });

  socket.on('error', (e) => console.error(`[${horodate()}] erreur socket : ${e.message}`));
}

function envoyerPositions(socket) {
  const tick = setInterval(() => {
    if (envoyees >= NB_POSITIONS) {
      clearInterval(tick);
      console.log(`[${horodate()}] ${envoyees} position(s) envoyée(s). Fin.`);
      socket.end();
      return;
    }
    const t = tramePosition(envoyees);
    socket.write(t);
    envoyees += 1;
    console.log(`[${horodate()}] -> position ${envoyees}/${NB_POSITIONS}`);
  }, INTERVALLE_S * 1000);
  // Première position tout de suite plutôt qu'après un intervalle d'attente.
  socket.write(tramePosition(envoyees));
  envoyees += 1;
  console.log(`[${horodate()}] -> position ${envoyees}/${NB_POSITIONS}`);
}

console.log(`Faux boîtier Coban — IMEI ${IMEI}`);
connecter();
