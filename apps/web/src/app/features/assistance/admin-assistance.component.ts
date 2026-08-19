import { DecimalPipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AssistanceAdminDetailDto, AssistanceAdminListItemDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { CheckCheck, Eye, LucideAngularModule, MessageSquare, Send } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import { AssistanceApiService } from '../../core/services/assistance.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * Assistance IA — l'archive côté administrateur.
 *
 * C'est ici que se joue la raison d'être de l'archivage : RELIRE ce que l'agent a répondu, le
 * CORRIGER quand il s'est trompé, et RECONTACTER la personne. Une conversation qu'on ne peut pas
 * relire ne permet ni de mesurer la qualité de l'agent, ni de réparer ce qu'il a raté.
 *
 * Deux informations n'existent que sur cet écran, et pas sur celui de l'utilisateur :
 *   - le COÛT de la conversation, parce qu'il relève de l'exploitation ;
 *   - CE QUE L'AGENT EST ALLÉ LIRE (lots consultés, volumes, refus). Le jour où quelqu'un demande
 *     « qu'est-ce que l'assistant a vu de mon compte ? », la réponse se lit ici.
 */
@Component({
  selector: 'app-admin-assistance',
  standalone: true,
  imports: [DecimalPipe, FormsModule, LucideAngularModule],
  template: `
    <div class="p-4 space-y-4">
      <header class="space-y-1">
        <h1 class="text-lg font-semibold text-fg-primary flex items-center gap-2">
          <lucide-icon [img]="MessageSquare" [size]="18" class="text-tracky-light" />
          Assistance — demandes
        </h1>
        <p class="text-xs text-fg-tertiary">
          Relire ce que l'assistant a répondu, corriger, et reprendre la main quand c'est nécessaire.
        </p>
      </header>

      <div class="flex gap-2 flex-wrap">
        @for (f of filtres; track f.valeur) {
          <button type="button" (click)="filtrer(f.valeur)"
                  class="rounded-lg border px-3 py-1.5 text-xs transition-colors"
                  [class]="statut() === f.valeur
                     ? 'border-border-strong bg-bg-tertiary text-fg-primary'
                     : 'border-border-subtle bg-bg-secondary text-fg-tertiary hover:text-fg-secondary'">
            {{ f.libelle }}
          </button>
        }
      </div>

      @if (liste().length === 0) {
        <p class="rounded-lg border border-border-subtle bg-bg-secondary p-3 text-sm text-fg-tertiary">
          Aucune demande pour ce filtre.
        </p>
      }

      <ul class="space-y-2">
        @for (c of liste(); track c.id) {
          <li class="rounded-lg border border-border-subtle bg-bg-secondary p-3 space-y-2">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="text-sm text-fg-primary truncate">{{ c.title }}</p>
                <p class="text-xs text-fg-tertiary truncate">
                  {{ c.userEmail }} @if (c.fleetName) { · {{ c.fleetName }} }
                </p>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                @if (c.severity === 'CRITICAL' || c.severity === 'HIGH') {
                  <span class="rounded px-1.5 py-0.5 text-xs bg-bg-tertiary text-fg-primary">{{ c.severity }}</span>
                }
                @if (c.reviewedAt) {
                  <lucide-icon [img]="CheckCheck" [size]="14" class="text-texte-succes" />
                }
              </div>
            </div>
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs text-fg-tertiary">
                {{ c.messageCount }} message(s) · {{ c.costEur | number: '1.4-4' }} €
              </span>
              <button type="button" (click)="ouvrir(c.id)"
                      class="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle
                             bg-bg-tertiary px-2.5 py-1 text-xs text-fg-secondary hover:text-fg-primary">
                <lucide-icon [img]="Eye" [size]="13" />
                Ouvrir
              </button>
            </div>
          </li>
        }
      </ul>

      <!-- Detail -->
      @if (detail(); as d) {
        <section class="rounded-lg border border-border-strong bg-bg-secondary p-3 space-y-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h2 class="text-sm font-medium text-fg-primary truncate">{{ d.title }}</h2>
              <p class="text-xs text-fg-tertiary truncate">{{ d.userEmail }} · {{ d.userRole }}</p>
            </div>
            <button type="button" (click)="detail.set(null)" class="text-xs text-fg-tertiary shrink-0">Fermer</button>
          </div>

          @if (d.escalatedReason) {
            <p class="rounded border border-border-subtle bg-bg-tertiary p-2 text-xs text-fg-secondary">
              Reprise demandée&nbsp;: {{ d.escalatedReason }}
            </p>
          }

          <ul class="space-y-2">
            @for (m of d.messages; track m.id) {
              <li class="rounded-lg border border-border-subtle bg-bg-primary p-2.5 space-y-1">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs text-fg-tertiary">{{ roleLabel(m.role) }}</span>
                  @if (m.model) {
                    <span class="text-xs text-fg-tertiary">{{ m.costEur | number: '1.4-4' }} €</span>
                  }
                </div>
                <p class="text-sm text-fg-secondary whitespace-pre-line">{{ m.content }}</p>
                <!-- Audit du cloisonnement : ce que l'agent est alle LIRE, jamais les donnees -->
                @if (m.contextUsed?.length) {
                  <p class="text-xs text-fg-tertiary">
                    Consulté&nbsp;:
                    @for (ctx of m.contextUsed; track ctx.key) {
                      <span>{{ ctx.key }} ({{ ctx.refuse ? 'refusé' : ctx.volume }})&nbsp;</span>
                    }
                  </p>
                }
              </li>
            }
          </ul>

          <!-- Reprendre la main : le message part dans le fil que l'utilisateur voit -->
          <div class="space-y-2">
            <label for="admin-reply" class="text-xs text-fg-tertiary">Répondre en tant que conseiller</label>
            <textarea id="admin-reply" rows="3" [(ngModel)]="reponse" [disabled]="occupe()"
                      class="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm
                             text-fg-primary placeholder:text-fg-tertiary focus:outline-none
                             focus:border-border-strong disabled:opacity-40"></textarea>
            <button type="button" (click)="repondre(d.id)" [disabled]="occupe() || !reponse.trim()"
                    class="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-tracky/20
                           border border-tracky/30 px-3 py-2 text-sm text-fg-primary
                           hover:bg-tracky/30 transition-colors disabled:opacity-40">
              <lucide-icon [img]="Send" [size]="14" />
              Envoyer au demandeur
            </button>
          </div>

          <!-- Relecture : ce qui manquait a l'agent, pour l'ameliorer plus tard -->
          <div class="space-y-2 border-t border-border-subtle pt-3">
            <label for="admin-note" class="text-xs text-fg-tertiary">
              Ce que l'assistant aurait dû répondre (sert à l'améliorer)
            </label>
            <textarea id="admin-note" rows="2" [(ngModel)]="note" [disabled]="occupe()"
                      class="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm
                             text-fg-primary placeholder:text-fg-tertiary focus:outline-none
                             focus:border-border-strong disabled:opacity-40"></textarea>
            <button type="button" (click)="relire(d.id)" [disabled]="occupe()"
                    class="w-full inline-flex items-center justify-center gap-2 rounded-lg border
                           border-border-subtle bg-bg-tertiary px-3 py-2 text-sm text-fg-secondary
                           hover:text-fg-primary transition-colors disabled:opacity-40">
              <lucide-icon [img]="CheckCheck" [size]="14" />
              Marquer relue
            </button>
            @if (d.reviewedAt) {
              <p class="text-xs text-fg-tertiary">Relue par {{ d.reviewedByEmail }}.</p>
            }
          </div>
        </section>
      }
    </div>
  `,
})
export class AdminAssistanceComponent implements OnInit {
  private readonly api = inject(AssistanceApiService);
  private readonly toast = inject(ToastService);

  protected readonly CheckCheck = CheckCheck;
  protected readonly Eye = Eye;
  protected readonly MessageSquare = MessageSquare;
  protected readonly Send = Send;

  protected readonly filtres = [
    { valeur: '', libelle: 'Toutes' },
    { valeur: 'escalated', libelle: 'À reprendre' },
    { valeur: 'open', libelle: 'En cours' },
    { valeur: 'closed', libelle: 'Closes' },
  ];

  protected readonly liste = signal<AssistanceAdminListItemDto[]>([]);
  protected readonly detail = signal<AssistanceAdminDetailDto | null>(null);
  protected readonly statut = signal('');
  protected readonly occupe = signal(false);
  protected reponse = '';
  protected note = '';

  async ngOnInit(): Promise<void> {
    await this.charger();
  }

  protected roleLabel(role: string): string {
    return role === 'user' ? 'Demandeur' : role === 'admin' ? 'Conseiller' : 'Assistant';
  }

  protected async filtrer(valeur: string): Promise<void> {
    this.statut.set(valeur);
    await this.charger();
  }

  private async charger(): Promise<void> {
    try {
      this.liste.set(await firstValueFrom(this.api.adminListe(this.statut() || undefined)));
    } catch (err) {
      swallow('assistance-admin:charger', err);
    }
  }

  protected async ouvrir(id: string): Promise<void> {
    try {
      const d = await firstValueFrom(this.api.adminDetail(id));
      this.detail.set(d);
      this.note = d.reviewNote ?? '';
      this.reponse = '';
    } catch (err) {
      swallow('assistance-admin:ouvrir', err);
      this.toast.error('Demande introuvable');
    }
  }

  protected async repondre(id: string): Promise<void> {
    const message = this.reponse.trim();
    if (!message) return;
    this.occupe.set(true);
    try {
      this.detail.set(await firstValueFrom(this.api.repondre(id, message)));
      this.reponse = '';
      this.toast.success('Réponse envoyée', 'Le demandeur est prévenu.');
      await this.charger();
    } catch (err) {
      swallow('assistance-admin:repondre', err);
      this.toast.error('Envoi impossible');
    } finally {
      this.occupe.set(false);
    }
  }

  protected async relire(id: string): Promise<void> {
    this.occupe.set(true);
    try {
      this.detail.set(await firstValueFrom(this.api.relire(id, { note: this.note.trim() || undefined })));
      this.toast.success('Demande marquée relue');
      await this.charger();
    } catch (err) {
      swallow('assistance-admin:relire', err);
      this.toast.error('Enregistrement impossible');
    } finally {
      this.occupe.set(false);
    }
  }
}
