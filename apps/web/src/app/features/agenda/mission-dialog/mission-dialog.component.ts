import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { AlertTriangle, LucideAngularModule, Route, Warehouse, X } from 'lucide-angular';
import { swallow } from '../../../core/error/swallow';
import { FleetFilterService } from '../../../core/services/fleet-filter.service';

/**
 * Espace dépôt (2026-08) — la modale de création d'une mission. Cf. design/A2-MISSIONS.md § 5.
 *
 * Deux blocs de cette modale ne sont PAS décoratifs :
 *
 *  1. **Le bloc de conséquence**, sous les champs. Créer une mission déclenche quatre
 *     effets dont trois sont invisibles : un événement se pose dans l'agenda, un
 *     véhicule devient indisponible, un dépôt reçoit une notification. On les écrit
 *     avant de valider. C'est ce qui évite le « je ne savais pas que ça bloquait le
 *     véhicule », découvert trois jours plus tard quand personne ne peut plus réserver.
 *
 *  2. **La ligne de périmètre**, sous le champ dépôt. Elle dit exactement ce que le
 *     tiers verra, et pendant combien de temps. Le gestionnaire ouvre un accès à une
 *     société extérieure : il doit savoir ce qu'il ouvre.
 *
 * Les véhicules occupés sont AFFICHÉS ET GRISÉS, avec leur motif — jamais masqués.
 */

interface VehiculeDispo {
  id: string;
  plate: string;
  label: string | null;
  available: boolean;
  reason: string | null;
  /** Prochain instant libre — renseigné uniquement quand toute la flotte est prise. */
  nextFreeAt: string | null;
}

interface Depot {
  id: string;
  nom: string;
}

interface ConflitMission {
  code: string;
  vehiclePlate: string;
  conflictingMission: { ref: string; startAt: string; endAt: string };
}

@Component({
  selector: 'app-mission-dialog',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="md-backdrop" (click)="fermer.emit()"></div>
    <div class="md-panel" role="dialog" aria-modal="true" aria-labelledby="md-titre">
      <!-- Poignée de feuille — mobile uniquement. Sa géométrie suit la plateforme
           (36 × 5 sur iOS, 32 × 4 sur Android) : c'est un des trois écarts que B1
           déclare volontaires. -->
      <div class="md-poignee" aria-hidden="true"><span></span></div>

      <header class="md-head">
        <!-- En-tête iOS « Annuler / Terminé » : sur une feuille, le geste attendu est
             en haut, pas en bas. Sur Android et sur PC, les actions restent en pied. -->
        <button type="button" class="md-ios-annuler" (click)="fermer.emit()">Annuler</button>
        <h2 id="md-titre"><lucide-icon [img]="Route" [size]="18" />Nouvelle mission</h2>
        <button type="button" class="md-x" (click)="fermer.emit()" aria-label="Fermer">
          <lucide-icon [img]="X" [size]="18" />
        </button>
      </header>

      <div class="md-corps">
        <div class="md-grid">
          <label class="md-champ md-col2">
            <span>Point de départ</span>
            <input type="text" [(ngModel)]="origine" placeholder="Fenouillet" />
          </label>
          <label class="md-champ md-col2">
            <span>Destination</span>
            <input type="text" [(ngModel)]="destination" placeholder="Muret" />
          </label>

          <label class="md-champ">
            <span>Date</span>
            <input type="date" [(ngModel)]="date" (ngModelChange)="rechargerDisponibilite()" />
          </label>
          <!-- Liseré accent sur les deux heures : ce sont ELLES qui bornent l'accès
               du dépôt. Le signaler visuellement, c'est dire qu'elles ne sont pas
               un détail d'organisation. -->
          <label class="md-champ md-champ--accent">
            <span>Heure de départ</span>
            <input type="time" [(ngModel)]="heureDebut" (ngModelChange)="rechargerDisponibilite()" />
          </label>
          <label class="md-champ md-champ--accent">
            <span>Heure de fin</span>
            <input type="time" [(ngModel)]="heureFin" (ngModelChange)="rechargerDisponibilite()" />
          </label>

          <label class="md-champ md-col2">
            <span>Véhicule</span>
            <select [(ngModel)]="vehiculeId">
              <option value="">Choisir un véhicule…</option>
              @for (v of vehicules(); track v.id) {
                <!-- Occupé = visible et désactivé, avec son motif. Le masquer ferait
                     disparaître le camion que le gestionnaire cherchait. -->
                <option [value]="v.id" [disabled]="!v.available">
                  {{ v.plate }}{{ v.label ? ' · ' + v.label : '' }}{{ v.reason ? ' — ' + v.reason : '' }}
                </option>
              }
            </select>
          </label>

          @if (aucunLibre()) {
            <!-- ═══ NIVEAU 2 DU CONFLIT (A2 § 4) ═══════════════════════════════
                 Aucun véhicule n'est libre. On ne se contente PAS d'annoncer un
                 échec : on liste les véhicules bloqués avec leur mission, et on
                 propose le prochain créneau réellement calculé.

                 « Un gestionnaire qui reçoit "aucun véhicule disponible" sans
                   alternative rouvre le formulaire cinq fois. » -->
            <div class="md-niveau2 md-col2">
              <p class="md-niveau2-titre">
                <lucide-icon [img]="AlertTriangle" [size]="15" />
                Créneau indisponible — toute la flotte est prise
              </p>
              <ul class="md-niveau2-liste">
                @for (v of vehicules(); track v.id) {
                  <li>
                    <b>{{ v.plate }}</b>
                    <span>{{ v.reason }}</span>
                  </li>
                }
              </ul>

              @if (meilleureAlternative(); as alt) {
                <div class="md-niveau2-sortie">
                  <p>
                    <b>{{ alt.plate }}</b> se libère à <b>{{ heureCourte(alt.nextFreeAt!) }}</b>{{ jourSiAutre(alt.nextFreeAt!) }},
                    pour la même durée.
                  </p>
                  <button type="button" class="md-btn md-btn--primaire" (click)="decaler(alt)">
                    Décaler à {{ heureCourte(alt.nextFreeAt!) }}
                  </button>
                </div>
              } @else {
                <p class="md-niveau2-rien">
                  Aucun créneau ne se dégage dans les 14 prochains jours. Essayez une
                  autre date, ou libérez un véhicule en annulant une mission.
                </p>
              }
            </div>
          }

          <label class="md-champ md-col2">
            <span>Dépôt destinataire <em>facultatif</em></span>
            <select [(ngModel)]="depotId">
              <option value="">Aucun — mission interne</option>
              @for (d of depots(); track d.id) {
                <option [value]="d.id">{{ d.nom }}</option>
              }
            </select>
          </label>

          @if (depotId()) {
            <!-- LA LIGNE DE PÉRIMÈTRE. Le gestionnaire ouvre un accès à une société
                 extérieure : il doit savoir exactement ce qu'il ouvre, et jusqu'à quand. -->
            <p class="md-perimetre md-col2">
              <lucide-icon [img]="Warehouse" [size]="14" />
              Le dépôt verra la position du camion de {{ heureDebut() }} à {{ heureFin() }}
              uniquement, puis le trajet passera dans son historique.
            </p>
          }

          <label class="md-champ md-col2">
            <span>Notes <em>non transmises au dépôt</em></span>
            <textarea rows="2" [(ngModel)]="notes" placeholder="Consignes internes…"></textarea>
          </label>
        </div>

        <!-- ═══ LE BLOC DE CONSÉQUENCE ═══════════════════════════════════════════
             Trois effets invisibles rendus visibles AVANT de valider. -->
        <div class="md-consequence">
          <strong>À l'enregistrement</strong>
          <ul>
            <li>un événement <em>Mission</em> est posé le {{ dateLisible() }} dans l'agenda ;</li>
            <li>
              @if (plaqueChoisie()) { <b>{{ plaqueChoisie() }}</b> } @else { le véhicule choisi }
              devient indisponible de {{ heureDebut() }} à {{ heureFin() }} — il sort des
              créneaux réservables ;
            </li>
            @if (nomDepotChoisi()) {
              <li><b>{{ nomDepotChoisi() }}</b> reçoit une notification par e-mail.</li>
            } @else {
              <li>aucun tiers n'est notifié : cette mission reste interne.</li>
            }
          </ul>
        </div>

        @if (conflit(); as c) {
          <div class="md-erreur md-erreur--conflit">
            <lucide-icon [img]="AlertTriangle" [size]="16" />
            <div>
              <strong>Créneau déjà pris</strong>
              <p>
                {{ c.vehiclePlate }} porte déjà la mission {{ c.conflictingMission.ref }},
                de {{ heure(c.conflictingMission.startAt) }} à {{ heure(c.conflictingMission.endAt) }}.
                Choisissez un autre véhicule ou décalez le créneau.
              </p>
            </div>
          </div>
        } @else if (erreur()) {
          <div class="md-erreur">
            <lucide-icon [img]="AlertTriangle" [size]="16" />
            <p>{{ erreur() }}</p>
          </div>
        }

        @if (avertissements().length > 0) {
          <div class="md-avert">
            @for (a of avertissements(); track a) { <p>{{ a }}</p> }
          </div>
        }
      </div>

      <footer class="md-pied">
        <button type="button" class="md-btn" (click)="fermer.emit()">Annuler</button>
        <button type="button" class="md-btn md-btn--primaire" [disabled]="!valide() || envoi()"
                (click)="enregistrer()">
          {{ envoi() ? 'Enregistrement…' : 'Créer la mission' }}
        </button>
      </footer>
    </div>
  `,
  styles: [`
    .md-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 60; }
    .md-panel { position: fixed; z-index: 61; top: 50%; left: 50%; transform: translate(-50%,-50%);
                width: min(620px, calc(100vw - 32px));
                max-height: calc(100vh - 64px); max-height: calc(100dvh - 64px);
                display: flex; flex-direction: column;
                background: var(--surface-secondary); border: 1px solid var(--border-color);
                border-radius: 18px; overflow: hidden; }
    .md-head { display: flex; align-items: center; justify-content: space-between;
               padding: 16px 20px; border-bottom: 1px solid var(--border-color); }
    .md-head h2 { display: flex; align-items: center; gap: 9px; margin: 0;
                  font-family: var(--font-display); font-size: 17px; font-weight: 800;
                  color: var(--text-primary); }
    .md-x { background: none; border: 0; color: var(--text-tertiary); cursor: pointer; padding: 4px; }
    .md-corps { padding: 18px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;
                /* Le corps ne défile QUE verticalement : un débordement latéral dans une
                   feuille mobile emmène l'en-tête et son bouton de fermeture hors du champ. */
                overflow-x: hidden; }
    .md-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; min-width: 0; }
    .md-col2 { grid-column: 1 / -1; }
    /* ⚠️ min-width: 0 sur les enfants de grille et de flex. Leur valeur par défaut est
       auto : ils REFUSENT de descendre sous la largeur de leur contenu, et un libellé
       de véhicule un peu long élargit alors toute la modale — d'où le défilement
       horizontal relevé le 2026-08-12 sur téléphone. Rien ne le montre sur un écran
       large, où la place ne manque jamais. */
    .md-grid > * { min-width: 0; }
    .md-champ { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .md-champ select, .md-champ input, .md-champ textarea { max-width: 100%; }
    .md-champ > span { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
    .md-champ > span em { font-style: normal; font-weight: 500; color: var(--text-tertiary); }
    .md-champ input, .md-champ select, .md-champ textarea {
      padding: 9px 11px; border-radius: 10px; font-size: 13.5px; font-family: inherit;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
      color: var(--text-primary); width: 100%; }
    .md-champ--accent input { border-left: 3px solid var(--color-tracky-light); }
    .md-champ select option:disabled { color: var(--text-tertiary); }

    .md-perimetre { display: flex; align-items: flex-start; gap: 8px; margin: 0;
                    padding: 9px 11px; border-radius: 10px; font-size: 12.5px; line-height: 1.55;
                    background: color-mix(in srgb, var(--violet) 10%, transparent);
                    color: var(--violet); }
    .md-perimetre lucide-icon { flex-shrink: 0; margin-top: 1px; }

    .md-consequence { padding: 12px 14px; border-radius: 12px;
                      background: var(--surface-tertiary); border: 1px dashed var(--border-strong-color); }
    .md-consequence strong { display: block; font-size: 12px; font-weight: 700;
                             color: var(--text-secondary); margin-bottom: 6px; }
    .md-consequence ul { margin: 0; padding-left: 17px; display: flex; flex-direction: column; gap: 4px; }
    .md-consequence li { font-size: 12.5px; line-height: 1.55; color: var(--text-secondary); }
    .md-consequence b { color: var(--text-primary); font-family: var(--font-mono); font-size: 12px; }
    .md-consequence em { font-style: normal; font-weight: 600; color: var(--text-primary); }

    /* Niveau 2 du conflit — ambre : c'est une ATTENTE à lever, pas un échec (règle
       « une couleur = une signification », design/TOKENS.md). */
    .md-niveau2 { padding: 12px 14px; border-radius: 12px;
                  background: color-mix(in srgb, var(--warning) 9%, transparent);
                  border: 1px solid color-mix(in srgb, var(--warning) 28%, transparent); }
    .md-niveau2-titre { display: flex; align-items: center; gap: 7px; margin: 0 0 9px;
                        font-size: 13px; font-weight: 700; color: var(--warning); }
    .md-niveau2-liste { margin: 0 0 11px; padding: 0; list-style: none;
                        display: flex; flex-direction: column; gap: 5px; }
    .md-niveau2-liste li { display: flex; gap: 9px; font-size: 12.5px; align-items: baseline; }
    .md-niveau2-liste b { font-family: var(--font-mono); font-size: 12px;
                          color: var(--text-primary); flex-shrink: 0; }
    .md-niveau2-liste span { color: var(--text-tertiary); }
    .md-niveau2-sortie { display: flex; align-items: center; justify-content: space-between;
                         gap: 12px; flex-wrap: wrap; padding-top: 10px;
                         border-top: 1px solid color-mix(in srgb, var(--warning) 22%, transparent); }
    .md-niveau2-sortie p { margin: 0; font-size: 12.5px; line-height: 1.5;
                           color: var(--text-secondary); }
    .md-niveau2-sortie b { color: var(--text-primary); }
    .md-niveau2-rien { margin: 0; padding-top: 10px; font-size: 12.5px; line-height: 1.55;
                       color: var(--text-tertiary);
                       border-top: 1px solid color-mix(in srgb, var(--warning) 22%, transparent); }

    .md-erreur { display: flex; align-items: flex-start; gap: 9px; padding: 11px 13px;
                 border-radius: 11px; color: var(--danger);
                 background: color-mix(in srgb, var(--danger) 10%, transparent);
                 border: 1px solid color-mix(in srgb, var(--danger) 26%, transparent); }
    .md-erreur p { margin: 0; font-size: 12.5px; line-height: 1.55; }
    .md-erreur strong { display: block; font-size: 13px; margin-bottom: 3px; }
    .md-avert { padding: 10px 13px; border-radius: 11px; color: var(--warning);
                background: color-mix(in srgb, var(--warning) 10%, transparent); }
    .md-avert p { margin: 0; font-size: 12.5px; line-height: 1.55; }

    .md-pied { display: flex; justify-content: flex-end; gap: 9px; padding: 14px 20px;
               border-top: 1px solid var(--border-color); }
    .md-btn { padding: 9px 17px; border-radius: 10px; font-size: 13.5px; font-weight: 600;
              font-family: inherit; cursor: pointer;
              background: var(--surface-tertiary); border: 1px solid var(--border-color);
              color: var(--text-secondary); }
    .md-btn--primaire { background: var(--color-tracky-light); border-color: transparent;
                        color: var(--accent-ink); font-weight: 700; }
    .md-btn--primaire:disabled { opacity: .5; cursor: not-allowed; }

    /* Poignée et en-tête iOS : absents du rendu PC. */
    .md-poignee, .md-ios-annuler { display: none; }

    /* ═══ MOBILE : la modale devient une FEUILLE BASSE ═══════════════════════
       « Modale sur PC, feuille sur mobile » — cinquième règle du kit partagé
       (B1 § H). Une modale centrée sur 390 px laisse des marges inutiles et se
       ferme par un geste que personne ne trouve. */
    @media (max-width: 767px) {
      .md-grid { grid-template-columns: 1fr; }

      .md-panel {
        top: auto; left: 0; right: 0; bottom: 0;
        transform: none;
        width: 100%;
        max-width: none;
        /* Rayon de la plateforme : 22 px sur iOS, 28 px sur Android. */
        border-radius: var(--feuille-rayon) var(--feuille-rayon) 0 0;
        /* ⚠️ dvh EN PLUS de vh, comme partout ailleurs dans le kit — cette feuille était
           la seule à l'oublier. 92vh se mesure sur le viewport LARGE (barre d'URL
           rétractée) : la feuille dépassait donc le haut de l'écran, emportant sa poignée,
           son titre ET son bouton de fermeture. « On ne peut pas la fermer », 2026-08-12. */
        max-height: 92vh;
        max-height: 92dvh;
        /* Une feuille ne déborde jamais latéralement. */
        max-width: 100%;
        overflow-x: hidden;
        /* Le pouce doit atteindre le pied de feuille sans masquer le contenu. */
        padding-bottom: env(safe-area-inset-bottom);
      }

      .md-poignee { display: flex; justify-content: center; padding: 9px 0 3px; }
      .md-poignee span {
        display: block;
        width: var(--feuille-poignee-l);
        height: var(--feuille-poignee-h);
        border-radius: 9999px;
        background: var(--border-strong-color);
      }

      /* Cibles ≥ 44 px : critère de recette 7 de B1. */
      .md-champ input, .md-champ select, .md-champ textarea { min-height: 44px; font-size: 16px; }
      .md-btn { min-height: 44px; }
    }

    /* ─── iOS : en-tête « Annuler / Terminé » ────────────────────────────────
       Sur une feuille iOS, l'utilisateur cherche l'annulation EN HAUT À GAUCHE.
       Android garde ses actions en pied, conformément à M3 — c'est le troisième
       écart volontaire, avec la poignée et le rayon.

       ⚠️ :host-context() est OBLIGATOIRE ici, et non un sélecteur d'ancêtre direct.
       L'encapsulation émulée d'Angular réécrit body.plat-ios .x en
       body.plat-ios[_ngcontent-xxx] .x[_ngcontent-xxx] — elle colle l'attribut de
       scope sur body, qui ne le porte pas. La règle ne peut alors JAMAIS s'appliquer,
       et elle échoue EN SILENCE : pas d'erreur, pas d'avertissement, juste un style
       qui n'arrive pas. Constaté le 2026-08-09 en inspectant la règle dans la page. */
    @media (max-width: 767px) {
      :host-context(body.plat-ios) .md-head { justify-content: space-between; }
      :host-context(body.plat-ios) .md-ios-annuler {
        display: inline-flex; align-items: center;
        background: none; border: 0;
        font-family: inherit; font-size: 15px; color: var(--color-tracky-light);
        cursor: pointer;
        /* ⚠️ Sur iOS la croix est masquée : CE BOUTON EST LE SEUL MOYEN DE FERMER la
           feuille. Il mesurait 54 × 36 — sous le seuil de 44 px du critère 7 de B1,
           et donc difficile à atteindre au pouce. Mesuré le 2026-08-12. Le retrait
           négatif garde l'alignement optique du texte sur le bord de l'en-tête. */
        min-height: 44px; min-width: 44px; padding: 0 8px; margin-left: -8px;
      }
      :host-context(body.plat-ios) .md-head h2 { font-size: 15px; }
      :host-context(body.plat-ios) .md-x { display: none; }
      /* Le bouton « Annuler » du pied fait doublon avec l'en-tête iOS. */
      :host-context(body.plat-ios) .md-pied .md-btn:not(.md-btn--primaire) { display: none; }
      :host-context(body.plat-ios) .md-pied .md-btn--primaire { flex: 1; }
    }
  `],
})
export class MissionDialogComponent {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly fleetFilter = inject(FleetFilterService);

  /**
   * `&fleetId=…` ou `?fleetId=…`, ou rien.
   *
   * Un SUPER_ADMIN n'appartient a aucune societe : sans ce parametre, le serveur ne
   * sait ni ou chercher les vehicules disponibles, ni quels comptes depot proposer.
   * Vide pour les autres roles, dont la flotte est imposee cote serveur.
   */
  private paramSociete(prefixe: '?' | '&'): string {
    const id = this.fleetFilter.selectedFleetId();
    return id ? `${prefixe}fleetId=${encodeURIComponent(id)}` : '';
  }

  readonly fermer = output<void>();
  readonly creee = output<void>();

  protected readonly Route = Route;
  protected readonly X = X;
  protected readonly Warehouse = Warehouse;
  protected readonly AlertTriangle = AlertTriangle;

  // Défauts d'A2 § 5 : aujourd'hui, 08:00, +3 h.
  protected readonly origine = signal('');
  protected readonly destination = signal('');
  protected readonly date = signal(new Date().toISOString().slice(0, 10));
  protected readonly heureDebut = signal('08:00');
  protected readonly heureFin = signal('11:00');
  protected readonly vehiculeId = signal('');
  protected readonly depotId = signal('');
  protected readonly notes = signal('');

  /** Numéro de la dernière requête de disponibilité émise — cf. garde anti-course. */
  private derniereDemande = 0;

  protected readonly vehicules = signal<VehiculeDispo[]>([]);
  protected readonly depots = signal<Depot[]>([]);
  protected readonly envoi = signal(false);
  protected readonly erreur = signal<string | null>(null);
  protected readonly conflit = signal<ConflitMission | null>(null);
  protected readonly avertissements = signal<string[]>([]);

  protected readonly plaqueChoisie = computed(
    () => this.vehicules().find((v) => v.id === this.vehiculeId())?.plate ?? null,
  );
  protected readonly nomDepotChoisi = computed(
    () => this.depots().find((d) => d.id === this.depotId())?.nom ?? null,
  );
  protected readonly valide = computed(
    () => !!this.origine().trim() && !!this.destination().trim() && !!this.vehiculeId(),
  );

  /** Niveau 2 du conflit : la flotte entière est prise sur ce créneau. */
  protected readonly aucunLibre = computed(
    () => this.vehicules().length > 0 && this.vehicules().every((v) => !v.available),
  );

  /**
   * Le véhicule qui se libère LE PLUS TÔT. On n'en propose qu'un : offrir sept
   * alternatives, c'est redemander de choisir à quelqu'un qui vient d'échouer.
   */
  protected readonly meilleureAlternative = computed(() => {
    const candidats = this.vehicules().filter((v) => v.nextFreeAt);
    if (candidats.length === 0) return null;
    return candidats.reduce((a, b) => (a.nextFreeAt! <= b.nextFreeAt! ? a : b));
  });

  constructor() {
    this.chargerDepots();
    this.rechargerDisponibilite();
  }

  protected dateLisible(): string {
    const d = new Date(this.date());
    return Number.isNaN(d.getTime())
      ? '—'
      : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  }

  protected heure(iso: string): string {
    return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  protected heureCourte(iso: string): string {
    return this.heure(iso);
  }

  /** « , demain » ou « , le 14 août » — seulement si ce n'est pas le jour demandé. */
  protected jourSiAutre(iso: string): string {
    const cible = new Date(iso);
    const demande = new Date(this.date());
    if (cible.toDateString() === demande.toDateString()) return '';
    const lendemain = new Date(demande.getTime() + 86_400_000);
    if (cible.toDateString() === lendemain.toDateString()) return ', demain';
    return `, le ${cible.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
  }

  /**
   * « Décaler à 12:30 » — reporte le créneau sur le prochain moment libre, EN
   * CONSERVANT la durée saisie, et présélectionne le véhicule concerné.
   *
   * Le gestionnaire n'a rien à ressaisir : c'est la différence entre une sortie et
   * un simple message d'erreur poli.
   */
  protected decaler(alt: VehiculeDispo): void {
    if (!alt.nextFreeAt) return;
    const { debut, fin } = this.creneau();
    if (!debut || !fin) return;
    const duree = new Date(fin).getTime() - new Date(debut).getTime();

    const nouveauDebut = new Date(alt.nextFreeAt);
    const nouvelleFin = new Date(nouveauDebut.getTime() + duree);
    const hhmm = (d: Date) =>
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    this.date.set(
      `${nouveauDebut.getFullYear()}-${String(nouveauDebut.getMonth() + 1).padStart(2, '0')}-${String(nouveauDebut.getDate()).padStart(2, '0')}`,
    );
    this.heureDebut.set(hhmm(nouveauDebut));
    this.heureFin.set(hhmm(nouvelleFin));
    this.vehiculeId.set(alt.id);
    this.conflit.set(null);
    // Recharge : sur le nouveau créneau, la flotte n'a plus la même tête.
    this.rechargerDisponibilite();
  }

  /**
   * Recharge la disponibilité à CHAQUE changement de créneau.
   *
   * Sans ça, le gestionnaire choisirait un véhicule libre à 08:00, décalerait à 14:00,
   * et découvrirait le conflit seulement au moment de valider — après avoir tout saisi.
   */
  protected rechargerDisponibilite(): void {
    const { debut, fin } = this.creneau();
    if (!debut || !fin) return;

    // ⚠️ GARDE ANTI-COURSE. Chaque frappe sur une heure déclenche une requête. Deux
    // requêtes lancées coup sur coup peuvent revenir DANS LE DÉSORDRE, et la plus
    // ancienne écraserait alors la plus récente.
    //
    // Ce n'est pas théorique : constaté le 2026-08-09 en testant l'écran. En posant
    // l'heure de début (21:00) alors que l'heure de fin valait encore 11:00, la modale
    // a calculé un créneau débordant sur le lendemain — donc une autre disponibilité.
    // Sa réponse est arrivée APRÈS celle du créneau corrigé et l'a remplacée : la liste
    // affichait un camion occupé qui était libre.
    //
    // Conséquence si on ne corrige pas : un véhicule montré libre alors qu'il est pris
    // (409 à la validation), ou masqué alors qu'il est disponible. On ne retient donc
    // que la réponse de la DERNIÈRE requête émise.
    const demande = ++this.derniereDemande;

    this.http
      .get<VehiculeDispo[]>(
        `/api/missions/vehicle-availability?startAt=${encodeURIComponent(debut)}&endAt=${encodeURIComponent(fin)}${this.paramSociete("&")}`,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (v) => {
          if (demande !== this.derniereDemande) return; // réponse périmée : on l'ignore
          this.vehicules.set(v ?? []);
          // Si le véhicule choisi vient de devenir occupé, on le désélectionne : garder
          // une sélection invalide mènerait droit à un 409 à la validation.
          const choisi = (v ?? []).find((x) => x.id === this.vehiculeId());
          if (choisi && !choisi.available) this.vehiculeId.set('');
        },
        error: (err) => {
          if (demande !== this.derniereDemande) return;
          swallow('mission-dialog:disponibilite', err);
        },
      });
  }

  private chargerDepots(): void {
    this.http
      .get<Depot[]>(`/api/missions/depots${this.paramSociete("?")}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => this.depots.set(d ?? []),
        error: (err) => swallow('mission-dialog:depots', err),
      });
  }

  private creneau(): { debut: string | null; fin: string | null } {
    const d = this.date();
    if (!d) return { debut: null, fin: null };
    const debut = new Date(`${d}T${this.heureDebut()}:00`);
    const fin = new Date(`${d}T${this.heureFin()}:00`);
    if (Number.isNaN(debut.getTime()) || Number.isNaN(fin.getTime())) {
      return { debut: null, fin: null };
    }
    // Une mission qui déborde sur le lendemain est autorisée (≤ 24 h, A2 § 8).
    if (fin <= debut) fin.setDate(fin.getDate() + 1);
    return { debut: debut.toISOString(), fin: fin.toISOString() };
  }

  protected enregistrer(): void {
    if (!this.valide() || this.envoi()) return;
    const { debut, fin } = this.creneau();
    if (!debut || !fin) return;

    this.envoi.set(true);
    this.erreur.set(null);
    this.conflit.set(null);

    this.http
      .post<{ mission: { ref: string }; avertissements: string[] }>('/api/missions', {
        fleetId: this.fleetFilter.selectedFleetId(),
        originLabel: this.origine().trim(),
        destLabel: this.destination().trim(),
        startAt: debut,
        endAt: fin,
        vehicleId: this.vehiculeId(),
        depotUserId: this.depotId() || null,
        notes: this.notes().trim() || null,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.envoi.set(false);
          // Un avertissement (véhicule sans boîtier) n'empêche PAS la création : on le
          // montre, la mission existe, et le gestionnaire ferme quand il l'a lu.
          if (r?.avertissements?.length) {
            this.avertissements.set(r.avertissements);
            this.creee.emit();
            return;
          }
          this.creee.emit();
          this.fermer.emit();
        },
        error: (err: HttpErrorResponse) => {
          this.envoi.set(false);
          const corps = err.error as ConflitMission | { message?: string } | undefined;
          if (corps && 'code' in corps && corps.code === 'MISSION_SLOT_CONFLICT') {
            this.conflit.set(corps);
            // On recharge : le véhicule vient d'être pris, la liste doit le dire.
            this.rechargerDisponibilite();
            return;
          }
          const message = (corps as { message?: string })?.message;
          this.erreur.set(
            typeof message === 'string' ? message : "La mission n'a pas pu être créée.",
          );
        },
      });
  }
}
