import { DatePipe } from '@angular/common';
import {
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import {
  BookOpen,
  ChevronLeft,
  CircleAlert,
  Clock,
  EyeOff,
  FileText,
  History,
  LayoutDashboard,
  LoaderCircle,
  LucideAngularModule,
  Search,
  ShieldAlert,
  Wrench,
  X,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  CentreAlerteWikiService,
  type WikiDocument,
  type WikiFiche,
  type WikiIndex,
} from '../../core/services/centre-alerte-wiki.service';
import { renderMarkdown, renderPlainCode } from '../../shared/utils/markdown.util';

/** Une entrée du sommaire d'un document, dérivée des titres rendus. */
interface TocEntry {
  id: string;
  text: string;
  level: number;
}

/** Habillage d'un statut. Le libellé, lui, vient du manifeste. */
const STATUT_STYLE: Record<string, { bord: string; puce: string; fond: string }> = {
  NON_CORRIGE: { bord: 'border-l-rose-500', puce: 'bg-rose-500/15 text-rose-300 border-rose-500/30', fond: 'bg-rose-500/[0.04]' },
  CORRECTIF_PROPOSE: { bord: 'border-l-amber-500', puce: 'bg-amber-500/15 text-amber-300 border-amber-500/30', fond: 'bg-amber-500/[0.03]' },
  TERRAIN: { bord: 'border-l-sky-500', puce: 'bg-sky-500/15 text-sky-300 border-sky-500/30', fond: '' },
  CORRIGE: { bord: 'border-l-emerald-500', puce: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', fond: '' },
  BRUIT: { bord: 'border-l-slate-500', puce: 'bg-slate-500/15 text-slate-300 border-slate-500/30', fond: '' },
};
const STATUT_STYLE_DEFAUT = { bord: 'border-l-slate-600', puce: 'bg-slate-500/15 text-slate-300 border-slate-500/30', fond: '' };

/**
 * WIKI DU CENTRE D'ALERTE — `docs/centre-alerte/` affiché dans l'écran d'administration.
 *
 * ══ Ce que l'accueil doit répondre ════════════════════════════════════════════════════
 *
 * Une liste de fichiers ne dit pas où on en est. L'accueil est donc un TABLEAU DE BORD qui
 * répond à trois questions, dans cet ordre :
 *
 *   **QUAND** — depuis quand ce défaut existe, quand il a été vu pour la dernière fois,
 *               combien de fois ;
 *   **QUOI**  — la cause racine en une phrase, pas le message d'erreur ;
 *   **QUOI FAIRE** — l'action, à l'impératif, précise au point de pouvoir être appliquée
 *               sans refaire l'enquête.
 *
 * Ces trois champs viennent de `app/wiki.json` (tableau `fiches`), tenu à jour par l'audit.
 * Les documents, eux, sont découverts automatiquement : un rapport déposé s'affiche même
 * s'il n'est déclaré nulle part — un oubli ne doit jamais rendre un rapport invisible.
 */
@Component({
  selector: 'app-centre-alerte-wiki',
  standalone: true,
  imports: [LucideAngularModule, DatePipe],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex items-center justify-center"
           role="dialog" aria-modal="true" aria-label="Documentation du centre d'alerte">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" (click)="close.emit()" aria-hidden="true"></div>

        <div class="relative bg-bg-primary border border-border-subtle rounded-[--radius-card]
                    w-full h-full sm:w-[min(1180px,95vw)] sm:h-[min(900px,93vh)]
                    shadow-2xl flex flex-col overflow-hidden">

          <!-- ── En-tete ─────────────────────────────────────────────────────────── -->
          <header class="flex items-center gap-3 px-4 py-3 border-b border-border-subtle shrink-0">
            @if (pane() === 'content') {
              <button (click)="pane.set('list')"
                      class="md:hidden p-1.5 rounded-lg text-fg-tertiary hover:text-fg-primary cursor-pointer"
                      aria-label="Retour au sommaire">
                <lucide-icon [img]="ChevronLeft" [size]="18"></lucide-icon>
              </button>
            }
            <lucide-icon [img]="BookOpen" [size]="18" class="text-tracky shrink-0"></lucide-icon>
            <div class="min-w-0 flex-1">
              <h2 class="text-sm sm:text-base font-display font-bold text-fg-primary truncate">
                {{ index()?.title ?? "Documentation du centre d'alerte" }}
              </h2>
              @if (index(); as idx) {
                <p class="text-[11px] text-fg-tertiary truncate">
                  {{ idx.documentCount }} document{{ idx.documentCount > 1 ? 's' : '' }}
                  @if (idx.fiches.length) { · {{ idx.fiches.length }} fiches }
                  @if (dernierPassage(); as p) { · dernier audit le {{ p.date }} }
                </p>
              }
            </div>
            <button (click)="close.emit()"
                    class="p-1.5 rounded-lg text-fg-tertiary hover:text-fg-primary cursor-pointer shrink-0"
                    aria-label="Fermer">
              <lucide-icon [img]="X" [size]="18"></lucide-icon>
            </button>
          </header>

          <div class="flex-1 flex min-h-0">

            <!-- ── Sommaire ──────────────────────────────────────────────────────── -->
            <aside class="w-full md:w-[272px] shrink-0 border-r border-border-subtle
                          flex-col bg-bg-secondary/40 overflow-y-auto md:flex"
                   [class.hidden]="pane() === 'content'"
                   [class.flex]="pane() === 'list'">
              <div class="p-3 sticky top-0 z-10 bg-bg-secondary/95 backdrop-blur border-b border-border-subtle">
                <div class="relative">
                  <lucide-icon [img]="Search" [size]="13"
                               class="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-tertiary"></lucide-icon>
                  <input type="search" [value]="filter()" (input)="onFilter($event)"
                         placeholder="Filtrer les documents…"
                         class="w-full pl-8 pr-2 py-2 bg-bg-tertiary border border-border-subtle rounded-lg
                                text-xs text-fg-primary placeholder:text-fg-tertiary outline-none
                                focus:border-tracky/50" />
                </div>
              </div>

              <nav class="p-2 flex flex-col gap-3">
                <button (click)="showHome()"
                        class="flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-semibold cursor-pointer text-left"
                        [class]="selected() === null
                          ? 'bg-tracky/15 text-tracky-light border border-tracky/30'
                          : 'text-fg-secondary hover:bg-bg-tertiary border border-transparent'">
                  <lucide-icon [img]="LayoutDashboard" [size]="14" class="shrink-0"></lucide-icon>
                  <span class="flex-1">Tableau de bord</span>
                  @if (nbATraiter() > 0) {
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">
                      {{ nbATraiter() }}
                    </span>
                  }
                </button>

                @for (section of visibleSections(); track section.key) {
                  <div>
                    <div class="px-2.5 pb-1 text-[10px] uppercase tracking-wide text-fg-tertiary font-semibold">
                      {{ section.label }}
                    </div>
                    <div class="flex flex-col gap-0.5">
                      @for (doc of section.documents; track doc.slug) {
                        <button (click)="openDoc(doc.slug)"
                                class="flex items-start gap-2 px-2.5 py-2 rounded-lg text-left cursor-pointer"
                                [class]="selected() === doc.slug
                                  ? 'bg-tracky/15 border border-tracky/30'
                                  : 'hover:bg-bg-tertiary border border-transparent'">
                          <lucide-icon [img]="FileText" [size]="13"
                                       class="shrink-0 mt-0.5"
                                       [class]="selected() === doc.slug ? 'text-tracky-light' : 'text-fg-tertiary'"></lucide-icon>
                          <span class="min-w-0">
                            <span class="block text-xs font-medium leading-snug"
                                  [class]="selected() === doc.slug ? 'text-tracky-light' : 'text-fg-secondary'">
                              {{ doc.title }}
                            </span>
                            @if (doc.description) {
                              <span class="block text-[10px] text-fg-tertiary leading-snug mt-0.5">{{ doc.description }}</span>
                            }
                          </span>
                        </button>
                      }
                    </div>
                  </div>
                } @empty {
                  <p class="px-2.5 py-6 text-xs text-fg-tertiary text-center">Aucun document ne correspond.</p>
                }
              </nav>
            </aside>

            <!-- ── Contenu ───────────────────────────────────────────────────────── -->
            <section #contentPane class="flex-1 min-w-0 overflow-y-auto md:block"
                     [class.hidden]="pane() === 'list'">

              @if (loading()) {
                <div class="h-full flex items-center justify-center text-tracky">
                  <lucide-icon [img]="LoaderCircle" [size]="26" class="animate-spin"></lucide-icon>
                </div>
              } @else if (error(); as err) {
                <div class="p-6">
                  <div class="rounded-[--radius-card] border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
                    {{ err }}
                  </div>
                </div>
              } @else if (selected() === null) {

                <!-- ═══ TABLEAU DE BORD ═══════════════════════════════════════════ -->
                <div class="p-5 sm:p-7">

                  <!-- Bandeau d'etat : la phrase qui compte -->
                  <div class="rounded-[--radius-card] border p-4 mb-5"
                       [class]="nbATraiter() > 0
                         ? 'border-rose-500/30 bg-rose-500/[0.07]'
                         : 'border-emerald-500/30 bg-emerald-500/[0.07]'">
                    <div class="flex items-start gap-3">
                      <lucide-icon [img]="nbATraiter() > 0 ? ShieldAlert : BookOpen" [size]="20"
                                   class="shrink-0 mt-0.5"
                                   [class]="nbATraiter() > 0 ? 'text-rose-400' : 'text-emerald-400'"></lucide-icon>
                      <div class="min-w-0">
                        <p class="text-sm font-semibold"
                           [class]="nbATraiter() > 0 ? 'text-rose-200' : 'text-emerald-200'">
                          {{ phraseEtat() }}
                        </p>
                        @if (dernierPassage(); as p) {
                          <p class="text-xs text-fg-secondary mt-1.5 leading-relaxed">{{ p.verdict }}</p>
                          <p class="text-[11px] text-fg-tertiary mt-1">
                            Dernier audit : {{ p.date }}@if (p.origine) { · {{ p.origine }}}@if (p.rapport) {
                              · <button (click)="openDoc(p.rapport!)" class="text-tracky-light hover:underline cursor-pointer">lire le rapport</button>
                            }
                          </p>
                        }
                      </div>
                    </div>
                  </div>

                  <!-- Filtres par statut -->
                  <div class="flex flex-wrap gap-1.5 mb-4">
                    <button (click)="statutFiltre.set(null)"
                            class="px-2.5 py-1 rounded-lg text-[11px] font-semibold border cursor-pointer"
                            [class]="statutFiltre() === null
                              ? 'bg-fg-primary/10 text-fg-primary border-fg-primary/25'
                              : 'text-fg-tertiary border-border-subtle hover:text-fg-secondary'">
                      Tout ({{ index()?.fiches?.length ?? 0 }})
                    </button>
                    @for (s of statutsAvecCompte(); track s.cle) {
                      <button (click)="statutFiltre.set(statutFiltre() === s.cle ? null : s.cle)"
                              class="px-2.5 py-1 rounded-lg text-[11px] font-semibold border cursor-pointer"
                              [class]="statutFiltre() === s.cle ? style(s.cle).puce : 'text-fg-tertiary border-border-subtle hover:text-fg-secondary'"
                              [title]="s.aide ?? ''">
                        {{ s.puce }} {{ s.libelle }} ({{ s.compte }})
                      </button>
                    }
                  </div>

                  <!-- Fiches : quand / quoi / quoi faire -->
                  @for (f of fichesVisibles(); track f.id) {
                    <article class="mb-3 rounded-[--radius-card] border border-border-subtle border-l-[3px] p-4"
                             [class]="style(f.statut).bord + ' ' + (style(f.statut).fond || 'bg-bg-secondary')">
                      <div class="flex items-center gap-2 flex-wrap mb-1.5">
                        <span class="font-mono text-[11px] font-bold text-fg-primary">{{ f.id }}</span>
                        <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold border" [class]="style(f.statut).puce">
                          {{ libelleStatut(f.statut) }}
                        </span>
                        <span class="text-[10px] text-fg-tertiary font-mono ml-auto">{{ f.source }}</span>
                      </div>
                      <h4 class="text-sm font-display font-bold text-fg-primary mb-2.5 leading-snug">{{ f.titre }}</h4>

                      <dl class="space-y-2">
                        <div class="flex gap-2.5">
                          <dt class="w-[86px] shrink-0 text-[10px] uppercase tracking-wide text-fg-tertiary font-semibold pt-0.5 flex items-center gap-1">
                            <lucide-icon [img]="Clock" [size]="11"></lucide-icon> Quand
                          </dt>
                          <dd class="text-xs text-fg-secondary">{{ quandLabel(f) }}</dd>
                        </div>
                        <div class="flex gap-2.5">
                          <dt class="w-[86px] shrink-0 text-[10px] uppercase tracking-wide text-fg-tertiary font-semibold pt-0.5 flex items-center gap-1">
                            <lucide-icon [img]="CircleAlert" [size]="11"></lucide-icon> Quoi
                          </dt>
                          <dd class="text-xs text-fg-secondary leading-relaxed">{{ f.quoi }}</dd>
                        </div>
                        <div class="flex gap-2.5">
                          <dt class="w-[86px] shrink-0 text-[10px] uppercase tracking-wide font-semibold pt-0.5 flex items-center gap-1 text-tracky-light">
                            <lucide-icon [img]="Wrench" [size]="11"></lucide-icon> Quoi faire
                          </dt>
                          <dd class="text-xs text-fg-primary leading-relaxed">{{ f.quoiFaire }}</dd>
                        </div>
                      </dl>

                      @if (f.pourquoiInvisible) {
                        <p class="mt-2.5 text-[11px] text-amber-300/90 bg-amber-500/[0.07] border border-amber-500/20 rounded-lg px-2.5 py-1.5 flex gap-1.5">
                          <lucide-icon [img]="EyeOff" [size]="12" class="shrink-0 mt-0.5"></lucide-icon>
                          <span><strong>Pourquoi c'est invisible :</strong> {{ f.pourquoiInvisible }}</span>
                        </p>
                      }
                      @if (f.aNePasFaire) {
                        <p class="mt-2 text-[11px] text-sky-300/90 bg-sky-500/[0.07] border border-sky-500/20 rounded-lg px-2.5 py-1.5">
                          <strong>À ne pas faire :</strong> {{ f.aNePasFaire }}
                        </p>
                      }
                      @if (f.seuilReescalade) {
                        <p class="mt-2 text-[11px] text-fg-tertiary italic">Seuil de ré-escalade : {{ f.seuilReescalade }}</p>
                      }

                      @if (f.doc) {
                        <div class="mt-3 flex justify-end">
                          <button (click)="openDoc(f.doc!, f.ancre)"
                                  class="text-[11px] text-tracky-light hover:underline cursor-pointer">
                            Ouvrir la fiche complète →
                          </button>
                        </div>
                      }
                    </article>
                  } @empty {
                    <p class="text-sm text-fg-tertiary py-6 text-center">Aucune fiche pour ce filtre.</p>
                  }

                  <!-- Journal des passages -->
                  <h3 class="text-xs uppercase tracking-wide text-fg-tertiary font-semibold mt-8 mb-3 flex items-center gap-1.5">
                    <lucide-icon [img]="History" [size]="13"></lucide-icon> Journal des passages d'audit
                  </h3>
                  @for (p of index()?.passages ?? []; track p.date + (p.rapport ?? '')) {
                    <article class="mb-2.5 rounded-[--radius-card] border border-border-subtle bg-bg-secondary p-3.5">
                      <div class="flex items-center gap-2 flex-wrap mb-1.5">
                        <span class="text-sm font-display font-bold text-fg-primary">{{ p.date }}</span>
                        @if (p.origine) {
                          <span class="text-[10px] uppercase px-1.5 py-0.5 rounded border border-border-subtle text-fg-tertiary">{{ p.origine }}</span>
                        }
                        @if (p.fiches?.nouvelles) {
                          <span class="text-[10px] px-1.5 py-0.5 rounded bg-tracky/15 text-tracky-light border border-tracky/30">
                            +{{ p.fiches!.nouvelles }} fiche{{ p.fiches!.nouvelles! > 1 ? 's' : '' }}
                          </span>
                        }
                        @if (p.rapport) {
                          <button (click)="openDoc(p.rapport!)"
                                  class="ml-auto text-[11px] text-tracky-light hover:underline cursor-pointer">
                            Lire le rapport →
                          </button>
                        }
                      </div>
                      @if (p.verdict) {
                        <p class="text-xs text-fg-secondary leading-relaxed mb-2">{{ p.verdict }}</p>
                      }
                      @if (p.chiffres) {
                        <div class="flex flex-wrap gap-x-4 gap-y-1">
                          @for (kv of chiffresOf(p.chiffres); track kv[0]) {
                            <span class="text-[11px] text-fg-tertiary">
                              {{ kv[0] }} <strong class="text-fg-secondary font-mono">{{ kv[1] }}</strong>
                            </span>
                          }
                        </div>
                      }
                      @if (p.note) {
                        <p class="text-[11px] text-fg-tertiary mt-2 italic">{{ p.note }}</p>
                      }
                    </article>
                  } @empty {
                    <p class="text-sm text-fg-tertiary">Aucun passage enregistré pour l'instant.</p>
                  }
                </div>

              } @else if (doc(); as d) {

                <!-- ═══ LECTURE D'UN DOCUMENT ═════════════════════════════════════ -->
                <div class="p-5 sm:p-7">
                  <div class="flex items-baseline gap-3 flex-wrap mb-4 pb-3 border-b border-border-subtle">
                    <h3 class="text-lg font-display font-bold text-fg-primary">{{ d.title }}</h3>
                    <span class="text-[11px] text-fg-tertiary font-mono">{{ d.slug }}</span>
                    <span class="text-[11px] text-fg-tertiary ml-auto">
                      modifié le {{ d.updatedAt | date: 'dd/MM/yyyy HH:mm' }}
                    </span>
                  </div>

                  <div class="flex gap-7">
                    <!-- Le HTML provient de notre propre rendu markdown ; voir renderedHtml(). -->
                    <div class="wiki-body flex-1 min-w-0" [innerHTML]="renderedHtml()" (click)="onBodyClick($event)"></div>

                    @if (toc().length > 2) {
                      <nav class="hidden xl:block w-[190px] shrink-0 self-start sticky top-0">
                        <div class="text-[10px] uppercase tracking-wide text-fg-tertiary font-semibold mb-2">
                          Dans ce document
                        </div>
                        <ul class="space-y-1 border-l border-border-subtle">
                          @for (t of toc(); track t.id) {
                            <li>
                              <button (click)="scrollTo(t.id)"
                                      class="block w-full text-left text-[11px] leading-snug py-1 pl-2.5 -ml-px
                                             border-l border-transparent text-fg-tertiary
                                             hover:text-tracky-light hover:border-tracky/50 cursor-pointer"
                                      [style.padding-left.px]="t.level === 2 ? 10 : 20">
                                {{ t.text }}
                              </button>
                            </li>
                          }
                        </ul>
                      </nav>
                    }
                  </div>

                  @if (d.truncated) {
                    <p class="mt-4 text-xs text-amber-300">Document tronqué à l'affichage (trop volumineux).</p>
                  }
                </div>
              }
            </section>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host ::ng-deep .wiki-body { color: var(--fg-secondary, #C7CFCB); font-size: 13.5px; line-height: 1.7; }
    :host ::ng-deep .wiki-body h1 { font-size: 20px; font-weight: 800; color: var(--fg-primary, #EAEFED); margin: 22px 0 10px; }
    :host ::ng-deep .wiki-body h2 { font-size: 16.5px; font-weight: 700; color: var(--tracky-light, #3EEBB8); margin: 26px 0 8px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,.07); scroll-margin-top: 8px; }
    :host ::ng-deep .wiki-body h3 { font-size: 14.5px; font-weight: 700; color: var(--fg-primary, #EAEFED); margin: 18px 0 6px; scroll-margin-top: 8px; }
    :host ::ng-deep .wiki-body h4, :host ::ng-deep .wiki-body h5, :host ::ng-deep .wiki-body h6 { font-size: 13.5px; font-weight: 700; color: var(--fg-primary, #EAEFED); margin: 14px 0 4px; }
    :host ::ng-deep .wiki-body p { margin: 8px 0; }
    :host ::ng-deep .wiki-body strong { color: var(--fg-primary, #EAEFED); font-weight: 700; }
    :host ::ng-deep .wiki-body a { color: var(--tracky-light, #3EEBB8); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
    :host ::ng-deep .wiki-body ul, :host ::ng-deep .wiki-body ol { margin: 8px 0 8px 20px; }
    :host ::ng-deep .wiki-body li { margin: 4px 0; }
    :host ::ng-deep .wiki-body code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.08); border-radius: 5px; padding: 1px 5px; color: var(--fg-primary, #EAEFED); }
    :host ::ng-deep .wiki-body pre { background: var(--bg-tertiary, #121917); border: 1px solid rgba(255,255,255,.09); border-radius: 10px; padding: 12px 14px; overflow-x: auto; margin: 12px 0; }
    :host ::ng-deep .wiki-body pre code { background: none; border: none; padding: 0; font-size: 11.5px; line-height: 1.6; white-space: pre; }
    :host ::ng-deep .wiki-body blockquote { border-left: 3px solid var(--tracky, #10E0A0); background: rgba(16,224,160,.06); padding: 2px 14px; margin: 12px 0; border-radius: 0 8px 8px 0; }
    :host ::ng-deep .wiki-body hr { border: none; border-top: 1px solid rgba(255,255,255,.09); margin: 20px 0; }
    /* Le tableau porte son propre defilement : la page ne doit jamais deborder lateralement. */
    :host ::ng-deep .wiki-body table { display: block; width: 100%; overflow-x: auto; border-collapse: collapse; margin: 12px 0; font-size: 12.5px; }
    :host ::ng-deep .wiki-body th, :host ::ng-deep .wiki-body td { border: 1px solid rgba(255,255,255,.1); padding: 7px 10px; text-align: left; vertical-align: top; }
    :host ::ng-deep .wiki-body th { background: rgba(255,255,255,.04); color: var(--fg-primary, #EAEFED); font-weight: 700; white-space: nowrap; }
    :host ::ng-deep .wiki-body del { opacity: .6; }
  `],
})
export class CentreAlerteWikiComponent {
  private readonly api = inject(CentreAlerteWikiService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly contentPane = viewChild<ElementRef<HTMLElement>>('contentPane');

  readonly open = input.required<boolean>();
  readonly close = output<void>();

  protected readonly BookOpen = BookOpen;
  protected readonly ChevronLeft = ChevronLeft;
  protected readonly CircleAlert = CircleAlert;
  protected readonly Clock = Clock;
  protected readonly EyeOff = EyeOff;
  protected readonly FileText = FileText;
  protected readonly History = History;
  protected readonly LayoutDashboard = LayoutDashboard;
  protected readonly LoaderCircle = LoaderCircle;
  protected readonly Search = Search;
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly Wrench = Wrench;
  protected readonly X = X;

  protected readonly index = signal<WikiIndex | null>(null);
  protected readonly doc = signal<WikiDocument | null>(null);
  protected readonly selected = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly filter = signal('');
  protected readonly statutFiltre = signal<string | null>(null);
  /** Sur mobile une seule colonne tient à l'écran ; sur ≥ md les deux sont visibles. */
  protected readonly pane = signal<'list' | 'content'>('list');

  private loaded = false;

  constructor() {
    // Chargement à la PREMIÈRE ouverture, pas au montage : le modal est instancié avec la
    // page mais ne doit rien demander au serveur tant qu'il est fermé. Un `effect` sur
    // l'input signal `open` fait ça sans passer par un hook de cycle de vie.
    effect(() => {
      if (this.open() && !this.loaded) {
        this.loaded = true;
        void this.loadIndex();
      }
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.open()) this.close.emit();
  }

  // ── Tableau de bord ──────────────────────────────────────────────────────────────

  protected style(cle: string) {
    return STATUT_STYLE[cle] ?? STATUT_STYLE_DEFAUT;
  }

  protected libelleStatut(cle: string): string {
    return this.index()?.statuts.find((s) => s.cle === cle)?.libelle ?? cle;
  }

  protected readonly fichesTriees = computed(() =>
    [...(this.index()?.fiches ?? [])].sort((a, b) => (a.gravite ?? 99) - (b.gravite ?? 99)),
  );

  protected readonly fichesVisibles = computed(() => {
    const f = this.statutFiltre();
    return f ? this.fichesTriees().filter((x) => x.statut === f) : this.fichesTriees();
  });

  protected readonly nbATraiter = computed(
    () => this.fichesTriees().filter((f) => f.statut === 'NON_CORRIGE').length,
  );

  /** Statuts du manifeste, dans leur ordre, avec le nombre de fiches de chacun. */
  protected readonly statutsAvecCompte = computed(() => {
    const fiches = this.fichesTriees();
    return [...(this.index()?.statuts ?? [])]
      .sort((a, b) => (a.ordre ?? 99) - (b.ordre ?? 99))
      .map((s) => ({ ...s, compte: fiches.filter((f) => f.statut === s.cle).length }))
      .filter((s) => s.compte > 0);
  });

  protected readonly dernierPassage = computed(() => this.index()?.passages?.[0] ?? null);

  /** La phrase d'état — celle qu'on lit même quand on ne lit rien d'autre. */
  protected readonly phraseEtat = computed(() => {
    const fiches = this.fichesTriees();
    if (!fiches.length) return 'Aucune fiche au référentiel.';
    const n = this.nbATraiter();
    const proposes = fiches.filter((f) => f.statut === 'CORRECTIF_PROPOSE').length;
    const terrain = fiches.filter((f) => f.statut === 'TERRAIN').length;
    if (n === 0) {
      return proposes > 0
        ? `Aucun défaut sans correctif — ${proposes} correctif${proposes > 1 ? 's' : ''} écrit${proposes > 1 ? 's' : ''}, en attente de livraison.`
        : 'Aucun défaut ouvert au référentiel.';
    }
    const bouts = [`${n} défaut${n > 1 ? 's' : ''} à traiter`];
    if (proposes) bouts.push(`${proposes} correctif${proposes > 1 ? 's' : ''} en attente`);
    if (terrain) bouts.push(`${terrain} action${terrain > 1 ? 's' : ''} terrain`);
    return `${bouts.join(' · ')}. À commencer par ${fiches[0].id}.`;
  });

  /** « Quand » d'une fiche : période observée + volume, en une ligne lisible. */
  protected quandLabel(f: WikiFiche): string {
    const bouts: string[] = [];
    if (f.vuPremiere && f.vuDerniere) {
      bouts.push(
        f.vuPremiere === f.vuDerniere
          ? `vu le ${f.vuPremiere}`
          : `du ${f.vuPremiere} au ${f.vuDerniere}`,
      );
    } else if (f.vuDerniere) {
      bouts.push(`vu le ${f.vuDerniere}`);
    }
    if (f.occurrencesLibelle) bouts.push(f.occurrencesLibelle);
    else if (typeof f.occurrences === 'number') {
      bouts.push(`${f.occurrences} occurrence${f.occurrences > 1 ? 's' : ''}`);
    }
    return bouts.join(' · ') || '—';
  }

  protected chiffresOf(chiffres: Record<string, number>): [string, number][] {
    const labels: Record<string, string> = {
      erreurs: 'erreurs',
      critical: 'critical',
      trackersFailing: 'FAILING',
      trackersHorsLigne: 'hors ligne',
      commandesEnAttente: 'cmd. en attente',
      echecsCommandesParJour: 'échecs cmd./jour',
      cadenceSousMinimum: 'cadence sous minimum',
    };
    return Object.entries(chiffres).map(([k, v]) => [labels[k] ?? k, v]);
  }

  // ── Documents ────────────────────────────────────────────────────────────────────

  protected visibleSections = computed(() => {
    const idx = this.index();
    if (!idx) return [];
    const needle = this.filter().trim().toLowerCase();
    if (!needle) return idx.sections;
    return idx.sections
      .map((s) => ({
        ...s,
        documents: s.documents.filter(
          (d) =>
            d.title.toLowerCase().includes(needle) ||
            d.slug.toLowerCase().includes(needle) ||
            (d.description ?? '').toLowerCase().includes(needle),
        ),
      }))
      .filter((s) => s.documents.length > 0);
  });

  /**
   * ⚠️ SEUL POINT DE CONFIANCE EXPLICITE DE CE COMPOSANT.
   *
   * `bypassSecurityTrustHtml` est légitime ici parce que la chaîne rendue est produite
   * intégralement par `markdown.util.ts`, qui **échappe chaque fragment de texte AVANT**
   * toute transformation et filtre les URL par schéma. Aucun balisage du document source
   * ne survit : un `<script>` dans un fichier .md ressort en `&lt;script&gt;`.
   *
   * On contourne le sanitizer plutôt que de le subir parce qu'il retire les attributs
   * `data-*` et casserait la navigation interne entre documents — sans rien ajouter, le
   * contenu étant déjà sûr en amont.
   *
   * 🔒 Ce raisonnement est verrouillé par `markdown.util.spec.ts`, qui vérifie la
   * neutralisation de charges XSS. **Ne pas assouplir le rendu sans étendre ces tests.**
   */
  protected renderedHtml = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(this.renderedRaw()),
  );

  /** La même chaîne, non enveloppée : sert à dériver le sommaire du document. */
  private readonly renderedRaw = computed<string>(() => {
    const d = this.doc();
    if (!d) return '';
    const baseDir = d.slug.includes('/') ? d.slug.slice(0, d.slug.lastIndexOf('/')) : '';
    return d.format === 'sql'
      ? renderPlainCode(d.content, 'sql')
      : renderMarkdown(d.content, { baseDir });
  });

  /**
   * Sommaire du document, dérivé des titres réellement rendus.
   *
   * L'analyse passe par `DOMParser` (document INERTE : rien ne s'y charge, rien ne s'y
   * exécute) plutôt que par une expression régulière sur le HTML — le texte d'un titre
   * peut contenir du balisage produit par le rendu (`<code>`, `<strong>`).
   */
  protected readonly toc = computed<TocEntry[]>(() => {
    const html = this.renderedRaw();
    if (!html) return [];
    const parsed = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    return [...parsed.querySelectorAll('h2[id], h3[id]')].map((el) => ({
      id: el.id,
      text: (el.textContent ?? '').trim(),
      level: el.tagName === 'H2' ? 2 : 3,
    }));
  });

  protected onFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected showHome(): void {
    this.selected.set(null);
    this.doc.set(null);
    this.error.set(null);
    this.pane.set('content');
  }

  private async loadIndex(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const idx = await firstValueFrom(this.api.index());
      this.index.set(idx);
      if (!idx.available) {
        this.error.set(
          "Documentation introuvable côté serveur : le dossier n'existe pas. En production, vérifier le montage /opt/tracky-centre-alerte.",
        );
      } else if (idx.documentCount === 0) {
        // Cas PIÉGEUX : un montage vide masque le contenu de l'image. Sans ce message,
        // l'écran s'afficherait normalement, simplement sans rien — et on chercherait
        // le problème du mauvais côté.
        this.error.set(
          'Le dossier de documentation existe mais ne contient aucun document. En production, ' +
            'c’est le symptôme d’un montage /opt/tracky-centre-alerte vide, qui masque le contenu de l’image.',
        );
      }
    } catch {
      this.error.set('Chargement de la documentation impossible.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async openDoc(slug: string, anchor?: string): Promise<void> {
    this.selected.set(slug);
    this.pane.set('content');
    this.loading.set(true);
    this.error.set(null);
    try {
      const d = await firstValueFrom(this.api.document(slug));
      this.doc.set(d);
      // Laisse le rendu se poser avant de chercher l'ancre (ou de remonter en haut).
      queueMicrotask(() => this.scrollTo(anchor));
    } catch {
      this.doc.set(null);
      this.error.set(`Document « ${slug} » introuvable.`);
    } finally {
      this.loading.set(false);
    }
  }

  protected scrollTo(anchor?: string): void {
    const pane = this.contentPane()?.nativeElement;
    if (!pane) return;
    if (!anchor) {
      pane.scrollTop = 0;
      return;
    }
    const target = pane.querySelector(`#${CSS.escape(anchor)}`);
    if (target instanceof HTMLElement) target.scrollIntoView({ block: 'start' });
    else pane.scrollTop = 0;
  }

  /**
   * Délégation de clic : les liens internes produits par le rendu markdown portent
   * `data-wiki-doc` / `data-wiki-anchor`. Les liens externes gardent leur comportement
   * natif (`target="_blank"`) et ne sont pas interceptés.
   */
  protected onBodyClick(event: Event): void {
    const anchorEl = (event.target as HTMLElement | null)?.closest('a');
    if (!anchorEl) return;

    const docSlug = anchorEl.getAttribute('data-wiki-doc');
    const anchorId = anchorEl.getAttribute('data-wiki-anchor');
    if (!docSlug && !anchorId) return;

    event.preventDefault();
    if (docSlug) void this.openDoc(docSlug, anchorId ?? undefined);
    else if (anchorId) this.scrollTo(anchorId);
  }
}
