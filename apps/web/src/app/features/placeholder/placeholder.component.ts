import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

@Component({
  selector: 'app-placeholder',
  standalone: true,
  template: `
    <div class="flex items-center justify-center h-64 rounded-[--radius-card]
                bg-bg-secondary border border-border-subtle">
      <p class="text-fg-tertiary text-lg font-display">{{ title }} — bientot disponible</p>
    </div>
  `,
})
export class PlaceholderComponent {
  protected readonly title = inject(ActivatedRoute).snapshot.data['title'] ?? '';
}
