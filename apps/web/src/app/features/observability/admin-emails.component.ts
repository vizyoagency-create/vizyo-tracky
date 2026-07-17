import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { ArrowLeft, LucideAngularModule, RefreshCw, Send, X } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  AdminEmailsService,
  type Deliverability,
  type EmailLogDto,
  type EmailStats,
  type EmailStatus,
  type EmailTemplateMeta,
} from '../../core/services/admin-emails.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

type Tab = 'suivi' | 'templates' | 'deliver';

/** Présentation client (icône + teinte) par modèle — le reste vient du backend. */
const TPL_PRESENT: Record<string, { icon: string; tone: 'green' | 'red' | 'amber'; desc: string }> = {
  invitation: { icon: '✉', tone: 'green', desc: 'Invitation à rejoindre une flotte avec création de mot de passe.' },
  password_reset: { icon: '🔐', tone: 'green', desc: 'Lien sécurisé de réinitialisation, valable 30 minutes.' },
  device_verification: { icon: '📱', tone: 'green', desc: 'Code de connexion à la vérification d’un nouvel appareil (2FA).' },
  two_factor_disable: { icon: '⚠', tone: 'amber', desc: 'Code de confirmation pour désactiver la double authentification.' },
  weekly_report: { icon: '📊', tone: 'green', desc: 'Synthèse hebdomadaire de flotte, chaque lundi 08:00.' },
  alert: { icon: '⚠', tone: 'red', desc: 'Notification temps réel (excès, sortie de zone, coupure).' },
  lead: { icon: '🎯', tone: 'green', desc: 'Notification interne équipe Vizyo à chaque prospect LP.' },
  lead_welcome: { icon: '👋', tone: 'green', desc: 'E-mail de bienvenue personnel au prospect (présentation + contact).' },
  quote_signed: { icon: '📝', tone: 'green', desc: 'Notification interne : un prospect a signé un devis en ligne.' },
  quote_client: { icon: '🧾', tone: 'green', desc: 'Copie du récapitulatif de devis envoyée au prospect.' },
  audio_activation: { icon: '🔊', tone: 'amber', desc: 'Rappel des obligations légales à l’activation du micro.' },
  audio_info: { icon: '🎧', tone: 'green', desc: 'Présentation de la fonction d’assistance en cas d’accident.' },
};

const STATUS_FILTERS: { id: string; label: string }[] = [
  { id: '', label: 'Tous' },
  { id: 'SENT', label: 'Envoyés' },
  { id: 'DELIVERED', label: 'Délivrés' },
  { id: 'OPENED', label: 'Ouverts' },
  { id: 'BOUNCED', label: 'Rejetés' },
  { id: 'FAILED', label: 'Échecs' },
];

/** Palette de barre de répartition (accent unique émeraude + statuts). */
const BREAKDOWN_COLORS = ['bg-tracky-light', 'bg-rose-400', 'bg-tracky', 'bg-sky-400', 'bg-amber-400'];

@Component({
  selector: 'app-admin-emails',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, DatePipe, FormsModule, RouterLink],
  template: `
    <div class="flex flex-col gap-6">
      <!-- ── HEADER ── -->
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <a routerLink="/admin" class="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1 mb-1">
            <lucide-icon [img]="ArrowLeft" [size]="12" /> Administration
          </a>
          <h1 class="text-[1.75rem] leading-tight font-display font-extrabold tracking-[-0.03em] text-fg-primary">E-mails</h1>
          <p class="text-sm text-fg-tertiary mt-1 max-w-[58ch]">
            Suivi des envois transactionnels, aperçu des modèles et santé de la délivrabilité — toute la vie e-mail de Tracky au même endroit.
          </p>
        </div>
        <div class="flex items-center gap-2.5">
          <span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-semibold font-mono border"
                [class]="providerOk()
                  ? 'bg-tracky-light/[0.06] border-tracky-light/20 text-tracky-light'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-400'">
            <span class="w-[7px] h-[7px] rounded-full" [class]="providerOk() ? 'bg-tracky-light em-pulse' : 'bg-rose-400'"></span>
            Resend · {{ providerOk() ? 'opérationnel' : 'à surveiller' }}
          </span>
          <button (click)="reload()" [disabled]="loading()"
                  class="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold bg-bg-secondary border border-border-subtle text-fg-secondary hover:text-fg-primary hover:border-tracky-light/40 transition-colors disabled:opacity-50">
            <lucide-icon [img]="RefreshCw" [size]="14" [class.animate-spin]="loading()" /> Rafraîchir
          </button>
        </div>
      </div>

      <!-- ── KPI ROW ── -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        @for (k of kpis(); track k.label) {
          <div class="relative overflow-hidden bg-bg-secondary border rounded-[--radius-card] p-[18px_20px]"
               [class]="k.danger ? 'border-rose-500/25' : 'border-border-subtle'">
            <div class="absolute top-0 left-0 right-0 h-[3px]" [class]="k.danger ? 'bg-rose-400' : 'bg-tracky-light'"></div>
            <div class="font-mono text-[10px] tracking-[0.14em] uppercase text-fg-tertiary mb-2.5">{{ k.label }}</div>
            <div class="font-display text-[2rem] font-extrabold leading-none" [class]="k.danger ? 'text-rose-400' : 'text-fg-primary'">
              {{ k.value }}<span class="text-[17px] text-fg-tertiary">{{ k.unit }}</span>
            </div>
            <div class="text-[11px] mt-2 font-semibold text-fg-tertiary">{{ k.sub }}</div>
          </div>
        }
      </div>

      <!-- ── TABS ── -->
      <div class="flex gap-1 border-b border-border-subtle overflow-x-auto -mt-1">
        @for (t of tabs; track t.key) {
          <button (click)="activeTab.set(t.key)"
                  class="px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px shrink-0 transition-colors cursor-pointer"
                  [class]="activeTab() === t.key ? 'text-tracky-light border-tracky-light' : 'text-fg-tertiary border-transparent hover:text-fg-secondary'">
            {{ t.label }}
          </button>
        }
      </div>

      <!-- ══ TAB : SUIVI ══ -->
      @if (activeTab() === 'suivi') {
        <div class="flex flex-col gap-3.5">
          <div class="grid lg:grid-cols-[1.55fr_1fr] gap-3.5">
            <!-- activité 14j -->
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-[20px_22px]">
              <div class="flex items-baseline justify-between mb-5">
                <div>
                  <div class="font-display text-[15px] font-bold text-fg-primary">Activité · 14 jours</div>
                  <div class="text-[11.5px] text-fg-tertiary mt-0.5">Envois quotidiens par statut</div>
                </div>
                <div class="flex gap-3.5 text-[10.5px] font-mono text-fg-tertiary">
                  <span><span class="inline-block w-2 h-2 rounded-sm bg-tracky-light mr-1.5"></span>Délivré</span>
                  <span><span class="inline-block w-2 h-2 rounded-sm bg-rose-400 mr-1.5"></span>Échec</span>
                </div>
              </div>
              <div class="flex items-end gap-1.5 h-[150px]">
                @for (d of chart(); track d.day) {
                  <div class="flex-1 flex flex-col justify-end items-center gap-[3px] h-full" [title]="d.delivered + ' délivré(s), ' + d.failed + ' échec(s)'">
                    <div class="w-full flex flex-col justify-end h-full gap-0.5">
                      @if (d.failH > 0) { <div class="w-full bg-rose-400 rounded-sm" [style.height.%]="d.failH"></div> }
                      <div class="w-full bg-tracky-light rounded-b-sm rounded-t-sm" [style.height.%]="d.okH"></div>
                    </div>
                    <div class="font-mono text-[8.5px] text-fg-tertiary">{{ d.day }}</div>
                  </div>
                }
              </div>
            </div>
            <!-- breakdown -->
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-[20px_22px]">
              <div class="font-display text-[15px] font-bold text-fg-primary mb-1">Répartition par modèle</div>
              <div class="text-[11.5px] text-fg-tertiary mb-4">Volume sur 30 jours</div>
              @if (breakdown().length === 0) {
                <div class="text-[12px] text-fg-tertiary py-4">Aucun envoi sur la période.</div>
              }
              @for (b of breakdown(); track b.label) {
                <div class="mb-3.5">
                  <div class="flex justify-between items-center mb-1.5">
                    <span class="text-[12.5px] text-fg-secondary font-semibold">{{ b.label }}</span>
                    <span class="font-mono text-[11.5px] text-fg-secondary">{{ b.count }}</span>
                  </div>
                  <div class="h-1.5 bg-bg-tertiary rounded overflow-hidden">
                    <div class="h-full rounded" [class]="b.color" [style.width.%]="b.pct"></div>
                  </div>
                </div>
              }
            </div>
          </div>

          <!-- LOG TABLE -->
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
            <div class="flex items-center justify-between gap-3.5 p-[16px_22px] border-b border-border-subtle flex-wrap">
              <div class="flex items-center gap-1">
                @for (f of statusFilters; track f.id) {
                  <button (click)="setFilter(f.id)"
                          class="px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                          [class]="filter() === f.id ? 'bg-tracky-light/10 text-tracky-light' : 'text-fg-tertiary hover:text-fg-secondary'">
                    {{ f.label }}
                  </button>
                }
              </div>
              <div class="flex items-center gap-2 px-3 py-2 bg-bg-primary border border-border-subtle rounded-lg min-w-[230px]">
                <span class="text-fg-tertiary text-sm">⌕</span>
                <input [(ngModel)]="search" (keyup.enter)="reloadLogs()" (blur)="reloadLogs()"
                       placeholder="Rechercher un destinataire, une flotte…"
                       class="bg-transparent border-0 outline-none text-[12.5px] text-fg-primary placeholder:text-fg-tertiary w-full" />
              </div>
            </div>
            <div class="grid grid-cols-[2.4fr_1.7fr_1.5fr_1.1fr_0.9fr] gap-3 p-[11px_22px] border-b border-border-subtle font-mono text-[9.5px] tracking-[0.1em] uppercase text-fg-tertiary">
              <div>Destinataire</div><div>Modèle</div><div>Statut</div><div>Envoyé</div><div class="text-right">ID Resend</div>
            </div>
            <div class="max-h-[520px] overflow-y-auto">
              @if (logs().length === 0) {
                <div class="p-8 text-center text-fg-tertiary text-sm">Aucun envoi dans cette vue.</div>
              }
              @for (l of logs(); track l.id) {
                <div class="grid grid-cols-[2.4fr_1.7fr_1.5fr_1.1fr_0.9fr] gap-3 p-[14px_22px] border-b border-border-subtle/60 items-center hover:bg-bg-tertiary/40 transition-colors">
                  <div class="min-w-0">
                    <div class="text-[13px] text-fg-primary font-semibold truncate">{{ l.toAddress }}</div>
                    <div class="text-[11px] text-fg-tertiary mt-0.5 truncate">{{ l.fleetId || tplLabel(l.template) }}</div>
                  </div>
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="w-[7px] h-[7px] rounded-sm shrink-0" [class]="tplDot(l.template)"></span>
                    <span class="text-[12.5px] text-fg-secondary truncate">{{ tplLabel(l.template) }}</span>
                  </div>
                  <div>
                    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md font-mono text-[10.5px] font-semibold border"
                          [class]="badge(l.status).cls">
                      <span class="w-[5px] h-[5px] rounded-full" [class]="badge(l.status).dot"></span>{{ badge(l.status).label }}
                    </span>
                  </div>
                  <div class="font-mono text-[11.5px] text-fg-secondary">{{ l.createdAt | date: 'dd/MM HH:mm' }}</div>
                  <div class="text-right font-mono text-[10.5px] text-fg-tertiary truncate">{{ l.providerId || '—' }}</div>
                </div>
              }
            </div>
            <div class="p-[13px_22px] border-t border-border-subtle flex items-center justify-between">
              <span class="text-[11.5px] text-fg-tertiary font-mono">{{ logs().length }} envoi(s) affiché(s)</span>
              @if (nextCursor()) {
                <button (click)="loadMore()" [disabled]="loadingMore()"
                        class="text-[12px] font-semibold text-tracky-light hover:underline disabled:opacity-50">
                  Charger plus →
                </button>
              }
            </div>
          </div>
        </div>
      }

      <!-- ══ TAB : MODÈLES ══ -->
      @if (activeTab() === 'templates') {
        <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          @for (t of templates(); track t.id) {
            <button type="button" (click)="openPreview(t)"
                    class="relative overflow-hidden text-left bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-[20px_22px] hover:border-tracky-light/40 transition-colors">
              <div class="absolute top-0 left-0 right-0 h-[3px]" [class]="toneBar(t.tone)"></div>
              <div class="flex items-start justify-between mb-3.5">
                <span class="inline-flex items-center justify-center w-10 h-10 rounded-xl text-[19px]" [class]="toneSoft(t.tone)">{{ t.icon }}</span>
                <span class="font-mono text-[9px] tracking-[0.12em] uppercase px-2 py-1 rounded-md" [class]="toneSoft(t.tone) + ' ' + toneText(t.tone)">{{ t.category }}</span>
              </div>
              <div class="font-display text-[15.5px] font-bold text-fg-primary mb-1.5">{{ t.label }}</div>
              <div class="text-[12px] leading-relaxed text-fg-tertiary mb-4 min-h-[36px]">{{ t.desc }}</div>
              <div class="flex gap-2 mb-4">
                <div class="flex-1 bg-bg-primary border border-border-subtle rounded-lg p-[8px_10px]">
                  <div class="font-mono text-[8.5px] tracking-[0.08em] uppercase text-fg-tertiary mb-0.5">30 j</div>
                  <div class="font-mono text-sm font-semibold text-fg-primary">{{ t.sent30d }}</div>
                </div>
                <div class="flex-1 bg-bg-primary border border-border-subtle rounded-lg p-[8px_10px]">
                  <div class="font-mono text-[8.5px] tracking-[0.08em] uppercase text-fg-tertiary mb-0.5">Ouverture</div>
                  <div class="font-mono text-sm font-semibold" [class]="t.openRate === null ? 'text-fg-tertiary' : 'text-tracky-light'">
                    {{ t.openRate === null ? '—' : t.openRate + '%' }}
                  </div>
                </div>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-[11px] text-fg-tertiary font-mono">Dernier · {{ t.lastSentAt ? (t.lastSentAt | date: 'dd/MM HH:mm') : 'jamais' }}</span>
                <span class="text-[12px] font-bold text-tracky-light">Aperçu →</span>
              </div>
            </button>
          }
        </div>
      }

      <!-- ══ TAB : DÉLIVRABILITÉ ══ -->
      @if (activeTab() === 'deliver') {
        @if (deliver(); as d) {
          <div class="flex flex-col gap-3.5">
            <!-- domain auth -->
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-[22px_24px]">
              <div class="flex items-center justify-between mb-4.5 flex-wrap gap-2.5">
                <div>
                  <div class="font-display text-[15px] font-bold text-fg-primary">Authentification du domaine</div>
                  <div class="text-[11.5px] text-fg-tertiary mt-0.5 font-mono">{{ d.domain }}</div>
                </div>
                <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11.5px] font-bold border"
                      [class]="d.verified ? 'bg-tracky-light/[0.08] text-tracky-light border-tracky-light/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/25'">
                  {{ d.verified ? '✓ Domaine vérifié' : '! Non vérifié' }}
                </span>
              </div>
              <div class="grid sm:grid-cols-3 gap-3">
                <div class="bg-bg-primary rounded-xl p-[15px_17px] border" [class]="d.spf === 'pass' ? 'border-tracky-light/20' : 'border-amber-500/25'">
                  <div class="flex items-center justify-between mb-2">
                    <span class="font-mono text-xs font-semibold text-fg-primary">SPF</span>
                    <span class="text-[15px]" [class]="d.spf === 'pass' ? 'text-tracky-light' : 'text-amber-400'">{{ d.spf === 'pass' ? '✓' : '!' }}</span>
                  </div>
                  <div class="text-[11px] text-fg-tertiary leading-relaxed">{{ d.spf === 'pass' ? 'Enregistrement présent et aligné.' : 'À vérifier côté DNS.' }}</div>
                </div>
                <div class="bg-bg-primary rounded-xl p-[15px_17px] border" [class]="d.dkim === 'pass' ? 'border-tracky-light/20' : 'border-amber-500/25'">
                  <div class="flex items-center justify-between mb-2">
                    <span class="font-mono text-xs font-semibold text-fg-primary">DKIM</span>
                    <span class="text-[15px]" [class]="d.dkim === 'pass' ? 'text-tracky-light' : 'text-amber-400'">{{ d.dkim === 'pass' ? '✓' : '!' }}</span>
                  </div>
                  <div class="text-[11px] text-fg-tertiary leading-relaxed">Clé <span class="font-mono">resend._domainkey</span> {{ d.dkim === 'pass' ? 'signée.' : 'à configurer.' }}</div>
                </div>
                <div class="bg-bg-primary rounded-xl p-[15px_17px] border" [class]="d.dmarc === 'pass' ? 'border-tracky-light/20' : 'border-amber-500/25'">
                  <div class="flex items-center justify-between mb-2">
                    <span class="font-mono text-xs font-semibold text-fg-primary">DMARC</span>
                    <span class="text-[15px]" [class]="d.dmarc === 'pass' ? 'text-tracky-light' : 'text-amber-400'">{{ d.dmarc === 'pass' ? '✓' : '!' }}</span>
                  </div>
                  <div class="text-[11px] text-fg-tertiary leading-relaxed">{{ d.dmarc === 'pass' ? 'Politique alignée.' : 'Politique à renforcer (quarantine).' }}</div>
                </div>
              </div>
              @if (!d.verified) {
                <div class="text-[11px] text-fg-tertiary mt-3">Lecture via l'API Resend indisponible (clé absente ou domaine non ajouté) — l'auth réelle se vérifie dans le tableau de bord Resend.</div>
              }
            </div>

            <div class="grid lg:grid-cols-2 gap-3.5">
              <!-- bounce reasons -->
              <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-[22px_24px]">
                <div class="font-display text-[15px] font-bold text-fg-primary mb-1">Motifs d'échec · 30 j</div>
                <div class="text-[11.5px] text-fg-tertiary mb-4.5">{{ bounceTotal(d) }} e-mail(s) non délivré(s)</div>
                @if (d.bounceReasons.length === 0) {
                  <div class="text-[12px] text-fg-tertiary py-2">Aucun échec sur la période. 🎉</div>
                }
                @for (b of d.bounceReasons; track b.code) {
                  <div class="flex items-center justify-between py-2.5 border-b border-border-subtle/70">
                    <div class="flex items-center gap-2.5 min-w-0">
                      <span class="w-2.5 h-2.5 rounded-full shrink-0 bg-rose-400"></span>
                      <div class="min-w-0">
                        <div class="text-[13px] text-fg-primary font-semibold truncate">{{ b.label }}</div>
                        @if (b.desc) { <div class="text-[11px] text-fg-tertiary mt-0.5 truncate">{{ b.desc }}</div> }
                      </div>
                    </div>
                    <span class="font-mono text-[15px] font-semibold text-fg-primary">{{ b.count }}</span>
                  </div>
                }
              </div>
              <!-- suppression list -->
              <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-[22px_24px]">
                <div class="flex items-center justify-between mb-1">
                  <div class="font-display text-[15px] font-bold text-fg-primary">Liste de suppression</div>
                  <span class="font-mono text-[11px] text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded-md">{{ d.suppression.length }} adresse(s)</span>
                </div>
                <div class="text-[11.5px] text-fg-tertiary mb-4">Bloquées après échecs répétés — aucun envoi tant qu'elles y figurent.</div>
                @if (d.suppression.length === 0) {
                  <div class="text-[12px] text-fg-tertiary py-2">Aucune adresse supprimée.</div>
                }
                @for (s of d.suppression; track s.email) {
                  <div class="flex items-center justify-between p-[11px_13px] bg-bg-primary border border-border-subtle rounded-lg mb-2">
                    <div class="min-w-0">
                      <div class="font-mono text-xs text-fg-primary truncate">{{ s.email }}</div>
                      <div class="text-[10.5px] text-fg-tertiary mt-0.5">{{ s.reason }} · {{ s.date | date: 'dd/MM/yyyy' }}</div>
                    </div>
                  </div>
                }
              </div>
            </div>
          </div>
        }
      }
    </div>

    <!-- ══ PREVIEW DRAWER ══ -->
    @if (previewOpen()) {
      <div (click)="closePreview()" class="fixed inset-0 bg-black/70 backdrop-blur-[3px] z-[2000]"></div>
      <div class="fixed top-0 right-0 bottom-0 w-[min(560px,94vw)] bg-bg-primary border-l border-border-subtle z-[2001] overflow-y-auto em-drawer flex flex-col">
        <div class="sticky top-0 z-[2] flex items-center justify-between gap-3 p-[18px_24px] bg-bg-primary/90 backdrop-blur border-b border-border-subtle">
          <div class="min-w-0">
            <div class="font-mono text-[9.5px] tracking-[0.14em] uppercase text-tracky-light mb-0.5">Aperçu du modèle</div>
            <div class="font-display text-[17px] font-bold text-fg-primary truncate">{{ selected()?.label }}</div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button (click)="sendTest()" [disabled]="sending()"
                    class="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-bg-secondary border border-border-subtle text-fg-secondary hover:text-fg-primary hover:border-tracky-light/40 transition-colors disabled:opacity-50">
              <lucide-icon [img]="Send" [size]="13" /> Envoyer un test
            </button>
            <button (click)="closePreview()" aria-label="Fermer"
                    class="w-[34px] h-[34px] flex items-center justify-center bg-bg-secondary border border-border-subtle rounded-xl text-fg-secondary hover:text-fg-primary">
              <lucide-icon [img]="X" [size]="16" />
            </button>
          </div>
        </div>
        <div class="flex gap-2.5 p-[16px_24px] border-b border-border-subtle flex-wrap">
          <div class="flex-1 min-w-[120px]">
            <div class="font-mono text-[8.5px] tracking-[0.1em] uppercase text-fg-tertiary mb-1">Objet</div>
            <div class="text-[12.5px] text-fg-secondary leading-snug">{{ selected()?.subject }}</div>
          </div>
          <div>
            <div class="font-mono text-[8.5px] tracking-[0.1em] uppercase text-fg-tertiary mb-1">Déclencheur</div>
            <div class="text-[12.5px] text-fg-secondary">{{ selected()?.trigger }}</div>
          </div>
        </div>
        <div class="p-6 flex-1">
          @if (previewHtml()) {
            <iframe [srcdoc]="previewHtml()" sandbox="allow-same-origin"
                    class="w-full h-full min-h-[560px] rounded-xl border border-border-subtle bg-white" title="Aperçu de l'e-mail"></iframe>
          } @else {
            <div class="text-center text-fg-tertiary text-sm py-10">Chargement de l'aperçu…</div>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    @keyframes em-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    .em-pulse { animation: em-pulse 2s ease-in-out infinite; }
    @keyframes em-drawer-in { from { transform: translateX(20px); opacity: 0; } to { transform: none; opacity: 1; } }
    .em-drawer { animation: em-drawer-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) both; box-shadow: -30px 0 80px rgba(0,0,0,.4); }
    @media (prefers-reduced-motion: reduce) { .em-pulse, .em-drawer { animation: none; } }
  `],
})
export class AdminEmailsComponent implements OnInit {
  private readonly api = inject(AdminEmailsService);
  private readonly toast = inject(ToastService);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly RefreshCw = RefreshCw;
  protected readonly X = X;
  protected readonly Send = Send;

  protected readonly tabs: { key: Tab; label: string }[] = [
    { key: 'suivi', label: 'Suivi des envois' },
    { key: 'templates', label: 'Modèles' },
    { key: 'deliver', label: 'Délivrabilité' },
  ];
  protected readonly statusFilters = STATUS_FILTERS;

  protected readonly activeTab = signal<Tab>('suivi');
  protected readonly filter = signal<string>('');
  protected search = '';

  protected readonly stats = signal<EmailStats | null>(null);
  protected readonly logsList = signal<EmailLogDto[]>([]);
  protected readonly nextCursor = signal<string | undefined>(undefined);
  protected readonly templatesRaw = signal<EmailTemplateMeta[]>([]);
  protected readonly deliver = signal<Deliverability | null>(null);

  protected readonly loading = signal(false);
  protected readonly loadingMore = signal(false);
  protected readonly sending = signal(false);

  protected readonly previewOpen = signal(false);
  protected readonly selected = signal<(EmailTemplateMeta & { icon: string; tone: string }) | null>(null);
  protected readonly previewHtml = signal<SafeHtml | null>(null);

  protected readonly logs = this.logsList;
  protected readonly providerOk = computed(() => (this.stats()?.failed24h ?? 0) < 10);

  protected readonly kpis = computed(() => {
    const s = this.stats();
    return [
      { label: 'Envoyés · 30 j', value: (s?.sent ?? 0).toLocaleString('fr-FR'), unit: '', sub: 'sur les 30 derniers jours', danger: false },
      { label: 'Délivrés', value: s?.deliveredRate ?? 0, unit: '%', sub: 'taux de remise (webhooks Resend)', danger: false },
      { label: "Taux d'ouverture", value: s?.openRate ?? 0, unit: '%', sub: 'hors e-mails de sécurité', danger: false },
      { label: 'À surveiller', value: s?.failed24h ?? 0, unit: '', sub: (s?.suppressed ?? 0) + ' en suppression', danger: (s?.failed24h ?? 0) > 0 },
    ];
  });

  protected readonly chart = computed(() => {
    const series = this.stats()?.series ?? [];
    const max = Math.max(1, ...series.map((d) => d.delivered + d.failed));
    return series.map((d) => ({
      day: d.day.slice(8, 10),
      delivered: d.delivered,
      failed: d.failed,
      okH: (d.delivered / max) * 100,
      failH: d.failed > 0 ? (d.failed / max) * 100 + 1.2 : 0,
    }));
  });

  protected readonly breakdown = computed(() => {
    const bt = this.stats()?.byTemplate ?? [];
    const max = Math.max(1, ...bt.map((b) => b.count));
    return bt.map((b, i) => ({
      label: b.label,
      count: b.count.toLocaleString('fr-FR'),
      pct: (b.count / max) * 100,
      color: BREAKDOWN_COLORS[i % BREAKDOWN_COLORS.length],
    }));
  });

  protected readonly templates = computed(() =>
    this.templatesRaw().map((t) => ({
      ...t,
      icon: TPL_PRESENT[t.id]?.icon ?? '✉',
      tone: TPL_PRESENT[t.id]?.tone ?? 'green',
      desc: TPL_PRESENT[t.id]?.desc ?? '',
    })),
  );

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const [stats, logs, templates, deliver] = await Promise.all([
        firstValueFrom(this.api.stats('30d')),
        firstValueFrom(this.api.logs({ status: this.filter() || undefined, q: this.search || undefined, limit: 50 })),
        firstValueFrom(this.api.templates()),
        firstValueFrom(this.api.deliverability()),
      ]);
      this.stats.set(stats);
      this.logsList.set(logs.items);
      this.nextCursor.set(logs.nextCursor);
      this.templatesRaw.set(templates);
      this.deliver.set(deliver);
    } catch {
      this.toast.error('Échec du chargement (accès SUPER_ADMIN requis)');
    } finally {
      this.loading.set(false);
    }
  }

  async reloadLogs(): Promise<void> {
    try {
      const page = await firstValueFrom(
        this.api.logs({ status: this.filter() || undefined, q: this.search || undefined, limit: 50 }),
      );
      this.logsList.set(page.items);
      this.nextCursor.set(page.nextCursor);
    } catch {
      this.toast.error('Échec du chargement des envois');
    }
  }

  async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor) return;
    this.loadingMore.set(true);
    try {
      const page = await firstValueFrom(
        this.api.logs({ status: this.filter() || undefined, q: this.search || undefined, cursor, limit: 50 }),
      );
      this.logsList.update((l) => [...l, ...page.items]);
      this.nextCursor.set(page.nextCursor);
    } catch {
      this.toast.error('Échec du chargement');
    } finally {
      this.loadingMore.set(false);
    }
  }

  setFilter(id: string): void {
    if (this.filter() === id) return;
    this.filter.set(id);
    void this.reloadLogs();
  }

  async openPreview(t: EmailTemplateMeta & { icon: string; tone: string }): Promise<void> {
    this.selected.set(t);
    this.previewHtml.set(null);
    this.previewOpen.set(true);
    try {
      const res = await firstValueFrom(this.api.preview(t.id));
      this.previewHtml.set(this.sanitizer.bypassSecurityTrustHtml(res.html));
    } catch {
      this.toast.error("Échec du chargement de l'aperçu");
    }
  }

  closePreview(): void {
    this.previewOpen.set(false);
    this.selected.set(null);
    this.previewHtml.set(null);
  }

  async sendTest(): Promise<void> {
    const t = this.selected();
    if (!t) return;
    const to = window.prompt('Envoyer un e-mail de test à :', 'contact@vizyoagency.com');
    if (!to) return;
    this.sending.set(true);
    try {
      const res = await firstValueFrom(this.api.sendTest(t.id, to));
      if (res.ok) this.toast.success(`Test « ${t.label} » envoyé à ${to}`);
      else this.toast.error(res.error || "Échec de l'envoi de test");
    } catch {
      this.toast.error("Échec de l'envoi de test");
    } finally {
      this.sending.set(false);
    }
  }

  // ── Presentation helpers ──
  protected tplLabel(id: string): string {
    return this.templatesRaw().find((t) => t.id === id)?.label ?? id;
  }
  protected tplDot(id: string): string {
    const tone = TPL_PRESENT[id]?.tone ?? 'green';
    return tone === 'red' ? 'bg-rose-400' : tone === 'amber' ? 'bg-amber-400' : 'bg-tracky-light';
  }
  protected toneBar(tone: string): string {
    return tone === 'red' ? 'bg-rose-400' : tone === 'amber' ? 'bg-amber-400' : 'bg-tracky-light';
  }
  protected toneSoft(tone: string): string {
    return tone === 'red' ? 'bg-rose-500/10' : tone === 'amber' ? 'bg-amber-500/10' : 'bg-tracky-light/10';
  }
  protected toneText(tone: string): string {
    return tone === 'red' ? 'text-rose-400' : tone === 'amber' ? 'text-amber-400' : 'text-tracky-light';
  }
  protected bounceTotal(d: Deliverability): number {
    return d.bounceReasons.reduce((n, b) => n + b.count, 0);
  }
  protected badge(status: EmailStatus): { label: string; cls: string; dot: string } {
    switch (status) {
      case 'DELIVERED':
        return { label: 'Délivré', cls: 'bg-tracky-light/[0.08] text-tracky-light border-tracky-light/20', dot: 'bg-tracky-light' };
      case 'OPENED':
      case 'CLICKED':
        return { label: status === 'CLICKED' ? 'Cliqué' : 'Ouvert', cls: 'bg-sky-500/10 text-sky-400 border-sky-500/25', dot: 'bg-sky-400' };
      case 'BOUNCED':
        return { label: 'Rejeté', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/25', dot: 'bg-amber-400' };
      case 'COMPLAINED':
        return { label: 'Plainte', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/25', dot: 'bg-amber-400' };
      case 'FAILED':
        return { label: 'Échec', cls: 'bg-rose-500/10 text-rose-400 border-rose-500/25', dot: 'bg-rose-400' };
      case 'QUEUED':
        return { label: 'En file', cls: 'bg-fg-tertiary/10 text-fg-tertiary border-border-subtle', dot: 'bg-fg-tertiary' };
      default:
        return { label: 'Envoyé', cls: 'bg-fg-tertiary/10 text-fg-secondary border-border-subtle', dot: 'bg-fg-tertiary' };
    }
  }
}
