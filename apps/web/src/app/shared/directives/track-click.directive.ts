import { Directive, HostListener, inject, input } from '@angular/core';
import { ActivityTrackerService } from '../../core/services/activity-tracker.service';

/**
 * Marque un élément cliquable pour le tracking d'activité.
 * Usage : `<button trackClick="export-pdf">Exporter</button>`.
 * On l'ajoute progressivement aux actions importantes.
 */
@Directive({ selector: '[trackClick]', standalone: true })
export class TrackClickDirective {
  readonly trackClick = input.required<string>();
  private readonly tracker = inject(ActivityTrackerService);

  @HostListener('click')
  onClick(): void {
    this.tracker.trackClick(this.trackClick());
  }
}
