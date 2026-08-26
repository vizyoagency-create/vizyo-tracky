import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { ArrowLeft, LucideAngularModule, RefreshCw, ShieldQuestion } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

interface ParVehicule {
  vehicleId: string | null;
  plaque: string;
  total: number;
  viaSms: number;
  canalInconnu: number;
  derniere: string;
}

interface Recente {
  id: string;
  creeLe: string;
  action: string;
  statut: string;
  canal: 'TCP' | 'SMS' | 'INCONNU';
  plaque: string;
  origine: string;
  ageHeures: number;
}

interface Reponse {
  fenetreJours: number;
  resume: {
    total: number;
    dernieres24h: number;
    derniers7j: number;
    parCanal: { TCP: number; SMS: number; INCONNU: number };
    vehiculesConcernes: number;
    plusAncienneHeures: number | null;
  };
  parVehicule: ParVehicule[];
  recentes: Recente[];
}

/**
 * TRK-018 nº 4 — les immobilisations que personne ne peut confirmer.
 *
 * ── POURQUOI CET ÉCRAN EXISTE ────────────────────────────────────────────────────────
 *
 * Le coupe-circuit peut repartir en SMS quand la socket TCP est indisponible. Pendant dix
 * semaines, ces commandes restaient `SENT` à vie : Tracky écrivait « envoyé » et n'y revenait
 * jamais, la passerelle écrivait « queued » et n'y revenait jamais. Un véhicule était immobilisé
 * et redémarré chaque nuit par un canal dont personne, à aucun étage, ne pouvait dire s'il
 * transmettait.
 *
 * Les correctifs 1 à 3 ont rendu l'état lisible EN BASE — statut `SENT_UNCONFIRMED`, échéance
 * temporelle, canal réellement emprunté. Il manquait l'écran : un exploitant n'ouvre pas psql.
 *
 * ── CE QUE CET ÉCRAN DIT, ET CE QU'IL NE DIT PAS ─────────────────────────────────────
 *
 * 🔑 Il montre une CÉCITÉ, pas une panne. Rien ici ne prouve qu'un véhicule n'a pas été
 * immobilisé — seulement que personne ne peut l'affirmer. C'est pour ça que le mot « échec »
 * n'apparaît nulle part : un canal muet et un canal sain se ressemblent exactement quand rien
 * ne les mesure, et c'est précisément ce qui a laissé passer le défaut dix semaines.
 *
 * ── CE QUE L'ÉCRAN REFUSE DE FAIRE ───────────────────────────────────────────────────
 *
 * Aucun bouton « marquer comme confirmée ». Acquitter d'office ferait disparaître ces lignes et
 * supprimerait la seule trace de la question — le témoin n'est pas le défaut. L'écran est en
 * lecture seule, et un test le verrouille côté API.
 */
@Component({
  selector: 'app-immobilisations-non-confirmees',
  standalone: true,
  imports: [LucideAngularModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="inc">
      <a routerLink="/admin" class="inc-retour">
        <lucide-icon [img]="ArrowLeft" [size]="15" /> Administration
      </a>
      <h1 class="inc-titre">Immobilisations non confirmées</h1>
      <p class="inc-sous">
        Commandes de coupure ou de redémarrage moteur parties sans qu'aucun accusé ne soit jamais
        revenu. <strong>Ce n'est pas une liste d'échecs</strong> : rien ici ne prouve que le
        véhicule n'a pas été immobilisé — seulement que personne ne peut l'affirmer.
      </p>

      <div class="inc-actions">
        <button class="inc-b" (click)="charger()" [disabled]="chargement()">
          <lucide-icon [img]="RefreshCw" [size]="15" /> Rafraichir
        </button>
        <select class="inc-b inc-sel" [value]="jours()" (change)="changerFenetre($event)">
          <option value="7">7 jours</option>
          <option value="30">30 jours</option>
          <option value="90">90 jours</option>
          <option value="365">1 an</option>
        </select>
      </div>

      @if (chargement()) {
        <p class="inc-vide">Chargement…</p>
      } @else if (erreur()) {
        <p class="inc-vide inc-err">{{ erreur() }}</p>
      } @else if (data(); as d) {

        @if (d.resume.total === 0) {
          <!-- Un zéro qui MÉRITE d'être affirmé : la fenêtre est explicite, donc il se lit. -->
          <div class="inc-ok">
            <lucide-icon [img]="ShieldQuestion" [size]="18" />
            <span>Aucune immobilisation sans confirmation sur {{ d.fenetreJours }} jours.
              Chaque commande moteur a reçu son accusé.</span>
          </div>
        } @else {
          <div class="inc-cartes">
            <div class="inc-c">
              <span class="inc-c-n">{{ d.resume.total }}</span>
              <span class="inc-c-l">sans confirmation</span>
              <span class="inc-c-s">sur {{ d.fenetreJours }} jours</span>
            </div>
            <div class="inc-c">
              <span class="inc-c-n" [class.inc-c-n--attention]="d.resume.dernieres24h > 0">{{ d.resume.dernieres24h }}</span>
              <span class="inc-c-l">sur 24 h</span>
              <span class="inc-c-s">{{ d.resume.derniers7j }} sur 7 jours</span>
            </div>
            <div class="inc-c">
              <span class="inc-c-n">{{ d.resume.vehiculesConcernes }}</span>
              <span class="inc-c-l">véhicules</span>
              <span class="inc-c-s">au moins une commande muette</span>
            </div>
            <div class="inc-c">
              <span class="inc-c-n">{{ d.resume.parCanal.SMS }}</span>
              <span class="inc-c-l">parties en SMS</span>
              <span class="inc-c-s">{{ d.resume.parCanal.TCP }} en TCP · {{ d.resume.parCanal.INCONNU }} canal inconnu</span>
            </div>
          </div>

          @if (d.resume.parCanal.INCONNU > 0) {
            <p class="inc-note">
              « Canal inconnu » n'est pas une lacune d'affichage : ces commandes sont antérieures
              à l'enregistrement du canal. Les marquer TCP par défaut fabriquerait une donnée que
              personne n'a observée.
            </p>
          }

          <h2 class="inc-h2">Par véhicule</h2>
          <div class="inc-liste">
            @for (v of d.parVehicule; track v.plaque) {
              <article class="inc-ligne">
                <span class="inc-plaque">{{ v.plaque }}</span>
                <span class="inc-total">{{ v.total }}</span>
                <span class="inc-detail">
                  @if (v.viaSms > 0) { <span class="inc-tag inc-tag--sms">{{ v.viaSms }} en SMS</span> }
                  @if (v.canalInconnu > 0) { <span class="inc-tag">{{ v.canalInconnu }} canal inconnu</span> }
                </span>
                <span class="inc-date">dernière : {{ dateCourte(v.derniere) }}</span>
              </article>
            }
          </div>

          <h2 class="inc-h2">Les plus récentes</h2>
          <div class="inc-liste">
            @for (r of d.recentes; track r.id) {
              <article class="inc-ligne inc-ligne--rec">
                <span class="inc-plaque">{{ r.plaque }}</span>
                <span class="inc-tag" [class.inc-tag--cut]="r.action === 'CUT'">
                  {{ r.action === 'CUT' ? 'Coupure' : 'Redémarrage' }}
                </span>
                <span class="inc-tag" [class.inc-tag--sms]="r.canal === 'SMS'">{{ r.canal }}</span>
                <span class="inc-tag">{{ r.origine === 'SCHEDULER' ? 'automatique' : 'manuelle' }}</span>
                <span class="inc-date">{{ age(r.ageHeures) }}</span>
              </article>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [
    `
      .inc { display: flex; flex-direction: column; gap: 10px; padding: 16px }
      .inc-retour { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; font-size: 12px; color: var(--fg-secondary); text-decoration: none }
      .inc-titre { margin: 0; font-size: 22px; font-weight: 700; color: var(--fg-primary) }
      .inc-sous { margin: 0; font-size: 12px; color: var(--fg-secondary); max-width: 74ch; line-height: 1.6 }
      .inc-sous strong { color: var(--fg-primary) }

      .inc-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px }
      .inc-b {
        display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 12px;
        border-radius: 10px; font-size: 13px; cursor: pointer;
        border: 1px solid var(--border-strong); background: transparent; color: var(--fg-secondary);
      }
      .inc-sel { padding-right: 8px }

      .inc-vide { font-size: 13px; color: var(--fg-tertiary); padding: 12px 0 }
      .inc-err { color: var(--danger, #f2748a) }

      .inc-ok {
        display: flex; align-items: center; gap: 10px; padding: 14px;
        border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--bg-secondary);
        font-size: 13px; color: var(--fg-secondary); line-height: 1.5;
      }

      .inc-cartes { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-top: 6px }
      .inc-c {
        display: flex; flex-direction: column; gap: 3px; padding: 12px;
        border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--bg-secondary);
      }
      .inc-c-n { font-size: 26px; font-weight: 700; color: var(--fg-primary); line-height: 1.1; font-variant-numeric: tabular-nums }
      .inc-c-n--attention { color: var(--warning, #e0a340) }
      .inc-c-l { font-size: 12px; font-weight: 600; color: var(--fg-secondary) }
      .inc-c-s { font-size: 11px; color: var(--fg-tertiary) }

      .inc-note { margin: 4px 0 0; font-size: 11.5px; color: var(--fg-tertiary); max-width: 74ch; line-height: 1.55 }

      .inc-h2 { margin: 16px 0 2px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--fg-tertiary) }

      .inc-liste { display: flex; flex-direction: column; gap: 6px }
      .inc-ligne {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px;
        border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--bg-secondary);
      }
      .inc-plaque { font-size: 13px; font-weight: 600; color: var(--fg-primary); min-width: 96px }
      .inc-total { font-size: 15px; font-weight: 700; color: var(--fg-primary); font-variant-numeric: tabular-nums }
      .inc-detail { display: flex; gap: 6px; flex-wrap: wrap; flex: 1 }
      .inc-tag {
        font-size: 11px; padding: 2px 7px; border-radius: 6px;
        background: var(--bg-tertiary, rgba(127,127,127,.12)); color: var(--fg-secondary);
      }
      .inc-tag--sms { background: rgba(224, 163, 64, .14); color: var(--warning, #e0a340) }
      .inc-tag--cut { background: rgba(242, 116, 138, .13); color: var(--danger, #f2748a) }
      .inc-date { font-size: 11px; color: var(--fg-tertiary); margin-left: auto }
    `,
  ],
})
export class ImmobilisationsNonConfirmeesComponent implements OnInit {
  private readonly http = inject(HttpClient);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly RefreshCw = RefreshCw;
  protected readonly ShieldQuestion = ShieldQuestion;

  readonly data = signal<Reponse | null>(null);
  readonly chargement = signal(false);
  readonly erreur = signal<string | null>(null);
  readonly jours = signal(30);

  ngOnInit(): void {
    void this.charger();
  }

  changerFenetre(e: Event): void {
    const v = parseInt((e.target as HTMLSelectElement).value, 10);
    if (Number.isFinite(v)) {
      this.jours.set(v);
      void this.charger();
    }
  }

  async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set(null);
    try {
      const r = await firstValueFrom(
        this.http.get<Reponse>('/api/engine-control/unconfirmed', {
          params: { days: String(this.jours()) },
        }),
      );
      this.data.set(r);
    } catch {
      this.erreur.set("Impossible de charger les immobilisations non confirmées.");
    } finally {
      this.chargement.set(false);
    }
  }

  dateCourte(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  /** Un âge se lit mieux en jours passé 48 h — « 1176 h » ne dit rien à personne. */
  age(heures: number): string {
    if (heures < 48) return `il y a ${Math.round(heures)} h`;
    return `il y a ${Math.round(heures / 24)} j`;
  }
}
