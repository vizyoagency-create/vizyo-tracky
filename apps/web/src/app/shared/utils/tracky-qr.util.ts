import qrcode from 'qrcode-generator';

export interface TrackyQrOptions {
  /** Modules de zone de silence autour du QR (défaut 4). */
  quiet?: number;
  /** Fraction du QR libérée au centre pour le badge logo (défaut 0.11). */
  centerRatio?: number;
}

/**
 * QR stylisé Tracky : modules émeraude arrondis, finder patterns (yeux) redessinés, centre libéré
 * pour le badge logo. Correction `H` (30 %) — NE JAMAIS baisser : c'est ce qui permet au badge
 * central de coexister avec un scan fiable. Porté 1:1 depuis la référence design `tracky-qr.html`.
 * On ré-encode le MÊME lien signé par le serveur (`dto.url`) → aucune perte de sécurité.
 */
export function buildTrackyQrSvg(text: string, opts: TrackyQrOptions = {}): string {
  const quiet = opts.quiet ?? 4;
  const centerRatio = opts.centerRatio ?? 0.11;
  const qr = qrcode(0, 'H'); // 'H' = correction max, NE PAS baisser
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const total = n + quiet * 2;
  const mid = (n - 1) / 2;
  const ch = Math.ceil(n * centerRatio);
  const inFinder = (r: number, c: number): boolean =>
    (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  const inCenter = (r: number, c: number): boolean => Math.abs(r - mid) <= ch && Math.abs(c - mid) <= ch;
  let dots = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c) || inFinder(r, c) || inCenter(r, c)) continue;
      dots += `<rect x="${(quiet + c + 0.06).toFixed(2)}" y="${(quiet + r + 0.06).toFixed(2)}" width="0.88" height="0.88" rx="0.22" fill="url(#tg)"/>`;
    }
  }
  const eye = (x: number, y: number): string =>
    `<rect x="${x}" y="${y}" width="7" height="7" rx="1.9" fill="url(#tg)"/>` +
    `<rect x="${x + 1}" y="${y + 1}" width="5" height="5" rx="1.35" fill="#FFFFFF"/>` +
    `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="0.9" fill="url(#tg)"/>`;
  const eyes = eye(quiet, quiet) + eye(quiet + n - 7, quiet) + eye(quiet, quiet + n - 7);
  const cs = 2 * ch + 1;
  const cx = quiet + mid - ch;
  const halo = `<rect x="${(cx - 0.5).toFixed(2)}" y="${(cx - 0.5).toFixed(2)}" width="${(cs + 1).toFixed(2)}" height="${(cs + 1).toFixed(2)}" rx="2.2" fill="#FFFFFF"/>`;
  return (
    `<svg viewBox="0 0 ${total} ${total}" width="100%" height="100%" shape-rendering="geometricPrecision" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><linearGradient id="tg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#10E0A0"/><stop offset="1" stop-color="#047857"/></linearGradient></defs>` +
    `<rect x="0" y="0" width="${total}" height="${total}" fill="#FFFFFF"/>` +
    dots + eyes + halo +
    `</svg>`
  );
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/**
 * `size` est une longueur CSS, pas un nombre de pixels : la carte se redimensionne
 * en bloc via la variable `--tqu` (cf. QR_CARD_CSS), et un attribut `width` en
 * pixels serait le seul element a ne pas suivre.
 */
const LOGO = (size: string): string =>
  `<svg style="width:${size};height:auto" viewBox="0 0 283 290" fill="none"><path d="M180 11.6296C182 10.6295 193 -1.37044 224 0.129555C248.8 1.32956 267.333 22.2962 273.5 32.6296C289 59.6295 278 88.1296 277.5 90.1296C277.5 92 192 245.13 185 260.13C175.5 277.129 163.404 283.129 156 284.5C154 284.87 145.5 286.5 135 284.5C119.5 280.5 109 271 101.5 251L2 33.1296H37C55.8 33.9296 67.8333 48.1296 71.5 55.1296L137 192.63C146.6 215.429 161 220.13 166.5 220.13H166.672C171.787 220.131 182.708 220.135 189 214.63C197 207.63 202 201 203.5 188C205 175 190 148.63 185 141.63C163 105.13 158 97.6293 154.5 82.6296C151 67.6299 152.5 59.1296 153 53.6296C153.5 48.1296 156.5 40.6295 159.5 34.6296C162.5 28.6296 170.5 19.1295 180 11.6296ZM217 32.1296C198.775 32.1296 184 46.9042 184 65.1296C184 83.3548 198.775 98.1296 217 98.1296C235.225 98.1296 250 83.3548 250 65.1296C250 46.9042 235.225 32.1296 217 32.1296Z" fill="url(#lg)"/><defs><linearGradient id="lg" x1="28" y1="280" x2="230" y2="79" gradientUnits="userSpaceOnUse"><stop stop-color="#10E0A0"/><stop offset="1" stop-color="#047857"/></linearGradient></defs></svg>`;

export interface QrCardData {
  plate: string;
  model?: string | null;
  qrSvg: string;
  domain?: string;
}

/**
 * Carte premium imprimable (référence `tracky-qr.html`). Rendue à l'identique à l'écran (innerHTML)
 * ET à l'impression (fenêtre print) — mêmes classes `.tq-scope`, même CSS (`QR_CARD_CSS`).
 */
export function buildQrCardHtml(d: QrCardData): string {
  const domain = d.domain ?? 'tracky.vizyoagency.com';
  const modelField = d.model
    ? `<div class="field"><div class="mono lbl">Véhicule</div><div class="model">${esc(d.model)}</div></div>`
    : '';
  const gridCols = d.model ? '1fr 1fr' : '1fr';
  return `<div class="tq-scope"><div class="card">
  <div class="topbar"></div>
  <div class="body">
    <svg class="motif" viewBox="0 0 452 620" preserveAspectRatio="xMidYMid slice"><g fill="none" stroke="#0A9E6C" stroke-width="1.2" opacity="0.06"><path d="M-30 78 C 90 46, 150 126, 250 96 S 430 52, 520 110"/><path d="M-30 108 C 90 76, 150 156, 250 126 S 430 82, 520 140"/></g><path d="M52 556 C 140 520, 200 604, 288 566 S 404 520, 452 556" fill="none" stroke="#0A9E6C" stroke-width="1.4" stroke-dasharray="2 9" stroke-linecap="round" opacity="0.12"/></svg>
    <div class="rel">
      <div class="head"><div class="brand">${LOGO('calc(23 * var(--tqu))')}Tracky</div><span class="mono cap">Suivi de flotte</span></div>
      <div class="lede"><div class="mono eyebrow">Déverrouillage véhicule</div><h1>Scannez pour démarrer votre trajet</h1></div>
      <div class="grid" style="grid-template-columns:${gridCols}">
        <div class="field"><div class="mono lbl">Immatriculation</div><div class="mono plate">${esc(d.plate || '—')}</div></div>
        ${modelField}
      </div>
      <div class="qrcard"><div class="qrwrap">
        <div class="corners"><span class="c-tl"></span><span class="c-tr"></span><span class="c-bl"></span><span class="c-br"></span></div>
        <div class="qrslot">${d.qrSvg}</div>
        <div class="badge">${LOGO('58%')}</div>
      </div></div>
      <div class="note"><span class="ic"><svg style="width:calc(13 * var(--tqu));height:calc(13 * var(--tqu))" viewBox="0 0 24 24" fill="none" stroke="#0A9E6C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"></rect><path d="M12 18h.01"></path></svg></span><p>Ouvrez l'appareil photo de votre téléphone et cadrez le code pour <strong>déverrouiller le véhicule</strong>. Un compte Tracky disposant des permissions sur ce véhicule est requis.</p></div>
      <div class="foot"><span class="mono sec"><svg style="width:calc(12 * var(--tqu));height:calc(12 * var(--tqu))" viewBox="0 0 24 24" fill="none" stroke="#0A9E6C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>Connexion chiffrée · UE</span><span class="mono url">${esc(domain)}</span></div>
    </div>
  </div>
</div></div>`;
}

/**
 * Feuille imprimable de PLUSIEURS cartes premium (« Imprimer tous les QR »). Même carte + même QR
 * stylisé que la fiche véhicule ; une carte = une page à l'impression.
 */
export function buildQrSheetHtml(cards: QrCardData[]): string {
  const items = cards.map((c) => `<div class="tq-sheet-item">${buildQrCardHtml(c)}</div>`).join('');
  const body = cards.length
    ? `<div class="tq-sheet">${items}</div>`
    : '<p style="padding:48px;text-align:center;font-family:system-ui,sans-serif;color:#46554F">Aucun véhicule à imprimer.</p>';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR de déverrouillage — flotte</title><style>${QR_CARD_CSS}
    body{margin:0;background:#EAF0ED;font-family:'Manrope',system-ui,sans-serif;}
    .tq-sheet{display:flex;flex-wrap:wrap;gap:22px;justify-content:center;padding:26px;}
    @media print{ body{background:#fff;} .tq-sheet{gap:0;padding:0;} .tq-sheet-item{break-inside:avoid;page-break-after:always;} .tq-sheet-item:last-child{page-break-after:auto;} }
  </style></head><body>${body}<script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script></body></html>`;
}

/**
 * CSS de la carte (portée `.tq-scope`) — partagée écran (ViewEncapsulation.None) + fenêtre print.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI TOUT EST EN `--tqu`                                               │
 * │                                                                            │
 * │ La carte doit exister à deux tailles : 452 px à l'écran, et 50 mm de large │
 * │ à l'impression pour tenir dans un autocollant 60 × 90 mm — le format que   │
 * │ le dialogue annonce désormais à l'utilisateur.                             │
 * │                                                                            │
 * │ `--tqu` est l'unité de la carte. Toute longueur s'écrit `calc(N *          │
 * │ var(--tqu))`, où N est la valeur en pixels de la maquette d'origine.       │
 * │ Changer `--tqu` redimensionne la carte ENTIÈRE, texte compris, sans        │
 * │ toucher à sa composition : les retours à la ligne sont identiques, donc    │
 * │ les proportions aussi.                                                     │
 * │                                                                            │
 * │ Pourquoi pas `em` : `em` se résout contre la taille de police du PARENT.   │
 * │ Le logo vit dans `.brand`, qui porte sa propre taille — il aurait grandi   │
 * │ de 10 % sans que rien ne le signale. Une variable héritée n'a pas ce       │
 * │ défaut : elle vaut la même chose partout dans la carte.                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const QR_CARD_CSS = `
/* max-width sur .tq-scope, et pas seulement sur .card : c'est .tq-scope que
   [innerHTML] insere entre le conteneur et la carte. Sans lui, le max-width de
   .card se mesurait contre un parent LUI-MEME non contraint et ne mordait
   jamais — la carte debordait de 38 px de chaque cote sur un ecran de 375. */
/* --em ne colore que DEUX textes : le sur-titre et le domaine en pied. A #0A9E6C
   ils mesuraient 3,37:1 sur le fond de la carte — sous le seuil. Assombri a
   #08855B (4,58:1). Les traits des pictogrammes gardent #0A9E6C, ecrit en dur
   dans le gabarit : un trait releve du seuil de 3:1, qu'il franchit. */
.tq-scope { --em:#08855B; --ink:#0C1512; max-width:100%; }
.tq-scope, .tq-scope * { box-sizing:border-box; }
.tq-scope .mono { font-family:'JetBrains Mono','JetBrains Mono Variable',monospace; }
.tq-scope .card { --tqu:1px; width:calc(452 * var(--tqu)); max-width:100%; position:relative; overflow:hidden; background:#FCFDFC; border:calc(1 * var(--tqu)) solid rgba(12,21,18,.11); border-radius:calc(22 * var(--tqu)); box-shadow:0 calc(28 * var(--tqu)) calc(64 * var(--tqu)) calc(-34 * var(--tqu)) rgba(4,66,44,.42),0 calc(1 * var(--tqu)) calc(3 * var(--tqu)) rgba(12,21,18,.05); font-family:'Manrope','Manrope Variable',system-ui,sans-serif; color:var(--ink); }
.tq-scope .topbar { height:calc(4 * var(--tqu)); background:linear-gradient(90deg,#10E0A0,#047857); }
.tq-scope .body { position:relative; padding:calc(28 * var(--tqu)) calc(30 * var(--tqu)) calc(26 * var(--tqu)); }
.tq-scope .motif { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
.tq-scope .rel { position:relative; z-index:1; }
.tq-scope .head { display:flex; align-items:center; justify-content:space-between; gap:calc(12 * var(--tqu)); }
.tq-scope .brand { display:flex; align-items:center; gap:calc(9 * var(--tqu)); font-size:calc(17.6 * var(--tqu)); font-weight:800; letter-spacing:-.02em; }
.tq-scope .cap { font-size:calc(9.28 * var(--tqu)); font-weight:600; letter-spacing:.2em; text-transform:uppercase; color:#6D7773; }
.tq-scope .eyebrow { font-size:calc(9.6 * var(--tqu)); font-weight:600; letter-spacing:.18em; text-transform:uppercase; color:var(--em); }
.tq-scope h1 { margin:calc(6 * var(--tqu)) 0 0; font-size:calc(24 * var(--tqu)); font-weight:800; letter-spacing:-.03em; line-height:1.1; }
.tq-scope .lede { margin-top:calc(22 * var(--tqu)); }
.tq-scope .grid { display:grid; gap:calc(10 * var(--tqu)); margin-top:calc(18 * var(--tqu)); }
.tq-scope .field { background:#fff; border:calc(1 * var(--tqu)) solid rgba(12,21,18,.1); border-radius:calc(12 * var(--tqu)); padding:calc(11 * var(--tqu)) calc(13 * var(--tqu)); }
.tq-scope .field .lbl { font-size:calc(8.64 * var(--tqu)); font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:#6A7772; }
.tq-scope .field .plate { font-size:calc(16.32 * var(--tqu)); font-weight:700; letter-spacing:.01em; color:var(--ink); margin-top:calc(4 * var(--tqu)); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tq-scope .field .model { font-size:calc(13.76 * var(--tqu)); font-weight:700; color:var(--ink); margin-top:calc(4 * var(--tqu)); line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tq-scope .qrcard { margin-top:calc(14 * var(--tqu)); background:#fff; border:calc(1 * var(--tqu)) solid rgba(12,21,18,.1); border-radius:calc(18 * var(--tqu)); padding:calc(22 * var(--tqu)); box-shadow:0 calc(8 * var(--tqu)) calc(26 * var(--tqu)) calc(-18 * var(--tqu)) rgba(4,66,44,.3); }
.tq-scope .qrwrap { position:relative; width:100%; aspect-ratio:1/1; }
.tq-scope .qrslot { width:100%; height:100%; }
.tq-scope .qrslot svg { display:block; width:100%; height:100%; }
.tq-scope .corners { position:absolute; inset:calc(-6 * var(--tqu)); pointer-events:none; }
.tq-scope .corners span { position:absolute; width:calc(20 * var(--tqu)); height:calc(20 * var(--tqu)); }
.tq-scope .c-tl { top:0; left:0; border-top:calc(2 * var(--tqu)) solid #10E0A0; border-left:calc(2 * var(--tqu)) solid #10E0A0; border-radius:calc(5 * var(--tqu)) 0 0 0; }
.tq-scope .c-tr { top:0; right:0; border-top:calc(2 * var(--tqu)) solid #10E0A0; border-right:calc(2 * var(--tqu)) solid #10E0A0; border-radius:0 calc(5 * var(--tqu)) 0 0; }
.tq-scope .c-bl { bottom:0; left:0; border-bottom:calc(2 * var(--tqu)) solid #047857; border-left:calc(2 * var(--tqu)) solid #047857; border-radius:0 0 0 calc(5 * var(--tqu)); }
.tq-scope .c-br { bottom:0; right:0; border-bottom:calc(2 * var(--tqu)) solid #047857; border-right:calc(2 * var(--tqu)) solid #047857; border-radius:0 0 calc(5 * var(--tqu)) 0; }
.tq-scope .badge { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:19%; aspect-ratio:1/1; background:#fff; border-radius:22%; box-shadow:0 calc(3 * var(--tqu)) calc(12 * var(--tqu)) calc(-4 * var(--tqu)) rgba(4,66,44,.34); display:flex; align-items:center; justify-content:center; }
.tq-scope .note { display:flex; align-items:flex-start; gap:calc(9 * var(--tqu)); margin-top:calc(16 * var(--tqu)); }
.tq-scope .note .ic { flex-shrink:0; display:inline-flex; align-items:center; justify-content:center; width:calc(22 * var(--tqu)); height:calc(22 * var(--tqu)); border-radius:calc(6 * var(--tqu)); background:rgba(10,158,108,.1); }
.tq-scope .note p { margin:0; font-size:calc(12.8 * var(--tqu)); line-height:1.5; color:#46554F; }
.tq-scope .note strong { color:#0C1512; font-weight:700; }
.tq-scope .foot { display:flex; align-items:center; justify-content:space-between; gap:calc(10 * var(--tqu)); margin-top:calc(18 * var(--tqu)); padding-top:calc(15 * var(--tqu)); border-top:calc(1 * var(--tqu)) solid rgba(12,21,18,.09); }
.tq-scope .foot .sec { display:inline-flex; align-items:center; gap:calc(6 * var(--tqu)); font-size:calc(9.6 * var(--tqu)); font-weight:500; letter-spacing:.03em; color:#6A7772; }
.tq-scope .foot .url { font-size:calc(10.56 * var(--tqu)); font-weight:700; letter-spacing:.01em; color:var(--em); }

/* Sur un telephone, c'est la MARGE qui cede, pas le QR.
   On scanne souvent l'ecran d'un collegue plutot que l'autocollant : le code doit
   rester lisible par un autre appareil, donc au-dessus de 262 px. Retrecir la carte
   proportionnellement le ramenait a 261 px — juste sous la barre. On reduit donc la
   marge interieure et le code garde sa taille. */
@media (max-width:440px) {
  .tq-scope .body { padding:calc(20 * var(--tqu)) calc(20 * var(--tqu)) calc(18 * var(--tqu)); }
  .tq-scope .qrcard { padding:calc(15 * var(--tqu)); }
}

/* Autocollant 60 x 90 mm — le format que le dialogue annonce.
   La carte mesure 452 x 792 px, soit un rapport de 1,753. A 60 mm de large elle
   ferait 105 mm de haut et ne tiendrait pas : c'est donc la HAUTEUR qui commande.
   50 mm de large donnent 87,6 mm de haut, centres dans la page. */
@media print {
  @page { size:60mm 90mm; margin:0; }
  .tq-scope { display:flex; align-items:center; justify-content:center; width:60mm; height:90mm; }
  .tq-scope .card { --tqu:calc(50mm / 452); box-shadow:none; border:none; }
}
`;
