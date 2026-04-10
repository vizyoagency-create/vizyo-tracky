import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LogoComponent } from '../shared/ui/logo/logo.component';

@Component({
  selector: 'app-auth-layout',
  standalone: true,
  imports: [RouterOutlet, LogoComponent],
  template: `
    <div class="min-h-screen flex items-center justify-center bg-bg-primary relative overflow-hidden">
      <div class="absolute inset-0 pointer-events-none"
           style="background: radial-gradient(ellipse at 50% 30%, rgba(16,224,160,0.08) 0%, transparent 60%)">
      </div>
      <div class="relative z-10 w-full max-w-md px-6">
        <div class="flex flex-col items-center mb-8">
          <app-logo variant="lockup" [size]="56" />
          <p class="text-fg-tertiary text-sm mt-3">Gestion de flottes GPS</p>
        </div>
        <router-outlet />
      </div>
    </div>
  `,
})
export class AuthLayoutComponent {}
