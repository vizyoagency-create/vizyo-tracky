import { reportClientError } from './report-client-error';

/**
 * AVALER UNE ERREUR SANS LA PERDRE.
 *
 * ══ Le trou que ce module bouche ══════════════════════════════════════════════════════
 *
 * L'application dispose de trois filets, et ils couvrent presque tout :
 *
 *   - `GlobalErrorHandler` attrape les erreurs JS NON RATTRAPÉES et les remonte ;
 *   - `AllExceptionsFilter`, côté serveur, journalise toute erreur 5xx avec sa pile ;
 *   - `errorReportInterceptor` remonte les pannes réseau et passerelle.
 *
 * Il reste une catégorie que AUCUN des trois ne peut voir : **une erreur JS attrapée par
 * un `catch`**. Elle n'est pas « non rattrapée », donc le gestionnaire global l'ignore ;
 * elle n'est pas HTTP, donc les intercepteurs ne la voient pas ; et le serveur n'en a
 * jamais entendu parler. Elle disparaît, silencieusement, définitivement.
 *
 * C'est le cas le plus courant en pratique : un `TypeError` sur une réponse dont la forme
 * a changé, un `undefined` déréférencé dans un `.map()`, une date invalide. Le bloc `try`
 * s'arrête à mi-chemin, l'écran affiche une liste vide, et rien nulle part n'indique que
 * quelque chose s'est mal passé.
 *
 * ══ Ce qu'il remonte, et ce qu'il ne remonte pas ══════════════════════════════════════
 *
 * ⚠️ Les `HttpErrorResponse` sont ÉCARTÉES, volontairement. Elles sont déjà couvertes :
 * les 5xx par le serveur (avec la pile d'appels, bien plus utile qu'une trace client),
 * les pannes réseau par l'intercepteur, et les 4xx sont du fonctionnement normal. Les
 * remonter ici produirait des doublons et noierait le centre d'alerte — or un centre
 * d'alerte bruyant finit ignoré, ce qui revient exactement au point de départ.
 *
 * ══ Usage ═════════════════════════════════════════════════════════════════════════════
 *
 *     try {
 *       this.items.set(await this.api.list());
 *     } catch (err) {
 *       swallow('agenda:chargement', err);   // le centre le verra
 *       this.items.set([]);                  // et l'écran reste utilisable
 *     }
 *
 * `source` doit situer l'appelant sans ambiguïté (`écran:action`) : c'est ce qui permet
 * de retrouver le code depuis le centre d'alerte, sans avoir à deviner.
 *
 * ⚠️ Ce n'est PAS un remplacement du message à l'utilisateur. Remonter au centre informe
 * l'équipe ; l'utilisateur, lui, doit toujours savoir que son action a échoué. Les deux
 * répondent à des questions différentes et aucune ne dispense de l'autre.
 */
export function swallow(source: string, err: unknown): void {
  // ⚠️ UNE SEULE GARDE, et c'est volontaire.
  //
  // Une première version testait d'abord `err instanceof HttpErrorResponse`, puis le
  // statut. Une mutation a montré que retirer le premier test ne cassait AUCUN test :
  // il était redondant, puisqu'une `HttpErrorResponse` porte justement un `status`
  // numérique. Du code dont la suppression ne casse rien n'est pas du code prouvé — et
  // deux gardes pour une seule règle font croire qu'il y a deux règles.
  //
  // Le critère retenu couvre les DEUX mondes HTTP de l'application d'un seul test :
  // `HttpErrorResponse` (appels `HttpClient`) et `HttpFailure` (appels `fetch`). Tous
  // deux sont déjà journalisés — par le serveur pour les 5xx, par l'intercepteur pour
  // les pannes réseau — et les 4xx sont du fonctionnement normal.
  if (typeof (err as { status?: unknown } | null)?.status === 'number') return;

  reportClientError(source, err);
}
