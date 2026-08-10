import { Component, computed, HostListener, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, AlertTriangle, Info } from 'lucide-angular';

/**
 * Confirmation — 14 pages. Le composant le plus vu du kit après les toasts.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ « ÊTES-VOUS SÛR ? » SEUL EST INTERDIT                                      │
 * │                                                                            │
 * │ Règle du kit (`Kit Partage Refonte`) : une modale de danger DOIT nommer ce │
 * │ qui est perdu, chiffres compris. « Supprimer ce véhicule ? » ne dit rien ; │
 * │ « Ses 3 412 trajets et son historique d'entretien seront perdus » dit tout.│
 * │ D'où l'entrée `consequences`, séparée de `description` : elle n'est pas un │
 * │ complément de style, c'est l'information qui permet de décider.            │
 * │                                                                            │
 * │ Et le libellé de confirmation porte un VERBE — « Supprimer », « Couper » — │
 * │ jamais « OK ». Le bouton doit se lire seul : c'est lui qu'on regarde au    │
 * │ moment d'appuyer, pas le titre.                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * TROIS NIVEAUX, ET CE QUI LES SÉPARE
 *   · normal    — pictogramme d'information, bouton d'accent.
 *   · danger    — pictogramme d'alerte, bouton rouge, conséquences exigées.
 *   · critique  — trois marqueurs de plus : liseré rouge en tête, état de l'objet
 *                 rappelé, et SAISIE d'un mot de confirmation. Un geste qui
 *                 immobilise un bien ne se fait pas en un clic.
 *
 * SUR MOBILE, C'EST UNE FEUILLE, PAS UNE BOÎTE CENTRÉE
 * « Jamais une modale centrée sur un téléphone : elle atterrit sous le clavier. »
 * Le cas critique le prouve — il demande une saisie, donc ouvre le clavier. La
 * bascule est en CSS : même composant, même DOM, géométrie de feuille sous 640 px,
 * avec le rayon et la poignée de la plateforme (jetons posés au lot A3).
 */
@Component({
  selector: 'app-confirm-modal',
  standalone: true,
  imports: [LucideAngularModule, FormsModule],
  template: `
    @if (open()) {
      <div class="cm-hote"
           role="dialog"
           aria-modal="true"
           [attr.aria-labelledby]="'confirm-modal-title-' + uid"
           [attr.aria-describedby]="description() ? 'confirm-modal-desc-' + uid : null">
        <div class="cm-voile" (click)="onCancel()" aria-hidden="true"></div>

        <div class="cm-boite" [class.cm-boite--critique]="critique()">
          <span class="cm-poignee" aria-hidden="true"></span>

          <div class="cm-tete">
            <lucide-icon
              [img]="danger() || critique() ? AlertTriangle : Info"
              [size]="24"
              class="cm-ico"
              [class.cm-ico--danger]="danger() || critique()"
              aria-hidden="true"></lucide-icon>
            <div class="cm-titres">
              <h3 [id]="'confirm-modal-title-' + uid" class="cm-titre">{{ title() }}</h3>
              @if (description()) {
                <p [id]="'confirm-modal-desc-' + uid" class="cm-desc" [innerHTML]="description()"></p>
              }
            </div>
          </div>

          <!-- L'état de l'objet, rappelé au moment du geste. « AB-231-CD est à l'arrêt
               depuis 12 min » : sans lui, on confirme de mémoire. -->
          @if (etat()) {
            <p class="cm-etat">{{ etat() }}</p>
          }

          <!-- Ce qui est perdu. Chiffré, et visuellement distinct du reste. -->
          @if (consequences()) {
            <p class="cm-conseq">
              {{ consequences() }}
              @if (irreversible()) { <strong class="cm-irr">Irréversible.</strong> }
            </p>
          }

          <ng-content />

          @if (critique() && confirmationAttendue()) {
            <label class="cm-saisie">
              <span class="cm-saisie-l">Tapez {{ confirmationAttendue() }} pour confirmer</span>
              <input
                class="cm-saisie-i"
                type="text"
                autocomplete="off"
                autocapitalize="characters"
                spellcheck="false"
                [attr.placeholder]="confirmationAttendue()"
                [ngModel]="saisie()"
                (ngModelChange)="saisie.set($event)" />
            </label>
          }

          <div class="cm-actions">
            <button type="button" class="cm-btn cm-btn--sec" (click)="onCancel()" [disabled]="loading()">
              {{ cancelLabel() }}
            </button>
            <button
              type="button"
              class="cm-btn"
              [class.cm-btn--danger]="danger() || critique()"
              [class.cm-btn--accent]="!danger() && !critique()"
              [disabled]="loading() || !confirmationOk()"
              [attr.title]="motifBlocage()"
              (click)="onConfirm()">
              @if (loading()) {
                <span class="cm-rond" aria-hidden="true"></span>
              }
              {{ confirmLabel() }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .cm-hote { position: fixed; inset: 0; z-index: 9000; display: flex; align-items: center; justify-content: center; }
    .cm-voile { position: absolute; inset: 0; background: rgba(0,0,0,.5); backdrop-filter: blur(2px); }
    .cm-boite {
      position: relative; width: 100%; max-width: 28rem; margin: 0 1rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card, 16px);
      padding: 24px;
      box-shadow: 0 24px 64px -12px rgba(0,0,0,.5);
    }
    /* Marqueur n° 1 du critique : un liseré rouge en tête, visible avant le titre. */
    .cm-boite--critique { border-top: 3px solid var(--texte-alerte); }

    .cm-poignee { display: none; }

    .cm-tete { display: flex; align-items: flex-start; gap: 12px; }
    .cm-ico { color: var(--texte-succes); flex: none; margin-top: 2px; }
    .cm-ico--danger { color: var(--texte-alerte); }
    .cm-titres { min-width: 0; }
    .cm-titre { margin: 0; font-family: var(--font-display); font-size: 1.125rem; font-weight: 600; color: var(--fg-primary); }
    .cm-desc { margin: 4px 0 0; font-size: .875rem; line-height: 1.5; color: var(--fg-secondary); }

    .cm-etat {
      margin: 14px 0 0; padding: 10px 12px;
      background: var(--bg-quaternary);
      border-radius: 10px;
      font-size: .8125rem; line-height: 1.5; color: var(--fg-secondary);
    }
    .cm-conseq {
      margin: 14px 0 0;
      font-size: .875rem; line-height: 1.55; color: var(--fg-primary);
    }
    .cm-irr { margin-left: 4px; color: var(--texte-alerte); font-weight: 700; }

    .cm-saisie { display: block; margin-top: 16px; }
    .cm-saisie-l { display: block; font-size: .78rem; font-weight: 600; color: var(--fg-secondary); margin-bottom: 6px; }
    .cm-saisie-i {
      width: 100%; padding: 10px 12px;
      font: inherit; font-family: var(--font-mono, monospace); font-size: .9rem; letter-spacing: .04em;
      color: var(--fg-primary); background: var(--bg-tertiary);
      border: 1px solid var(--border-strong); border-radius: 10px;
    }
    .cm-saisie-i:focus-visible { outline: 2px solid var(--texte-alerte); outline-offset: 1px; }

    .cm-actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 24px; }
    .cm-btn {
      display: inline-flex; align-items: center; gap: 8px;
      min-height: 44px; padding: 10px 16px;
      font: inherit; font-size: .875rem; font-weight: 500;
      border-radius: 12px; border: 1px solid transparent; cursor: pointer;
      transition: filter .15s, opacity .15s;
    }
    .cm-btn:disabled { opacity: .5; cursor: not-allowed; }
    .cm-btn:not(:disabled):hover { filter: brightness(1.08); }
    .cm-btn--sec { background: var(--bg-tertiary); color: var(--fg-secondary); border-color: var(--border-subtle); }
    .cm-btn--sec:not(:disabled):hover { color: var(--fg-primary); }
    /* L'encre sur l'accent est FONCÉE — règle non négociable de design/B0-SOCLE.md.
       Le blanc y donnait 3,43:1 en thème clair. */
    .cm-btn--accent { background: var(--color-tracky-light); color: var(--accent-ink); }
    .cm-btn--danger { background: var(--danger); color: var(--accent-ink); }

    .cm-rond {
      width: 16px; height: 16px; flex: none;
      border: 2px solid color-mix(in srgb, var(--accent-ink) 30%, transparent);
      border-top-color: var(--accent-ink);
      border-radius: 50%;
      animation: cm-tourne .8s linear infinite;
    }
    @keyframes cm-tourne { to { transform: rotate(360deg) } }
    @media (prefers-reduced-motion: reduce) { .cm-rond { animation-duration: 2.4s } }

    /* ─── Sous 640 px : une FEUILLE, pas une boîte centrée ─────────────────────
       Une modale centrée atterrit sous le clavier — et le cas critique ouvre
       justement le clavier. Rayon et poignée suivent les jetons de plateforme
       (iOS 22 px / 36 × 5, Android 28 px / 32 × 4). */
    @media (max-width: 639px) {
      .cm-hote { align-items: flex-end; }
      .cm-boite {
        margin: 0; max-width: none;
        border: 0;
        border-top-left-radius: var(--feuille-rayon);
        border-top-right-radius: var(--feuille-rayon);
        border-bottom-left-radius: 0; border-bottom-right-radius: 0;
        padding: 8px 20px calc(20px + env(safe-area-inset-bottom));
        max-height: 88dvh; overflow-y: auto;
      }
      .cm-boite--critique { border-top: 3px solid var(--texte-alerte); }
      .cm-poignee {
        display: block; margin: 4px auto 14px;
        width: var(--feuille-poignee-l); height: var(--feuille-poignee-h);
        border-radius: 9999px; background: var(--fg-tertiary); opacity: .45;
      }
      /* Les deux actions à parts égales, au pouce. */
      .cm-actions { margin-top: 20px; }
      .cm-btn { flex: 1; justify-content: center; }
    }
  `],
})
export class ConfirmModalComponent {
  readonly open = input.required<boolean>();
  readonly title = input.required<string>();
  readonly description = input<string>();
  /**
   * Ce qui est perdu, CHIFFRÉ. « Ses 3 412 trajets et son historique d'entretien
   * seront perdus. » Exigé dès que `danger` ou `critique` est vrai — cf. le contrôle
   * `pnpm verif:confirmations`, qui refuse une modale de danger sans conséquence.
   */
  readonly consequences = input<string>();
  /** Ajoute la mention « Irréversible. » à la suite des conséquences. */
  readonly irreversible = input(false);
  /**
   * L'état de l'objet au moment du geste — « AB-231-CD est à l'arrêt depuis 12 min ».
   * Marqueur n° 2 du niveau critique.
   */
  readonly etat = input<string>();
  /** Verbe explicite. Jamais « OK » : le bouton doit se lire seul. */
  readonly confirmLabel = input('Confirmer');
  readonly cancelLabel = input('Annuler');
  readonly danger = input(false);
  /** Niveau critique : liseré rouge, état rappelé, saisie de confirmation. */
  readonly critique = input(false);
  /**
   * Le mot à retaper pour débloquer la confirmation — la plaque, en général.
   * Marqueur n° 3 du niveau critique. Comparaison insensible à la casse et aux
   * espaces : on vérifie que la personne a LU la plaque, pas qu'elle sait taper.
   */
  readonly confirmationAttendue = input<string>();
  readonly loading = input(false);

  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Info = Info;
  /** Identifiant unique pour relier title/desc via aria-labelledby/describedby */
  protected readonly uid = Math.random().toString(36).slice(2, 9);

  protected readonly saisie = signal('');

  /** Le mot est-il correctement retapé ? Vrai d'office hors mode critique. */
  protected readonly confirmationOk = computed(() => {
    const attendu = this.confirmationAttendue();
    if (!this.critique() || !attendu) return true;
    return this.saisie().trim().toUpperCase() === attendu.trim().toUpperCase();
  });

  /**
   * Un bouton grisé sans explication se lit comme un bug. On dit pourquoi —
   * « nommer ce qui est perdu » vaut aussi pour ce qui est bloqué.
   */
  protected readonly motifBlocage = computed(() =>
    this.confirmationOk() ? null : `Tapez ${this.confirmationAttendue()} pour débloquer ce bouton`,
  );

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.open() && !this.loading()) this.onCancel();
  }

  onConfirm() {
    if (!this.confirmationOk() || this.loading()) return;
    this.confirmed.emit();
  }

  onCancel() {
    if (this.loading()) return;
    this.saisie.set('');
    this.cancelled.emit();
  }
}
