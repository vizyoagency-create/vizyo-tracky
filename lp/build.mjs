// ──────────────────────────────────────────────────────────────────────────
//  Générateur statique Vizyo Tracky (zéro dépendance).
//  Assemble : head SEO paramétré + header + contenu + footer + données client.
//  Sortie : HTML statique pur à la racine (déployé tel quel).
//  Usage : node build.mjs
// ──────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { site, nav } from './data/site.mjs';
import { pricing } from './data/pricing.mjs';
import { cities, region } from './data/cities.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = (p) => join(__dir, p);
const read = (p) => readFileSync(root(p), 'utf8');

const headerTpl = read('partials/header.html');
const footerTpl = read('partials/footer.html');

const fmt = (n) => n.toFixed(2).replace('.', ',');
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const frDate = (iso) => { const [y, m, d] = iso.split('-'); return `${+d} ${MONTHS[+m - 1]} ${y}`; };
const P = pricing.plans, A = pricing.addons, L = pricing.launch;

// Tokens texte remplacés dans head + header + footer + contenu
const TOKENS = {
  '{{APP_URL}}': site.appUrl,
  '{{WHATSAPP}}': site.whatsapp,
  '{{EMAIL}}': site.email,
  '{{PHONE_E164}}': site.phoneE164,
  '{{PHONE_DISPLAY}}': site.phoneDisplay,
  '{{AGENCY_URL}}': site.agencyUrl,
  '{{YEAR}}': String(new Date().getFullYear()),
  '{{REGION}}': site.region,
  '{{BASE_CITY}}': site.baseCity,
  '{{PRICE_LITE_ANNUAL}}': fmt(P.lite.annual),
  '{{PRICE_LITE_MONTHLY}}': fmt(P.lite.monthly),
  '{{PRICE_PRO_ANNUAL}}': fmt(P.pro.annual),
  '{{PRICE_PRO_MONTHLY}}': fmt(P.pro.monthly),
  '{{PRICE_LIVE}}': fmt(A.live.perVehMonth),
  '{{HW_LITE}}': String(P.lite.hardware),
  '{{HW_PRO}}': String(P.pro.hardware),
  '{{INSTALL_BASE}}': String(pricing.install.base),
  '{{INSTALL_FROM5}}': String(pricing.install.from5),
  '{{INSTALL_FREE_FROM}}': String(pricing.install.freeFrom),
  '{{LAUNCH_UNTIL}}': frDate(L.until),
  '{{LAUNCH_SLOTS}}': String(L.slotsLeft),
  '{{LAUNCH_LABEL}}': L.label,
  '{{CITY_LINKS}}': cities.map((c) => c.generate
    ? `<a href="gps-flotte-${c.slug}.html" class="city-chip">${c.name} <span class="tg6">${c.deptNum}</span></a>`
    : `<span class="city-chip city-soon">${c.name} <span class="tg6">${c.deptNum}</span></span>`).join(''),
};
const applyTokens = (s) => { for (const k in TOKENS) s = s.split(k).join(TOKENS[k]); return s; };

const caret = '<svg class="nav-cv" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';

function renderNav(current) {
  return nav.map((it) => {
    const cur = it.href === current ? ' aria-current="page"' : '';
    if (it.children) {
      const sub = it.children.map((c) => `<a href="${c.href}">${c.label}</a>`).join('');
      return `<div class="nav-dd"><a href="${it.href}"${cur}>${it.label}${caret}</a><div class="nav-dd-menu">${sub}</div></div>`;
    }
    return `<a href="${it.href}"${cur}>${it.label}</a>`;
  }).join('');
}
const NAV_ICONS = {
  'Fonctionnalités': '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  'Secteur public': '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  'Tarifs': '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.3"/>',
  'Zones desservies': '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  'Sécurité': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
};
const navIcon = (label) => `<span class="mm-ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[label] || ''}</svg></span>`;
const MM_CHEV = '<svg class="mm-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>';
function renderNavMobile() {
  return nav.map((it) => {
    let h = `<a class="mm-item" href="${it.href}" onclick="tmm()">${navIcon(it.label)}<span class="mm-lbl">${it.label}</span>${MM_CHEV}</a>`;
    if (it.children) h += `<div class="mm-sub">` + it.children.map((c) => `<a class="mm-sub-link" href="${c.href}" onclick="tmm()"><span class="mm-dot"></span>${c.label}</a>`).join('') + `</div>`;
    return h;
  }).join('');
}

const abs = (path) => site.baseUrl + (path.startsWith('/') ? path : '/' + path);

function renderHead({ title, description, canonical, ogImage, jsonld = [], geo, robots }) {
  const img = abs(ogImage || site.ogImage);
  const ld = jsonld.map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');
  const geoTags = geo ? `<meta name="geo.region" content="FR-${geo.dept}"><meta name="geo.placename" content="${geo.place}"><meta name="geo.position" content="${geo.lat};${geo.lng}"><meta name="ICBM" content="${geo.lat}, ${geo.lng}">` : '';
  return `<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="${robots || 'index,follow'}">
<meta name="theme-color" content="#0A0F0D">
${geoTags}
<meta property="og:type" content="website"><meta property="og:site_name" content="${site.name}"><meta property="og:locale" content="${site.locale}">
<meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${img}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${img}">
<script>(function(){try{var t=localStorage.getItem('vt-theme');if(!t){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}})();</script>
<link rel="icon" type="image/x-icon" href="favicon.ico"><link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png"><link rel="icon" type="image/png" sizes="16x16" href="favicon-16.png"><link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon-180.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700;9..40,800&display=swap" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700;9..40,800&display=swap"></noscript>
<link rel="stylesheet" href="assets/tracky.css">
${ld}`;
}

// Données injectées côté client (simulateur, formulaire, FABs)
const clientData = { site: { whatsapp: site.whatsapp, leadApi: site.leadApi }, pricing };
const clientScript = `<script>window.TRACKY=${JSON.stringify(clientData)}</script>`;

function renderPage(meta, contentHtml) {
  const out = meta.out;
  const canonical = out === 'index.html' ? site.baseUrl + '/' : abs(out);
  const head = renderHead({ ...meta, canonical });
  const header = applyTokens(headerTpl)
    .replace('{{NAV}}', renderNav(out))
    .replace('{{NAV_MOBILE}}', renderNavMobile());
  const footer = applyTokens(footerTpl);
  const content = applyTokens(contentHtml);
  return `<!DOCTYPE html>
<html lang="fr">
<head>
${head}
</head>
<body>
${header}
<main id="main">
${content}
</main>
${footer}
${clientScript}
<script src="assets/tracky.js"></script>
</body>
</html>`;
}

// ── Manifeste des pages (slug => fichier contenu + SEO) ──
const ORG_LD = {
  '@context': 'https://schema.org', '@type': 'Organization', name: site.name, url: site.baseUrl,
  logo: abs('/apple-touch-icon-180.png'), email: site.email, telephone: site.phoneE164,
  areaServed: site.region, sameAs: [site.agencyUrl],
};
const WEBSITE_LD = { '@context': 'https://schema.org', '@type': 'WebSite', name: site.name, url: site.baseUrl, inLanguage: 'fr-FR' };

// Helpers JSON-LD
const crumb = (items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.out === 'index.html' ? site.baseUrl + '/' : abs(it.out) })) });
const faqLd = (qa) => ({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: qa.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) });
const productLd = () => ({
  '@context': 'https://schema.org', '@type': 'Product', name: 'Vizyo Tracky — traceur GPS de flotte',
  description: "Boîtier GPS + application française : géolocalisation temps réel, coupure moteur, alertes, rapports.",
  brand: { '@type': 'Brand', name: 'Vizyo Tracky' },
  offers: {
    '@type': 'AggregateOffer', priceCurrency: 'EUR', lowPrice: P.lite.annual, highPrice: P.pro.monthly,
    offerCount: 3, offers: [
      { '@type': 'Offer', name: 'Tracky Lite (annuel)', price: P.lite.annual, priceCurrency: 'EUR' },
      { '@type': 'Offer', name: 'Tracky Pro (annuel)', price: P.pro.annual, priceCurrency: 'EUR' },
    ],
  },
});
const localBizLd = (c, out) => ({
  '@context': 'https://schema.org', '@type': 'LocalBusiness', name: `Vizyo Tracky — ${c.name}`,
  description: `Installation de traceurs GPS de flotte à ${c.name} (${c.dept}) et dans tout le département. Géolocalisation temps réel, coupure moteur, support local.`,
  url: abs(out), telephone: site.phoneE164, email: site.email, priceRange: '€€', areaServed: { '@type': 'City', name: c.name },
  address: { '@type': 'PostalAddress', addressLocality: c.name, addressRegion: 'Occitanie', addressCountry: 'FR' },
  geo: { '@type': 'GeoCoordinates', latitude: c.lat, longitude: c.lng },
});

const HOME = { name: 'Accueil', out: 'index.html' };

const PAGES = [
  {
    out: 'index.html', file: 'pages/index.html',
    title: 'Vizyo Tracky — Traçage GPS & gestion de flotte en Occitanie',
    description: "Boîtier GPS + application française pour gérer votre flotte : géolocalisation temps réel, coupure moteur, alertes, rapports. Installation à Toulouse et en Occitanie.",
    jsonld: [ORG_LD, WEBSITE_LD],
  },
  {
    out: 'fonctionnalites.html', file: 'pages/fonctionnalites.html',
    title: 'Fonctionnalités — GPS temps réel, coupure moteur, alertes | Vizyo Tracky',
    description: "Toutes les fonctionnalités de Vizyo Tracky en détail : géolocalisation temps réel, Live 10 s, historique, coupure moteur par plage horaire, alertes, rapports, conducteurs identifiés, mode vie privée CNIL.",
    jsonld: [productLd(), crumb([HOME, { name: 'Fonctionnalités', out: 'fonctionnalites.html' }])],
  },
  {
    out: 'tarifs.html', file: 'pages/tarifs.html',
    title: `Tarifs & simulateur GPS flotte — dès ${fmt(P.lite.annual)} €/véhicule | Vizyo Tracky`,
    description: `Tarifs clairs et bloqués à la souscription : Tracky Lite dès ${fmt(P.lite.annual)} €, Pro dès ${fmt(P.pro.annual)} €/véhicule/mois HT. Option Live temps réel, rétention longue. Simulateur de budget en ligne.`,
    jsonld: [productLd(), crumb([HOME, { name: 'Tarifs', out: 'tarifs.html' }]), faqLd([
      { q: "Quels sont les tarifs de Vizyo Tracky ?", a: `Tracky Lite à ${fmt(P.lite.annual)} € et Tracky Pro à ${fmt(P.pro.annual)} € par véhicule et par mois HT en engagement annuel renouvelable. SIM et data incluses.` },
      { q: "Le temps réel est-il inclus ?", a: `Le suivi standard est inclus. Le Live temps réel (10 s) est une option à ${fmt(A.live.perVehMonth)} €/véhicule/mois car il génère beaucoup plus de données.` },
      { q: "Le tarif peut-il augmenter ?", a: "Non : le tarif est garanti à la souscription et reconduit au même prix. Pas d'augmentation surprise." },
    ])],
  },
  {
    out: 'secteur-public.html', file: 'pages/secteur-public.html',
    title: 'GPS véhicules de service — secteur public & médico-social | Vizyo Tracky',
    description: "Géolocalisation des véhicules de service pour établissements publics, foyers, structures médico-sociales et collectivités : conformité CNIL, conducteurs identifiés, données souveraines, marchés publics et contrats pluriannuels.",
    jsonld: [crumb([HOME, { name: 'Secteur public', out: 'secteur-public.html' }])],
  },
  {
    out: 'securite.html', file: 'pages/securite.html',
    title: 'Sécurité & conformité RGPD — hébergement France | Vizyo Tracky',
    description: "Vos données restent en France, sous votre contrôle : hébergement souverain, chiffrement TLS 1.3, conformité RGPD by design, DPA signable, mode vie privée CNIL.",
    jsonld: [crumb([HOME, { name: 'Sécurité', out: 'securite.html' }])],
  },
  {
    out: 'gps-flotte-occitanie.html', file: 'pages/gps-flotte-occitanie.html',
    title: 'GPS flotte Occitanie — géolocalisation véhicules entreprise (13 départements)',
    description: "Vizyo Tracky équipe les flottes professionnelles et véhicules de service dans toute l'Occitanie : Toulouse, Montpellier, Nîmes, Perpignan… Installation locale, application française, support réactif.",
    jsonld: [localBizLd({ name: 'Occitanie', dept: 'Occitanie', lat: 43.6, lng: 2.0 }, 'gps-flotte-occitanie.html'), crumb([HOME, { name: 'Zones desservies', out: 'gps-flotte-occitanie.html' }])],
  },
];

let built = 0;
const sitemapUrls = [];
function emit(meta, content) {
  writeFileSync(root(meta.out), renderPage(meta, content), 'utf8');
  sitemapUrls.push(meta.out === 'index.html' ? site.baseUrl + '/' : abs(meta.out));
  built++;
  console.log('✓', meta.out);
}

for (const meta of PAGES) {
  let content;
  try { content = read(meta.file); }
  catch { console.warn('⚠︎ contenu manquant, page ignorée :', meta.file); continue; }
  emit(meta, content);
}

// ── Pages villes (SEO local) depuis le gabarit ──
let cityTpl = null;
try { cityTpl = read('pages/_city.html'); } catch { console.warn('⚠︎ gabarit pages/_city.html manquant — pages villes ignorées'); }
if (cityTpl) {
  for (const c of cities.filter((x) => x.generate)) {
    const out = `gps-flotte-${c.slug}.html`;
    const zonesLi = c.zones.map((z) => `<span class="city-chip">${z}</span>`).join('');
    const content = cityTpl
      .split('{{CITY_ENC}}').join(encodeURIComponent(c.name))
      .split('{{CITY_SLUG}}').join(c.slug)
      .split('{{CITY}}').join(c.name)
      .split('{{IN_DEPT}}').join(c.inDept)
      .split('{{OF_DEPT}}').join(c.ofDept)
      .split('{{DEPTNUM}}').join(c.deptNum)
      .split('{{DEPT}}').join(c.dept)
      .split('{{INTRO}}').join(c.intro || '')
      .split('{{CONTEXT}}').join(c.context || '')
      .split('{{ZONES}}').join(c.zones.join(', '))
      .split('{{ZONES_LI}}').join(zonesLi);
    emit({
      out, file: '(gabarit)',
      title: `GPS flotte ${c.name} — géolocalisation véhicules entreprise (${c.dept})`,
      description: `Installation de traceurs GPS de flotte à ${c.name} et ${c.inDept} (${c.deptNum}). Géolocalisation temps réel, coupure moteur, alertes. Application française, support local, installation sous 48h.`,
      geo: { dept: c.deptNum, place: c.name, lat: c.lat, lng: c.lng },
      jsonld: [localBizLd(c, out), crumb([HOME, { name: 'Occitanie', out: 'gps-flotte-occitanie.html' }, { name: c.name, out }]), faqLd([
        { q: `Installez-vous les traceurs GPS à ${c.name} ?`, a: `Oui, nous intervenons à ${c.name} et partout ${c.inDept}. Installation sur site en moins de 48h.` },
        { q: `Quel est le tarif à ${c.name} ?`, a: `Les mêmes tarifs transparents partout : Tracky Lite dès ${fmt(P.lite.annual)} € et Pro dès ${fmt(P.pro.annual)} €/véhicule/mois HT.` },
      ])],
    }, content);
  }
}

// ── Sitemap + robots ──
const today = new Date().toISOString().slice(0, 10);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join('\n')}
</urlset>`;
writeFileSync(root('sitemap.xml'), sitemap, 'utf8');
writeFileSync(root('robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${site.baseUrl}/sitemap.xml\n`, 'utf8');

console.log(`\n${built} page(s) générée(s) · sitemap.xml (${sitemapUrls.length} URL) · robots.txt`);
