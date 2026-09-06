import { Component, DestroyRef, inject, input, OnInit, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { CalendarClock, Eye, EyeOff, LoaderCircle, LucideAngularModule, X } from 'lucide-angular';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ETATS_VIE_PRIVEE, type EtatViePrivee, WorkScheduleApiService } from '../../core/services/work-schedule.service';

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
          <!-- L'état effectif, en tête — les mêmes mots et les mêmes couleurs que
               « Couverture vie privée ». Deux écrans qui décrivent le même fait
               doivent le nommer pareil. -->
          <div class="ws-etat" [attr.data-etat]="etatCouverture()">
            <div class="ws-etat-h">
              <lucide-icon [img]="etatCouverture() === 'PROTEGE' ? EyeOff : Eye" [size]="15" />
              <strong>{{ mots[etatCouverture()].long }}</strong>
            </div>
            <p class="ws-etat-s">{{ mots[etatCouverture()].sens }}</p>
            <!-- L'etat INSTANTANE n'ajoute rien quand l'usage mixte est eteint : il vaut
                 alors toujours la meme chose que le titre. On ne le repete pas. -->
            @if (mixedUse()) {
              <p class="ws-etat-i">À l'instant : {{ reasonLabel() }}</p>
            }
          </div>

          <label class="ws-main ws-main--mix">
            <input type="checkbox" [ngModel]="mixedUse()" (ngModelChange)="toggleMixedUse($event)" [disabled]="savingMix()" />
            <span>Véhicule à <strong>usage mixte</strong> (ramené au domicile)</span>
          </label>
          <p class="ws-hint">
            Le conducteur le ramène chez lui. C'est <strong>cet interrupteur</strong> qui autorise
            la protection de sa vie privée — les plages ci-dessous ne servent à rien sans lui.
          </p>

          @if (mixedUse()) {
            <!-- Les plages sont IMBRIQUÉES derrière le filet vert : on ne peut plus les
                 régler en croyant protéger quelqu'un alors que l'usage mixte est éteint.
                 La dépendance était dite en prose, en fin de paragraphe. -->
            <section class="ws-cadre">
              <h3 class="ws-cadre-t">Plages de travail déclarées</h3>
              <p class="ws-hint">
                En dehors — et les jours fériés — <strong>aucune position n'est enregistrée</strong>.
                Le conducteur voit ce cadre depuis son espace.
              </p>

              <label class="ws-main">
                <input type="checkbox" [(ngModel)]="enabled" />
                <span>Activer le cadre de temps de travail</span>
              </label>
              @if (!enabled) {
                <p class="ws-alerte">
                  Tant qu'il est éteint, <strong>rien n'est protégé</strong> : le véhicule reste suivi
                  en permanence, domicile compris.
                </p>
              }

              <div class="ws-days" [class.ws-days--off]="!enabled">
                @for (d of days; track d.key) {
                  <div class="ws-day" [class.ws-day--on]="d.enabled">
                    <label class="ws-daylab">
                      <input type="checkbox" [(ngModel)]="d.enabled" [disabled]="!enabled" />
                      <span>{{ d.label }}</span>
                    </label>
                    @if (d.enabled) {
                      <div class="ws-times">
                        <input type="time" [(ngModel)]="d.start" [disabled]="!enabled" aria-label="Début" />
                        <span>→</span>
                        <input type="time" [(ngModel)]="d.end" [disabled]="!enabled" aria-label="Fin" />
                      </div>
                    } @else {
                      <span class="ws-rest"><lucide-icon [img]="EyeOff" [size]="12" /> Non travaillé</span>
                    }
                  </div>
                }
              </div>

              <!-- Le calcul rend la protection TANGIBLE : « le cadre s'applique » ne dit
                   pas combien de temps le conducteur est effectivement laissé tranquille. -->
              @if (enabled) {
                <p class="ws-bilan">
                  Soit <strong>{{ heuresSansCollecte() }} h sur 168</strong> sans aucune collecte —
                  nuits, week-ends et fériés compris.
                </p>
              }
            </section>
          } @else {
            <!-- MASQUER plutôt que griser : un champ grisé invite à chercher comment
                 l'activer. Ici on explique pourquoi il n'est pas là. -->
            <section class="ws-pro">
              <h3 class="ws-pro-t">Éteint : ce véhicule est purement professionnel</h3>
              <p class="ws-pro-s">Ce que cela implique</p>
              <ul class="ws-pro-l">
                <li>Suivi <strong>24 h / 24</strong>, y compris la nuit et le week-end.</li>
                <li>L'<strong>antivol fonctionne</strong> la nuit et le week-end — c'est le bénéfice.</li>
                <li>Les plages horaires <strong>n'ont aucun effet</strong> : elles sont masquées, pas grisées.</li>
                <li>Reste correct tant que le véhicule <strong>ne rentre pas au domicile</strong>. S'il y rentre, la loi impose l'usage mixte.</li>
              </ul>
            </section>
          }

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
    .ws-pan { width:100%; max-width:480px; max-height: 92vh; max-height:92dvh; overflow:auto; background:var(--bg-primary,#0A0F0E); border:1px solid var(--border-subtle,rgba(255,255,255,.1)); border-radius:16px 16px 0 0; padding:18px; box-sizing:border-box; }
    @media(min-width:640px){ .ws-pan { border-radius:16px; } }
    .ws-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
    .ws-title { display:flex; gap:10px; align-items:center; color:var(--tracky,#10E0A0); }
    .ws-t { font-weight:700; font-size:15px; color:var(--fg-primary,#EAEFED); }
    .ws-s { font-family:var(--font-mono,monospace); font-size:12px; color:var(--fg-secondary); }
    .ws-x { background:none; border:none; color:var(--fg-secondary); cursor:pointer; width:44px; height:44px; display:inline-flex; align-items:center; justify-content:center; border-radius:10px; }
    .ws-load { display:flex; justify-content:center; padding:40px; color:var(--tracky,#10E0A0); }
    .spin { animation:ws-spin 1s linear infinite; } @keyframes ws-spin { to { transform:rotate(360deg); } }
    /* L'etat, aux memes couleurs que /privacy-coverage. */
    .ws-etat { padding:11px 13px; border-radius:12px; background:var(--bg-secondary); border:1px solid var(--border-subtle); margin-bottom:14px; }
    .ws-etat-h { display:flex; align-items:center; gap:7px; font-size:13.5px; color:var(--fg-primary); }
    .ws-etat-s { margin:5px 0 0; font-size:12px; line-height:1.5; color:var(--fg-secondary); }
    .ws-etat-i { margin:6px 0 0; font-size:11.5px; color:var(--fg-secondary); }
    .ws-etat[data-etat='PROTEGE'] { border-color:color-mix(in srgb, var(--color-tracky-light) 32%, transparent); }
    .ws-etat[data-etat='PROTEGE'] .ws-etat-h { color:var(--texte-succes); }
    .ws-etat[data-etat='MIXTE_SANS_CADRE'] { border-color:color-mix(in srgb, var(--warning) 34%, transparent); background:color-mix(in srgb, var(--warning) 8%, var(--bg-secondary)); }
    .ws-etat[data-etat='MIXTE_SANS_CADRE'] .ws-etat-h { color:var(--texte-attente); }

    /* 44 px : la ligne entiere devient la cible, la case garde sa taille visuelle. */
    .ws-main { display:flex; align-items:center; gap:10px; min-height:44px; font-weight:600; font-size:14px; color:var(--fg-primary); cursor:pointer; }
    .ws-main input { width:20px; height:20px; accent-color:var(--tracky); flex:none; }
    .ws-hint { margin:6px 0 14px; font-size:12px; line-height:1.5; color:var(--fg-secondary); }
    .ws-hint strong { color:var(--fg-primary); }

    /* Le FILET VERT : les plages n'existent que dans l'usage mixte, et la mise en page
       le dit — la dependance etait auparavant enfouie en fin de paragraphe. */
    .ws-cadre {
      margin:2px 0 0; padding:2px 0 2px 14px;
      border-left:3px solid color-mix(in srgb, var(--color-tracky-light) 55%, transparent);
    }
    .ws-cadre-t { margin:6px 0 0; font-size:13px; font-weight:700; color:var(--fg-primary); }
    .ws-alerte {
      margin:4px 0 12px; padding:8px 10px; border-radius:9px;
      font-size:12px; line-height:1.5; color:var(--texte-attente);
      background:color-mix(in srgb, var(--warning) 12%, transparent);
    }
    .ws-alerte strong { font-weight:700; }
    .ws-bilan {
      margin:10px 0 0; padding:9px 11px; border-radius:10px;
      font-size:12.5px; line-height:1.5; color:var(--fg-secondary);
      background:color-mix(in srgb, var(--color-tracky-light) 10%, transparent);
      border:1px solid color-mix(in srgb, var(--color-tracky-light) 24%, transparent);
    }
    .ws-bilan strong { color:var(--texte-succes); font-weight:700; }

    /* Usage professionnel : on MASQUE les plages et on dit pourquoi. */
    .ws-pro { margin-top:2px; padding:12px 13px; border-radius:12px; background:var(--bg-secondary); border:1px solid var(--border-subtle); }
    .ws-pro-t { margin:0; font-size:13px; font-weight:700; color:var(--fg-primary); }
    .ws-pro-s { margin:9px 0 5px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.07em; color:var(--fg-secondary); }
    .ws-pro-l { margin:0; padding-left:17px; display:grid; gap:5px; font-size:12.5px; line-height:1.5; color:var(--fg-secondary); }
    .ws-pro-l strong { color:var(--fg-primary); font-weight:700; }
    .ws-days { display:flex; flex-direction:column; gap:6px; }
    .ws-days--off { opacity:.45; pointer-events:none; }
    .ws-day { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 12px; border-radius:10px; background:var(--bg-secondary,#101514); border:1px solid var(--border-subtle,rgba(255,255,255,.07)); }
    .ws-day--on { border-color:rgba(16,224,160,.25); }
    .ws-daylab { display:flex; align-items:center; gap:8px; min-height:44px; font-size:13.5px; color:var(--fg-primary); cursor:pointer; }
    .ws-daylab input { width:18px; height:18px; accent-color:var(--tracky); flex:none; }
    .ws-times { display:flex; align-items:center; gap:6px; }
    .ws-times input { background:var(--bg-tertiary); border:1px solid var(--border-subtle); border-radius:8px; color:var(--fg-primary); min-height:44px; padding:5px 7px; font-size:13px; }
    .ws-times span { color:var(--fg-secondary); }
    .ws-rest { display:inline-flex; align-items:center; gap:4px; font-size:11.5px; color:var(--fg-secondary); }
    .ws-foot { display:flex; gap:10px; margin-top:18px; }
    .ws-btn { flex:1; min-height:44px; padding:11px; border-radius:11px; border:1px solid var(--border-subtle); background:transparent; color:var(--fg-secondary); font-size:14px; font-weight:600; cursor:pointer; }
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

  /** Le vocabulaire partagé avec `/privacy-coverage`, exposé au gabarit. */
  protected readonly mots = ETATS_VIE_PRIVEE;

  /**
   * Le cadre tel que le SERVEUR le connaît. `enabled` suit le formulaire et peut être
   * modifié sans être enregistré : afficher « Protégé » sur une case cochée mais non
   * sauvegardée annoncerait une protection qui n'existe pas encore.
   */
  private readonly enabledSauvegarde = signal(false);

  /**
   * L'état de couverture, dérivé exactement comme le serveur le classe
   * (`work-schedule.service.ts` : mixedUseEnabled ? scheduleEnabled ? PROTEGE :
   * MIXTE_SANS_CADRE : NON_COUVERT). Aucun appel supplémentaire, aucun contrat touché.
   */
  protected etatCouverture(): EtatViePrivee {
    if (!this.mixedUse()) return 'NON_COUVERT';
    return this.enabledSauvegarde() ? 'PROTEGE' : 'MIXTE_SANS_CADRE';
  }

  /**
   * Les heures de la semaine SANS collecte, sur 168.
   *
   * « Le cadre s'applique » ne dit pas combien de temps le conducteur est effectivement
   * laissé tranquille. Une plage dont la fin précède le début n'est pas comptée : elle
   * ne décrit aucune durée valide, et l'inclure gonflerait la protection annoncée.
   */
  protected heuresSansCollecte(): number {
    if (!this.enabled) return 0;
    let minutesTravaillees = 0;
    for (const d of this.days) {
      if (!d.enabled) continue;
      const debut = this.enMinutes(d.start);
      const fin = this.enMinutes(d.end);
      if (debut === null || fin === null || fin <= debut) continue;
      minutesTravaillees += fin - debut;
    }
    return Math.max(0, 168 - Math.round(minutesTravaillees / 60));
  }

  private enMinutes(hhmm: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h >= 0 && h <= 23 && min >= 0 && min <= 59 ? h * 60 + min : null;
  }

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
        this.enabledSauvegarde.set(!!s.schedule?.enabled);
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
