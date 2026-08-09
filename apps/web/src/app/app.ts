import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ActivityTrackerService } from './core/services/activity-tracker.service';
import { AuthService } from './core/services/auth.service';
import { InstallPromptService } from './core/services/install-prompt.service';
import { NetworkStatusService } from './core/services/network-status.service';
import { PreferencesService } from './core/services/preferences.service';
import { PwaUpdateService } from './core/services/pwa-update.service';
import { RealtimeService } from './core/services/realtime.service';
import { ThemeService } from './core/theme/theme.service';
import { ToastContainerComponent } from './shared/ui/toast/toast-container.component';
import { appliquerPlateforme } from './shared/utils/platform';
import { UpdateRequiredModalComponent } from './shared/ui/update-required-modal/update-required-modal.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ToastContainerComponent, UpdateRequiredModalComponent],
  template: `
    <router-outlet />
    <app-toast-container />
    <app-update-required-modal />
  `,
})
export class App implements OnInit {
  private readonly theme = inject(ThemeService);
  private readonly auth = inject(AuthService);
  private readonly realtime = inject(RealtimeService);
  private readonly preferences = inject(PreferencesService);
  private readonly pwaUpdate = inject(PwaUpdateService);
  private readonly installPrompt = inject(InstallPromptService);
  private readonly network = inject(NetworkStatusService);
  // Tracking d'activité utilisateur : instancié ici pour démarrer son effet
  // (start/stop automatique selon l'authentification).
  private readonly activityTracker = inject(ActivityTrackerService);

  ngOnInit(): void {
    // Refonte v2 — pose `plat-ios` / `plat-android` / `plat-bureau` sur <body>. Les
    // 3 écarts de géométrie (poignée, rayon, densité) sont VOLONTAIRES : les aplatir
    // donnerait une application étrangère sur les deux plateformes (B1 § système de
    // référence). Fait en premier : des composants montés plus bas les consomment.
    appliquerPlateforme();
    // Charger les préférences si déjà authentifié (refresh page)
    const user = this.auth.user();
    if (user?.sub) {
      this.preferences.load(user.sub);
    }
    this.theme.init();
    if (user?.sub) {
      // Le theme courant a ete pose par le script inline d'index.html. Si l'user
      // auth a sauvegarde un choix different, on l'applique maintenant.
      this.theme.applyFromPrefs();
    }

    // Services transverses PWA/network : init avant la connexion realtime
    // pour qu'on dispose de l'etat de connectivite des le depart.
    this.network.init();
    this.installPrompt.init();
    this.pwaUpdate.init();

    const token = this.auth.token;
    if (token) {
      this.realtime.connect(token);
    }
  }
}
