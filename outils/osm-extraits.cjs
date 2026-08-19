/**
 * Téléchargement et fraîcheur des extraits OpenStreetMap (Geofabrik).
 *
 * Un extrait pèse 250 à 350 Mo et se périme lentement : les routes bougent peu, les limites de
 * vitesse encore moins. On le garde donc plusieurs semaines et on ne retélécharge que si le
 * serveur annonce une version plus récente — un `HEAD` de quelques octets suffit à le savoir,
 * là où un téléchargement inutile coûterait 300 Mo.
 *
 * ── DEUX PRÉCAUTIONS QUI ÉVITENT DES DONNÉES FAUSSES ─────────────────────────────────
 *
 *   1. ÉCRITURE ATOMIQUE. Le fichier arrive sous `.part` et n'est renommé qu'une fois complet.
 *      Une coupure de réseau ou un poste éteint en cours de route laisse donc un `.part`
 *      inutilisable, jamais un extrait tronqué que l'index lirait comme une carte à trous —
 *      ce qui produirait des « aucune route à portée » massifs et parfaitement crédibles.
 *
 *   2. TAILLE VÉRIFIÉE. Si l'octet compte annoncé par le serveur ne correspond pas à ce qui est
 *      arrivé, on jette. Mieux vaut retélécharger que résoudre sur une carte incomplète.
 */

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

/** Les extraits vivent hors du dépôt suivi : ce sont des centaines de Mo régénérables. */
const DOSSIER = path.join(__dirname, '.osm');
/** Au-delà, on redemande au serveur s'il a mieux. Les limites de vitesse bougent lentement. */
const FRAICHEUR_JOURS = 30;

function cheminExtrait(region) {
  return path.join(DOSSIER, `${region.id}.osm.pbf`);
}

function infosLocales(region) {
  const p = cheminExtrait(region);
  if (!fs.existsSync(p)) return null;
  const st = fs.statSync(p);
  return { chemin: p, octets: st.size, ageJours: (Date.now() - st.mtimeMs) / 86_400_000 };
}

/** Taille annoncée par Geofabrik, sans rien télécharger. */
async function tailleDistante(region) {
  const r = await fetch(region.pbf, { method: 'HEAD', redirect: 'follow' });
  if (!r.ok) throw new Error(`HEAD ${r.status} sur ${region.pbf}`);
  const n = Number(r.headers.get('content-length'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Garantit un extrait local exploitable, et renvoie son chemin.
 *
 * Ne retélécharge que si le fichier manque, est périmé, ou ne fait pas la taille annoncée.
 */
async function assurerExtrait(region, { journal = () => {}, fraicheurJours = FRAICHEUR_JOURS } = {}) {
  fs.mkdirSync(DOSSIER, { recursive: true });
  const local = infosLocales(region);

  if (local && local.ageJours < fraicheurJours) {
    journal(`${region.nom} : extrait local du disque, ${Math.round(local.octets / 1048576)} Mo, ${local.ageJours.toFixed(0)} j`);
    return local.chemin;
  }

  let attendu = null;
  try {
    attendu = await tailleDistante(region);
  } catch (e) {
    if (local) {
      // Geofabrik injoignable mais on a une copie : on s'en sert plutot que de ne rien faire.
      journal(`${region.nom} : Geofabrik injoignable (${e.message}), on garde l'extrait local de ${local.ageJours.toFixed(0)} j`);
      return local.chemin;
    }
    throw e;
  }

  if (local && attendu !== null && local.octets === attendu) {
    // Perime a l'age, mais identique a la version publiee : on le rajeunit sans rien retirer.
    fs.utimesSync(local.chemin, new Date(), new Date());
    journal(`${region.nom} : deja a jour (${Math.round(local.octets / 1048576)} Mo), aucun telechargement`);
    return local.chemin;
  }

  const dest = cheminExtrait(region);
  const partiel = `${dest}.part`;
  journal(`${region.nom} : telechargement de ${attendu ? Math.round(attendu / 1048576) + ' Mo' : 'l\'extrait'}...`);

  const t0 = Date.now();
  const r = await fetch(region.pbf, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} sur ${region.pbf}`);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(partiel));

  const recu = fs.statSync(partiel).size;
  if (attendu !== null && recu !== attendu) {
    fs.unlinkSync(partiel);
    throw new Error(
      `${region.nom} : extrait tronque (${recu} octets recus pour ${attendu} annonces). ` +
      `Rien n'est conserve : resoudre sur une carte incomplete produirait de faux « aucune route a portee ».`,
    );
  }

  fs.renameSync(partiel, dest); // atomique : jamais d'extrait a moitie ecrit sous le nom final
  const s = ((Date.now() - t0) / 1000).toFixed(0);
  journal(`${region.nom} : ${Math.round(recu / 1048576)} Mo telecharges en ${s}s`);
  return dest;
}

/** Nettoie les fragments laissés par une coupure. */
function nettoyerPartiels() {
  if (!fs.existsSync(DOSSIER)) return 0;
  const restes = fs.readdirSync(DOSSIER).filter((f) => f.endsWith('.part'));
  for (const f of restes) fs.unlinkSync(path.join(DOSSIER, f));
  return restes.length;
}

module.exports = { assurerExtrait, cheminExtrait, infosLocales, nettoyerPartiels, DOSSIER, FRAICHEUR_JOURS };
