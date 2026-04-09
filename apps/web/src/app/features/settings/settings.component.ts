import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { LucideAngularModule, LogOut, User } from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
import { RealtimeService } from '../../core/services/realtime.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    <div class="flex flex-col gap-6">
      <h1 class="text-2xl font-display font-bold text-fg-primary">Parametres</h1>

      <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-6 max-w-lg">
        <h2 class="text-lg font-display font-semibold text-fg-primary mb-4">Compte</h2>

        @if (user()) {
          <div class="flex items-center gap-3 mb-6 p-4 rounded-xl bg-bg-tertiary">
            <div class="w-10 h-10 rounded-full bg-tracky/20 flex items-center justify-center">
              <lucide-icon [img]="User" [size]="20" class="text-tracky-light"></lucide-icon>
            </div>
            <div>
              <p class="text-sm font-semibold text-fg-primary">{{ user()!.email }}</p>
              <p class="text-xs text-fg-tertiary">{{ user()!.role }}</p>
            </div>
          </div>
        }

        <button
          (click)="logout()"
          class="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium
                 bg-red-600/20 text-red-400 border border-red-600/30
                 hover:bg-red-600/30 transition-colors cursor-pointer"
        >
          <lucide-icon [img]="LogOut" [size]="18"></lucide-icon>
          Se deconnecter
        </button>
      </div>
    </div>
  `,
})
export class SettingsComponent {
  private readonly auth = inject(AuthService);
  private readonly realtime = inject(RealtimeService);
  private readonly router = inject(Router);
  protected readonly user = this.auth.user;
  protected readonly User = User;
  protected readonly LogOut = LogOut;

  logout(): void {
    this.realtime.disconnect();
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
