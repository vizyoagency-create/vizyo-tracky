import { Component, DestroyRef, inject, input, OnInit, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { CalendarClock, Eye, EyeOff, LoaderCircle, LucideAngularModule, ShieldCheck, X } from 'lucide-angular';
import type { PrivacyModeEventDto } from '@vizyo/tracky-shared';
import { PrivacyModeApiService } from '../../core/services/privacy-mode.service';
import { WorkScheduleApiService } from '../../core/services/work-schedule.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

const DAY_LABEL: Record<string, string> = {
  monday: 'Lun', tuesday: 'Mar', wednesday: 'Mer', thursday: 'Jeu', friday: 'Ven', saturday: 'Sam', sunday: 'Dim',
};
const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const REASON_LABEL: Record<string, string> = {
  MANUAL: 'Privé — vous l\'avez activé',
  WORK_OVERRIDE: 'Suivi — exception « je travaille »',
  OUT_OF_HOURS: 'Privé — hors temps de travail',
  WORK_HOURS: 'Suivi — temps de travail',
  NO_SCHEDULE: 'Suivi — aucun horaire défini',
};

/**
 * Panneau conducteur « Vie privée & horaires » (RGPD, usage mixte). Le conducteur VOIT le cadre de
 * temps de travail défini par son employeur (transparence, il ne peut pas l'éditer), son état de
 * suivi courant, l'historique des changements, et peut passer SON véhicule en privé pour un usage
 * personnel — SAUF pendant une plage de temps de travail (refusé côté serveur).
 */
@Component({
  selector: 'app-driver-privacy-panel',
  standalone: true,
  imports: [LucideAngularModule, DatePipe],
  template: `
    <div class="dp-ov" (click)="close.emit()">
      <div class="dp-pan" (click)="$event.stopPropagation()">
        <header class="dp-head">
          <div class="dp-title"><lucide-icon [img]="ShieldCheck" [size]="18" /><div><div class="dp-t">Vie privée & horaires</div><div class="dp-s">{{ plate() }}</div></div></div>
          <button class="dp-x" (click)="close.emit()"><lucide-icon [img]="X" [size]="18" /></button>
        </header>

        @if (loading()) {
          <div class="dp-load"><lucide-icon [img]="LoaderCircle" [size]="22" class="spin" /></div>
        } @else {
          <div class="dp-eff" [class.dp-eff--priv]="isPrivate()">
            <lucide-icon [img]="isPrivate() ? EyeOff : Eye" [size]="16" />
            <span>{{ reasonLabel() }}</span>
          </div>

          <div class="dp-frame">
            <div class="dp-frame-h"><lucide-icon [img]="CalendarClock" [size]="14" /> Votre temps de travail (défini par l'employeur)</div>
            @if (frameEnabled()) {
              <div class="dp-days">
                @for (d of frameDays(); track d.key) {
                  <div class="dp-day" [class.dp-day--work]="d.work">
                    <span>{{ d.label }}</span>
                    <span class="dp-hrs">{{ d.work ? d.range : 'privé' }}</span>
                  </div>
                }
              </div>
              <p class="dp-note">Hors de ces plages (et jours fériés), votre position <strong>n'est pas enregistrée</strong>.</p>
            } @else {
              <p class="dp-note">Aucun horaire défini : ce véhicule est suivi en continu. Vous pouvez passer en privé ci-dessous pour un usage personnel.</p>
            }
          </div>

          <button class="dp-toggle" [class.dp-toggle--on]="isPrivate()" [disabled]="busy()" (click)="toggle()">
            <lucide-icon [img]="isPrivate() ? Eye : EyeOff" [size]="16" />
            {{ isPrivate() ? 'Reprendre le suivi' : 'Passer en privé (usage personnel)' }}
          </button>

          @if (history().length) {
            <div class="dp-hist">
              <div class="dp-hist-h">Historique</div>
              @for (h of history(); track h.id) {
                <div class="dp-hrow">
                  <lucide-icon [img]="h.enabled ? EyeOff : Eye" [size]="12" />
                  <span class="dp-hr-t">{{ h.enabled ? 'Passé en privé' : 'Suivi repris' }}</span>
                  <span class="dp-hr-d">{{ h.createdAt | date:'dd/MM HH:mm' }}</span>
                </div>
              }
            </div>
          }
        }
      </div>
    </div>
  `,
  styles: [`
    .dp-ov { position:fixed; inset:0; z-index:60; background:rgba(0,0,0,.55); display:flex; align-items:flex-end; justify-content:center; }
    @media(min-width:640px){ .dp-ov { align-items:center; padding:16px; } }
    .dp-pan { width:100%; max-width:440px; max-height:92dvh; overflow:auto; background:var(--bg-primary,#0A0F0E); border:1px solid var(--border-subtle,rgba(255,255,255,.1)); border-radius:16px 16px 0 0; padding:18px; box-sizing:border-box; }
    @media(min-width:640px){ .dp-pan { border-radius:16px; } }
    .dp-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
    .dp-title { display:flex; gap:10px; align-items:center; color:var(--tracky-light,#3EEBB8); }
    .dp-t { font-weight:700; font-size:15px; color:var(--fg-primary,#EAEFED); }
    .dp-s { font-family:var(--font-mono,monospace); font-size:12px; color:var(--fg-tertiary,#69736E); }
    .dp-x { background:none; border:none; color:var(--fg-tertiary,#69736E); cursor:pointer; padding:4px; }
    .dp-load { display:flex; justify-content:center; padding:40px; color:var(--tracky-light,#3EEBB8); }
    .spin { animation:dp-spin 1s linear infinite; } @keyframes dp-spin { to { transform:rotate(360deg); } }
    .dp-eff { display:flex; align-items:center; gap:8px; font-size:13.5px; font-weight:600; padding:12px; border-radius:11px; background:var(--bg-secondary,#101514); border:1px solid var(--border-subtle,rgba(255,255,255,.08)); color:var(--fg-secondary,#9BA5A1); margin-bottom:12px; }
    .dp-eff--priv { color:var(--tracky-light,#3EEBB8); border-color:rgba(16,224,160,.3); background:rgba(16,224,160,.06); }
    .dp-frame { padding:12px; border-radius:11px; background:var(--bg-secondary,#101514); border:1px solid var(--border-subtle,rgba(255,255,255,.07)); margin-bottom:12px; }
    .dp-frame-h { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:var(--fg-tertiary,#9BA5A1); margin-bottom:8px; }
    .dp-days { display:flex; flex-wrap:wrap; gap:5px; }
    .dp-day { flex:1 1 60px; display:flex; flex-direction:column; align-items:center; gap:2px; padding:6px 4px; border-radius:8px; background:var(--bg-tertiary,#161D1B); font-size:11px; color:var(--fg-tertiary,#69736E); }
    .dp-day--work { color:var(--fg-primary,#EAEFED); }
    .dp-hrs { font-size:10px; }
    .dp-day--work .dp-hrs { color:var(--tracky-light,#3EEBB8); }
    .dp-note { margin:9px 0 0; font-size:11.5px; line-height:1.5; color:var(--fg-tertiary,#9BA5A1); }
    .dp-note strong { color:var(--fg-secondary,#C7CFCB); }
    .dp-toggle { width:100%; display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:13px; border-radius:12px; border:1px solid var(--tracky,#10E0A0); background:var(--tracky,#10E0A0); color:#04130D; font-size:14px; font-weight:700; cursor:pointer; }
    .dp-toggle--on { background:transparent; color:var(--fg-secondary,#9BA5A1); border-color:var(--border-subtle,rgba(255,255,255,.16)); }
    .dp-toggle:disabled { opacity:.55; cursor:default; }
    .dp-hist { margin-top:16px; }
    .dp-hist-h { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--fg-tertiary,#69736E); margin-bottom:6px; }
    .dp-hrow { display:flex; align-items:center; gap:7px; padding:6px 0; font-size:12.5px; color:var(--fg-secondary,#9BA5A1); border-top:1px solid var(--border-subtle,rgba(255,255,255,.06)); }
    .dp-hr-t { flex:1; }
    .dp-hr-d { font-size:11px; color:var(--fg-tertiary,#69736E); }
  `],
})
export class DriverPrivacyPanelComponent implements OnInit {
  private readonly wsApi = inject(WorkScheduleApiService);
  private readonly pmApi = inject(PrivacyModeApiService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly vehicleId = input.required<string>();
  readonly plate = input<string>('');
  readonly close = output<void>();

  protected readonly ShieldCheck = ShieldCheck; protected readonly CalendarClock = CalendarClock;
  protected readonly Eye = Eye; protected readonly EyeOff = EyeOff; protected readonly X = X; protected readonly LoaderCircle = LoaderCircle;

  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly effReason = signal('NO_SCHEDULE');
  protected readonly isPrivate = signal(false);
  protected readonly frameEnabled = signal(false);
  protected readonly frameDays = signal<{ key: string; label: string; work: boolean; range: string }[]>([]);
  protected readonly history = signal<PrivacyModeEventDto[]>([]);

  protected reasonLabel(): string { return REASON_LABEL[this.effReason()] ?? this.effReason(); }

  ngOnInit(): void {
    this.load();
    this.pmApi.getHistory(this.vehicleId(), 15).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (h) => this.history.set(h ?? []), error: () => undefined });
  }

  private load(): void {
    this.wsApi.get(this.vehicleId()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => {
        this.effReason.set(s.effective?.reason ?? 'NO_SCHEDULE');
        this.isPrivate.set(!!s.effective?.isPrivate);
        this.frameEnabled.set(!!s.schedule?.enabled);
        const sc = s.schedule as Record<string, unknown> | null;
        this.frameDays.set(DAY_ORDER.map((k) => {
          const work = !!sc && sc[`${k}Enabled`] !== false && !!s.schedule?.enabled;
          const start = (sc?.[`${k}Start`] as string) ?? '08:00';
          const end = (sc?.[`${k}End`] as string) ?? '18:00';
          return { key: k, label: DAY_LABEL[k], work, range: `${start}–${end}` };
        }));
        this.loading.set(false);
      },
      error: () => { this.toast.error('Chargement impossible', 'Réessayez.'); this.loading.set(false); },
    });
  }

  protected toggle(): void {
    if (this.busy()) return;
    const target = !this.isPrivate();
    this.busy.set(true);
    this.pmApi.set(this.vehicleId(), target).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.toast.success(target ? 'Mode privé activé' : 'Suivi repris', this.plate());
        this.busy.set(false);
        this.load();
        this.pmApi.getHistory(this.vehicleId(), 15).pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({ next: (h) => this.history.set(h ?? []), error: () => undefined });
      },
      error: (e: unknown) => {
        const msg = (e as { error?: { message?: string } })?.error?.message;
        this.toast.error('Action impossible', typeof msg === 'string' ? msg : 'Réessayez.');
        this.busy.set(false);
      },
    });
  }
}
