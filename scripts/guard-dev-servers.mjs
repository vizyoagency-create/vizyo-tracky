#!/usr/bin/env node
/**
 * Garde-fou : refuse de lancer la suite de tests si un serveur de developpement
 * tourne encore.
 *
 * POURQUOI (mesure du 2026-08-17 sur le poste 15,7 Go de RAM soudee) :
 * la suite `apps/api` a cache ts-jest vide, avec les serveurs de dev actifs,
 * n'a PAS TERMINE en 20 minutes -- la RAM libre est tombee a 0,00 Go et la
 * machine a passe 84 % du temps sous 1,5 Go. Sans les serveurs, la meme suite
 * passe en 51 secondes. Ce n'est pas "plus lent", c'est un changement de
 * regime : au-dela de la RAM disponible, chaque fichier de test se lit depuis
 * le fichier d'echange. Un serveur `nest start --watch` est d'ailleurs mort
 * pendant la mesure -- ils ne survivent pas a la pression.
 *
 * Contournement volontaire :   ALLOW_DEV_DURING_TESTS=1 pnpm test
 * Ignore automatiquement en CI (CI=true).
 */

import { execFileSync } from 'node:child_process';
import { freemem, totalmem, platform } from 'node:os';

const GO = 1024 ** 3;
const RAM_MINI_GO = 3; // en dessous, on previent (mesure : la suite tient sous 3,06 Go libres)

/** Motifs qui designent un VRAI serveur de developpement. */
const SERVEURS = [
  // Le piege verifie le 2026-08-17 : la ligne de commande reelle du serveur
  // Angular est   node "...\@angular\cli\bin\ng.js" "serve" "--port" ...
  // Le motif litteral "ng serve" ne matche donc PAS -- il faut viser ng.js.
  { re: /ng\.js["'\s].*\bserve\b/i, nom: 'Angular (ng serve)' },
  { re: /@angular[\\/]cli[\\/]bin/i, nom: 'Angular CLI' },
  { re: /nest\.js["'\s].*\bstart\b/i, nom: 'NestJS (nest start --watch)' },
  { re: /\bnx\b.*\bserve\b/i, nom: 'Nx (nx serve)' },
  { re: /\bnext\b.*\bdev\b/i, nom: 'Next.js (next dev)' },
  { re: /webpack(-dev-server|\s+serve)/i, nom: 'webpack dev server' },
  // vite, mais surtout PAS vitest : \b ne suffit pas ("vite" est un prefixe de
  // "vitest"), on exige que le mot ne soit pas suivi de "st".
  { re: /\bvite(?!st)\b/i, nom: 'Vite' },
  // `tsx watch` (vizyo-verify) : selon l'invocation, la ligne de commande est
  // soit `tsx watch src/...`, soit `node .../tsx/dist/cli.mjs watch src/...`.
  { re: /\btsx\s+watch\b|tsx[\\/]dist[\\/]cli[^\s]*\s+watch\b/i, nom: 'tsx watch' },
  { re: /dist[\\/]main(\.js)?\b/i, nom: 'API compilee (node dist/main)' },
];

/** Ce qui ne doit JAMAIS declencher le garde-fou. */
const EXCLUS = [
  /\bjest\b/i,
  /\bvitest\b/i,
  /\bkarma\b/i,
  /\bturbo\b/i,
  /run-many/i,
  /guard-dev-servers/i,
  /jest-worker/i,
];

function processusNode() {
  try {
    if (platform() === 'win32') {
      const ps = [
        '-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
        'ForEach-Object { $_.ProcessId.ToString() + "\u0001" + $_.CommandLine }',
      ];
      const out = execFileSync('powershell.exe', ps, {
        encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      });
      return out.split(/\r?\n/).filter(Boolean).map((l) => {
        const i = l.indexOf('\u0001');
        return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) || '' };
      });
    }
    const out = execFileSync('ps', ['-eo', 'pid=,args='], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    return out.split('\n').filter(Boolean).map((l) => {
      const m = l.trim().match(/^(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), cmd: m[2] } : null;
    }).filter(Boolean).filter((p) => /\bnode\b/.test(p.cmd));
  } catch {
    // Si on ne sait pas lister les processus, on ne bloque pas le developpeur.
    return null;
  }
}

function main() {
  if (process.env.CI === 'true' || process.env.CI === '1') return;
  if (process.env.ALLOW_DEV_DURING_TESTS === '1') {
    console.log('[garde-fou] ALLOW_DEV_DURING_TESTS=1 -- controle ignore.');
    return;
  }

  const procs = processusNode();
  if (procs === null) {
    console.log('[garde-fou] impossible de lister les processus -- controle ignore.');
    return;
  }

  const moi = new Set([process.pid, process.ppid]);
  const trouves = [];
  for (const p of procs) {
    if (moi.has(p.pid) || !p.cmd) continue;
    if (EXCLUS.some((re) => re.test(p.cmd))) continue;
    const hit = SERVEURS.find((s) => s.re.test(p.cmd));
    if (hit) trouves.push({ ...p, nom: hit.nom });
  }

  const libreGo = freemem() / GO;

  if (trouves.length === 0) {
    if (libreGo < RAM_MINI_GO) {
      console.warn(
        `[garde-fou] Attention : ${libreGo.toFixed(2)} Go de RAM libre sur ` +
        `${(totalmem() / GO).toFixed(1)} Go. La suite en demande ~3 Go. ` +
        'Redemarrer Claude Desktop libere generalement plusieurs Go.',
      );
    }
    return;
  }

  const l = '-'.repeat(74);
  console.error(`\n${l}`);
  console.error('  TESTS BLOQUES : un serveur de developpement tourne encore');
  console.error(l);
  for (const t of trouves) {
    console.error(`  PID ${String(t.pid).padEnd(7)} ${t.nom}`);
    console.error(`          ${t.cmd.replace(/\s+/g, ' ').slice(0, 100)}`);
  }
  console.error(l);
  console.error(`  RAM libre : ${libreGo.toFixed(2)} Go sur ${(totalmem() / GO).toFixed(1)} Go`);
  console.error('');
  console.error('  Mesure du 2026-08-17 : avec les serveurs actifs et le cache ts-jest');
  console.error('  vide, la suite API n\'a pas termine en 20 min (RAM libre a 0,00 Go).');
  console.error('  Sans eux : 51 secondes.');
  console.error('');
  console.error('  Pour les arreter : fermez leur terminal, ou');
  for (const t of trouves) {
    console.error(`      ${process.platform === 'win32' ? `Stop-Process -Id ${t.pid} -Force` : `kill ${t.pid}`}`);
  }
  console.error('');
  console.error('  Pour passer outre malgre tout :');
  console.error(process.platform === 'win32'
    ? '      $env:ALLOW_DEV_DURING_TESTS=1; pnpm test'
    : '      ALLOW_DEV_DURING_TESTS=1 pnpm test');
  console.error(`${l}\n`);
  process.exit(1);
}

main();
