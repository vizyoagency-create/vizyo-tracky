#!/usr/bin/env node
/**
 * Genere `docs/centre-alerte/TABLEAU-DE-BORD.html` a partir de `app/taches.json`.
 *
 * ── Pourquoi un fichier genere plutot qu'une page ecrite a la main ────────────────────────────
 * Parce qu'un tableau de bord tenu a la main derive. `docs/vps-audit/ROADMAP.md`, retire le
 * 06/09, annoncait VPS-013 « FAIT » dans son resume alors que sa propre section detaillee disait
 * l'inverse : c'est le RESUME qui avait vieilli, pas le detail. Ici le resume ne peut pas vieillir
 * separement — il n'existe pas en tant que texte, il est recalcule a chaque passage.
 *
 * ── Ce que ce script ne fait PAS ──────────────────────────────────────────────────────────────
 * Il ne lit pas ROADMAP-CORRECTIFS.md et ne cherche pas a le comprendre. La prose porte le
 * pourquoi et les pieges ; `taches.json` porte l'etat. Les deux doivent s'accorder, et c'est la
 * PREUVE qui tranche, jamais le fichier le plus recent.
 *
 * Usage : node docs/centre-alerte/app/generer-tableau-de-bord.mjs
 *         (depuis la racine du depot ; aucune dependance, aucun reseau)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE_DOCS = resolve(ICI, '..');
const SRC = join(ICI, 'taches.json');
const SORTIE = join(RACINE_DOCS, 'TABLEAU-DE-BORD.html');

const data = JSON.parse(readFileSync(SRC, 'utf8'));
const taches = data.taches;

/** Echappement HTML — les libelles viennent d'un fichier versionne, mais on ne fait pas confiance par principe. */
const e = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const AUJOURDHUI = new Date().toISOString().slice(0, 10);

/** Anciennete en jours, pour la colonne « depuis » — c'est elle qui rend une file d'attente lisible. */
function joursDepuis(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = Math.floor((Date.parse(AUJOURDHUI) - Date.parse(iso)) / 86_400_000);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

const ETATS = data.etats;
const CLASSES = data.classes;

const compte = (p) => taches.filter(p).length;
const stats = {
  total: taches.length,
  fait: compte((t) => t.etat === 'FAIT'),
  deploye: compte((t) => t.etat === 'DEPLOYE'),
  commite: compte((t) => t.etat === 'COMMITE'),
  ouvert: compte((t) => t.etat === 'OUVERT'),
  g1: compte((t) => t.etat === 'OUVERT' && t.gravite === 1),
  retard: compte((t) => t.etat === 'OUVERT' && t.retard),
  humain: compte((t) => t.etat === 'OUVERT' && ['HUMAIN', 'TERRAIN', 'PRODUIT'].includes(t.classe)),
  code: compte((t) => t.etat === 'OUVERT' && ['A_CODER', 'CHANTIER', 'AUTO', 'PREPARE'].includes(t.classe)),
};
const pct = (n) => (stats.total ? Math.round((n / stats.total) * 100) : 0);

/** Ordre d'affichage : ce qui est ouvert et grave d'abord, ce qui est clos en dernier. */
const RANG_ETAT = { OUVERT: 0, COMMITE: 1, DEPLOYE: 2, FAIT: 3 };
const triees = [...taches].sort(
  (a, b) =>
    RANG_ETAT[a.etat] - RANG_ETAT[b.etat] ||
    (b.phare ? 1 : 0) - (a.phare ? 1 : 0) ||
    (a.gravite ?? 9) - (b.gravite ?? 9) ||
    a.id.localeCompare(b.id, 'fr', { numeric: true }),
);

function carte(t) {
  const jours = joursDepuis(t.depuis);
  const cl = CLASSES[t.classe] ?? { libelle: t.classe, puce: '•' };
  const marque = ETATS[t.etat]?.marque ?? '?';
  const badges = [
    t.phare ? '<span class="b b-phare">⭐ le plus rentable</span>' : '',
    t.retard ? '<span class="b b-retard">🔴 au-dela de 7 jours</span>' : '',
    t.bloque ? '<span class="b b-bloque">⛔ prerequis</span>' : '',
    t.echeance ? `<span class="b b-ech">🗓️ echeance ${e(t.echeance)}</span>` : '',
  ].join('');
  const preuve = t.preuve ? `<p class="preuve"><b>Preuve</b> — ${e(t.preuve)}</p>` : '';
  const attendue = t.preuveAttendue
    ? `<p class="attendue"><b>Preuve attendue</b> — ${e(t.preuveAttendue)}</p>`
    : '';
  const commit = t.commit ? `<code class="commit">${e(t.commit)}</code>` : '';
  return `<article class="t etat-${t.etat} g${t.gravite ?? 9}" data-etat="${t.etat}" data-partie="${t.partie}" data-classe="${t.classe}" data-g="${t.gravite ?? 9}">
  <div class="t-h">
    <span class="marque" title="${e(ETATS[t.etat]?.libelle ?? '')}">${marque}</span>
    <span class="id">${e(t.id)}</span>
    <span class="fiche">${e(t.fiche)}</span>
    <span class="classe">${cl.puce} ${e(cl.libelle)}</span>
    ${t.gravite ? `<span class="grav" title="gravite ${t.gravite}">G${t.gravite}</span>` : ''}
    ${jours !== null ? `<span class="depuis" title="ouverte depuis le ${e(t.depuis)}">${jours} j</span>` : ''}
    ${commit}
  </div>
  <h3>${e(t.titre)}</h3>
  <p class="detail">${e(t.detail)}</p>
  ${preuve}${attendue}
  <div class="badges">${badges}</div>
</article>`;
}

const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tableau de bord — corrections Tracky</title>
<style>
  :root{
    --bg:#f6f7f9; --card:#fff; --txt:#14181f; --mut:#5d6672; --bord:#e3e7ec;
    --ok:#0f9d6b; --warn:#d98324; --dgr:#d1453b; --info:#2f6fd0; --neutre:#8b95a3;
    --ombre:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06);
  }
  @media (prefers-color-scheme:dark){:root{
    --bg:#0f1216; --card:#171c22; --txt:#e6eaf0; --mut:#98a2b3; --bord:#252c35;
    --ombre:0 1px 2px rgba(0,0,0,.4);
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);
    font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:1120px;margin:0 auto;padding:28px 20px 80px}
  header h1{margin:0 0 4px;font-size:25px;letter-spacing:-.02em}
  .sous{color:var(--mut);margin:0 0 22px;font-size:14px}
  .sous b{color:var(--txt)}

  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:18px}
  .k{background:var(--card);border:1px solid var(--bord);border-radius:10px;padding:13px 15px;box-shadow:var(--ombre)}
  .k .n{font-size:27px;font-weight:650;letter-spacing:-.02em;line-height:1.1}
  .k .l{color:var(--mut);font-size:12.5px;margin-top:3px}
  .k.ok .n{color:var(--ok)} .k.warn .n{color:var(--warn)} .k.dgr .n{color:var(--dgr)} .k.info .n{color:var(--info)}

  .barre{display:flex;height:11px;border-radius:6px;overflow:hidden;border:1px solid var(--bord);margin-bottom:6px}
  .barre span{display:block}
  .s-FAIT{background:var(--ok)} .s-DEPLOYE{background:var(--warn)}
  .s-COMMITE{background:var(--info)} .s-OUVERT{background:var(--bord)}
  .leg{color:var(--mut);font-size:12.5px;margin-bottom:22px}
  .leg i{font-style:normal;margin-right:14px;white-space:nowrap}
  .leg b{color:var(--txt)}

  .filtres{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:18px}
  .filtres button{font:inherit;font-size:13px;padding:6px 12px;border-radius:999px;cursor:pointer;
    border:1px solid var(--bord);background:var(--card);color:var(--txt)}
  .filtres button[aria-pressed="true"]{background:var(--txt);color:var(--bg);border-color:var(--txt)}

  .t{background:var(--card);border:1px solid var(--bord);border-left:4px solid var(--neutre);
    border-radius:10px;padding:14px 16px;margin-bottom:11px;box-shadow:var(--ombre)}
  .t.g1{border-left-color:var(--dgr)} .t.g2{border-left-color:var(--warn)}
  .t.g3{border-left-color:var(--info)} .t.g4{border-left-color:var(--neutre)}
  .t.etat-FAIT{border-left-color:var(--ok);opacity:.72}
  .t.etat-FAIT h3{text-decoration:line-through;text-decoration-color:var(--mut)}
  .t.etat-DEPLOYE{border-left-color:var(--warn)}
  .t-h{display:flex;flex-wrap:wrap;gap:9px;align-items:center;font-size:12.5px;color:var(--mut);margin-bottom:6px}
  .marque{font-weight:700;color:var(--txt);font-size:15px;width:1.1em;text-align:center}
  .etat-FAIT .marque{color:var(--ok)} .etat-DEPLOYE .marque{color:var(--warn)}
  .id{font-weight:700;color:var(--txt);font-variant-numeric:tabular-nums}
  .fiche{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  .grav,.depuis{border:1px solid var(--bord);border-radius:5px;padding:0 6px;font-size:11.5px}
  .commit{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;
    background:var(--bg);border:1px solid var(--bord);border-radius:5px;padding:0 6px}
  .t h3{margin:0 0 5px;font-size:15.5px;font-weight:620;letter-spacing:-.01em}
  .detail{margin:0;color:var(--mut);font-size:14px}
  .preuve,.attendue{margin:8px 0 0;font-size:13.5px;padding:8px 11px;border-radius:7px;background:var(--bg);border:1px solid var(--bord)}
  .preuve b{color:var(--ok)} .attendue b{color:var(--warn)}
  .badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
  .badges:empty{display:none}
  .b{font-size:11.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--bord);color:var(--mut)}
  .b-phare{border-color:var(--ok);color:var(--ok)}
  .b-retard{border-color:var(--dgr);color:var(--dgr)}
  .b-bloque{border-color:var(--neutre)}
  .b-ech{border-color:var(--warn);color:var(--warn)}

  h2.sec{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);
    margin:30px 0 12px;font-weight:600}
  .vide{color:var(--mut);font-style:italic;padding:20px;text-align:center;
    border:1px dashed var(--bord);border-radius:10px}
  footer{margin-top:38px;padding-top:16px;border-top:1px solid var(--bord);color:var(--mut);font-size:13px}
  footer code{font-size:12px}
  @media print{.filtres{display:none} body{background:#fff}}
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>Tableau de bord des corrections — Tracky</h1>
  <p class="sous">Genere le <b>${e(AUJOURDHUI)}</b> depuis <code>app/taches.json</code>.
  Le detail, le pourquoi et les pieges vivent dans <b>ROADMAP-CORRECTIFS.md</b> —
  ce tableau ne dit que <b>l'etat</b>.</p>
</header>

<div class="kpis">
  <div class="k ok"><div class="n">${stats.fait}</div><div class="l">faites et verifiees</div></div>
  <div class="k warn"><div class="n">${stats.deploye}</div><div class="l">deployees, preuve attendue</div></div>
  <div class="k"><div class="n">${stats.ouvert}</div><div class="l">ouvertes sur ${stats.total}</div></div>
  <div class="k dgr"><div class="n">${stats.g1}</div><div class="l">ouvertes en gravite 1</div></div>
  <div class="k dgr"><div class="n">${stats.retard}</div><div class="l">au-dela de 7 jours</div></div>
  <div class="k info"><div class="n">${stats.humain}</div><div class="l">attendent un humain</div></div>
</div>

<div class="barre" role="img" aria-label="Avancement : ${stats.fait} faites, ${stats.deploye} deployees, ${stats.ouvert} ouvertes sur ${stats.total}">
  <span class="s-FAIT" style="width:${pct(stats.fait)}%"></span>
  <span class="s-DEPLOYE" style="width:${pct(stats.deploye)}%"></span>
  <span class="s-COMMITE" style="width:${pct(stats.commite)}%"></span>
  <span class="s-OUVERT" style="width:${pct(stats.ouvert)}%"></span>
</div>
<p class="leg">
  <i><b>✓</b> faite ET verifiee</i>
  <i><b>»</b> deployee, la preuve n'est pas venue</i>
  <i><b>~</b> ecrite et commitee, pas en ligne</i>
  <i><b>☐</b> ouverte</i>
  <br><i style="margin-top:4px;display:inline-block">Une tache ne passe a <b>✓</b> qu'avec une preuve : un commit ne prouve pas un deploiement, un deploiement ne prouve pas un fonctionnement.</i>
</p>

<div class="filtres" id="f">
  <button data-f="tout" aria-pressed="true">Tout (${stats.total})</button>
  <button data-f="ouvert" aria-pressed="false">Ouvertes (${stats.ouvert})</button>
  <button data-f="g1" aria-pressed="false">Gravite 1 (${stats.g1})</button>
  <button data-f="humain" aria-pressed="false">Attendent un humain (${stats.humain})</button>
  <button data-f="code" aria-pressed="false">A faire soi-meme (${stats.code})</button>
  <button data-f="centre-alerte" aria-pressed="false">Centre d'alerte</button>
  <button data-f="vps" aria-pressed="false">VPS</button>
  <button data-f="fait" aria-pressed="false">Closes (${stats.fait + stats.deploye})</button>
</div>

<h2 class="sec">Les ${stats.total} taches — ouvertes et graves d'abord</h2>
<div id="liste">
${triees.map(carte).join('\n')}
</div>
<p class="vide" id="rien" hidden>Aucune tache ne correspond a ce filtre.</p>

<footer>
  <p><b>Ce fichier est genere.</b> Ne pas l'editer a la main : la prochaine execution ecraserait la
  modification. Pour changer l'etat d'une tache, editer <code>docs/centre-alerte/app/taches.json</code>
  puis relancer&nbsp;: <code>node docs/centre-alerte/app/generer-tableau-de-bord.mjs</code></p>
  <p>Il est regenere automatiquement par les deux routines quotidiennes — l'audit du centre d'alerte
  et l'audit du VPS — et publie avec le reste de la documentation.</p>
</footer>

</div>
<script>
(() => {
  const boutons = [...document.querySelectorAll('#f button')];
  const cartes = [...document.querySelectorAll('#liste .t')];
  const rien = document.getElementById('rien');
  const HUMAIN = ['HUMAIN', 'TERRAIN', 'PRODUIT'];
  const CODE = ['A_CODER', 'CHANTIER', 'AUTO', 'PREPARE'];
  const garde = (f, c) => {
    const d = c.dataset;
    switch (f) {
      case 'tout': return true;
      case 'ouvert': return d.etat === 'OUVERT';
      case 'g1': return d.etat === 'OUVERT' && d.g === '1';
      case 'humain': return d.etat === 'OUVERT' && HUMAIN.includes(d.classe);
      case 'code': return d.etat === 'OUVERT' && CODE.includes(d.classe);
      case 'fait': return d.etat === 'FAIT' || d.etat === 'DEPLOYE';
      default: return d.partie === f;
    }
  };
  const appliquer = (f) => {
    let n = 0;
    for (const c of cartes) { const v = garde(f, c); c.hidden = !v; if (v) n++; }
    rien.hidden = n > 0;
  };
  for (const b of boutons) {
    b.addEventListener('click', () => {
      for (const o of boutons) o.setAttribute('aria-pressed', String(o === b));
      appliquer(b.dataset.f);
    });
  }
})();
</script>
</body>
</html>
`;

writeFileSync(SORTIE, html, 'utf8');
console.log(
  `TABLEAU-DE-BORD.html ecrit — ${stats.total} taches : ${stats.fait} faites, ` +
    `${stats.deploye} deployees, ${stats.ouvert} ouvertes (dont ${stats.g1} en gravite 1, ${stats.retard} au-dela de 7 j).`,
);
