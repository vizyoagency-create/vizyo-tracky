import { Component, input } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

@Component({
  selector: 'app-metric-card',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    <div class="flex flex-col gap-3 p-5 rounded-[--radius-card]
                bg-bg-secondary border border-border-subtle
                transition-all duration-300 ease-tracky
                hover:border-border-strong hover:shadow-tracky-glow">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-fg-tertiary">{{ label() }}</span>
        @if (icon()) {
          <lucide-icon [img]="icon()!" [size]="20" class="text-tracky-light"></lucide-icon>
        }
      </div>
      <span class="text-3xl font-display font-bold text-fg-primary">{{ value() }}</span>
      @if (trend()) {
        <span class="text-xs text-fg-secondary">{{ trend() }}</span>
      }
    </div>
  `,
})
export class MetricCardComponent {
  label = input.required<string>();
  value = input.required<string | number>();
  trend = input<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon = input<any>();
}
