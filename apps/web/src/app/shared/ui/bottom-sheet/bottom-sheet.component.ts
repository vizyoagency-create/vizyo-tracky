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
        (click)="dismiss()"
        aria-hidden="true">
      </div>
      <div
        #panel
        class="bs-panel"
        [class.bs-panel--leaving]="leaving()"
        [style.transform]="panelTransform()"
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
    .bs-backdrop--leaving {
      animation: bs-fade-out 200ms cubic-bezier(0.4, 0, 1, 1) both;
    }

    .bs-panel {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 8001;
      max-height: 85vh;
      display: flex; flex-direction: column;
      background: var(--bg-secondary, #0F1714);
      border-top-left-radius: 20px;
      border-top-right-radius: 20px;
      box-shadow: 0 -12px 48px rgba(0, 0, 0, 0.5);
      padding-bottom: env(safe-area-inset-bottom);
      animation: bs-slide-up 280ms cubic-bezier(0.16, 1, 0.3, 1) both;
      will-change: transform;
      touch-action: pan-y;
    }
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
      width: 44px; height: 4px;
      border-radius: 9999px;
      background: var(--fg-tertiary, #64748b);
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
