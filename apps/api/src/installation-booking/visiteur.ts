/**
 * Ce qu'on retient d'un visiteur de la page publique de prise de RDV — et ce qu'on n'en
 * retient PAS.
 *
 * Le visiteur n'a pas de compte et n'a consenti à rien : on veut pouvoir dire « le client
 * a ouvert le lien samedi depuis son iPhone, via Gmail, et a regardé la vidéo Supervision »,
 * pas reconstituer une empreinte. D'où trois réductions, toutes à sens unique :
 *  - de l'user-agent, on ne garde que la FAMILLE (mobile / iOS / Safari), jamais la chaîne ;
 *  - du referrer, on ne garde que l'HÔTE (« mail.google.com »), jamais l'URL ;
 *  - l'IP est tronquée ailleurs (`tronquerAdresse`, même règle que les liens de partage).
 *
 * Fonctions PURES, sans dépendance : testables avec des chaînes.
 */

export type DeviceKind = 'mobile' | 'tablet' | 'desktop';

export interface AgentDescription {
  device: DeviceKind | null;
  os: string | null;
  browser: string | null;
  /**
   * Robot de prévisualisation (WhatsApp, iMessage, Slack…) ou scanner de liens d'une
   * passerelle de courriel (Safe Links, Mimecast…). Il ouvre le lien AVANT le client,
   * parfois plusieurs fois : compté comme une visite, il ferait croire à une lecture qui
   * n'a pas eu lieu — le pire faux positif pour la question « le client a-t-il ouvert ? ».
   */
  robot: boolean;
}

const ROBOT_MARKERS = [
  'bot', 'crawler', 'spider', 'headless', 'preview', 'facebookexternalhit', 'whatsapp',
  'telegrambot', 'slackbot', 'twitterbot', 'linkedinbot', 'discordbot', 'skypeuripreview',
  'google-safety', 'microsoft office', 'mimecast', 'proofpoint', 'barracuda', 'curl/', 'wget/',
  'python-requests', 'go-http-client', 'okhttp', 'java/', 'phantomjs', 'lighthouse',
];

/** Un iPad récent se présente comme un Mac : seul le « touch » le trahit — invisible ici. */
export function decrireAgent(userAgent: string | undefined | null): AgentDescription {
  const ua = (userAgent ?? '').trim();
  if (!ua) return { device: null, os: null, browser: null, robot: false };
  const bas = ua.toLowerCase();

  const robot = ROBOT_MARKERS.some((m) => bas.includes(m));

  let os: string | null = null;
  if (/iphone|ipod/.test(bas)) os = 'iOS';
  else if (/ipad/.test(bas)) os = 'iPadOS';
  else if (/android/.test(bas)) os = 'Android';
  else if (/windows/.test(bas)) os = 'Windows';
  else if (/cros/.test(bas)) os = 'ChromeOS';
  else if (/mac os x|macintosh/.test(bas)) os = 'macOS';
  else if (/linux/.test(bas)) os = 'Linux';

  let device: DeviceKind | null = null;
  if (/ipad|tablet|kindle|silk/.test(bas) || (/android/.test(bas) && !/mobile/.test(bas))) device = 'tablet';
  else if (/mobi|iphone|ipod|android|windows phone/.test(bas)) device = 'mobile';
  else if (os) device = 'desktop';

  // L'ordre compte : Edge, Opera et Samsung se déclarent aussi « Chrome » et « Safari ».
  let browser: string | null = null;
  if (/edg(e|a|ios)?\//.test(bas)) browser = 'Edge';
  else if (/opr\/|opera/.test(bas)) browser = 'Opera';
  else if (/samsungbrowser/.test(bas)) browser = 'Samsung Internet';
  else if (/fxios|firefox/.test(bas)) browser = 'Firefox';
  else if (/crios|chrome|chromium/.test(bas)) browser = 'Chrome';
  else if (/safari/.test(bas)) browser = 'Safari';

  return { device, os, browser, robot };
}

/**
 * L'hôte du referrer, ou `null` : ouverture directe (SMS, lien tapé). Une URL malformée
 * vaut `null` aussi — on ne devine pas.
 *
 * ⚠️ C'est `document.referrer` DE LA PAGE qu'il faut lui donner, pas l'en-tête `Referer`
 * de l'appel API : cet appel part de notre propre page, son `Referer` est donc toujours
 * nous-mêmes. Seul le navigateur sait d'où le client est arrivé.
 *
 * Android transmet l'application d'origine sous `android-app://<paquet>` (Gmail, WhatsApp,
 * Messages…) : on garde le nom du paquet, c'est exactement la provenance qu'on cherche.
 */
export function hoteDuReferrer(referrer: string | undefined | null): string | null {
  const brut = (referrer ?? '').trim();
  if (!brut) return null;
  try {
    const url = new URL(brut);
    if (url.protocol === 'android-app:') {
      const paquet = url.hostname.toLowerCase();
      return paquet.length > 0 ? paquet.slice(0, 120) : null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const hote = url.hostname.toLowerCase();
    return hote.length > 0 ? hote.slice(0, 120) : null;
  } catch {
    return null;
  }
}

/** Paquets Android connus → nom lisible. Le reste s'affiche tel quel. */
const PAQUETS_ANDROID: Record<string, string> = {
  'com.google.android.gm': 'Gmail (application)',
  'com.google.android.apps.messaging': 'Messages (SMS)',
  'com.samsung.android.messaging': 'Messages Samsung (SMS)',
  'com.whatsapp': 'WhatsApp',
  'com.whatsapp.w4b': 'WhatsApp Business',
  'com.microsoft.office.outlook': 'Outlook (application)',
  'com.facebook.orca': 'Messenger',
  'org.telegram.messenger': 'Telegram',
  'com.linkedin.android': 'LinkedIn',
  'com.slack': 'Slack',
};

/**
 * Une PROVENANCE lisible pour l'écran admin, à partir de l'hôte du referrer et de l'origine
 * de l'application elle-même (un rechargement depuis la page vient de chez nous).
 */
export function provenanceLisible(referrerHost: string | null, hoteApp: string | null): string {
  if (!referrerHost) return 'Ouverture directe (SMS, messagerie…)';
  if (hoteApp && referrerHost === hoteApp) return 'Depuis la page elle-même';
  if (PAQUETS_ANDROID[referrerHost]) return PAQUETS_ANDROID[referrerHost];
  if (/mail\.google|gmail/.test(referrerHost)) return 'Gmail';
  if (/outlook|live\.com|office\.com|hotmail/.test(referrerHost)) return 'Outlook';
  if (/mail\.yahoo/.test(referrerHost)) return 'Yahoo Mail';
  if (/orange\.fr|laposte\.net|sfr\.fr|free\.fr/.test(referrerHost)) return `Webmail (${referrerHost})`;
  if (/whatsapp/.test(referrerHost)) return 'WhatsApp Web';
  if (/messenger|facebook/.test(referrerHost)) return 'Messenger';
  if (/linkedin/.test(referrerHost)) return 'LinkedIn';
  if (/t\.co|twitter|x\.com/.test(referrerHost)) return 'X / Twitter';
  if (/google\./.test(referrerHost)) return 'Google';
  return referrerHost;
}
