import { Component, inject } from '@angular/core';
import { FlaskConical, LucideAngularModule } from 'lucide-angular';
import { DemoModeService } from '../../../core/services/demo-mode.service';

/**
 * Le bandeau PERMANENT de l'environnement de démonstration.
 *
 * Il ne se ferme pas, il ne se replie pas : un prospect qui coupe un moteur doit lire, à
 * chaque écran, que rien ici n'atteint un véhicule. Une phrase sur bureau, trois mots sur
 * téléphone — la place manque, pas le message.
 *
 * Teinte de la famille verte fabriquée en `color-mix` (jamais `--color-tracky-light` en fond
 * sous du texte accent : vert sur vert, illisible — cf. design/TOKENS.md), texte en `--texte-succes`.
 */
@Component({
  selector: 'app-demo-banner',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    @if (demo.enabled()) {
      <div class="demo-bandeau" role="note" aria-label="Environnement de démonstration">
        <lucide-icon [img]="FlaskConical" [size]="14" aria-hidden="true"></lucide-icon>
        <span class="demo-bandeau-t">Démonstration</span>
        <span class="demo-bandeau-p demo-bandeau-p--long">
          Société, véhicules et conducteurs fictifs · aucune commande n'atteint un véhicule réel
        </span>
        <span class="demo-bandeau-p demo-bandeau-p--court">Données fictives · commandes simulées</span>
      </div>
    }
  `,
  styles: [
    `
      :host { display: block; }
      .demo-bandeau {
        display: flex; align-items: center; justify-content: center; gap: 8px;
        min-height: 28px; padding: 4px 12px;
        background: color-mix(in srgb, var(--color-tracky-light) 12%, var(--bg-secondary));
        border-bottom: 1px solid color-mix(in srgb, var(--color-tracky-light) 35%, transparent);
        color: var(--texte-succes);
        font-size: 12px; line-height: 1.3;
      }
      .demo-bandeau-t { font-weight: 800; letter-spacing: 0.02em; text-transform: uppercase; font-size: 11px; }
      .demo-bandeau-p { color: var(--fg-secondary); font-weight: 600; text-wrap: pretty; }
      .demo-bandeau-p--court { display: none; }
      /* Téléphone : le libellé, un point, trois mots — sur UNE ligne à 375 px (mesuré : deux
         lignes avec l'espacement du bureau). */
      @media (max-width: 560px) {
        .demo-bandeau { gap: 6px; padding: 4px 10px; font-size: 11px; }
        .demo-bandeau-t { font-size: 10px; }
        .demo-bandeau-p--long { display: none; }
        .demo-bandeau-p--court { display: inline; white-space: nowrap; }
      }
    `,
  ],
})
export class DemoBannerComponent {
  protected readonly demo = inject(DemoModeService);
  protected readonly FlaskConical = FlaskConical;
}
