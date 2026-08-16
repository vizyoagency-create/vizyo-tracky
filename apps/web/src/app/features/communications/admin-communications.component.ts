import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Bell, LucideAngularModule, Mail, MessageSquare, RefreshCw, X } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  AdminCommunicationsService,
  type CommChannel,
  type CommLogDto,
  type CommOverview,
  type CommTemplateDto,
} from '../../core/services/admin-communications.service';
import { AdminEmailsService } from '../../core/services/admin-emails.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

type Tab = 'overview' | 'journal' | 'templates';

/** Présentation par canal — un seul endroit à maintenir. */
const CHANNEL_META: Record<CommChannel, { label: string; icon: string; tone: string; soft: string }> = {
  EMAIL: { label: 'E-mails', icon: '✉', tone: 'text-tracky-light', soft: 'bg-tracky-light/10' },
  SMS: { label: 'SMS', icon: '💬', tone: 'text-sky-400', soft: 'bg-sky-400/10' },
  PUSH: { label: 'Notifications', icon: '🔔', tone: 'text-violet-400', soft: 'bg-violet-400/10' },
};

/**
 * MODULE COMMUNICATIONS (admin) — un seul écran pour TOUT ce que Tracky envoie à un
 * humain : e-mails, SMS et notifications push. Remplace les écrans séparés et rend
 * chaque envoi identifiable (modèle typé côté serveur, journal par canal).
 */
@Component({
  selector: 'app-admin-communications',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, DatePipe, FormsModule, RouterLink],
  template: `
    <div class="p-4 sm:p-6 max-w-[1180px] mx-auto">
      <!-- En-tête -->
      <div class="flex items-start justify-between gap-4 mb-5">
        <div>
          <!-- ⚠️ 44 px DE HAUT, pour un texte de 10. C'est le SEUL chemin de retour vers
               l'administration sur cet écran, et il mesurait 14 px : au doigt, on le rate.
               Le retrait négatif garde le titre à sa place — la zone grandit, pas la mise
               en page. -->
          <a routerLink="/admin"
             class="inline-flex items-center font-mono text-[10px] tracking-[0.14em] uppercase text-fg-tertiary hover:text-fg-secondary"
             style="min-height:44px;margin-top:-12px">← Administration</a>
          <h1 class="font-display text-[26px] font-extrabold tracking-[-0.025em] text-fg-primary -mt-2">Communications</h1>
          <p class="text-[13px] text-fg-tertiary mt-0.5">
            Tout ce que Tracky envoie — e-mails, SMS et notifications — au même endroit.
          </p>
        </div>
        <button type="button" (click)="reload()" [disabled]="loading()"
                class="shrink-0 inline-flex items-center gap-2 text-[12.5px] font-semibold px-3 py-2 rounded-lg border border-border-subtle text-fg-secondary hover:text-fg-primary disabled:opacity-50"
                style="min-height:44px">
          <lucide-icon [img]="RefreshCw" [size]="14" />
          {{ loading() ? '…' : 'Rafraîchir' }}
        </button>
      </div>

      <!-- KPI par canal -->
      <div class="grid sm:grid-cols-3 gap-3.5 mb-5">
        @for (c of channels(); track c.channel) {
          <div class="relative overflow-hidden bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-[18px_20px]">
            <!-- ⚠️ LA RANGÉE PASSE À LA LIGNE, ELLE NE COUPE PAS. À trois colonnes dans une
                 fenêtre étroite, la carte tombe à 131 px : l'icône en prend 36, il reste
                 54 px pour un libellé qui en réclame 100. « NOTIFICATIONS » sortait donc de
                 sa pilule. Tronquer donnait « NOTI… » — un badge dont le seul rôle est de
                 nommer le canal, et qui ne le nomme plus. Il descend d'une ligne. -->
            <div class="flex items-center justify-between gap-2 flex-wrap mb-3">
              <span class="inline-flex items-center justify-center w-9 h-9 rounded-xl text-[17px] shrink-0" [class]="meta(c.channel).soft">{{ meta(c.channel).icon }}</span>
              <span class="font-mono text-[9px] tracking-[0.12em] uppercase px-2 py-1 rounded-md whitespace-nowrap" [class]="meta(c.channel).soft + ' ' + meta(c.channel).tone">{{ meta(c.channel).label }}</span>
            </div>
            <div class="font-mono text-[26px] font-semibold text-fg-primary leading-none">{{ c.sent }}</div>
            <!-- whitespace-nowrap : sans lui, le « j » de « 30 j » partait seul à la ligne. -->
            <div class="font-mono text-[9.5px] tracking-[0.1em] uppercase text-fg-tertiary mt-1.5 whitespace-nowrap">envoyés · {{ overview()?.days ?? 30 }} j</div>
            <div class="flex gap-2 mt-3">
              <!-- ⚠️ ZÉRO ENVOI N'EST PAS ZÉRO POUR CENT DE RÉUSSITE. Le taux affichait
                   « 0 % » en ROUGE sur un canal qui n'avait simplement rien envoyé sur la
                   période — un administrateur y lit « mes SMS ne partent plus » alors que
                   rien n'est cassé. Un taux sans envoi n'existe pas : on écrit « — ». -->
              <div class="flex-1 bg-bg-primary border border-border-subtle rounded-lg p-[7px_9px]">
                <div class="font-mono text-[8.5px] uppercase text-fg-tertiary">Succès</div>
                <div class="font-mono text-[13px] font-semibold" [class]="tauxClasse(c)">{{ tauxLabel(c) }}</div>
              </div>
              <div class="flex-1 bg-bg-primary border border-border-subtle rounded-lg p-[7px_9px]">
                <div class="font-mono text-[8.5px] uppercase text-fg-tertiary">Échecs</div>
                <div class="font-mono text-[13px] font-semibold" [class]="c.failed ? 'text-rose-400' : 'text-fg-tertiary'">{{ c.failed }}</div>
              </div>
            </div>
          </div>
        }
      </div>

      <!-- Onglets -->
      <div class="flex gap-1 mb-4 border-b border-border-subtle">
        @for (t of TABS; track t.key) {
          <button type="button" (click)="activeTab.set(t.key)"
                  class="px-4 text-[13px] font-semibold border-b-2 -mb-px transition-colors"
                  style="min-height:44px"
                  [class]="activeTab() === t.key ? 'border-tracky-light text-fg-primary' : 'border-transparent text-fg-tertiary hover:text-fg-secondary'">
            {{ t.label }}
          </button>
        }
      </div>

      <!-- ══ VUE D'ENSEMBLE ══ -->
      @if (activeTab() === 'overview') {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-[20px_22px] mb-4">
          <div class="font-display text-[15px] font-bold text-fg-primary mb-4">Volume des 14 derniers jours</div>
          <div class="flex items-end gap-[3px] h-[120px]">
            @for (d of overview()?.series ?? []; track d.day) {
              <div class="flex-1 flex flex-col justify-end gap-[2px] group relative" [title]="d.day + ' — ' + d.ok + ' ok, ' + d.failed + ' échec(s)'">
                @if (d.failed) { <div class="bg-rose-400/80 rounded-sm" [style.height.px]="barH(d.failed)"></div> }
                <div class="bg-tracky-light/80 rounded-sm" [style.height.px]="barH(d.ok)"></div>
              </div>
            }
          </div>
        </div>

        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-[20px_22px]">
          <div class="font-display text-[15px] font-bold text-fg-primary mb-1">Répartition par modèle</div>
          <div class="text-[12px] text-fg-tertiary mb-4">Les 12 modèles les plus envoyés, tous canaux confondus.</div>
          @for (t of overview()?.byTemplate ?? []; track t.channel + t.template) {
            <div class="flex items-center gap-3 py-2 border-b border-border-subtle/60 last:border-0">
              <span class="w-[22px] text-center text-[13px]">{{ meta(t.channel).icon }}</span>
              <span class="flex-1 text-[13px] text-fg-secondary truncate">{{ t.label }}</span>
              <span class="font-mono text-[12px] font-semibold text-fg-primary">{{ t.count }}</span>
            </div>
          } @empty {
            <div class="text-[13px] text-fg-tertiary py-6 text-center">Aucun envoi sur la période.</div>
          }
        </div>
      }

      <!-- ══ JOURNAL ══ -->
      @if (activeTab() === 'journal') {
        <!-- ⚠️ 44 px SUR TOUTE LA RANGÉE. Ces cinq contrôles mesuraient 36 px : ils ne
             vivent que sur cet onglet, et la première mesure — prise sur la vue
             d'ensemble — ne les voyait pas. Un filtre se tape au doigt comme le reste. -->
        <div class="flex flex-wrap gap-2 mb-3.5">
          <button type="button" (click)="setChannel(undefined)"
                  class="px-3 rounded-lg text-[12px] font-semibold border"
                  style="min-height:44px"
                  [class]="!channel() ? 'border-tracky-light text-tracky-light bg-tracky-light/10' : 'border-border-subtle text-fg-tertiary'">Tous</button>
          @for (c of CHANNEL_KEYS; track c) {
            <button type="button" (click)="setChannel(c)"
                    class="px-3 rounded-lg text-[12px] font-semibold border"
                    style="min-height:44px"
                    [class]="channel() === c ? 'border-tracky-light text-tracky-light bg-tracky-light/10' : 'border-border-subtle text-fg-tertiary'">
              {{ meta(c).icon }} {{ meta(c).label }}
            </button>
          }
          <input [(ngModel)]="search" (keyup.enter)="reloadLogs()" placeholder="Rechercher…"
                 style="min-height:44px"
                 class="flex-1 min-w-[160px] px-3 rounded-lg bg-bg-secondary border border-border-subtle text-[12.5px] text-fg-primary placeholder:text-fg-tertiary" />
        </div>

        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
          @for (l of logs(); track l.channel + l.id) {
            <div class="flex items-center gap-3 px-4 py-2.5 border-b border-border-subtle/60 last:border-0">
              <span class="w-[22px] text-center text-[13px] shrink-0" [title]="meta(l.channel).label">{{ meta(l.channel).icon }}</span>
              <div class="min-w-0 flex-1">
                <div class="text-[13px] text-fg-primary truncate">{{ l.subject || l.templateLabel }}</div>
                <div class="text-[11px] text-fg-tertiary truncate">{{ l.templateLabel }} · {{ l.target }}</div>
              </div>
              <span class="shrink-0 font-mono text-[9.5px] tracking-[0.08em] uppercase px-2 py-1 rounded-md" [class]="outcomeClass(l.outcome)">{{ outcomeLabel(l.outcome) }}</span>
              <span class="shrink-0 font-mono text-[10.5px] text-fg-tertiary w-[104px] text-right">{{ l.createdAt | date: 'dd/MM HH:mm' }}</span>
            </div>
          } @empty {
            <div class="text-[13px] text-fg-tertiary py-10 text-center">Aucun envoi ne correspond.</div>
          }
        </div>
      }

      <!-- ══ MODÈLES ══ -->
      @if (activeTab() === 'templates') {
        <div class="text-[12.5px] text-fg-tertiary mb-4">
          <b class="text-fg-secondary">{{ templates().length }} modèles recensés</b> — chaque message sortant est catalogué ici.
          Un modèle non recensé fait échouer la compilation (garde anti-oubli).
        </div>
        @for (c of CHANNEL_KEYS; track c) {
          <div class="mb-6">
            <div class="flex items-center gap-2 mb-2.5">
              <span class="text-[14px]">{{ meta(c).icon }}</span>
              <span class="font-display text-[15px] font-bold text-fg-primary">{{ meta(c).label }}</span>
              <span class="font-mono text-[10px] text-fg-tertiary">{{ byChannel(c).length }}</span>
            </div>
            <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              @for (t of byChannel(c); track t.id) {
                <button type="button" [disabled]="!t.previewable" (click)="openPreview(t)"
                        class="text-left bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-[16px_18px] transition-colors"
                        [class.hover:border-tracky-light]="t.previewable"
                        [class.cursor-default]="!t.previewable">
                  <div class="flex items-start justify-between gap-2 mb-2">
                    <span class="font-display text-[14px] font-bold text-fg-primary">{{ t.label }}</span>
                    <span class="shrink-0 font-mono text-[8.5px] tracking-[0.1em] uppercase px-1.5 py-0.5 rounded" [class]="meta(c).soft + ' ' + meta(c).tone">{{ t.category }}</span>
                  </div>
                  <div class="text-[11.5px] leading-relaxed text-fg-tertiary mb-2.5 min-h-[32px]">{{ t.description }}</div>
                  <div class="text-[11px] text-fg-tertiary mb-2.5"><span class="text-fg-secondary">Déclencheur :</span> {{ t.trigger }}</div>
                  <div class="flex items-center justify-between">
                    <span class="font-mono text-[10.5px] text-fg-tertiary">30 j · <span class="text-fg-primary font-semibold">{{ t.sent30d }}</span>@if (t.failed30d) { <span class="text-rose-400"> · {{ t.failed30d }} KO</span> }</span>
                    @if (t.previewable) { <span class="text-[11px] font-semibold text-tracky-light">Aperçu →</span> }
                  </div>
                </button>
              }
            </div>
          </div>
        }
      }
    </div>

    <!-- Aperçu (e-mails uniquement) -->
    @if (preview(); as p) {
      <div class="fixed inset-0 z-[4000] flex" (click)="preview.set(null)">
        <div class="flex-1 bg-black/50"></div>
        <div class="w-full max-w-[560px] bg-bg-secondary border-l border-border-subtle overflow-y-auto" (click)="$event.stopPropagation()">
          <div class="flex items-start justify-between gap-3 p-5 border-b border-border-subtle">
            <div>
              <div class="font-mono text-[9.5px] tracking-[0.14em] uppercase text-fg-tertiary">Aperçu du modèle</div>
              <div class="font-display text-[17px] font-bold text-fg-primary">{{ p.label }}</div>
            </div>
            <button type="button" (click)="preview.set(null)" class="p-1.5 rounded-lg text-fg-tertiary hover:text-fg-primary"><lucide-icon [img]="X" [size]="16" /></button>
          </div>
          <div class="p-5">
            <iframe [srcdoc]="p.html" class="w-full h-[560px] rounded-xl border border-border-subtle bg-white" title="Aperçu"></iframe>
          </div>
        </div>
      </div>
    }
  `,
})
export class AdminCommunicationsComponent implements OnInit {
  private readonly api = inject(AdminCommunicationsService);
  private readonly emailApi = inject(AdminEmailsService);
  private readonly toast = inject(ToastService);

  protected readonly RefreshCw = RefreshCw;
  protected readonly X = X;
  protected readonly Mail = Mail;
  protected readonly MessageSquare = MessageSquare;
  protected readonly Bell = Bell;

  protected readonly TABS: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Vue d\'ensemble' },
    { key: 'journal', label: 'Journal' },
    { key: 'templates', label: 'Modèles' },
  ];
  protected readonly CHANNEL_KEYS: CommChannel[] = ['EMAIL', 'SMS', 'PUSH'];

  protected readonly activeTab = signal<Tab>('overview');
  protected readonly loading = signal(false);
  protected readonly overview = signal<CommOverview | null>(null);
  protected readonly logs = signal<CommLogDto[]>([]);
  protected readonly templates = signal<CommTemplateDto[]>([]);
  protected readonly channel = signal<CommChannel | undefined>(undefined);
  protected readonly preview = signal<{ label: string; html: string } | null>(null);
  protected search = '';

  protected readonly channels = computed(() => {
    const o = this.overview();
    // Ordre stable EMAIL → SMS → PUSH, même si le backend renvoie autrement.
    return this.CHANNEL_KEYS.map(
      (k) => o?.channels.find((c) => c.channel === k) ?? { channel: k, sent: 0, delivered: 0, failed: 0, successRate: 0, lastAt: null },
    );
  });

  private readonly maxBar = computed(() =>
    Math.max(1, ...(this.overview()?.series ?? []).map((d) => d.ok + d.failed)),
  );

  ngOnInit(): void {
    void this.reload();
  }

  protected meta(c: CommChannel) {
    return CHANNEL_META[c];
  }

  protected byChannel(c: CommChannel): CommTemplateDto[] {
    return this.templates().filter((t) => t.channel === c);
  }

  protected barH(n: number): number {
    return Math.round((n / this.maxBar()) * 108);
  }

  /** Le taux de succès, ou « — » quand il n'y a rien eu à réussir. */
  protected tauxLabel(c: { sent: number; successRate: number }): string {
    return c.sent === 0 ? '—' : `${c.successRate}%`;
  }

  /**
   * La couleur suit le taux — sauf quand il n'y en a pas.
   *
   * Un canal muet est NEUTRE, pas en échec : le rouge est réservé à ce qui est parti et
   * n'est pas arrivé. Peindre en rouge une absence d'envoi ferait chercher une panne
   * inexistante, et userait le rouge pour le jour où il compte.
   */
  protected tauxClasse(c: { sent: number; successRate: number }): string {
    if (c.sent === 0) return 'text-fg-tertiary';
    if (c.successRate >= 90) return 'text-tracky-light';
    return c.successRate >= 60 ? 'text-amber-400' : 'text-rose-400';
  }

  protected outcomeLabel(o: CommLogDto['outcome']): string {
    return o === 'DELIVERED' ? 'Délivré' : o === 'SENT' ? 'Envoyé' : o === 'FAILED' ? 'Échec'
      : o === 'EXPIRED' ? 'Expiré' : 'Reçu';
  }

  protected outcomeClass(o: CommLogDto['outcome']): string {
    if (o === 'FAILED') return 'bg-rose-400/10 text-rose-400';
    if (o === 'EXPIRED') return 'bg-amber-400/10 text-amber-400';
    if (o === 'DELIVERED') return 'bg-tracky-light/10 text-tracky-light';
    if (o === 'RECEIVED') return 'bg-sky-400/10 text-sky-400';
    return 'bg-fg-tertiary/10 text-fg-tertiary';
  }

  protected setChannel(c: CommChannel | undefined): void {
    this.channel.set(c);
    void this.reloadLogs();
  }

  protected async reloadLogs(): Promise<void> {
    const r = await firstValueFrom(
      this.api.logs({ channel: this.channel(), q: this.search || undefined }),
    );
    this.logs.set(r.items);
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const [o, l, t] = await Promise.all([
        firstValueFrom(this.api.overview('30d')),
        firstValueFrom(this.api.logs({ channel: this.channel(), q: this.search || undefined })),
        firstValueFrom(this.api.templates()),
      ]);
      this.overview.set(o);
      this.logs.set(l.items);
      this.templates.set(t);
    } catch {
      this.toast.error('Chargement impossible', 'Réessayez dans un instant.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async openPreview(t: CommTemplateDto): Promise<void> {
    if (!t.previewable) return;
    try {
      const r = await firstValueFrom(this.emailApi.preview(t.id));
      this.preview.set({ label: t.label, html: r.html });
    } catch {
      this.toast.error('Aperçu indisponible');
    }
  }
}
