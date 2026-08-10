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
import { estPagePublique } from './core/utils/page-publique';
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
    //
    // ⚠️ RIEN DE TOUT CELA SUR LA PAGE PUBLIQUE DE SUIVI (lot A4). `installPrompt`
    // compte les visites dans le localStorage et propose d'installer l'application ;
    // `pwaUpdate` enregistre un service worker. Chez un destinataire anonyme, ce sont
    // deux traces posées sur son appareil et une proposition qui n'a aucun sens — il
    // ne vient pas installer une application de gestion de flotte, il regarde arriver
    // son colis (A4 § 6). Le réseau, lui, reste utile : il ne pose rien.
    this.network.init();
    if (!estPagePublique()) {
      this.installPrompt.init();
      this.pwaUpdate.init();
    }

    const token = this.auth.token;
    // ⚠️ Espace dépôt (2026-08), lot A3 — PAS de socket de flotte pour un DEPOT.
    //
    // `RealtimeService` est le canal de la FLOTTE : positions de tous les véhicules,
    // alertes, statuts de boîtier. Un dépôt n'en reçoit rien (le serveur ne le met
    // dans aucun salon de flotte, A1 § 3) — il ouvrait donc un second raccordement
    // permanent qui n'écoute rien, en plus de celui de `DepotLiveStore`. Deux sockets
    // par dépôt, deux fois la revalidation périodique, pour zéro message utile.
    if (token && !this.auth.isDepot()) {
      this.realtime.connect(token);
    }
  }
}
