import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './core/services/auth.service';
import { InstallPromptService } from './core/services/install-prompt.service';
import { NetworkStatusService } from './core/services/network-status.service';
import { PreferencesService } from './core/services/preferences.service';
import { PwaUpdateService } from './core/services/pwa-update.service';
import { RealtimeService } from './core/services/realtime.service';
import { ThemeService } from './core/theme/theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class App implements OnInit {
  private readonly theme = inject(ThemeService);
  private readonly auth = inject(AuthService);
  private readonly realtime = inject(RealtimeService);
  private readonly preferences = inject(PreferencesService);
  private readonly pwaUpdate = inject(PwaUpdateService);
  private readonly installPrompt = inject(InstallPromptService);
  private readonly network = inject(NetworkStatusService);

  ngOnInit(): void {
    // Charger les préférences si déjà authentifié (refresh page)
    const user = this.auth.user();
    if (user?.sub) {
      this.preferences.load(user.sub);
    }
    this.theme.init();

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
