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

const LOGO = (size: string): string =>
  `<svg width="${size}" viewBox="0 0 283 290" fill="none"><path d="M180 11.6296C182 10.6295 193 -1.37044 224 0.129555C248.8 1.32956 267.333 22.2962 273.5 32.6296C289 59.6295 278 88.1296 277.5 90.1296C277.5 92 192 245.13 185 260.13C175.5 277.129 163.404 283.129 156 284.5C154 284.87 145.5 286.5 135 284.5C119.5 280.5 109 271 101.5 251L2 33.1296H37C55.8 33.9296 67.8333 48.1296 71.5 55.1296L137 192.63C146.6 215.429 161 220.13 166.5 220.13H166.672C171.787 220.131 182.708 220.135 189 214.63C197 207.63 202 201 203.5 188C205 175 190 148.63 185 141.63C163 105.13 158 97.6293 154.5 82.6296C151 67.6299 152.5 59.1296 153 53.6296C153.5 48.1296 156.5 40.6295 159.5 34.6296C162.5 28.6296 170.5 19.1295 180 11.6296ZM217 32.1296C198.775 32.1296 184 46.9042 184 65.1296C184 83.3548 198.775 98.1296 217 98.1296C235.225 98.1296 250 83.3548 250 65.1296C250 46.9042 235.225 32.1296 217 32.1296Z" fill="url(#lg)"/><defs><linearGradient id="lg" x1="28" y1="280" x2="230" y2="79" gradientUnits="userSpaceOnUse"><stop stop-color="#10E0A0"/><stop offset="1" stop-color="#047857"/></linearGradient></defs></svg>`;

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
      <div class="head"><div class="brand">${LOGO('23')}Tracky</div><span class="mono cap">Suivi de flotte</span></div>
      <div style="margin-top:22px"><div class="mono eyebrow">Déverrouillage véhicule</div><h1>Scannez pour démarrer votre trajet</h1></div>
      <div class="grid" style="grid-template-columns:${gridCols}">
        <div class="field"><div class="mono lbl">Immatriculation</div><div class="mono plate">${esc(d.plate || '—')}</div></div>
        ${modelField}
      </div>
      <div class="qrcard"><div class="qrwrap">
        <div class="corners"><span class="c-tl"></span><span class="c-tr"></span><span class="c-bl"></span><span class="c-br"></span></div>
        <div class="qrslot">${d.qrSvg}</div>
        <div class="badge">${LOGO('58%')}</div>
      </div></div>
      <div class="note"><span class="ic"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#0A9E6C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"></rect><path d="M12 18h.01"></path></svg></span><p>Ouvrez l'appareil photo de votre téléphone et cadrez le code pour <strong>déverrouiller le véhicule</strong>. Un compte Tracky disposant des permissions sur ce véhicule est requis.</p></div>
      <div class="foot"><span class="mono sec"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#0A9E6C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>Connexion chiffrée · UE</span><span class="mono url">${esc(domain)}</span></div>
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

/** CSS de la carte (portée `.tq-scope`) — partagée écran (ViewEncapsulation.None) + fenêtre print. */
export const QR_CARD_CSS = `
.tq-scope { --em:#0A9E6C; --ink:#0C1512; }
.tq-scope, .tq-scope * { box-sizing:border-box; }
.tq-scope .mono { font-family:'JetBrains Mono','JetBrains Mono Variable',monospace; }
.tq-scope .card { width:452px; max-width:100%; position:relative; overflow:hidden; background:#FCFDFC; border:1px solid rgba(12,21,18,.11); border-radius:22px; box-shadow:0 28px 64px -34px rgba(4,66,44,.42),0 1px 3px rgba(12,21,18,.05); font-family:'Manrope','Manrope Variable',system-ui,sans-serif; color:var(--ink); }
.tq-scope .topbar { height:4px; background:linear-gradient(90deg,#10E0A0,#047857); }
.tq-scope .body { position:relative; padding:28px 30px 26px; }
.tq-scope .motif { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
.tq-scope .rel { position:relative; z-index:1; }
.tq-scope .head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.tq-scope .brand { display:flex; align-items:center; gap:9px; font-size:1.1rem; font-weight:800; letter-spacing:-.02em; }
.tq-scope .cap { font-size:.58rem; font-weight:600; letter-spacing:.2em; text-transform:uppercase; color:#9AA8A2; }
.tq-scope .eyebrow { font-size:.6rem; font-weight:600; letter-spacing:.18em; text-transform:uppercase; color:var(--em); }
.tq-scope h1 { margin:6px 0 0; font-size:1.5rem; font-weight:800; letter-spacing:-.03em; line-height:1.1; }
.tq-scope .grid { display:grid; gap:10px; margin-top:18px; }
.tq-scope .field { background:#fff; border:1px solid rgba(12,21,18,.1); border-radius:12px; padding:11px 13px; }
.tq-scope .field .lbl { font-size:.54rem; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:#7A8983; }
.tq-scope .field .plate { font-size:1.02rem; font-weight:700; letter-spacing:.01em; color:var(--ink); margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tq-scope .field .model { font-size:.86rem; font-weight:700; color:var(--ink); margin-top:4px; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tq-scope .qrcard { margin-top:14px; background:#fff; border:1px solid rgba(12,21,18,.1); border-radius:18px; padding:22px; box-shadow:0 8px 26px -18px rgba(4,66,44,.3); }
.tq-scope .qrwrap { position:relative; width:100%; aspect-ratio:1/1; }
.tq-scope .qrslot { width:100%; height:100%; }
.tq-scope .qrslot svg { display:block; width:100%; height:100%; }
.tq-scope .corners { position:absolute; inset:-6px; pointer-events:none; }
.tq-scope .corners span { position:absolute; width:20px; height:20px; }
.tq-scope .c-tl { top:0; left:0; border-top:2px solid #10E0A0; border-left:2px solid #10E0A0; border-radius:5px 0 0 0; }
.tq-scope .c-tr { top:0; right:0; border-top:2px solid #10E0A0; border-right:2px solid #10E0A0; border-radius:0 5px 0 0; }
.tq-scope .c-bl { bottom:0; left:0; border-bottom:2px solid #047857; border-left:2px solid #047857; border-radius:0 0 0 5px; }
.tq-scope .c-br { bottom:0; right:0; border-bottom:2px solid #047857; border-right:2px solid #047857; border-radius:0 0 5px 0; }
.tq-scope .badge { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:19%; aspect-ratio:1/1; background:#fff; border-radius:22%; box-shadow:0 3px 12px -4px rgba(4,66,44,.34); display:flex; align-items:center; justify-content:center; }
.tq-scope .note { display:flex; align-items:flex-start; gap:9px; margin-top:16px; }
.tq-scope .note .ic { flex-shrink:0; display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:6px; background:rgba(10,158,108,.1); }
.tq-scope .note p { margin:0; font-size:.8rem; line-height:1.5; color:#46554F; }
.tq-scope .note strong { color:#0C1512; font-weight:700; }
.tq-scope .foot { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:18px; padding-top:15px; border-top:1px solid rgba(12,21,18,.09); }
.tq-scope .foot .sec { display:inline-flex; align-items:center; gap:6px; font-size:.6rem; font-weight:500; letter-spacing:.03em; color:#7A8983; }
.tq-scope .foot .url { font-size:.66rem; font-weight:700; letter-spacing:.01em; color:var(--em); }
@media print { @page { margin:12mm; } .tq-scope .card { box-shadow:none; border:none; } }
`;
