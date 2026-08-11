import { Component, DestroyRef, inject, input, OnInit, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { CalendarClock, Eye, EyeOff, LoaderCircle, LucideAngularModule, X } from 'lucide-angular';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ETATS_VIE_PRIVEE, WorkScheduleApiService } from '../../core/services/work-schedule.service';

interface DayRow { key: string; label: string; enabled: boolean; start: string; end: string }

const DAY_DEFS: { key: string; label: string; work: boolean }[] = [
  { key: 'monday', label: 'Lundi', work: true },
  { key: 'tuesday', label: 'Mardi', work: true },
  { key: 'wednesday', label: 'Mercredi', work: true },
  { key: 'thursday', label: 'Jeudi', work: true },
  { key: 'friday', label: 'Vendredi', work: true },
  { key: 'saturday', label: 'Samedi', work: false },
  { key: 'sunday', label: 'Dimanche', work: false },
];

/**
 * ⚠️ Les deux raisons qui correspondent a un ETAT de `/privacy-coverage` sont lues depuis la
 * source partagee `ETATS_VIE_PRIVEE`, pas recopiees ici. B1 § E exige que les deux ecrans
 * emploient les MEMES MOTS ; deux chaines ecrites a deux endroits divergent a la premiere
 * reformulation, et personne ne s'en apercoit — sur un ecran qui sert de preuve en cas de
 * controle, c'est le genre de derive qui coute cher.
 *
 * Les quatre autres raisons sont propres a l'editeur (etats INSTANTANES du vehicule, pas des
 * etats de couverture) : elles restent ici.
 */
const REASON_LABEL: Record<string, string> = {
  NOT_MIXED_USE: ETATS_VIE_PRIVEE.NON_COUVERT.long,
  MANUAL: 'Privé — mode manuel',
  WORK_OVERRIDE: 'Tracé — exception « je travaille »',
  OUT_OF_HOURS: 'Privé — hors temps de travail',
  WORK_HOURS: 'Tracé — temps de travail',
  NO_SCHEDULE: 'Tracé — aucun cadre défini',
};

/**
 * Éditeur du CADRE de temps de travail d'un véhicule (usage mixte, RGPD). L'employeur (fleet-admin)
 * déclare les jours + heures de travail : HORS de ces plages, le véhicule passe automatiquement en
 * mode privé (positions non collectées). Toute édition est auditée côté serveur.
 */
@Component({
  selector: 'app-work-schedule-editor',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    <div class="ws-ov" (click)="close.emit()">
      <div class="ws-pan" (click)="$event.stopPropagation()">
        <header class="ws-head">
          <div class="ws-title">
            <lucide-icon [img]="CalendarClock" [size]="18" />
            <div>
              <div class="ws-t">Cadre de temps de travail</div>
              <div class="ws-s">{{ plate() }}</div>
            </div>
          </div>
          <button class="ws-x" (click)="close.emit()"><lucide-icon [img]="X" [size]="18" /></button>
        </header>

        @if (loading()) {
          <div class="ws-load"><lucide-icon [img]="LoaderCircle" [size]="22" class="spin" /></div>
        } @else {
          <div class="ws-eff" [class.ws-eff--priv]="effPrivate()">
            <lucide-icon [img]="effPrivate() ? EyeOff : Eye" [size]="15" />
            État actuel : <strong>{{ reasonLabel() }}</strong>
          </div>

          <label class="ws-main ws-main--mix">
            <input type="checkbox" [ngModel]="mixedUse()" (ngModelChange)="toggleMixedUse($event)" [disabled]="savingMix()" />
            <span>Véhicule à <strong>usage mixte</strong> (ramené au domicile)</span>
          </label>
          <p class="ws-hint">
            @if (mixedUse()) {
              Le cadre ci-dessous <strong>s'applique</strong> : hors des plages (et les jours fériés), aucune position n'est enregistrée.
            } @else {
              Ce véhicule est <strong>purement professionnel</strong> : il reste suivi 24/7 et son <strong>antivol fonctionne la nuit et le week-end</strong>.
              Le cadre ci-dessous est prêt mais ne s'applique pas. Activez l'usage mixte uniquement si le conducteur rentre avec le véhicule.
            }
          </p>

          <label class="ws-main">
            <input type="checkbox" [(ngModel)]="enabled" />
            <span>Activer le cadre de temps de travail</span>
          </label>
          <p class="ws-hint">Hors des plages déclarées ci-dessous (et les jours fériés), <strong>aucune position n'est enregistrée</strong> — à condition que l'usage mixte soit activé ci-dessus. Le conducteur voit ce cadre.</p>

          <div class="ws-days" [class.ws-days--off]="!enabled">
            @for (d of days; track d.key) {
              <div class="ws-day" [class.ws-day--on]="d.enabled">
                <label class="ws-daylab">
                  <input type="checkbox" [(ngModel)]="d.enabled" [disabled]="!enabled" />
                  <span>{{ d.label }}</span>
                </label>
                @if (d.enabled) {
                  <div class="ws-times">
                    <input type="time" [(ngModel)]="d.start" [disabled]="!enabled" />
                    <span>→</span>
                    <input type="time" [(ngModel)]="d.end" [disabled]="!enabled" />
                  </div>
                } @else {
                  <span class="ws-rest"><lucide-icon [img]="EyeOff" [size]="12" /> Privé toute la journée</span>
                }
              </div>
            }
          </div>

          <footer class="ws-foot">
            <button class="ws-btn" (click)="close.emit()">Fermer</button>
            @if (canManage) {
              <button class="ws-btn ws-btn--go" (click)="save()" [disabled]="saving()">
                {{ saving() ? 'Enregistrement…' : 'Enregistrer' }}
              </button>
            }
          </footer>
        }
      </div>
    </div>
  `,
  styles: [`
    .ws-ov { position:fixed; inset:0; z-index:9000; background:rgba(0,0,0,.55); display:flex; align-items:flex-end; justify-content:center; padding:0; }
    @media(min-width:640px){ .ws-ov { align-items:center; padding:16px; } }
    .ws-pan { width:100%; max-width:480px; max-height:92dvh; overflow:auto; background:var(--bg-primary,#0A0F0E); border:1px solid var(--border-subtle,rgba(255,255,255,.1)); border-radius:16px 16px 0 0; padding:18px; box-sizing:border-box; }
    @media(min-width:640px){ .ws-pan { border-radius:16px; } }
    .ws-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
    .ws-title { display:flex; gap:10px; align-items:center; color:var(--tracky,#10E0A0); }
    .ws-t { font-weight:700; font-size:15px; color:var(--fg-primary,#EAEFED); }
    .ws-s { font-family:var(--font-mono,monospace); font-size:12px; color:var(--fg-tertiary,#69736E); }
    .ws-x { background:none; border:none; color:var(--fg-tertiary,#69736E); cursor:pointer; padding:4px; }
    .ws-load { display:flex; justify-content:center; padding:40px; color:var(--tracky,#10E0A0); }
    .spin { animation:ws-spin 1s linear infinite; } @keyframes ws-spin { to { transform:rotate(360deg); } }
    .ws-eff { display:flex; align-items:center; gap:6px; font-size:12.5px; padding:9px 12px; border-radius:10px; background:var(--bg-secondary,#101514); border:1px solid var(--border-subtle,rgba(255,255,255,.08)); color:var(--fg-secondary,#9BA5A1); margin-bottom:14px; }
    .ws-eff--priv { color:var(--tracky,#10E0A0); border-color:rgba(16,224,160,.3); }
    .ws-eff strong { color:var(--fg-primary,#EAEFED); }
    .ws-main { display:flex; align-items:center; gap:10px; font-weight:600; font-size:14px; color:var(--fg-primary,#EAEFED); cursor:pointer; }
    .ws-main input { width:18px; height:18px; accent-color:var(--tracky,#10E0A0); }
    .ws-hint { margin:6px 0 14px; font-size:12px; line-height:1.5; color:var(--fg-tertiary,#9BA5A1); }
    .ws-hint strong { color:var(--fg-secondary,#C7CFCB); }
    .ws-days { display:flex; flex-direction:column; gap:6px; }
    .ws-days--off { opacity:.45; pointer-events:none; }
    .ws-day { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 12px; border-radius:10px; background:var(--bg-secondary,#101514); border:1px solid var(--border-subtle,rgba(255,255,255,.07)); }
    .ws-day--on { border-color:rgba(16,224,160,.25); }
    .ws-daylab { display:flex; align-items:center; gap:8px; font-size:13.5px; color:var(--fg-primary,#EAEFED); cursor:pointer; }
    .ws-daylab input { width:16px; height:16px; accent-color:var(--tracky,#10E0A0); }
    .ws-times { display:flex; align-items:center; gap:6px; }
    .ws-times input { background:var(--bg-tertiary,#161D1B); border:1px solid var(--border-subtle,rgba(255,255,255,.14)); border-radius:8px; color:var(--fg-primary,#EAEFED); padding:5px 7px; font-size:13px; }
    .ws-times span { color:var(--fg-tertiary,#69736E); }
    .ws-rest { display:inline-flex; align-items:center; gap:4px; font-size:11.5px; color:var(--fg-tertiary,#69736E); }
    .ws-foot { display:flex; gap:10px; margin-top:18px; }
    .ws-btn { flex:1; padding:11px; border-radius:11px; border:1px solid var(--border-subtle,rgba(255,255,255,.14)); background:transparent; color:var(--fg-secondary,#9BA5A1); font-size:14px; font-weight:600; cursor:pointer; }
    .ws-btn--go { background:var(--tracky,#10E0A0); color:#04130D; border-color:var(--tracky,#10E0A0); }
    .ws-btn:disabled { opacity:.55; cursor:default; }
  `],
})
export class WorkScheduleEditorComponent implements OnInit {
  private readonly api = inject(WorkScheduleApiService);
  private readonly toast = inject(ToastService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly vehicleId = input.required<string>();
  readonly plate = input<string>('');
  readonly close = output<void>();
  readonly changed = output<void>();

  protected readonly CalendarClock = CalendarClock; protected readonly X = X;
  protected readonly Eye = Eye; protected readonly EyeOff = EyeOff; protected readonly LoaderCircle = LoaderCircle;
  protected readonly canManage = this.perms.can('schedules_manage');

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly effReason = signal('NO_SCHEDULE');
  protected readonly effPrivate = signal(false);
  protected enabled = false;
  protected days: DayRow[] = DAY_DEFS.map((d) => ({ key: d.key, label: d.label, enabled: d.work, start: '08:00', end: '18:00' }));

  protected reasonLabel(): string { return REASON_LABEL[this.effReason()] ?? this.effReason(); }

  ngOnInit(): void {
    this.load();
  }

  /** (Re)charge le cadre + l'état effectif + l'usage mixte depuis le serveur. */
  protected load(): void {
    this.api.get(this.vehicleId()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => {
        this.effReason.set(s.effective?.reason ?? 'NO_SCHEDULE');
        this.effPrivate.set(!!s.effective?.isPrivate);
        this.mixedUse.set(!!s.mixedUseEnabled);
        if (s.schedule) {
          this.enabled = !!s.schedule.enabled;
          this.days = DAY_DEFS.map((d) => ({
            key: d.key,
            label: d.label,
            enabled: (s.schedule as Record<string, unknown>)[`${d.key}Enabled`] !== false,
            start: (s.schedule as Record<string, string | null>)[`${d.key}Start`] ?? '08:00',
            end: (s.schedule as Record<string, string | null>)[`${d.key}End`] ?? '18:00',
          }));
        }
        this.loading.set(false);
      },
      error: () => { this.toast.error('Chargement impossible', 'Réessayez.'); this.loading.set(false); },
    });
  }

  /** Usage mixte : interrupteur de proportionnalité (sans lui, le cadre ne s'applique pas). */
  protected readonly mixedUse = signal(false);
  protected readonly savingMix = signal(false);

  protected toggleMixedUse(value: boolean): void {
    this.savingMix.set(true);
    this.api.setMixedUse(this.vehicleId(), value).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.mixedUse.set(value); this.savingMix.set(false); this.changed.emit(); this.load(); },
      error: () => this.savingMix.set(false), // l'interrupteur reste sur l'état serveur
    });
  }

  protected save(): void {
    if (this.saving()) return;
    this.saving.set(true);
    const days: Record<string, { enabled: boolean; start: string | null; end: string | null }> = {};
    for (const d of this.days) days[d.key] = { enabled: d.enabled, start: d.enabled ? d.start : null, end: d.enabled ? d.end : null };
    this.api.set(this.vehicleId(), { enabled: this.enabled, timezone: 'Europe/Paris', countryCode: 'FR', days })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.toast.success('Cadre enregistré', this.plate());
          this.changed.emit();
          this.close.emit();
        },
        error: (e: unknown) => {
          const msg = (e as { error?: { message?: string } })?.error?.message;
          this.toast.error('Enregistrement impossible', typeof msg === 'string' ? msg : 'Réessayez.');
          this.saving.set(false);
        },
      });
  }
}
