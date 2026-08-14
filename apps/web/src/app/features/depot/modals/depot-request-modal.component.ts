import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ArrowDown, ArrowUp, LucideAngularModule, Plus, RotateCcw, Trash2, TriangleAlert } from 'lucide-angular';
import { swallow } from '../../../core/error/swallow';
import { MissionRequestsApi } from '../../../core/services/mission-requests.api';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { calculerDevis, euros, type GrilleTarifaire } from '../devis-tarifaire';
import { DepotModalComponent } from './depot-modal.component';

/**
 * Espace dépôt, lot A6 — demander une mission. Cf. docs/A6-DEMANDES-ET-DEVIS.md § 7bis.
 *
 * ┌─ UN PARCOURS EN ÉTAPES NOMMÉES, PAS UN FORMULAIRE (arbitrage F) ──────────┐
 * │ Trajet · Marchandise · Créneau · Devis · Envoi. Vingt champs d'un bloc     │
 * │ font abandonner : on ne sait ni où on en est, ni combien il reste. Cinq    │
 * │ étapes nommées répondent aux deux questions en permanence, et chacune ne   │
 * │ demande qu'une chose à la fois.                                            │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ CE QUE LE DEVIS EN DIRECT ÉVITE ─────────────────────────────────────────┐
 * │ La grille du client est forfaitaire par tranches : 79 € jusqu'à 50 km,     │
 * │ 169 € au-delà. Elle DOUBLE à la borne. Un dépôt qui ne la connaît pas      │
 * │ découvre l'écart sur sa facture et appelle — « pourquoi ai-je payé le      │
 * │ double pour deux kilomètres ? ». L'avertissement de borne existe pour cet  │
 * │ appel-là, et pour lui seul.                                                │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ LE RETOUR N'EST JAMAIS AJOUTÉ D'OFFICE (arbitrage H). Aucun segment fantôme :
 * le dépôt voit exactement ce qu'il paie. L'écran lui dit comment le facturer s'il
 * le veut — ajouter son adresse de chargement en dernière livraison — et le bouton
 * qui le fait est un geste de sa part, jamais un défaut.
 *
 * La coque vient de `depot-modal` : feuille basse, 88dvh, safe-area, fermeture 44×44.
 * Les sept modales du dépôt la partagent — c'est la duplication qui avait cassé
 * mission-dialog.
 */

type Etape = 'trajet' | 'marchandise' | 'creneau' | 'devis' | 'envoi';

const ETAPES: Array<{ clef: Etape; nom: string }> = [
  { clef: 'trajet', nom: 'Trajet' },
  { clef: 'marchandise', nom: 'Marchandise' },
  { clef: 'creneau', nom: 'Créneau' },
  { clef: 'devis', nom: 'Devis' },
  { clef: 'envoi', nom: 'Envoi' },
];

interface Arret {
  label: string;
  /** Kilomètres depuis l'arrêt précédent. `null` sur le chargement : il n'en a pas. */
  km: number | null;
}

const MESSAGE_MAX = 600;

@Component({
  selector: 'app-depot-request-modal',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, DepotModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-depot-modal
      titre="Demander une mission"
      [sousTitre]="sousTitre()"
      (fermer)="fermer.emit()"
    >
      @if (chargementGrille()) {
        <div class="drm-sk">@for (i of [1,2,3]; track i) { <div class="sk drm-sk-l"></div> }</div>
      } @else if (!grilleUtilisable()) {
        <!-- Arbitrage J : sans tarif a presenter, la demande n'a pas d'objet. On le dit,
             et on ne laisse pas saisir dix adresses pour rien. -->
        <div class="drm-ferme">
          <lucide-icon [img]="TriangleAlert" [size]="20" aria-hidden="true" />
          <div>
            <p class="drm-ferme-t">Les demandes ne sont pas ouvertes</p>
            <p class="drm-ferme-s">{{ motifFermeture() }}</p>
          </div>
        </div>
      } @else {
        <!-- ═══ LA PROGRESSION ═══════════════════════════════════════════════ -->
        <ol class="drm-jauge" [attr.aria-label]="'Étape ' + (rang() + 1) + ' sur ' + etapes.length">
          @for (e of etapes; track e.clef; let i = $index) {
            <!-- Le nom est porte par un aria-label sur le <li>, PAS seulement par le
                 <span> : celui-ci passe en display:none sous 767 px, ou il disparait
                 aussi de l'arbre d'accessibilite. Sans l'attribut, un lecteur d'ecran
                 sur telephone n'annoncerait que « element 2 sur 5 ». -->
            <li
              class="drm-seg"
              [class.drm-seg--faite]="i < rang()"
              [class.drm-seg--ici]="i === rang()"
              [attr.aria-label]="e.nom"
              [attr.aria-current]="i === rang() ? 'step' : null"
            ><span class="drm-seg-n">{{ e.nom }}</span></li>
          }
        </ol>

        <!-- ═══ 1. TRAJET ════════════════════════════════════════════════════ -->
        @if (etape() === 'trajet') {
          <p class="drm-intro">
            Une adresse de chargement, puis vos livraisons dans l'ordre de passage.
            Indiquez les kilomètres de chaque segment : c'est ce qui détermine le tarif.
          </p>

          <div class="drm-arret drm-arret--charge">
            <span class="drm-puce drm-puce--charge">Chargement</span>
            <input
              type="text"
              class="drm-champ"
              [ngModel]="arrets()[0].label"
              (ngModelChange)="majLabel(0, $event)"
              placeholder="Adresse de chargement"
              aria-label="Adresse de chargement"
            />
          </div>

          @for (a of arrets(); track $index; let i = $index) {
            @if (i > 0) {
              <div class="drm-arret">
                <div class="drm-arret-tete">
                  <span class="drm-puce">Livraison {{ i }}</span>
                  <div class="drm-outils">
                    <button
                      type="button" class="drm-outil"
                      [disabled]="i === 1"
                      (click)="monter(i)"
                      [attr.aria-label]="'Remonter la livraison ' + i"
                    ><lucide-icon [img]="ArrowUp" [size]="15" /></button>
                    <button
                      type="button" class="drm-outil"
                      [disabled]="i === arrets().length - 1"
                      (click)="descendre(i)"
                      [attr.aria-label]="'Descendre la livraison ' + i"
                    ><lucide-icon [img]="ArrowDown" [size]="15" /></button>
                    <button
                      type="button" class="drm-outil"
                      [disabled]="arrets().length <= 2"
                      (click)="retirer(i)"
                      [attr.aria-label]="'Retirer la livraison ' + i"
                    ><lucide-icon [img]="Trash2" [size]="15" /></button>
                  </div>
                </div>
                <input
                  type="text"
                  class="drm-champ"
                  [ngModel]="a.label"
                  (ngModelChange)="majLabel(i, $event)"
                  placeholder="Adresse de livraison"
                  [attr.aria-label]="'Adresse de la livraison ' + i"
                />
                <label class="drm-km">
                  <span>Depuis {{ resume(arrets()[i - 1].label, 'le point précédent') }}</span>
                  <span class="drm-km-saisie">
                    <input
                      type="number" min="0" step="1" inputmode="numeric"
                      [ngModel]="a.km"
                      (ngModelChange)="majKm(i, $event)"
                      [attr.aria-label]="'Kilomètres du segment vers la livraison ' + i"
                    />
                    <em>km</em>
                  </span>
                </label>
              </div>
            }
          }

          <div class="drm-ajouts">
            <button type="button" class="drm-btn" (click)="ajouter()">
              <lucide-icon [img]="Plus" [size]="15" /> Ajouter une livraison
            </button>
            <button
              type="button" class="drm-btn"
              [disabled]="!arrets()[0].label.trim()"
              (click)="ajouterRetour()"
            >
              <lucide-icon [img]="RotateCcw" [size]="15" /> Ajouter le retour
            </button>
          </div>

          <!-- Arbitrage H, dit a l'ecran plutot que subi sur la facture. -->
          <p class="drm-aide">
            Le retour au dépôt n'est jamais compté d'office. Pour le faire facturer,
            ajoutez votre adresse de chargement comme dernière livraison.
          </p>
        }

        <!-- ═══ 2. MARCHANDISE ═══════════════════════════════════════════════ -->
        @if (etape() === 'marchandise') {
          <p class="drm-intro">
            Ce que vous faites transporter. Ces précisions n'entrent pas dans le prix,
            mais elles évitent au transporteur de vous rappeler pour les demander.
          </p>
          <label class="drm-label" for="drm-marchandise">Nature de la marchandise</label>
          <textarea
            id="drm-marchandise" class="drm-champ drm-texte" rows="3"
            [(ngModel)]="marchandise"
            placeholder="Palettes, colis fragiles, matériel de chantier…"
          ></textarea>
          <label class="drm-label" for="drm-poids">Poids total (facultatif)</label>
          <span class="drm-km-saisie drm-km-saisie--seule">
            <input id="drm-poids" type="number" min="0" step="1" inputmode="numeric" [(ngModel)]="poids" />
            <em>kg</em>
          </span>
        }

        <!-- ═══ 3. CRÉNEAU ═══════════════════════════════════════════════════ -->
        @if (etape() === 'creneau') {
          <p class="drm-intro">
            La fenêtre que vous souhaitez. Ce n'est pas une réservation : le
            transporteur peut la discuter en vous répondant.
          </p>
          <label class="drm-label" for="drm-debut">Au plus tôt</label>
          <input id="drm-debut" type="datetime-local" class="drm-champ" [(ngModel)]="debut" />
          <label class="drm-label" for="drm-fin">Au plus tard</label>
          <input id="drm-fin" type="datetime-local" class="drm-champ" [(ngModel)]="fin" />
          @if (debut && fin && !creneauValide()) {
            <p class="drm-erreur">L'heure de fin doit suivre l'heure de départ.</p>
          }
        }

        <!-- ═══ 4. DEVIS ═════════════════════════════════════════════════════ -->
        @if (etape() === 'devis') {
          <p class="drm-intro">
            Calculé sur la grille de votre transporteur. C'est une proposition : il
            peut l'accepter, la discuter, ou vous en proposer une autre.
          </p>

          <div class="drm-segs">
            @for (s of segments(); track $index) {
              <div class="drm-seg-l">
                <span>{{ resume(s.de, 'Chargement') }} → {{ resume(s.vers, 'Livraison') }}</span>
                <strong>{{ s.km ?? 0 }} km</strong>
              </div>
            }
            <div class="drm-seg-l drm-seg-l--total">
              <span>Distance totale</span>
              <strong>{{ distanceTotale() }} km</strong>
            </div>
          </div>

          @switch (devis().statut) {
            @case ('TARIF') {
              @if (devisTarif(); as d) {
                <div class="drm-devis">
                  <p class="drm-devis-tr">Tranche {{ d.trancheLibelle }}</p>
                  <p class="drm-devis-ttc">{{ montant(d.ttcCents) }} <em>TTC</em></p>
                  <p class="drm-devis-ht">{{ montant(d.htCents) }} HT · TVA {{ montant(d.tvaCents) }}</p>
                </div>
                @if (d.borne; as b) {
                  <!-- L'avertissement qui evite l'appel « pourquoi le double pour 2 km ». -->
                  <p class="drm-borne">
                    <lucide-icon [img]="TriangleAlert" [size]="15" aria-hidden="true" />
                    <span>
                      {{ b.kmAvant }} km de plus feraient passer à
                      <strong>{{ b.suivantCents === null ? 'un tarif sur devis' : montant(b.suivantCents) }}</strong>
                      au lieu de <strong>{{ montant(d.htCents) }}</strong> HT.
                    </span>
                  </p>
                }
              }
            }
            @case ('SUR_DEVIS') {
              @if (devisSurDevis(); as d) {
                <div class="drm-devis drm-devis--attente">
                  <p class="drm-devis-tr">Sur devis</p>
                  <p class="drm-devis-ht">{{ d.motif }} Votre demande partira sans montant.</p>
                </div>
              }
            }
            @default {
              <div class="drm-devis drm-devis--attente">
                <p class="drm-devis-ht">{{ motifSansTarif() }}</p>
              </div>
            }
          }
        }

        <!-- ═══ 5. ENVOI ═════════════════════════════════════════════════════ -->
        @if (etape() === 'envoi') {
          <p class="drm-intro">
            Relisez, ajoutez un mot si besoin, et envoyez. Votre transporteur reçoit un
            e-mail et vous répond depuis son espace.
          </p>
          <dl class="drm-recap">
            <div><dt>Trajet</dt><dd>{{ recapTrajet() }}</dd></div>
            <div><dt>Distance</dt><dd>{{ distanceTotale() }} km</dd></div>
            <div><dt>Créneau</dt><dd>{{ recapCreneau() }}</dd></div>
            <div><dt>Marchandise</dt><dd>{{ marchandise.trim() || 'Non précisée' }}</dd></div>
            <div><dt>Devis</dt><dd>{{ recapDevis() }}</dd></div>
          </dl>
          <label class="drm-label" for="drm-message">Un mot pour le transporteur (facultatif)</label>
          <textarea
            id="drm-message" class="drm-champ drm-texte" rows="3" maxlength="600"
            [(ngModel)]="message"
            placeholder="Contraintes de quai, horaires stricts, contact sur place…"
          ></textarea>
          <p class="drm-compteur">{{ message.length }} / {{ MESSAGE_MAX }}</p>
        }

        <!-- ═══ LE BANDEAU DE DEVIS, PRÉSENT DÈS LA PREMIÈRE LIVRAISON ═══════ -->
        @if (etape() !== 'devis' && distanceTotale() > 0) {
          <p class="drm-bandeau">
            <span>{{ distanceTotale() }} km</span>
            <strong>{{ bandeauMontant() }}</strong>
          </p>
        }
      }

      <footer pied class="drm-pied">
        @if (grilleUtilisable() && !chargementGrille()) {
          @if (rang() > 0) {
            <button type="button" class="drm-btn" (click)="precedent()">Précédent</button>
          }
          @if (etape() !== 'envoi') {
            <button
              type="button" class="drm-btn drm-btn--accent"
              [disabled]="!etapeValide()"
              (click)="suivant()"
            >Continuer</button>
          } @else {
            <button
              type="button" class="drm-btn drm-btn--accent"
              [disabled]="envoi() || !toutValide()"
              (click)="envoyer()"
            >{{ envoi() ? 'Envoi…' : 'Envoyer la demande' }}</button>
          }
        } @else {
          <button type="button" class="drm-btn" (click)="fermer.emit()">Fermer</button>
        }
      </footer>
    </app-depot-modal>
  `,
  styles: [`
    /* ─── Progression ──────────────────────────────────────────────────────── */
    .drm-jauge { display: flex; gap: 5px; margin: 0 0 16px; padding: 0; list-style: none }
    .drm-seg { flex: 1; min-width: 0 }
    .drm-seg::before {
      content: ''; display: block; height: 4px; border-radius: 9999px;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
    }
    .drm-seg--faite::before, .drm-seg--ici::before {
      background: var(--color-tracky-light); border-color: transparent;
    }
    .drm-seg-n {
      display: block; margin-top: 6px; font-size: 10.5px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .04em;
      color: var(--depot-attenue); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .drm-seg--ici .drm-seg-n { color: var(--text-primary) }

    .drm-intro { margin: 0 0 14px; font-size: 12.5px; line-height: 1.6; color: var(--text-secondary) }
    .drm-aide { margin: 12px 0 0; font-size: 12px; line-height: 1.6; color: var(--depot-attenue) }
    .drm-erreur { margin: 8px 0 0; font-size: 12.5px; color: var(--texte-alerte) }
    .drm-label { display: block; margin: 16px 0 7px; font-size: 12px; font-weight: 600; color: var(--depot-attenue) }
    .drm-label:first-of-type { margin-top: 0 }

    .drm-champ {
      width: 100%; min-width: 0; min-height: 44px; padding: 10px 12px; border-radius: 11px;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
      color: var(--text-primary); font-family: inherit; font-size: 13.5px;
    }
    .drm-champ:focus { outline: 2px solid var(--violet); outline-offset: 1px }
    .drm-texte { resize: vertical; line-height: 1.55 }
    .drm-compteur { margin: 6px 0 0; text-align: right; font-size: 11px; color: var(--depot-attenue) }

    /* ─── Les arrets ───────────────────────────────────────────────────────── */
    .drm-arret {
      padding: 11px 12px; border-radius: 13px; margin-bottom: 8px;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
    }
    .drm-arret .drm-champ { background: var(--surface-secondary) }
    .drm-arret--charge { border-color: color-mix(in srgb, var(--color-tracky-light) 34%, transparent) }
    .drm-arret-tete { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px }
    .drm-puce {
      display: inline-block; margin-bottom: 8px; padding: 3px 9px; border-radius: 9999px;
      font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
      background: var(--surface-secondary); color: var(--text-secondary);
    }
    .drm-arret-tete .drm-puce { margin-bottom: 0 }
    /* --texte-succes, et NON --color-tracky-light : le vert de marque brut sur un lavis
       de lui-meme tombe a 2,71:1 en theme clair. Le jeton --texte-succes existe pour ca
       — il assombrit le vert de 72 % en clair et le laisse intact en sombre. Mesure
       dans scripts/verif-contraste.mjs, section « Demande de mission ». */
    .drm-puce--charge {
      background: color-mix(in srgb, var(--color-tracky-light) 16%, transparent);
      color: var(--texte-succes);
    }
    .drm-outils { display: flex; gap: 5px; flex-shrink: 0 }
    .drm-outil {
      display: grid; place-items: center; width: 34px; height: 34px; border-radius: 9px;
      background: var(--surface-secondary); border: 1px solid var(--border-color);
      color: var(--text-secondary); cursor: pointer;
    }
    .drm-outil:hover:not(:disabled) { color: var(--text-primary) }
    .drm-outil:disabled { opacity: .35; cursor: not-allowed }

    .drm-km { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 9px }
    .drm-km > span { min-width: 0; font-size: 11.5px; color: var(--depot-attenue);
                     overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .drm-km-saisie { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0 }
    .drm-km-saisie input {
      width: 78px; min-height: 44px; padding: 8px 10px; border-radius: 10px; text-align: right;
      background: var(--surface-secondary); border: 1px solid var(--border-color);
      color: var(--text-primary); font-family: inherit; font-size: 13.5px;
    }
    .drm-km-saisie em { font-style: normal; font-size: 12px; color: var(--depot-attenue) }
    .drm-km-saisie--seule input { width: 110px }

    .drm-ajouts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px }

    /* ─── Devis ────────────────────────────────────────────────────────────── */
    .drm-segs {
      display: flex; flex-direction: column; gap: 7px; margin-bottom: 14px;
      padding: 12px 13px; border-radius: 13px;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
    }
    .drm-seg-l { display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
                 font-size: 12.5px; color: var(--text-secondary) }
    .drm-seg-l > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .drm-seg-l strong { flex-shrink: 0; color: var(--text-primary) }
    .drm-seg-l--total { padding-top: 8px; border-top: 1px solid var(--border-color); font-weight: 700 }
    .drm-seg-l--total > span { color: var(--text-primary) }

    .drm-devis {
      padding: 15px 16px; border-radius: 13px;
      background: color-mix(in srgb, var(--color-tracky-light) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--color-tracky-light) 30%, transparent);
    }
    .drm-devis--attente {
      background: color-mix(in srgb, var(--warning) 12%, transparent);
      border-color: color-mix(in srgb, var(--warning) 32%, transparent);
    }
    .drm-devis-tr { margin: 0; font-size: 11.5px; font-weight: 700; text-transform: uppercase;
                    letter-spacing: .05em; color: var(--text-secondary) }
    .drm-devis-ttc { margin: 6px 0 0; font-family: var(--font-display); font-size: 26px;
                     font-weight: 800; letter-spacing: -.02em; color: var(--text-primary) }
    .drm-devis-ttc em { font-style: normal; font-size: 13px; font-weight: 700; color: var(--text-secondary) }
    .drm-devis-ht { margin: 5px 0 0; font-size: 12.5px; line-height: 1.6; color: var(--text-secondary) }

    .drm-borne {
      display: flex; align-items: flex-start; gap: 9px; margin: 10px 0 0;
      padding: 11px 13px; border-radius: 12px; font-size: 12.5px; line-height: 1.6;
      color: var(--texte-attente);
      background: color-mix(in srgb, var(--warning) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
    }
    .drm-borne lucide-icon { flex: 0 0 auto; margin-top: 1px }
    .drm-borne strong { color: var(--text-primary) }

    /* ─── Recapitulatif ────────────────────────────────────────────────────── */
    .drm-recap { display: flex; flex-direction: column; gap: 9px; margin: 0 0 4px;
                 padding: 12px 13px; border-radius: 13px;
                 background: var(--surface-tertiary); border: 1px solid var(--border-color) }
    .drm-recap > div { display: flex; align-items: baseline; justify-content: space-between; gap: 14px }
    .drm-recap dt { flex-shrink: 0; font-size: 11.5px; font-weight: 600; color: var(--depot-attenue) }
    .drm-recap dd { margin: 0; min-width: 0; text-align: right; font-size: 12.5px;
                    line-height: 1.5; color: var(--text-primary) }

    /* ─── Bandeau permanent ────────────────────────────────────────────────── */
    .drm-bandeau {
      display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
      margin: 16px 0 0; padding: 11px 13px; border-radius: 12px;
      background: color-mix(in srgb, var(--color-tracky-light) 9%, transparent);
      border: 1px solid color-mix(in srgb, var(--color-tracky-light) 26%, transparent);
    }
    .drm-bandeau > span { font-size: 12px; color: var(--text-secondary) }
    .drm-bandeau strong { font-size: 15px; font-weight: 800; color: var(--text-primary) }

    /* ─── Demande fermee ───────────────────────────────────────────────────── */
    .drm-ferme { display: flex; align-items: flex-start; gap: 12px; padding: 16px;
                 border-radius: 13px; color: var(--texte-attente);
                 background: color-mix(in srgb, var(--warning) 10%, transparent);
                 border: 1px solid color-mix(in srgb, var(--warning) 28%, transparent) }
    .drm-ferme lucide-icon { flex: 0 0 auto; margin-top: 1px }
    .drm-ferme > div { min-width: 0 }
    .drm-ferme-t { margin: 0; font-size: 13.5px; font-weight: 700 }
    .drm-ferme-s { margin: 5px 0 0; font-size: 12.5px; line-height: 1.6; color: var(--text-secondary) }
    .drm-sk { display: flex; flex-direction: column; gap: 10px }
    .drm-sk-l { height: 54px; border-radius: 12px }

    /* ─── Pied ─────────────────────────────────────────────────────────────── */
    .drm-pied {
      flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 20px 16px; border-top: 1px solid var(--border-color);
    }
    .drm-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      min-height: 40px; padding: 9px 17px; border-radius: 11px;
      border: 1px solid var(--border-color); background: var(--surface-tertiary);
      color: var(--text-secondary); font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .drm-btn--accent { background: var(--color-tracky-light); border-color: transparent; color: var(--accent-ink) }
    .drm-btn:disabled { opacity: .5; cursor: not-allowed }

    @media (max-width: 767px) {
      /* 375 px : les cinq noms d'etapes ne tiennent plus cote a cote sans se tronquer
         en bouillie. On garde les cinq barres — la progression reste lisible — et le
         nom de l'etape courante est porte par le sous-titre de la coque. */
      .drm-seg-n { display: none }
      .drm-btn, .drm-outil { min-height: 44px }
      .drm-outil { width: 44px; height: 44px }
      .drm-pied .drm-btn { flex: 1 }
      .drm-km { flex-direction: column; align-items: stretch; gap: 6px }
      .drm-km > span { white-space: normal }
      .drm-km-saisie { justify-content: flex-end }
    }
  `],
})
export class DepotRequestModalComponent implements OnInit {
  readonly fermer = output<void>();
  /** La demande est partie : l'écran appelant peut se rafraîchir. */
  readonly envoyee = output<string>();

  private readonly api = inject(MissionRequestsApi);
  private readonly toast = inject(ToastService);

  protected readonly ArrowDown = ArrowDown;
  protected readonly ArrowUp = ArrowUp;
  protected readonly Plus = Plus;
  protected readonly RotateCcw = RotateCcw;
  protected readonly Trash2 = Trash2;
  protected readonly TriangleAlert = TriangleAlert;
  protected readonly etapes = ETAPES;
  protected readonly MESSAGE_MAX = MESSAGE_MAX;

  protected readonly chargementGrille = signal(true);
  protected readonly grille = signal<GrilleTarifaire | null>(null);
  /**
   * Le compte n'a pas la capacité de demander (`missions_request`).
   *
   * ⚠️ DISTINCT DE « PAS DE GRILLE », ET IL FAUT QUE ÇA LE RESTE. Les deux referment
   * l'écran, mais la cause n'est pas la même et le geste de sortie non plus : sans
   * grille, le dépôt appelle son transporteur ; sans permission, c'est SON compte qu'il
   * faut rouvrir. Confondre les deux enverrait le dépôt réclamer des tarifs qui
   * existent déjà — et le transporteur chercherait longtemps ce qu'on lui reproche.
   */
  protected readonly sansPermission = signal(false);
  protected readonly etape = signal<Etape>('trajet');
  protected readonly envoi = signal(false);

  /** Un chargement, une livraison : le minimum que le serveur accepte. */
  protected readonly arrets = signal<Arret[]>([
    { label: '', km: null },
    { label: '', km: null },
  ]);

  protected marchandise = '';
  protected poids: number | null = null;
  protected debut = '';
  protected fin = '';
  protected message = '';

  // ═══ ÉTAT DÉRIVÉ ═══════════════════════════════════════════════════════════

  protected readonly rang = computed(() => ETAPES.findIndex((e) => e.clef === this.etape()));

  protected readonly sousTitre = computed(() => {
    if (this.chargementGrille() || !this.grilleUtilisable()) return null;
    const e = ETAPES[this.rang()];
    return `Étape ${this.rang() + 1} sur ${ETAPES.length} · ${e.nom}`;
  });

  /**
   * Sans grille ACTIVE, la demande n'a pas d'objet (arbitrage J). On le vérifie ici et
   * pas seulement au serveur : celui-ci refuserait, mais après dix adresses saisies.
   */
  protected readonly grilleUtilisable = computed(() => {
    if (this.sansPermission()) return false;
    const g = this.grille();
    return !!g && g.enabled && g.tiers.length > 0;
  });

  /** Pourquoi l'écran est fermé — et donc à qui s'adresser pour le rouvrir. */
  protected readonly motifFermeture = computed(() =>
    this.sansPermission()
      ? 'Votre compte ne porte pas encore la capacité de demander une mission. Votre transporteur peut vous l\'ouvrir depuis la fiche de votre compte.'
      : 'Votre transporteur n\'a pas encore publié ses tarifs. Appelez-le : il lui suffit d\'activer sa grille tarifaire pour que vous puissiez demander une mission.',
  );

  /**
   * La distance est la SOMME DES SEGMENTS, dans l'ordre saisi. Le retour n'en fait
   * partie que si le dépôt a ajouté l'adresse de chargement en dernière livraison —
   * aucun segment fantôme (arbitrage H).
   */
  protected readonly distanceTotale = computed(() =>
    this.arrets()
      .slice(1)
      .reduce((somme, a) => somme + (a.km && a.km > 0 ? a.km : 0), 0),
  );

  protected readonly segments = computed(() =>
    this.arrets()
      .slice(1)
      .map((a, i) => ({ de: this.arrets()[i].label, vers: a.label, km: a.km })),
  );

  protected readonly devis = computed(() => calculerDevis(this.distanceTotale(), this.grille()));

  /**
   * Trois accesseurs plutôt qu'un transtypage dans le gabarit : Angular ne réduit pas
   * une union sur un `@switch`, et un `$any()` ferait taire le compilateur au lieu de
   * le laisser vérifier les champs affichés.
   */
  protected readonly devisTarif = computed(() => {
    const d = this.devis();
    return d.statut === 'TARIF' ? d : null;
  });

  protected readonly devisSurDevis = computed(() => {
    const d = this.devis();
    return d.statut === 'SUR_DEVIS' ? d : null;
  });

  protected readonly motifSansTarif = computed(() => {
    const d = this.devis();
    return d.statut === 'PAS_DE_GRILLE' ? d.motif : '';
  });

  protected readonly trajetValide = computed(() => {
    const a = this.arrets();
    if (a.length < 2) return false;
    if (!a[0].label.trim()) return false;
    // Chaque livraison porte une adresse ET son segment : sans les kilomètres, il n'y
    // a pas de devis, et une demande sans devis n'a pas d'objet.
    return a.slice(1).every((x) => !!x.label.trim() && !!x.km && x.km > 0);
  });

  /**
   * ⚠️ DES MÉTHODES, PAS DES `computed()`, ET C'EST OBLIGATOIRE ICI.
   *
   * `debut` et `fin` sont des champs simples liés par `[(ngModel)]`, pas des signaux.
   * Un `computed()` ne suit que les signaux qu'il lit : il aurait mémorisé le résultat
   * du premier calcul — « créneau invalide » — et ne l'aurait plus jamais révisé. Le
   * bouton « Continuer » serait resté grisé quoi que le dépôt saisisse, sans le moindre
   * message pour l'expliquer.
   *
   * Une méthode est réévaluée à chaque cycle de détection, et `ngModelChange` en
   * déclenche un à chaque frappe — y compris sous `OnPush`.
   */
  protected creneauValide(): boolean {
    return !!this.debut && !!this.fin && new Date(this.fin) > new Date(this.debut);
  }

  protected etapeValide(): boolean {
    switch (this.etape()) {
      case 'trajet':
        return this.trajetValide();
      case 'creneau':
        return this.creneauValide();
      default:
        return true;
    }
  }

  protected toutValide(): boolean {
    return this.trajetValide() && this.creneauValide();
  }

  // ═══ CYCLE DE VIE ══════════════════════════════════════════════════════════

  async ngOnInit(): Promise<void> {
    try {
      this.grille.set(await this.api.grille());
    } catch (err) {
      swallow('depot-request-modal:grille', err);
      // 403 = le compte ne porte pas `missions_request`. Le cas n'est pas theorique :
      // c'est la premiere capacite d'ecriture jamais accordee au role DEPOT, et un
      // compte cree avant elle porte un jeu de permissions ou la cle est simplement
      // ABSENTE — le resolveur lit `perms[cle] === true` et refuse. L'ecran doit dire
      // que c'est le COMPTE qui est fermé, pas les tarifs qui manquent.
      this.sansPermission.set((err as { status?: number })?.status === 403);
      this.grille.set(null);
    } finally {
      this.chargementGrille.set(false);
    }
  }

  // ═══ LES ARRÊTS ════════════════════════════════════════════════════════════

  protected majLabel(i: number, valeur: string): void {
    this.arrets.update((liste) => liste.map((a, j) => (j === i ? { ...a, label: valeur } : a)));
  }

  protected majKm(i: number, valeur: unknown): void {
    const n = valeur === '' || valeur === null || valeur === undefined ? null : Number(valeur);
    this.arrets.update((liste) =>
      liste.map((a, j) => (j === i ? { ...a, km: Number.isFinite(n as number) ? n : null } : a)),
    );
  }

  protected ajouter(): void {
    this.arrets.update((liste) => [...liste, { label: '', km: null }]);
  }

  /**
   * Le retour, AJOUTÉ PAR LE DÉPÔT et jamais d'office (arbitrage H).
   *
   * Le bouton ne fait que recopier l'adresse de chargement en dernière livraison —
   * exactement le geste que le § 7bis demande d'expliquer. Ses kilomètres restent à
   * saisir : personne d'autre que le dépôt ne connaît son trajet de retour.
   */
  protected ajouterRetour(): void {
    const depart = this.arrets()[0].label.trim();
    if (!depart) return;
    this.arrets.update((liste) => [...liste, { label: depart, km: null }]);
  }

  /** On ne retire jamais la dernière livraison : il en faut au moins une. */
  protected retirer(i: number): void {
    if (i === 0 || this.arrets().length <= 2) return;
    this.arrets.update((liste) => liste.filter((_, j) => j !== i));
  }

  /**
   * ⚠️ LA POSITION 0 EST INTOUCHABLE. Le serveur fait du premier arrêt le PICKUP :
   * remonter une livraison au rang 0 transformerait silencieusement une adresse de
   * livraison en adresse de chargement. L'adresse de chargement est fixe (arbitrage B),
   * et les livraisons se réordonnent entre elles.
   */
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

  // ═══ NAVIGATION ════════════════════════════════════════════════════════════

  protected suivant(): void {
    if (!this.etapeValide()) return;
    const prochain = ETAPES[this.rang() + 1];
    if (prochain) this.etape.set(prochain.clef);
  }

  protected precedent(): void {
    const avant = ETAPES[this.rang() - 1];
    if (avant) this.etape.set(avant.clef);
  }

  // ═══ AFFICHAGE ═════════════════════════════════════════════════════════════

  protected montant(cents: number): string {
    return euros(cents);
  }

  /** Une adresse longue tronquée pour un libellé de segment, avec un repli lisible. */
  protected resume(label: string, defaut: string): string {
    const propre = (label ?? '').trim();
    if (!propre) return defaut;
    return propre.length > 28 ? `${propre.slice(0, 27)}…` : propre;
  }

  protected bandeauMontant(): string {
    const d = this.devis();
    if (d.statut === 'TARIF') return `${euros(d.ttcCents)} TTC`;
    if (d.statut === 'SUR_DEVIS') return 'Sur devis';
    return '—';
  }

  protected recapTrajet(): string {
    const a = this.arrets();
    const livraisons = a.length - 1;
    const base = `${this.resume(a[0].label, 'Chargement')} → ${this.resume(a[a.length - 1].label, 'Livraison')}`;
    return livraisons > 1 ? `${base} (${livraisons} livraisons)` : base;
  }

  protected recapCreneau(): string {
    if (!this.creneauValide()) return 'À compléter';
    const f = (v: string) =>
      new Date(v).toLocaleString('fr-FR', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      });
    return `${f(this.debut)} → ${f(this.fin)}`;
  }

  protected recapDevis(): string {
    const d = this.devis();
    if (d.statut === 'TARIF') return `${euros(d.ttcCents)} TTC (${euros(d.htCents)} HT)`;
    if (d.statut === 'SUR_DEVIS') return 'Sur devis — le transporteur chiffrera';
    return 'Indisponible';
  }

  // ═══ ENVOI ═════════════════════════════════════════════════════════════════

  protected async envoyer(): Promise<void> {
    if (!this.toutValide() || this.envoi()) return;
    this.envoi.set(true);
    try {
      const demande = await this.api.creer({
        stops: this.arrets().map((a) => ({ label: a.label.trim() })),
        wantedStartAt: new Date(this.debut).toISOString(),
        wantedEndAt: new Date(this.fin).toISOString(),
        goodsDescription: this.marchandise.trim() || null,
        weightKg: this.poids && this.poids > 0 ? Math.round(this.poids) : null,
        // La distance DÉCLARÉE, en kilomètres : le serveur la convertit en mètres
        // entiers. Elle est la somme des segments — le retour n'y figure que si le
        // dépôt l'a ajouté.
        declaredDistanceKm: this.distanceTotale(),
        message: this.message.trim() || null,
      });
      this.toast.show({
        kind: 'success',
        title: `Demande ${demande.ref} envoyée`,
        // On dit ce qui se passe ensuite : une demande dont on ignore le sort se
        // re-pose par téléphone dix minutes plus tard.
        message:
          demande.currentAmountCents === null
            ? 'Votre transporteur va la chiffrer et vous répondre.'
            : 'Votre transporteur l\'a reçue avec son devis. Il accepte, refuse ou vous répond.',
      });
      this.envoyee.emit(demande.id);
      this.fermer.emit();
    } catch (err) {
      swallow('depot-request-modal:envoyer', err);
      const brut = (err as { error?: { message?: unknown } })?.error?.message;
      this.toast.show({
        kind: 'error',
        title: 'Demande non envoyée',
        // Le message du SERVEUR d'abord : il nomme l'adresse ou la date en cause.
        message:
          typeof brut === 'string' && brut.trim()
            ? brut
            : 'La demande n\'a pas pu être transmise. Réessayez dans un instant.',
      });
    } finally {
      this.envoi.set(false);
    }
  }
}
