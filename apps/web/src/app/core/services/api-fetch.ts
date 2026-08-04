import { reportClientError } from '../error/report-client-error';
import { HttpFailure } from './http-failure';

/**
 * APPEL API EN `fetch` NATIF — avec statut préservé et remontée au centre d'alerte.
 *
 * ══ Pourquoi ce module existe (audit du 2026-08-03) ═══════════════════════════════════
 *
 * Trois services de l'application appellent l'API avec `fetch` natif plutôt qu'avec
 * `HttpClient` : `users.service`, `vehicle-groups.service`, `auth.service` — 25 appels.
 * Ce choix a une conséquence que rien ne rappelle sur place :
 *
 *   **`fetch` ne traverse AUCUN intercepteur Angular.**
 *
 * Ces 25 appels échappaient donc aux deux mécanismes qui protègent tous les autres :
 *
 *   1. `authInterceptor` — qui affiche la panne à l'utilisateur et gère la session
 *      expirée. Un 401 sur ces appels ne déclenchait ni déconnexion ni message.
 *   2. `errorReportInterceptor` — qui remonte au centre d'alerte les pannes réseau et
 *      passerelle. Une API injoignable sur ces appels n'apparaissait NULLE PART.
 *
 * S'y ajoutait une perte d'information : ils signalaient l'échec par
 * `new Error('Failed to load users')`. Le statut disparaissait, donc l'écran ne pouvait
 * plus distinguer « session expirée » de « pas le droit » ou « serveur en panne ». Les
 * trois s'affichaient identiquement — souvent « aucun élément », c'est-à-dire la réponse
 * métier d'une liste réellement vide.
 *
 * ══ Ce que ce module garantit ═════════════════════════════════════════════════════════
 *
 *   - l'échec porte TOUJOURS son statut ({@link HttpFailure}), donc l'écran peut parler ;
 *   - une panne RÉSEAU remonte au centre d'alerte, comme pour `HttpClient`.
 *
 * ══ Ce qu'il ne remonte volontairement PAS ════════════════════════════════════════════
 *
 *   - les **4xx** : ce sont des réponses attendues (droit refusé, ressource absente,
 *     conflit). Les journaliser noierait le centre sous du fonctionnement normal ;
 *   - les **5xx** : déjà journalisés CÔTÉ SERVEUR par `AllExceptionsFilter`, avec la
 *     pile d'appels complète. Les remonter aussi depuis le client créerait deux lignes
 *     pour un seul incident, et la seconde serait la moins informative des deux.
 *
 * Reste donc le seul angle mort réel : la requête qui n'atteint jamais l'API.
 *
 * ⚠️ La bonne cible à terme reste de migrer ces services vers `HttpClient`, qui apporte
 * tout cela sans intermédiaire. Ce module est le pont en attendant — pas une alternative
 * qu'il faudrait étendre à de nouveaux appels.
 */

/** Message par défaut si l'appelant n'en fournit pas. */
const DEFAULT_MESSAGE = 'Requête impossible';

/**
 * Faut-il remonter cet échec de transport au centre d'alerte ? (TRK-002)
 *
 * Deux situations produisent le même symptôme technique — une requête qui n'aboutit pas —
 * sans qu'il y ait la moindre panne de plateforme :
 *
 *   1. **Le navigateur se sait hors ligne.** C'est le wifi de l'utilisateur qui est tombé.
 *   2. **La page est cachée.** Onglet en arrière-plan, appareil en veille, navigation en
 *      cours : le navigateur TUE les requêtes en vol. Sur iOS c'est le fameux
 *      `TypeError: Load failed`.
 *
 * Le cas 2 manquait, et `navigator.onLine` ne le couvre pas : il dit « une interface réseau
 * est active », pas « Internet est joignable ». Sur un appareil qui vient de se réveiller,
 * il vaut déjà `true` alors que la route ne l'est pas encore. D'où des lignes ERREUR au
 * centre d'alerte pour un hoquet que personne ne peut corriger.
 *
 * C'est exactement la garde que `realtime.service` applique déjà à ses propres reports.
 *
 * ⚠️ Ce qui continue de remonter : une panne réellement VÉCUE, page au premier plan et
 * navigateur en ligne. C'est la raison d'être de ce module — la supprimer aussi le rendrait
 * inutile.
 */
function shouldReportNetworkFailure(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  return true;
}

/**
 * Exécute un `fetch` et transforme tout échec en {@link HttpFailure} portant son statut.
 *
 * @param input  URL ou Request, comme `fetch`.
 * @param init   Options, comme `fetch`.
 * @param label  Ce qu'on tentait de faire, pour le message d'erreur et le centre d'alerte
 *               (ex. « Chargement des utilisateurs »). Jamais montré tel quel à
 *               l'utilisateur : l'écran compose son propre message depuis le statut.
 *
 * @throws {HttpFailure} statut HTTP réel, ou `0` si la requête n'a pas abouti.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  label = DEFAULT_MESSAGE,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    // La requête n'a pas abouti : réseau coupé, DNS, CORS, API injoignable. C'est le seul
    // cas que PERSONNE d'autre ne peut voir — le serveur n'a rien reçu, donc il n'a rien
    // pu journaliser. Sans cette ligne, l'incident n'existe nulle part.
    //
    // Voir `shouldReportNetworkFailure` : on écarte le hors-ligne et la page cachée, qui
    // rempliraient le centre d'alerte d'incidents que personne ne peut corriger.
    if (shouldReportNetworkFailure()) {
      reportClientError('api-fetch', new Error(`${label} — API injoignable : ${describe(err)}`));
    }
    throw new HttpFailure(0, label);
  }

  if (!res.ok) {
    // Le statut voyage AVEC l'erreur. C'est toute la différence entre un écran qui dit
    // « votre session a expiré » et un écran qui dit « aucun élément ».
    throw new HttpFailure(res.status, label);
  }
  return res;
}

/**
 * Le `fetch` NU, mais avec la remontée réseau — et rien d'autre.
 *
 * Pour les appels dont l'appelant construit lui-même sa réponse d'erreur : beaucoup
 * d'endpoints renvoient `{ message }` sur un 400/409, et le service le lit pour le
 * présenter tel quel. {@link apiFetch} refuserait ces réponses avant qu'il ait pu le
 * faire ; celui-ci lui rend la main sur toute réponse, quel que soit son statut.
 *
 * ⚠️ L'appelant reste RESPONSABLE de jeter une {@link HttpFailure} portant `res.status`.
 * Un `new Error(message)` perdrait le statut, et l'écran ne pourrait plus distinguer une
 * session expirée d'un refus de droit — c'est précisément le défaut que tout ce module
 * corrige.
 */
export async function apiFetchRaw(
  input: RequestInfo | URL,
  init?: RequestInit,
  label = DEFAULT_MESSAGE,
  /**
   * `silentNetworkFailure` — ne pas remonter un échec de TRANSPORT sur cette tentative.
   *
   * Réservé aux appelants qui vont RÉESSAYER : remonter le premier essai puis réussir le
   * second laisserait une erreur au centre d'alerte pour un incident qui n'a existé pour
   * personne. Le second essai, lui, doit remonter normalement (TRK-002).
   */
  opts?: { silentNetworkFailure?: boolean },
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    if (!opts?.silentNetworkFailure && shouldReportNetworkFailure()) {
      reportClientError('api-fetch', new Error(`${label} — API injoignable : ${describe(err)}`));
    }
    throw new HttpFailure(0, label);
  }
}

/**
 * Comme {@link apiFetch}, mais lit aussi le message d'erreur renvoyé par l'API.
 *
 * Beaucoup d'endpoints répondent `{ message: "..." }` sur un 400/409 : c'est un texte
 * métier écrit pour l'utilisateur (« Cet e-mail est déjà utilisé »), toujours plus utile
 * qu'un message générique dérivé du statut. On le préfère quand il existe.
 */
export async function apiFetchJson<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  label = DEFAULT_MESSAGE,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    if (shouldReportNetworkFailure()) {
      reportClientError('api-fetch', new Error(`${label} — API injoignable : ${describe(err)}`));
    }
    throw new HttpFailure(0, label);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const serverMessage =
      typeof (body as { message?: unknown } | null)?.message === 'string'
        ? ((body as { message: string }).message)
        : null;
    // ⚠️ Le message du serveur ne remplace pas le STATUT, il s'y ajoute. Une version
    // antérieure de ce code ne gardait que le texte : l'écran affichait la bonne phrase
    // mais ne pouvait plus distinguer une session expirée d'un refus de droit, donc ne
    // pouvait plus proposer la bonne action.
    throw new HttpFailure(res.status, serverMessage ?? label);
  }
  return body as T;
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
