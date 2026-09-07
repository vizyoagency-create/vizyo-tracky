/* eslint-disable no-console */
/**
 * ═══ IMPORTEUR DE LA DÉMO — un processus à part, sans Nest ═══════════════════════════════
 *
 *   node dist/demo/import/import.cli.js
 *
 * Ne démarre NI l'application, NI ses crons, NI le serveur TCP. Lit la production par un rôle
 * SELECT seulement, écrit dans la base de démo, et consigne le résultat dans le journal de la
 * démo (`system_activity_logs`, catégorie DEMO). Lancé par `deploy/vps/demo-refresh.sh` dans un
 * conteneur éphémère — le seul à voir les deux bases à la fois.
 *
 * Variables d'environnement (cf. `.env.demo.example`) :
 *   DEMO_MODE=true              — refus sinon : cet outil ne tourne que pour la démo ;
 *   DATABASE_URL                — la base de démo (cible) ;
 *   DEMO_SOURCE_DATABASE_URL    — la production, rôle tracky_ro ;
 *   DEMO_SOURCE_FLEET_IDS       — CSV des sociétés source ;
 *   DEMO_SALT (≥ 16 car.), DEMO_FLEET_NAME, DEMO_POSITIONS_DAYS, DEMO_TRIPS_MONTHS.
 *
 * Code de sortie : 0 si l'import a abouti, 1 sinon (le script du VPS le lit).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { importerDemo } from './demo-importer';

function lire(nom: string): string {
  return (process.env[nom] ?? '').trim();
}

function entier(nom: string, defaut: number): number {
  const brut = lire(nom);
  if (brut === '') return defaut;
  const n = Number(brut);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${nom} doit être un entier strictement positif (reçu « ${brut} »).`);
  return n;
}

async function main(): Promise<void> {
  if (lire('DEMO_MODE') !== 'true') {
    throw new Error("DEMO_MODE=true est requis : cet importeur ne tourne que pour l'environnement de démonstration.");
  }
  const urlCible = lire('DATABASE_URL');
  const urlSource = lire('DEMO_SOURCE_DATABASE_URL');
  if (!urlCible) throw new Error('DATABASE_URL (base de démo, cible) est requis.');
  if (!urlSource) throw new Error('DEMO_SOURCE_DATABASE_URL (production, rôle SELECT seulement) est requis.');

  const options = {
    urlSource,
    urlCible,
    sel: lire('DEMO_SALT'),
    idsFlottesSource: lire('DEMO_SOURCE_FLEET_IDS').split(',').map((s) => s.trim()).filter(Boolean),
    nomFlotte: lire('DEMO_FLEET_NAME') || 'Transports Démo',
    joursPositions: entier('DEMO_POSITIONS_DAYS', 30),
    moisTrajets: entier('DEMO_TRIPS_MONTHS', 12),
  };

  const source = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlSource }) });
  const cible = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlCible }) });
  try {
    const bilan = await importerDemo({
      ...options,
      source,
      cible,
      journal: (m) => console.log(`[import-demo] ${m}`),
    });
    console.log(JSON.stringify(bilan, null, 2));
  } finally {
    await Promise.all([source.$disconnect(), cible.$disconnect()]);
  }
}

main().catch((err) => {
  console.error(`❌ Import de la démo en échec : ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
