import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './core/services/auth.service';
import { PreferencesService } from './core/services/preferences.service';
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

  ngOnInit(): void {
    // Charger les préférences si déjà authentifié (refresh page)
    const user = this.auth.user();
    if (user?.sub) {
      this.preferences.load(user.sub);
    }
    this.theme.init();

    const token = this.auth.token;
    if (token) {
      this.realtime.connect(token);
    }
  }
}
