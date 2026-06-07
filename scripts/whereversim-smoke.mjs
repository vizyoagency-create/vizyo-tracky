#!/usr/bin/env node
/**
 * V1.16 — Smoke-test connectivité WhereverSIM (read-only).
 *
 * Vérifie, sans démarrer l'API Tracky, que le token et l'endpoint GraphQL
 * fonctionnent : appelle `listSims` + `getStatistics` et affiche un résumé
 * masqué. À lancer après déploiement / changement de token.
 *
 *   node scripts/whereversim-smoke.mjs
 *
 * Token : variable d'env WHEREVER_SIM_TOKEN, sinon lue dans le .env racine.
 * Endpoint : WHEREVER_SIM_API_URL, sinon défaut prod.
 * Exit : 0 = OK, 1 = config manquante, 2 = erreur API.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'https://graphql.api.whereversim.com/graphql';

function fromEnvFile(key) {
  try {
    const txt = readFileSync(join(ROOT, '.env'), 'utf8');
    const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^"|"$/g, '') : '';
  } catch {
    return '';
  }
}

const token = (process.env.WHEREVER_SIM_TOKEN || fromEnvFile('WHEREVER_SIM_TOKEN')).trim();
const apiUrl = (process.env.WHEREVER_SIM_API_URL || fromEnvFile('WHEREVER_SIM_API_URL') || DEFAULT_URL).trim();

if (!token) {
  console.error('✖ WHEREVER_SIM_TOKEN absent (env ou .env racine). Abandon.');
  process.exit(1);
}

const mask = (v) => (v ? `${String(v).slice(0, 6)}…${String(v).slice(-4)}` : v);

async function gql(query, variables = {}) {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body?.data;
}

try {
  console.log(`→ Endpoint : ${apiUrl}`);
  console.log(`→ Token    : longueur ${token.length} (${token.slice(0, 3)}…)`);

  const list = await gql(
    `query($limit:Int!){ listSims(limit:$limit){ totalSims items{ iccid msisdn statusid providerid monthly_data_volume } } }`,
    { limit: 3 },
  );
  const L = list.listSims;
  console.log(`✓ listSims OK — parc total : ${L.totalSims} SIM`);
  for (const s of L.items ?? []) {
    console.log(`   · ${mask(s.iccid)} | n° ${mask(s.msisdn)} | statusid ${s.statusid} | conso ${s.monthly_data_volume} o`);
  }

  try {
    const stats = await gql(`query{ getStatistics{ totalSimCards activeSimCards currentMonthlyDataUsage } }`);
    const st = stats.getStatistics;
    console.log(`✓ getStatistics OK — ${st.activeSimCards}/${st.totalSimCards} actives, conso mois ${st.currentMonthlyDataUsage} o`);
  } catch (e) {
    console.log(`! getStatistics indisponible : ${e.message}`);
  }

  console.log('\n✅ Connectivité WhereverSIM OK.');
  process.exit(0);
} catch (err) {
  console.error(`\n✖ Échec WhereverSIM : ${err.message}`);
  process.exit(2);
}
