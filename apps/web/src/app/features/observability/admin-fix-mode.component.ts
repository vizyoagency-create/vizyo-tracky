import { swallow } from '../../core/error/swallow';
import { DatePipe, JsonPipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  ArrowLeft,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  LucideAngularModule,
  RefreshCw,
  ShieldAlert,
  Zap,
} from 'lucide-angular';
import {
  DORMANT_STOP_ACTING_MS,
  formatSilenceLabel,
  trackerSilenceMs,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import {
  AdminFixModeService,
  FixModeStateDto,
  FixModeTimelineEntry,
} from '../../core/services/admin-fix-mode.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

@Component({
  selector: 'app-admin-fix-mode',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, JsonPipe, FormsModule, RouterLink],
  template: `
    <div class="flex flex-col gap-6">
      <!-- Header -->
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <a routerLink="/admin/alerts"
             class="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1">
            <lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon>
            Centre d'alertes
          </a>
          <h1 class="text-2xl font-display font-bold text-fg-primary mt-1">
            Fix mode tracker
          </h1>
          @if (state(); as s) {
            <p class="text-sm text-fg-tertiary">
              {{ s.vehiclePlate ?? '—' }}
              <span class="font-mono ml-2">{{ s.imei.slice(0,4) }}...{{ s.imei.slice(-4) }}</span>
            </p>
          }
        </div>
        <button (click)="reload()"
                class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer flex items-center gap-2">
          <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
          Rafraichir
        </button>
      </div>

      <!-- State banner -->
      @if (state(); as s) {
        <!-- Un boitier muet depuis des semaines n'est ni OK (vert) ni FAILING : il est
             injoignable. Afficher « OK — fix interval honore » sur son dernier etat connu
             reviendrait a certifier un pilotage qui n'a plus lieu. On DATE le silence. -->
        <div class="bg-bg-secondary border rounded-[--radius-card] p-4 flex flex-col gap-3"
             [class.border-rose-500\\/40]="!dormantSilence() && s.fixCommandFailing"
             [class.border-amber-500\\/30]="!!dormantSilence() || (!s.fixCommandFailing && pendingDelta())"
             [class.border-emerald-500\\/30]="!dormantSilence() && !s.fixCommandFailing && !pendingDelta()">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <div class="flex items-center gap-2">
              @if (dormantSilence(); as silence) {
                <lucide-icon [img]="ShieldAlert" [size]="20" class="text-amber-400"></lucide-icon>
                <span class="text-amber-400 font-semibold">BOITIER MUET — aucune trame depuis {{ silence }}</span>
              } @else if (s.fixCommandFailing) {
                <lucide-icon [img]="ShieldAlert" [size]="20" class="text-rose-400"></lucide-icon>
                <span class="text-rose-400 font-semibold">FAILING — {{ s.fixCommandFailureCount }} trames non conformes</span>
              } @else if (pendingDelta()) {
                <lucide-icon [img]="Clock" [size]="20" class="text-amber-400"></lucide-icon>
                <span class="text-amber-400 font-semibold">PENDING — boîtier n'a pas encore confirme</span>
              } @else {
                <lucide-icon [img]="CheckCircle" [size]="20" class="text-emerald-400"></lucide-icon>
                <span class="text-emerald-400 font-semibold">OK — fix interval honore</span>
              }
            </div>
            <span class="text-xs font-mono px-2 py-0.5 rounded"
                  [class]="s.status === 'ONLINE' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'">
              {{ s.status }}
            </span>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <div class="text-xs text-fg-tertiary uppercase">Cible serveur</div>
              <div class="font-mono font-bold">{{ s.desiredFixIntervalS }}s</div>
            </div>
            <div>
              <div class="text-xs text-fg-tertiary uppercase">Réel observe</div>
              <!-- TRK-048 — une mesure sans trame valide recente est un VESTIGE (FS-253-HR :
                   « 1 s » affiche en emettant a 20 s pile). On ecrit « non mesurable »,
                   jamais un chiffre faux : l'information juste est l'absence d'information. -->
              @if (s.currentFixIntervalPerime) {
                <div class="font-bold text-fg-tertiary" title="Aucune trame GPS valide récente : la dernière mesure ne décrit plus le présent (boîtier hors champ ou muet).">non mesurable</div>
              } @else {
                <div class="font-mono font-bold">
                  {{ s.currentFixIntervalS ?? '—' }}{{ s.currentFixIntervalS != null ? 's' : '' }}
                </div>
              }
            </div>
            <div>
              <div class="text-xs text-fg-tertiary uppercase">Dernière sync</div>
              <div class="text-xs font-mono">
                {{ s.lastFixIntervalSyncAt ? (s.lastFixIntervalSyncAt | date: 'dd/MM HH:mm') : '—' }}
              </div>
            </div>
            <div>
              <div class="text-xs text-fg-tertiary uppercase">État sampling</div>
              <div class="text-xs font-mono">{{ s.lastSampledState ?? '—' }}</div>
            </div>
          </div>
          @if (dormantSilence(); as silence) {
            <div class="text-xs text-amber-400 bg-amber-500/10 rounded px-2 py-1.5">
              Ce boitier n'emet plus depuis {{ silence }} (alimentation coupee, SIM desactivee
              ou boitier depose). Les valeurs ci-dessus sont les dernieres CONNUES, pas l'etat
              courant : plus rien ne vient les confirmer. Le pilotage automatique est suspendu
              et reprend seul des la premiere trame recue.
              <!-- Le bandeau « BOITIER MUET » PREND LA PLACE de la ligne FAILING : sans ce
                   rappel, l'admin arrive depuis le centre d'alertes pour un tracker FAILING
                   et ne trouve plus AUCUNE trace du motif de son alerte sous 11 echecs (le
                   pave « echec persistant » ne s'affiche qu'au-dela). On DATE le fait au lieu
                   de le supprimer : il reste vrai, il n'est simplement plus verifiable. -->
              @if (s.fixCommandFailing) {
                <span class="block mt-1 text-rose-400">
                  Indicateur FAILING toujours actif ({{ s.fixCommandFailureCount }} trames non
                  conformes) — constate AVANT le silence, donc ni confirme ni infirme depuis.
                </span>
              }
            </div>
          }
          @if (s.fixCommandFailing && s.fixCommandFailureCount > 10) {
            <div class="text-xs text-rose-400 bg-rose-500/10 rounded px-2 py-1.5">
              Echec persistant ({{ s.fixCommandFailureCount }} trames).
              Actions recommandees : reset SMS du boitier (commande RESET), verification physique
              de l'alimentation et de la carte SIM, ou remplacement du tracker.
            </div>
          }
          @if (s.fixModeOverrideUntil) {
            <div class="text-xs text-amber-400 bg-amber-500/10 rounded px-2 py-1">
              Override admin actif jusqu'a {{ s.fixModeOverrideUntil | date: 'dd/MM HH:mm' }}.
            </div>
          }
          @if (!s.adaptiveFixModeEnabled) {
            <div class="text-xs text-fg-tertiary bg-bg-tertiary rounded px-2 py-1">
              Le pilotage adaptatif est désactivé sur cette flotte (mode tracage continu).
            </div>
          }
        </div>
      }

      <!-- Override panel -->
      <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-wrap items-end gap-3">
        <div class="flex-1 min-w-[180px]">
          <div class="text-sm font-semibold text-fg-primary">Override manuel</div>
          <div class="text-xs text-fg-tertiary">
            Force un intervalle pour la durée choisie. Bloque les transitions automatiques.
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-fg-tertiary">Intervalle force</label>
          <select [(ngModel)]="overrideIntervalS"
                  class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm">
            <option [value]="null">Aucun (laisse l'algo)</option>
            <option [value]="30">30s (haute frequence)</option>
            <option [value]="60">60s</option>
            <option [value]="120">120s</option>
            <option [value]="300">300s (5 min)</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-fg-tertiary">Duree</label>
          <select [(ngModel)]="overrideMinutes"
                  class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm">
            <option [value]="0">Lever override</option>
            <option [value]="60">1 h</option>
            <option [value]="240">4 h</option>
            <option [value]="1440">24 h</option>
          </select>
        </div>
        <!-- Bouton NON grise, et c'est verifie cote serveur : TrackerFixModeService passe
             l'option force pour un override admin, ce qui traverse volontairement la porte
             « boitier muet » du repli SMS (l'automate, lui, est bloque). Sonder un boitier
             silencieux est precisement l'usage de cet ecran de diagnostic. On avertit
             donc au lieu d'interdire — sinon on retirerait l'outil au moment ou il sert. -->
        <button (click)="applyOverride()"
                class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer">
          Appliquer
        </button>
        @if (overrideWarning(); as warning) {
          <p class="w-full text-xs text-amber-400">{{ warning }}</p>
        }
      </div>

      <!-- Filter -->
      <div class="flex items-center gap-2">
        <label class="text-xs text-fg-tertiary">Filtrer la timeline</label>
        <select [(ngModel)]="filter" (change)="reloadTimeline()"
                class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-1.5 text-xs">
          <option value="">Toutes</option>
          <option value="failed">Echouees</option>
          <option value="pending">En attente</option>
        </select>
      </div>

      <!-- Timeline -->
      @if (timeline().length > 0) {
        <div class="flex flex-col gap-2">
          @for (e of timeline(); track e.id) {
            <div class="bg-bg-secondary border rounded-[--radius-card]"
                 [class.border-rose-500\\/30]="e.status === 'FAILED'"
                 [class.border-emerald-500\\/30]="e.status === 'ACKNOWLEDGED'"
                 [class.border-border-subtle]="e.status !== 'FAILED' && e.status !== 'ACKNOWLEDGED'">
              <button (click)="toggleExpand(e.id)"
                      class="w-full px-4 py-3 flex items-center gap-3 hover:bg-bg-tertiary/30 cursor-pointer text-left">
                <lucide-icon [img]="expanded()[e.id] ? ChevronDown : ChevronRight" [size]="14" class="text-fg-tertiary shrink-0"></lucide-icon>
                <div class="flex flex-col flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-xs font-mono text-fg-secondary">
                      {{ e.createdAt | date: 'dd/MM HH:mm:ss' }}
                    </span>
                    <span class="inline-flex items-center px-2 py-0.5 text-[10px] rounded-md font-mono"
                          [class]="statusBadgeClass(e.status, e.confirmation)"
                          [title]="statusTitre(e.status, e.confirmation)">
                      {{ statusLibelle(e.status, e.confirmation) }}
                    </span>
                    <!--
                      TRK-051 — une commande close par la MESURE ne doit pas pouvoir se lire comme
                      un acquittement du boitier. Le badge le dit, en toutes lettres et sans vert.
                    -->
                    @if (e.confirmation === 'MESURE') {
                      <span class="inline-flex items-center px-2 py-0.5 text-[10px] rounded-md
                                   bg-amber-500/10 text-amber-400"
                            title="Le boitier n'a envoye aucune reponse. L'effet est constate par la
                                   cadence mesuree, pas confirme par le materiel.">
                        sans accuse du boitier
                      </span>
                    }
                    @if (e.outcomeReason) {
                      <span class="text-xs text-fg-tertiary">{{ e.outcomeReason }}</span>
                    }
                  </div>
                  <div class="text-xs text-fg-secondary font-mono mt-1 truncate">
                    {{ e.payload }}
                  </div>
                </div>
              </button>
              @if (expanded()[e.id]) {
                <div class="border-t border-border-subtle/50 px-4 py-3 flex flex-col gap-3 text-xs">
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <div class="text-fg-tertiary uppercase text-[10px]">Attendu</div>
                      <div class="text-fg-secondary">{{ e.expectedResult ?? '—' }}</div>
                    </div>
                    <div>
                      <div class="text-fg-tertiary uppercase text-[10px]">Observe</div>
                      <div class="text-fg-secondary">{{ e.observedResult ?? '—' }}</div>
                    </div>
                  </div>
                  @if (e.diagnosticHint) {
                    <div class="bg-amber-500/10 text-amber-400 rounded px-2 py-1.5">
                      <span class="font-semibold">Diagnostic suggere :</span> {{ e.diagnosticHint }}
                    </div>
                  }
                  @if (e.lastError) {
                    <div class="bg-rose-500/10 text-rose-400 rounded px-2 py-1.5">
                      <span class="font-semibold">Erreur :</span> {{ e.lastError }}
                    </div>
                  }
                  @if (e.contextSnapshot) {
                    <details class="text-fg-tertiary">
                      <summary class="cursor-pointer hover:text-fg-secondary text-xs">Contexte au moment de la commande</summary>
                      <pre class="mt-2 text-[10px] bg-bg-tertiary p-2 rounded overflow-x-auto">{{ e.contextSnapshot | json }}</pre>
                    </details>
                  }
                  <div class="flex items-center gap-2 text-fg-tertiary">
                    <span>Cree {{ e.createdAt | date: 'dd/MM HH:mm:ss' }}</span>
                    @if (e.sentAt) { <span>· Envoye {{ e.sentAt | date: 'HH:mm:ss' }}</span> }
                    @if (e.ackedAt) { <span>· ACK {{ e.ackedAt | date: 'HH:mm:ss' }}</span> }
                  </div>
                </div>
              }
            </div>
          }
        </div>
      } @else if (!loading()) {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-8 text-center">
          <lucide-icon [img]="Zap" [size]="32" class="mx-auto mb-2 opacity-40"></lucide-icon>
          <p class="text-sm text-fg-tertiary">Aucune commande fix mode dans la fenêtre.</p>
        </div>
      }
    </div>
  `,
})
export class AdminFixModeComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(AdminFixModeService);
  private readonly toast = inject(ToastService);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly CheckCircle = CheckCircle;
  protected readonly ChevronDown = ChevronDown;
  protected readonly ChevronRight = ChevronRight;
  protected readonly Clock = Clock;
  protected readonly RefreshCw = RefreshCw;
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly Zap = Zap;

  readonly trackerId = signal('');
  readonly state = signal<FixModeStateDto | null>(null);
  readonly timeline = signal<FixModeTimelineEntry[]>([]);
  readonly loading = signal(false);
  readonly expanded = signal<Record<string, boolean>>({});

  filter: '' | 'failed' | 'pending' = '';
  overrideIntervalS: number | null = null;
  overrideMinutes = 0;

  readonly pendingDelta = computed(() => {
    const s = this.state();
    if (!s) return false;
    // TRK-048 — un ecart calcule sur une mesure perimee accuserait un boitier sur un
    // vestige : pas de delta tant que la mesure ne decrit pas le present.
    if (s.currentFixIntervalPerime) return false;
    return s.currentFixIntervalS != null && s.desiredFixIntervalS !== s.currentFixIntervalS;
  });

  /**
   * BOITIER MUET (seuil AGIR = 72 h) — libelle de silence, null si le boitier parle encore.
   *
   * Meme constante que le serveur (DORMANT_STOP_ACTING_MS) : c'est le seuil au-dela duquel
   * toute commande est une tentative dont on connait deja l'issue. `lastSeenAt` est la seule
   * source valable — `status` est derive de la colonne collante Tracker.status, qui reste
   * ONLINE pour un boitier mort depuis 89 jours.
   *
   * `null` (boitier qui n'a JAMAIS emis) n'est pas de la dormance : c'est un probleme de
   * provisioning, deja nomme ailleurs, et on ne bloque rien dessus.
   */
  readonly dormantSilence = computed<string | null>(() => {
    const s = this.state();
    if (!s || s.lastSeenAt == null) return null;
    const now = Date.now();
    const silent = trackerSilenceMs(s.lastSeenAt, now);
    if (silent == null || silent <= DORMANT_STOP_ACTING_MS) return null;
    return formatSilenceLabel(s.lastSeenAt, now) ?? '—';
  });

  /**
   * « Appliquer » va-t-il REELLEMENT pousser une commande vers le boitier ?
   *
   * Le serveur ne declenche `requestChange` que sous DEUX conditions reunies
   * (`if (desiredS && overrideUntil)`, cf. TrackerFixModeService.setManualOverride) :
   * une duree > 0 ET un intervalle choisi. « Lever override » (0 min) comme « Aucun
   * (laisse l'algo) » n'ecrivent que `fixModeOverrideUntil` — rien ne part vers le
   * boitier. Annoncer un envoi SMS dans ces cas serait exactement le mensonge que ce
   * lot combat, en sens inverse : un avertissement pour une commande qui n'existe pas.
   *
   * `Number()` sur les deux champs : les `<option [value]>` renvoient des CHAINES, et
   * « Aucun » donne litteralement "null" -> NaN, que les comparaisons rejettent toutes.
   */
  private pushesCommand(): boolean {
    return Number(this.overrideMinutes) > 0 && Number(this.overrideIntervalS) > 0;
  }

  /**
   * Avertissement sous « Appliquer », ou null. Methode et non `computed` :
   * `overrideMinutes` est un champ ngModel simple, aucun signal ne le suit — la detection
   * de changements par defaut re-evalue l'expression a chaque cycle, ce qui suffit ici.
   */
  overrideWarning(): string | null {
    const silence = this.dormantSilence();
    if (!silence) return null;
    if (!this.pushesCommand()) return null;
    return `Boitier muet depuis ${silence} — la commande sera tentee par SMS, sans garantie ` +
      `d'arrivee ni de confirmation. Vérifier alimentation, SIM ou presence du boitier.`;
  }

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.toast.error('Tracker ID manquant');
      return;
    }
    this.trackerId.set(id);
    this.reload();
  }

  toggleExpand(id: string): void {
    this.expanded.update((m) => ({ ...m, [id]: !m[id] }));
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const [state, timeline] = await Promise.all([
        firstValueFrom(this.api.state(this.trackerId())),
        firstValueFrom(this.api.timeline(this.trackerId(), 90, this.filter || undefined)),
      ]);
      this.state.set(state);
      this.timeline.set(timeline.items);
    } catch (err) {
      swallow('admin-fix-mode:reload', err);
      this.toast.error('Échec du chargement');
    } finally {
      this.loading.set(false);
    }
  }

  async reloadTimeline(): Promise<void> {
    try {
      const t = await firstValueFrom(
        this.api.timeline(this.trackerId(), 90, this.filter || undefined),
      );
      this.timeline.set(t.items);
    } catch (err) {
      swallow('admin-fix-mode:reloadTimeline', err);
      this.toast.error('Échec du chargement de la timeline');
    }
  }

  async applyOverride(): Promise<void> {
    // Boitier muet : « override actif » seul laisserait croire que le boitier obeit deja.
    // On date le silence dans le message, la derniere chose lue avant de partir — mais
    // UNIQUEMENT si une commande part vraiment (sinon on annonce un envoi inexistant).
    // Capture AVANT l'appel : le message doit decrire ce qui vient d'etre tente.
    const silence = this.pushesCommand() ? this.dormantSilence() : null;
    try {
      const result = await firstValueFrom(
        this.api.setOverride(
          this.trackerId(),
          Number(this.overrideMinutes),
          this.overrideIntervalS != null ? Number(this.overrideIntervalS) : null,
        ),
      );
      if (result.overrideUntil) {
        this.toast.success(
          `Override actif jusqu'a ${new Date(result.overrideUntil).toLocaleString('fr-FR')}`,
          silence
            ? `Boitier muet depuis ${silence} : commande tentee, aucune confirmation a attendre.`
            : undefined,
        );
      } else {
        this.toast.success('Override leve');
      }
      this.reload();
    } catch (err) {
      swallow('admin-fix-mode:applyOverride', err);
      this.toast.error('Échec de l\'override');
    }
  }

  /**
   * TRK-051 — le vert (succes confirme) est RESERVE a une vraie reponse du boitier.
   * Un `ACKNOWLEDGED` obtenu par la mesure passe en ambre : l'effet est constate, il n'est
   * pas confirme par le materiel. Peindre les deux en vert etait exactement ce qui faisait
   * lire « 120 acquittements » la ou il y en a 2.
   */
  /**
   * TRK-051 — le libelle affiche. `ACKNOWLEDGED` seul est ambigu : il recouvre « le boitier a
   * repondu » et « la cadence mesuree a rejoint la cible, sans aucune reponse ». On ecrit lequel.
   */
  statusLibelle(status: string, confirmation?: 'BOITIER' | 'MESURE' | null): string {
    if (status !== 'ACKNOWLEDGED') return status;
    return confirmation === 'BOITIER' ? 'ACQUITTEE (boitier)' : 'CIBLE ATTEINTE (mesuree)';
  }

  /** Infobulle : dit la preuve sur laquelle repose le verdict. */
  statusTitre(status: string, confirmation?: 'BOITIER' | 'MESURE' | null): string {
    if (status !== 'ACKNOWLEDGED') return status;
    return confirmation === 'BOITIER'
      ? 'Le boitier a renvoye une trame de reponse : confirmation materielle.'
      : 'Cloture par echeance : la cadence mesuree a rejoint la cadence demandee. '
        + 'Le boitier n a envoye aucun accuse de reception (TRK-051).';
  }

  statusBadgeClass(status: string, confirmation?: 'BOITIER' | 'MESURE' | null): string {
    if (status === 'ACKNOWLEDGED') {
      return confirmation === 'BOITIER'
        ? 'bg-emerald-500/10 text-emerald-400'
        : 'bg-amber-500/10 text-amber-400';
    }
    if (status === 'SENT') return 'bg-sky-500/10 text-sky-400';
    if (status === 'FAILED') return 'bg-rose-500/10 text-rose-400';
    if (status === 'PENDING') return 'bg-amber-500/10 text-amber-400';
    if (status === 'CANCELLED') return 'bg-fg-tertiary/10 text-fg-tertiary';
    return 'bg-fg-tertiary/10 text-fg-tertiary';
  }
}
