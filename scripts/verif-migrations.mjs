#!/usr/bin/env node
/**
 * Garde des migrations Prisma : chaque migration se REJOUE de bout en bout, et le schéma
 * qu'elles produisent est celui de `schema.prisma`.
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 * │ Pourquoi ce script existe — incident du 2026-09-17, 04:56 UTC.                            │
 * │                                                                                            │
 * │ La migration du lot A des RDV portait un bloc `ADD CONSTRAINT … fleetId_fkey` EN DOUBLE   │
 * │ (un script de patch joué deux fois). Sur la base de dev, le fichier n'avait jamais été    │
 * │ rejoué en entier : les deux instructions ajoutées avaient été passées à la main. En       │
 * │ production, Postgres a tout annulé, Prisma a marqué la migration « échouée », et l'API a  │
 * │ refusé de démarrer pendant 56 minutes (P3009 en boucle) — au moment où elle devait        │
 * │ envoyer les reprises du coupe-circuit : 28 véhicules sont restés coupés.                  │
 * │                                                                                            │
 * │ `tsc` ne lit pas le SQL, Jest non plus. Le seul juge d'une migration, c'est une base qui   │
 * │ la joue. Ce script en prend une vierge, y rejoue TOUTES les migrations dans l'ordre, puis  │
 * │ compare le résultat au schéma : une instruction en double, un nom déjà pris, une table    │
 * │ oubliée — tout ce que la prod aurait découvert à 04:56, on le découvre ici, avant le push. │
 * └───────────────────────────────────────────────────────────────────────────────────────────┘
 *
 *   pnpm verif:migrations            # rejeu complet sur une base temporaire (Postgres de dev)
 *   pnpm verif:migrations --statique # seulement l'analyse des fichiers (sans base)
 *
 * La base temporaire (`verif_migrations_<horodatage>`) est créée sur le serveur de
 * `DATABASE_URL` (apps/api/.env) et supprimée à la fin, même en cas d'échec.
 *
 * Bruit toléré dans la comparaison : les `DROP DEFAULT` (les migrations posent
 * `gen_random_uuid()` / `now()` / `'{}'` là où Prisma déclare `uuid()` / `@updatedAt` / rien)
 * — une différence de forme sur les valeurs par défaut, qui n'a jamais rien cassé — et la DÉRIVE
 * CONNUE listée ci-dessous (`DERIVE_CONNUE`), constatée le 17/09 en même temps que l'incident :
 * elle existe aussi en production, elle est antérieure, et elle se résorbe par une migration
 * dédiée, pas en douce dans ce garde-fou. Toute ligne NOUVELLE est un échec.
 *
 * Sortie 0 = rien à signaler. Sortie 1 = le problème est nommé, avec la migration fautive.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RACINE = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const API = join(RACINE, 'apps', 'api');
const MIGRATIONS = join(API, 'prisma', 'migrations');
const SCHEMA = join(API, 'prisma', 'schema.prisma');
const STATIQUE_SEULEMENT = process.argv.includes('--statique');

const echecs = [];
const dire = (m) => console.log(m);

/**
 * Écarts entre « les migrations rejouées » et `schema.prisma`, relevés le 2026-09-17 (identiques
 * sur la base de production). Dette connue : cinq valeurs d'`AlertType` déclarées mais jamais
 * migrées, un index resté dans les migrations, une précision de type. À résorber par une
 * migration dédiée — et alors à retirer d'ici. Comparés après normalisation (sans `,` ni `;`).
 */
const DERIVE_CONNUE = new Set([
  'ALTER TYPE "AlertType" ADD VALUE \'TOW\'',
  'ALTER TYPE "AlertType" ADD VALUE \'TAMPER\'',
  'ALTER TYPE "AlertType" ADD VALUE \'FATIGUE\'',
  'ALTER TYPE "AlertType" ADD VALUE \'ILLEGAL_IGNITION\'',
  'ALTER TYPE "AlertType" ADD VALUE \'IDLE_TIME\'',
  'DROP INDEX "trip_analyses_limitsCoverage_computedAt_idx"',
  'ALTER TABLE "trackers" ALTER COLUMN "lastIgnitionChangeAt" SET DATA TYPE TIMESTAMP(3)',
]);

// ── 1. L'analyse des fichiers : une instruction en double dans UNE migration ──────────────
//
// C'est exactement le défaut du 17/09 : le même `ADD CONSTRAINT "x"` deux fois dans le même
// fichier. Postgres refuse la seconde, la transaction est annulée, la migration est « échouée ».
const dossiers = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name))
  .map((d) => d.name)
  .sort();

const MOTIFS = [
  /ADD CONSTRAINT\s+"([^"]+)"/gi,
  /CREATE (?:UNIQUE )?INDEX\s+(?:IF NOT EXISTS\s+)?"([^"]+)"/gi,
  /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"([^"]+)"/gi,
  /CREATE TYPE\s+"([^"]+)"/gi,
];
for (const nom of dossiers) {
  const fichier = join(MIGRATIONS, nom, 'migration.sql');
  if (!existsSync(fichier)) { echecs.push(`${nom} : pas de migration.sql`); continue; }
  const sql = readFileSync(fichier, 'utf8').replace(/--[^\n]*/g, '');
  for (const motif of MOTIFS) {
    const vus = new Map();
    for (const m of sql.matchAll(motif)) vus.set(m[1], (vus.get(m[1]) ?? 0) + 1);
    for (const [objet, n] of vus) {
      if (n > 1) echecs.push(`${nom} : « ${objet} » créé ${n} fois dans le même fichier (${motif.source.split('\\s')[0]}) — la migration échouerait en prod`);
    }
  }
}
dire(`Migrations : ${dossiers.length} dossiers analysés${echecs.length ? '' : ', aucune instruction en double'}.`);

// ── 2. Le rejeu complet sur une base vierge, puis la comparaison au schéma ────────────────
function urlDeBase() {
  const brut = process.env.DATABASE_URL ?? (() => {
    const env = join(API, '.env');
    if (!existsSync(env)) return null;
    const ligne = readFileSync(env, 'utf8').split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
    return ligne ? ligne.slice('DATABASE_URL='.length).replace(/^"|"$/g, '') : null;
  })();
  if (!brut) return null;
  return new URL(brut);
}

function prisma(args, env) {
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', ...args], {
    cwd: API, env: { ...process.env, ...env }, encoding: 'utf8', shell: process.platform === 'win32',
  });
  return { code: r.status ?? 1, sortie: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function executerSql(url, sql) {
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', 'db', 'execute', '--url', url, '--stdin'], {
    cwd: API, input: sql, encoding: 'utf8', shell: process.platform === 'win32',
  });
  return { code: r.status ?? 1, sortie: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

if (!STATIQUE_SEULEMENT && echecs.length === 0) {
  const base = urlDeBase();
  if (!base) {
    echecs.push('DATABASE_URL introuvable (apps/api/.env) : impossible de rejouer les migrations. Lancer avec --statique pour la seule analyse des fichiers.');
  } else {
    const nomTemp = `verif_migrations_${Date.now()}`;
    const admin = new URL(base.toString()); admin.pathname = '/postgres';
    const temp = new URL(base.toString()); temp.pathname = `/${nomTemp}`;
    const creation = executerSql(admin.toString(), `CREATE DATABASE "${nomTemp}";`);
    if (creation.code !== 0) {
      echecs.push(`Base temporaire impossible à créer sur ${admin.host} : le Postgres de dev tourne-t-il ? (docker compose up -d)\n${creation.sortie.trim().split('\n').slice(-3).join('\n')}`);
    } else {
      try {
        const t0 = Date.now();
        const deploy = prisma(['migrate', 'deploy'], { DATABASE_URL: temp.toString() });
        if (deploy.code !== 0) {
          const fautive = /migration `([^`]+)`|The `([^`]+)` migration/.exec(deploy.sortie);
          echecs.push(`REJEU EN ÉCHEC${fautive ? ` — migration « ${fautive[1] ?? fautive[2]} »` : ''} :\n${deploy.sortie.trim().split('\n').filter((l) => /error|Error|ERROR|failed|migration/i.test(l)).slice(-8).join('\n')}`);
        } else {
          dire(`Rejeu : ${dossiers.length} migrations appliquées sur une base vierge en ${Math.round((Date.now() - t0) / 1000)} s.`);
          const diff = prisma(['migrate', 'diff', '--from-url', temp.toString(), '--to-schema-datamodel', SCHEMA, '--script'], {});
          const lignes = diff.sortie.split('\n')
            .map((l) => l.trim().replace(/[,;]$/, ''))
            .filter((l) => l && !l.startsWith('--') && !/^warn/i.test(l) && !/pris\.ly/.test(l) && !/^For more information/.test(l))
            .filter((l) => !/ALTER COLUMN "[^"]+" DROP DEFAULT$/.test(l))
            .filter((l) => !DERIVE_CONNUE.has(l))
            .filter((l) => l !== 'This is an empty migration.' && !/^ALTER TABLE "[^"]+"$/.test(l));
          if (diff.code !== 0 && lignes.length === 0) lignes.push(diff.sortie.trim().split('\n').slice(-3).join(' '));
          if (lignes.length > 0) {
            echecs.push(`Les migrations ne produisent PAS le schéma de schema.prisma — écart :\n${lignes.map((l) => '  ' + l).join('\n')}`);
          } else {
            dire('Schéma : les migrations rejouées produisent exactement schema.prisma (au bruit connu près).');
          }
        }
      } finally {
        const suppression = executerSql(admin.toString(), `DROP DATABASE IF EXISTS "${nomTemp}" WITH (FORCE);`);
        if (suppression.code !== 0) dire(`⚠️ base temporaire ${nomTemp} non supprimée : ${suppression.sortie.trim().split('\n').slice(-1)[0]}`);
      }
    }
  }
}

if (echecs.length === 0) {
  console.log('\nMigrations : rien à signaler.\n');
  process.exit(0);
}
console.log('');
for (const e of echecs) console.log(`✗ ${e}`);
console.log(`\n${echecs.length} problème(s) de migration.\n`);
process.exit(1);
