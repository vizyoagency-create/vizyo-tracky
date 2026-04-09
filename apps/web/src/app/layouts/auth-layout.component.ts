import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-auth-layout',
  standalone: true,
  imports: [RouterOutlet],
  template: `
    <div class="min-h-screen flex items-center justify-center bg-bg-primary relative overflow-hidden">
      <div class="absolute inset-0 pointer-events-none"
           style="background: radial-gradient(ellipse at 50% 30%, rgba(16,224,160,0.08) 0%, transparent 60%)">
      </div>
      <div class="relative z-10 w-full max-w-md px-6">
        <div class="text-center mb-8">
          <h1 class="text-3xl font-display font-bold bg-tracky-gradient bg-clip-text text-transparent">
            Vizyo Tracky
          </h1>
          <p class="text-fg-tertiary text-sm mt-2">Gestion de flottes GPS</p>
        </div>
        <router-outlet />
      </div>
    </div>
  `,
})
export class AuthLayoutComponent {}
