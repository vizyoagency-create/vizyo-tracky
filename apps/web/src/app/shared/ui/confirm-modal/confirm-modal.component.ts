import { Component, computed, HostListener, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, AlertTriangle, ChevronsRight, Info, Pointer } from 'lucide-angular';

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
 *                 rappelé, et geste explicite (saisie ou glissement). Un geste qui
 *                 immobilise un bien ne se fait pas en un clic.
 *
 * SUR MOBILE, C'EST UNE FEUILLE, PAS UNE BOÎTE CENTRÉE
 * « Jamais une modale centrée sur un téléphone : elle atterrit sous le clavier. »
 * La variante avec saisie ouvre le clavier ; la variante moteur utilise un glissement.
 * La bascule est en CSS : même composant, même DOM, géométrie de feuille sous 640 px,
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

          @if (critique() && confirmationAttendue() && !slideToConfirm()) {
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

          @if (slideToConfirm()) {
            <!-- 30/09 : un VRAI bouton à glisser (retour du propriétaire : « une ligne avec un point »).
                 Le range natif reste là, invisible et posé sur toute la piste, à la taille de la pastille :
                 c'est lui qui porte le doigt, la souris, le clavier et la garde T50. La piste, la pastille,
                 le remplissage et le doigt animé ne sont que son dessin, piloté par la valeur du glissement. -->
            <div class="cm-glisse"
                 [class.cm-glisse--danger]="danger() || critique()"
                 [class.cm-glisse--actif]="glissement() > 0"
                 [class.cm-glisse--envoi]="loading()"
                 [style.--p]="loading() ? 100 : glissement()">
              <div class="cm-glisse-piste" aria-hidden="true">
                <span class="cm-glisse-rempli"></span>
                <span class="cm-glisse-texte">{{ loading() ? 'Envoi…' : slideLabel() }}</span>
                <span class="cm-glisse-bout"><lucide-icon [img]="ChevronsRight" [size]="18"></lucide-icon></span>
                <span class="cm-glisse-bouton">
                  @if (loading()) {
                    <span class="cm-rond"></span>
                  } @else {
                    <lucide-icon [img]="ChevronsRight" [size]="24"></lucide-icon>
                  }
                </span>
                <span class="cm-glisse-doigt"><lucide-icon [img]="Pointer" [size]="26"></lucide-icon></span>
              </div>
              <input
                class="cm-glisse-i"
                type="range"
                min="0"
                max="100"
                step="1"
                [disabled]="loading()"
                [value]="glissement()"
                (input)="onSlideEvent($event)"
                (change)="onSlideRelease($event)"
                (keydown)="onSlideKeydown($event)"
                [attr.aria-label]="slideLabel()"
                [attr.aria-description]="'Faites glisser jusqu’au bout, ou maintenez la flèche droite ; les touches Fin et Page suivante sont sans effet.'" />
            </div>
            <p class="cm-glisse-aide" aria-hidden="true">{{ loading() ? 'Envoi en cours…' : 'Posez le doigt sur le bouton et faites-le glisser jusqu’au bout.' }}</p>
          }

          <div class="cm-actions" [class.cm-actions--slide]="slideToConfirm()">
            <button type="button" class="cm-btn cm-btn--sec" (click)="onCancel()" [disabled]="loading()">
              {{ cancelLabel() }}
            </button>
            @if (!slideToConfirm()) {
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
            }
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
      /* Une modale plus haute que l'écran doit rester atteignable JUSQU'À SES BOUTONS. Mesuré le
         2026-09-07 : la confirmation critique de coupure, avec l'état du véhicule, ses conséquences
         et l'encart de démonstration, fait 775 px — sur un portable à 720 px de haut, le bouton
         « Couper le moteur » sortait de l'écran, sans défilement possible. Même règle qu'en
         feuille basse (ci-dessous) : la boîte défile, jamais la page. */
      max-height: 92vh; max-height: 92dvh; overflow-y: auto;
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

    /* ── Confirmation gestuelle : un VRAI bouton à glisser (30/09) ────────────────────────────
       Le range natif (.cm-glisse-i) couvre toute la piste, OPACITÉ 0, avec un pouce de la taille de
       la pastille : le geste réel (tactile, souris, clavier, garde T50) reste le sien. La pastille
       suit sa valeur (--p, 0 → 100) ; au relâché avant le bout, elle revient avec un petit rebond.
       Au repos, une invitation en boucle : un doigt se pose sur la pastille, la pousse, se lève —
       et le libellé porte un reflet qui court vers la droite. Rien ne bouge sous « mouvement réduit ». */
    .cm-glisse { --p: 0; --b: 52px; --pad: 4px; position: relative; margin-top: 18px; }
    .cm-glisse-piste {
      position: relative; height: calc(var(--b) + 2 * var(--pad)); border-radius: 9999px; overflow: hidden;
      background: color-mix(in srgb, var(--color-tracky-light) 13%, var(--bg-tertiary));
      border: 1px solid color-mix(in srgb, var(--color-tracky-light) 45%, var(--border-subtle));
      box-shadow: inset 0 2px 5px rgba(0,0,0,.16);
    }
    .cm-glisse--danger .cm-glisse-piste {
      background: color-mix(in srgb, var(--danger) 11%, var(--bg-tertiary));
      border-color: color-mix(in srgb, var(--danger) 50%, var(--border-subtle));
    }
    .cm-glisse-rempli {
      position: absolute; top: var(--pad); bottom: var(--pad); left: var(--pad);
      width: calc(var(--b) + (100% - var(--b) - 2 * var(--pad)) * var(--p) / 100);
      border-radius: 9999px;
      background: color-mix(in srgb, var(--color-tracky-light) 32%, transparent);
    }
    .cm-glisse--danger .cm-glisse-rempli { background: color-mix(in srgb, var(--danger) 30%, transparent); }
    .cm-glisse-texte {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      padding: 0 calc(var(--b) + 14px);
      font-size: .9rem; font-weight: 750; letter-spacing: .01em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      color: var(--fg-primary);
      background: linear-gradient(90deg, var(--fg-secondary) 0%, var(--fg-secondary) 38%, var(--fg-primary) 50%, var(--fg-secondary) 62%, var(--fg-secondary) 100%);
      background-size: 250% 100%;
      -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
      animation: cm-reflet 2.6s linear infinite;
      opacity: calc(1 - var(--p) / 70);
    }
    .cm-glisse-bout {
      position: absolute; top: 50%; right: 18px; transform: translateY(-50%); display: flex;
      color: var(--color-tracky-light); opacity: calc(.7 - var(--p) / 140);
    }
    .cm-glisse--danger .cm-glisse-bout { color: var(--danger); }
    .cm-glisse-bouton {
      position: absolute; top: var(--pad);
      left: calc(var(--pad) + (100% - var(--b) - 2 * var(--pad)) * var(--p) / 100);
      width: var(--b); height: var(--b); border-radius: 9999px;
      display: flex; align-items: center; justify-content: center;
      background: var(--color-tracky-light); color: var(--accent-ink);
      box-shadow: 0 6px 14px -4px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.28);
      transition: left .32s cubic-bezier(.3, 1.45, .5, 1);
    }
    .cm-glisse--danger .cm-glisse-bouton { background: var(--danger); }
    .cm-glisse--actif .cm-glisse-bouton { transition: none; }
    .cm-glisse-doigt {
      position: absolute; pointer-events: none; opacity: 0;
      /* La pointe de l'index (≈ 9 × 2 px de l'icône) posée au centre de la pastille. */
      left: calc(var(--pad) + var(--b) / 2 - 9px); top: calc(var(--pad) + var(--b) / 2 - 2px);
      /* Encre du thème, cernée de son fond : lisible sur la pastille comme sur la piste, clair ou sombre. */
      color: var(--fg-primary);
      filter: drop-shadow(0 0 1.5px var(--bg-primary)) drop-shadow(0 1px 2px color-mix(in srgb, var(--bg-primary) 70%, transparent));
    }
    /* L'invitation ne joue qu'au repos : ni pendant le geste, ni pendant l'envoi. */
    .cm-glisse:not(.cm-glisse--actif):not(.cm-glisse--envoi) .cm-glisse-bouton { animation: cm-invite 2.8s ease-in-out infinite; }
    .cm-glisse:not(.cm-glisse--actif):not(.cm-glisse--envoi) .cm-glisse-doigt { animation: cm-doigt 2.8s ease-in-out infinite; }
    @keyframes cm-invite {
      0%, 22%, 66%, 100% { transform: translateX(0); }
      44% { transform: translateX(46px); }
      54% { transform: translateX(40px); }
    }
    @keyframes cm-doigt {
      0%, 8% { opacity: 0; transform: translate(0, 6px) scale(1.12); }
      20% { opacity: 1; transform: translate(0, 0) scale(1); }
      22% { opacity: 1; transform: translate(0, 0) scale(.94); }
      44% { opacity: 1; transform: translate(46px, 0) scale(.94); }
      54% { opacity: .9; transform: translate(40px, 0) scale(.94); }
      66%, 100% { opacity: 0; transform: translate(40px, 8px) scale(1.08); }
    }
    @keyframes cm-reflet { from { background-position: 100% 0; } to { background-position: -150% 0; } }
    .cm-glisse--envoi .cm-glisse-texte { animation: none; }

    .cm-glisse-i {
      position: absolute; inset: 0; width: 100%; height: 100%; margin: 0;
      opacity: 0; cursor: grab; touch-action: pan-x;
      -webkit-appearance: none; appearance: none; background: transparent;
    }
    .cm-glisse-i:active { cursor: grabbing; }
    .cm-glisse-i:disabled { cursor: progress; }
    .cm-glisse-i::-webkit-slider-runnable-track { height: 100%; background: transparent; }
    .cm-glisse-i::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: calc(var(--b) + 2 * var(--pad)); height: calc(var(--b) + 2 * var(--pad)); border: 0;
    }
    .cm-glisse-i::-moz-range-track { height: 100%; background: transparent; border: 0; }
    .cm-glisse-i::-moz-range-thumb { width: calc(var(--b) + 2 * var(--pad)); height: calc(var(--b) + 2 * var(--pad)); border: 0; background: transparent; }
    /* Le focus clavier se voit sur la piste, puisque le range est transparent. */
    .cm-glisse:has(.cm-glisse-i:focus-visible) .cm-glisse-piste { outline: 2px solid var(--color-tracky-light); outline-offset: 3px; }
    .cm-glisse--danger:has(.cm-glisse-i:focus-visible) .cm-glisse-piste { outline-color: var(--danger); }
    .cm-glisse-aide { margin: 8px 0 0; font-size: .74rem; color: var(--fg-secondary); text-align: center; }
    @media (prefers-reduced-motion: reduce) {
      .cm-glisse .cm-glisse-bouton, .cm-glisse .cm-glisse-doigt, .cm-glisse .cm-glisse-texte { animation: none !important; }
      .cm-glisse-bouton { transition: none; }
    }

    .cm-actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 24px; }
    .cm-actions--slide { margin-top: 12px; }
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
        max-height: 88vh; max-height: 88dvh; overflow-y: auto;
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
  /** Niveau critique : liseré rouge, état rappelé, geste explicite de confirmation. */
  readonly critique = input(false);
  /**
   * Le mot à retaper pour débloquer la confirmation — la plaque, en général.
   * Marqueur n° 3 du niveau critique. Comparaison insensible à la casse et aux
   * espaces : on vérifie que la personne a LU la plaque, pas qu'elle sait taper.
   */
  readonly confirmationAttendue = input<string>();
  /** Confirmation tactile/accessible par glissement, utilisée pour les commandes moteur. */
  readonly slideToConfirm = input(false);
  readonly slideLabel = input('Glissez pour confirmer');
  readonly loading = input(false);

  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Info = Info;
  protected readonly ChevronsRight = ChevronsRight;
  protected readonly Pointer = Pointer;
  /** Identifiant unique pour relier title/desc via aria-labelledby/describedby */
  protected readonly uid = Math.random().toString(36).slice(2, 9);

  protected readonly saisie = signal('');
  protected readonly glissement = signal(0);
  /**
   * ══ T50 (contre-expertise du 13/09, P2-3) — UN GLISSEMENT, PAS UN CLIC ═════════════════════
   *
   * Un `<input type="range">` natif saute au point cliqué : un clic en bout de piste, ou la
   * touche Fin, produisait `change` à 100 → confirmation d'une coupure moteur sans le moindre
   * geste continu. L'exigence « impossible de déclencher accidentellement » n'était pas tenue.
   *
   * La confirmation exige désormais un geste PROGRESSIF : au moins SLIDE_MIN_SAMPLES valeurs
   * strictement croissantes, la première sous SLIDE_START_MAX, la dernière au bout. Un doigt qui
   * glisse en produit des dizaines ; une flèche droite maintenue aussi (chaque répétition est un
   * événement `input`) — le clavier reste donc possible. Un clic, un `Fin`, un `Page suivante`
   * n'en produisent qu'un : rien ne part, le curseur revient au départ.
   */
  private static readonly SLIDE_MIN_SAMPLES = 8;
  private static readonly SLIDE_START_MAX = 10;
  private static readonly SLIDE_END_MIN = 98;
  private slideSamples: number[] = [];

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
    this.glissement.set(0);
    this.confirmed.emit();
  }

  onSlide(value: number | string) {
    const next = Math.max(0, Math.min(100, Number(value) || 0));
    // T50 — on ne retient que les progressions : un retour en arrière n'efface rien (le pouce
    // tremble), mais ne compte pas non plus. Un premier échantillon déjà loin du départ (clic en
    // bout de piste) disqualifie le geste : il n'a pas d'échantillon « de départ ».
    const last = this.slideSamples[this.slideSamples.length - 1];
    if (last === undefined || next > last) this.slideSamples.push(next);
    this.glissement.set(next);
  }

  onSlideEvent(event: Event) {
    this.onSlide((event.target as HTMLInputElement).value);
  }

  /** T50 — un geste continu : assez d'échantillons croissants, partis du début, arrivés au bout. */
  protected gesteVolontaire(): boolean {
    const samples = this.slideSamples;
    const first = samples[0];
    const last = samples[samples.length - 1];
    return (
      samples.length >= ConfirmModalComponent.SLIDE_MIN_SAMPLES &&
      first !== undefined && first < ConfirmModalComponent.SLIDE_START_MAX &&
      last !== undefined && last >= ConfirmModalComponent.SLIDE_END_MIN
    );
  }

  onSlideRelease(event?: Event) {
    const volontaire = this.gesteVolontaire();
    this.slideSamples = [];
    if (volontaire && this.glissement() >= ConfirmModalComponent.SLIDE_END_MIN && !this.loading()) {
      // La commande part au RELÂCHEMENT au bout, jamais au simple passage du pouce près de la fin.
      this.onConfirm();
    } else {
      this.glissement.set(0);
      // Le DOM d'un range est modifié directement par le navigateur. Comme la valeur finale
      // du signal redevient identique à l'ancienne (0), Angular peut légitimement ne pas
      // réécrire la propriété : on remet donc aussi le contrôle natif au départ.
      if (event?.target instanceof HTMLInputElement) event.target.value = '0';
    }
  }

  /** T50 — Fin, Début, Page suivante/précédente sauteraient au bout d'un seul coup : sans effet. */
  onSlideKeydown(event: KeyboardEvent) {
    if (['End', 'Home', 'PageUp', 'PageDown'].includes(event.key)) event.preventDefault();
  }

  onCancel() {
    if (this.loading()) return;
    this.saisie.set('');
    this.glissement.set(0);
    this.slideSamples = [];
    this.cancelled.emit();
  }
}
