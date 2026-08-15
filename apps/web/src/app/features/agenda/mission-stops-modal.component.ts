import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ArrowDown, ArrowUp, History, LucideAngularModule, Plus, Trash2, TriangleAlert } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import { montantEuros } from '../../core/services/mission-requests.api';
import { DepotModalComponent } from '../depot/modals/depot-modal.component';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * A6 — MODIFIER LA TOURNÉE d'une mission, et lire son historique.
 *
 * ┌─ CE GESTE COÛTE DE L'ARGENT ──────────────────────────────────────────────┐
 * │ Trois livraisons de plus, et la distance saute d'une tranche : la mission  │
 * │ vaut 169 € au lieu de 79 €. L'écran le dit AVANT d'enregistrer, et le      │
 * │ journal le retient après — c'est ce qui permet de répondre six mois plus   │
 * │ tard à « pourquoi cette facture ».                                          │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ LE MOTIF EST OBLIGATOIRE. Il ne l'est pas à la création d'une mission — il n'y
 * a rien à justifier. Il l'est ici, parce qu'une tournée qu'on change a une raison,
 * et que c'est elle qu'on cherchera dans l'historique. Le serveur le refuse aussi :
 * l'écran ne fait que l'annoncer plus tôt.
 *
 * La coque est `depot-modal`, comme les sept modales du dépôt et celle de
 * négociation : feuille basse, 88dvh, safe-area, fermeture 44×44. En écrire une
 * autre est ce qui avait fait dériver `mission-dialog` (§ 10).
 */

interface Arret {
  label: string;
}

/** Une version de la tournée, telle que le serveur la rend. */
interface Revision {
  position: number;
  authorName: string;
  authorRole: string;
  reason: string | null;
  stops: string[];
  distanceKm: number | null;
  amountCents: number | null;
  previousAmountCents: number | null;
  createdAt: string;
}

@Component({
  selector: 'app-mission-stops-modal',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, DepotModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-depot-modal
      [titre]="'Tournée ' + missionRef()"
      sousTitre="Modifier les arrêts, et laisser une trace"
      (fermer)="fermer.emit()"
    >
      <p class="mst-intro">
        Le premier arrêt est le chargement, les suivants sont les livraisons dans
        l'ordre de passage. Le dépôt destinataire verra la tournée et sera prévenu du
        changement.
      </p>

      <!-- ═══ LES ARRÊTS ═══════════════════════════════════════════════════ -->
      <div class="mst-arret mst-arret--charge">
        <span class="mst-puce mst-puce--charge">Chargement</span>
        <input type="text" class="mst-champ"
               [ngModel]="arrets()[0].label"
               (ngModelChange)="majLabel(0, $event)"
               aria-label="Adresse de chargement" />
      </div>

      @for (a of arrets(); track $index; let i = $index) {
        @if (i > 0) {
          <div class="mst-arret">
            <div class="mst-tete">
              <span class="mst-puce">Livraison {{ i }}</span>
              <div class="mst-outils">
                <button type="button" class="mst-outil" [disabled]="i === 1"
                        (click)="monter(i)"
                        [attr.aria-label]="'Remonter la livraison ' + i">
                  <lucide-icon [img]="ArrowUp" [size]="15" />
                </button>
                <button type="button" class="mst-outil" [disabled]="i === arrets().length - 1"
                        (click)="descendre(i)"
                        [attr.aria-label]="'Descendre la livraison ' + i">
                  <lucide-icon [img]="ArrowDown" [size]="15" />
                </button>
                <button type="button" class="mst-outil" [disabled]="arrets().length <= 2"
                        (click)="retirer(i)"
                        [attr.aria-label]="'Retirer la livraison ' + i">
                  <lucide-icon [img]="Trash2" [size]="15" />
                </button>
              </div>
            </div>
            <input type="text" class="mst-champ"
                   [ngModel]="a.label"
                   (ngModelChange)="majLabel(i, $event)"
                   [attr.aria-label]="'Adresse de la livraison ' + i" />
          </div>
        }
      }

      <button type="button" class="mst-ajout" (click)="ajouter()">
        <lucide-icon [img]="Plus" [size]="15" /> Ajouter une livraison
      </button>

      <!-- ═══ DISTANCE ET PRIX ═════════════════════════════════════════════ -->
      <label class="mst-label" for="mst-km">Distance retenue</label>
      <span class="mst-unite">
        <input id="mst-km" type="number" min="0" step="1" inputmode="numeric"
               [ngModel]="distanceKm" (ngModelChange)="majDistance($event)" />
        <em>km</em>
      </span>
      <p class="mst-aide">
        C'est elle qui détermine la tranche tarifaire. Laissée vide, aucun montant
        n'est calculé et l'historique le dira.
      </p>

      @if (ecart(); as e) {
        <!-- L'ecart AVANT d'enregistrer : c'est ce qui evite la facture surprise. -->
        <p class="mst-ecart" [class.mst-ecart--hausse]="e.hausse">
          <lucide-icon [img]="TriangleAlert" [size]="15" aria-hidden="true" />
          <span>{{ e.texte }}</span>
        </p>
      }

      <!-- ═══ LE MOTIF, OBLIGATOIRE ════════════════════════════════════════ -->
      <label class="mst-label" for="mst-motif">Motif du changement</label>
      <textarea id="mst-motif" class="mst-champ mst-texte" rows="2" maxlength="400"
                [(ngModel)]="motif"
                placeholder="Le client a ajouté deux points de livraison."></textarea>
      <p class="mst-aide">
        Obligatoire : c'est cette phrase qu'on relira pour comprendre le changement.
      </p>

      <!-- ═══ L'HISTORIQUE ═════════════════════════════════════════════════ -->
      @if (historique().length > 0) {
        <section class="mst-histo">
          <h3 class="mst-histo-t">
            <lucide-icon [img]="History" [size]="15" aria-hidden="true" />
            Historique de la tournée
          </h3>
          <ol class="mst-histo-l">
            @for (r of historiqueRecentDAbord(); track r.position) {
              <li class="mst-rev">
                <div class="mst-rev-tete">
                  <strong>{{ r.position === 0 ? 'Tournée initiale' : 'Modification ' + r.position }}</strong>
                  <span>{{ quand(r.createdAt) }}</span>
                </div>
                <p class="mst-rev-qui">{{ r.authorName }}</p>
                @if (r.reason) { <p class="mst-rev-motif">{{ r.reason }}</p> }
                <p class="mst-rev-trajet">{{ r.stops.join(' → ') }}</p>
                <p class="mst-rev-chiffres">
                  {{ r.distanceKm === null ? 'Distance non renseignée' : r.distanceKm + ' km' }}
                  @if (r.amountCents !== null) {
                    · <strong>{{ euros(r.amountCents) }} HT</strong>
                    @if (r.previousAmountCents !== null && r.previousAmountCents !== r.amountCents) {
                      <em>(au lieu de {{ euros(r.previousAmountCents) }})</em>
                    }
                  }
                </p>
              </li>
            }
          </ol>
        </section>
      }

      <footer pied class="mst-pied">
        <button type="button" class="mst-btn" (click)="fermer.emit()">Annuler</button>
        <button type="button" class="mst-btn mst-btn--accent"
                [disabled]="envoi() || !valide()"
                (click)="enregistrer()">
          {{ envoi() ? 'Enregistrement…' : 'Enregistrer la tournée' }}
        </button>
      </footer>
    </app-depot-modal>
  `,
  styles: [`
    .mst-intro { margin: 0 0 14px; font-size: 12.5px; line-height: 1.6; color: var(--text-secondary) }
    .mst-aide { margin: 7px 0 0; font-size: 12px; line-height: 1.55; color: var(--texte-inactif) }
    .mst-label { display: block; margin: 16px 0 7px; font-size: 12px; font-weight: 600;
                 color: var(--text-secondary) }

    .mst-champ { width: 100%; min-width: 0; min-height: 44px; padding: 10px 12px;
                 border-radius: 11px; background: var(--surface-tertiary);
                 border: 1px solid var(--border-color); color: var(--text-primary);
                 font-family: inherit; font-size: 13.5px }
    .mst-champ:focus { outline: 2px solid var(--violet); outline-offset: 1px }
    .mst-texte { resize: vertical; line-height: 1.55 }

    .mst-arret { padding: 11px 12px; border-radius: 13px; margin-bottom: 8px;
                 background: var(--surface-tertiary); border: 1px solid var(--border-color) }
    .mst-arret .mst-champ { background: var(--surface-secondary) }
    .mst-arret--charge { border-color: color-mix(in srgb, var(--color-tracky-light) 34%, transparent) }
    .mst-tete { display: flex; align-items: center; justify-content: space-between;
                gap: 10px; margin-bottom: 8px }
    .mst-puce { display: inline-block; margin-bottom: 8px; padding: 3px 9px; border-radius: 9999px;
                font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
                background: var(--surface-secondary); color: var(--text-secondary) }
    .mst-tete .mst-puce { margin-bottom: 0 }
    .mst-puce--charge { background: color-mix(in srgb, var(--color-tracky-light) 16%, transparent);
                        color: var(--texte-succes) }
    .mst-outils { display: flex; gap: 5px; flex-shrink: 0 }
    .mst-outil { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 9px;
                 background: var(--surface-secondary); border: 1px solid var(--border-color);
                 color: var(--text-secondary); cursor: pointer }
    .mst-outil:disabled { opacity: .35; cursor: not-allowed }
    .mst-ajout { min-height: 40px; padding: 9px 15px; border-radius: 10px; cursor: pointer;
                 font-family: inherit; font-size: 12.5px; font-weight: 600;
                 background: transparent; border: 1px dashed var(--border-strong-color);
                 color: var(--text-secondary) }

    .mst-unite { display: inline-flex; align-items: center; gap: 7px }
    .mst-unite input { width: 110px; min-height: 44px; padding: 9px 11px; border-radius: 10px;
                       text-align: right; background: var(--surface-tertiary);
                       border: 1px solid var(--border-color); color: var(--text-primary);
                       font-family: inherit; font-size: 13.5px }
    .mst-unite em { font-style: normal; font-size: 12px; color: var(--text-secondary) }

    .mst-ecart { display: flex; align-items: flex-start; gap: 9px; margin: 12px 0 0;
                 padding: 11px 13px; border-radius: 12px; font-size: 12.5px; line-height: 1.6;
                 color: var(--text-secondary);
                 background: var(--surface-tertiary); border: 1px solid var(--border-color) }
    .mst-ecart--hausse { color: var(--texte-attente);
                         background: color-mix(in srgb, var(--warning) 12%, transparent);
                         border-color: color-mix(in srgb, var(--warning) 30%, transparent) }
    .mst-ecart lucide-icon { flex: 0 0 auto; margin-top: 1px }

    .mst-histo { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-color) }
    .mst-histo-t { display: flex; align-items: center; gap: 7px; margin: 0 0 10px;
                   font-size: 13px; font-weight: 700; color: var(--text-primary) }
    .mst-histo-l { margin: 0; padding: 0; list-style: none;
                   display: flex; flex-direction: column; gap: 9px }
    .mst-rev { padding: 10px 12px; border-radius: 12px;
               background: var(--surface-tertiary); border: 1px solid var(--border-color) }
    .mst-rev-tete { display: flex; align-items: baseline; justify-content: space-between;
                    gap: 12px; margin-bottom: 4px }
    .mst-rev-tete strong { font-size: 12.5px; color: var(--text-primary) }
    .mst-rev-tete span { flex-shrink: 0; font-size: 11px; color: var(--texte-inactif) }
    .mst-rev-qui { margin: 0; font-size: 11.5px; font-weight: 600; color: var(--text-secondary) }
    .mst-rev-motif { margin: 5px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--text-secondary) }
    .mst-rev-trajet { margin: 6px 0 0; font-size: 12.5px; line-height: 1.5;
                      color: var(--text-primary); overflow-wrap: anywhere }
    .mst-rev-chiffres { margin: 5px 0 0; font-size: 12px; color: var(--text-secondary) }
    .mst-rev-chiffres strong { color: var(--text-primary) }
    .mst-rev-chiffres em { font-style: normal; color: var(--texte-inactif) }

    .mst-pied { flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 8px;
                padding: 12px 20px 16px; border-top: 1px solid var(--border-color) }
    .mst-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px;
               min-height: 44px; padding: 10px 17px; border-radius: 11px;
               border: 1px solid var(--border-color); background: var(--surface-tertiary);
               color: var(--text-secondary); font-family: inherit; font-size: 13px;
               font-weight: 600; cursor: pointer }
    .mst-btn--accent { background: var(--color-tracky-light); border-color: transparent;
                       color: var(--accent-ink); font-weight: 700 }
    .mst-btn:disabled { opacity: .5; cursor: not-allowed }

    @media (max-width: 767px) {
      .mst-outil { width: 44px; height: 44px }
      .mst-ajout { min-height: 44px }
      .mst-pied .mst-btn { flex: 1 }
    }
  `],
})
export class MissionStopsModalComponent implements OnInit {
  readonly missionId = input.required<string>();
  readonly missionRef = input.required<string>();
  /** Les arrêts actuels, ou les deux libellés quand la mission est point à point. */
  readonly arretsInitiaux = input<string[]>([]);
  readonly fermer = output<void>();
  readonly modifiee = output<void>();

  private readonly http = inject(HttpClient);
  private readonly toast = inject(ToastService);

  protected readonly ArrowDown = ArrowDown;
  protected readonly ArrowUp = ArrowUp;
  protected readonly History = History;
  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected readonly TriangleAlert = TriangleAlert;

  protected readonly arrets = signal<Arret[]>([{ label: '' }, { label: '' }]);
  protected readonly historique = signal<Revision[]>([]);
  protected readonly envoi = signal(false);

  protected distanceKm: number | null = null;
  protected motif = '';

  ngOnInit(): void {
    const initiaux = this.arretsInitiaux().filter((l) => !!l?.trim());
    // Deux arrêts au minimum : une mission point à point arrive ici avec ses deux
    // libellés, et le formulaire doit pouvoir les afficher tels quels.
    this.arrets.set(
      initiaux.length >= 2 ? initiaux.map((label) => ({ label })) : [{ label: '' }, { label: '' }],
    );
    void this.chargerHistorique();
  }

  private async chargerHistorique(): Promise<void> {
    try {
      const r = await new Promise<Revision[]>((resoudre, rejeter) => {
        this.http
          .get<Revision[]>(`/api/missions/${this.missionId()}/stop-revisions`)
          .subscribe({ next: resoudre, error: rejeter });
      });
      this.historique.set(r ?? []);
      // La distance de la dernière version sert de point de départ : on modifie une
      // tournée à partir de ce qu'elle est, jamais d'un formulaire vide.
      const derniere = (r ?? []).at(-1);
      if (derniere?.distanceKm != null) this.distanceKm = derniere.distanceKm;
    } catch (err) {
      swallow('mission-stops-modal:historique', err);
      this.historique.set([]);
    }
  }

  // ═══ ÉTAT DÉRIVÉ ═══════════════════════════════════════════════════════════

  protected readonly historiqueRecentDAbord = computed(() =>
    [...this.historique()].sort((a, b) => b.position - a.position),
  );

  /** Le dernier montant connu, pour annoncer l'écart avant d'enregistrer. */
  private readonly montantActuel = computed<number | null>(() => {
    const derniere = [...this.historique()].sort((a, b) => b.position - a.position)[0];
    return derniere?.amountCents ?? null;
  });

  /**
   * ⚠️ MÉTHODES, PAS `computed()` : `distanceKm` et `motif` sont des champs simples
   * liés par `ngModel`. Un signal ne suit pas une propriété simple — le calcul
   * resterait figé sur sa première évaluation, et l'écart de prix annoncerait un
   * montant qui n'a plus rien à voir avec la saisie. Ce piège a déjà été payé deux
   * fois sur ce lot.
   */
  protected valide(): boolean {
    const a = this.arrets();
    if (a.length < 2) return false;
    if (!a.every((x) => !!x.label.trim())) return false;
    return this.motif.trim().length >= 3;
  }

  /**
   * L'écart de prix, en toutes lettres.
   *
   * Il ne se calcule pas ici : la grille tarifaire est côté serveur, et la dupliquer
   * une troisième fois serait une troisième source de vérité. On compare donc au
   * dernier montant CONNU, et on annonce le montant définitif après enregistrement.
   */
  protected ecart(): { texte: string; hausse: boolean } | null {
    const actuel = this.montantActuel();
    if (this.distanceKm === null) {
      return {
        texte: 'Sans distance, aucun montant ne sera calculé — l\'historique le notera.',
        hausse: false,
      };
    }
    if (actuel === null) return null;
    return {
      texte: `Le montant sera recalculé sur ${this.distanceKm} km, à partir de ${montantEuros(actuel)} HT aujourd'hui.`,
      hausse: false,
    };
  }

  // ═══ LES ARRÊTS ════════════════════════════════════════════════════════════

  protected majLabel(i: number, valeur: string): void {
    this.arrets.update((liste) => liste.map((a, j) => (j === i ? { label: valeur } : a)));
  }

  protected majDistance(valeur: unknown): void {
    const n = valeur === '' || valeur === null || valeur === undefined ? null : Number(valeur);
    this.distanceKm = Number.isFinite(n as number) ? n : null;
  }

  protected ajouter(): void {
    this.arrets.update((liste) => [...liste, { label: '' }]);
  }

  protected retirer(i: number): void {
    if (i === 0 || this.arrets().length <= 2) return;
    this.arrets.update((liste) => liste.filter((_, j) => j !== i));
  }

  /** La position 0 est intouchable : le serveur en fait le chargement (arbitrage B). */
  protected monter(i: number): void {
    if (i <= 1) return;
    this.echanger(i, i - 1);
  }

  protected descendre(i: number): void {
    if (i === 0 || i >= this.arrets().length - 1) return;
    this.echanger(i, i + 1);
  }

  private echanger(a: number, b: number): void {
    this.arrets.update((liste) => {
      const copie = [...liste];
      [copie[a], copie[b]] = [copie[b], copie[a]];
      return copie;
    });
  }

  // ═══ AFFICHAGE ═════════════════════════════════════════════════════════════

  protected euros(cents: number): string {
    return montantEuros(cents);
  }

  protected quand(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  // ═══ ENREGISTREMENT ════════════════════════════════════════════════════════

  protected async enregistrer(): Promise<void> {
    if (!this.valide() || this.envoi()) return;
    this.envoi.set(true);
    try {
      const r = await new Promise<{ amountCents: number | null; previousAmountCents: number | null }>(
        (resoudre, rejeter) => {
          this.http
            .patch<{ amountCents: number | null; previousAmountCents: number | null }>(
              `/api/missions/${this.missionId()}/stops`,
              {
                stops: this.arrets().map((a) => ({ label: a.label.trim() })),
                distanceKm: this.distanceKm,
                reason: this.motif.trim(),
              },
            )
            .subscribe({ next: resoudre, error: rejeter });
        },
      );
      this.toast.show({
        kind: 'success',
        title: 'Tournée modifiée',
        // On dit LE MONTANT et QUI est prévenu : c'est ce que le gestionnaire veut
        // savoir en refermant, et ce qu'il aurait sinon découvert sur la facture.
        message:
          r.amountCents === null
            ? 'Le dépôt est prévenu par e-mail. Aucun montant recalculé, faute de distance ou de grille.'
            : `Nouveau montant : ${montantEuros(r.amountCents)} HT. Le dépôt est prévenu par e-mail.`,
      });
      this.modifiee.emit();
      this.fermer.emit();
    } catch (err) {
      swallow('mission-stops-modal:enregistrer', err);
      const brut = (err as { error?: { message?: unknown } })?.error?.message;
      this.toast.show({
        kind: 'error',
        title: 'Modification impossible',
        message:
          typeof brut === 'string' && brut.trim()
            ? brut
            : 'La tournée n\'a pas pu être enregistrée. Réessayez dans un instant.',
      });
    } finally {
      this.envoi.set(false);
    }
  }
}
