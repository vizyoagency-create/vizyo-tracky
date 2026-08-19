import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import type { AssistanceConversationDto, AssistanceListItemDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { LifeBuoy, LucideAngularModule, PhoneCall, Send, Sparkles, User } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import { AssistanceApiService } from '../../core/services/assistance.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * Assistance IA — l'écran de l'utilisateur.
 *
 * Conçu pour 375 px d'abord : une colonne, le fil au centre, la saisie collée en bas. Sur écran
 * large, la liste des demandes passées vient à gauche — c'est un confort, pas la structure.
 *
 * Trois choses sont dites À L'ÉCRAN plutôt que subies en silence :
 *   - le nombre de réponses automatiques restantes, AVANT d'arriver à zéro ;
 *   - que l'assistance ne fait rien à votre place : elle explique, elle n'agit pas ;
 *   - qu'un rappel humain est possible à tout moment, sans quota.
 */
@Component({
  selector: 'app-assistance',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    <div class="p-4 space-y-4 max-w-3xl mx-auto">
      <header class="space-y-1">
        <h1 class="text-lg font-semibold text-fg-primary flex items-center gap-2">
          <lucide-icon [img]="LifeBuoy" [size]="18" class="text-tracky-light" />
          Assistance
        </h1>
        <p class="text-xs text-fg-tertiary">
          Posez une question sur l'application. L'assistant explique et oriente&nbsp;; il ne modifie
          rien à votre place.
        </p>
      </header>

      @if (indisponible()) {
        <p class="rounded-lg border border-border-subtle bg-bg-secondary p-3 text-sm text-fg-secondary">
          L'assistance est momentanément indisponible. Vous pouvez tout de même demander un rappel
          depuis une demande existante.
        </p>
      }

      <!-- Demandes precedentes : replie par defaut sur mobile, c'est le fil qui compte -->
      @if (liste().length > 0 && !active()) {
        <section class="space-y-2">
          <h2 class="text-xs font-medium uppercase tracking-wide text-fg-tertiary">Vos demandes</h2>
          <ul class="space-y-2">
            @for (c of liste(); track c.id) {
              <li>
                <button type="button" (click)="ouvrir(c.id)"
                        class="w-full text-left rounded-lg border border-border-subtle bg-bg-secondary p-3
                               hover:bg-bg-tertiary transition-colors">
                  <span class="block text-sm text-fg-primary">{{ c.title }}</span>
                  <span class="block text-xs text-fg-tertiary mt-0.5 line-clamp-2">{{ c.apercu }}</span>
                </button>
              </li>
            }
          </ul>
        </section>
      }

      <!-- Le fil -->
      @if (active(); as conv) {
        <section class="space-y-3">
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-sm font-medium text-fg-primary truncate">{{ conv.title }}</h2>
            <button type="button" (click)="fermer()" class="text-xs text-fg-tertiary hover:text-fg-secondary shrink-0">
              Nouvelle demande
            </button>
          </div>

          <ul class="space-y-2">
            @for (m of conv.messages; track m.id) {
              <li class="flex gap-2" [class.justify-end]="m.role === 'user'">
                @if (m.role !== 'user') {
                  <span class="shrink-0 w-7 h-7 rounded-lg bg-bg-tertiary flex items-center justify-center self-start">
                    <lucide-icon [img]="m.role === 'admin' ? User : Sparkles" [size]="14"
                                 class="text-fg-secondary" />
                  </span>
                }
                <div class="rounded-lg px-3 py-2 text-sm max-w-[85%] whitespace-pre-line"
                     [class]="m.role === 'user'
                        ? 'bg-tracky/15 text-fg-primary'
                        : 'bg-bg-secondary border border-border-subtle text-fg-secondary'">
                  @if (m.role === 'admin') {
                    <span class="block text-xs text-fg-tertiary mb-1">Un conseiller</span>
                  }
                  {{ m.content }}
                </div>
              </li>
            }
          </ul>

          <!-- Le plafond est ANNONCE : arriver a zero sans prevenir se lit comme une panne -->
          @if (conv.reponsesRestantes <= 3) {
            <p class="text-xs text-fg-tertiary">
              @if (conv.reponsesRestantes > 0) {
                {{ conv.reponsesRestantes }} réponse(s) automatique(s) restante(s) sur cette demande.
              } @else {
                Cette demande a atteint son nombre de réponses automatiques. Demandez un rappel&nbsp;:
                un conseiller reprendra le fil.
              }
            </p>
          }

          <button type="button" (click)="rappel()" [disabled]="envoi()"
                  class="w-full inline-flex items-center justify-center gap-2 rounded-lg border
                         border-border-subtle bg-bg-secondary px-3 py-2 text-sm text-fg-secondary
                         hover:bg-bg-tertiary transition-colors disabled:opacity-40">
            <lucide-icon [img]="PhoneCall" [size]="14" />
            Demander un rappel urgent
          </button>
        </section>
      }

      <!-- Saisie -->
      <section class="space-y-2">
        <label for="assistance-msg" class="sr-only">Votre question</label>
        <textarea id="assistance-msg" rows="3" [(ngModel)]="brouillon" [disabled]="envoi()"
                  [attr.maxlength]="2000"
                  placeholder="Par exemple : pourquoi mon trajet est-il coupé en deux ?"
                  class="w-full rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2
                         text-sm text-fg-primary placeholder:text-fg-tertiary
                         focus:outline-none focus:border-border-strong disabled:opacity-40"></textarea>
        <button type="button" (click)="envoyer()" [disabled]="!peutEnvoyer()"
                class="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-tracky/20
                       border border-tracky/30 px-3 py-2 text-sm text-fg-primary
                       hover:bg-tracky/30 transition-colors disabled:opacity-40">
          <lucide-icon [img]="Send" [size]="14" />
          {{ envoi() ? 'Envoi…' : 'Envoyer' }}
        </button>
      </section>
    </div>
  `,
})
export class AssistanceComponent implements OnInit {
  private readonly api = inject(AssistanceApiService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  protected readonly LifeBuoy = LifeBuoy;
  protected readonly PhoneCall = PhoneCall;
  protected readonly Send = Send;
  protected readonly Sparkles = Sparkles;
  protected readonly User = User;

  protected readonly liste = signal<AssistanceListItemDto[]>([]);
  protected readonly active = signal<AssistanceConversationDto | null>(null);
  protected readonly envoi = signal(false);
  protected readonly indisponible = signal(false);
  protected brouillon = '';

  protected readonly peutEnvoyer = computed(() => !this.envoi());

  async ngOnInit(): Promise<void> {
    try {
      const [dispo, mes] = await Promise.all([
        firstValueFrom(this.api.disponible()),
        firstValueFrom(this.api.mesConversations()),
      ]);
      this.indisponible.set(!dispo.disponible);
      this.liste.set(mes);
      // Ouverture directe depuis une notification « un conseiller vous a répondu ».
      const cible = this.route.snapshot.queryParamMap.get('conversation');
      if (cible) await this.ouvrir(cible);
    } catch (err) {
      swallow('assistance:init', err);
    }
  }

  protected async ouvrir(id: string): Promise<void> {
    try {
      this.active.set(await firstValueFrom(this.api.conversation(id)));
    } catch (err) {
      swallow('assistance:ouvrir', err);
      this.toast.error('Demande introuvable');
    }
  }

  protected fermer(): void {
    this.active.set(null);
  }

  protected async envoyer(): Promise<void> {
    const message = this.brouillon.trim();
    if (!message || this.envoi()) return;
    this.envoi.set(true);
    try {
      const conv = await firstValueFrom(this.api.ask(message, this.active()?.id));
      this.active.set(conv);
      this.brouillon = '';
      this.liste.set(await firstValueFrom(this.api.mesConversations()));
    } catch (err) {
      swallow('assistance:envoyer', err);
      // Le message est enregistré côté serveur AVANT tout appel : on le dit, sinon la personne
      // croit avoir perdu sa question et la retape.
      this.toast.error('Réponse indisponible', 'Votre message est enregistré, réessayez dans un instant.');
    } finally {
      this.envoi.set(false);
    }
  }

  protected async rappel(): Promise<void> {
    const conv = this.active();
    if (!conv) return;
    this.envoi.set(true);
    try {
      this.active.set(await firstValueFrom(this.api.rappel(conv.id)));
      this.toast.success('Rappel demandé', 'Les responsables viennent d\'être prévenus.');
    } catch (err) {
      swallow('assistance:rappel', err);
      this.toast.error('Demande de rappel impossible');
    } finally {
      this.envoi.set(false);
    }
  }
}
