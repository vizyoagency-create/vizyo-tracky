// ──────────────────────────────────────────────────────────────────────────
//  Générateur statique Vizyo Tracky (zéro dépendance) — design premium.
//  Prend les pages "design" (format x-dc de claude.ai/design) dans lp/design/,
//  retire le runtime React/Babel (support.js), injecte un <head> SEO complet
//  (title/description/canonical/OG/JSON-LD/geo) + l'interactivité vanilla vt.js,
//  et produit du HTML statique autonome dans lp/public/ (servi tel quel).
//  Usage : node build.mjs
// ──────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { site } from './src/data/site.mjs';
import { pricing } from './src/data/pricing.mjs';
import { cities } from './src/data/cities.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = (p) => join(__dir, p);
const readDesign = (p) => readFileSync(root('design/' + p), 'utf8');
const pub = (p) => root('public/' + p);
const fmt = (n) => n.toFixed(2).replace('.', ',');
const P = pricing.plans, A = pricing.addons;

// Cache-busting de vt.js (hash de contenu)
const VT_V = createHash('md5').update(readFileSync(pub('assets/vt.js'))).digest('hex').slice(0, 8);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const abs = (path) => site.baseUrl + (path.startsWith('/') ? path : '/' + path);

// ── JSON-LD ──
const ORG_LD = { '@context': 'https://schema.org', '@type': 'Organization', name: site.name, url: site.baseUrl, logo: abs('/favicon-512.png'), email: site.email, telephone: site.phoneE164, areaServed: site.region, sameAs: [site.agencyUrl] };
const WEBSITE_LD = { '@context': 'https://schema.org', '@type': 'WebSite', name: site.name, url: site.baseUrl, inLanguage: 'fr-FR' };
const crumb = (items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.out === 'index.html' ? site.baseUrl + '/' : abs(it.out) })) });
const faqLd = (qa) => ({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: qa.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) });
const productLd = () => ({ '@context': 'https://schema.org', '@type': 'Product', name: 'Vizyo Tracky — traceur GPS de flotte', description: 'Boîtier GPS + application française : géolocalisation temps réel, coupure moteur, alertes, rapports.', brand: { '@type': 'Brand', name: 'Vizyo Tracky' }, offers: { '@type': 'AggregateOffer', priceCurrency: 'EUR', lowPrice: P.lite.annual, highPrice: P.pro.monthly, offerCount: 3, offers: [{ '@type': 'Offer', name: 'Tracky Lite (annuel)', price: P.lite.annual, priceCurrency: 'EUR' }, { '@type': 'Offer', name: 'Tracky Pro (annuel)', price: P.pro.annual, priceCurrency: 'EUR' }] } });
const localBizLd = (c, out) => ({ '@context': 'https://schema.org', '@type': 'LocalBusiness', name: `Vizyo Tracky — ${c.name}`, description: `Installation de traceurs GPS de flotte à ${c.name} (${c.dept}) et dans tout le département. Géolocalisation temps réel, coupure moteur, support local.`, url: abs(out), telephone: site.phoneE164, email: site.email, priceRange: '€€', areaServed: { '@type': 'City', name: c.name }, address: { '@type': 'PostalAddress', addressLocality: c.name, addressRegion: 'Occitanie', addressCountry: 'FR' }, geo: { '@type': 'GeoCoordinates', latitude: c.lat, longitude: c.lng } });
const HOME = { name: 'Accueil', out: 'index.html' };

// ── <head> SEO (le design fournit polices + styles via son <helmet>) ──
function seoHead({ title, description, canonical, jsonld = [], geo, robots }) {
  const img = abs(site.ogImage);
  const ld = jsonld.map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');
  const geoTags = geo ? `<meta name="geo.region" content="FR-${geo.dept}"><meta name="geo.placename" content="${esc(geo.place)}"><meta name="geo.position" content="${geo.lat};${geo.lng}"><meta name="ICBM" content="${geo.lat}, ${geo.lng}">` : '';
  return `<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="${robots || 'index,follow'}">
<meta name="theme-color" content="#080B0A">
${geoTags}
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(site.name)}"><meta property="og:locale" content="${site.locale}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${img}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${img}">
<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="icon" type="image/png" sizes="48x48" href="/favicon-48.png"><link rel="icon" type="image/png" sizes="96x96" href="/favicon-96.png"><link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon-180.png"><link rel="manifest" href="/site.webmanifest">
${ld}
<script>window.VT_CFG=${JSON.stringify({ leadApi: site.leadApi, partnerApi: site.appUrl + '/api/partner/activity', wa: 'https://wa.me/' + site.whatsapp, tel: site.phoneDisplay, telE164: site.phoneE164 })};</script>`;
}

// ── Simulateur tarifs : styles initiaux (identiques à vt.js) ──
const seg = (a) => `flex:1;padding:11px;border-radius:9px;border:none;cursor:pointer;font-weight:700;font-size:.9rem;font-family:inherit;transition:all .2s;${a ? 'background:var(--accent);color:var(--accent-ink)' : 'background:transparent;color:var(--tx2)'}`;
const opt = (a) => `padding:13px 10px;border-radius:11px;cursor:pointer;font-weight:700;font-size:.88rem;font-family:inherit;text-align:center;transition:all .2s;${a ? 'background:var(--accent-soft);border:1.5px solid var(--accent);color:var(--accent)' : 'background:var(--surface);border:1px solid var(--border);color:var(--tx2)'}`;
const tog = (a) => `flex:none;width:50px;height:28px;border-radius:16px;border:none;cursor:pointer;padding:3px;display:flex;transition:all .2s;justify-content:${a ? 'flex-end' : 'flex-start'};background:${a ? 'var(--accent)' : 'var(--border2)'}`;
const THUMB = 'width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3)';
const optRow = (title, note, val) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--surface2);margin-bottom:14px"><div><div style="font-weight:700;font-size:.92rem">${title}</div><div style="font-size:.78rem;color:var(--tx2)">${note}</div></div><button data-sim="opt" data-val="${val}" aria-label="${esc(title)}" style="${tog(false)}"><span style="${THUMB}"></span></button></div>`;
const resCard = (label, out, sub, accent) => `<div style="border:${accent ? '1.5px solid var(--accent)' : '1px solid var(--border)'};border-radius:12px;padding:15px;background:${accent ? 'var(--accent-soft)' : 'var(--surface2)'}"><div style="font-size:.7rem;color:var(--tx2);margin-bottom:5px">${label}</div><div data-out="${out}" style="font-size:1.35rem;font-weight:800;letter-spacing:-.02em${accent ? ';color:var(--accent)' : ''}">…</div><div${sub.o ? ` data-out="${sub.o}"` : ''} style="font-size:.66rem;color:var(--tx3);margin-top:2px">${sub.t}</div></div>`;

// ── Champs de formulaire lead (réutilisés par la section démo et le devis) ──
const leadField = (label, name, type, req, ph) =>
  `<div style="display:flex;flex-direction:column;gap:6px;text-align:left"><label style="font-size:.8rem;font-weight:600;color:var(--tx2)">${label}${req ? ' *' : ''}</label><input type="${type}" name="${name}"${req ? ' required' : ''} placeholder="${esc(ph || '')}" style="padding:12px 14px;border-radius:10px;border:1px solid var(--border);background:var(--surface2);color:var(--tx);font:inherit;font-size:.92rem;outline:none"></div>`;

// ── Section « Recevoir une présentation » : VRAI formulaire lead → POST site.leadApi (vt.js) ──
const DEMO_SECTION = `<section id="demo" class="vt-sec" style="padding:72px 0;position:relative;overflow:hidden;border-bottom:1px solid var(--border)">
<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:640px;height:320px;background:radial-gradient(ellipse,var(--accent-soft),transparent 70%);pointer-events:none"></div>
<div data-reveal style="max-width:560px;margin:0 auto;padding:0 32px;text-align:center;position:relative">
<div style="display:inline-flex;align-items:center;gap:10px;margin-bottom:16px"><span style="width:26px;height:2px;background:var(--accent);border-radius:2px"></span><span style="font-family:'JetBrains Mono',monospace;font-size:.68rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)">Réponse en moins de 2h · Sans engagement</span><span style="width:26px;height:2px;background:var(--accent);border-radius:2px"></span></div>
<h2 style="font-size:clamp(1.7rem,3.4vw,2.3rem);font-weight:800;letter-spacing:-.03em;line-height:1.08;margin:0 0 8px">Demandez votre démo gratuite.</h2>
<p style="font-size:1rem;line-height:1.55;color:var(--tx2);margin:0 0 22px">Laissez vos coordonnées — on s'occupe du reste, en 2 minutes.</p>
<form data-vt-lead="${site.leadApi}" style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:20px;box-shadow:var(--shadow-sm);display:grid;gap:12px;text-align:left">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${leadField('Nom', 'name', 'text', true, 'Jean Dupont')}${leadField('E-mail', 'email', 'email', true, 'vous@societe.fr')}</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${leadField('Téléphone', 'phone', 'tel', false, '06 12 34 56 78')}${leadField('Nombre de véhicules', 'fleetSize', 'text', false, 'ex : 8')}</div>
<button type="submit" style="display:flex;align-items:center;justify-content:center;gap:8px;background:var(--accent);color:var(--accent-ink);font-weight:700;font-size:.98rem;padding:14px;border-radius:11px;border:none;cursor:pointer;transition:transform .2s" data-vth="transform:translateY(-2px)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Recevoir ma démo</button>
<div data-form-status style="font-size:.84rem;min-height:1.1em;color:var(--tx2);text-align:center"></div>
</form>
<div style="margin-top:14px;font-size:.86rem;color:var(--tx2)">ou <a href="https://wa.me/${site.whatsapp}" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600">WhatsApp</a> · <a href="tel:${site.phoneE164}" style="color:var(--accent);font-weight:600">${site.phoneDisplay}</a></div>
</div>
</section>`;

// Section simulateur → devis signable (remplace le composant React du design).
const SIM_SECTION = `<section class="vt-sec" id="simulateur" style="padding:96px 0">
<div style="max-width:780px;margin:0 auto;padding:0 32px">
<div data-reveal style="text-align:center;max-width:40rem;margin:0 auto 40px">
<p style="font-family:'JetBrains Mono',monospace;font-size:.74rem;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:600;margin:0 0 14px">Devis en ligne</p>
<h2 style="font-size:clamp(1.8rem,3.4vw,2.5rem);font-weight:800;letter-spacing:-.025em;line-height:1.1;margin:0 0 14px">Composez votre devis.</h2>
<p style="font-size:1.04rem;line-height:1.6;color:var(--tx2);margin:0">Configurez votre flotte, obtenez votre tarif tout compris, puis validez votre devis en un clic. Tarif bloqué à la souscription.</p>
</div>
<div id="vt-sim" data-reveal style="background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:30px;box-shadow:var(--shadow-sm)">
<div style="display:flex;gap:8px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:5px;margin-bottom:26px">
<button data-sim="plan" data-val="lite" style="${seg(false)}">Tracky Lite</button>
<button data-sim="plan" data-val="pro" style="${seg(true)}">Tracky Pro</button>
</div>
<div style="margin-bottom:26px">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><label style="font-weight:700;font-size:.95rem">Nombre de véhicules</label><span data-out="vehicles" style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:1.4rem;color:var(--accent)">5</span></div>
<input type="range" min="1" max="50" step="1" value="5" data-sim="vehicles" aria-label="Nombre de véhicules" style="width:100%;height:6px;cursor:pointer;accent-color:var(--accent)">
<div style="display:flex;justify-content:space-between;margin-top:6px;font-size:.74rem;color:var(--tx3)"><span>1</span><span>50+ → Tracky Fleet</span></div>
</div>
<div style="margin-bottom:26px">
<label style="display:block;font-weight:700;font-size:.95rem;margin-bottom:11px">Engagement</label>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
<button data-sim="eng" data-val="annual" style="${opt(true)}">Annuel renouvelable<small style="display:block;font-weight:500;font-size:.72rem;opacity:.7;margin-top:2px">tarif bloqué</small></button>
<button data-sim="eng" data-val="monthly" style="${opt(false)}">Mensuel<small style="display:block;font-weight:500;font-size:.72rem;opacity:.7;margin-top:2px">sans engagement</small></button>
</div>
</div>
${optRow('Option Live temps réel (15 s)', '+9,90 €/véhicule/mois · <a href="#modele" style="color:var(--accent);font-weight:600">détails ›</a>', 'live')}
${optRow("Option Micro d'assistance <span style=\"font-weight:500;color:var(--tx3)\">(légal)</span>", '+6,90 €/véhicule/mois', 'micro')}
${optRow('Option Agent IA <span style="font-weight:500;color:var(--tx3)">(optimisation)</span>', '+14,90 €/véhicule/mois', 'agent')}
<div style="margin-bottom:26px;margin-top:12px">
<label style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-weight:700;font-size:.95rem;margin-bottom:11px">Rétention de l'historique</label>
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
<button data-sim="ret" data-val="90j" style="${opt(true)}">90 jours<small style="display:block;font-weight:500;font-size:.68rem;opacity:.7;margin-top:2px">inclus</small></button>
<button data-sim="ret" data-val="1an" style="${opt(false)}">1 an<small style="display:block;font-weight:500;font-size:.68rem;opacity:.7;margin-top:2px">+3,90 €</small></button>
<button data-sim="ret" data-val="2ans" style="${opt(false)}">2 ans<small style="display:block;font-weight:500;font-size:.68rem;opacity:.7;margin-top:2px">+6,90 €</small></button>
<button data-sim="ret" data-val="3ans" style="${opt(false)}">3 ans<small style="display:block;font-weight:500;font-size:.68rem;opacity:.7;margin-top:2px">+9,90 €</small></button>
</div>
</div>
<div style="height:1px;background:var(--border);margin:0 0 24px"></div>
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px">
${resCard('Par jour / véhicule', 'perDay', { t: 'tout compris' })}
${resCard('Mensuel total', 'monthTotal', { o: 'perVeh', t: '' }, true)}
${resCard('Coût 1re année', 'year1', { t: 'boîtier + install + abo' })}
${resCard('Années suivantes', 'recurring', { t: 'abonnement seul' })}
</div>
<div style="border:1px solid var(--border);border-radius:12px;padding:18px;background:var(--surface2);margin-bottom:22px">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px"><span style="font-size:.82rem;color:var(--tx2)">Économies estimées</span><span data-out="roi" style="font-weight:800;font-size:1.15rem;color:var(--accent)">…</span></div>
<div style="height:8px;border-radius:5px;background:var(--border);overflow:hidden"><div style="height:100%;width:62%;background:linear-gradient(90deg,var(--accent2),var(--accent))"></div></div>
<p style="font-size:.74rem;color:var(--tx3);margin:10px 0 0">Carburant &amp; usage maîtrisés, par an pour votre flotte.</p>
</div>
<div style="display:flex;align-items:flex-start;gap:9px;font-size:.82rem;color:var(--tx2);margin-bottom:22px"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.8" style="flex:none;margin-top:1px"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/></svg><span data-out="installNote">Installation : 29 €/véhicule (dès 5).</span></div>
<form data-vt-lead="${site.leadApi}" data-require-accord style="display:grid;gap:14px;border-top:1px solid var(--border);padding-top:24px;text-align:left">
<div style="font-weight:800;font-size:1.05rem;text-align:center;margin-bottom:2px">Recevez ce devis et validez-le</div>
<input type="hidden" name="message"><input type="hidden" name="fleetSize">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${leadField('Nom', 'name', 'text', true, 'Jean Dupont')}${leadField('Société', 'company', 'text', false, 'Votre entreprise')}</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${leadField('E-mail', 'email', 'email', true, 'vous@societe.fr')}${leadField('Téléphone', 'phone', 'tel', false, '06 12 34 56 78')}</div>
<label style="display:flex;align-items:flex-start;gap:10px;font-size:.86rem;color:var(--tx2);cursor:pointer"><input type="checkbox" name="accord" style="margin-top:2px;width:18px;height:18px;accent-color:var(--accent);flex:none"><span><strong style="color:var(--tx)">Bon pour accord.</strong> Je valide ce devis indicatif et souhaite être recontacté(e) pour le finaliser — tarif bloqué à la souscription, sans engagement de ma part à ce stade.</span></label>
<button type="submit" style="display:flex;align-items:center;justify-content:center;gap:8px;background:var(--accent);color:var(--accent-ink);font-weight:700;font-size:.98rem;padding:15px;border-radius:12px;border:none;cursor:pointer;transition:transform .2s" data-vth="transform:translateY(-2px)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Valider et recevoir mon devis</button>
<div data-form-status style="font-size:.84rem;min-height:1.1em;color:var(--tx2);text-align:center"></div>
</form>
</div>
</div>
</section>`;

// ── Transformation d'une page design → contenu statique ──
function transform(html, out) {
  const helmetM = html.match(/<helmet>([\s\S]*?)<\/helmet>/);
  const bodyM = html.match(/<\/helmet>([\s\S]*?)<\/x-dc>/);
  if (!helmetM || !bodyM) throw new Error('structure x-dc introuvable dans ' + out);
  const helmet = helmetM[1].trim();
  let body = bodyM[1].trim();
  // bindings support.js → hooks vanilla
  body = body
    .replace(/onClick="\{\{ toggleTheme \}\}"/g, 'data-vt="theme"')
    .replace(/onClick="\{\{ toggleMenu \}\}"/g, 'data-vt="menu"')
    .replace(/style="display:\{\{ menuDisplay \}\};/g, 'id="vt-menu" style="display:none;')
    .replace(/ style-hover="([^"]*)"/g, ' data-vth="$1"');
  // Page tarifs : remplace la section simulateur (bindings React) par le devis signable autonome
  if (out === 'tarifs.html') body = body.replace(/<section[^>]*id="simulateur"[\s\S]*?<\/section>/, SIM_SECTION);
  // Page accueil : remplace la section #demo (2 boutons morts) par le VRAI formulaire lead.
  if (out === 'index.html') body = body.replace(/<section[^>]*id="demo"[\s\S]*?<\/section>/, DEMO_SECTION);
  // Répare le lien mort de l'agence en footer (toutes pages).
  body = body.replace(/<a href="#"([^>]*)>vizyoagency\.com<\/a>/g, `<a href="${site.agencyUrl}"$1 target="_blank" rel="noopener">vizyoagency.com</a>`);
  return { helmet, body };
}

function buildPage(meta) {
  const canonical = meta.out === 'index.html' ? site.baseUrl + '/' : abs(meta.out);
  const { helmet, body } = transform(readDesign(meta.file || meta.out), meta.out);
  const head = seoHead({ title: meta.title, description: meta.description, canonical, jsonld: meta.jsonld || [], geo: meta.geo, robots: meta.robots });
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
${head}
${helmet}
</head>
<body>
${body}
<script src="assets/vt.js?v=${VT_V}"></script>
</body>
</html>`;
  const leftover = html.match(/\{\{[^}]*\}\}/);
  if (leftover) console.warn('  ⚠︎ binding non résolu dans', meta.out, ':', leftover[0]);
  writeFileSync(pub(meta.out), html, 'utf8');
  return meta.out === 'index.html' ? site.baseUrl + '/' : abs(meta.out);
}

// ── Manifeste des pages principales (SEO) ──
const PAGES = [
  { out: 'index.html', title: 'Vizyo Tracky — Traçage GPS & gestion de flotte en Occitanie', description: "Boîtier GPS + application française pour gérer votre flotte : géolocalisation temps réel, coupure moteur, alertes, rapports. Installation à Toulouse et en Occitanie.", jsonld: [ORG_LD, WEBSITE_LD] },
  { out: 'fonctionnalites.html', title: 'Fonctionnalités — GPS temps réel, coupure moteur, alertes | Vizyo Tracky', description: "Toutes les fonctionnalités de Vizyo Tracky : géolocalisation temps réel, Live 15 s, historique, coupure moteur par plage horaire, alertes, rapports, conducteurs identifiés, mode vie privée CNIL.", jsonld: [productLd(), crumb([HOME, { name: 'Fonctionnalités', out: 'fonctionnalites.html' }])] },
  { out: 'tarifs.html', title: `Tarifs & simulateur GPS flotte — dès ${fmt(P.lite.annual)} €/véhicule | Vizyo Tracky`, description: `Tarifs clairs et bloqués à la souscription : Tracky Lite dès ${fmt(P.lite.annual)} €, Pro dès ${fmt(P.pro.annual)} €/véhicule/mois HT. Options Live temps réel, micro, agent IA, rétention. Simulateur en ligne.`, jsonld: [productLd(), crumb([HOME, { name: 'Tarifs', out: 'tarifs.html' }]), faqLd([{ q: 'Quels sont les tarifs de Vizyo Tracky ?', a: `Tracky Lite à ${fmt(P.lite.annual)} € et Tracky Pro à ${fmt(P.pro.annual)} € par véhicule et par mois HT en engagement annuel renouvelable. SIM et data incluses.` }, { q: 'Le temps réel est-il inclus ?', a: `Le suivi standard est inclus. Le Live temps réel (15 s) est une option à ${fmt(A.live.perVehMonth)} €/véhicule/mois car il génère beaucoup plus de données.` }, { q: 'Le tarif peut-il augmenter ?', a: "Non : le tarif est garanti à la souscription et reconduit au même prix. Pas d'augmentation surprise." }])] },
  { out: 'secteur-public.html', title: 'GPS véhicules de service — secteur public & médico-social | Vizyo Tracky', description: "Géolocalisation des véhicules de service pour établissements publics, foyers, structures médico-sociales et collectivités : conformité CNIL, conducteurs identifiés, données souveraines, marchés publics.", jsonld: [crumb([HOME, { name: 'Secteur public', out: 'secteur-public.html' }])] },
  { out: 'securite.html', title: 'Sécurité & conformité RGPD — hébergement France | Vizyo Tracky', description: "Vos données restent en France, sous votre contrôle : hébergement souverain, chiffrement TLS 1.3, conformité RGPD by design, mode vie privée CNIL.", jsonld: [crumb([HOME, { name: 'Sécurité', out: 'securite.html' }])] },
  { out: 'partenariat-maestroo.html', title: 'Vizyo Tracky × Maestroo — le GPS de flotte dans votre gestion de transport', description: "Vizyo Tracky en partenariat avec Maestroo : GPS temps réel, coupe-circuit moteur, analyse IA des trajets et pilotage des économies, bientôt intégrés à votre logiciel de gestion de transport. Découvrez la présentation animée.", jsonld: [crumb([HOME, { name: 'Partenariat Maestroo', out: 'partenariat-maestroo.html' }])] },
  { out: 'decouvrir.html', title: 'Vizyo Tracky en vidéo — présentation des services', description: "Présentation animée de Vizyo Tracky : supervision, analyse et administration de votre flotte. Lien partagé par e-mail après une demande.", robots: 'noindex,follow', noSitemap: true, jsonld: [] },
  { out: 'gps-flotte-occitanie.html', title: 'GPS flotte Occitanie — géolocalisation véhicules entreprise (13 départements)', description: "Vizyo Tracky équipe les flottes professionnelles et véhicules de service dans toute l'Occitanie : Toulouse, Montpellier, Nîmes, Perpignan… Installation locale, application française, support réactif.", jsonld: [localBizLd({ name: 'Occitanie', dept: 'Occitanie', lat: 43.6, lng: 2.0 }, 'gps-flotte-occitanie.html'), crumb([HOME, { name: 'Zones desservies', out: 'gps-flotte-occitanie.html' }])] },
  { out: 'mentions-legales.html', title: 'Mentions légales | Vizyo Tracky', description: 'Mentions légales du site Vizyo Tracky (Vizyo Agency).', robots: 'index,follow', noSitemap: true, jsonld: [crumb([HOME, { name: 'Mentions légales', out: 'mentions-legales.html' }])] },
];

let built = 0;
const sitemapUrls = [];
function seoWeight(out) {
  if (out === 'index.html') return { priority: '1.0', changefreq: 'weekly' };
  if (out === 'gps-flotte-toulouse.html' || out === 'gps-flotte-occitanie.html') return { priority: '0.9', changefreq: 'monthly' };
  if (out.startsWith('gps-flotte-')) return { priority: '0.7', changefreq: 'monthly' };
  return { priority: '0.8', changefreq: 'monthly' };
}
function emit(meta) {
  const loc = buildPage(meta);
  if (!meta.noSitemap) sitemapUrls.push({ loc, ...seoWeight(meta.out) });
  built++; console.log('✓', meta.out);
}

for (const meta of PAGES) emit(meta);

// ── Pages villes (SEO local depuis cities.mjs, contenu depuis le design) ──
for (const c of cities.filter((x) => x.generate)) {
  const out = `gps-flotte-${c.slug}.html`;
  emit({
    out, file: out,
    title: `GPS flotte ${c.name} — géolocalisation véhicules entreprise (${c.dept})`,
    description: `Installation de traceurs GPS de flotte à ${c.name} et ${c.inDept} (${c.deptNum}). Géolocalisation temps réel, coupure moteur, alertes. Application française, support local, installation sous 48h.`,
    geo: { dept: c.deptNum, place: c.name, lat: c.lat, lng: c.lng },
    jsonld: [localBizLd(c, out), crumb([HOME, { name: 'Occitanie', out: 'gps-flotte-occitanie.html' }, { name: c.name, out }]), faqLd([
      { q: `Installez-vous les traceurs GPS à ${c.name} ?`, a: `Oui, nous intervenons à ${c.name} et partout ${c.inDept}. Installation sur site en moins de 48h.` },
      { q: `Quel est le tarif à ${c.name} ?`, a: `Les mêmes tarifs transparents partout : Tracky Lite dès ${fmt(P.lite.annual)} € et Pro dès ${fmt(P.pro.annual)} €/véhicule/mois HT.` },
    ])],
  });
}

// ── Sitemap + robots ──
const today = new Date().toISOString().slice(0, 10);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>`;
writeFileSync(pub('sitemap.xml'), sitemap, 'utf8');
writeFileSync(pub('robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${site.baseUrl}/sitemap.xml\n`, 'utf8');

console.log(`\n${built} page(s) générée(s) · sitemap.xml (${sitemapUrls.length} URL) · robots.txt · vt.js?v=${VT_V}`);
