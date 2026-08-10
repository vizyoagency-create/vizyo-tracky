import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  Output,
  signal,
  viewChild,
} from '@angular/core';

/**
 * Bottom sheet mobile generique : un panneau qui glisse depuis le bas avec :
 *   - backdrop semi-transparent (tap pour fermer)
 *   - handle drag-to-dismiss (touchmove vertical)
 *   - touche Escape pour fermer
 *   - safe-area-inset-bottom respectee
 *
 * Pattern UX standard sur iOS/Android (Apple Music, Google Maps, etc.) — plus
 * naturel pour le pouce que les drawers lateraux quand l'utilisateur tient
 * le tel d'une main. Le composant est purement structurel : le contenu est
 * passe via `<ng-content>`. Cf. install-banner pour un pattern proche.
 *
 * Usage :
 *   <app-bottom-sheet [open]="menuOpen()" (closed)="menuOpen.set(false)">
 *     <header>Mon titre</header>
 *     <ul>...</ul>
 *   </app-bottom-sheet>
 */
@Component({
  selector: 'app-bottom-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div
        class="bs-backdrop"
        [class.bs-backdrop--leaving]="leaving()"
        [class.bs-backdrop--sans-voile]="sansVoile"
        (click)="dismiss()"
        aria-hidden="true">
      </div>
      <div
        #panel
        class="bs-panel"
        [class.bs-panel--leaving]="leaving()"
        [style.transform]="panelTransform()"
        [style.--bs-hauteur]="hauteurCss()"
        [attr.data-hauteur]="hauteur ? '' : null"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="ariaLabel || null">
        <button
          type="button"
          class="bs-handle-wrap"
          (touchstart)="onTouchStart($event)"
          (touchmove)="onTouchMove($event)"
          (touchend)="onTouchEnd()"
          (touchcancel)="onTouchEnd()"
          (click)="dismiss()"
          aria-label="Fermer le menu">
          <span class="bs-handle"></span>
        </button>
        <div class="bs-content">
          <ng-content></ng-content>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: contents }

    .bs-backdrop {
      position: fixed; inset: 0; z-index: 8000;
      background: rgba(0, 0, 0, .5);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
      animation: bs-fade-in 220ms cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    /* Le voile disparaît quand la feuille se pose sur une carte : « la carte reste
       lisible et manipulable derrière » (Kit Partage). Une carte masquée par un voile
       gris pendant qu'on choisit un calque ne montre plus ce qu'on est en train de régler. */
    .bs-backdrop--sans-voile {
      background: transparent;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
    .bs-backdrop--leaving {
      animation: bs-fade-out 200ms cubic-bezier(0.4, 0, 1, 1) both;
    }

    /* GÉOMÉTRIE DE PLATEFORME — le rayon et la poignée viennent des jetons posés au
       lot A3, pas de valeurs figées. La feuille était à 20 px de rayon et 44 × 4 de
       poignée : ni iOS (22 px, 36 × 5) ni Android (28 px, 32 × 4). Un seul habillage
       pour deux plateformes donne une application étrangère sur les deux
       (design/B1-PAGES.md § « Le système de référence »). La classe plat-* est posée
       sur body par shared/utils/platform.ts ; les jetons sont déclarés au niveau de
       body dans styles.css, donc ils traversent l'encapsulation sans sélecteur. */
    .bs-panel {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 8001;
      max-height: 85vh; max-height: 85dvh;
      display: flex; flex-direction: column;
      background: var(--bg-secondary);
      border-top-left-radius: var(--feuille-rayon);
      border-top-right-radius: var(--feuille-rayon);
      box-shadow: 0 -12px 48px rgba(0, 0, 0, 0.5);
      padding-bottom: env(safe-area-inset-bottom);
      animation: bs-slide-up 280ms cubic-bezier(0.16, 1, 0.3, 1) both;
      will-change: transform;
      touch-action: pan-y;
    }
    /* HAUTEUR ANNONCÉE — les six feuilles de la maquette sont dimensionnées, pas
       laissées au contenu : commandes de rejeu 50 %, calques de carte 62 %, fiche
       véhicule 72 %, valider un lieu 56 %, choisir une période 58 %, partager une
       position 44 %. Une feuille qui prend la hauteur de son contenu saute d'un écran
       à l'autre ; une hauteur déclarée se retient. Sans l'entrée, rien ne change. */
    .bs-panel[data-hauteur] { height: var(--bs-hauteur); }
    .bs-panel--leaving {
      animation: bs-slide-down 220ms cubic-bezier(0.4, 0, 1, 1) both;
    }

    .bs-handle-wrap {
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      width: 100%; height: 28px;
      background: transparent; border: none;
      cursor: grab; touch-action: none;
    }
    .bs-handle-wrap:active { cursor: grabbing }
    .bs-handle {
      display: block;
      width: var(--feuille-poignee-l); height: var(--feuille-poignee-h);
      border-radius: 9999px;
      background: var(--fg-tertiary);
      opacity: 0.45;
      transition: opacity .15s ease;
    }
    .bs-handle-wrap:hover .bs-handle,
    .bs-handle-wrap:focus-visible .bs-handle { opacity: 0.8 }

    .bs-content {
      flex: 1;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 0 16px 12px;
    }

    @keyframes bs-fade-in {
      from { opacity: 0 }
      to   { opacity: 1 }
    }
    @keyframes bs-fade-out {
      from { opacity: 1 }
      to   { opacity: 0 }
    }
    @keyframes bs-slide-up {
      from { transform: translateY(100%) }
      to   { transform: translateY(0) }
    }
    @keyframes bs-slide-down {
      from { transform: translateY(0) }
      to   { transform: translateY(100%) }
    }

    @media (prefers-reduced-motion: reduce) {
      .bs-backdrop, .bs-panel { animation-duration: 1ms !important }
    }
  `],
})
export class BottomSheetComponent {
  /** Etat ouvert/ferme. Bind two-way avec un signal parent. */
  @Input({ required: true }) set open(value: boolean) {
    if (value === this._isOpen()) return;
    this._isOpen.set(value);
    if (value) {
      this.leaving.set(false);
      this.dragOffset.set(0);
    } else {
      this.startLeaveAnimation();
    }
  }
  get open(): boolean { return this._isOpen(); }

  /** Texte aria-label du dialog (utile pour les screen readers). */
  @Input() ariaLabel?: string;

  /**
   * Hauteur annoncée, en pourcentage de la fenêtre (50, 62, 72, 56, 58, 44 dans les
   * six feuilles de la maquette). Non renseignée, la feuille prend la hauteur de son
   * contenu — ce qui la fait sauter d'un écran à l'autre.
   */
  @Input() hauteur?: number;

  /**
   * Retire le voile. À réserver aux feuilles posées sur une CARTE : « le toast est en
   * haut et la feuille en bas, les deux surfaces ne se disputent jamais la même zone.
   * Le voile est absent — la carte reste lisible et manipulable derrière. » Partout
   * ailleurs le voile reste : il dit qu'on est dans une tâche modale.
   */
  @Input() sansVoile = false;

  /** `dvh` et non `vh` : sur mobile, la barre d'URL fait mentir `vh` de sa propre hauteur. */
  protected hauteurCss(): string | null {
    return this.hauteur ? `${this.hauteur}dvh` : null;
  }

  /** Emis quand l'utilisateur ferme la sheet (tap backdrop, drag-down, ESC). */
  @Output() closed = new EventEmitter<void>();

  protected readonly panelRef = viewChild<ElementRef<HTMLDivElement>>('panel');

  private readonly _isOpen = signal(false);
  protected readonly leaving = signal(false);
  /** Pendant un drag down, deplacement vertical du panneau (px). 0 = ferme. */
  protected readonly dragOffset = signal(0);

  /** Affiche le DOM uniquement si on est ouvert ou en train de fermer (animation). */
  protected readonly visible = computed(() => this._isOpen() || this.leaving());

  /** Transform calcule du panneau (drag en cours = decalage vertical). */
  protected readonly panelTransform = computed(() => {
    const offset = this.dragOffset();
    return offset > 0 ? `translateY(${offset}px)` : '';
  });

  private dragStartY = 0;
  private dragging = false;

  // Bloquer le scroll body quand ouvert (evite que la page derriere scroll
  // sous le sheet sur iOS Safari).
  private bodyLockEffect = effect(() => {
    if (typeof document === 'undefined') return;
    if (this.visible()) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
  });

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this._isOpen()) this.dismiss();
  }

  protected dismiss(): void {
    if (!this._isOpen()) return;
    this.startLeaveAnimation();
    this.closed.emit();
  }

  private startLeaveAnimation(): void {
    this._isOpen.set(false);
    this.leaving.set(true);
    setTimeout(() => this.leaving.set(false), 220);
  }

  protected onTouchStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    this.dragStartY = e.touches[0]!.clientY;
    this.dragging = true;
    this.dragOffset.set(0);
  }

  protected onTouchMove(e: TouchEvent): void {
    if (!this.dragging || e.touches.length !== 1) return;
    const dy = e.touches[0]!.clientY - this.dragStartY;
    // Drag uniquement vers le bas (positif) ; resistance progressive au-dessus.
    if (dy > 0) {
      this.dragOffset.set(dy);
      // Empeche le scroll vertical de la page pendant le drag
      e.preventDefault();
    } else {
      this.dragOffset.set(0);
    }
  }

  protected onTouchEnd(): void {
    if (!this.dragging) return;
    this.dragging = false;
    const offset = this.dragOffset();
    const panelHeight = this.panelRef()?.nativeElement.offsetHeight ?? 400;
    // Si l'utilisateur a drag plus de 25% de la hauteur du panneau → ferme.
    // Sinon → revient en place avec animation CSS sur transform (prochaine
    // frame, on remet a 0 avec une transition eclair).
    if (offset > panelHeight * 0.25) {
      this.dismiss();
    } else {
      // Smoothly back to position
      this.dragOffset.set(0);
    }
  }
}
