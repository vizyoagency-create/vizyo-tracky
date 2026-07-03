import { Directive, HostBinding, HostListener, inject, input } from '@angular/core';
import { Router } from '@angular/router';

/**
 * Rend un élément (plaque, ligne de tableau…) cliquable → fiche véhicule.
 *
 * Usage : `<span class="plate" [vehicleLink]="v.id">{{ v.plate }}</span>`
 *
 * - Clic (ou Entrée / Espace) → navigation vers `/vehicles/:id`.
 * - `stopPropagation` : dans une ligne déjà cliquable, le véhicule ciblé prime
 *   (évite un double comportement).
 * - Ajoute curseur pointer + `role="link"` + focus clavier via la classe globale
 *   `.vehicle-link` (styles.css).
 * - Si l'id est null/undefined : totalement inerte (ni lien, ni curseur) — sûr à
 *   poser partout, même quand le véhicule n'est pas résolu.
 */
@Directive({
  selector: '[vehicleLink]',
  standalone: true,
})
export class VehicleLinkDirective {
  /** Id du véhicule cible. Null/undefined → directive inerte. */
  readonly vehicleLink = input<string | null | undefined>(null);

  private readonly router = inject(Router);

  @HostBinding('class.vehicle-link') get active(): boolean {
    return !!this.vehicleLink();
  }
  @HostBinding('attr.role') get role(): string | null {
    return this.vehicleLink() ? 'link' : null;
  }
  @HostBinding('attr.tabindex') get tabindex(): string | null {
    return this.vehicleLink() ? '0' : null;
  }

  @HostListener('click', ['$event'])
  onClick(ev: Event): void {
    const id = this.vehicleLink();
    if (!id) return;
    ev.stopPropagation();
    void this.router.navigate(['/vehicles', id]);
  }

  @HostListener('keydown.enter', ['$event'])
  @HostListener('keydown.space', ['$event'])
  onKey(ev: Event): void {
    const id = this.vehicleLink();
    if (!id) return;
    ev.preventDefault();
    ev.stopPropagation();
    void this.router.navigate(['/vehicles', id]);
  }
}
