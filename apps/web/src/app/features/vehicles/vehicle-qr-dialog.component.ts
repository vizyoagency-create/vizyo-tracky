import { Component, DestroyRef, inject, input, OnInit, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { Copy, LucideAngularModule, Printer, X } from 'lucide-angular';
import { VehiclesApiService, type VehicleUnlockQrDto } from '../../core/services/vehicles.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * feat/comptes-conducteurs (4a) — modale QR de déverrouillage d'UN véhicule.
 * Réutilisée depuis la liste véhicules ET la fiche véhicule. Récupère le QR (SVG signé
 * côté serveur), permet de copier le deep-link et d'imprimer une étiquette du véhicule.
 * Le QR encode un lien vers l'écran conducteur ; le déverrouillage réel (autorisation +
 * proximité) est traité à l'incrément 4b.
 */
@Component({
  selector: 'app-vehicle-qr-dialog',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    <div class="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4" (click)="close()">
      <div
        class="relative w-full max-w-sm rounded-2xl bg-bg-secondary border border-border-subtle p-5 text-fg-primary shadow-xl"
        (click)="$event.stopPropagation()"
      >
        <button (click)="close()" class="absolute right-3 top-3 text-fg-tertiary hover:text-fg-primary">
          <lucide-icon [img]="X" [size]="18" />
        </button>
        <h3 class="text-base font-semibold mb-1">QR de déverrouillage</h3>
        @if (plate()) {
          <div class="text-sm text-fg-secondary mb-3 font-medium">{{ plate() }}</div>
        }

        @if (loading()) {
          <div class="py-10 text-center text-sm text-fg-tertiary">Génération du QR…</div>
        } @else if (error()) {
          <div class="py-6 text-center text-sm text-red-400">{{ error() }}</div>
        } @else if (svg(); as s) {
          <div class="flex justify-center rounded-xl bg-white p-3" [innerHTML]="s"></div>
          <p class="text-xs text-fg-tertiary mt-3">
            Le conducteur autorisé scanne ce QR avec son téléphone (à proximité du véhicule) pour le déverrouiller.
          </p>
          <div class="flex gap-2 mt-4">
            <button
              (click)="copyLink()"
              class="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-bg-tertiary border border-border-subtle hover:opacity-80 transition"
            >
              <lucide-icon [img]="Copy" [size]="14" /> Copier le lien
            </button>
            <button
              (click)="print()"
              class="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-tracky/20 text-tracky-light border border-tracky/30 hover:bg-tracky/30 transition"
            >
              <lucide-icon [img]="Printer" [size]="14" /> Imprimer
            </button>
          </div>
        }
      </div>
    </div>
  `,
})
export class VehicleQrDialogComponent implements OnInit {
  readonly vehicleId = input.required<string>();
  readonly plate = input<string | null>(null);
  readonly closed = output<void>();

  private readonly api = inject(VehiclesApiService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly svg = signal<SafeHtml | null>(null);
  private data: VehicleUnlockQrDto | null = null;

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
          // SVG généré côté serveur à partir de nos données → trusted.
          this.svg.set(this.sanitizer.bypassSecurityTrustHtml(dto.svg));
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

  protected print(): void {
    if (!this.data) return;
    const w = window.open('', '_blank', 'width=420,height=580');
    if (!w) return;
    const plate = (this.plate() ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
    w.document.write(
      `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>QR ${plate}</title>` +
        `<style>body{font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:24px;color:#0b1220}` +
        `svg{width:280px;height:auto}.p{font-weight:700;font-size:20px;margin-top:12px;letter-spacing:.5px}` +
        `.h{color:#64748b;font-size:12px;margin-top:6px}</style></head><body>` +
        `${this.data.svg}<div class="p">${plate}</div><div class="h">Scannez pour déverrouiller</div>` +
        `<script>window.onload=function(){window.print()}</script></body></html>`,
    );
    w.document.close();
  }
}
