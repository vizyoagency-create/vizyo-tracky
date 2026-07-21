import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { AlertTriangle, CheckCircle2, LoaderCircle, LucideAngularModule, ShieldCheck, ShieldOff } from 'lucide-angular';
import { WorkScheduleApiService, type PrivacyCoverageRow } from '../../core/services/work-schedule.service';

/**
 * Lot 2 — « Couverture vie privée » : quels véhicules sont réellement protégés hors temps de
 * travail, et surtout lesquels ne le sont PAS. L'absence de protection doit être visible, jamais
 * silencieuse (exigence 21/07/2026).
 *
 * Trois états :
 * - PROTÉGÉ          : usage mixte déclaré ET cadre actif → hors plage, aucune position collectée ;
 * - MIXTE SANS CADRE : usage mixte déclaré mais aucun cadre actif → le véhicule serait privé en
 *                      permanence (à corriger : définir des horaires) ;
 * - NON COUVERT      : véhicule professionnel, tracé 24/7 — normal si le véhicule ne rentre pas
 *                      au domicile ; à activer sinon (l'antivol reste actif dans ce mode).
 *
 * Accès : permission `privacy_manage` (super/fleet-admin nativement ; accordable à un gestionnaire
 * ou un lecteur depuis la matrice d'accès).
 */
@Component({
  selector: 'app-privacy-coverage',
  standalone: true,
  imports: [LucideAngularModule, RouterLink],
  template: `
    <div class="pc">
      <header class="pc-head">
        <div>
          <h1 class="pc-title"><lucide-icon [img]="ShieldCheck" [size]="22" /> Couverture vie privée</h1>
          <p class="pc-sub">Quels véhicules cessent d'être suivis hors du temps de travail — et lesquels sont suivis en permanence.</p>
        </div>
      </header>

      @if (loading()) {
        <div class="pc-load"><lucide-icon [img]="LoaderCircle" [size]="24" class="spin" /></div>
      } @else {
        <div class="pc-kpis">
          <div class="pc-kpi pc-kpi--ok">
            <div class="pc-kpi-n">{{ protectedCount() }}</div>
            <div class="pc-kpi-l">protégé{{ protectedCount() > 1 ? 's' : '' }} hors travail</div>
          </div>
          <div class="pc-kpi" [class.pc-kpi--warn]="uncoveredCount() > 0">
            <div class="pc-kpi-n">{{ uncoveredCount() }}</div>
            <div class="pc-kpi-l">suivi{{ uncoveredCount() > 1 ? 's' : '' }} en permanence</div>
          </div>
          <div class="pc-kpi"><div class="pc-kpi-n">{{ total() }}</div><div class="pc-kpi-l">véhicules</div></div>
        </div>

        @if (uncoveredCount() > 0) {
          <div class="pc-note">
            <lucide-icon [img]="AlertTriangle" [size]="15" class="pc-note-ic" />
            <span>
              <strong>{{ uncoveredCount() }} véhicule{{ uncoveredCount() > 1 ? 's ne sont' : " n'est" }} pas couvert{{ uncoveredCount() > 1 ? 's' : '' }}.</strong>
              C'est normal pour un véhicule qui ne rentre pas au domicile (l'antivol reste actif 24/7).
              Pour un véhicule de service ramené chez le conducteur, activez l'usage mixte depuis sa fiche.
            </span>
          </div>
        }

        <div class="pc-rows">
          @for (r of rows(); track r.vehicleId) {
            <a class="pc-row" [routerLink]="['/vehicles', r.vehicleId]">
              <lucide-icon [img]="r.status === 'PROTEGE' ? CheckCircle2 : ShieldOff" [size]="17"
                           [class]="r.status === 'PROTEGE' ? 'pc-ic pc-ic--ok' : (r.status === 'MIXTE_SANS_CADRE' ? 'pc-ic pc-ic--warn' : 'pc-ic')" />
              <div class="pc-row-main">
                <div class="pc-plate">{{ r.plate }}</div>
                <div class="pc-meta">
                  {{ r.fleetName }}@if (r.driverName) { · {{ r.driverName }} }
                </div>
              </div>
              <span class="pc-badge" [class.pc-badge--ok]="r.status === 'PROTEGE'" [class.pc-badge--warn]="r.status === 'MIXTE_SANS_CADRE'">
                {{ label(r) }}
              </span>
            </a>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .pc { max-width: 940px; margin: 0 auto; padding: 20px 16px 60px; color: var(--fg-primary, #EAEFED); }
    .pc-head { margin-bottom: 18px; }
    .pc-title { display:flex; align-items:center; gap:9px; font-size:20px; font-weight:800; margin:0; color:var(--tracky-light,#3EEBB8); }
    .pc-title lucide-icon { color: var(--tracky,#10E0A0); }
    .pc-sub { margin:4px 0 0; font-size:12.5px; color:var(--fg-tertiary,#9BA5A1); }
    .pc-load { display:flex; justify-content:center; padding:60px; color:var(--tracky,#10E0A0); }
    .spin { animation:pc-spin 1s linear infinite; } @keyframes pc-spin { to { transform:rotate(360deg); } }
    .pc-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:14px; }
    .pc-kpi { border:1px solid var(--border-subtle,rgba(255,255,255,.08)); border-radius:13px; background:var(--bg-secondary,#101514); padding:14px; }
    .pc-kpi--ok { border-color:rgba(16,224,160,.35); }
    .pc-kpi--warn { border-color:rgba(245,179,61,.35); }
    .pc-kpi-n { font-size:26px; font-weight:800; letter-spacing:-.02em; }
    .pc-kpi--ok .pc-kpi-n { color:var(--tracky-light,#3EEBB8); }
    .pc-kpi--warn .pc-kpi-n { color:#F5B33D; }
    .pc-kpi-l { font-size:11.5px; color:var(--fg-tertiary,#9BA5A1); margin-top:2px; }
    .pc-note { display:flex; gap:9px; align-items:flex-start; padding:11px 14px; border-radius:11px; background:rgba(245,179,61,.07); border:1px solid rgba(245,179,61,.28); font-size:12.5px; line-height:1.55; color:var(--fg-secondary,#C7CFCB); margin-bottom:14px; }
    .pc-note-ic { color:#F5B33D; flex:none; margin-top:2px; }
    .pc-rows { display:flex; flex-direction:column; gap:8px; }
    .pc-row { display:flex; align-items:center; gap:11px; padding:12px 14px; border:1px solid var(--border-subtle,rgba(255,255,255,.08)); border-radius:12px; background:var(--bg-secondary,#101514); text-decoration:none; color:inherit; }
    .pc-row:hover { border-color:var(--tracky,#10E0A0); }
    .pc-ic { color:var(--fg-tertiary,#69736E); flex:none; }
    .pc-ic--ok { color:var(--tracky,#10E0A0); } .pc-ic--warn { color:#F5B33D; }
    .pc-row-main { flex:1; min-width:0; }
    .pc-plate { font-weight:700; font-size:14px; }
    .pc-meta { font-size:11.5px; color:var(--fg-tertiary,#9BA5A1); }
    .pc-badge { flex:none; font-size:11px; font-weight:700; padding:4px 9px; border-radius:7px; border:1px solid var(--border-subtle,rgba(255,255,255,.14)); color:var(--fg-tertiary,#9BA5A1); }
    .pc-badge--ok { color:var(--tracky-light,#3EEBB8); border-color:rgba(16,224,160,.35); }
    .pc-badge--warn { color:#F5B33D; border-color:rgba(245,179,61,.35); }
  `],
})
export class PrivacyCoverageComponent implements OnInit {
  private readonly api = inject(WorkScheduleApiService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly ShieldCheck = ShieldCheck; protected readonly ShieldOff = ShieldOff;
  protected readonly CheckCircle2 = CheckCircle2; protected readonly AlertTriangle = AlertTriangle;
  protected readonly LoaderCircle = LoaderCircle;

  protected readonly loading = signal(true);
  protected readonly rows = signal<PrivacyCoverageRow[]>([]);
  protected readonly total = signal(0);
  protected readonly protectedCount = signal(0);
  protected readonly uncoveredCount = signal(0);

  ngOnInit(): void {
    this.api.coverage().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        // Les non-couverts d'abord : ce sont eux qui demandent une décision.
        this.rows.set([...res.items].sort((a, b) => (a.status === 'PROTEGE' ? 1 : 0) - (b.status === 'PROTEGE' ? 1 : 0)));
        this.total.set(res.total);
        this.protectedCount.set(res.protectedCount);
        this.uncoveredCount.set(res.uncoveredCount);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  protected label(r: PrivacyCoverageRow): string {
    if (r.status === 'PROTEGE') return 'Protégé hors travail';
    if (r.status === 'MIXTE_SANS_CADRE') return 'Usage mixte sans cadre';
    return 'Suivi 24/7';
  }
}
