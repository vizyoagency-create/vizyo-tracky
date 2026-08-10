import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';

// Intervalle court (1 min) : on veut que les clients basculent sur la nouvelle
// version dans la minute apres un deploy, pas a la prochaine session du
// lendemain. Le call est tres leger (HEAD/GET ngsw.json), aucune charge serveur
// significative. Combine avec le check on `visibilitychange`, ca couvre 99%
// des scenarios de PWA en arriere-plan.
const CHECK_INTERVAL_MS = 60 * 1000; // 1 min

/**
 * Surveille les nouvelles versions du service worker.
 *
 * Quand une nouvelle version est prete, expose un signal `updateAvailable`
 * que la modale `UpdateRequiredModalComponent` (montee au root de l'app)
 * lit pour s'afficher de maniere bloquante. L'utilisateur doit appeler
 * `applyUpdate()` pour recharger l'app.
 *
 * En mode dev, `SwUpdate.isEnabled` est false : init() est un no-op silencieux.
 */
@Injectable({ providedIn: 'root' })
export class PwaUpdateService {
  private readonly sw = inject(SwUpdate);
  private readonly destroyRef = inject(DestroyRef);
  private interval: ReturnType<typeof setInterval> | null = null;
  private visibilityListener: (() => void) | null = null;

  /** Signal lu par la modale bloquante au root. */
  readonly updateAvailable = signal(false);
  /** Vrai pendant l'activation/reload, pour afficher l'etat "Mise à jour en cours". */
  readonly applying = signal(false);

  init(): void {
    if (!this.sw.isEnabled) return;

    this.sw.versionUpdates
      .pipe(
        filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.updateAvailable.set(true));

    // Verification periodique pour les sessions tres longues
    this.interval = setInterval(() => {
      this.sw.checkForUpdate().catch(() => { /* silent */ });
    }, CHECK_INTERVAL_MS);

    // Vérifier au premier focus apres lancement
    this.sw.checkForUpdate().catch(() => { /* silent */ });

    // Re-verifier des que l'utilisateur revient sur l'app (PWA mobile :
    // c'est le moment ideal pour proposer la maj quand il rouvre l'app).
    this.visibilityListener = () => {
      if (document.visibilityState === 'visible') {
        this.sw.checkForUpdate().catch(() => { /* silent */ });
      }
    };
    document.addEventListener('visibilitychange', this.visibilityListener);
  }

  destroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
  }

  /**
   * Active la nouvelle version puis recharge la page. Appele par la modale.
   * Pas de catch silencieux : si l'activation echoue on force le reload, ce
   * qui declenchera un fetch frais du nouveau SW.
   */
  async applyUpdate(): Promise<void> {
    if (this.applying()) return;
    this.applying.set(true);
    try {
      await this.sw.activateUpdate();
    } finally {
      location.reload();
    }
  }
}
