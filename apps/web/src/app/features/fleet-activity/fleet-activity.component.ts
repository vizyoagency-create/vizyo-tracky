import { swallow } from '../../core/error/swallow';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { httpFailureMessage } from '../../core/services/http-failure';
import { ZoneComponent } from '../../shared/ui/zone/zone.component';
import type { EtatZone } from '../../shared/ui/zone/zone.component';
import {
  ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal,
} from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  Activity, AlertTriangle, CircleDot, LucideAngularModule, Power, PowerOff, RefreshCw, Users, Zap,
} from 'lucide-angular';
import type { ActivityFeedItemDto, EngineCommandAuditDto, OnlineUserDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { FleetActivityApiService } from './fleet-activity-api.service';

type Tab = 'engine' | 'live' | 'history';

/** Ton d'un resultat — chacun pointe vers un jeton de la famille --texte-*. */
type Ton = 'succes' | 'attente' | 'alerte' | 'inactif';

/** Le resultat d'une commande, tel qu'il se lit : un mot, puis ce qui s'est passe. */
interface Resultat {
  mot: string;
  detail: string | null;
  ton: Ton;
  probleme: boolean;
}

interface Groupe {
  cle: string;
  titre: string;
  alerte: boolean;
  items: EngineCommandAuditDto[];
}

/** Fenetre des compteurs de tete. La maquette parle de « ces 7 derniers jours ». */
const FENETRE_JOURS = 7;
const FENETRE_MS = FENETRE_JOURS * 24 * 60 * 60 * 1000;

/**
 * Espace « Activite de la flotte » — FLEET_ADMIN (demande 2026-07).
 *
 * Permet a un responsable de flotte de CONTROLER qui agit sur ses vehicules, notamment QUI a
 * COUPE / RALLUME un moteur et QUAND. AUCUN rapport/analytics.
 *
 * SECURITE : le back borne a la flotte de l'appelant ET exclut les roles ELEVES
 * (super-admin / owner) — un fleet-admin ne voit JAMAIS l'activite des roles au-dessus de lui.
 *
 * ── Lot B-pages (2026-08-11) — « le resultat avant l'evenement » ────────────────────────
 *
 * L'ecran affichait un MOT de statut (« Echec », « Refusee (en mouvement) ») et s'arretait la.
 * Or c'est la RAISON qui fait agir : « refusee » ne dit pas s'il faut s'inquieter, alors que
 * « refusee · vehicule en mouvement, 74 km/h » dit que le garde-fou a fonctionne, et que rien
 * n'est a reparer. La raison existait deja en base (`lastError`, ecrit par `rejectSpeed`) et
 * n'etait affichee NULLE PART. Aucun DTO n'a bouge : la colonne « Resultat » lit des champs
 * qui etaient deja servis.
 *
 * Trois autres decisions de la planche :
 *  · LES ECHECS EN TETE — un groupe « A verifier » ouvre la liste, avant le classement par
 *    jour. Un echec vieux de trois jours se lit avant une confirmation d'il y a une heure.
 *  · LA PRESENCE DEVIENT PERMANENTE sur grand ecran — elle etait un onglet, donc invisible
 *    tant qu'on ne cliquait pas. Sous 1024 px elle reste un onglet : la planche mobile ne lui
 *    donne pas de colonne, et il n'y en a pas.
 *  · LES COMPTEURS NE MENTENT PAS SUR LEUR PERIMETRE — cf. `fenetreComplete()` plus bas.
 */
@Component({
  selector: 'app-fleet-activity',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, LucideAngularModule, NgTemplateOutlet, ZoneComponent],
  template: `
    <div class="fa">
      <header class="fa-head">
        <div class="fa-title">
          <lucide-icon [img]="ActivityIcon" [size]="20" />
          <div>
            <h1>Activité de la flotte</h1>
            <p class="fa-sub">Qui agit sur vos véhicules — coupures/rallumages moteur, présence et historique.</p>
          </div>
        </div>
        <button class="fa-refresh" (click)="reloadActive()" [disabled]="loading()" aria-label="Rafraîchir">
          <lucide-icon [img]="RefreshIcon" [size]="16" [class.spin]="loading()" />
        </button>
      </header>

      @if (problemes().length) {
        <div class="fa-alerte" role="status">
          <span class="fa-alerte-ico"><lucide-icon [img]="WarnIcon" [size]="16" /></span>
          <div class="fa-alerte-corps">
            <div class="fa-alerte-titre">{{ titreProblemes() }}</div>
            <p class="fa-alerte-txt">{{ expliqueProblemes() }}</p>
            <div class="fa-alerte-chips">
              @for (c of problemes(); track c.id) {
                <span class="fa-chip" [attr.data-ton]="resultat(c).ton">
                  <span class="fa-plq">{{ c.vehiclePlate ?? 'Sans plaque' }}</span>
                  · {{ motCourt(c) }}
                </span>
              }
            </div>
          </div>
        </div>
      }

      <div class="fa-tuiles">
        <div class="fa-tuile"><b>{{ vus().length }}</b><span>{{ libelleFenetre() }}</span></div>
        <div class="fa-tuile"><b class="t-info">{{ nbCoupures() }}</b><span>Coupures</span></div>
        <div class="fa-tuile"><b class="t-succes">{{ nbRallumages() }}</b><span>Rallumages</span></div>
        <div class="fa-tuile" [class.bord-attente]="nbRefusees() > 0">
          <b class="t-attente">{{ nbRefusees() }}</b><span>Refusée en marche</span>
        </div>
        <div class="fa-tuile" [class.bord-alerte]="nbEchecs() > 0">
          <b class="t-alerte">{{ nbEchecs() }}</b><span>Échec</span>
        </div>
      </div>

      <nav class="fa-tabs" aria-label="Vues de l'activité">
        <button class="tab-btn" [class.on]="tab() === 'engine'" (click)="setTab('engine')">
          <lucide-icon [img]="ZapIcon" [size]="15" /> Moteurs
        </button>
        @if (!large()) {
          <button class="tab-btn" [class.on]="tab() === 'live'" (click)="setTab('live')">
            <lucide-icon [img]="UsersIcon" [size]="15" /> En ligne
            @if (online().length) { <span class="fa-badge">{{ online().length }}</span> }
          </button>
        }
        <button class="tab-btn" [class.on]="tab() === 'history'" (click)="setTab('history')">
          <lucide-icon [img]="DotIcon" [size]="15" /> Historique
        </button>
      </nav>

      <div class="fa-grille" [class.avec-aside]="large()">
        <div class="fa-colonne">

          @if (tab() === 'engine') {
            <div class="fa-filters">
              <label class="sr-only" for="fa-action">Filtrer par action</label>
              <select id="fa-action" [ngModel]="engineAction()" (ngModelChange)="setEngineAction($event)">
                <option value="">Toutes actions</option>
                <option value="CUT">Coupures</option>
                <option value="RESTORE">Rallumages</option>
              </select>
              <label class="sr-only" for="fa-statut">Filtrer par résultat</label>
              <select id="fa-statut" [ngModel]="engineStatus()" (ngModelChange)="setEngineStatus($event)">
                <option value="">Tous résultats</option>
                <option value="ACKNOWLEDGED">Confirmée</option>
                <option value="SENT">Envoyée</option>
                <option value="PENDING">En attente</option>
                <option value="FAILED">Échec</option>
                <option value="REJECTED_SPEED">Refusée (en mouvement)</option>
              </select>
            </div>

            <app-zone
              [etat]="etatMoteurs()"
              quoi="Les actions moteur"
              vide="Aucune action moteur sur cette flotte"
              videDetail="Les coupures et rallumages apparaîtront ici dès qu'un moteur sera commandé."
              erreur="Impossible de charger les actions moteur"
              (reessayer)="reloadActive()">
              <div class="fa-liste">
                @for (g of groupes(); track g.cle) {
                  <div class="fa-groupe" [class.alerte]="g.alerte">
                    <span class="fa-losange" aria-hidden="true">&#9670;</span>{{ g.titre }}
                  </div>
                  @for (c of g.items; track c.id) {
                    <article class="fa-ligne" [attr.data-ton]="resultat(c).probleme ? resultat(c).ton : null">
                      <div class="fa-l-tete">
                        <span class="fa-plq">{{ c.vehiclePlate ?? 'Sans plaque' }}</span>
                        <span class="fa-act" [attr.data-a]="c.action">
                          <lucide-icon [img]="c.action === 'CUT' ? PowerOffIcon : PowerIcon" [size]="12" />
                          {{ c.action === 'CUT' ? 'Coupure' : 'Rallumage' }}
                        </span>
                        <time class="fa-when">{{ c.createdAt | date:'dd/MM HH:mm' }}</time>
                      </div>
                      <div class="fa-l-res">
                        <span class="fa-mot" [attr.data-ton]="resultat(c).ton">{{ resultat(c).mot }}</span>
                        @if (resultat(c).detail) {
                          <span class="fa-detail">{{ resultat(c).detail }}</span>
                        }
                      </div>
                      <div class="fa-l-pied">
                        <span>{{ c.requestedByName }}</span>
                        @if (c.requestedByRole) { <span class="fa-role">{{ roleLabel(c.requestedByRole) }}</span> }
                        <span class="fa-sep" aria-hidden="true">·</span>
                        <span>{{ sourceLabel(c.source) }}</span>
                      </div>
                    </article>
                  }
                }
              </div>

              <p class="fa-note-pied">
                « Détecté (boîtier) » signifie que quelqu'un a agi <strong>sur le véhicule</strong>, pas depuis Tracky.
              </p>
              @if (engine().length >= pageSize) {
                <button class="fa-more" (click)="loadMoreEngine()" [disabled]="loading()">Charger plus</button>
              }
            </app-zone>
          }

          @if (tab() === 'live' && !large()) {
            <ng-container [ngTemplateOutlet]="presence" />
          }

          @if (tab() === 'history') {
            <div class="fa-note">Flux des actions des utilisateurs de votre flotte (les plus récentes d'abord).</div>
            <app-zone
              [etat]="etatFeed()"
              quoi="L'historique"
              vide="Aucune activité récente"
              videDetail="Les pages ouvertes et les actions de vos utilisateurs apparaîtront ici."
              erreur="Impossible de charger l'historique"
              (reessayer)="reloadActive()">
              <ul class="fa-feed">
                @for (f of feed(); track f.id) {
                  <li>
                    <span class="fa-feed-when">{{ f.at | date:'dd/MM HH:mm' }}</span>
                    <span class="fa-feed-user">{{ f.userName }}</span>
                    <span class="fa-feed-type">{{ typeLabel(f.type) }}</span>
                    <span class="fa-feed-target">{{ f.routeLabel ?? f.route ?? f.target ?? '' }}</span>
                  </li>
                }
              </ul>
              @if (feed().length >= pageSize) {
                <button class="fa-more" (click)="loadMoreFeed()" [disabled]="loading()">Charger plus</button>
              }
            </app-zone>
          }
        </div>

        @if (large()) {
          <aside class="fa-aside">
            <ng-container [ngTemplateOutlet]="presence" />
          </aside>
        }
      </div>
    </div>

    <ng-template #presence>
      <section class="fa-presence">
        <header class="fa-p-tete">
          <span class="fa-p-ico"><lucide-icon [img]="UsersIcon" [size]="16" /></span>
          <div class="fa-p-titres">
            <h2>En ligne maintenant</h2>
            <p>Rafraîchi toutes les {{ periodeSondageSec }} s</p>
          </div>
          <span class="fa-p-nb">{{ online().length }}</span>
        </header>
        <app-zone
          [etat]="etatPresence()"
          quoi="La présence"
          vide="Personne en ligne"
          videDetail="Aucun utilisateur de votre flotte n'est connecté en ce moment."
          [lignes]="2">
          <ul class="fa-p-liste">
            @for (u of online(); track u.userId) {
              <li>
                <span class="fa-dot" [class.idle]="u.status !== 'ACTIVE'" aria-hidden="true"></span>
                <div class="fa-p-corps">
                  <div class="fa-p-nom">
                    <span class="fa-p-n">{{ u.name }}</span>
                    <span class="fa-role">{{ roleLabel(u.role) }}</span>
                  </div>
                  <div class="fa-p-meta">
                    {{ u.currentRouteLabel ?? u.currentRoute ?? 'Page inconnue' }}
                    · {{ vuIlYA(u.lastSeenSec) }}
                  </div>
                </div>
              </li>
            }
          </ul>
        </app-zone>
      </section>
    </ng-template>
  `,
  styles: [`
    .fa { padding: 16px; max-width: 1240px; margin: 0 auto; }
    .fa-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .fa-title { display: flex; gap: 10px; align-items: center; color: var(--text-primary); }
    .fa-title h1 { font-size: 20px; font-weight: 800; margin: 0; }
    .fa-sub { margin: 2px 0 0; font-size: 12.5px; color: var(--text-secondary); }
    .fa-refresh {
      display: flex; align-items: center; justify-content: center;
      min-width: 44px; min-height: 44px; flex-shrink: 0;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: 10px; cursor: pointer; color: var(--text-secondary);
    }
    .fa-refresh:disabled { opacity: .5; }
    .spin { animation: fa-spin 1s linear infinite; }
    @keyframes fa-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }

    /* Bandeau « ce qui n'a pas abouti » — les echecs en tete, avant tout le reste. */
    .fa-alerte {
      display: flex; gap: 11px; padding: 12px 14px; border-radius: 13px; margin-bottom: 13px;
      background: color-mix(in srgb, var(--danger) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
    }
    .fa-alerte-ico {
      display: flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; border-radius: 10px; flex-shrink: 0;
      background: var(--danger); color: var(--accent-ink);
    }
    .fa-alerte-corps { min-width: 0; flex: 1; }
    .fa-alerte-titre { font-size: 13.5px; font-weight: 800; color: var(--texte-alerte); }
    .fa-alerte-txt { margin: 4px 0 0; font-size: 12px; line-height: 1.45; color: var(--text-secondary); text-wrap: pretty; }
    .fa-alerte-chips { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    .fa-chip {
      display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 7px;
      background: var(--bg-secondary); font-size: 11.5px; font-weight: 700;
    }
    .fa-chip[data-ton='alerte'] { color: var(--texte-alerte); border: 1px solid color-mix(in srgb, var(--danger) 28%, transparent); }
    .fa-chip[data-ton='attente'] { color: var(--texte-attente); border: 1px solid color-mix(in srgb, var(--warning) 28%, transparent); }

    /* Tuiles de tete. */
    .fa-tuiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(80px, 1fr)); gap: 8px; margin-bottom: 13px; }
    .fa-tuile {
      display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: 13px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle); min-width: 0;
    }
    .fa-tuile b { font-size: 20px; font-weight: 800; letter-spacing: -.03em; line-height: 1.05; color: var(--text-primary); }
    .fa-tuile span { font-size: 11px; font-weight: 600; color: var(--text-secondary); }
    .fa-tuile.bord-attente { border-color: color-mix(in srgb, var(--warning) 34%, transparent); }
    .fa-tuile.bord-alerte { border-color: color-mix(in srgb, var(--danger) 34%, transparent); background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .t-info { color: var(--texte-info); } .t-succes { color: var(--texte-succes); }
    .t-attente { color: var(--texte-attente); } .t-alerte { color: var(--texte-alerte); }

    .fa-tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
    .fa-tabs .tab-btn {
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; min-height: 44px;
      border-radius: 10px; border: 1px solid var(--border-subtle); background: var(--bg-secondary);
      color: var(--text-secondary); font-weight: 700; font-size: 13px; cursor: pointer;
    }
    .fa-tabs .tab-btn.on { background: var(--tracky-light); color: var(--accent-ink); border-color: var(--tracky-light); }
    .fa-badge { background: var(--surface-quaternary); color: var(--text-primary); border-radius: 9999px; padding: 0 6px; font-size: 11px; }
    .fa-tabs .tab-btn.on .fa-badge { background: color-mix(in srgb, var(--accent-ink) 18%, transparent); color: var(--accent-ink); }

    .fa-grille { display: block; }
    .fa-grille.avec-aside { display: grid; grid-template-columns: minmax(0, 1fr) 344px; gap: 16px; align-items: start; }
    .fa-colonne { min-width: 0; }
    .fa-aside { min-width: 0; position: sticky; top: 16px; }

    .fa-note { font-size: 12.5px; color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
    .fa-filters { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .fa-filters select {
      min-height: 44px; padding: 7px 10px; border-radius: 9px; border: 1px solid var(--border-subtle);
      background: var(--bg-secondary); color: var(--text-primary); font-size: 13px; flex: 1 1 150px;
    }

    /* Liste des actions moteur — une carte par action, groupee. */
    .fa-liste { border: 1px solid var(--border-subtle); border-radius: 12px; overflow: hidden; }
    .fa-groupe {
      display: flex; align-items: center; gap: 8px; padding: 7px 14px;
      background: var(--bg-tertiary); border-bottom: 1px solid var(--border-subtle);
      font-size: 11px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase;
      color: var(--text-secondary);
    }
    .fa-groupe:not(:first-child) { border-top: 1px solid var(--border-subtle); }
    .fa-groupe.alerte { color: var(--texte-alerte); }
    .fa-losange { font-size: 9px; }
    .fa-ligne { display: flex; flex-direction: column; gap: 5px; padding: 11px 14px; border-bottom: 1px solid var(--border-subtle); }
    .fa-ligne:last-child { border-bottom: none; }
    .fa-ligne[data-ton='alerte'] { background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .fa-ligne[data-ton='attente'] { background: color-mix(in srgb, var(--warning) 12%, transparent); }
    .fa-l-tete { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .fa-plq {
      display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 5px;
      background: var(--surface-quaternary); border: 1px solid var(--border-strong);
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; font-weight: 600; white-space: nowrap;
      color: var(--text-primary);
    }
    .fa-act { display: inline-flex; align-items: center; gap: 4px; font-weight: 700; padding: 2px 8px; border-radius: 7px; font-size: 11.5px; }
    .fa-act[data-a='CUT'] { color: var(--texte-alerte); background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .fa-act[data-a='RESTORE'] { color: var(--texte-succes); background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent); }
    .fa-when { margin-left: auto; font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }

    /* Le resultat : un mot, puis ce qui s'est reellement passe. */
    .fa-l-res { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
    .fa-mot { font-size: 13px; font-weight: 800; }
    .fa-mot[data-ton='succes'] { color: var(--texte-succes); }
    .fa-mot[data-ton='attente'] { color: var(--texte-attente); }
    .fa-mot[data-ton='alerte'] { color: var(--texte-alerte); }
    .fa-mot[data-ton='inactif'] { color: var(--texte-inactif); }
    /*
     * --text-tertiary est lisible a 16 px, pas a 12 : mesure au navigateur en theme CLAIR,
     * 2,34:1 sur une ligne teintee et 3,07:1 sur la carte — sous le seuil de 4,5. Or cette
     * ligne EST le sujet de la page (« le resultat avant l'evenement ») : c'est le dernier
     * texte de l'ecran qu'on peut laisser palir. Meme constat que la famille --texte-* au
     * lot B0-prime : la couleur ne change pas de sens, elle descend d'un cran pour se lire.
     */
    .fa-detail { font-size: 12px; color: var(--text-secondary); text-wrap: pretty; }
    .fa-l-pied { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); }
    .fa-sep { color: var(--text-secondary); }
    .fa-role {
      display: inline-block; font-size: 10.5px; font-weight: 700; color: var(--text-secondary);
      background: var(--surface-quaternary); border-radius: 6px; padding: 1px 6px;
    }
    .fa-note-pied { margin: 10px 2px 0; font-size: 12px; line-height: 1.45; color: var(--text-secondary); text-wrap: pretty; }
    .fa-note-pied strong { color: var(--text-primary); }
    .fa-more {
      display: block; margin: 12px auto 0; min-height: 44px; padding: 8px 18px; border-radius: 9px;
      border: 1px solid var(--border-subtle); background: var(--bg-secondary); color: var(--text-primary);
      font-weight: 700; cursor: pointer;
    }

    /* Presence — panneau permanent au-dela de 1024 px, onglet en deca. */
    .fa-presence {
      border: 1px solid color-mix(in srgb, var(--color-tracky-light) 26%, transparent);
      border-radius: 13px; background: var(--bg-secondary); overflow: hidden;
    }
    .fa-p-tete {
      display: flex; align-items: center; gap: 11px; padding: 12px 14px;
      border-bottom: 1px solid color-mix(in srgb, var(--color-tracky-light) 20%, transparent);
    }
    .fa-p-ico {
      display: flex; align-items: center; justify-content: center; width: 31px; height: 31px;
      border-radius: 10px; flex-shrink: 0;
      background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent); color: var(--texte-succes);
    }
    .fa-p-titres { min-width: 0; flex: 1; }
    .fa-p-titres h2 { margin: 0; font-size: 14px; font-weight: 800; color: var(--text-primary); }
    .fa-p-titres p { margin: 1px 0 0; font-size: 11.5px; color: var(--text-secondary); }
    .fa-p-nb { font-size: 17px; font-weight: 800; color: var(--texte-succes); }
    .fa-p-liste { list-style: none; margin: 0; padding: 0; }
    .fa-p-liste li { display: flex; align-items: center; gap: 11px; padding: 11px 14px; border-bottom: 1px solid var(--border-subtle); }
    .fa-p-liste li:last-child { border-bottom: none; }
    .fa-dot { width: 8px; height: 8px; border-radius: 9999px; background: var(--color-tracky-light); flex-shrink: 0; }
    .fa-dot.idle { background: var(--warning); }
    .fa-p-corps { min-width: 0; flex: 1; }
    .fa-p-nom { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .fa-p-n { font-size: 13px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fa-p-meta { font-size: 11.5px; color: var(--text-secondary); margin-top: 2px; }

    .fa-feed { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-subtle); border-radius: 12px; overflow: hidden; }
    .fa-feed li { display: flex; gap: 10px; align-items: baseline; padding: 9px 12px; border-top: 1px solid var(--border-subtle); font-size: 13px; flex-wrap: wrap; }
    .fa-feed li:first-child { border-top: none; }
    .fa-feed-when { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .fa-feed-user { font-weight: 700; color: var(--text-primary); }
    .fa-feed-type { font-size: 11px; text-transform: uppercase; color: var(--text-secondary); }
    .fa-feed-target { color: var(--text-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  `],
})
export class FleetActivityComponent implements OnInit, OnDestroy {
  private readonly api = inject(FleetActivityApiService);
  private readonly toast = inject(ToastService);

  protected readonly ActivityIcon = Activity;
  protected readonly RefreshIcon = RefreshCw;
  protected readonly ZapIcon = Zap;
  protected readonly UsersIcon = Users;
  protected readonly DotIcon = CircleDot;
  protected readonly PowerIcon = Power;
  protected readonly PowerOffIcon = PowerOff;
  protected readonly WarnIcon = AlertTriangle;

  protected readonly pageSize = 50;
  /**
   * La presence est desormais un panneau PERMANENT sur grand ecran : elle est a l'ecran en
   * continu, alors qu'elle n'apparaissait avant que sur clic d'onglet. Un sondage de 5 s
   * permanent serait un appel toutes les 5 secondes pendant toute la session ; la planche
   * ecrit « Rafraichi toutes les 20 s », et le libelle affiche cette valeur — il ne peut donc
   * pas deriver de la realite.
   */
  protected readonly periodeSondageSec = 20;
  protected readonly tab = signal<Tab>('engine');
  protected readonly loading = signal(false);
  protected readonly online = signal<OnlineUserDto[]>([]);
  protected readonly feed = signal<ActivityFeedItemDto[]>([]);
  protected readonly engine = signal<EngineCommandAuditDto[]>([]);
  protected readonly engineAction = signal<string>('');
  protected readonly engineStatus = signal<string>('');
  /** Grand ecran : la presence a une colonne a elle. Sous 1024 px, elle redevient un onglet. */
  protected readonly large = signal(false);

  /**
   * Une panne et un resultat vide sont DEUX choses. Le code precedent les confondait
   * (`catch` qui posait un tableau vide) : une API tombee affichait « Aucune action moteur
   * sur cette flotte » — un mensonge rassurant sur l'ecran meme qui sert a verifier que
   * personne n'a touche aux vehicules.
   */
  private readonly engineErreur = signal(false);
  private readonly feedErreur = signal(false);
  private readonly presenceErreur = signal(false);
  private readonly engineCharge = signal(false);
  private readonly feedCharge = signal(false);
  private readonly presenceCharge = signal(false);

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private mq: MediaQueryList | null = null;
  private onMq: ((e: MediaQueryListEvent) => void) | null = null;

  // ── Etats de zone ──────────────────────────────────────────────────────────
  protected readonly etatMoteurs = computed<EtatZone>(() => {
    if (this.engineErreur()) return 'erreur';
    if (!this.engineCharge()) return 'chargement';
    return this.engine().length ? 'rempli' : 'vide';
  });
  protected readonly etatFeed = computed<EtatZone>(() => {
    if (this.feedErreur()) return 'erreur';
    if (!this.feedCharge()) return 'chargement';
    return this.feed().length ? 'rempli' : 'vide';
  });
  /**
   * La presence est un sondage de FOND, volontairement silencieux (cf. le service). Une panne
   * n'y merite pas un bandeau d'erreur rouge sur un panneau permanent : on garde le dernier
   * etat connu s'il y en a un, et on ne bascule en « vide » qu'une fois un tour reussi.
   */
  protected readonly etatPresence = computed<EtatZone>(() => {
    if (this.online().length) return 'rempli';
    if (!this.presenceCharge()) return this.presenceErreur() ? 'vide' : 'chargement';
    return 'vide';
  });

  // ── Compteurs de tete ──────────────────────────────────────────────────────
  /**
   * Les actions retenues pour les compteurs : celles des 7 derniers jours PARMI celles
   * chargees. Le back sert une page (cursor `before`), pas une fenetre : compter « sur 7
   * jours » sans le verifier afficherait un chiffre faux des que la flotte depasse une page.
   */
  protected readonly vus = computed<EngineCommandAuditDto[]>(() => {
    const limite = Date.now() - FENETRE_MS;
    return this.engine().filter((c) => new Date(c.createdAt).getTime() >= limite);
  });
  /**
   * A-t-on REELLEMENT toute la fenetre de 7 jours ? Oui seulement si la plus ancienne action
   * chargee est plus vieille que la fenetre : dans ce cas la page couvre les 7 jours en
   * entier. Sinon on ne sait pas ce qui manque, et le libelle le dit.
   */
  private readonly fenetreComplete = computed<boolean>(() => {
    const tout = this.engine();
    if (!tout.length) return true;
    const plusAncienne = new Date(tout[tout.length - 1].createdAt).getTime();
    return plusAncienne < Date.now() - FENETRE_MS;
  });
  protected readonly libelleFenetre = computed(() =>
    this.fenetreComplete() ? 'Actions · 7 j' : 'Actions chargées',
  );

  private compte(pred: (c: EngineCommandAuditDto) => boolean): number {
    return this.vus().filter(pred).length;
  }
  protected readonly nbCoupures = computed(() => this.compte((c) => c.action === 'CUT'));
  protected readonly nbRallumages = computed(() => this.compte((c) => c.action === 'RESTORE'));
  protected readonly nbRefusees = computed(() => this.compte((c) => c.status === 'REJECTED_SPEED'));
  protected readonly nbEchecs = computed(() => this.compte((c) => c.status === 'FAILED'));

  /** Ce qui n'a pas abouti — l'ordre de lecture de la page commence ici. */
  protected readonly problemes = computed(() =>
    this.vus().filter((c) => c.status === 'FAILED' || c.status === 'REJECTED_SPEED'),
  );

  protected readonly titreProblemes = computed(() => {
    const n = this.problemes().length;
    const suffixe = this.fenetreComplete() ? ` ces ${FENETRE_JOURS} derniers jours` : ' parmi les actions chargées';
    return n > 1
      ? `${n} commandes moteur n'ont pas abouti${suffixe}`
      : `1 commande moteur n'a pas abouti${suffixe}`;
  });

  /**
   * La phrase qui evite l'inquietude inutile : une refusee est le garde-fou qui FONCTIONNE,
   * un echec est un boitier a verifier. Les deux etaient rouges et indistincts.
   */
  protected readonly expliqueProblemes = computed(() => {
    const r = this.nbRefusees();
    const e = this.nbEchecs();
    const bouts: string[] = [];
    if (r) bouts.push(r > 1
      ? `${r} refusées parce que le véhicule roulait — c'est le garde-fou, il a fonctionné`
      : `Une refusée parce que le véhicule roulait — c'est le garde-fou, il a fonctionné`);
    if (e) bouts.push(e > 1
      ? `${e} en échec : le boîtier n'a pas répondu, à vérifier`
      : `Une en échec : le boîtier n'a pas répondu, à vérifier`);
    return bouts.join('. ') + '.';
  });

  /** Les echecs en tete, puis le classement par jour. */
  protected readonly groupes = computed<Groupe[]>(() => {
    const tout = this.engine();
    const aVerifier = tout.filter((c) => this.resultat(c).probleme);
    const reste = tout.filter((c) => !this.resultat(c).probleme);
    const out: Groupe[] = [];
    if (aVerifier.length) {
      out.push({ cle: 'a-verifier', titre: `À vérifier · ${aVerifier.length}`, alerte: true, items: aVerifier });
    }
    const parJour = new Map<string, EngineCommandAuditDto[]>();
    for (const c of reste) {
      const d = new Date(c.createdAt);
      const cle = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      const liste = parJour.get(cle);
      if (liste) liste.push(c); else parJour.set(cle, [c]);
    }
    for (const [cle, items] of parJour) {
      out.push({ cle, titre: this.libelleJour(items[0].createdAt), alerte: false, items });
    }
    return out;
  });

  ngOnInit(): void {
    void this.loadEngine();
    void this.loadOnline();
    this.pollTimer = setInterval(() => void this.loadOnline(), this.periodeSondageSec * 1000);

    // La presence n'a une colonne que s'il y a la place. 1024 px = la largeur en deca de
    // laquelle la colonne de 344 px mangerait la liste au lieu de l'accompagner.
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.mq = window.matchMedia('(min-width: 1024px)');
      this.large.set(this.mq.matches);
      this.onMq = (e: MediaQueryListEvent) => {
        this.large.set(e.matches);
        // En passant au grand ecran, l'onglet « En ligne » disparait : on ne laisse pas
        // l'utilisateur sur un onglet qui n'existe plus.
        if (e.matches && this.tab() === 'live') this.setTab('engine');
      };
      this.mq.addEventListener('change', this.onMq);
    }
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.mq && this.onMq) this.mq.removeEventListener('change', this.onMq);
  }

  protected setTab(t: Tab): void {
    if (t === this.tab()) return;
    this.tab.set(t);
    this.reloadActive();
  }

  protected reloadActive(): void {
    if (this.tab() === 'engine') void this.loadEngine();
    else if (this.tab() === 'live') void this.loadOnline();
    else void this.loadFeed();
  }

  protected setEngineAction(v: string): void { this.engineAction.set(v); void this.loadEngine(); }
  protected setEngineStatus(v: string): void { this.engineStatus.set(v); void this.loadEngine(); }

  private async loadOnline(): Promise<void> {
    try {
      this.online.set(await firstValueFrom(this.api.online()));
      this.presenceErreur.set(false);
      this.presenceCharge.set(true);
    } catch (err) {
      // Silencieux : sondage de fond. Signaler toutes les 20 s serait du harcelement.
      swallow('fleet-activity:loadOnline', err);
      this.presenceErreur.set(true);
    }
  }

  private async loadEngine(): Promise<void> {
    this.loading.set(true);
    this.engineErreur.set(false);
    try {
      this.engine.set(await firstValueFrom(
        this.api.engineCommands(this.pageSize, undefined, this.engineAction() || undefined, this.engineStatus() || undefined),
      ));
      this.engineCharge.set(true);
    } catch (err) {
      swallow('fleet-activity:loadEngine', err);
      this.engine.set([]);
      this.engineErreur.set(true);
    } finally { this.loading.set(false); }
  }

  protected async loadMoreEngine(): Promise<void> {
    const last = this.engine()[this.engine().length - 1];
    if (!last) return;
    this.loading.set(true);
    try {
      const more = await firstValueFrom(
        this.api.engineCommands(this.pageSize, last.createdAt, this.engineAction() || undefined, this.engineStatus() || undefined),
      );
      if (more.length) this.engine.update((cur) => [...cur, ...more]);
    } catch (err) {
      swallow('fleet-activity:loadMoreEngine', err);
      // Chargement declenche par l'utilisateur : une panne muette lui laisserait croire
      // qu'il n'y a plus rien a montrer.
      this.toast.error('Chargement impossible', httpFailureMessage(err, 'cette activité'));
    } finally { this.loading.set(false); }
  }

  private async loadFeed(): Promise<void> {
    this.loading.set(true);
    this.feedErreur.set(false);
    try {
      this.feed.set(await firstValueFrom(this.api.feed({ limit: this.pageSize })));
      this.feedCharge.set(true);
    } catch (err) {
      swallow('fleet-activity:loadFeed', err);
      this.feed.set([]);
      this.feedErreur.set(true);
    } finally { this.loading.set(false); }
  }

  protected async loadMoreFeed(): Promise<void> {
    const last = this.feed()[this.feed().length - 1];
    if (!last) return;
    this.loading.set(true);
    try {
      const more = await firstValueFrom(this.api.feed({ limit: this.pageSize, before: last.at, beforeId: last.id }));
      if (more.length) this.feed.update((cur) => [...cur, ...more]);
    } catch (err) {
      swallow('fleet-activity:loadMoreFeed', err);
      this.toast.error('Chargement impossible', httpFailureMessage(err, 'cet historique'));
    } finally { this.loading.set(false); }
  }

  // ── Le resultat, pas le statut ────────────────────────────────────────────
  /**
   * « Refusee » seul n'aide personne : il faut savoir POURQUOI pour savoir s'il y a quelque
   * chose a faire. Le detail vient de `lastError`, que le serveur ecrit deja
   * (« Vitesse trop elevee : 74 km/h », « Position trop ancienne (…) », « Fix GPS invalide »)
   * et que l'ecran n'affichait pas. Aucun champ nouveau n'a ete demande a l'API.
   */
  protected resultat(c: EngineCommandAuditDto): Resultat {
    switch (c.status) {
      case 'ACKNOWLEDGED':
        return { mot: 'Confirmée', detail: this.delaiAck(c), ton: 'succes', probleme: false };
      case 'SENT':
        return {
          mot: 'Envoyée',
          detail: c.confirmationExpected ? "en attente de la confirmation du boîtier" : 'le boîtier ne confirme pas ce modèle',
          ton: 'attente',
          probleme: false,
        };
      case 'PENDING':
        return { mot: 'En attente', detail: "pas encore transmise au boîtier", ton: 'inactif', probleme: false };
      case 'FAILED':
        return { mot: 'Échec', detail: c.lastError ?? "le boîtier n'a pas répondu", ton: 'alerte', probleme: true };
      case 'REJECTED_SPEED':
        return { mot: 'Refusée', detail: c.lastError ?? 'véhicule en mouvement', ton: 'attente', probleme: true };
      default:
        return { mot: c.status, detail: c.lastError, ton: 'inactif', probleme: false };
    }
  }

  /**
   * Le libelle court d'une puce du bandeau : « GH-204-LP · échec boîtier ». On nomme la CAUSE
   * quand elle tient en deux mots, sinon le mot de resultat suffit — la ligne complete est
   * juste en dessous.
   */
  protected motCourt(c: EngineCommandAuditDto): string {
    if (c.status === 'FAILED') return 'échec boîtier';
    if (c.status === 'REJECTED_SPEED') return 'refusée';
    return this.resultat(c).mot.toLowerCase();
  }

  /** « le boitier a repondu en 4 s » — mesure reelle, jamais une valeur ecrite en dur. */
  private delaiAck(c: EngineCommandAuditDto): string | null {
    if (!c.ackedAt) return null;
    const depart = c.sentAt ?? c.createdAt;
    const ms = new Date(c.ackedAt).getTime() - new Date(depart).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    if (ms < 60_000) return `le boîtier a répondu en ${Math.max(1, Math.round(ms / 1000))} s`;
    return `le boîtier a répondu en ${Math.round(ms / 60_000)} min`;
  }

  protected vuIlYA(sec: number): string {
    if (sec < 10) return "vu à l'instant";
    if (sec < 60) return `vu il y a ${Math.round(sec)} s`;
    if (sec < 3600) return `vu il y a ${Math.round(sec / 60)} min`;
    return `vu il y a ${Math.round(sec / 3600)} h`;
  }

  private libelleJour(iso: string): string {
    const d = new Date(iso);
    const auj = new Date();
    const memeJour = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    if (memeJour(d, auj)) return "Aujourd'hui";
    const hier = new Date(auj.getTime() - 86_400_000);
    if (memeJour(d, hier)) return 'Hier';
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // ── Libellés ──────────────────────────────────────────────────────────────
  protected roleLabel(role: string): string {
    switch (role) {
      case 'FLEET_ADMIN': return 'Admin flotte';
      case 'FLEET_MANAGER': return 'Gestionnaire';
      case 'NIGHT_WATCHMAN': return 'Veilleur';
      case 'VIEWER': return 'Observateur';
      default: return role;
    }
  }
  protected sourceLabel(s: string): string {
    switch (s) {
      case 'MANUAL': return 'Manuel';
      case 'SCHEDULER': return 'Planning horaire';
      case 'DEVICE_OBSERVED': return 'Détecté (boîtier)';
      default: return s;
    }
  }
  protected typeLabel(t: string): string {
    switch (t) {
      case 'PAGE_VIEW': return 'Page';
      case 'CLICK': return 'Clic';
      case 'FORM_SUBMIT': return 'Formulaire';
      case 'SCROLL': return 'Défilement';
      default: return t;
    }
  }
}
