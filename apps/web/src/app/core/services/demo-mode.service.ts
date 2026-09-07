import { Injectable, signal } from '@angular/core';
import { swallow } from '../error/swallow';

/**
 * Environnement de démonstration (2026-09) — docs/environnement-demo/PLAN-2026-09-07.md.
 *
 * Le web apprend qu'il parle à la DÉMO par `GET /api/health`, public — donc dès la page de
 * connexion, avant toute session. Le même bundle sert la production et la démo : c'est l'API
 * qui le dit, jamais le domaine ni une variable de build.
 *
 * ── POURQUOI `fetch` ET NON `HttpClient` ────────────────────────────────────────────────────
 *
 * Ce service est lu par la page de CONNEXION, et une dépendance de la page de connexion est une
 * dépendance de la porte d'entrée. Passer par `HttpClient` en ajoutait deux, mesurées le
 * 2026-09-07 :
 *
 *   1. une dépendance d'INJECTION — cinq scénarios de `retour-post-connexion.spec.ts` sont
 *      tombés sur `NG0201: No provider found for HttpClient`, parce que leur banc monte
 *      `LoginComponent` seul. Le test disait vrai : une bannière décorative n'a pas à exiger
 *      la pile HTTP pour que l'écran de connexion s'affiche ;
 *   2. les INTERCEPTEURS. `/api/health` répond **503 quand la base est tombée** ; l'appel
 *      serait alors rapporté au centre d'alerte par `errorReportInterceptor` — un incident
 *      serveur re-signalé par chaque navigateur qui ouvre la page, alors que l'API le sait
 *      déjà. Le chemin de connexion appelle d'ailleurs `window.fetch` en direct pour la même
 *      raison.
 *
 * Sans dépendance de constructeur, ce service ne peut casser aucun montage de composant.
 */
@Injectable({ providedIn: 'root' })
export class DemoModeService {
  /** true = cette instance est l'environnement de démonstration. */
  readonly enabled = signal(false);
  private charge = false;

  async charger(): Promise<void> {
    if (this.charge) return;
    this.charge = true;
    try {
      const reponse = await fetch('/api/health', { headers: { Accept: 'application/json' } });
      // 503 = API dégradée (base injoignable) : le corps porte quand même le drapeau. On lit
      // donc la réponse sans exiger `ok` — une démo dégradée reste une démo, et doit le dire.
      const sante = (await reponse.json()) as { demo?: boolean } | null;
      this.enabled.set(sante?.demo === true);
    } catch (err) {
      // Injoignable ou corps illisible : on reste en « pas la démo ». Une démo sans bandeau
      // pendant une seconde vaut mieux qu'une production qui se croirait démo.
      swallow('demo-mode:charger', err);
    }
  }
}
