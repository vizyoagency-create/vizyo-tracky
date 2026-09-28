import { swallow } from '../../../core/error/swallow';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DecimalPipe, NgClass } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { apiErrorMessage } from '../../../core/error/api-error';
import {
  LucideAngularModule, Gauge, Sparkles, TrendingDown, Truck, Info, AlertTriangle, Loader, X, Check,
} from 'lucide-angular';
import {
  FLEET_METIER_LABELS,
  type AiCapacityResultDto,
  type FleetMetier,
  type FleetOptimizationDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AiApiService } from '../../../core/services/ai.service';
import { AiStatusService } from '../../../core/services/ai-status.service';
import { AiJobService } from '../../../core/services/ai-job.service';
import { AuthService } from '../../../core/services/auth.service';
import { FleetCacheService } from '../../../core/services/fleet-cache.service';
import { FleetFilterService } from '../../../core/services/fleet-filter.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { BottomSheetComponent } from '../../../shared/ui/bottom-sheet/bottom-sheet.component';
import { AgendaApiService } from '../../../core/services/agenda.service';

const METIERS: FleetMetier[] = ['CHILDREN_TRANSPORT', 'PARCELS', 'RENTAL', 'GENERIC'];

/**
 * Sprint 9 (consolidation) — Optimisation depuis l'Agenda : réglage du métier de la
 * flotte, opportunités de mutualisation (véhicules sous-utilisés), et enrichissement
 * des capacités par l'IA (places / places-enfant par modèle → applique). Aucune page séparée.
 */
@Component({
  selector: 'app-optimization-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, NgClass, LucideAngularModule, BottomSheetComponent],
  template: `
    <app-bottom-sheet [open]="open()" ariaLabel="Optimisation de la flotte" (closed)="closed.emit()">
      <div class="op">
        <div class="op-head">
          <h3 class="op-title"><lucide-icon [img]="GaugeIcon" [size]="15"></lucide-icon> Optimisation</h3>
          <button type="button" class="op-x" (click)="closed.emit()" aria-label="Fermer"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
        </div>

        <div class="op-body">
          <!-- Hero IA (réf. maquette AgentIA.dc.html) : identité « agent » honnête,
               sans KPI inventés (km/€/CO₂) ni suggestions de tournée non implémentées.
               Masqué si l'IA est coupée pour la flotte (les mutualisations déterministes restent). -->
          @if (aiEnabled()) {
            <div class="op-hero">
              <span class="op-hero-ico"><lucide-icon [img]="SparklesIcon" [size]="20"></lucide-icon></span>
              <div class="op-hero-txt">
                <div class="op-hero-eye">
                  <span class="op-hero-kick">Optimisation</span>
                  <span class="op-hero-live"><span class="op-hero-dot"></span>Analyse active</span>
                </div>
                <p class="op-hero-lead">L'agent analyse votre parc et propose des améliorations chiffrées. <span class="op-muted">Rien n'est appliqué sans votre validation.</span></p>
              </div>
            </div>
          } @else {
            <div class="op-alert op-alert--info"><lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon> Assistance IA désactivée pour cette flotte. Les opportunités de mutualisation ci-dessous restent disponibles ; l'analyse IA des capacités est masquée.</div>
          }

          <!-- Société (super-admin) : celle du BANDEAU, jamais un second sélecteur. P1-4 (audit du
               22/09) : la feuille avait le sien, l'en-tête pouvait dire cdef31 pendant que la feuille
               changeait le métier de mh cars. Une seule source de vérité, lue ici, réglée là-haut. -->
          @if (isSuperAdmin()) {
            <div class="op-f"><span>Société</span>
              @if (fleetName(); as nom) {
                <span class="op-fleet" [attr.title]="'Réglée dans le bandeau en haut de page'">{{ nom }}</span>
              } @else {
                <span class="op-fleet op-muted">Toutes les sociétés — choisissez-en une dans le bandeau pour analyser un parc.</span>
              }
            </div>
          }

          <!-- Métier -->
          <div class="op-metier">
            <div class="op-metier-l">
              <span class="op-k">Métier de la flotte</span>
              @if (metier()) { <span class="op-metier-v">{{ metierLabel(metier()!) }}</span> }
              @else { <span class="op-metier-v op-muted">{{ needsFleet() ? 'Choisissez une société dans le bandeau' : '—' }}</span> }
            </div>
            @if (canEditMetier() && metier()) {
              <select class="op-in op-in--sm" [value]="metier()!" (change)="onMetierChange($any($event.target).value)">
                @for (m of metiers; track m) { <option [value]="m">{{ metierLabel(m) }}</option> }
              </select>
            }
          </div>
          <p class="op-hint"><lucide-icon [img]="InfoIcon" [size]="12"></lucide-icon> Conditionne l'IA : enfants → places et sièges auto du stock · colis → charge · location → disponibilité.</p>

          <!-- Capacité IA (masquée si l'IA est coupée pour la flotte) -->
          @if (aiEnabled()) {
          <section class="op-sec">
            <div class="op-sec-head">
              <h4 class="op-sec-title"><lucide-icon [img]="SparklesIcon" [size]="14" class="op-accent"></lucide-icon> Compléter les capacités (IA)</h4>
              <button type="button" class="op-btn op-btn--primary" [disabled]="capLoading() || needsFleet()" (click)="runCapacity()">
                @if (capLoading()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="op-spin"></lucide-icon> }
                {{ capLoading() ? 'Analyse…' : 'Analyser' }}
              </button>
            </div>
            <p class="op-sec-sub">L'IA déduit les places par modèle (Jumpy/Expert : 9 ou 2). Vérifiez puis appliquez. Les sièges auto, eux, sont un stock de la société (Paramètres de l'agenda).</p>
            @if (needsFleet()) { <div class="op-alert op-alert--warn"><lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon> Choisissez une société dans le bandeau pour analyser son parc.</div> }
            @if (capError()) { <div class="op-alert op-alert--err"><lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon> {{ capError() }}</div> }
            @if (capLoading()) { <div class="op-skel"></div><div class="op-skel"></div> }
            @else if (capResult(); as r) {
              @if (capConserveLe(); as le) {
                <div class="op-alert op-alert--info"><lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon> Résultat conservé de l'analyse du {{ conserveDepuis(le) }} — rien n'a été repayé. Relancez « Analyser » pour une lecture fraîche du parc.</div>
              }
              @if (r.proposals.length === 0) { <p class="op-muted op-pad">Aucune proposition (parc vide).</p> }
              @else {
                @if (canApply()) {
                  <div class="op-selbar">
                    <button type="button" class="op-link" (click)="toggleAll()">{{ allSelected() ? 'Tout désélectionner' : 'Tout sélectionner' }}</button>
                    <span class="op-selc">{{ selected().size }}/{{ r.proposals.length }}</span>
                  </div>
                } @else {
                  <div class="op-alert op-alert--info"><lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon> Consultation seule — droit « Modifier un véhicule » requis pour appliquer.</div>
                }
                <div class="op-cards">
                  @for (p of r.proposals; track p.vehicleId) {
                    <button type="button" class="op-card" [class.op-card--on]="canApply() && selected().has(p.vehicleId)" [disabled]="!canApply()" (click)="toggleSel(p.vehicleId)">
                      <div class="op-card-top">
                        <span class="op-plate">{{ p.plate || '—' }}@if (p.model) { <span class="op-model">{{ p.model }}</span> }</span>
                        <span class="op-chip" [ngClass]="confClass(p.confidence)">{{ p.confidence * 100 | number:'1.0-0' }}%</span>
                      </div>
                      <div class="op-vals"><span>{{ valOf(p.seats) }} places</span>@if (p.features.length > 0) { <span>{{ p.features.join(', ') }}</span> }</div>
                      @if (p.reasoning) { <p class="op-reason">{{ p.reasoning }}</p> }
                    </button>
                  }
                </div>
                @if (canApply()) {
                  <div class="op-apply">
                    <button type="button" class="op-btn op-btn--primary" [disabled]="applying() || selected().size === 0" (click)="applySel()">
                      @if (applying()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="op-spin"></lucide-icon> }
                      {{ applying() ? 'Application…' : 'Appliquer (' + selected().size + ')' }}
                    </button>
                  </div>
                }
              }
            }
          </section>
          }

          <!-- Sous-utilisés (déterministe — toujours visible, même IA coupée) -->
          <section class="op-sec">
            <h4 class="op-sec-title"><lucide-icon [img]="TrendingDownIcon" [size]="14" class="op-accent"></lucide-icon> Opportunités de mutualisation</h4>
            @if (utilLoading()) { <div class="op-skel"></div> }
            @else if (underutilized().length === 0) { <p class="op-muted op-pad">Aucun véhicule franchement sous-utilisé sur 28 jours.</p> }
            @else {
              <div class="op-under">
                @for (v of underutilized(); track v.vehicleId) {
                  <div class="op-u">
                    <div class="op-u-top"><span class="op-plate">{{ v.vehiclePlate || '—' }}</span><span class="op-u-pct">{{ v.utilizationRatio * 100 | number:'1.0-0' }}%</span></div>
                    @if (v.freePatterns.length > 0) { <div class="op-free">@for (fp of v.freePatterns; track fp) { <span class="op-free-c">Libre {{ fp }}</span> }</div> }
                  </div>
                }
              </div>
            }
          </section>

          <!-- Comment ça marche (réf. maquette AgentIA.dc.html) — masqué si l'IA est coupée -->
          @if (aiEnabled()) {
          <section class="op-sec">
            <h4 class="op-sec-title"><lucide-icon [img]="InfoIcon" [size]="14" class="op-accent"></lucide-icon> Comment ça marche</h4>
            <div class="op-steps">
              <div class="op-step"><span class="op-step-n">1</span><p>L'IA lit les capacités du parc et l'utilisation réelle des 28 derniers jours.</p></div>
              <div class="op-step"><span class="op-step-n">2</span><p>Elle propose des enrichissements de capacité et des mutualisations, avec un indice de confiance.</p></div>
              <div class="op-step"><span class="op-step-n">3</span><p>Vous validez ; l'application met à jour les véhicules concernés. Jamais d'action automatique.</p></div>
            </div>
          </section>
          }
        </div>
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    .op { display: flex; flex-direction: column; padding: 2px 2px 0; }
    .op-head { display: flex; align-items: center; justify-content: space-between; }
    .op-title { display: flex; align-items: center; gap: 7px; font-size: 15px; font-weight: 700; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .op-x { width: 34px; height: 34px; border-radius: 9px; color: var(--fg-tertiary); display: inline-flex; align-items: center; justify-content: center; }
    .op-x:hover { color: var(--fg-primary); background: var(--bg-tertiary); }
    .op-body { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; max-height: 64vh; max-height: 64dvh; padding: 10px 2px 0; }
    .op-accent { color: var(--tracky-light); }
    .op-muted { color: var(--fg-secondary); }
    .op-pad { padding: 10px 2px; font-size: 12.5px; }
    .op-f { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--fg-tertiary); }
    /* P1-4 : la société vient du bandeau ; on l'AFFICHE, on ne la choisit plus ici. */
    .op-fleet { font-size: 14px; font-weight: 700; color: var(--fg-primary); }
    .op-f > span { font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    .op-in { width: 100%; padding: 9px 11px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-primary); font-size: 16px; }
    .op-in--sm { width: auto; font-size: 14px; padding: 7px 10px; }
    .op-in:focus { outline: none; border-color: var(--tracky-light); }
    .op-metier { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .op-metier-l { display: flex; flex-direction: column; }
    .op-k { font-size: 11px; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: .03em; }
    .op-metier-v { font-size: 16px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .op-hint { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--fg-secondary); line-height: 1.4; }
    .op-sec { border-top: 1px solid var(--border-subtle); padding-top: 12px; display: flex; flex-direction: column; gap: 8px; }
    .op-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .op-sec-title { font-size: 13.5px; font-weight: 700; color: var(--fg-primary); display: flex; align-items: center; gap: 7px; font-family: var(--font-display, inherit); }
    .op-sec-sub { font-size: 12px; color: var(--fg-tertiary); line-height: 1.45; }
    .op-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 10px; font-size: 13px; font-weight: 700; }
    .op-btn--primary { background: var(--tracky, #10B981); color: #fff; }
    .op-btn:disabled { opacity: .55; }
    .op-link { font-size: 12px; font-weight: 600; color: var(--tracky-light); }
    .op-selbar { display: flex; align-items: center; justify-content: space-between; }
    .op-selc { font-size: 12px; color: var(--fg-tertiary); }
    .op-cards { display: grid; grid-template-columns: 1fr; gap: 8px; }
    @media (min-width: 560px) { .op-cards { grid-template-columns: 1fr 1fr; } }
    .op-card { text-align: left; padding: 11px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .op-card--on { border-color: var(--tracky-light); box-shadow: 0 0 0 1px var(--tracky-light) inset; background: rgba(16,224,160,.06); }
    .op-card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .op-plate { font-weight: 800; color: var(--fg-primary); letter-spacing: .3px; }
    .op-model { display: block; font-size: 11px; color: var(--fg-tertiary); font-weight: 400; margin-top: 1px; }
    .op-vals { display: flex; gap: 14px; margin-top: 8px; font-size: 12px; font-weight: 700; color: var(--fg-secondary); }
    .op-reason { font-size: 12px; color: var(--fg-secondary); margin-top: 7px; line-height: 1.4; }
    .op-chip { font-size: 12px; font-weight: 800; padding: 2px 9px; border-radius: 999px; }
    .op-chip--hi { color: #10B981; background: rgba(16,185,129,.13); }
    .op-chip--mid { color: var(--texte-attente); background: color-mix(in srgb, var(--warning) 14%, transparent); }
    .op-chip--lo { color: var(--texte-alerte); background: color-mix(in srgb, var(--danger) 13%, transparent); }
    .op-apply { display: flex; justify-content: flex-end; margin-top: 4px; }
    .op-under { display: grid; grid-template-columns: 1fr; gap: 8px; }
    @media (min-width: 560px) { .op-under { grid-template-columns: 1fr 1fr; } }
    .op-u { padding: 10px 11px; border-radius: 11px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .op-u-top { display: flex; align-items: center; justify-content: space-between; }
    .op-u-pct { font-size: 12px; font-weight: 800; color: var(--texte-attente); }
    .op-free { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
    .op-free-c { font-size: 10.5px; font-weight: 600; padding: 2px 7px; border-radius: 6px; background: rgba(16,224,160,.12); color: var(--tracky-light); }
    .op-alert { display: flex; align-items: center; gap: 7px; padding: 9px 11px; border-radius: 10px; font-size: 12px; }
    .op-alert--err { background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--texte-alerte); }
    .op-alert--warn { background: color-mix(in srgb, var(--warning) 12%, transparent); color: var(--texte-attente); }
    .op-alert--info { background: var(--bg-secondary); color: var(--fg-tertiary); border: 1px solid var(--border-subtle); }
    .op-skel { height: 60px; border-radius: 12px; background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: op-sh 1.3s infinite; }
    @keyframes op-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .op-spin { animation: op-spin 1s linear infinite; }
    @keyframes op-spin { to { transform: rotate(360deg); } }

    /* Hero IA */
    .op-hero { display: flex; gap: 13px; padding: 14px 15px; border-radius: 14px; border: 1px solid var(--border-subtle); background: color-mix(in srgb, var(--tracky) 5%, var(--bg-secondary)); }
    .op-hero-ico { display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; border-radius: 12px; background: var(--tracky); color: var(--accent-ink); flex-shrink: 0; }
    .op-hero-eye { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    /* Petits libelles sur le hero teinte : --texte-succes, le vert de marque
       rend ~3,3:1 en theme clair (convention du kit, styles.css). */
    .op-hero-kick { font-family: var(--font-mono); font-size: 10.5px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--texte-succes); }
    .op-hero-live { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; color: var(--texte-succes); }
    .op-hero-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--tracky-light); animation: op-blink 2s ease-in-out infinite; }
    @keyframes op-blink { 0%,100%{opacity:1} 50%{opacity:.25} }
    .op-hero-lead { font-size: 12.5px; color: var(--fg-secondary); margin-top: 6px; line-height: 1.5; }

    /* Comment ça marche */
    .op-steps { display: flex; flex-direction: column; gap: 9px; }
    .op-step { display: flex; gap: 10px; }
    .op-step-n { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 7px; background: color-mix(in srgb, var(--tracky) 12%, transparent); color: var(--texte-succes); font-family: var(--font-mono); font-size: 11px; font-weight: 700; flex-shrink: 0; }
    .op-step p { font-size: 12px; color: var(--fg-secondary); line-height: 1.5; margin: 0; }
  `],
})
export class OptimizationSheetComponent {
  private readonly ai = inject(AiApiService);
  private readonly aiStatus = inject(AiStatusService);
  private readonly agendaApi = inject(AgendaApiService);
  private readonly auth = inject(AuthService);
  private readonly fleetCache = inject(FleetCacheService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);
  private readonly aiJob = inject(AiJobService);

  readonly open = input(false);
  /** Résultat de capacité IA pré-chargé (analyse lancée en arrière-plan via la pastille) — affiché
   *  à la ré-ouverture au clic « Voir ». */
  readonly presetCapacity = input<AiCapacityResultDto | null>(null);
  readonly closed = output<void>();
  /** Émis quand une capacité est appliquée (le parent peut recharger si besoin). */
  readonly applied = output<void>();

  protected readonly GaugeIcon = Gauge;
  protected readonly SparklesIcon = Sparkles;
  protected readonly TrendingDownIcon = TrendingDown;
  protected readonly TruckIcon = Truck;
  protected readonly InfoIcon = Info;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly LoaderIcon = Loader;
  protected readonly XIcon = X;
  protected readonly CheckIcon = Check;
  protected readonly metiers = METIERS;

  /**
   * P1-4 — la société de la feuille EST celle du bandeau (`FleetFilterService`), jamais un signal
   * local : l'ancien sélecteur propre à la feuille laissait l'en-tête dire cdef31 pendant que la
   * feuille lisait — et changeait le métier de — mh cars. Pour un non-super-admin, `null` : le
   * serveur borne à sa société.
   */
  protected readonly selectedFleetId = computed(() => (this.isSuperAdmin() ? this.fleetFilter.selectedFleetId() : null));
  /** Nom de la société du bandeau, pour l'afficher là où était le sélecteur. */
  protected readonly fleetName = computed(() => this.fleetCache.getName(this.selectedFleetId()));
  protected readonly metier = signal<FleetMetier | null>(null);
  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  /** IA active pour la flotte : masque les sections IA (hero, capacités, « comment ça marche »). */
  /**
   * Toutes les sections IA de cette feuille reposent sur `runCapacity()` → fonction `capacity`.
   * ⚠️ Gaté sur `capacity`, PAS sur l'interrupteur maître : couper `capacity` pour tout le monde
   * laissait auparavant le bouton « Analyser » à l'écran, et le serveur refusait le clic.
   */
  protected readonly aiEnabled = computed(() => this.aiStatus.can('capacity'));
  protected readonly canEditMetier = computed(() => {
    const r = this.auth.user()?.role;
    return r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN';
  });
  protected readonly needsFleet = computed(() => this.isSuperAdmin() && !this.selectedFleetId());
  protected readonly canApply = computed(() => this.perms.can('vehicles_edit'));

  protected readonly capLoading = signal(false);
  protected readonly capError = signal<string | null>(null);
  protected readonly capResult = signal<AiCapacityResultDto | null>(null);
  protected readonly selected = signal<Set<string>>(new Set());
  protected readonly applying = signal(false);
  protected readonly allSelected = computed(() => {
    const r = this.capResult();
    return !!r && r.proposals.length > 0 && r.proposals.every((p) => this.selected().has(p.vehicleId));
  });

  protected readonly utilLoading = signal(false);
  protected readonly util = signal<FleetOptimizationDto | null>(null);
  protected readonly underutilized = computed(() => (this.util()?.vehicles ?? []).filter((v) => v.underutilized).slice(0, 12));

  /** Date (ISO) du résultat de capacité affiché quand il vient de la mémoire du navigateur. */
  protected readonly capConserveLe = signal<string | null>(null);

  constructor() {
    this.aiStatus.ensureLoaded();
    /**
     * À CHAQUE ouverture, et à chaque changement de société pendant qu'elle est ouverte :
     * métier et mutualisations sont relus (deux GET légers). L'ancien garde `loadedOnce` ne
     * chargeait qu'à la première ouverture — la feuille rouvrait sur le métier d'une autre
     * société, ou sur des chiffres d'il y a une heure (P1-4).
     *
     * Le résultat de capacité affiché vient, dans l'ordre : de la pastille (« Voir » après une
     * analyse en arrière-plan), sinon de la mémoire du navigateur pour CETTE société (P1-5),
     * sinon rien — jamais un résultat périmé d'une autre société.
     */
    effect(() => {
      if (!this.open()) return;
      this.selectedFleetId(); // dépendance : la société du bandeau — changer de société recharge
      void this.fleetCache.loadIfNeeded();
      this.selected.set(new Set());
      const preset = this.presetCapacity();
      if (preset) {
        this.capResult.set(preset);
        this.capConserveLe.set(null);
      } else {
        this.restaurerCapacite();
      }
      if (!this.needsFleet()) void this.loadMetier();
      else this.metier.set(null);
      void this.loadUtil();
    });
  }

  protected metierLabel(m: FleetMetier): string { return FLEET_METIER_LABELS[m]; }
  protected valOf(n: number | null): string { return n === null || n === undefined ? '—' : String(n); }
  protected confClass(v: number): string { return v >= 0.7 ? 'op-chip--hi' : v >= 0.4 ? 'op-chip--mid' : 'op-chip--lo'; }
  /** « 27/09 à 21:14 » — date locale d'un résultat conservé ; une date illisible ne casse pas la feuille. */
  protected conserveDepuis(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'date inconnue';
    return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(' ', ' à ');
  }

  // ─── P1-5 — un résultat de capacité payé ne se perd plus au rechargement ──────────────────
  //
  // `AiJobService` vit en mémoire du navigateur : un F5 pendant ou après l'analyse effaçait le
  // résultat, et l'analyse suivante était REPAYÉE. Le serveur ne le garde nulle part (c'est une
  // suggestion, pas un enregistrement) — on le garde donc ici, par société, le temps qu'il soit
  // appliqué ou remplacé. Mémoire du navigateur = confort, jamais une source de vérité : chaque
  // accès est protégé, et sans elle la feuille marche comme avant.

  /**
   * La clé porte la société RÉELLE : celle du bandeau pour un super-admin, celle du compte pour
   * les autres. Sans cela, deux comptes de sociétés différentes sur le même navigateur liraient
   * le résultat l'un de l'autre — des plaques et des modèles qui ne sont pas les leurs.
   */
  private cleCapacite(): string {
    const fleetId = this.selectedFleetId() ?? this.auth.user()?.fleetId ?? null;
    return `tracky.capacite.${fleetId ?? 'sans-societe'}`;
  }

  private memoriserCapacite(r: AiCapacityResultDto): void {
    try {
      localStorage.setItem(this.cleCapacite(), JSON.stringify({ le: new Date().toISOString(), r }));
    } catch (e) {
      swallow('optimization-sheet:memoriserCapacite', e);
    }
  }

  private oublierCapacite(): void {
    try {
      localStorage.removeItem(this.cleCapacite());
    } catch (e) {
      swallow('optimization-sheet:oublierCapacite', e);
    }
  }

  private restaurerCapacite(): void {
    this.capResult.set(null);
    this.capConserveLe.set(null);
    try {
      const brut = localStorage.getItem(this.cleCapacite());
      if (!brut) return;
      const { le, r } = JSON.parse(brut) as { le?: unknown; r?: AiCapacityResultDto };
      if (!r || !Array.isArray(r.proposals)) return;
      this.capResult.set(r);
      this.capConserveLe.set(typeof le === 'string' ? le : null);
    } catch (e) {
      swallow('optimization-sheet:restaurerCapacite', e);
    }
  }

  private async loadMetier(): Promise<void> {
    this.metier.set(null);
    try {
      const res = await firstValueFrom(this.ai.getFleetMetier(this.selectedFleetId() ?? undefined));
      this.metier.set(res.metier);
    } catch (err) {
      // needsFleet hint le couvre
      swallow('optimization-sheet:loadMetier', err);
    }
  }

  protected async onMetierChange(m: string): Promise<void> {
    const metier = m as FleetMetier;
    const prev = this.metier();
    this.metier.set(metier);
    try {
      await firstValueFrom(this.ai.setFleetMetier({ fleetId: this.selectedFleetId() ?? undefined, metier }));
      this.toast.success('Métier mis à jour', this.metierLabel(metier));
    } catch (e) {
      swallow('optimization-sheet:onMetierChange', e);
      this.metier.set(prev);
      this.toast.error('Échec', this.errMsg(e));
    }
  }

  private async loadUtil(): Promise<void> {
    this.utilLoading.set(true);
    try {
      this.util.set(await firstValueFrom(this.agendaApi.getUtilization({ fleetId: this.selectedFleetId() ?? undefined })));
    } catch (err) {
      swallow('optimization-sheet:loadUtil', err);
      this.util.set(null);
    } finally {
      this.utilLoading.set(false);
    }
  }

  /**
   * Lance l'analyse des capacités EN ARRIÈRE-PLAN : ferme la feuille ; une pastille en haut de
   * l'agenda montre l'avancement (« l'IA travaille… ») puis « Résultats prêts » → le clic ré-ouvre
   * CETTE feuille avec les capacités à valider pré-chargées. Fini le spinner bloquant sans retour.
   */
  protected runCapacity(): void {
    if (this.needsFleet()) { this.capError.set('Choisissez une société dans le bandeau pour analyser son parc.'); return; }
    // Anti-double-lancement (feuille encore montée ~220 ms après fermeture) : évite 2 analyses.
    if (this.aiJob.hasRunningOf('optimization')) { this.closed.emit(); return; }
    const fleetId = this.selectedFleetId();
    this.aiJob.run({
      kind: 'optimization',
      title: 'Analyse des capacités',
      hint: 'L\'IA déduit les places par modèle de véhicule à partir du parc. Ça prend quelques secondes…',
      // P1-5 : le résultat est mémorisé DÈS qu'il arrive, avant même que la pastille l'annonce —
      // un rechargement entre les deux ne coûte plus une seconde analyse.
      task: firstValueFrom(this.ai.capacitySuggest({ fleetId: fleetId ?? undefined })).then((r) => {
        this.memoriserCapacite(r);
        return r;
      }),
      summarize: (r) =>
        r.proposals.length
          ? `${r.proposals.length} véhicule(s) dont la capacité peut être complétée (places / équipements).`
          : 'Aucune capacité à compléter : le parc semble déjà renseigné.',
    });
    this.closed.emit(); // suivi dans la pastille ; « Voir » ré-ouvre avec le résultat.
  }

  protected toggleSel(id: string): void {
    if (!this.canApply()) return;
    const next = new Set(this.selected());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.selected.set(next);
  }
  protected toggleAll(): void {
    const r = this.capResult();
    if (!r) return;
    this.selected.set(this.allSelected() ? new Set() : new Set(r.proposals.map((p) => p.vehicleId)));
  }

  protected async applySel(): Promise<void> {
    const r = this.capResult();
    if (!r) return;
    const items = r.proposals
      .filter((p) => this.selected().has(p.vehicleId))
      .map((p) => ({ vehicleId: p.vehicleId, seats: p.seats, features: p.features }));
    if (items.length === 0) return;
    this.applying.set(true);
    this.capError.set(null);
    try {
      const res = await firstValueFrom(this.ai.capacityApply({ items }));
      this.toast.success('Capacité appliquée', `${res.updated} véhicule(s) mis à jour.`);
      this.selected.set(new Set());
      // P1-5 : appliqué = consommé. Ce qui reste en mémoire décrirait des véhicules déjà à jour.
      this.oublierCapacite();
      this.capResult.set(null);
      this.capConserveLe.set(null);
      this.applied.emit();
    } catch (e) {
      swallow('optimization-sheet:Set', e);
      this.capError.set(this.errMsg(e));
    } finally {
      this.applying.set(false);
    }
  }

  private errMsg(e: unknown): string {
    if (e instanceof HttpErrorResponse && e.status === 503) {
      return apiErrorMessage(e, 'Copilote IA non configuré côté serveur (ANTHROPIC_API_KEY).');
    }
    return apiErrorMessage(e, e instanceof HttpErrorResponse ? `Erreur (${e.status}).` : 'Une erreur est survenue.');
  }
}
