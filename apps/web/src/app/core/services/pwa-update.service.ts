import { inject, Injectable } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';
import { ToastService } from '../../shared/ui/toast/toast.service';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Surveille les nouvelles versions du service worker et propose un toast
 * "Mettre a jour" quand une version est prete a etre installee.
 *
 * En mode dev, `SwUpdate.isEnabled` est false : init() est un no-op silencieux.
 */
@Injectable({ providedIn: 'root' })
export class PwaUpdateService {
  private readonly sw = inject(SwUpdate);
  private readonly toast = inject(ToastService);
  private interval: ReturnType<typeof setInterval> | null = null;

  init(): void {
    if (!this.sw.isEnabled) return;

    this.sw.versionUpdates
      .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
      .subscribe(() => this.notifyUpdate());

    // Verification periodique pour les sessions tres longues
    this.interval = setInterval(() => {
      this.sw.checkForUpdate().catch(() => { /* silent */ });
    }, CHECK_INTERVAL_MS);

    // Verifier au premier focus apres lancement
    this.sw.checkForUpdate().catch(() => { /* silent */ });
  }

  destroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private notifyUpdate(): void {
    this.toast.show({
      kind: 'info',
      title: 'Nouvelle version disponible',
      message: 'Cliquer pour rafraichir et appliquer la mise a jour',
      duration: 0,
      action: {
        label: 'Mettre a jour',
        callback: () => {
          this.sw.activateUpdate().then(() => location.reload());
        },
      },
    });
  }
}
