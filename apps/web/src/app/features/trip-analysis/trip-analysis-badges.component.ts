import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { LucideAngularModule, Leaf, OctagonX, Gauge, Fuel, Sparkles, Loader, AlertTriangle, ShieldCheck, FileText, X, GitCompareArrows } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type { AiProviderId, TripAiResultDto, TripAnalysisDto } from '@vizyo/tracky-shared';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';
import { AuthService } from '../../core/services/auth.service';
import { apiErrorMessage } from '../../core/error/api-error';

/**
 * Traçabilité fine (Palier 4 + 3) — RANGÉE DE BADGES d'analyse d'un trajet, RÉUTILISABLE (fiche
 * véhicule, Rapports, Replay). Affiche l'éco-conduite / excès / arrêts / conso (déterministe) + le
 * Trust Score si présent, et ouvre un DÉTAIL IA (récit + conseils + génération LLM + mode « Comparer »
 * Claude vs GPT). Reçoit l'analyse pré-chargée en lot ; « Analyser » (POST) si absente.
 */
@Component({
  selector: 'app-trip-analysis-badges',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, DecimalPipe],
  template: `
    @if (current(); as a) {
      <div class="tab-badges" role="group" aria-label="Analyse du trajet">
        <span class="tab-badge tab-badge--eco" [attr.data-tier]="ecoTier()" [title]="'Score éco-conduite : ' + a.ecoScore + '/100'">
          <lucide-icon [img]="LeafIcon" [size]="12"></lucide-icon> Éco {{ a.ecoScore }}
        </span>

        @if (a.speedingCount > 0) {
          <span class="tab-badge tab-badge--danger" [title]="speedingTitle(a)">
            <lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon>
            {{ a.speedingCount }} excès@if (a.limitsKnown && a.maxOverKmh > 0) { <span class="tab-badge-sub">+{{ a.maxOverKmh | number:'1.0-0' }}</span> }
          </span>
        }

        @if (a.stopCount > 0) {
          <span class="tab-badge" title="Arrêts significatifs (≥ 4 min)">
            <lucide-icon [img]="StopIcon" [size]="12"></lucide-icon> {{ a.stopCount }} arrêt{{ a.stopCount > 1 ? 's' : '' }}
          </span>
        }

        @if (a.harshAccel + a.harshBrake > 0) {
          <span class="tab-badge tab-badge--warn" title="Accélérations / freinages brusques">
            <lucide-icon [img]="GaugeIcon" [size]="12"></lucide-icon> {{ a.harshAccel + a.harshBrake }} à-coup{{ (a.harshAccel + a.harshBrake) > 1 ? 's' : '' }}
          </span>
        }

        @if (a.idleSec >= 60) {
          <span class="tab-badge" title="Temps moteur tournant à l'arrêt (gaspillage)">⏱ ralenti {{ minutes(a.idleSec) }} min</span>
        }

        @if (a.fuelLiters != null) {
          <span class="tab-badge" [title]="'Consommation estimée · ' + (a.co2Kg | number:'1.1-1') + ' kg CO₂'">
            <lucide-icon [img]="FuelIcon" [size]="12"></lucide-icon> {{ a.fuelLiters | number:'1.1-1' }} L
          </span>
        }

        @if (a.trustScore != null) {
          <span class="tab-badge tab-badge--trust" [attr.data-tier]="trustTier(a.trustScore)" title="Tracky Trust Score — fiabilité de la donnée GPS">
            <lucide-icon [img]="ShieldIcon" [size]="12"></lucide-icon> {{ a.trustScore }}
          </span>
        }

        <button type="button" class="tab-refresh" (click)="openDetail()" title="Récit IA, conseils & comparaison">
          <lucide-icon [img]="FileIcon" [size]="12"></lucide-icon> Récit IA
        </button>
        <button type="button" class="tab-refresh" (click)="runAnalyze()" [disabled]="busy()" title="Recalculer l'analyse (chiffres)">
          @if (busy()) { <lucide-icon [img]="LoaderIcon" [size]="12" class="tab-spin"></lucide-icon> }
          @else { <lucide-icon [img]="SparklesIcon" [size]="12"></lucide-icon> }
        </button>
      </div>
    } @else {
      <button type="button" class="tab-analyze" (click)="runAnalyze()" [disabled]="busy()" title="Analyser ce trajet (arrêts, excès, éco-conduite)">
        @if (busy()) { <lucide-icon [img]="LoaderIcon" [size]="13" class="tab-spin"></lucide-icon> Analyse… }
        @else { <lucide-icon [img]="SparklesIcon" [size]="13"></lucide-icon> Analyser }
      </button>
    }
    @if (error(); as e) { <span class="tab-err">{{ e }}</span> }

    <!-- ── Détail IA (récit + conseils + génération + comparaison) ── -->
    @if (detailOpen()) {
      <div class="taid-overlay" (click)="closeDetail()">
        <div class="taid-card" (click)="$event.stopPropagation()" role="dialog" aria-label="Analyse IA du trajet">
          <header class="taid-head">
            <h3><lucide-icon [img]="SparklesIcon" [size]="16"></lucide-icon> Analyse IA du trajet</h3>
            <button type="button" class="taid-x" (click)="closeDetail()" aria-label="Fermer"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
          </header>
          <div class="taid-body">
            @if (current(); as a) {
              @if (a.trustScore != null) {
                <div class="taid-trust" [attr.data-tier]="trustTier(a.trustScore)">
                  <span class="taid-trust-n">{{ a.trustScore }}</span>
                  <span class="taid-trust-l"><strong>Tracky Trust Score</strong><small>Fiabilité de la donnée GPS de ce trajet</small></span>
                </div>
              }

              @if (a.narrative) {
                <section class="taid-sec">
                  <h4>Récit @if (a.provider) { <span class="taid-prov">par {{ providerLabel(a.provider) }}</span> }</h4>
                  <p>{{ a.narrative }}</p>
                </section>
                @if (a.advice) {
                  <section class="taid-sec taid-sec--advice">
                    <h4><lucide-icon [img]="LeafIcon" [size]="13"></lucide-icon> Conseils d'éco-conduite</h4>
                    <p>{{ a.advice }}</p>
                  </section>
                }
              } @else {
                <p class="taid-empty">Les chiffres du trajet sont déjà calculés. Générez le récit IA ci-dessous pour une lecture vulgarisée + des conseils.</p>
              }

              <div class="taid-actions">
                <button type="button" class="taid-btn" (click)="runNarrate()" [disabled]="busyNarrate()">
                  @if (busyNarrate()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="tab-spin"></lucide-icon> Génération… }
                  @else { <lucide-icon [img]="SparklesIcon" [size]="14"></lucide-icon> {{ a.narrative ? 'Régénérer' : 'Générer le récit IA' }} }
                </button>
                @if (canCompare()) {
                  <button type="button" class="taid-btn taid-btn--ghost" (click)="runCompare()" [disabled]="busyCompare()" title="Lance les 2 IA sur ce trajet (coût ×2)">
                    @if (busyCompare()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="tab-spin"></lucide-icon> Comparaison… }
                    @else { <lucide-icon [img]="CompareIcon" [size]="14"></lucide-icon> Comparer Claude vs GPT }
                  </button>
                }
              </div>
              @if (detailError(); as e) { <p class="taid-err">{{ e }}</p> }

              @if (compareResults(); as cr) {
                <div class="taid-compare">
                  @for (r of cr; track r.provider) {
                    <div class="taid-col" [attr.data-provider]="r.provider">
                      <div class="taid-col-head">
                        <span>{{ providerLabel(r.provider) }}</span>
                        @if (!r.error) { <span class="taid-col-cost">{{ r.costEur | number:'1.4-4' }} €</span> }
                      </div>
                      @if (r.error) {
                        <p class="taid-col-err"><lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon> {{ r.error }}</p>
                      } @else {
                        <div class="taid-col-trust" [attr.data-tier]="trustTier(r.trustScore ?? 0)">Trust {{ r.trustScore }}</div>
                        <p class="taid-col-txt">{{ r.narrative }}</p>
                        @if (r.advice) { <p class="taid-col-advice">{{ r.advice }}</p> }
                      }
                    </div>
                  }
                </div>
              }
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .tab-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
    .tab-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 700;
      background: var(--bg-tertiary); color: var(--fg-secondary);
      border: 1px solid var(--border-subtle);
    }
    .tab-badge lucide-icon { flex-shrink: 0; }
    .tab-badge-sub { opacity: .8; font-weight: 800; margin-left: 1px; }
    .tab-badge--eco[data-tier="good"] { background: color-mix(in srgb, var(--tracky-light, #10E0A0) 16%, transparent); color: var(--tracky-light, #10E0A0); border-color: transparent; }
    .tab-badge--eco[data-tier="mid"]  { background: color-mix(in srgb, #F59E0B 16%, transparent); color: #F59E0B; border-color: transparent; }
    .tab-badge--eco[data-tier="bad"]  { background: color-mix(in srgb, #EF4444 16%, transparent); color: #EF4444; border-color: transparent; }
    .tab-badge--danger { background: color-mix(in srgb, #EF4444 14%, transparent); color: #EF4444; border-color: transparent; }
    .tab-badge--warn { background: color-mix(in srgb, #F59E0B 13%, transparent); color: #F59E0B; border-color: transparent; }
    .tab-badge--trust[data-tier="good"] { background: color-mix(in srgb, #60A5FA 16%, transparent); color: #60A5FA; border-color: transparent; }
    .tab-badge--trust[data-tier="mid"]  { background: color-mix(in srgb, #F59E0B 14%, transparent); color: #F59E0B; border-color: transparent; }
    .tab-badge--trust[data-tier="bad"]  { background: color-mix(in srgb, #EF4444 14%, transparent); color: #EF4444; border-color: transparent; }
    .tab-analyze, .tab-refresh {
      display: inline-flex; align-items: center; gap: 5px;
      border-radius: 8px; cursor: pointer; font-weight: 700;
      color: var(--tracky-light, #10E0A0);
      background: color-mix(in srgb, var(--tracky-light, #10E0A0) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 24%, transparent);
      transition: background .15s;
    }
    .tab-analyze { padding: 5px 11px; font-size: 11.5px; }
    .tab-refresh { padding: 4px 8px; font-size: 11px; }
    .tab-analyze:hover:not(:disabled), .tab-refresh:hover:not(:disabled) { background: color-mix(in srgb, var(--tracky-light, #10E0A0) 16%, transparent); }
    .tab-analyze:disabled, .tab-refresh:disabled { opacity: .6; cursor: default; }
    .tab-spin { animation: tab-rot .9s linear infinite; }
    @keyframes tab-rot { to { transform: rotate(360deg); } }
    .tab-err { font-size: 11px; color: #EF4444; }

    /* ── Modal détail IA ── */
    .taid-overlay { position: fixed; inset: 0; z-index: 9500; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,.55); backdrop-filter: blur(3px); }
    .taid-card { width: 100%; max-width: 720px; max-height: 88vh; display: flex; flex-direction: column; border-radius: 16px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); box-shadow: 0 20px 60px rgba(0,0,0,.4); overflow: hidden; }
    .taid-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border-subtle); }
    .taid-head h3 { margin: 0; display: inline-flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 800; color: var(--fg-primary); }
    .taid-head h3 lucide-icon { color: var(--tracky-light, #10E0A0); }
    .taid-x { width: 32px; height: 32px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: var(--fg-tertiary); }
    .taid-x:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    .taid-body { padding: 16px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
    .taid-trust { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .taid-trust-n { font-size: 34px; font-weight: 800; line-height: 1; letter-spacing: -.02em; }
    .taid-trust[data-tier="good"] .taid-trust-n { color: #60A5FA; }
    .taid-trust[data-tier="mid"]  .taid-trust-n { color: #F59E0B; }
    .taid-trust[data-tier="bad"]  .taid-trust-n { color: #EF4444; }
    .taid-trust-l { display: flex; flex-direction: column; gap: 2px; }
    .taid-trust-l strong { font-size: 13.5px; font-weight: 800; color: var(--fg-primary); }
    .taid-trust-l small { font-size: 11.5px; color: var(--fg-tertiary); }
    .taid-sec h4 { margin: 0 0 5px; display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 800; color: var(--fg-primary); text-transform: uppercase; letter-spacing: .03em; }
    .taid-prov { text-transform: none; letter-spacing: 0; font-weight: 600; font-size: 11px; color: var(--fg-tertiary); }
    .taid-sec p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--fg-secondary); white-space: pre-line; }
    .taid-sec--advice p { color: var(--fg-primary); }
    .taid-empty { margin: 0; font-size: 12.5px; color: var(--fg-tertiary); line-height: 1.5; }
    .taid-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 2px; }
    .taid-btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 14px; border-radius: 10px; font-size: 12.5px; font-weight: 800; cursor: pointer; background: var(--tracky, #10E0A0); color: var(--accent-ink, #04130D); border: none; }
    .taid-btn:disabled { opacity: .6; cursor: default; }
    .taid-btn--ghost { background: transparent; color: var(--fg-secondary); border: 1px solid var(--border-strong, var(--border-subtle)); }
    .taid-btn--ghost:hover:not(:disabled) { color: var(--fg-primary); border-color: var(--tracky-light, #10E0A0); }
    .taid-err { margin: 0; font-size: 12px; color: #EF4444; }
    .taid-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 4px; }
    @media (max-width: 560px) { .taid-compare { grid-template-columns: 1fr; } }
    .taid-col { display: flex; flex-direction: column; gap: 7px; padding: 12px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .taid-col-head { display: flex; align-items: center; justify-content: space-between; font-size: 13px; font-weight: 800; color: var(--fg-primary); }
    .taid-col-cost { font-size: 11px; font-weight: 700; color: var(--fg-tertiary); }
    .taid-col-trust { display: inline-block; align-self: flex-start; font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, #60A5FA 16%, transparent); color: #60A5FA; }
    .taid-col-trust[data-tier="mid"] { background: color-mix(in srgb, #F59E0B 16%, transparent); color: #F59E0B; }
    .taid-col-trust[data-tier="bad"] { background: color-mix(in srgb, #EF4444 16%, transparent); color: #EF4444; }
    .taid-col-txt { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--fg-secondary); }
    .taid-col-advice { margin: 0; font-size: 12px; line-height: 1.45; color: var(--fg-primary); padding-top: 6px; border-top: 1px dashed var(--border-subtle); }
    .taid-col-err { margin: 0; display: inline-flex; align-items: flex-start; gap: 5px; font-size: 12px; color: #EF4444; }
  `],
})
export class TripAnalysisBadgesComponent {
  private readonly api = inject(TripAnalysisApiService);
  private readonly auth = inject(AuthService);

  readonly tripId = input.required<string>();
  readonly analysis = input<TripAnalysisDto | null>(null);
  readonly analyzed = output<TripAnalysisDto>();

  private readonly fresh = signal<TripAnalysisDto | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  // Détail IA (récit + conseils + comparaison)
  protected readonly detailOpen = signal(false);
  protected readonly busyNarrate = signal(false);
  protected readonly busyCompare = signal(false);
  protected readonly detailError = signal<string | null>(null);
  protected readonly compareResults = signal<TripAiResultDto[] | null>(null);

  protected readonly current = computed(() => this.fresh() ?? this.analysis());

  /** Comparer les 2 moteurs = usage INTERNE (super-admin) : un client (fleet-admin & -) ne voit jamais
   *  quel moteur tourne (marque blanche « agent Tracky »). */
  protected readonly canCompare = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');

  protected readonly ecoTier = computed(() => {
    const s = this.current()?.ecoScore ?? 100;
    return s >= 80 ? 'good' : s >= 50 ? 'mid' : 'bad';
  });

  protected readonly LeafIcon = Leaf;
  protected readonly StopIcon = OctagonX;
  protected readonly GaugeIcon = Gauge;
  protected readonly FuelIcon = Fuel;
  protected readonly SparklesIcon = Sparkles;
  protected readonly LoaderIcon = Loader;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly ShieldIcon = ShieldCheck;
  protected readonly FileIcon = FileText;
  protected readonly XIcon = X;
  protected readonly CompareIcon = GitCompareArrows;

  protected minutes(sec: number): number { return Math.round(sec / 60); }
  protected trustTier(s: number): 'good' | 'mid' | 'bad' { return s >= 75 ? 'good' : s >= 45 ? 'mid' : 'bad'; }
  /** Libellé du moteur. MARQUE BLANCHE : tout ce qui n'est pas un moteur nommé (le backend masque en
   *  'tracky' pour les clients) s'affiche « l'agent Tracky ». Seul le super-admin voit Claude/GPT/Mixte. */
  protected providerLabel(p: AiProviderId | string): string {
    return p === 'gpt' ? 'GPT (OpenAI)' : p === 'claude' ? 'Claude' : p === 'both' ? 'Mixte (les 2 IA)' : 'l\'agent Tracky';
  }
  protected speedingTitle(a: TripAnalysisDto): string {
    return a.limitsKnown
      ? `${a.speedingCount} excès de vitesse — dépassement max +${Math.round(a.maxOverKmh)} km/h`
      : `${a.speedingCount} pointe(s) de vitesse (limites légales non résolues — excès probable)`;
  }

  protected openDetail(): void { this.detailError.set(null); this.detailOpen.set(true); }
  protected closeDetail(): void { this.detailOpen.set(false); }

  protected async runAnalyze(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.analyze(this.tripId()));
      this.fresh.set(res);
      this.analyzed.emit(res);
    } catch (e) {
      this.error.set(apiErrorMessage(e, 'Analyse impossible.'));
    } finally {
      this.busy.set(false);
    }
  }

  /** Génère le récit IA (LLM) + Trust Score + conseils, persistés. */
  protected async runNarrate(): Promise<void> {
    if (this.busyNarrate()) return;
    this.busyNarrate.set(true);
    this.detailError.set(null);
    try {
      const res = await firstValueFrom(this.api.narrate(this.tripId()));
      this.fresh.set(res);
      this.analyzed.emit(res);
    } catch (e) {
      this.detailError.set(apiErrorMessage(e, 'Génération du récit impossible.'));
    } finally {
      this.busyNarrate.set(false);
    }
  }

  /** Compare les 2 IA sur ce trajet (côte à côte). */
  protected async runCompare(): Promise<void> {
    if (this.busyCompare()) return;
    this.busyCompare.set(true);
    this.detailError.set(null);
    try {
      const res = await firstValueFrom(this.api.compare(this.tripId()));
      this.compareResults.set(res.results);
    } catch (e) {
      this.detailError.set(apiErrorMessage(e, 'Comparaison impossible.'));
    } finally {
      this.busyCompare.set(false);
    }
  }
}
