import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { BadgeEuro, Building2, Gift, LoaderCircle, LucideAngularModule, Save, Sparkles } from 'lucide-angular';
import {
  SubscriptionsAdminApiService,
  type PricingGridDto,
  type SubscriptionRowDto,
  type TrackyFormule,
  type TrackyPlan,
} from '../../core/services/subscriptions-admin.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/** État d'édition d'une ligne (copie locale ; « non attribué » → défauts PRO/Sérénité). */
interface RowEdit {
  plan: TrackyPlan;
  formule: TrackyFormule;
  optLive: boolean;
  optMicro: boolean;
  optAgent: boolean;
  retentionKey: string;
  isComp: boolean;
  customPriceEurYear: number | null;
  notes: string;
  assigned: boolean;
}

/**
 * D4 + Phase 3 — « Abonnements & tarifs » (SUPER_ADMIN).
 * Onglet 1 : abonnements clients — plan/formule/options par flotte, cas spéciaux (COMP, prix
 * négocié, notes), revenu estimé. SIGNATURE affiche les options « incluses ».
 * Onglet 2 : grille tarifaire publique — éditée ici, propagée à la LP sans redéploiement (≤ 5 min).
 */
@Component({
  selector: 'app-admin-subscriptions',
  standalone: true,
  imports: [FormsModule, DatePipe, DecimalPipe, LucideAngularModule],
  template: `
    <div class="sb">
      <header class="sb-head">
        <div>
          <h1 class="sb-title"><lucide-icon [img]="BadgeEuro" [size]="22" /> Abonnements &amp; tarifs</h1>
          <p class="sb-sub">Plan, formule et options de chaque client · grille tarifaire publique (LP)</p>
        </div>
        <div class="sb-tabs">
          <button [class.on]="tab() === 'subs'" (click)="tab.set('subs')">Abonnements clients</button>
          <button [class.on]="tab() === 'grid'" (click)="tab.set('grid')">Grille tarifaire</button>
        </div>
      </header>

      @if (loading()) {
        <div class="sb-load"><lucide-icon [img]="LoaderCircle" [size]="24" class="spin" /></div>
      } @else if (tab() === 'subs') {
        <div class="sb-total">
          Revenu annuel estimé (abonnements attribués) :
          <strong>{{ totalRevenueYear() | number : '1.0-0' : 'fr' }} € HT/an</strong>
        </div>
        @for (r of rows(); track r.fleetId) {
          <div class="sb-row" [class.sb-row--off]="!edits[r.fleetId].assigned">
            <div class="sb-fleet">
              <lucide-icon [img]="Building2" [size]="16" class="sb-fleet-ic" />
              <div>
                <div class="sb-fleet-name">{{ r.fleetName }}</div>
                <div class="sb-fleet-meta">{{ r.vehicles }} véhicule{{ r.vehicles > 1 ? 's' : '' }}
                  @if (r.subscription) { · {{ r.subscription.pricePerVehYear }} €/véh/an → <strong>{{ r.subscription.revenueYear | number : '1.0-0' : 'fr' }} €/an</strong> }
                  @else { · <em>non attribué</em> }
                </div>
              </div>
              @if (edits[r.fleetId].isComp) { <span class="sb-comp"><lucide-icon [img]="Gift" [size]="12" /> Offert</span> }
            </div>

            @if (edits[r.fleetId].assigned) {
              <div class="sb-controls">
                <label>Plan
                  <select [(ngModel)]="edits[r.fleetId].plan">
                    <option value="LITE">Lite</option><option value="PRO">Pro</option><option value="SIGNATURE">Signature</option>
                  </select>
                </label>
                <label>Formule
                  <select [(ngModel)]="edits[r.fleetId].formule">
                    <option value="SERENITE">Sérénité (36 mois)</option><option value="LIBERTE">Liberté (sans eng.)</option>
                  </select>
                </label>
                @if (edits[r.fleetId].plan === 'SIGNATURE') {
                  <span class="sb-incl"><lucide-icon [img]="Sparkles" [size]="13" /> Toutes options incluses · rétention 3 ans</span>
                } @else {
                  <label class="sb-check"><input type="checkbox" [(ngModel)]="edits[r.fleetId].optLive" /> Live 20 s</label>
                  <label class="sb-check"><input type="checkbox" [(ngModel)]="edits[r.fleetId].optMicro" /> Micro</label>
                  <label class="sb-check"><input type="checkbox" [(ngModel)]="edits[r.fleetId].optAgent" /> Assistant IA</label>
                  <label>Rétention
                    <select [(ngModel)]="edits[r.fleetId].retentionKey">
                      <option value="90j">90 j</option><option value="1an">1 an</option><option value="2ans">2 ans</option><option value="3ans">3 ans</option>
                    </select>
                  </label>
                }
                <label class="sb-check sb-check--amber"><input type="checkbox" [(ngModel)]="edits[r.fleetId].isComp" /> Offert (comp)</label>
                <label>Prix négocié €/véh/an
                  <input type="number" min="0" [(ngModel)]="edits[r.fleetId].customPriceEurYear" placeholder="grille" />
                </label>
                <label class="sb-notes">Notes
                  <input type="text" maxlength="1000" [(ngModel)]="edits[r.fleetId].notes" placeholder="ex. accord spécial signé le…" />
                </label>
                <button class="sb-save" (click)="save(r)" [disabled]="savingId() === r.fleetId">
                  <lucide-icon [img]="Save" [size]="14" /> {{ savingId() === r.fleetId ? '…' : 'Enregistrer' }}
                </button>
              </div>
            } @else {
              <button class="sb-assign" (click)="edits[r.fleetId].assigned = true">Attribuer un abonnement</button>
            }
          </div>
        }
      } @else if (grid(); as g) {
        <div class="sb-grid-note">Modifiée ici → la LP affiche les nouveaux prix automatiquement (≤ 5 min), sans redéploiement.
          @if (gridUpdatedAt()) { <span> · Dernière modification : {{ gridUpdatedAt() | date : 'dd/MM/yyyy HH:mm' }}</span> }
        </div>
        <div class="sb-gcards">
          @for (p of planKeys; track p) {
            <div class="sb-gcard">
              <div class="sb-gcard-t">{{ g.plans[p].name }}</div>
              <label>Sérénité €/véh/an <input type="number" min="1" [(ngModel)]="g.plans[p].serenite" /></label>
              <label>Liberté €/véh/an <input type="number" min="1" [(ngModel)]="g.plans[p].liberte" /></label>
            </div>
          }
          <div class="sb-gcard">
            <div class="sb-gcard-t">Options (€/véh/an)</div>
            <label>Live 20 s <input type="number" min="1" [(ngModel)]="g.addons.live.perVehYear" /></label>
            <label>Micro <input type="number" min="1" [(ngModel)]="g.addons.micro.perVehYear" /></label>
            <label>Assistant IA <input type="number" min="1" [(ngModel)]="g.addons.agent.perVehYear" /></label>
          </div>
          <div class="sb-gcard">
            <div class="sb-gcard-t">Rétention (€/véh/an)</div>
            @for (rt of g.addons.retention; track rt.key) {
              @if (!rt.included) { <label>{{ rt.label }} <input type="number" min="0" [(ngModel)]="rt.perVehYear" /></label> }
            }
          </div>
        </div>
        <button class="sb-save sb-save--big" (click)="saveGrid()" [disabled]="savingGrid()">
          <lucide-icon [img]="Save" [size]="15" /> {{ savingGrid() ? 'Enregistrement…' : 'Enregistrer la grille (propagée à la LP)' }}
        </button>
      }
    </div>
  `,
  styles: [`
    .sb { max-width: 1080px; margin: 0 auto; padding: 20px 16px 60px; color: var(--fg-primary, #EAEFED); }
    .sb-head { display:flex; flex-wrap:wrap; gap:14px; align-items:flex-end; justify-content:space-between; margin-bottom:18px; }
    /* Convention du kit (styles.css) : un libelle prend un jeton --texte-*, jamais
       la couleur de marque — le vert plein rendait 3,43:1 en theme clair. */
    .sb-title { display:flex; align-items:center; gap:9px; font-size:20px; font-weight:800; margin:0; color:var(--texte-succes); }
    .sb-title lucide-icon { color: var(--tracky,#10E0A0); }
    .sb-sub { margin:4px 0 0; font-size:12.5px; color:var(--fg-tertiary,#9BA5A1); }
    .sb-tabs { display:flex; gap:6px; background:var(--bg-secondary,#101514); border:1px solid var(--border-subtle,rgba(255,255,255,.1)); border-radius:11px; padding:4px; }
    .sb-tabs button { padding:8px 14px; border-radius:8px; border:none; background:transparent; color:var(--fg-tertiary,#9BA5A1); font-size:13px; font-weight:600; cursor:pointer; }
    .sb-tabs button.on { background:var(--tracky,#10E0A0); color:#04130D; }
    .sb-load { display:flex; justify-content:center; padding:60px; color:var(--tracky,#10E0A0); }
    .spin { animation:sb-spin 1s linear infinite; } @keyframes sb-spin { to { transform:rotate(360deg); } }
    .sb-total { padding:11px 14px; border-radius:11px; background:var(--bg-secondary,#101514); border:1px solid var(--border-subtle,rgba(255,255,255,.08)); font-size:13px; color:var(--fg-secondary,#C7CFCB); margin-bottom:14px; }
    .sb-total strong { color:var(--texte-succes); }
    .sb-row { border:1px solid var(--border-subtle,rgba(255,255,255,.08)); border-radius:13px; background:var(--bg-secondary,#101514); padding:13px 15px; margin-bottom:10px; }
    .sb-row--off { opacity:.85; }
    .sb-fleet { display:flex; align-items:center; gap:9px; margin-bottom:8px; }
    .sb-fleet-ic { color:var(--fg-tertiary,#69736E); }
    .sb-fleet-name { font-weight:700; font-size:14.5px; }
    .sb-fleet-meta { font-size:12px; color:var(--fg-tertiary,#9BA5A1); }
    .sb-fleet-meta strong { color:var(--texte-succes); }
    .sb-comp { display:inline-flex; align-items:center; gap:4px; margin-left:auto; font-size:11px; font-weight:700; color:var(--texte-attente); border:1px solid color-mix(in srgb, var(--warning) 35%, transparent); border-radius:7px; padding:3px 8px; }
    .sb-controls { display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; }
    .sb-controls label { display:flex; flex-direction:column; gap:4px; font-size:11px; color:var(--fg-tertiary,#9BA5A1); font-weight:600; }
    .sb-controls select, .sb-controls input[type=number], .sb-controls input[type=text] { background:var(--bg-tertiary,#161D1B); border:1px solid var(--border-subtle,rgba(255,255,255,.14)); border-radius:9px; color:var(--fg-primary,#EAEFED); padding:8px 9px; font-size:13px; min-width:110px; }
    .sb-controls input[type=number] { width:120px; }
    .sb-notes { flex:1 1 180px; } .sb-notes input { width:100%; }
    .sb-check { flex-direction:row !important; align-items:center; gap:6px !important; font-size:12.5px !important; color:var(--fg-secondary,#C7CFCB) !important; padding-bottom:9px; }
    .sb-check input { width:16px; height:16px; accent-color:var(--tracky,#10E0A0); }
    .sb-check--amber input { accent-color:#F5B33D; }
    .sb-incl { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--texte-succes); padding-bottom:9px; }
    .sb-save { display:inline-flex; align-items:center; gap:6px; padding:9px 14px; border-radius:10px; border:none; background:var(--tracky,#10E0A0); color:#04130D; font-size:13px; font-weight:700; cursor:pointer; }
    .sb-save:disabled { opacity:.6; }
    .sb-save--big { margin-top:14px; padding:12px 18px; }
    .sb-assign { padding:9px 14px; border-radius:10px; border:1px solid var(--border-subtle,rgba(255,255,255,.16)); background:transparent; color:var(--fg-secondary,#C7CFCB); font-size:13px; font-weight:600; cursor:pointer; }
    .sb-grid-note { padding:11px 14px; border-radius:11px; background:rgba(16,224,160,.06); border:1px solid rgba(16,224,160,.25); font-size:12.5px; color:var(--fg-secondary,#C7CFCB); margin-bottom:14px; }
    .sb-gcards { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; }
    .sb-gcard { border:1px solid var(--border-subtle,rgba(255,255,255,.08)); border-radius:13px; background:var(--bg-secondary,#101514); padding:14px; display:flex; flex-direction:column; gap:9px; }
    .sb-gcard-t { font-weight:700; font-size:13.5px; color:var(--texte-succes); }
    .sb-gcard label { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; color:var(--fg-tertiary,#9BA5A1); }
    .sb-gcard input { width:90px; background:var(--bg-tertiary,#161D1B); border:1px solid var(--border-subtle,rgba(255,255,255,.14)); border-radius:8px; color:var(--fg-primary,#EAEFED); padding:7px 8px; font-size:13px; }
  `],
})
export class AdminSubscriptionsComponent implements OnInit {
  private readonly api = inject(SubscriptionsAdminApiService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly BadgeEuro = BadgeEuro; protected readonly Building2 = Building2; protected readonly Gift = Gift;
  protected readonly LoaderCircle = LoaderCircle; protected readonly Save = Save; protected readonly Sparkles = Sparkles;

  protected readonly loading = signal(true);
  protected readonly tab = signal<'subs' | 'grid'>('subs');
  protected readonly rows = signal<SubscriptionRowDto[]>([]);
  protected readonly totalRevenueYear = signal(0);
  protected readonly savingId = signal<string | null>(null);
  protected readonly grid = signal<PricingGridDto | null>(null);
  protected readonly gridUpdatedAt = signal<string | null>(null);
  protected readonly savingGrid = signal(false);
  protected readonly planKeys = ['lite', 'pro', 'signature'] as const;

  /** Copies locales éditables par flotte. */
  protected edits: Record<string, RowEdit> = {};

  ngOnInit(): void { this.load(); }

  private load(): void {
    this.api.list().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.rows.set(res.items);
        this.totalRevenueYear.set(res.totalRevenueYear);
        for (const r of res.items) {
          const s = r.subscription;
          this.edits[r.fleetId] = s
            ? { plan: s.plan, formule: s.formule, optLive: s.optLive, optMicro: s.optMicro, optAgent: s.optAgent, retentionKey: s.retentionKey, isComp: s.isComp, customPriceEurYear: s.customPriceEurYear, notes: s.notes ?? '', assigned: true }
            : { plan: 'PRO', formule: 'SERENITE', optLive: false, optMicro: false, optAgent: false, retentionKey: '90j', isComp: false, customPriceEurYear: null, notes: '', assigned: false };
        }
        this.loading.set(false);
      },
      error: () => { this.toast.error('Chargement impossible', 'Réessayez.'); this.loading.set(false); },
    });
    this.api.getGrid().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => { this.grid.set(res.grid); this.gridUpdatedAt.set(res.updatedAt); },
      error: () => undefined,
    });
  }

  protected save(r: SubscriptionRowDto): void {
    const e = this.edits[r.fleetId];
    this.savingId.set(r.fleetId);
    this.api
      .upsert(r.fleetId, {
        plan: e.plan, formule: e.formule,
        optLive: e.optLive, optMicro: e.optMicro, optAgent: e.optAgent,
        retentionKey: e.retentionKey, isComp: e.isComp,
        customPriceEurYear: e.customPriceEurYear === null || (e.customPriceEurYear as unknown as string) === '' ? null : Number(e.customPriceEurYear),
        notes: e.notes || null,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.toast.success('Abonnement enregistré', r.fleetName); this.savingId.set(null); this.load(); },
        error: (err: unknown) => {
          const msg = (err as { error?: { message?: string } })?.error?.message;
          this.toast.error('Enregistrement impossible', typeof msg === 'string' ? msg : 'Réessayez.');
          this.savingId.set(null);
        },
      });
  }

  protected saveGrid(): void {
    const g = this.grid();
    if (!g) return;
    this.savingGrid.set(true);
    this.api.updateGrid(g).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.toast.success('Grille enregistrée', 'La LP affichera les nouveaux prix sous 5 min.'); this.savingGrid.set(false); },
      error: (err: unknown) => {
        const msg = (err as { error?: { message?: string } })?.error?.message;
        this.toast.error('Grille refusée', typeof msg === 'string' ? msg : 'Vérifiez les prix saisis.');
        this.savingGrid.set(false);
      },
    });
  }
}
