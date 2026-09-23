import { Component, DestroyRef, inject, input, OnInit, output, signal, ViewEncapsulation } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { Copy, LucideAngularModule, Printer, X } from 'lucide-angular';
import type { ReservationBookingLinkDto } from '@vizyo/tracky-shared';
import { swallow } from '../../core/error/swallow';
import { ReservationBookingApiService } from '../../core/services/reservation-booking.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { buildQrCardHtml, buildTrackyQrSvg, QR_CARD_CSS } from '../../shared/utils/tracky-qr.util';

/**
 * Le domaine LISIBLE de la carte, tiré du lien lui-même.
 *
 * Repli sur le domaine courant plutôt que sur une constante : une carte imprimée doit pouvoir être
 * retapée à la main, et une adresse fausse au pied d'un QR est pire que pas d'adresse du tout.
 */
export function domaineDe(url: string, courant?: string): string {
  try {
    return new URL(url).host;
  } catch {
    return courant ?? (typeof location !== 'undefined' ? location.host : '');
  }
}

/**
 * P0-1 (2026-09-23) — LE QR DU LIEN PUBLIC DE RÉSERVATION, propre à chaque société.
 *
 * ┌─ POURQUOI CE DIALOGUE EXISTE ─────────────────────────────────────────────┐
 * │ Le lien public existait (⚙️ Paramètres de l'agenda) et se copiait-collait  │
 * │ à la main. Le seul QR de l'application menait AILLEURS : au déverrouillage │
 * │ d'un véhicule précis. Le parcours voulu — « le conducteur scanne et        │
 * │ demande un véhicule » — n'avait donc pas de porte d'entrée imprimable.     │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * La carte est CELLE des véhicules (`buildQrCardHtml`), avec d'autres textes : même marque, même
 * format d'autocollant, une seule feuille de style à maintenir.
 *
 * ⚠️ Ce dialogue ne CRÉE jamais de lien. Créer ou désactiver reste un geste d'admin (le lien
 * ouvre un accès à des tiers) ; l'afficher et l'imprimer est le geste du standard. Sans lien
 * actif, on le DIT et on renvoie vers le bon écran plutôt que d'en fabriquer un dans le dos.
 */
@Component({
  selector: 'app-reservation-qr-dialog',
  standalone: true,
  encapsulation: ViewEncapsulation.None,
  imports: [LucideAngularModule],
  template: `
    <div class="rq-ov" (click)="close()">
      <div class="rq-modal" (click)="$event.stopPropagation()" role="dialog" aria-label="QR du lien de réservation">
        <button class="rq-close" (click)="close()" aria-label="Fermer"><lucide-icon [img]="X" [size]="18" /></button>

        @if (loading()) {
          <div class="rq-msg">Génération du QR…</div>
        } @else if (error(); as err) {
          <div class="rq-msg rq-msg--err">{{ err }}</div>
        } @else {
          <div class="rq-cardwrap" [innerHTML]="cardHtml()"></div>

          <p class="rq-usage">
            Le conducteur scanne pour <strong>demander un véhicule</strong>.
            Sa demande n'immobilise rien : elle attend votre validation.
          </p>

          @if (!active()) {
            <p class="rq-warn">
              Ce lien est <strong>désactivé</strong> : le QR s'ouvrira sur une page qui refuse les
              demandes. Réactivez-le dans « Paramètres de l'agenda » avant de l'imprimer.
            </p>
          }

          <div class="rq-actions">
            <button type="button" class="rq-btn rq-btn--go" (click)="printCard()">
              <lucide-icon [img]="Printer" [size]="16" /> Imprimer
            </button>
            <button type="button" class="rq-icon" (click)="copyLink()"
                    title="Copier le lien de réservation" aria-label="Copier le lien de réservation">
              <lucide-icon [img]="Copy" [size]="17" />
            </button>
          </div>

          <p class="rq-format">Format autocollant 60 × 90 mm — à afficher au dépôt ou dans chaque véhicule.</p>
        }
      </div>
    </div>
  `,
  styles: [QR_CARD_CSS, `
    /* Le voile et sa barre d'action suivent le VOILE, pas le thème : même raison et mêmes
       mesures de contraste que le dialogue QR des véhicules (.78 sur une encre presque noire). */
    .rq-ov { position:fixed; inset:0; z-index:9000; display:flex; justify-content:center; padding:calc(env(safe-area-inset-top,0px) + 26px) 16px calc(env(safe-area-inset-bottom,0px) + 26px); background:rgba(4,10,8,.78); overflow-y:auto; overscroll-behavior:contain; }
    .rq-modal { position:relative; width:100%; max-width:452px; margin:auto; }
    .rq-close { position:absolute; top:-12px; right:-12px; z-index:3; width:44px; height:44px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; background:#0C1512; color:#EAF0ED; border:1px solid rgba(255,255,255,.28); cursor:pointer; }
    .rq-cardwrap { display:flex; justify-content:center; }
    .rq-msg { padding:40px; text-align:center; color:#C2CCC8; background:#101514; border-radius:16px; line-height:1.55; }
    .rq-msg--err { color:#FCA5A5; }
    .rq-usage { margin:14px 0 0; font-size:13.5px; line-height:1.5; color:#DCE4E1; text-align:center; }
    .rq-usage strong { color:#FFFFFF; font-weight:700; }
    .rq-warn { margin:10px 0 0; padding:10px 12px; border-radius:11px; font-size:13px; line-height:1.5; color:#FDE7C8; background:rgba(245,179,61,.16); border:1px solid rgba(245,179,61,.4); }
    .rq-warn strong { color:#FFFFFF; }
    .rq-actions { display:flex; gap:10px; margin-top:12px; }
    .rq-btn { flex:1; display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:44px; padding:11px 14px; border-radius:12px; font-size:14px; font-weight:600; cursor:pointer; border:1px solid transparent; background:rgba(255,255,255,.06); color:#EAF0ED; }
    .rq-btn--go { background:#10E0A0; color:#04130D; border-color:#10E0A0; }
    .rq-icon { flex:none; width:44px; height:44px; display:inline-flex; align-items:center; justify-content:center; border-radius:12px; cursor:pointer; border:1px solid rgba(255,255,255,.22); background:rgba(255,255,255,.08); color:#EAF0ED; }
    .rq-icon:hover { background:rgba(255,255,255,.14); }
    .rq-format { margin:10px 0 0; font-size:12.5px; line-height:1.45; color:#C2CCC8; text-align:center; }
  `],
})
export class ReservationQrDialogComponent implements OnInit {
  /** Nom de la société, affiché sur la carte à la place de l'immatriculation. */
  readonly fleetName = input<string | null>(null);
  readonly closed = output<void>();

  private readonly api = inject(ReservationBookingApiService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly cardHtml = signal<SafeHtml | null>(null);
  /** Le lien retenu est-il actif ? Un QR imprimé sur un lien coupé est un QR mort. */
  protected readonly active = signal(true);
  private cardHtmlRaw = '';
  private url = '';

  protected readonly X = X;
  protected readonly Copy = Copy;
  protected readonly Printer = Printer;

  ngOnInit(): void {
    this.api
      .listLinks(this.fleetFilter.selectedFleetId() ?? undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (links) => this.rendre(links),
        error: (err) => {
          swallow('reservation-qr-dialog:listLinks', err);
          this.error.set('Impossible de lire le lien de réservation (permission ou réseau).');
          this.loading.set(false);
        },
      });
  }

  /**
   * Choisit le lien à imprimer et construit la carte.
   *
   * Un lien ACTIF l'emporte toujours sur un lien inactif, même plus récent : c'est celui qui
   * marchera une fois le QR collé sur un pare-brise. S'il n'y en a aucun, on le dit avec le geste
   * exact à faire — « aucun lien » sans la suite laisserait le standard chercher où le créer.
   */
  private rendre(links: ReservationBookingLinkDto[]): void {
    const lien = links.find((l) => l.active) ?? links[0];
    if (!lien) {
      this.error.set(
        "Aucun lien public de réservation pour cette société. Un administrateur peut le créer dans « Paramètres de l'agenda » (⚙️), puis ce QR sera disponible.",
      );
      this.loading.set(false);
      return;
    }
    this.url = lien.publicUrl;
    this.active.set(lien.active);
    let qrSvg: string;
    try {
      qrSvg = buildTrackyQrSvg(lien.publicUrl);
    } catch (e) {
      // Pas de repli serveur ici (ce endpoint ne rend pas de SVG) : on le dit plutôt que
      // d'afficher une carte sans code, qu'on imprimerait sans s'en apercevoir.
      swallow('reservation-qr-dialog:buildQr', e);
      this.error.set('Le code n’a pas pu être généré. Copiez le lien depuis « Paramètres de l’agenda ».');
      this.loading.set(false);
      return;
    }
    this.cardHtmlRaw = buildQrCardHtml({
      plate: this.fleetName() ?? lien.fleetName ?? 'Votre société',
      qrSvg,
      /**
       * ⚠️ LE DOMAINE IMPRIMÉ EST CELUI DU LIEN, jamais un défaut.
       *
       * Sans ça, la carte affichait `tracky.vizyoagency.com` — le défaut de `buildQrCardHtml`,
       * hérité de la carte de déverrouillage — alors que l'application est servie sur
       * `app-tracky.vizyoagency.com`. Le QR, lui, encode bien `publicUrl` : le scan marchait.
       * Mais un conducteur qui ne peut pas scanner et retape ce qu'il LIT tombait sur un 404,
       * et la carte est faite pour être imprimée et affichée au dépôt.
       */
      domain: domaineDe(lien.publicUrl),
      textes: {
        eyebrow: 'Réservation de véhicule',
        titre: 'Scannez pour demander un véhicule',
        champLabel: 'Société',
        note:
          "Ouvrez l'appareil photo de votre téléphone et cadrez le code pour <strong>demander un véhicule</strong>. " +
          'Décrivez votre besoin ; un gestionnaire valide, et vous recevez la confirmation.',
      },
    });
    this.cardHtml.set(this.sanitizer.bypassSecurityTrustHtml(this.cardHtmlRaw));
    this.loading.set(false);
  }

  protected close(): void {
    this.closed.emit();
  }

  protected async copyLink(): Promise<void> {
    if (!this.url) return;
    try {
      await navigator.clipboard.writeText(this.url);
      this.toast.success('Lien copié');
    } catch (e) {
      // Presse-papier indisponible (contexte non sécurisé) : on ne crie pas, le lien est à l'écran.
      swallow('reservation-qr-dialog:copyLink', e);
    }
  }

  /** Imprime la carte complète (une carte = une page), rendu identique à l'écran. */
  protected printCard(): void {
    if (!this.cardHtmlRaw) return;
    const w = window.open('', '_blank', 'width=520,height=780');
    if (!w) {
      this.toast.error('Impression bloquée', 'Autorisez les fenêtres pop-up pour imprimer.');
      return;
    }
    w.document.write(
      `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>QR réservation</title>` +
        `<style>${QR_CARD_CSS} body{margin:0;background:#fff;display:flex;justify-content:center;padding:16px;}</style></head><body>` +
        this.cardHtmlRaw +
        `<script>window.onload=function(){setTimeout(function(){window.print()},120)}<\/script></body></html>`,
    );
    w.document.close();
  }
}
