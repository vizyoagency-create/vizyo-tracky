#!/usr/bin/env node
/**
 * La garde du déploiement — jouée à blanc, avant que le script ne touche la production.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI CE CONTRÔLE EXISTE                                                │
 * │                                                                            │
 * │ `deploy/vps/deploy.sh` est le seul chemin vers la production (décision D1 │
 * │ du propriétaire, 2026-09-13). Il porte une garde qui refuse de recréer     │
 * │ l'API pendant — ou juste avant — un passage d'automatisation, un journal   │
 * │ que l'API relit au démarrage, et un repli par étiquettes. Un script bash   │
 * │ ne passe par aucun typecheck : la seule façon de savoir qu'il fait ce      │
 * │ qu'il dit est de le jouer avec des doubles, et c'est ce que fait           │
 * │ `deploy/vps/deploy.test.sh` (47 contrôles).                                │
 * │                                                                            │
 * │ TRK-077 (2026-09-09) : la garde lisait au départ, puis une construction    │
 * │ de plusieurs minutes précédait la recréation — la seule chose qui tue.    │
 * │ Le passage de 17:45 est mort malgré une garde présente et correcte.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * CE QUE CE SCRIPT FAIT : trouver un bash (Git Bash sur Windows, `bash` ailleurs) et
 * lancer le harnais. Le VPS et la CI n'ont pas Windows ; le poste du propriétaire, si.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const CANDIDATS_WINDOWS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

function trouverBash() {
  if (process.platform !== 'win32') return 'bash';
  const trouve = CANDIDATS_WINDOWS.find((c) => existsSync(c));
  if (!trouve) {
    console.error('verif:deploiement — Git Bash introuvable (attendu sous C:\\Program Files\\Git). Le harnais ne peut pas tourner ici.');
    process.exit(2);
  }
  return trouve;
}

const bash = trouverBash();
const r = spawnSync(bash, ['deploy/vps/deploy.test.sh'], {
  stdio: 'inherit',
  // Git Bash sans PATH POSIX ne trouve ni `sed` ni `cut` : on le lui donne, il sait le lire.
  env: { ...process.env, PATH: process.platform === 'win32' ? `/usr/bin:/bin:${process.env.PATH ?? ''}` : process.env.PATH },
});
process.exit(r.status ?? 1);
