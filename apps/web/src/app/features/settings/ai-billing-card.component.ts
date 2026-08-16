import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, OnInit, signal, viewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { DatePipe, TitleCasePipe } from '@angular/common';
import { LucideAngularModule, Sparkles, CreditCard, Check, Loader, AlertTriangle, FileText, Gift, X } from 'lucide-angular';
import { loadStripe, type Stripe, type StripeCardElement } from '@stripe/stripe-js';
import { firstValueFrom } from 'rxjs';
import type { BillingStatusDto } from '@vizyo/tracky-shared';
import { BillingApiService } from '../../core/services/billing.service';
import { AiStatusService } from '../../core/services/ai-status.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * Carte « Option IA » de l'onglet Facturation. Un fleet-admin y voit le COÛT (par mois + par voiture),
 * ajoute une carte (Stripe), ACTIVE l'IA (abonnement mensuel) ou demande une FACTURE PHYSIQUE, et
 * peut ANNULER. Si l'IA est OFFERTE par Vizyo (COMP) ou si Stripe n'est pas configuré, l'UI s'adapte.
 * `fleetId` optionnel = super-admin ciblant une société ; sinon la société de l'utilisateur.
 */
@Component({
  selector: 'app-ai-billing-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, TitleCasePipe, LucideAngularModule],
  template: `
    <section class="abc">
      <div class="abc-head">
        <div class="abc-ico"><lucide-icon [img]="SparklesIcon" [size]="20"></lucide-icon></div>
        <div>
          <h3 class="abc-title">Assistance IA</h3>
          <p class="abc-sub">Récits de trajet, agent d'agenda, optimiseur, saisie vocale. L'analyse déterministe (trajets, stations, scores) reste incluse et gratuite.</p>
        </div>
        @if (s(); as st) { <span class="abc-badge" [attr.data-st]="st.status">{{ badge(st.status) }}</span> }
      </div>

      @if (loading()) {
        <div class="abc-skel"></div>
      } @else if (s(); as st) {
        <!-- Coût -->
        <div class="abc-price">
          <div class="abc-price-main">{{ eur(st.monthlyEurCents) }}<span class="abc-price-per">/ mois</span></div>
          <div class="abc-price-detail">
            {{ eur(st.perVehicleEurCents) }} / véhicule · {{ st.vehicleCount }} véhicule{{ st.vehicleCount > 1 ? 's' : '' }}
            @if (st.pricingUnit === 'per_vehicle') { <span class="abc-dim">(facturé à l'usage du parc)</span> }
          </div>
        </div>

        @if (!st.configured && st.status !== 'COMP') {
          <div class="abc-note"><lucide-icon [img]="AlertIcon" [size]="14"></lucide-icon> La facturation en ligne n'est pas encore disponible. Pour activer l'IA, écrivez à <a href="mailto:contact@vizyoagency.com">contact&#64;vizyoagency.com</a>.</div>
        } @else if (st.status === 'COMP') {
          <div class="abc-note abc-note--ok"><lucide-icon [img]="GiftIcon" [size]="14"></lucide-icon> Option IA <strong>offerte</strong> par Vizyo — active, sans facturation.</div>
        } @else if (st.status === 'INVOICE_PENDING') {
          <div class="abc-note"><lucide-icon [img]="FileIcon" [size]="14"></lucide-icon> Demande de <strong>facture physique</strong> enregistrée. Notre équipe (contact&#64;vizyoagency.com) vous recontacte pour l'activation.</div>
        } @else if (st.status === 'PAST_DUE') {
          <div class="abc-note abc-note--warn"><lucide-icon [img]="AlertIcon" [size]="14"></lucide-icon> Le dernier paiement a échoué. Mettez à jour votre carte pour rétablir l'IA.</div>
        } @else if (st.status === 'ACTIVE') {
          <div class="abc-note abc-note--ok"><lucide-icon [img]="CheckIcon" [size]="14"></lucide-icon> Abonnement <strong>actif</strong>@if (st.currentPeriodEnd) { · prochaine échéance {{ st.currentPeriodEnd | date:'dd/MM/yyyy' }} }@if (st.cancelAtPeriodEnd) { · <span class="abc-warn">annulation en fin de période</span> }.</div>
        }

        <!-- Carte enregistrée -->
        @if (st.configured && st.card; as c) {
          <div class="abc-card-line"><lucide-icon [img]="CardIcon" [size]="15"></lucide-icon> {{ c.brand | titlecase }} •••• {{ c.last4 }} · {{ pad(c.expMonth) }}/{{ c.expYear }}</div>
        }

        <!-- Zone d'ajout de carte (Stripe Card Element monté à la volée) -->
        @if (addingCard()) {
          <div class="abc-cardbox">
            <div #cardHost class="abc-stripe"></div>
            <div class="abc-cardbox-actions">
              <button type="button" class="abc-btn abc-btn--ghost" (click)="cancelAddCard()" [disabled]="busy()">Annuler</button>
              <button type="button" class="abc-btn abc-btn--primary" (click)="saveCard()" [disabled]="busy()">
                @if (busy()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="abc-spin"></lucide-icon> } Enregistrer la carte
              </button>
            </div>
          </div>
        }

        @if (st.canManage) {
          <div class="abc-actions">
            @if (st.status === 'ACTIVE' || st.status === 'PAST_DUE') {
              @if (!st.cancelAtPeriodEnd) {
                <button type="button" class="abc-btn abc-btn--ghost" (click)="cancel()" [disabled]="busy()">Annuler l'abonnement</button>
              }
              @if (!addingCard()) { <button type="button" class="abc-btn abc-btn--ghost" (click)="startAddCard()" [disabled]="busy() || !st.configured">Changer de carte</button> }
            } @else if (st.status !== 'COMP') {
              <!-- NONE / CANCELED / INVOICE_PENDING → activer -->
              @if (st.configured && !addingCard()) {
                @if (!st.card) {
                  <button type="button" class="abc-btn abc-btn--primary" (click)="startAddCard()" [disabled]="busy()"><lucide-icon [img]="CardIcon" [size]="15"></lucide-icon> Ajouter une carte</button>
                } @else {
                  <button type="button" class="abc-btn abc-btn--primary" (click)="subscribe()" [disabled]="busy()">
                    @if (busy()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="abc-spin"></lucide-icon> } Activer l'IA ({{ eur(st.monthlyEurCents) }}/mois)
                  </button>
                }
              }
              @if (st.status !== 'INVOICE_PENDING') {
                <button type="button" class="abc-btn abc-btn--ghost" (click)="requestInvoice()" [disabled]="busy()"><lucide-icon [img]="FileIcon" [size]="15"></lucide-icon> Payer par facture physique</button>
              }
            }
          </div>
        }
      } @else if (error()) {
        <div class="abc-note abc-note--warn"><lucide-icon [img]="AlertIcon" [size]="14"></lucide-icon> {{ error() }}</div>
      }
    </section>
  `,
  styles: [`
    .abc { display: flex; flex-direction: column; gap: 14px; padding: 18px; border-radius: 16px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .abc-head { display: flex; align-items: flex-start; gap: 12px; }
    .abc-ico { width: 42px; height: 42px; border-radius: 11px; display: flex; align-items: center; justify-content: center; background: rgba(16,224,160,.12); color: var(--tracky-light, #10E0A0); flex-shrink: 0; }
    .abc-title { font-size: 15px; font-weight: 800; color: var(--fg-primary); margin: 0; }
    .abc-sub { font-size: 12px; color: var(--fg-tertiary); margin: 3px 0 0; line-height: 1.45; }
    .abc-badge { margin-left: auto; font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 3px 9px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-tertiary); white-space: nowrap; height: fit-content; }
    .abc-badge[data-st="ACTIVE"], .abc-badge[data-st="COMP"] { background: rgba(16,224,160,.16); color: var(--tracky-light, #10E0A0); }
    .abc-badge[data-st="PAST_DUE"] { background: rgba(239,68,68,.16); color: #f87171; }
    .abc-badge[data-st="INVOICE_PENDING"] { background: rgba(245,158,11,.16); color: #fbbf24; }
    .abc-price { padding: 14px 16px; border-radius: 12px; background: var(--bg-tertiary); }
    .abc-price-main { font-family: var(--font-display); font-size: 26px; font-weight: 800; color: var(--fg-primary); }
    .abc-price-per { font-size: 14px; font-weight: 600; color: var(--fg-tertiary); margin-left: 4px; }
    .abc-price-detail { font-size: 12.5px; color: var(--fg-secondary); margin-top: 3px; }
    .abc-dim { color: var(--fg-tertiary); }
    .abc-note { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; line-height: 1.45; color: var(--fg-secondary); background: var(--bg-tertiary); border-radius: 10px; padding: 10px 12px; }
    .abc-note a { color: var(--tracky-light, #10E0A0); }
    .abc-note--ok { background: rgba(16,224,160,.08); }
    .abc-note--warn { background: rgba(239,68,68,.08); color: #f0b8b8; }
    .abc-warn { color: #fbbf24; }
    .abc-card-line { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--fg-secondary); }
    .abc-cardbox { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 12px; background: var(--bg-primary); border: 1px solid var(--border-subtle); }
    .abc-stripe { padding: 12px; border-radius: 9px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .abc-cardbox-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .abc-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .abc-btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 14px; border-radius: 10px; font-size: 13px; font-weight: 700; cursor: pointer; }
    .abc-btn--primary { background: var(--tracky, #10B981); color: #fff; }
    .abc-btn--ghost { background: var(--bg-tertiary); color: var(--fg-secondary); border: 1px solid var(--border-subtle); }
    .abc-btn:disabled { opacity: .55; cursor: not-allowed; }
    .abc-skel { height: 90px; border-radius: 12px; background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: abc-sh 1.3s infinite; }
    @keyframes abc-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .abc-spin { animation: abc-spin 1s linear infinite; }
    @keyframes abc-spin { to { transform: rotate(360deg); } }
  `],
})
export class AiBillingCardComponent implements OnInit {
  private readonly api = inject(BillingApiService);
  private readonly aiStatus = inject(AiStatusService);
  private readonly toast = inject(ToastService);

  readonly fleetId = input<string | undefined>(undefined);

  protected readonly SparklesIcon = Sparkles;
  protected readonly CardIcon = CreditCard;
  protected readonly CheckIcon = Check;
  protected readonly LoaderIcon = Loader;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly FileIcon = FileText;
  protected readonly GiftIcon = Gift;
  protected readonly XIcon = X;

  protected readonly s = signal<BillingStatusDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly addingCard = signal(false);
  protected readonly error = signal<string | null>(null);

  private stripe: Stripe | null = null;
  private cardElement: StripeCardElement | null = null;
  private cardClientSecret: string | null = null;
  private readonly cardHost = viewChild<ElementRef<HTMLDivElement>>('cardHost');

  ngOnInit(): void {
    void this.reload();
  }

  protected async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.s.set(await firstValueFrom(this.api.status(this.fleetId())));
    } catch (e) {
      swallow('ai-billing-card:reload', e);
      this.error.set(this.msg(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected eur(cents: number): string {
    return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
  }
  protected pad(n: number): string {
    return String(n).padStart(2, '0');
  }
  protected badge(st: string): string {
    return st === 'ACTIVE' ? 'Active' : st === 'COMP' ? 'Offerte' : st === 'PAST_DUE' ? 'Paiement en échec'
      : st === 'INVOICE_PENDING' ? 'Facture en attente' : st === 'CANCELED' ? 'Annulée' : 'Inactive';
  }

  // ── Ajout de carte (Stripe Card Element) ──────────────────────────────────────
  protected async startAddCard(): Promise<void> {
    const st = this.s();
    if (!st?.publishableKey) { this.toast.error('Facturation', 'Paiement non configuré.'); return; }
    this.addingCard.set(true);
    this.busy.set(true);
    try {
      const [intent, stripe] = await Promise.all([
        firstValueFrom(this.api.setupIntent(this.fleetId())),
        this.ensureStripe(st.publishableKey),
      ]);
      if (!stripe) throw new Error('Stripe indisponible.');
      const elements = stripe.elements();
      this.cardElement = elements.create('card', { hidePostalCode: true });
      const host = this.cardHost()?.nativeElement;
      if (!host) throw new Error('Zone carte introuvable.');
      this.cardElement.mount(host);
      this.cardClientSecret = intent.clientSecret;
    } catch (e) {
      swallow('ai-billing-card:startAddCard', e);
      this.addingCard.set(false);
      this.toast.error('Carte', this.msg(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async saveCard(): Promise<void> {
    if (!this.stripe || !this.cardElement) return;
    const clientSecret = this.cardClientSecret;
    if (!clientSecret) { this.toast.error('Carte', 'Session expirée, réessayez.'); return; }
    this.busy.set(true);
    try {
      const res = await this.stripe.confirmCardSetup(clientSecret, { payment_method: { card: this.cardElement } });
      if (res.error) throw new Error(res.error.message ?? 'Échec de l’enregistrement.');
      this.toast.success('Carte enregistrée', 'Vous pouvez activer l’IA.');
      this.cancelAddCard();
      await this.reload();
    } catch (e) {
      this.toast.error('Carte', this.msg(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected cancelAddCard(): void {
    this.cardElement?.destroy();
    this.cardElement = null;
    this.cardClientSecret = null;
    this.addingCard.set(false);
  }

  private async ensureStripe(pk: string): Promise<Stripe | null> {
    if (!this.stripe) this.stripe = await loadStripe(pk);
    return this.stripe;
  }

  // ── Abonnement / facture / annulation ─────────────────────────────────────────
  protected async subscribe(): Promise<void> {
    this.busy.set(true);
    try {
      const res = await firstValueFrom(this.api.subscribe(this.fleetId()));
      if (res.requiresAction && res.clientSecret && this.s()?.publishableKey) {
        const stripe = await this.ensureStripe(this.s()!.publishableKey!);
        const conf = await stripe?.confirmCardPayment(res.clientSecret);
        if (conf?.error) throw new Error(conf.error.message ?? 'Authentification refusée.');
      }
      this.aiStatus.refresh();
      this.toast.success('Assistance IA', 'Activée. Merci !');
      await this.reload();
    } catch (e) {
      swallow('ai-billing-card:subscribe', e);
      this.toast.error('Activation', this.msg(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async requestInvoice(): Promise<void> {
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.requestInvoice(this.fleetId()));
      this.toast.success('Facture physique', 'Demande envoyée — notre équipe vous recontacte.');
      await this.reload();
    } catch (e) {
      swallow('ai-billing-card:requestInvoice', e);
      this.toast.error('Facture', this.msg(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async cancel(): Promise<void> {
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.cancel(this.fleetId()));
      this.aiStatus.refresh();
      this.toast.success('Abonnement', 'Annulation prise en compte.');
      await this.reload();
    } catch (e) {
      swallow('ai-billing-card:cancel', e);
      this.toast.error('Annulation', this.msg(e));
    } finally {
      this.busy.set(false);
    }
  }

  private msg(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const m = (e.error as { message?: string } | null)?.message;
      if (m) return Array.isArray(m) ? m.join(', ') : m;
      return `Erreur (${e.status}).`;
    }
    return e instanceof Error ? e.message : 'Une erreur est survenue.';
  }
}
