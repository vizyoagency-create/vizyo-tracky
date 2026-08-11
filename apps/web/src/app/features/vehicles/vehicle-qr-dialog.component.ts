import { Component, DestroyRef, inject, input, OnInit, output, signal, ViewEncapsulation } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { Copy, Download, LucideAngularModule, Printer, X } from 'lucide-angular';
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

          <!-- À quoi sert ce code, et où le coller. Le dialogue affichait le code et
               deux boutons — sans jamais dire ni l'un ni l'autre. -->
          <p class="tq-usage">
            Le conducteur scanne pour <strong>déverrouiller le véhicule</strong>.
            La localisation vérifie qu'il est bien à côté.
          </p>

          <div class="tq-actions">
            <button type="button" class="tq-btn tq-btn--go" (click)="printCard()">
              <lucide-icon [img]="Printer" [size]="16" /> Imprimer
            </button>
            <button type="button" class="tq-icon" (click)="downloadQr()"
                    title="Télécharger le code au format PNG"
                    aria-label="Télécharger le code au format PNG">
              <lucide-icon [img]="Download" [size]="17" />
            </button>
            <button type="button" class="tq-icon" (click)="copyLink()"
                    title="Copier le lien de déverrouillage"
                    aria-label="Copier le lien de déverrouillage">
              <lucide-icon [img]="Copy" [size]="17" />
            </button>
          </div>

          <p class="tq-format">Format autocollant 60 × 90 mm, à coller côté conducteur.</p>
        }
      </div>
    </div>
  `,
  styles: [QR_CARD_CSS, `
    .tq-ov { position:fixed; inset:0; z-index:9000; display:flex; justify-content:center; padding:calc(env(safe-area-inset-top,0px) + 26px) 16px calc(env(safe-area-inset-bottom,0px) + 26px); background:rgba(4,10,8,.78); overflow-y:auto; overscroll-behavior:contain; }
    .tq-modal { position:relative; width:100%; max-width:452px; margin:auto; }
    /* 44 px : ce bouton mesurait 32 x 32, et il est la seule sortie visible.
       Il se decale hors de la carte pour ne pas mordre sur son coin arrondi. */
    .tq-close { position:absolute; top:-12px; right:-12px; z-index:3; width:44px; height:44px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; background:#0C1512; color:#EAF0ED; border:1px solid rgba(255,255,255,.28); cursor:pointer; }
    .tq-cardwrap { display:flex; justify-content:center; }
    .tq-msg { padding:40px; text-align:center; color:#C2CCC8; background:#101514; border-radius:16px; }
    .tq-msg--err { color:#FCA5A5; }
    /* Le voile est sombre dans LES DEUX themes — c'est un voile, pas une surface.
       Les couleurs de cette barre d'action ne suivent donc pas le theme : elles
       suivent le voile, et sont mesurees contre lui.
       A rgba(0,0,0,.6) sur une page CLAIRE, le voile donnait un gris moyen (#666)
       et non un fond sombre : la ligne de format y tombait a 3,56:1. Une opacite
       de .78 sur une encre presque noire donne le meme fond dans les deux
       themes — 7,12:1 pour le texte discret, 9,05 pour le texte courant. */
    .tq-usage { margin:14px 0 0; font-size:13.5px; line-height:1.5; color:#DCE4E1; text-align:center; }
    .tq-usage strong { color:#FFFFFF; font-weight:700; }
    .tq-actions { display:flex; gap:10px; margin-top:12px; }
    .tq-btn { flex:1; display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:44px; padding:11px 14px; border-radius:12px; font-size:14px; font-weight:600; cursor:pointer; border:1px solid transparent; background:rgba(255,255,255,.06); color:#EAF0ED; }
    /* Impression en action principale, telechargement et copie en icones : c'est ce
       qu'on fait de ce dialogue neuf fois sur dix. */
    .tq-btn--go { background:#10E0A0; color:#04130D; border-color:#10E0A0; }
    .tq-icon { flex:none; width:44px; height:44px; display:inline-flex; align-items:center; justify-content:center; border-radius:12px; cursor:pointer; border:1px solid rgba(255,255,255,.22); background:rgba(255,255,255,.08); color:#EAF0ED; }
    .tq-icon:hover { background:rgba(255,255,255,.14); }
    .tq-format { margin:10px 0 0; font-size:12.5px; line-height:1.45; color:#C2CCC8; text-align:center; }
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
  protected readonly Download = Download;
  protected readonly Printer = Printer;

  /** Le SVG du code seul — gardé pour le téléchargement, qui n'exporte que lui. */
  private qrSvgRaw = '';

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
          this.qrSvgRaw = qrSvg;
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

  /**
   * Télécharge le CODE seul, en PNG 1024 px.
   *
   * Le code, pas la carte : la carte est du HTML, la rasteriser demanderait une
   * bibliothèque tierce. Le libellé du bouton dit donc « le code », et l'impression
   * reste le chemin pour obtenir la carte entière.
   *
   * Le SVG porte `width="100%"` : sans dimensions intrinsèques, le navigateur le
   * dessinerait à sa taille par défaut. On les impose avant de le charger.
   */
  protected async downloadQr(): Promise<void> {
    if (!this.qrSvgRaw) return;
    const TAILLE = 1024;
    let objet: string | null = null;
    try {
      const doc = new DOMParser().parseFromString(this.qrSvgRaw, 'image/svg+xml');
      const racine = doc.documentElement;
      if (racine.nodeName !== 'svg') throw new Error('svg illisible');
      racine.setAttribute('width', String(TAILLE));
      racine.setAttribute('height', String(TAILLE));
      const source = new XMLSerializer().serializeToString(racine);

      objet = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
      const image = new Image();
      await new Promise<void>((ok, ko) => {
        image.onload = () => ok();
        image.onerror = () => ko(new Error('rendu impossible'));
        image.src = objet as string;
      });

      const toile = document.createElement('canvas');
      toile.width = toile.height = TAILLE;
      const ctx = toile.getContext('2d');
      if (!ctx) throw new Error('canvas indisponible');
      // Fond blanc explicite : un PNG transparent devient illisible sur fond sombre.
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, TAILLE, TAILLE);
      ctx.drawImage(image, 0, 0, TAILLE, TAILLE);

      const png = await new Promise<Blob | null>((ok) => toile.toBlob(ok, 'image/png'));
      if (!png) throw new Error('encodage impossible');
      const lien = document.createElement('a');
      lien.href = URL.createObjectURL(png);
      lien.download = `qr-${(this.plate() ?? 'vehicule').replace(/[^\w-]/g, '')}.png`;
      lien.click();
      // Libérer l'URL dans la foulée du clic peut couper le téléchargement avant
      // qu'il ne démarre : le navigateur lit le blob de façon asynchrone. Relevé
      // en testant réellement le bouton — le PNG était introuvable à la lecture.
      setTimeout(() => URL.revokeObjectURL(lien.href), 30_000);
      this.toast.success('Code téléchargé', 'PNG 1024 px, fond blanc.');
    } catch {
      this.toast.error('Téléchargement impossible', 'Utilisez « Imprimer » pour obtenir la carte.');
    } finally {
      if (objet) URL.revokeObjectURL(objet);
    }
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
