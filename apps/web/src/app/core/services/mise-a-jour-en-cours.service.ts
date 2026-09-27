import { Injectable, signal } from '@angular/core';

/**
 * ══ L'ÉCRAN DE MISE À JOUR — incident CDEF31 du 24 septembre 2026 ═════════════════════════════
 *
 * Quand l'API est recréée (déploiement), l'application reste à l'écran et se dégrade en silence :
 * les requêtes en vol échouent, la liaison temps réel tombe, l'état des boutons se fige sur une
 * valeur périmée, et les morceaux de code chargés à la demande ne se chargent plus. Rien ne le
 * DIT à l'opérateur. La nuit du 23 au 24/09, un veilleur s'est reconnecté cinq fois en dix
 * minutes et a cliqué vingt-trois fois sur un bouton, sans jamais voir un seul message.
 *
 * Plutôt que d'interdire les déploiements de nuit — trop contraignant —, l'application le DIT et
 * se répare seule : écran plein, « mise à jour en cours », puis rechargement automatique dès que
 * l'API répond. Le rechargement n'est pas un détail : il ramène le code neuf ET une hydratation
 * fraîche, donc un état de coupe juste. C'est ce qui manquait le plus cette nuit-là.
 *
 * ── CE QUI DÉCLENCHE, ET CE QUI NE DÉCLENCHE PAS ──────────────────────────────────────────────
 *
 * Déclenche : les échecs de TRANSPORT — `status 0` (réseau, CORS, timeout), `502`, `503`, `504`.
 * La requête n'a jamais atteint l'API, ou la passerelle n'a trouvé personne derrière.
 *
 * Ne déclenche PAS : tout code que l'API a produit elle-même, 4xx comme 5xx. Un `500` signifie que
 * l'API est VIVANTE et qu'une route a échoué — afficher « mise à jour en cours » là-dessus serait
 * un mensonge, et masquerait un vrai défaut derrière un écran rassurant.
 *
 * ── POURQUOI UN DÉLAI, ET PAS UN COMPTEUR D'ÉCHECS ────────────────────────────────────────────
 *
 * Une page qui charge lance dix requêtes en parallèle : au premier hoquet, un compteur atteindrait
 * n'importe quel seuil d'un coup. On mesure donc la DURÉE de l'épisode — l'écran n'apparaît que si
 * l'injoignabilité PERSISTE. Toute réponse de l'API clôt l'épisode, même une erreur applicative.
 */

/** Persistance minimale avant d'afficher l'écran : en deçà, c'est un hoquet, pas une panne. */
const AVANT_AFFICHAGE_MS = 6_000;
/** Cadence de la sonde de retour. Assez lent pour ne pas marteler une API qui redémarre. */
const SONDE_MS = 3_000;
/** Codes qui signifient « la requête n'a pas atteint l'API ». */
const TRANSPORT_EN_ECHEC = new Set([0, 502, 503, 504]);

@Injectable({ providedIn: 'root' })
export class MiseAJourEnCoursService {
  /** L'écran est-il affiché ? Lu par le composant d'habillage. */
  readonly indisponible = signal(false);
  /** Le réseau du POSTE est-il coupé ? Change le message : ce n'est alors pas notre faute. */
  readonly horsLigne = signal(false);

  private debutEpisode = 0;
  private minuterieAffichage: ReturnType<typeof setTimeout> | null = null;
  private minuterieSonde: ReturnType<typeof setInterval> | null = null;
  /** Surchargé en test pour observer le rechargement sans recharger le contexte de test. */
  protected recharger(): void {
    if (typeof window !== 'undefined') window.location.reload();
  }

  /**
   * Le réseau du POSTE est-il coupé ? Isolé en méthode pour être surchargeable : `navigator.onLine`
   * vit sur le prototype et ne se double pas proprement depuis un test.
   */
  protected estHorsLigne(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  /** Appelé par l'intercepteur HTTP sur un échec de TRANSPORT. */
  signalerEchecDeTransport(status: number): void {
    if (!TRANSPORT_EN_ECHEC.has(status)) return;
    this.horsLigne.set(this.estHorsLigne());
    if (this.debutEpisode === 0) this.debutEpisode = Date.now();
    if (this.indisponible() || this.minuterieAffichage) return;
    this.minuterieAffichage = setTimeout(() => {
      this.minuterieAffichage = null;
      // Un succès a pu clore l'épisode pendant l'attente : on ne montre plus rien.
      if (this.debutEpisode === 0) return;
      this.indisponible.set(true);
      this.demarrerSonde();
    }, AVANT_AFFICHAGE_MS);
  }

  /**
   * Appelé dès que l'API a RÉPONDU quoi que ce soit — succès ou erreur applicative.
   *
   * Si l'écran est affiché, c'est que l'API vient de revenir : on recharge. Recharger plutôt que
   * masquer l'écran est délibéré — une page restée ouverte pendant un déploiement porte du code
   * périmé, des morceaux chargés à la demande qui n'existent plus sous ce nom, et un état de coupe
   * figé sur ce qu'il était avant la coupure. La masquer rendrait la main sur une application qui
   * ment ; c'est exactement le défaut qu'on répare.
   */
  signalerReponseDeLApi(): void {
    this.debutEpisode = 0;
    this.horsLigne.set(false);
    if (this.minuterieAffichage) {
      clearTimeout(this.minuterieAffichage);
      this.minuterieAffichage = null;
    }
    if (this.indisponible()) {
      this.arreterSonde();
      this.indisponible.set(false);
      this.recharger();
    }
  }

  private demarrerSonde(): void {
    if (this.minuterieSonde) return;
    this.minuterieSonde = setInterval(() => void this.sonder(), SONDE_MS);
    void this.sonder();
  }

  private arreterSonde(): void {
    if (this.minuterieSonde) {
      clearInterval(this.minuterieSonde);
      this.minuterieSonde = null;
    }
  }

  /**
   * La sonde n'utilise PAS HttpClient : l'intercepteur qui nourrit ce service tournerait sur
   * elle-même, et chaque échec de sonde relancerait un épisode. `fetch` direct, sans cache, sur
   * `/api/health` — la seule route qui ne demande ni jeton ni consentement.
   */
  private async sonder(): Promise<void> {
    this.horsLigne.set(this.estHorsLigne());
    if (this.horsLigne()) return;
    try {
      const r = await fetch('/api/health', { cache: 'no-store', credentials: 'omit' });
      // N'importe quelle réponse HTTP prouve que quelqu'un écoute derrière la passerelle ; un 502
      // ou 503 signifie que l'API n'est pas encore revenue.
      if (!TRANSPORT_EN_ECHEC.has(r.status)) {
        this.arreterSonde();
        this.indisponible.set(false);
        this.debutEpisode = 0;
        this.recharger();
      }
    } catch {
      // Toujours injoignable : la sonde suivante réessaiera. Silencieux par construction —
      // un journal ici remplirait la console pendant toute la coupure.
    }
  }
}
