import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { DecimalPipe, NgClass } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  LucideAngularModule,
  Sparkles, Truck, CalendarCheck, AlertTriangle, Info, Users, Check, Copy, Code, X, Loader,
} from 'lucide-angular';
import {
  FLEET_METIER_LABELS,
  type AiCapacityProposalDto,
  type AiCapacityResultDto,
  type AiPlacementResultDto,
  type FleetMetier,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AiApiService } from '../../core/services/ai.service';
import { AuthService } from '../../core/services/auth.service';
import { FleetCacheService } from '../../core/services/fleet-cache.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { BottomSheetComponent } from '../../shared/ui/bottom-sheet/bottom-sheet.component';

const METIERS: FleetMetier[] = ['CHILDREN_TRANSPORT', 'PARCELS', 'RENTAL', 'GENERIC'];

function toLocalInput(d: Date): string {
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

@Component({
  selector: 'app-ai-optimization',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, NgClass, LucideAngularModule, BottomSheetComponent],
  template: `
    <div class="aio">
      <!-- Header -->
      <header class="aio-head">
        <div class="aio-head-txt">
          <h1 class="aio-h1">
            <lucide-icon [img]="SparklesIcon" [size]="20" class="aio-h1-ic"></lucide-icon>
            Optimisation IA
          </h1>
          <p class="aio-lead">L'IA <strong>propose</strong>, vous <strong>validez</strong>. Rien n'est écrit sans votre accord.</p>
        </div>
        @if (isSuperAdmin() && fleetOptions().length > 0) {
          <label class="aio-fleet">
            <span class="aio-fleet-lbl">Flotte</span>
            <select class="aio-input aio-input--sm" [value]="selectedFleetId() ?? ''" (change)="onFleetChange($any($event.target).value)">
              <option value="" disabled>Choisir…</option>
              @for (f of fleetOptions(); track f.id) { <option [value]="f.id">{{ f.name }}</option> }
            </select>
          </label>
        }
      </header>

      <!-- Métier -->
      <section class="aio-card aio-metier">
        <div class="aio-metier-l">
          <span class="aio-metier-lbl">Métier de la flotte</span>
          @if (metierLoading()) {
            <span class="aio-metier-cur aio-muted">…</span>
          } @else if (metier()) {
            <span class="aio-metier-cur">{{ metierLabel(metier()!) }}</span>
          } @else {
            <span class="aio-metier-cur aio-muted">{{ metierError() || (needsFleet() ? 'Sélectionnez une flotte' : 'Non déterminé') }}</span>
          }
        </div>
        @if (canEditMetier() && metier()) {
          <select class="aio-input aio-input--sm" [value]="metier()!" (change)="onMetierChange($any($event.target).value)">
            @for (m of metiers; track m) { <option [value]="m">{{ metierLabel(m) }}</option> }
          </select>
        }
        <p class="aio-metier-hint">
          <lucide-icon [img]="InfoIcon" [size]="12"></lucide-icon>
          Conditionne l'objectif de l'IA : enfants → places/sièges-enfant · colis → charge · location → disponibilité.
        </p>
      </section>

      <!-- Onglets -->
      <div class="aio-seg" role="tablist" aria-label="Mode">
        <button type="button" role="tab" class="aio-seg-btn" [class.aio-seg-btn--on]="tab() === 'capacity'" (click)="tab.set('capacity')">
          <lucide-icon [img]="TruckIcon" [size]="15"></lucide-icon> Capacité du parc
        </button>
        <button type="button" role="tab" class="aio-seg-btn" [class.aio-seg-btn--on]="tab() === 'placement'" (click)="tab.set('placement')">
          <lucide-icon [img]="CalendarCheckIcon" [size]="15"></lucide-icon> Placement
        </button>
      </div>

      <!-- ═══════════════ CAPACITÉ ═══════════════ -->
      @if (tab() === 'capacity') {
        <section class="aio-card">
          <div class="aio-card-head">
            <h2 class="aio-card-title"><lucide-icon [img]="TruckIcon" [size]="16" class="aio-accent"></lucide-icon> Compléter la capacité</h2>
            <div class="aio-actions">
              <button type="button" class="aio-btn aio-btn--ghost" [disabled]="previewLoading() || needsFleet()" (click)="openCapacityPreview()">
                <lucide-icon [img]="CodeIcon" [size]="14"></lucide-icon> <span class="aio-btn-txt">Voir le payload</span>
              </button>
              <button type="button" class="aio-btn aio-btn--primary" [disabled]="capLoading() || needsFleet()" (click)="runCapacity()">
                <lucide-icon [img]="SparklesIcon" [size]="14"></lucide-icon> {{ capLoading() ? 'Analyse…' : 'Analyser le parc' }}
              </button>
            </div>
          </div>
          <p class="aio-sub">
            L'IA déduit les places et places-enfant par modèle (ex. Jumpy/Expert : 9 ou 2 places) avec un niveau de confiance.
            <strong>Vérifiez</strong> puis appliquez — un Jumpy peut être un fourgon comme une navette.
          </p>

          @if (needsFleet()) {
            <div class="aio-alert aio-alert--warn"><lucide-icon [img]="InfoIcon" [size]="14"></lucide-icon> Sélectionnez une flotte (en haut) pour analyser son parc.</div>
          }
          @if (capError()) {
            <div class="aio-alert aio-alert--err"><lucide-icon [img]="AlertIcon" [size]="14"></lucide-icon> {{ capError() }}</div>
          }

          @if (capLoading()) {
            <div class="aio-cap-grid">
              <div class="aio-skel"></div><div class="aio-skel"></div><div class="aio-skel"></div><div class="aio-skel"></div>
            </div>
          } @else if (capResult(); as r) {
            @if (r.proposals.length === 0) {
              <div class="aio-empty"><lucide-icon [img]="TruckIcon" [size]="40" class="aio-empty-ic"></lucide-icon><p>Aucune proposition (parc vide ou hors périmètre).</p></div>
            } @else {
              @if (canApply()) {
                <div class="aio-selbar">
                  <button type="button" class="aio-link" (click)="toggleAll()">{{ allSelected() ? 'Tout désélectionner' : 'Tout sélectionner' }}</button>
                  <span class="aio-selcount">{{ selected().size }} / {{ r.proposals.length }} sélectionné(s)</span>
                </div>
              } @else {
                <div class="aio-alert aio-alert--info"><lucide-icon [img]="InfoIcon" [size]="14"></lucide-icon> Consultation seule — le droit « Modifier un véhicule » est requis pour appliquer.</div>
              }

              <div class="aio-cap-grid">
                @for (p of r.proposals; track p.vehicleId) {
                  <button type="button" class="aio-cap-card"
                          [class.aio-cap-card--sel]="canApply() && selected().has(p.vehicleId)"
                          [class.aio-cap-card--ro]="!canApply()"
                          [disabled]="!canApply()"
                          (click)="toggleSel(p.vehicleId)">
                    <div class="aio-cap-top">
                      <div class="aio-cap-id">
                        <span class="aio-plate">{{ p.plate || '—' }}</span>
                        @if (p.model) { <span class="aio-model">{{ p.model }}</span> }
                      </div>
                      <span class="aio-chip" [ngClass]="confClass(p.confidence)">{{ p.confidence * 100 | number:'1.0-0' }}%</span>
                    </div>
                    <div class="aio-cap-vals">
                      <div class="aio-cap-val"><span class="aio-cap-k">Places</span><span class="aio-cap-v">{{ valOf(p.seats) }}</span></div>
                      <div class="aio-cap-val"><span class="aio-cap-k">Sièges-enfant</span><span class="aio-cap-v">{{ valOf(p.childSeats) }}</span></div>
                    </div>
                    @if (p.features.length > 0) {
                      <div class="aio-feats">@for (f of p.features; track f) { <span class="aio-feat">{{ f }}</span> }</div>
                    }
                    @if (p.reasoning) { <p class="aio-cap-reason">{{ p.reasoning }}</p> }
                    @if (canApply()) {
                      <span class="aio-cap-check" [class.on]="selected().has(p.vehicleId)" aria-hidden="true">
                        @if (selected().has(p.vehicleId)) { <lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon> }
                      </span>
                    }
                  </button>
                }
              </div>

              @if (canApply()) {
                <div class="aio-foot">
                  <button type="button" class="aio-btn aio-btn--primary aio-btn--lg" [disabled]="applying() || selected().size === 0" (click)="applySelected()">
                    @if (applying()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="aio-spin"></lucide-icon> }
                    {{ applying() ? 'Application…' : 'Appliquer (' + selected().size + ')' }}
                  </button>
                </div>
              }
            }
          } @else if (!needsFleet()) {
            <div class="aio-empty aio-empty--hint">
              <lucide-icon [img]="SparklesIcon" [size]="36" class="aio-empty-ic"></lucide-icon>
              <p>Lancez l'analyse pour obtenir des propositions de capacité.</p>
            </div>
          }
        </section>
      }

      <!-- ═══════════════ PLACEMENT ═══════════════ -->
      @if (tab() === 'placement') {
        <section class="aio-card">
          <h2 class="aio-card-title"><lucide-icon [img]="CalendarCheckIcon" [size]="16" class="aio-accent"></lucide-icon> Meilleur placement</h2>
          <p class="aio-sub">
            L'IA classe les véhicules <strong>disponibles</strong> : adéquation au besoin, bon dimensionnement, mutualisation
            des sous-utilisés. Elle ne réserve rien — vous validez ensuite dans Réservations.
          </p>
          @if (isSuperAdmin()) {
            <div class="aio-alert aio-alert--info"><lucide-icon [img]="InfoIcon" [size]="14"></lucide-icon> Super-admin : le placement couvre toutes les flottes (objectif générique). Pour un placement métier (ex. CDEF), utilisez un compte rattaché à la flotte.</div>
          }

          <div class="aio-form">
            <label class="aio-field"><span>Début</span><input type="datetime-local" class="aio-input" [value]="startAt()" (input)="startAt.set($any($event.target).value)"></label>
            <label class="aio-field"><span>Fin</span><input type="datetime-local" class="aio-input" [value]="endAt()" (input)="endAt.set($any($event.target).value)"></label>
            <label class="aio-field aio-field--sm"><span>Places min.</span><input type="number" min="0" inputmode="numeric" class="aio-input" [value]="minSeats()" (input)="minSeats.set($any($event.target).value)"></label>
            <label class="aio-field aio-field--sm"><span>Sièges-enfant min.</span><input type="number" min="0" inputmode="numeric" class="aio-input" [value]="minChildSeats()" (input)="minChildSeats.set($any($event.target).value)"></label>
          </div>
          <div class="aio-actions aio-actions--form">
            <button type="button" class="aio-btn aio-btn--ghost" [disabled]="previewLoading()" (click)="openPlacementPreview()">
              <lucide-icon [img]="CodeIcon" [size]="14"></lucide-icon> <span class="aio-btn-txt">Voir le payload</span>
            </button>
            <button type="button" class="aio-btn aio-btn--primary" [disabled]="plLoading()" (click)="runPlacement()">
              <lucide-icon [img]="SparklesIcon" [size]="14"></lucide-icon> {{ plLoading() ? 'Analyse…' : 'Suggérer avec l\\'IA' }}
            </button>
          </div>

          @if (plError()) {
            <div class="aio-alert aio-alert--err"><lucide-icon [img]="AlertIcon" [size]="14"></lucide-icon> {{ plError() }}</div>
          }

          @if (plLoading()) {
            <div class="aio-pl-grid"><div class="aio-skel"></div><div class="aio-skel"></div><div class="aio-skel"></div></div>
          } @else if (plResult(); as r) {
            @if (r.noGoodMatch) {
              <div class="aio-alert aio-alert--warn"><lucide-icon [img]="AlertIcon" [size]="14"></lucide-icon> {{ r.notes || 'Aucun véhicule ne couvre correctement le besoin sur ce créneau.' }}</div>
            }
            @if (r.proposals.length > 0) {
              <div class="aio-pl-grid">
                @for (p of r.proposals; track p.vehicleId; let i = $index) {
                  <div class="aio-pl" [class.aio-pl--top]="i === 0">
                    <div class="aio-pl-top">
                      <span class="aio-rank">#{{ i + 1 }}</span>
                      <span class="aio-plate">{{ p.plate || '—' }}</span>
                      <span class="aio-chip" [ngClass]="confClass(p.score)">{{ p.score * 100 | number:'1.0-0' }}%</span>
                    </div>
                    <div class="aio-pl-meta"><lucide-icon [img]="UsersIcon" [size]="12"></lucide-icon> {{ valOf(p.seats) }} places · {{ valOf(p.childSeats) }} sièges-enfant</div>
                    <p class="aio-pl-reason">{{ p.reasoning }}</p>
                  </div>
                }
              </div>
            }
          }
        </section>
      }
    </div>

    <!-- Aperçu du payload (testable Console) -->
    <app-bottom-sheet [open]="previewOpen()" ariaLabel="Aperçu du payload IA" (closed)="previewOpen.set(false)">
      <div class="aio-prev">
        <div class="aio-prev-head">
          <h3 class="aio-prev-title"><lucide-icon [img]="CodeIcon" [size]="15"></lucide-icon> {{ previewTitle() }}</h3>
          <button type="button" class="aio-iconbtn" (click)="previewOpen.set(false)" aria-label="Fermer"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
        </div>
        <p class="aio-prev-sub">Données <strong>réelles &amp; à jour</strong> de votre parc — exactement ce que reçoit Claude. Collez-le dans la Console (Opus 4.8) pour tester.</p>
        <pre class="aio-prev-json">{{ previewJson() }}</pre>
        <div class="aio-prev-foot">
          <button type="button" class="aio-btn aio-btn--primary aio-btn--lg" (click)="copyPreview()">
            <lucide-icon [img]="CopyIcon" [size]="15"></lucide-icon> Copier le payload
          </button>
        </div>
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    :host { display: block; }
    .aio { display: flex; flex-direction: column; gap: 14px; }

    /* Header */
    .aio-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .aio-h1 { display: flex; align-items: center; gap: 8px; font-size: 22px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .aio-h1-ic { color: var(--tracky-light); }
    .aio-lead { font-size: 13px; color: var(--fg-tertiary); margin-top: 2px; }
    .aio-accent { color: var(--tracky-light); }
    .aio-muted { color: var(--fg-muted, var(--fg-tertiary)); }
    .aio-fleet { display: flex; align-items: center; gap: 8px; }
    .aio-fleet-lbl { font-size: 12px; color: var(--fg-tertiary); }

    /* Card */
    .aio-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; padding: 16px; }
    .aio-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .aio-card-title { font-size: 15px; font-weight: 700; color: var(--fg-primary); display: flex; align-items: center; gap: 7px; font-family: var(--font-display, inherit); }
    .aio-sub { font-size: 12.5px; color: var(--fg-tertiary); margin: 8px 0 12px; line-height: 1.5; }

    /* Inputs — 16px évite le zoom auto iOS */
    .aio-input { width: 100%; padding: 10px 12px; border-radius: 10px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-primary); font-size: 16px; }
    .aio-input--sm { width: auto; padding: 7px 10px; font-size: 14px; }
    .aio-input:focus { outline: none; border-color: var(--tracky-light); box-shadow: 0 0 0 2px rgba(16,224,160,.1); }

    /* Métier */
    .aio-metier { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .aio-metier-l { display: flex; flex-direction: column; }
    .aio-metier-lbl { font-size: 11.5px; color: var(--fg-tertiary); }
    .aio-metier-cur { font-size: 17px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .aio-metier-hint { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--fg-muted, var(--fg-tertiary)); flex-basis: 100%; line-height: 1.4; }

    /* Segmented */
    .aio-seg { display: flex; gap: 2px; padding: 3px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .aio-seg-btn { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 12px; border-radius: 9px; font-size: 13px; font-weight: 600; color: var(--fg-tertiary); transition: all .15s; min-height: 40px; }
    .aio-seg-btn--on { background: var(--bg-primary); color: var(--tracky-light); box-shadow: 0 1px 2px rgba(0,0,0,.14); }

    /* Buttons */
    .aio-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .aio-actions--form { justify-content: flex-end; margin-top: 4px; }
    .aio-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 14px; border-radius: 10px; font-size: 13px; font-weight: 700; transition: all .15s; min-height: 40px; }
    .aio-btn--lg { padding: 11px 20px; }
    .aio-btn--primary { background: var(--tracky, #10B981); color: #fff; box-shadow: 0 2px 8px rgba(5,150,105,.28); }
    .aio-btn--primary:hover:not(:disabled) { filter: brightness(1.08); }
    .aio-btn--primary:active:not(:disabled) { transform: scale(.98); }
    .aio-btn--ghost { background: var(--bg-tertiary); color: var(--fg-secondary); border: 1px solid var(--border-subtle); }
    .aio-btn--ghost:hover:not(:disabled) { color: var(--fg-primary); }
    .aio-btn:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }
    .aio-link { font-size: 12.5px; font-weight: 600; color: var(--tracky-light); cursor: pointer; }
    .aio-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 9px; color: var(--fg-tertiary); }
    .aio-iconbtn:hover { color: var(--fg-primary); background: var(--bg-tertiary); }

    /* Selection bar */
    .aio-selbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 12px 0 8px; }
    .aio-selcount { font-size: 12px; color: var(--fg-tertiary); }

    /* Chips / badges */
    .aio-chip { font-size: 12px; font-weight: 800; padding: 2px 9px; border-radius: 999px; white-space: nowrap; }
    .aio-chip--hi { color: #10B981; background: rgba(16,185,129,.13); }
    .aio-chip--mid { color: #F59E0B; background: rgba(245,158,11,.14); }
    .aio-chip--lo { color: #EF4444; background: rgba(239,68,68,.13); }
    .aio-plate { font-weight: 800; color: var(--fg-primary); letter-spacing: .3px; }
    .aio-model { font-size: 11.5px; color: var(--fg-tertiary); display: block; margin-top: 1px; }

    /* Capacity cards (mobile-first: 1 col → grid) */
    .aio-cap-grid { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 4px; }
    @media (min-width: 640px) { .aio-cap-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 1100px) { .aio-cap-grid { grid-template-columns: repeat(3, 1fr); } }
    .aio-cap-card { position: relative; text-align: left; padding: 13px; border-radius: 14px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); transition: all .15s; }
    .aio-cap-card:not(.aio-cap-card--ro) { cursor: pointer; }
    .aio-cap-card:not(.aio-cap-card--ro):active { transform: scale(.99); }
    .aio-cap-card--sel { border-color: var(--tracky-light); box-shadow: 0 0 0 1px var(--tracky-light) inset; background: rgba(16,224,160,.06); }
    .aio-cap-card--ro { opacity: .96; }
    .aio-cap-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .aio-cap-id { min-width: 0; }
    .aio-cap-vals { display: flex; gap: 18px; margin-top: 10px; }
    .aio-cap-val { display: flex; flex-direction: column; }
    .aio-cap-k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); }
    .aio-cap-v { font-size: 17px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .aio-cap-reason { font-size: 12px; color: var(--fg-secondary); margin-top: 9px; line-height: 1.45; }
    .aio-feats { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
    .aio-feat { font-size: 10.5px; font-weight: 600; padding: 2px 7px; border-radius: 6px; background: var(--bg-secondary); color: var(--fg-tertiary); border: 1px solid var(--border-subtle); }
    .aio-cap-check { position: absolute; top: 11px; right: 11px; width: 20px; height: 20px; border-radius: 6px; border: 1.5px solid var(--border-strong, var(--border-subtle)); display: none; align-items: center; justify-content: center; color: #fff; }
    .aio-cap-card:not(.aio-cap-card--ro) .aio-cap-check { display: flex; }
    .aio-cap-check.on { background: var(--tracky-light); border-color: var(--tracky-light); }
    /* le check chevauche le chip : on décale le chip pour les cartes sélectionnables */
    .aio-cap-card:not(.aio-cap-card--ro) .aio-cap-top { padding-right: 26px; }

    .aio-foot { display: flex; justify-content: flex-end; margin-top: 14px; }

    /* Form placement */
    .aio-form { display: grid; grid-template-columns: 1fr; gap: 10px; }
    @media (min-width: 560px) { .aio-form { grid-template-columns: 1fr 1fr; } }
    .aio-field { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--fg-tertiary); }
    .aio-field > span { font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }

    /* Placement cards */
    .aio-pl-grid { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 12px; }
    @media (min-width: 640px) { .aio-pl-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 1100px) { .aio-pl-grid { grid-template-columns: repeat(3, 1fr); } }
    .aio-pl { padding: 13px; border-radius: 14px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .aio-pl--top { border-color: rgba(16,224,160,.4); box-shadow: 0 0 0 1px rgba(16,224,160,.22) inset; }
    .aio-pl-top { display: flex; align-items: center; gap: 8px; }
    .aio-rank { font-size: 12px; font-weight: 800; color: var(--fg-tertiary); }
    .aio-pl-top .aio-plate { flex: 1; }
    .aio-pl-top .aio-chip { margin-left: auto; }
    .aio-pl-meta { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--fg-tertiary); margin-top: 7px; }
    .aio-pl-reason { font-size: 12.5px; color: var(--fg-secondary); margin-top: 7px; line-height: 1.45; }

    /* Alerts / states */
    .aio-alert { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 10px; font-size: 12.5px; margin-top: 10px; line-height: 1.4; }
    .aio-alert--err { background: rgba(239,68,68,.1); color: #EF4444; }
    .aio-alert--warn { background: rgba(245,158,11,.12); color: #B45309; }
    .aio-alert--info { background: var(--bg-tertiary); color: var(--fg-tertiary); border: 1px solid var(--border-subtle); }
    .aio-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 26px; text-align: center; font-size: 13px; color: var(--fg-tertiary); }
    .aio-empty-ic { opacity: .3; }
    .aio-empty--hint { color: var(--fg-tertiary); }
    .aio-skel { height: 96px; border-radius: 14px; background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: aio-sh 1.3s infinite; }
    @keyframes aio-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .aio-spin { animation: aio-spin 1s linear infinite; }
    @keyframes aio-spin { to { transform: rotate(360deg); } }
    .aio-btn-txt { white-space: nowrap; }

    /* Preview sheet */
    .aio-prev { display: flex; flex-direction: column; padding: 4px 4px 0; }
    .aio-prev-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .aio-prev-title { display: flex; align-items: center; gap: 7px; font-size: 15px; font-weight: 700; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .aio-prev-sub { font-size: 12px; color: var(--fg-tertiary); margin: 6px 0 10px; line-height: 1.45; }
    .aio-prev-json { max-height: 50dvh; overflow: auto; -webkit-overflow-scrolling: touch; margin: 0; padding: 12px; border-radius: 12px; background: var(--bg-primary); border: 1px solid var(--border-subtle); font-family: var(--font-mono, monospace); font-size: 11.5px; line-height: 1.5; color: var(--fg-secondary); white-space: pre; }
    .aio-prev-foot { display: flex; justify-content: flex-end; padding: 12px 0 max(8px, env(safe-area-inset-bottom)); }

    @media (max-width: 480px) {
      .aio-h1 { font-size: 20px; }
      .aio-actions { width: 100%; }
      .aio-card-head .aio-actions { width: 100%; }
      .aio-btn { flex: 1; }
      .aio-btn-txt { display: inline; }
    }
  `],
})
export class AiOptimizationComponent implements OnInit {
  private readonly api = inject(AiApiService);
  private readonly auth = inject(AuthService);
  private readonly fleetCache = inject(FleetCacheService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);

  protected readonly SparklesIcon = Sparkles;
  protected readonly TruckIcon = Truck;
  protected readonly CalendarCheckIcon = CalendarCheck;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly InfoIcon = Info;
  protected readonly UsersIcon = Users;
  protected readonly CheckIcon = Check;
  protected readonly CopyIcon = Copy;
  protected readonly CodeIcon = Code;
  protected readonly XIcon = X;
  protected readonly LoaderIcon = Loader;
  protected readonly metiers = METIERS;

  protected readonly tab = signal<'capacity' | 'placement'>('capacity');

  // Flotte / métier
  protected readonly selectedFleetId = signal<string | null>(null);
  protected readonly metier = signal<FleetMetier | null>(null);
  protected readonly metierLoading = signal(false);
  protected readonly metierError = signal<string | null>(null);
  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  protected readonly canEditMetier = computed(() => {
    const r = this.auth.user()?.role;
    return r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN';
  });
  protected readonly fleetOptions = computed(() =>
    [...this.fleetCache.fleets().entries()].map(([id, name]) => ({ id, name })),
  );
  protected readonly canApply = computed(() => this.perms.can('vehicles_edit'));
  protected readonly needsFleet = computed(() => this.isSuperAdmin() && !this.selectedFleetId());

  // Capacité
  protected readonly capLoading = signal(false);
  protected readonly capError = signal<string | null>(null);
  protected readonly capResult = signal<AiCapacityResultDto | null>(null);
  protected readonly selected = signal<Set<string>>(new Set());
  protected readonly applying = signal(false);
  protected readonly allSelected = computed(() => {
    const r = this.capResult();
    return !!r && r.proposals.length > 0 && r.proposals.every((p) => this.selected().has(p.vehicleId));
  });

  // Placement
  protected readonly startAt = signal('');
  protected readonly endAt = signal('');
  protected readonly minSeats = signal('');
  protected readonly minChildSeats = signal('');
  protected readonly plLoading = signal(false);
  protected readonly plError = signal<string | null>(null);
  protected readonly plResult = signal<AiPlacementResultDto | null>(null);

  // Aperçu payload
  protected readonly previewOpen = signal(false);
  protected readonly previewLoading = signal(false);
  protected readonly previewTitle = signal('Payload');
  protected readonly previewJson = signal('');

  ngOnInit(): void {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    now.setHours(now.getHours() + 1);
    this.startAt.set(toLocalInput(now));
    this.endAt.set(toLocalInput(new Date(now.getTime() + 60 * 60 * 1000)));
    void this.fleetCache.loadIfNeeded();
    if (!this.isSuperAdmin()) void this.loadMetier();
  }

  protected metierLabel(m: FleetMetier): string {
    return FLEET_METIER_LABELS[m];
  }
  protected valOf(n: number | null): string {
    return n === null || n === undefined ? '—' : String(n);
  }

  protected onFleetChange(id: string): void {
    this.selectedFleetId.set(id || null);
    this.capResult.set(null);
    this.selected.set(new Set());
    void this.loadMetier();
  }

  private async loadMetier(): Promise<void> {
    this.metierLoading.set(true);
    this.metierError.set(null);
    this.metier.set(null);
    try {
      const res = await firstValueFrom(this.api.getFleetMetier(this.selectedFleetId() ?? undefined));
      this.metier.set(res.metier);
    } catch (e) {
      this.metierError.set(this.needsFleet() ? 'Sélectionnez une flotte' : this.errMsg(e));
    } finally {
      this.metierLoading.set(false);
    }
  }

  protected async onMetierChange(m: string): Promise<void> {
    const metier = m as FleetMetier;
    const prev = this.metier();
    this.metier.set(metier);
    try {
      await firstValueFrom(this.api.setFleetMetier({ fleetId: this.selectedFleetId() ?? undefined, metier }));
      this.toast.success('Métier mis à jour', this.metierLabel(metier));
    } catch (e) {
      this.metier.set(prev); // rollback
      this.toast.error('Échec', this.errMsg(e));
    }
  }

  // ─── Capacité ───
  protected async runCapacity(): Promise<void> {
    this.capLoading.set(true);
    this.capError.set(null);
    this.selected.set(new Set());
    try {
      const res = await firstValueFrom(this.api.capacitySuggest({ fleetId: this.selectedFleetId() ?? undefined }));
      this.capResult.set(res);
    } catch (e) {
      this.capError.set(this.errMsg(e));
    } finally {
      this.capLoading.set(false);
    }
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

  protected async applySelected(): Promise<void> {
    const r = this.capResult();
    if (!r) return;
    const items = r.proposals
      .filter((p: AiCapacityProposalDto) => this.selected().has(p.vehicleId))
      .map((p) => ({ vehicleId: p.vehicleId, seats: p.seats, childSeats: p.childSeats, features: p.features }));
    if (items.length === 0) return;
    this.applying.set(true);
    this.capError.set(null);
    try {
      const res = await firstValueFrom(this.api.capacityApply({ items }));
      this.toast.success('Capacité appliquée', `${res.updated} véhicule(s) mis à jour.`);
      this.selected.set(new Set());
    } catch (e) {
      this.capError.set(this.errMsg(e));
    } finally {
      this.applying.set(false);
    }
  }

  // ─── Placement ───
  private slotIso(): { startAt: string; endAt: string } | null {
    const start = this.startAt();
    const end = this.endAt();
    if (!start || !end) {
      this.plError.set('Renseignez le créneau (début et fin).');
      return null;
    }
    const startIso = new Date(start).toISOString();
    const endIso = new Date(end).toISOString();
    if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
      this.plError.set('La fin doit être après le début.');
      return null;
    }
    return { startAt: startIso, endAt: endIso };
  }

  protected async runPlacement(): Promise<void> {
    this.plError.set(null);
    const slot = this.slotIso();
    if (!slot) return;
    this.plLoading.set(true);
    try {
      const res = await firstValueFrom(
        this.api.placementSuggest({ ...slot, criteria: this.criteria() }),
      );
      this.plResult.set(res);
    } catch (e) {
      this.plError.set(this.errMsg(e));
    } finally {
      this.plLoading.set(false);
    }
  }

  private criteria() {
    return { minSeats: this.numOrUndef(this.minSeats()), minChildSeats: this.numOrUndef(this.minChildSeats()) };
  }

  // ─── Aperçu payload ───
  protected async openCapacityPreview(): Promise<void> {
    this.previewLoading.set(true);
    this.capError.set(null);
    try {
      const payload = await firstValueFrom(this.api.capacityPreview({ fleetId: this.selectedFleetId() ?? undefined }));
      this.previewTitle.set('Payload capacité');
      this.previewJson.set(JSON.stringify(payload, null, 2));
      this.previewOpen.set(true);
    } catch (e) {
      this.capError.set(this.errMsg(e));
    } finally {
      this.previewLoading.set(false);
    }
  }

  protected async openPlacementPreview(): Promise<void> {
    this.plError.set(null);
    const slot = this.slotIso();
    if (!slot) return;
    this.previewLoading.set(true);
    try {
      const payload = await firstValueFrom(this.api.placementPreview({ ...slot, criteria: this.criteria() }));
      this.previewTitle.set('Payload placement');
      this.previewJson.set(JSON.stringify(payload, null, 2));
      this.previewOpen.set(true);
    } catch (e) {
      this.plError.set(this.errMsg(e));
    } finally {
      this.previewLoading.set(false);
    }
  }

  protected async copyPreview(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.previewJson());
      this.toast.success('Copié', 'Payload copié — collez-le dans la Console Anthropic.');
    } catch {
      this.toast.error('Copie impossible', 'Sélectionnez et copiez le texte manuellement.');
    }
  }

  private numOrUndef(v: string): number | undefined {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  protected confClass(v: number): string {
    if (v >= 0.7) return 'aio-chip--hi';
    if (v >= 0.4) return 'aio-chip--mid';
    return 'aio-chip--lo';
  }

  private errMsg(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const m = (e.error as { message?: string } | null)?.message;
      if (m) return m;
      if (e.status === 503) {
        return "Copilote IA non configuré côté serveur (ANTHROPIC_API_KEY). À tester d'abord en Console.";
      }
      return `Erreur (${e.status}).`;
    }
    return 'Une erreur est survenue.';
  }
}
