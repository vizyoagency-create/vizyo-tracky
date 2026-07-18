import { Component, DestroyRef, inject, input, OnInit, output, signal, ViewEncapsulation } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { Copy, LucideAngularModule, Printer, X } from 'lucide-angular';
import { VehiclesApiService, type VehicleUnlockQrDto } from '../../core/services/vehicles.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { buildQrCardHtml, buildTrackyQrSvg, QR_CARD_CSS } from '../../shared/utils/tracky-qr.util';

/**
 * feat/comptes-conducteurs (4a) — modale QR de déverrouillage d'UN véhicule (carte premium Tracky).
 * Réutilisée depuis la liste véhicules ET la fiche véhicule. Le QR est régénéré CÔTÉ CLIENT à partir
 * du lien signé serveur (`dto.url`) — modules émeraude + badge logo central, correction `H` — avec
 * repli sur le SVG serveur (`dto.svg`) si la génération échoue. L'impression rend la carte complète.
 */
@Component({
  selector: 'app-vehicle-qr-dialog',
  standalone: true,
  encapsulation: ViewEncapsulation.None,
  imports: [LucideAngularModule],
  template: `
    <div class="tq-ov" (click)="close()">
      <div class="tq-modal" (click)="$event.stopPropagation()">
        <button class="tq-close" (click)="close()" aria-label="Fermer"><lucide-icon [img]="X" [size]="18" /></button>

        @if (loading()) {
          <div class="tq-msg">Génération du QR…</div>
        } @else if (error()) {
          <div class="tq-msg tq-msg--err">{{ error() }}</div>
        } @else {
          <div class="tq-cardwrap" [innerHTML]="cardHtml()"></div>
          <div class="tq-actions">
            <button type="button" class="tq-btn" (click)="copyLink()">
              <lucide-icon [img]="Copy" [size]="14" /> Copier le lien
            </button>
            <button type="button" class="tq-btn tq-btn--go" (click)="printCard()">
              <lucide-icon [img]="Printer" [size]="14" /> Imprimer
            </button>
          </div>
        }
      </div>
    </div>
  `,
  styles: [QR_CARD_CSS, `
    .tq-ov { position:fixed; inset:0; z-index:9000; display:flex; align-items:center; justify-content:center; padding:16px; background:rgba(0,0,0,.6); overflow:auto; }
    .tq-modal { position:relative; width:100%; max-width:452px; }
    .tq-close { position:absolute; top:-6px; right:-6px; z-index:3; width:32px; height:32px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; background:#0C1512; color:#EAF0ED; border:1px solid rgba(255,255,255,.2); cursor:pointer; }
    .tq-cardwrap { display:flex; justify-content:center; }
    .tq-msg { padding:40px; text-align:center; color:var(--fg-tertiary,#9BA5A1); background:var(--bg-secondary,#101514); border-radius:16px; }
    .tq-msg--err { color:#f87171; }
    .tq-actions { display:flex; gap:10px; margin-top:14px; }
    .tq-btn { flex:1; display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:11px; border-radius:12px; font-size:13px; font-weight:600; cursor:pointer; border:1px solid rgba(255,255,255,.16); background:rgba(255,255,255,.06); color:#EAF0ED; }
    .tq-btn--go { background:#10E0A0; color:#04130D; border-color:#10E0A0; }
  `],
})
export class VehicleQrDialogComponent implements OnInit {
  readonly vehicleId = input.required<string>();
  readonly plate = input<string | null>(null);
  /** Optionnel — affiché en 2ᵉ colonne « Véhicule » (masqué si absent). */
  readonly model = input<string | null>(null);
  readonly closed = output<void>();

  private readonly api = inject(VehiclesApiService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly cardHtml = signal<SafeHtml | null>(null);
  private data: VehicleUnlockQrDto | null = null;
  private cardHtmlRaw = '';

  protected readonly X = X;
  protected readonly Copy = Copy;
  protected readonly Printer = Printer;

  ngOnInit(): void {
    this.api
      .getUnlockQr(this.vehicleId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (dto) => {
          this.data = dto;
          // QR régénéré client-side (même URL signée) → modules émeraude + badge. Repli serveur si KO.
          let qrSvg: string;
          try {
            qrSvg = buildTrackyQrSvg(dto.url);
          } catch {
            qrSvg = dto.svg;
          }
          this.cardHtmlRaw = buildQrCardHtml({ plate: this.plate() ?? dto.plate ?? '', model: this.model(), qrSvg });
          this.cardHtml.set(this.sanitizer.bypassSecurityTrustHtml(this.cardHtmlRaw));
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Impossible de générer le QR (permission ou réseau).');
          this.loading.set(false);
        },
      });
  }

  protected close(): void {
    this.closed.emit();
  }

  protected copyLink(): void {
    if (!this.data) return;
    navigator.clipboard?.writeText(this.data.url).then(
      () => this.toast.success('Lien copié', 'Le lien de déverrouillage est dans le presse-papier.'),
      () => this.toast.error('Copie impossible', 'Copiez le lien manuellement.'),
    );
  }

  /** Imprime la CARTE complète (une carte = une page), rendu identique à l'écran. */
  protected printCard(): void {
    if (!this.cardHtmlRaw) return;
    const w = window.open('', '_blank', 'width=520,height=780');
    if (!w) {
      this.toast.error('Impression bloquée', 'Autorisez les fenêtres pop-up pour imprimer.');
      return;
    }
    w.document.write(
      `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>QR ${(this.plate() ?? '').replace(/[<>"]/g, '')}</title>` +
        `<style>${QR_CARD_CSS} body{margin:0;background:#fff;display:flex;justify-content:center;padding:16px;}</style></head><body>` +
        this.cardHtmlRaw +
        `<script>window.onload=function(){setTimeout(function(){window.print()},120)}<\/script></body></html>`,
    );
    w.document.close();
  }
}
