import { ChangeDetectionStrategy, Component, HostListener, input, output } from '@angular/core';
import { LucideAngularModule, X } from 'lucide-angular';

/**
 * Espace dépôt (2026-08) — l'enveloppe commune des modales (A3 § 5).
 *
 * Cinq modales partagent la même enveloppe : voile, échappement clavier, fermeture
 * au clic hors panneau, et — sur mobile — une présentation en FEUILLE BASSE plutôt
 * qu'en boîte centrée. Une modale centrée sur 390 px oblige le pouce à remonter au
 * milieu de l'écran ; la feuille se ferme là où la main se trouve déjà.
 *
 * La géométrie vient des jetons de plateforme (`--feuille-rayon`, `--feuille-poignee-*`) :
 * aucun composant ne teste la plateforme dans son template, il consomme et suit.
 */
@Component({
  selector: 'app-depot-modal',
  standalone: true,
  imports: [LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dmo-voile" (click)="fermer.emit()" aria-hidden="true"></div>
    <div class="dmo-panneau" role="dialog" aria-modal="true" [attr.aria-label]="titre()">
      <span class="dmo-poignee" aria-hidden="true"></span>
      <header class="dmo-tete">
        <div>
          <h2>{{ titre() }}</h2>
          @if (sousTitre()) { <p>{{ sousTitre() }}</p> }
        </div>
        <button type="button" class="dmo-fermer" (click)="fermer.emit()" aria-label="Fermer">
          <lucide-icon [img]="X" [size]="18" />
        </button>
      </header>
      <div class="dmo-corps"><ng-content /></div>
      <ng-content select="[pied]" />
    </div>
  `,
  styles: [`
    :host { display: contents }
    .dmo-voile {
      position: fixed; inset: 0; z-index: 9000;
      background: rgba(0, 0, 0, .55); backdrop-filter: blur(2px);
      animation: dmo-fondu 180ms ease both;
    }
    .dmo-panneau {
      position: fixed; z-index: 9001; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(640px, calc(100vw - 32px)); max-height: min(84vh, 780px);
      display: flex; flex-direction: column;
      border-radius: 20px; background: var(--surface-secondary);
      border: 1px solid var(--border-color);
      box-shadow: 0 24px 64px rgba(0, 0, 0, .38);
      animation: dmo-entree 220ms cubic-bezier(.16, 1, .3, 1) both;
    }
    .dmo-poignee { display: none }
    .dmo-tete {
      flex: 0 0 auto; display: flex; align-items: flex-start; justify-content: space-between;
      gap: 14px; padding: 18px 20px 12px; border-bottom: 1px solid var(--border-color);
    }
    .dmo-tete h2 {
      margin: 0; font-family: var(--font-display); font-size: 17px; font-weight: 800;
      letter-spacing: -.015em; color: var(--text-primary);
    }
    /* --texte-inactif, et non --depot-attenue : depuis le lot A6 cette coque sert AUSSI
       a l'espace transporteur (modale de negociation), ou les jetons --depot-* n'existent
       pas. Les deux ont la meme valeur — --depot-attenue en est un alias — donc l'espace
       depot ne bouge pas d'un pixel. */
    .dmo-tete p { margin: 4px 0 0; font-size: 12.5px; color: var(--texte-inactif) }
    .dmo-fermer {
      flex: 0 0 auto; display: grid; place-items: center; width: 34px; height: 34px;
      border-radius: 10px; border: 1px solid var(--border-color);
      background: transparent; color: var(--text-secondary); cursor: pointer;
    }
    .dmo-fermer:hover { background: var(--surface-tertiary); color: var(--text-primary) }
    .dmo-corps { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px 18px }

    @keyframes dmo-fondu { from { opacity: 0 } to { opacity: 1 } }
    @keyframes dmo-entree {
      from { opacity: 0; transform: translate(-50%, -46%) scale(.97) }
      to   { opacity: 1; transform: translate(-50%, -50%) scale(1) }
    }

    /* ─── Mobile : feuille basse ────────────────────────────────────────────── */
    @media (max-width: 767px) {
      .dmo-panneau {
        left: 0; right: 0; bottom: 0; top: auto; transform: none;
        width: auto; max-height: 88dvh;
        border-radius: var(--feuille-rayon) var(--feuille-rayon) 0 0;
        padding-bottom: env(safe-area-inset-bottom);
        animation: dmo-monte 260ms cubic-bezier(.16, 1, .3, 1) both;
      }
      .dmo-poignee {
        display: block; margin: 10px auto 2px; border-radius: 9999px;
        background: var(--text-tertiary); opacity: .45;
        width: var(--feuille-poignee-l); height: var(--feuille-poignee-h);
      }
      .dmo-tete { padding-top: 10px }
      .dmo-fermer { width: 44px; height: 44px }
    }
    @keyframes dmo-monte { from { transform: translateY(100%) } to { transform: translateY(0) } }

    @media (prefers-reduced-motion: reduce) {
      .dmo-voile, .dmo-panneau { animation-duration: 1ms !important }
    }
  `],
})
export class DepotModalComponent {
  readonly titre = input.required<string>();
  readonly sousTitre = input<string | null>(null);
  readonly fermer = output<void>();

  protected readonly X = X;

  @HostListener('document:keydown.escape')
  protected surEchap(): void {
    this.fermer.emit();
  }
}
