import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import {
  Activity,
  ArrowLeft,
  CalendarClock,
  ChevronLeft,
  CircleAlert,
  Cpu,
  FileText,
  HardDrive,
  LoaderCircle,
  LucideAngularModule,
  Search,
  Server,
  ShieldAlert,
  Trash2,
  TrendingUp,
  Wrench,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  VpsAuditWikiService,
  type VpsWikiConstat,
  type VpsWikiDocument,
  type VpsWikiIndex,
} from '../../core/services/vps-audit-wiki.service';
import { renderMarkdown, renderPlainCode } from '../../shared/utils/markdown.util';

/** Une entrée du sommaire d'un document, dérivée des titres rendus. */
interface TocEntry {
  id: string;
  text: string;
  level: number;
}

/** Habillage d'un statut. Le libellé, lui, vient du manifeste. */
const STATUT_STYLE: Record<string, string> = {
  A_TRAITER: 'rose',
  CORRECTIF_PROPOSE: 'amber',
  SURVEILLANCE: 'sky',
  APPLIQUE: 'emerald',
  ACCEPTE: 'slate',
};

/**
 * ADMINISTRATION → VPS : ce que la MACHINE subit.
 *
 * ══ Pourquoi un écran distinct du centre d'alerte ═════════════════════════════════════
 *
 * Le centre d'alerte répond à « qu'est-ce que l'application casse ». Celui-ci répond à
 * « qu'est-ce que la machine encaisse » : disque, mémoire, conteneurs, sécurité. Deux
 * questions, deux temporalités — une erreur applicative se voit à la seconde, une
 * saturation de disque se voit en semaines. Les mélanger noierait la seconde.
 *
 * ══ Ce que l'accueil doit répondre ════════════════════════════════════════════════════
 *
 * Une liste de fichiers ne dit pas où on en est. L'accueil est donc un TABLEAU DE BORD :
 *
 *   **QUAND** — depuis quand ce constat existe, quand il a été revu ;
 *   **QUOI**  — la cause, pas la mesure brute ;
 *   **QUOI FAIRE** — l'action, à l'impératif, avec le gain attendu.
 *
 * Ces champs viennent de `app/wiki.json` (tableau `fiches`), tenu par l'agent d'audit. Les
 * documents, eux, sont découverts automatiquement : un rapport déposé s'affiche même s'il
 * n'est déclaré nulle part — un oubli ne doit jamais rendre un rapport invisible.
 */
@Component({
  selector: 'app-admin-vps',
  standalone: true,
  imports: [LucideAngularModule, RouterLink, DatePipe, DecimalPipe],
  template: `
    <div class="page">
      <div class="head">
        <a routerLink="/admin" class="back"><lucide-icon [img]="ArrowLeft" [size]="16" /> Administration</a>
        <h1><lucide-icon [img]="Server" [size]="24" /> VPS — performances &amp; données</h1>
        <p class="sub">
          Audit de la machine : ce qui consomme, ce qui sature, ce qui traîne et ce qui expose.
          Un passage par jour, en <b>lecture seule</b> — l'agent observe et propose, il ne
          touche à rien.
        </p>
      </div>

      @if (loading() && !index()) {
        <div class="s-card empty">Chargement…</div>
      } @else if (error(); as e) {
        <div class="s-card empty err"><lucide-icon [img]="CircleAlert" [size]="16" /> {{ e }}</div>
      } @else if (index(); as idx) {

        @if (!idx.available) {
          <div class="s-card empty err">
            <lucide-icon [img]="CircleAlert" [size]="16" />
            Documentation introuvable côté serveur. En production, vérifier le montage
            <code>/opt/tracky-vps-audit</code>.
          </div>
        } @else {

          <!-- ── Verdict ─────────────────────────────────────────────────────────── -->
          <div class="s-card banner" [class.danger]="nbATraiter() > 0">
            <span class="mode" [class.real]="nbATraiter() > 0" [class.dry]="nbATraiter() === 0">
              <lucide-icon [img]="nbATraiter() > 0 ? ShieldAlert : Wrench" [size]="14" />
              {{ nbATraiter() > 0 ? nbATraiter() + ' à traiter' : 'Rien à traiter' }}
            </span>
            <div class="cfg"><span class="verdict">{{ phraseEtat() }}</span></div>
            @if (dernierPassage(); as p) {
              <span class="when">dernier passage le {{ p.date }}</span>
            }
          </div>

          <!-- ── Chiffres du dernier passage ─────────────────────────────────────── -->
          @if (chiffres().length) {
            <div class="s-card">
              <div class="card-title"><lucide-icon [img]="Cpu" [size]="16" /> Mesures du dernier passage</div>
              <div class="tiles">
                @for (c of chiffres(); track c[0]) {
                  <div class="tile"><span class="num">{{ c[1] }}</span><span class="lbl">{{ c[0] }}</span></div>
                }
              </div>
            </div>
          }

          <!-- ── Prévisions ──────────────────────────────────────────────────────── -->
          @if (idx.previsions; as p) {
            <div class="s-card">
              <div class="card-title">
                <lucide-icon [img]="TrendingUp" [size]="16" /> Prévisions — saturation du disque
                <span class="when">seuil d'alerte {{ p.disque.seuilAlertePct }} %</span>
              </div>

              <div class="jauge" [class.warn]="p.disque.utilisePct >= 75" [class.crit]="p.disque.utilisePct >= p.disque.seuilAlertePct">
                <div class="barre"><span [style.width.%]="p.disque.utilisePct"></span></div>
                <div class="jauge-txt">
                  <b>{{ p.disque.utiliseGo }} Go</b> utilisés sur {{ p.disque.totalGo }} Go
                  · {{ p.disque.libreGo }} Go libres
                  <span class="pct">{{ p.disque.utilisePct }} %</span>
                </div>
              </div>

              <p class="tendance" [class.ok]="tendance().dispo">{{ tendance().message }}</p>

              <div class="card-title sub-title">
                <lucide-icon [img]="Trash2" [size]="15" /> Ce que chaque nettoyage rendrait
              </div>
              <div class="tbl-wrap">
                <table class="tbl">
                  <thead>
                    <tr><th>Poste</th><th class="n">Gain</th><th>Commande</th><th>Risque</th><th>Contrepartie</th></tr>
                  </thead>
                  <tbody>
                    @for (r of p.recuperable; track r.poste) {
                      <tr [class.inerte]="r.commande === '— AUCUNE —'">
                        <td class="fname">
                          {{ r.poste }}
                          @if (r.constat) { <span class="ref">{{ r.constat }}</span> }
                        </td>
                        <td class="n"><b>{{ r.go }} Go</b></td>
                        <td><code>{{ r.commande }}</code></td>
                        <td [class.red]="r.risque.startsWith('ELEVE')">{{ r.risque }}</td>
                        <td class="small">{{ r.contrepartie }}</td>
                      </tr>
                    }
                  </tbody>
                  <tfoot>
                    <tr>
                      <td><b>Total récupérable sans risque</b></td>
                      <td class="n"><b class="gain-total">{{ totalRecuperable() }} Go</b></td>
                      <td colspan="3" class="small">
                        soit un disque à <b>{{ pctApresNettoyage() }} %</b> au lieu de {{ p.disque.utilisePct }} %
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div class="fond">
                <lucide-icon [img]="Activity" [size]="14" />
                <span>
                  <b>Charge de fond permanente</b> — {{ p.chargeDeFond.healthchecksParMinute }} sondes/min
                  sur {{ p.chargeDeFond.conteneursSondes }} conteneurs
                  ({{ p.chargeDeFond.healthchecksParJour | number }}/jour), et
                  {{ p.chargeDeFond.processusParMinute | number }} processus créés par minute au total.
                  C'est le coût que personne ne planifie.
                </span>
              </div>
            </div>
          }

          <!-- ── Ordonnancement ──────────────────────────────────────────────────── -->
          @if (idx.ordonnancement.length) {
            <div class="s-card">
              <div class="card-title">
                <lucide-icon [img]="CalendarClock" [size]="16" /> Ordonnancement — ce qui se déclenche tout seul
                <span class="when">{{ idx.ordonnancement.length }} opérations</span>
              </div>
              <p class="intro-txt">
                Les trois couches sur la même ligne de temps : <b class="c-vps">VPS</b> (cron et timers
                de la machine), <b class="c-poste">Poste</b> (agents planifiés) et le permanent.
                Une collision ne se voit qu'ici — c'est ainsi qu'on a trouvé les deux sauvegardes de 5 h.
              </p>

              <div class="ordo">
                @for (o of ordonnancementTrie(); track o.id) {
                  <article class="op" [class]="'op c-' + o.couche.toLowerCase()">
                    <div class="heure">
                      <span class="hl">{{ o.heureLocale }}</span>
                      @if (o.heureUtc !== '—') { <span class="hu">{{ o.heureUtc }} UTC</span> }
                    </div>
                    <div class="corps">
                      <div class="ligne1">
                        <span class="couche">{{ o.couche }}</span>
                        <span class="quoi">{{ o.quoi }}</span>
                        @if (o.constat) { <span class="ref">{{ o.constat }}</span> }
                      </div>
                      <div class="ligne2">
                        <span>{{ o.cadence }}</span> · <span>durée {{ o.duree }}</span> · <span>{{ o.cout }}</span>
                      </div>
                      @if (o.note) { <p class="note">{{ o.note }}</p> }
                    </div>
                  </article>
                }
              </div>
            </div>
          }

          <!-- ── Constats ────────────────────────────────────────────────────────── -->
          @if (constatsTries().length) {
            <div class="s-card">
              <div class="card-title">
                <lucide-icon [img]="HardDrive" [size]="16" /> Constats
                <span class="when">{{ constatsTries().length }} au référentiel</span>
              </div>

              <div class="filtres">
                <button class="chip" [class.on]="statutFiltre() === null" (click)="statutFiltre.set(null)">
                  Tous ({{ constatsTries().length }})
                </button>
                @for (s of statutsAvecCompte(); track s.cle) {
                  <button class="chip" [class]="'chip ' + style(s.cle)" [class.on]="statutFiltre() === s.cle"
                          (click)="statutFiltre.set(statutFiltre() === s.cle ? null : s.cle)">
                    {{ s.libelle }} ({{ s.compte }})
                  </button>
                }
              </div>

              <div class="constats">
                @for (c of constatsVisibles(); track c.id) {
                  <article class="constat" [class]="'constat ' + style(c.statut)">
                    <header>
                      <span class="id">{{ c.id }}</span>
                      <span class="titre">{{ c.titre }}</span>
                      <span class="badge">{{ libelleStatut(c.statut) }}</span>
                    </header>
                    <dl>
                      <div><dt>Quand</dt><dd>{{ quandLabel(c) }}</dd></div>
                      <div><dt>Quoi</dt><dd>{{ c.quoi }}</dd></div>
                      <div><dt>Quoi faire</dt><dd class="action">{{ c.quoiFaire }}</dd></div>
                      @if (c.gain) { <div><dt>Gain</dt><dd class="gain">{{ c.gain }}</dd></div> }
                      @if (c.aNePasFaire) { <div><dt>À ne pas faire</dt><dd class="danger-txt">{{ c.aNePasFaire }}</dd></div> }
                    </dl>
                  </article>
                }
              </div>
            </div>
          }

          <!-- ── Documents ───────────────────────────────────────────────────────── -->
          <div class="s-card docs">
            <div class="card-title">
              <lucide-icon [img]="FileText" [size]="16" /> Rapports &amp; documentation
              <span class="when">{{ idx.documentCount }} document{{ idx.documentCount > 1 ? 's' : '' }}</span>
            </div>

            <div class="split">
              <aside [class.hidden-sm]="!!doc()">
                <div class="search">
                  <lucide-icon [img]="Search" [size]="13" />
                  <input type="search" [value]="filter()" (input)="onFilter($event)"
                         placeholder="Filtrer les documents…" aria-label="Filtrer les documents" />
                </div>
                @for (s of visibleSections(); track s.key) {
                  <div class="sec">
                    <h4>{{ s.label }}</h4>
                    @for (d of s.documents; track d.slug) {
                      <button class="docbtn" [class.on]="selected() === d.slug" (click)="openDoc(d.slug)">
                        <span class="dt">{{ d.title }}</span>
                        @if (d.description) { <span class="dd">{{ d.description }}</span> }
                      </button>
                    }
                  </div>
                }
              </aside>

              <section class="reader" [class.hidden-sm]="!doc()">
                @if (loadingDoc()) {
                  <div class="empty"><lucide-icon [img]="LoaderCircle" [size]="16" class="spin" /> Chargement…</div>
                } @else if (doc(); as d) {
                  <button class="back-sm" (click)="doc.set(null); selected.set(null)">
                    <lucide-icon [img]="ChevronLeft" [size]="15" /> Documents
                  </button>
                  <div class="doc-head">
                    <h3>{{ d.title }}</h3>
                    <span class="when">mis à jour le {{ d.updatedAt | date: 'dd/MM/yyyy à HH:mm' }}</span>
                  </div>
                  @if (toc().length > 2) {
                    <nav class="toc">
                      @for (t of toc(); track t.id) {
                        <a [href]="'#' + t.id" [class.l3]="t.level === 3">{{ t.text }}</a>
                      }
                    </nav>
                  }
                  <div class="md" [innerHTML]="renderedHtml()"></div>
                } @else {
                  <div class="empty">Choisir un document à gauche.</div>
                }
              </section>
            </div>
          </div>
        }
      }
    </div>
  `,
  styles: [
    `
      .empty { display: flex; align-items: center; gap: 8px; justify-content: center; padding: 28px; color: var(--fg-tertiary); font-size: 13px; }
      .empty.err { color: #f87171; }

      .banner { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
      .banner .mode { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; padding: 5px 11px; border-radius: 999px; white-space: nowrap; }
      .mode.dry { background: rgba(16, 224, 160, .12); color: var(--tracky-light); }
      .mode.real { background: rgba(248, 113, 113, .13); color: #f87171; }
      .banner .cfg { flex: 1; min-width: 220px; }
      .banner .verdict { font-size: 13px; color: var(--fg-secondary); line-height: 1.5; }
      .banner .when { font-size: 12px; color: var(--fg-tertiary); white-space: nowrap; }

      .card-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; color: var(--fg-primary); margin-bottom: 14px; }
      .card-title .when { margin-left: auto; font-size: 12px; font-weight: 400; color: var(--fg-tertiary); }

      .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
      .tile { display: flex; flex-direction: column; gap: 4px; background: var(--bg-tertiary); border-radius: 12px; padding: 14px; }
      .tile .num { font-family: var(--font-display); font-size: 23px; font-weight: 700; color: var(--fg-primary); }
      .tile .lbl { font-size: 12px; color: var(--fg-tertiary); }

      /* ── Prévisions ── */
      .sub-title { margin-top: 20px; font-size: 13.5px; }
      .jauge { margin-bottom: 10px; }
      .barre { height: 10px; border-radius: 999px; background: var(--bg-tertiary); overflow: hidden; }
      .barre span { display: block; height: 100%; border-radius: 999px; background: var(--tracky-light); transition: width .3s; }
      .jauge.warn .barre span { background: #fbbf24; }
      .jauge.crit .barre span { background: #f87171; }
      .jauge-txt { display: flex; align-items: baseline; gap: 8px; margin-top: 7px; font-size: 13px; color: var(--fg-secondary); }
      .jauge-txt b { color: var(--fg-primary); }
      .jauge-txt .pct { margin-left: auto; font-family: var(--font-display); font-size: 19px; font-weight: 700; color: var(--fg-primary); }
      .tendance { font-size: 12.5px; color: var(--fg-tertiary); line-height: 1.5; margin: 0 0 4px; font-style: italic; }
      .tendance.ok { color: var(--fg-secondary); font-style: normal; }
      .intro-txt { font-size: 12.5px; color: var(--fg-tertiary); line-height: 1.55; margin: -6px 0 14px; }
      .ref { display: inline-block; font-family: var(--font-mono, monospace); font-size: 10.5px; padding: 1px 6px; margin-left: 6px; border-radius: 5px; background: var(--bg-secondary); color: var(--fg-tertiary); border: 1px solid var(--border-subtle); }
      .tbl-wrap { overflow-x: auto; }
      .tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      .tbl th { text-align: left; color: var(--fg-tertiary); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; padding: 6px 9px; border-bottom: 1px solid var(--border-subtle); }
      .tbl th.n, .tbl td.n { text-align: right; white-space: nowrap; }
      .tbl td { padding: 8px 9px; border-bottom: 1px solid var(--border-subtle); color: var(--fg-secondary); vertical-align: top; }
      .tbl tfoot td { border-bottom: none; border-top: 1px solid var(--border-subtle); padding-top: 10px; }
      .tbl tr.inerte { opacity: .55; }
      .tbl code { font-size: 11.5px; background: var(--bg-tertiary); padding: 2px 6px; border-radius: 5px; white-space: nowrap; }
      .fname { color: var(--fg-primary); font-weight: 500; }
      .gain-total { color: var(--tracky-light); font-size: 14px; }
      .red { color: #f87171; font-weight: 600; }
      .small { font-size: 11.5px; }
      .fond { display: flex; align-items: flex-start; gap: 8px; margin-top: 16px; padding: 11px 13px; border-radius: 11px; background: var(--bg-tertiary); font-size: 12.5px; color: var(--fg-secondary); line-height: 1.55; }
      .fond lucide-icon { color: #fbbf24; flex-shrink: 0; margin-top: 2px; }

      /* ── Ordonnancement ── */
      .ordo { display: flex; flex-direction: column; gap: 8px; }
      .op { display: grid; grid-template-columns: 92px 1fr; gap: 12px; padding: 10px 13px; border-radius: 11px; background: var(--bg-tertiary); border-left: 3px solid var(--border-subtle); }
      .op.c-vps { border-left-color: #0ea5e9; }
      .op.c-poste { border-left-color: #a78bfa; }
      .op .heure { display: flex; flex-direction: column; gap: 1px; }
      .op .hl { font-family: var(--font-display); font-size: 14px; font-weight: 700; color: var(--fg-primary); }
      .op .hu { font-size: 10.5px; color: var(--fg-tertiary); }
      .op .ligne1 { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
      .op .couche { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; padding: 1.5px 7px; border-radius: 999px; background: var(--bg-secondary); color: var(--fg-tertiary); border: 1px solid var(--border-subtle); }
      .op.c-vps .couche { color: #38bdf8; border-color: rgba(14,165,233,.35); }
      .op.c-poste .couche { color: #a78bfa; border-color: rgba(139,92,246,.35); }
      .op .quoi { font-size: 13px; color: var(--fg-primary); font-weight: 500; }
      .op .ligne2 { margin-top: 3px; font-size: 11.5px; color: var(--fg-tertiary); }
      .op .note { margin: 5px 0 0; font-size: 12px; color: var(--fg-secondary); line-height: 1.5; }
      .c-vps { color: #38bdf8; }
      .c-poste { color: #a78bfa; }

      .filtres { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 14px; }
      .chip { font-size: 12px; padding: 4px 11px; border-radius: 999px; cursor: pointer; background: var(--bg-tertiary); color: var(--fg-tertiary); border: 1px solid var(--border-subtle); }
      .chip:hover { color: var(--fg-primary); }
      .chip.on { background: var(--fg-primary); color: var(--bg-primary); border-color: var(--fg-primary); }

      .constats { display: flex; flex-direction: column; gap: 10px; }
      .constat { border: 1px solid var(--border-subtle); border-left-width: 3px; border-radius: 12px; padding: 13px 15px; background: var(--bg-tertiary); }
      .constat.rose { border-left-color: #f43f5e; background: rgba(244, 63, 94, .04); }
      .constat.amber { border-left-color: #f59e0b; background: rgba(245, 158, 11, .03); }
      .constat.sky { border-left-color: #0ea5e9; }
      .constat.emerald { border-left-color: #10b981; }
      .constat.slate { border-left-color: #64748b; }
      .constat header { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; margin-bottom: 9px; }
      .constat .id { font-family: var(--font-mono, monospace); font-size: 11.5px; color: var(--fg-tertiary); }
      .constat .titre { font-size: 14px; font-weight: 600; color: var(--fg-primary); flex: 1; min-width: 180px; }
      .constat .badge { font-size: 11px; padding: 2.5px 9px; border-radius: 999px; background: var(--bg-secondary); color: var(--fg-tertiary); border: 1px solid var(--border-subtle); }
      .constat dl { display: flex; flex-direction: column; gap: 6px; margin: 0; }
      .constat dl > div { display: grid; grid-template-columns: 96px 1fr; gap: 10px; }
      .constat dt { font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em; color: var(--fg-tertiary); }
      .constat dd { margin: 0; font-size: 13px; color: var(--fg-secondary); line-height: 1.5; }
      .constat dd.action { color: var(--fg-primary); }
      .constat dd.gain { color: var(--tracky-light); font-weight: 500; }
      .constat dd.danger-txt { color: #fbbf24; }

      .split { display: grid; grid-template-columns: 258px 1fr; gap: 16px; min-height: 320px; }
      .split aside { border-right: 1px solid var(--border-subtle); padding-right: 14px; max-height: 620px; overflow-y: auto; }
      .search { position: relative; margin-bottom: 12px; }
      .search lucide-icon { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--fg-tertiary); }
      .search input { width: 100%; padding: 7px 10px 7px 27px; font-size: 12.5px; border-radius: 9px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-primary); }
      .sec { margin-bottom: 14px; }
      .sec h4 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); margin: 0 0 6px; font-weight: 600; }
      .docbtn { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; padding: 7px 9px; border-radius: 9px; cursor: pointer; background: transparent; border: none; }
      .docbtn:hover { background: var(--bg-tertiary); }
      .docbtn.on { background: var(--bg-tertiary); }
      .docbtn.on .dt { color: var(--tracky-light); }
      .docbtn .dt { font-size: 13px; color: var(--fg-secondary); }
      .docbtn .dd { font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.4; }

      .reader { max-height: 620px; overflow-y: auto; padding-right: 4px; }
      .back-sm { display: none; align-items: center; gap: 4px; font-size: 12.5px; color: var(--fg-tertiary); background: none; border: none; cursor: pointer; margin-bottom: 8px; }
      .doc-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
      .doc-head h3 { font-size: 16px; font-weight: 600; color: var(--fg-primary); margin: 0; }
      .doc-head .when { font-size: 11.5px; color: var(--fg-tertiary); }
      .toc { display: flex; flex-direction: column; gap: 3px; padding: 10px 13px; margin-bottom: 14px; background: var(--bg-tertiary); border-radius: 10px; }
      .toc a { font-size: 12.5px; color: var(--fg-tertiary); text-decoration: none; }
      .toc a:hover { color: var(--tracky-light); }
      .toc a.l3 { padding-left: 13px; font-size: 12px; }
      .spin { animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }

      @media (max-width: 820px) {
        .split { grid-template-columns: 1fr; }
        .split aside { border-right: none; padding-right: 0; }
        .hidden-sm { display: none; }
        .back-sm { display: inline-flex; }
        .constat dl > div { grid-template-columns: 1fr; gap: 1px; }
      }
    `,
  ],
})
export class AdminVpsComponent implements OnInit {
  private readonly wiki = inject(VpsAuditWikiService);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly Activity = Activity;
  protected readonly ArrowLeft = ArrowLeft;
  protected readonly CalendarClock = CalendarClock;
  protected readonly ChevronLeft = ChevronLeft;
  protected readonly Trash2 = Trash2;
  protected readonly TrendingUp = TrendingUp;
  protected readonly CircleAlert = CircleAlert;
  protected readonly Cpu = Cpu;
  protected readonly FileText = FileText;
  protected readonly HardDrive = HardDrive;
  protected readonly LoaderCircle = LoaderCircle;
  protected readonly Search = Search;
  protected readonly Server = Server;
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly Wrench = Wrench;

  protected readonly index = signal<VpsWikiIndex | null>(null);
  protected readonly doc = signal<VpsWikiDocument | null>(null);
  protected readonly selected = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadingDoc = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly filter = signal('');
  protected readonly statutFiltre = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      this.index.set(await firstValueFrom(this.wiki.index()));
      this.error.set(null);
    } catch {
      this.error.set("Impossible de charger la documentation de l'audit VPS.");
    } finally {
      this.loading.set(false);
    }
  }

  // ── Tableau de bord ────────────────────────────────────────────────────────────────

  protected style(cle: string): string {
    return STATUT_STYLE[cle] ?? 'slate';
  }

  protected libelleStatut(cle: string): string {
    return this.index()?.statuts.find((s) => s.cle === cle)?.libelle ?? cle;
  }

  protected readonly constatsTries = computed(() =>
    [...(this.index()?.fiches ?? [])].sort((a, b) => (a.gravite ?? 99) - (b.gravite ?? 99)),
  );

  protected readonly constatsVisibles = computed(() => {
    const f = this.statutFiltre();
    return f ? this.constatsTries().filter((x) => x.statut === f) : this.constatsTries();
  });

  protected readonly nbATraiter = computed(
    () => this.constatsTries().filter((c) => c.statut === 'A_TRAITER').length,
  );

  /** Statuts du manifeste, dans leur ordre, avec le nombre de constats de chacun. */
  protected readonly statutsAvecCompte = computed(() => {
    const constats = this.constatsTries();
    return [...(this.index()?.statuts ?? [])]
      .sort((a, b) => (a.ordre ?? 99) - (b.ordre ?? 99))
      .map((s) => ({ ...s, compte: constats.filter((c) => c.statut === s.cle).length }))
      .filter((s) => s.compte > 0);
  });

  protected readonly dernierPassage = computed(() => this.index()?.passages?.[0] ?? null);

  // ── Prévisions ─────────────────────────────────────────────────────────────────────

  /** Total récupérable **sans risque** : la ligne « aucune commande » est exclue à dessein. */
  protected readonly totalRecuperable = computed(() => {
    const r = this.index()?.previsions?.recuperable ?? [];
    return Math.round(r.filter((x) => x.commande !== '— AUCUNE —').reduce((s, x) => s + x.go, 0) * 10) / 10;
  });

  protected readonly pctApresNettoyage = computed(() => {
    const d = this.index()?.previsions?.disque;
    if (!d) return 0;
    return Math.round(((d.utiliseGo - this.totalRecuperable()) / d.totalGo) * 100);
  });

  /**
   * Tendance de remplissage du disque, dérivée de l'historique des passages.
   *
   * ⚠️ Il faut **au moins deux passages** pour qu'une pente existe. Tant qu'il n'y en a qu'un,
   * on le dit franchement plutôt que d'afficher « 0 %/jour » — un zéro inventé se lit comme
   * « rien ne bouge », ce qui est exactement le contraire de « on ne sait pas encore ».
   */
  protected readonly tendance = computed<{ dispo: boolean; message: string }>(() => {
    const passages = this.index()?.passages ?? [];
    const seuil = this.index()?.previsions?.disque.seuilAlertePct ?? 90;

    const points = passages
      .map((p) => ({ date: p.date, pct: p.chiffres?.['disqueUtilisePct'] }))
      .filter((p): p is { date: string; pct: number } => typeof p.pct === 'number')
      .sort((a, b) => a.date.localeCompare(b.date));

    if (points.length < 2) {
      return {
        dispo: false,
        message:
          'Tendance indisponible : elle demande au moins deux passages. Elle apparaîtra au prochain audit.',
      };
    }

    const premier = points[0];
    const dernier = points[points.length - 1];
    const jours = (Date.parse(dernier.date) - Date.parse(premier.date)) / 86_400_000;
    if (jours <= 0) return { dispo: false, message: 'Tendance indisponible : passages non datés distinctement.' };

    const pente = (dernier.pct - premier.pct) / jours;
    if (pente <= 0.01) {
      return {
        dispo: true,
        message: `Le disque ne se remplit pas (${pente.toFixed(2)} %/jour sur ${points.length} passages). Aucune saturation en vue.`,
      };
    }

    const joursRestants = Math.round((seuil - dernier.pct) / pente);
    return {
      dispo: true,
      message:
        `Le disque gagne ${pente.toFixed(2)} %/jour sur ${points.length} passages. ` +
        `À ce rythme, le seuil de ${seuil} % serait atteint dans ${joursRestants} jour${joursRestants > 1 ? 's' : ''}` +
        ` — et les ${this.totalRecuperable()} Go récupérables repoussent l'échéance d'autant.`,
    };
  });

  /** L'ordre de la nuit : les opérations à heure fixe d'abord, le permanent à la fin. */
  protected readonly ordonnancementTrie = computed(() => {
    const ops = this.index()?.ordonnancement ?? [];
    const rang = (h: string) => (/^\d{2}:\d{2}$/.test(h) ? 0 : 1);
    return [...ops].sort(
      (a, b) => rang(a.heureLocale) - rang(b.heureLocale) || a.heureLocale.localeCompare(b.heureLocale),
    );
  });

  protected readonly chiffres = computed<[string, number | string][]>(() => {
    const c = this.dernierPassage()?.chiffres;
    if (!c) return [];
    const labels: Record<string, string> = {
      disqueUtilisePct: 'disque utilisé (%)',
      disqueRecuperableGo: 'récupérable (Go)',
      ramUtiliseePct: 'RAM utilisée (%)',
      swapUtiliseMo: 'swap (Mo)',
      chargeMoyenne1m: 'charge (1 min)',
      conteneursActifs: 'conteneurs actifs',
      conteneursMorts: 'conteneurs morts',
      paquetsEnRetard: 'paquets en retard',
      echecsSshJour: 'échecs SSH',
    };
    return Object.entries(c).map(([k, v]) => [labels[k] ?? k, v]);
  });

  /** La phrase d'état — celle qu'on lit même quand on ne lit rien d'autre. */
  protected readonly phraseEtat = computed(() => {
    const p = this.dernierPassage();
    if (p?.verdict) return p.verdict;
    const constats = this.constatsTries();
    if (!constats.length) return 'Aucun constat au référentiel.';
    const n = this.nbATraiter();
    return n === 0
      ? 'Aucun constat ouvert.'
      : `${n} constat${n > 1 ? 's' : ''} à traiter. À commencer par ${constats[0].id}.`;
  });

  /** « Quand » d'un constat : période observée, en une ligne lisible. */
  protected quandLabel(c: VpsWikiConstat): string {
    const bouts: string[] = [];
    if (c.vuPremiere && c.vuDerniere) {
      bouts.push(
        c.vuPremiere === c.vuDerniere ? `vu le ${c.vuPremiere}` : `du ${c.vuPremiere} au ${c.vuDerniere}`,
      );
    } else if (c.vuDerniere) {
      bouts.push(`vu le ${c.vuDerniere}`);
    }
    if (c.mesure) bouts.push(c.mesure);
    return bouts.join(' · ') || '—';
  }

  // ── Documents ──────────────────────────────────────────────────────────────────────

  protected onFilter(e: Event): void {
    this.filter.set((e.target as HTMLInputElement).value);
  }

  protected readonly visibleSections = computed(() => {
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

  protected async openDoc(slug: string): Promise<void> {
    this.selected.set(slug);
    this.loadingDoc.set(true);
    try {
      this.doc.set(await firstValueFrom(this.wiki.document(slug)));
    } catch {
      this.error.set('Document illisible.');
    } finally {
      this.loadingDoc.set(false);
    }
  }

  /**
   * ⚠️ SEUL POINT DE CONFIANCE EXPLICITE DE CE COMPOSANT.
   *
   * `bypassSecurityTrustHtml` est légitime ici parce que la chaîne rendue est produite
   * intégralement par `markdown.util.ts`, qui **échappe chaque fragment de texte AVANT**
   * toute transformation et filtre les URL par schéma. Aucun balisage du document source
   * ne survit : un `<script>` dans un fichier .md ressort en `&lt;script&gt;`.
   *
   * On contourne le sanitizer plutôt que de le subir parce qu'il retire les attributs
   * `data-*` et casserait la navigation interne entre documents.
   *
   * 🔒 Verrouillé par `markdown.util.spec.ts`, qui vérifie la neutralisation de charges
   * XSS. **Ne pas assouplir le rendu sans étendre ces tests.**
   */
  protected readonly renderedHtml = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(this.renderedRaw()),
  );

  /** La même chaîne, non enveloppée : sert à dériver le sommaire du document. */
  private readonly renderedRaw = computed<string>(() => {
    const d = this.doc();
    if (!d) return '';
    const baseDir = d.slug.includes('/') ? d.slug.slice(0, d.slug.lastIndexOf('/')) : '';
    return d.format === 'markdown'
      ? renderMarkdown(d.content, { baseDir })
      : renderPlainCode(d.content, d.format);
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
}
