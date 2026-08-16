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
import { Check, LucideAngularModule, MessageSquare, TriangleAlert, X } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import {
  aLaMain,
  estNegociable,
  libelleStatut,
  montantEuros,
  tonStatut,
  MissionRequestsApi,
  type Camp,
  type Demande,
  type DetailDevis,
  type TourDemande,
} from '../../core/services/mission-requests.api';
import { calculerDevis, type GrilleTarifaire } from '../../features/depot/devis-tarifaire';
import { ToastService } from '../ui/toast/toast.service';

/**
 * Espace dépôt, lot A6 — LE FIL DE NÉGOCIATION, vu des deux côtés de la table.
 * Cf. docs/A6-DEMANDES-ET-DEVIS.md § 6 et § 7bis.
 *
 * ┌─ UN SEUL COMPOSANT POUR LES DEUX CAMPS, ET C'EST LA DÉCISION CENTRALE ────┐
 * │ Le dépôt et le transporteur négocient sur le MÊME objet. Deux écrans      │
 * │ auraient divergé dès la première retouche — un montant arrondi ici, une   │
 * │ date formatée là — et les deux parties auraient fini par lire deux        │
 * │ versions du même fil. Une négociation où chacun voit autre chose n'est    │
 * │ pas une négociation : c'est un malentendu qui finit au téléphone.         │
 * │                                                                            │
 * │ Ce qui change d'un camp à l'autre n'est PAS la structure, ce sont les      │
 * │ MOTS : « votre transporteur » d'un côté, « le dépôt » de l'autre. Un seul  │
 * │ endroit les décide — `nomDe()`.                                            │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ QUI PEUT AGIR, ET QUAND ─────────────────────────────────────────────────┐
 * │ Les deux parties accèdent au fil TANT QUE L'ACCORD N'EST PAS CONCLU DES   │
 * │ DEUX CÔTÉS. Concrètement :                                                │
 * │                                                                            │
 * │  · `SUBMITTED` / `NEGOTIATING` → celui dont c'est le tour agit ; l'autre  │
 * │    lit et voit qu'on l'attend.                                            │
 * │  · `ACCEPTED` → plus personne ne négocie. L'accord porte sur une version   │
 * │    précise ; laisser contre-proposer permettrait de revenir sur un montant │
 * │    que l'autre a déjà accepté. Le fil reste CONSULTABLE des deux côtés —   │
 * │    le dépôt doit pouvoir relire ce sur quoi il s'est engagé.               │
 * │  · `CONVERTED` / `REJECTED` / `EXPIRED` → lecture seule, avec l'issue.     │
 * │                                                                            │
 * │ ⚠️ ON NE RÉPOND JAMAIS À SOI-MÊME. Le serveur le refuse ; l'écran ne doit  │
 * │ donc pas le proposer, sinon il promet un geste qui échouera.               │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

type Volet = 'aucun' | 'contre' | 'refus';

@Component({
  selector: 'app-mission-request-thread',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- ═══ L'ÉTAT, EN PREMIER ══════════════════════════════════════════════ -->
    <div class="mrt-etat" [class]="'mrt-etat--' + ton()">
      <div class="mrt-etat-l">
        <span class="mrt-badge">{{ statutLisible() }}</span>
        <strong>{{ demande().ref }}</strong>
      </div>
      <p class="mrt-etat-p">{{ phraseEtat() }}</p>
    </div>

    <!-- ═══ CE SUR QUOI ON NÉGOCIE ══════════════════════════════════════════ -->
    <section class="mrt-bloc">
      <h3 class="mrt-titre">Le trajet</h3>
      <ol class="mrt-arrets">
        @for (a of demande().stops; track a.position; let i = $index) {
          <li>
            <span class="mrt-puce" [class.mrt-puce--charge]="i === 0">
              {{ i === 0 ? 'Chargement' : 'Livraison ' + i }}
            </span>
            <span class="mrt-arret-l">{{ a.label }}</span>
          </li>
        }
      </ol>
      <dl class="mrt-faits">
        <div><dt>Créneau souhaité</dt><dd>{{ creneau() }}</dd></div>
        <div><dt>Marchandise</dt><dd>{{ demande().goodsDescription || 'Non précisée' }}</dd></div>
        @if (demande().weightKg) { <div><dt>Poids</dt><dd>{{ demande().weightKg }} kg</dd></div> }
      </dl>
    </section>

    <!-- ═══ LES DISTANCES ═══════════════════════════════════════════════════ -->
    <section class="mrt-bloc">
      <h3 class="mrt-titre">Les distances</h3>
      <dl class="mrt-faits">
        <div><dt>Annoncée par {{ nomDe('DEPOT') }}</dt><dd>{{ km(demande().declaredDistanceKm) }}</dd></div>
        <div><dt>Retenue pour le devis</dt><dd><strong>{{ km(demande().usedDistanceKm) }}</strong></dd></div>
      </dl>
      <!-- Q3, tranchée le 2026-08-14 : aucun service de routage n'est branché. Un vol
           d'oiseau n'est pas une distance routiere — 20 a 40 % d'ecart, de quoi changer
           de tranche et donc de prix. On le DIT plutot que d'afficher un chiffre faux. -->
      <p class="mrt-aide">
        Aucune estimation automatique : le calcul d'itinéraire n'est pas branché, et une
        distance à vol d'oiseau ferait changer de tranche. C'est donc la distance
        annoncée qui sert, jusqu'à correction.
      </p>
    </section>

    <!-- ═══ LE DEVIS COURANT, TEL QU'IL EST FIGÉ ════════════════════════════ -->
    @if (devisCourant(); as d) {
      <section class="mrt-bloc mrt-bloc--devis">
        <h3 class="mrt-titre">Le devis sur la table</h3>
        @if (d.statut === 'TARIF') {
          @if (d.lignes; as lignes) {
            <dl class="mrt-faits">
              @for (l of lignes; track $index) {
                <div><dt>{{ l.libelle }}</dt><dd>{{ euros(l.montantCents) }}</dd></div>
              }
              <div><dt>Total HT</dt><dd>{{ euros(d.htCents ?? 0) }}</dd></div>
              <div><dt>TVA</dt><dd>{{ euros(d.tvaCents ?? 0) }}</dd></div>
            </dl>
          }
          <p class="mrt-ttc">{{ euros(d.ttcCents ?? 0) }} <em>TTC</em></p>
        } @else {
          <p class="mrt-aide">{{ d.motif || 'Aucun montant calculé.' }}</p>
        }
        @if (montantCourant() !== null && montantAjuste()) {
          <!-- Le montant du tour prime sur le calcul : une contre-proposition est
               ajustable (arbitrage I), et c'est ELLE qui engage. -->
          <p class="mrt-aide">
            Montant proposé au dernier tour : <strong>{{ euros(montantCourant()!) }} HT</strong> —
            ajusté par rapport au tarif calculé.
          </p>
        }
        @if (demande().quoteExpiresAt && estNegociableIci()) {
          <p class="mrt-aide">Ce devis est valable jusqu'au {{ echeance() }}.</p>
        }
      </section>
    }

    <!-- ═══ LE FIL ══════════════════════════════════════════════════════════ -->
    <section class="mrt-bloc">
      <h3 class="mrt-titre">
        <lucide-icon [img]="MessageSquare" [size]="15" aria-hidden="true" />
        Les échanges
      </h3>
      <ol class="mrt-fil">
        @for (t of demande().rounds; track t.position) {
          <li class="mrt-tour" [class.mrt-tour--moi]="t.author === camp()">
            <div class="mrt-tour-tete">
              <span class="mrt-auteur">{{ nomDe(t.author) }}</span>
              <span class="mrt-quand">{{ quand(t.createdAt) }}</span>
            </div>
            <p class="mrt-tour-m">
              <strong>{{ euros2(t.amountCents) }}</strong>
              @if (t.amountCents !== null) { <em>HT</em> }
            </p>
            @if (t.message) { <p class="mrt-tour-t">{{ t.message }}</p> }
          </li>
        }
      </ol>
    </section>

    <!-- ═══ CE QU'ON PEUT FAIRE ═════════════════════════════════════════════ -->
    @if (jePeuxAgir()) {
      @if (volet() === 'contre') {
        <section class="mrt-bloc mrt-bloc--action">
          <h3 class="mrt-titre">Votre contre-proposition</h3>
          <p class="mrt-aide">
            Vous pouvez corriger la distance retenue : le tarif se recalcule, puis reste
            ajustable. C'est votre montant qui fait foi.
          </p>
          <div class="mrt-champs">
            <label class="mrt-champ">
              <span>Distance retenue</span>
              <span class="mrt-unite">
                <input type="number" min="0" step="1" inputmode="numeric"
                       [ngModel]="distance" (ngModelChange)="majDistance($event)" />
                <em>km</em>
              </span>
            </label>
            <label class="mrt-champ">
              <span>Votre montant HT</span>
              <span class="mrt-unite">
                <input type="number" min="0" step="1" inputmode="decimal" [(ngModel)]="montant" />
                <em>€</em>
              </span>
            </label>
          </div>
          @if (tarifRecalcule(); as t) {
            <p class="mrt-aide">
              Sur {{ distance }} km, votre grille donne <strong>{{ t }}</strong>.
            </p>
          }
          <label class="mrt-label" for="mrt-msg">Un mot (facultatif)</label>
          <textarea id="mrt-msg" class="mrt-texte" rows="3" maxlength="600"
                    [(ngModel)]="message"
                    placeholder="Ce qui justifie votre proposition."></textarea>
          <div class="mrt-actions">
            <button type="button" class="mrt-btn" (click)="volet.set('aucun')">Annuler</button>
            <button type="button" class="mrt-btn mrt-btn--accent"
                    [disabled]="envoi() || montant === null || montant < 0"
                    (click)="contreProposer()">
              {{ envoi() ? 'Envoi…' : 'Envoyer la proposition' }}
            </button>
          </div>
        </section>
      } @else if (volet() === 'refus') {
        <section class="mrt-bloc mrt-bloc--action">
          <h3 class="mrt-titre">Refuser cette demande</h3>
          <!-- Motif OBLIGATOIRE : sans lui, l'autre partie repose la meme demande. -->
          <p class="mrt-aide">
            Le motif est obligatoire. Sans lui, {{ nomDe(autreCamp()) }} reposera la même
            demande sans savoir ce qui n'allait pas.
          </p>
          <label class="mrt-label" for="mrt-motif">Motif du refus</label>
          <textarea id="mrt-motif" class="mrt-texte" rows="3" maxlength="600"
                    [(ngModel)]="motif"
                    placeholder="Aucun camion disponible sur ce créneau…"></textarea>
          <div class="mrt-actions">
            <button type="button" class="mrt-btn" (click)="volet.set('aucun')">Annuler</button>
            <button type="button" class="mrt-btn mrt-btn--danger"
                    [disabled]="envoi() || motif.trim().length < 3"
                    (click)="refuser()">
              {{ envoi() ? 'Envoi…' : 'Refuser' }}
            </button>
          </div>
        </section>
      } @else {
        <div class="mrt-actions mrt-actions--principales">
          <button type="button" class="mrt-btn mrt-btn--danger" (click)="ouvrirRefus()">
            <lucide-icon [img]="X" [size]="15" aria-hidden="true" /> Refuser
          </button>
          <button type="button" class="mrt-btn" (click)="ouvrirContre()">Contre-proposer</button>
          <!-- Une offre « sur devis » ne s'accepte pas : il n'y a rien a accepter. -->
          @if (montantCourant() !== null) {
            <button type="button" class="mrt-btn mrt-btn--accent"
                    [disabled]="envoi()" (click)="accepter()">
              <lucide-icon [img]="Check" [size]="15" aria-hidden="true" />
              Accepter {{ euros(montantCourant()!) }}
            </button>
          }
        </div>
      }
    } @else if (estNegociableIci()) {
      <p class="mrt-attente">
        <lucide-icon [img]="TriangleAlert" [size]="15" aria-hidden="true" />
        <span>La balle est dans le camp {{ deQui(demande().awaiting) }}. Vous serez prévenu par e-mail.</span>
      </p>
    }
  `,
  styles: [`
    /* ⚠️ AUCUN JETON --depot-* ICI. Ils sont definis sous .layout--depot et n'existent
       PAS dans l'espace transporteur : une couleur declaree avec une variable absente
       retombe sur la valeur heritee, donc sur du texte principal la ou on voulait de
       l'attenue — invisible en relecture, et invisible aussi de la garde des contrastes,
       qui mesure le jeton et non ce que le navigateur finit par appliquer. Ce composant
       vit des DEUX cotes : il ne consomme que des jetons globaux. */
    :host { display: block }

    .mrt-etat { padding: 12px 14px; border-radius: 13px; margin-bottom: 14px;
                border: 1px solid var(--border-color); background: var(--surface-tertiary) }
    .mrt-etat-l { display: flex; align-items: center; gap: 10px; flex-wrap: wrap }
    .mrt-etat-l strong { font-family: var(--font-display); font-size: 15px; color: var(--text-primary) }
    .mrt-badge { padding: 3px 10px; border-radius: 9999px; font-size: 11px; font-weight: 700;
                 text-transform: uppercase; letter-spacing: .05em;
                 background: var(--surface-secondary); color: var(--text-secondary) }
    .mrt-etat-p { margin: 7px 0 0; font-size: 12.5px; line-height: 1.6; color: var(--text-secondary) }
    .mrt-etat--succes { border-color: color-mix(in srgb, var(--color-tracky-light) 30%, transparent);
                        background: color-mix(in srgb, var(--color-tracky-light) 10%, transparent) }
    .mrt-etat--succes .mrt-badge { color: var(--texte-succes) }
    .mrt-etat--attente { border-color: color-mix(in srgb, var(--warning) 28%, transparent);
                         background: color-mix(in srgb, var(--warning) 10%, transparent) }
    .mrt-etat--attente .mrt-badge { color: var(--texte-attente) }
    .mrt-etat--alerte { border-color: color-mix(in srgb, var(--danger) 28%, transparent);
                        background: color-mix(in srgb, var(--danger) 10%, transparent) }
    .mrt-etat--alerte .mrt-badge { color: var(--texte-alerte) }

    .mrt-bloc { padding: 13px 14px; border-radius: 13px; margin-bottom: 12px;
                background: var(--surface-tertiary); border: 1px solid var(--border-color) }
    .mrt-bloc--devis { background: color-mix(in srgb, var(--color-tracky-light) 8%, transparent);
                       border-color: color-mix(in srgb, var(--color-tracky-light) 26%, transparent) }
    .mrt-bloc--action { background: var(--surface-secondary) }
    .mrt-titre { display: flex; align-items: center; gap: 7px; margin: 0 0 10px;
                 font-size: 13px; font-weight: 700; color: var(--text-primary) }
    .mrt-aide { margin: 9px 0 0; font-size: 12px; line-height: 1.6; color: var(--text-secondary) }
    .mrt-aide strong { color: var(--text-primary) }

    .mrt-arrets { margin: 0 0 10px; padding: 0; list-style: none;
                  display: flex; flex-direction: column; gap: 7px }
    .mrt-arrets li { display: flex; align-items: baseline; gap: 9px; min-width: 0 }
    .mrt-puce { flex: 0 0 auto; padding: 2px 8px; border-radius: 9999px; font-size: 10.5px;
                font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
                background: var(--surface-secondary); color: var(--text-secondary) }
    .mrt-puce--charge { background: color-mix(in srgb, var(--color-tracky-light) 16%, transparent);
                        color: var(--texte-succes) }
    .mrt-arret-l { min-width: 0; font-size: 13px; color: var(--text-primary); overflow-wrap: anywhere }

    .mrt-faits { display: flex; flex-direction: column; gap: 7px; margin: 0 }
    .mrt-faits > div { display: flex; align-items: baseline; justify-content: space-between; gap: 14px }
    .mrt-faits dt { flex-shrink: 0; font-size: 11.5px; color: var(--texte-inactif) }
    .mrt-faits dd { margin: 0; min-width: 0; text-align: right; font-size: 12.5px;
                    line-height: 1.5; color: var(--text-primary); overflow-wrap: anywhere }
    .mrt-ttc { margin: 10px 0 0; font-family: var(--font-display); font-size: 24px;
               font-weight: 800; letter-spacing: -.02em; color: var(--text-primary) }
    .mrt-ttc em { font-style: normal; font-size: 12.5px; font-weight: 700; color: var(--text-secondary) }

    .mrt-fil { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 9px }
    .mrt-tour { padding: 10px 12px; border-radius: 12px;
                background: var(--surface-secondary); border: 1px solid var(--border-color) }
    /* Ses propres tours sont marques : dans un fil de six lignes, savoir qui a dit quoi
       sans relire l'auteur est ce qui rend l'historique consultable d'un coup d'œil. */
    .mrt-tour--moi { border-color: color-mix(in srgb, var(--color-tracky-light) 30%, transparent) }
    .mrt-tour-tete { display: flex; align-items: baseline; justify-content: space-between;
                     gap: 12px; margin-bottom: 5px }
    .mrt-auteur { font-size: 11.5px; font-weight: 700; color: var(--text-secondary) }
    .mrt-quand { flex-shrink: 0; font-size: 11px; color: var(--texte-inactif) }
    .mrt-tour-m { margin: 0; font-size: 15px; font-weight: 700; color: var(--text-primary) }
    .mrt-tour-m em { font-style: normal; font-size: 11.5px; font-weight: 600; color: var(--text-secondary) }
    .mrt-tour-t { margin: 6px 0 0; font-size: 12.5px; line-height: 1.6; color: var(--text-secondary) }

    .mrt-champs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px }
    .mrt-champ { display: flex; flex-direction: column; gap: 5px; min-width: 0 }
    .mrt-champ > span:first-child { font-size: 11.5px; font-weight: 600; color: var(--text-secondary) }
    .mrt-unite { display: flex; align-items: center; gap: 6px }
    .mrt-unite input { width: 100%; min-width: 0; min-height: 44px; padding: 8px 11px;
                       border-radius: 10px; background: var(--surface-tertiary);
                       border: 1px solid var(--border-color); color: var(--text-primary);
                       font-family: inherit; font-size: 13.5px }
    .mrt-unite em { flex-shrink: 0; font-style: normal; font-size: 12px; color: var(--text-secondary) }
    .mrt-label { display: block; margin: 13px 0 6px; font-size: 11.5px; font-weight: 600;
                 color: var(--text-secondary) }
    .mrt-texte { width: 100%; min-height: 44px; padding: 10px 12px; border-radius: 11px;
                 resize: vertical; line-height: 1.55;
                 background: var(--surface-tertiary); border: 1px solid var(--border-color);
                 color: var(--text-primary); font-family: inherit; font-size: 13.5px }
    .mrt-unite input:focus, .mrt-texte:focus { outline: 2px solid var(--violet); outline-offset: 1px }

    .mrt-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 13px }
    .mrt-actions--principales { margin-top: 4px }
    .mrt-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px;
               min-height: 44px; padding: 10px 16px; border-radius: 11px;
               border: 1px solid var(--border-color); background: var(--surface-tertiary);
               color: var(--text-secondary); font-family: inherit; font-size: 13px;
               font-weight: 600; cursor: pointer }
    .mrt-btn--accent { background: var(--color-tracky-light); border-color: transparent;
                       color: var(--accent-ink); font-weight: 700 }
    .mrt-btn--danger { color: var(--texte-alerte);
                       border-color: color-mix(in srgb, var(--danger) 34%, transparent) }
    .mrt-btn:disabled { opacity: .5; cursor: not-allowed }

    .mrt-attente { display: flex; align-items: flex-start; gap: 9px; margin: 4px 0 0;
                   padding: 11px 13px; border-radius: 12px; font-size: 12.5px; line-height: 1.6;
                   color: var(--texte-attente);
                   background: color-mix(in srgb, var(--warning) 10%, transparent);
                   border: 1px solid color-mix(in srgb, var(--warning) 26%, transparent) }
    .mrt-attente lucide-icon { flex: 0 0 auto; margin-top: 1px }

    @media (max-width: 767px) {
      /* Deux champs cote a cote sous 375 px donnent 140 px chacun : le clavier
         numerique masque la moitie du nombre saisi. On empile. */
      .mrt-champs { grid-template-columns: 1fr }
      .mrt-actions--principales .mrt-btn { flex: 1 1 46% }
    }
  `],
})
export class MissionRequestThreadComponent implements OnInit {
  readonly demande = input.required<Demande>();
  /** De quel côté de la table se trouve celui qui regarde. */
  readonly camp = input.required<Camp>();
  /** La demande a changé : l'écran appelant rafraîchit sa liste. */
  readonly misAJour = output<Demande>();

  private readonly api = inject(MissionRequestsApi);
  private readonly toast = inject(ToastService);

  protected readonly Check = Check;
  protected readonly MessageSquare = MessageSquare;
  protected readonly TriangleAlert = TriangleAlert;
  protected readonly X = X;

  protected readonly volet = signal<Volet>('aucun');
  protected readonly envoi = signal(false);
  private readonly grille = signal<GrilleTarifaire | null>(null);

  protected distance: number | null = null;
  protected montant: number | null = null;
  protected message = '';
  protected motif = '';

  async ngOnInit(): Promise<void> {
    try {
      // La grille sert le RECALCUL pendant la contre-proposition. Son absence ne ferme
      // rien : on négocie très bien à la main, seul l'aide-mémoire disparaît.
      this.grille.set(await this.api.grille());
    } catch (err) {
      swallow('mission-request-thread:grille', err);
    }
  }

  // ═══ ÉTAT DÉRIVÉ ═══════════════════════════════════════════════════════════

  protected readonly ton = computed(() => tonStatut(this.demande().status));
  protected readonly statutLisible = computed(() => libelleStatut(this.demande().status));
  protected readonly estNegociableIci = computed(() => estNegociable(this.demande()));
  protected readonly jePeuxAgir = computed(() => aLaMain(this.demande(), this.camp()));
  protected readonly autreCamp = computed<Camp>(() => (this.camp() === 'DEPOT' ? 'CARRIER' : 'DEPOT'));

  /** Le dernier tour porte le devis qui est sur la table. */
  protected readonly dernierTour = computed<TourDemande | null>(() => {
    const r = this.demande().rounds;
    return r.length > 0 ? r[r.length - 1] : null;
  });

  protected readonly devisCourant = computed<DetailDevis | null>(
    () => this.dernierTour()?.breakdown ?? null,
  );

  protected readonly montantCourant = computed(() => this.demande().currentAmountCents);

  /**
   * Le montant du tour s'écarte-t-il du tarif calculé ?
   *
   * Une contre-proposition est ajustable (arbitrage I) : quand elle l'est, c'est le
   * montant SAISI qui engage, pas le calcul. Le dire évite qu'on lise le détail du
   * devis comme s'il donnait le prix final.
   */
  protected readonly montantAjuste = computed(() => {
    const d = this.devisCourant();
    const m = this.montantCourant();
    return !!d && d.statut === 'TARIF' && m !== null && d.htCents !== m;
  });

  /**
   * Ce que la grille donnerait sur la distance en cours de saisie.
   *
   * ⚠️ UNE MÉTHODE, PAS UN `computed()`, ET LA RECETTE A MONTRÉ POURQUOI.
   *
   * `distance` est un champ simple lié par `ngModel`, pas un signal. Un `computed()`
   * ne suit que les signaux qu'il lit : il avait mémorisé le résultat calculé sur la
   * distance d'origine et ne le révisait plus jamais. Constaté au navigateur le
   * 2026-08-14 — le transporteur corrigeait 48 km en 62 et l'écran affichait
   * « Sur 62 km, votre grille donne 79,00 € HT (tranche 0 à 50 km) ». Le nombre venait
   * de la nouvelle saisie, le prix de l'ancienne : un montant faux, sur le seul écran
   * où l'on discute d'argent, et parfaitement invisible en relecture de code.
   *
   * Une méthode est réévaluée à chaque cycle de détection, et chaque frappe en
   * déclenche un — y compris sous `OnPush`.
   */
  protected tarifRecalcule(): string | null {
    const g = this.grille();
    if (!g || this.distance === null) return null;
    const d = calculerDevis(this.distance, g);
    if (d.statut === 'TARIF') return `${montantEuros(d.htCents)} HT (tranche ${d.trancheLibelle})`;
    if (d.statut === 'SUR_DEVIS') return 'un tarif sur devis';
    return null;
  }

  // ═══ LES MOTS DE CHAQUE CAMP ═══════════════════════════════════════════════

  /**
   * ⚠️ LE SEUL ENDROIT OÙ LES DEUX CAMPS DIVERGENT.
   *
   * Le dépôt lit « votre transporteur », le transporteur lit « le dépôt ». Disperser
   * ces libellés dans le gabarit aurait rendu impossible de vérifier qu'aucun des deux
   * ne lit le vocabulaire de l'autre — et un dépôt qui lit « le dépôt » à propos de
   * lui-même ne comprend plus de qui on parle.
   */
  protected nomDe(auteur: 'SYSTEM' | Camp): string {
    if (auteur === 'SYSTEM') return 'Devis automatique';
    if (auteur === this.camp()) return 'Vous';
    return auteur === 'CARRIER' ? 'Votre transporteur' : 'Le dépôt';
  }

  protected deQui(camp: Camp | null): string {
    if (!camp) return 'adverse';
    if (camp === this.camp()) return 'le vôtre';
    return camp === 'CARRIER' ? 'du transporteur' : 'du dépôt';
  }

  protected phraseEtat(): string {
    const d = this.demande();
    switch (d.status) {
      case 'ACCEPTED':
        return this.camp() === 'CARRIER'
          ? `Les deux parties sont d'accord sur ${montantEuros(d.agreedAmountCents)} HT. Il reste à affecter un véhicule et un conducteur.`
          : `Les deux parties sont d'accord sur ${montantEuros(d.agreedAmountCents)} HT. Votre transporteur affecte à présent un véhicule.`;
      case 'CONVERTED':
        return 'Un véhicule est affecté : cette demande est devenue une mission.';
      case 'REJECTED':
        return `Refusée${d.rejectedReason ? ` — ${d.rejectedReason}` : ''}.`;
      case 'EXPIRED':
        // Une echeance passee n'est pas un refus : on dit quoi faire ensuite.
        return 'Le devis a expiré sans réponse. Cette demande ne se négocie plus — il faut en déposer une nouvelle.';
      default:
        return this.jePeuxAgir()
          ? 'Vous avez la main : acceptez, contre-proposez, ou refusez avec un motif.'
          : `En attente ${this.deQui(d.awaiting)}.`;
    }
  }

  // ═══ AFFICHAGE ═════════════════════════════════════════════════════════════

  protected euros(cents: number): string {
    return montantEuros(cents);
  }

  /** Un tour sans montant est « sur devis », jamais zéro. */
  protected euros2(cents: number | null): string {
    return montantEuros(cents);
  }

  protected km(valeur: number | null): string {
    return valeur === null ? 'Non renseignée' : `${valeur} km`;
  }

  protected creneau(): string {
    const f = (v: string) =>
      new Date(v).toLocaleString('fr-FR', {
        weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      });
    return `${f(this.demande().wantedStartAt)} → ${f(this.demande().wantedEndAt)}`;
  }

  protected echeance(): string {
    const v = this.demande().quoteExpiresAt;
    return v
      ? new Date(v).toLocaleString('fr-FR', {
          day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
        })
      : '';
  }

  protected quand(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  // ═══ LES GESTES ════════════════════════════════════════════════════════════

  protected ouvrirContre(): void {
    const d = this.demande();
    // On PRÉ-REMPLIT avec ce qui est sur la table : une contre-proposition part
    // toujours de l'offre en cours, jamais d'un formulaire vide qu'il faudrait
    // recomposer de mémoire.
    this.distance = d.usedDistanceKm;
    this.montant = d.currentAmountCents === null ? null : d.currentAmountCents / 100;
    this.message = '';
    this.volet.set('contre');
  }

  protected ouvrirRefus(): void {
    this.motif = '';
    this.volet.set('refus');
  }

  /**
   * La distance change → le montant SUIT le nouveau tarif, puis reste ajustable.
   *
   * C'est l'arbitrage I mot pour mot : « le prix est recalculé, puis ajustable ».
   * Laisser l'ancien montant en place aurait produit des contre-propositions à 79 €
   * sur 120 km — le genre d'erreur qu'on ne voit qu'une fois la mission facturée.
   */
  protected majDistance(valeur: unknown): void {
    const n = valeur === '' || valeur === null || valeur === undefined ? null : Number(valeur);
    this.distance = Number.isFinite(n as number) ? n : null;
    const g = this.grille();
    if (g && this.distance !== null) {
      const d = calculerDevis(this.distance, g);
      this.montant = d.statut === 'TARIF' ? d.htCents / 100 : null;
    }
  }

  protected async contreProposer(): Promise<void> {
    if (this.montant === null || this.montant < 0) return;
    await this.agir(
      () =>
        this.api.contreProposer(this.demande().id, {
          amountCents: Math.round(this.montant! * 100),
          usedDistanceKm: this.distance,
          message: this.message.trim() || null,
        }),
      'Proposition envoyée',
      `${this.nomDe(this.autreCamp())} en est prévenu par e-mail.`,
    );
  }

  protected async accepter(): Promise<void> {
    await this.agir(
      () => this.api.accepter(this.demande().id),
      'Accord conclu',
      this.camp() === 'CARRIER'
        ? 'Il reste à affecter un véhicule pour que la mission existe.'
        : 'Votre transporteur affecte à présent un véhicule.',
    );
  }

  protected async refuser(): Promise<void> {
    if (this.motif.trim().length < 3) return;
    await this.agir(
      () => this.api.refuser(this.demande().id, this.motif.trim()),
      'Demande refusée',
      'Le motif a été transmis.',
    );
  }

  /**
   * Le tronc commun des trois gestes : appel, message, remontée, fermeture du volet.
   *
   * ⚠️ LE MESSAGE D'ERREUR DU SERVEUR PASSE EN PREMIER. Il nomme la cause — « vous avez
   * déjà la main », « cette demande est expirée » — là où un repli générique laisserait
   * l'utilisateur réessayer le même geste indéfiniment.
   */
  private async agir(
    appel: () => Promise<Demande>,
    titre: string,
    message: string,
  ): Promise<void> {
    if (this.envoi()) return;
    this.envoi.set(true);
    try {
      const majAJour = await appel();
      this.misAJour.emit(majAJour);
      this.volet.set('aucun');
      this.toast.show({ kind: 'success', title: titre, message });
    } catch (err) {
      swallow('mission-request-thread:agir', err);
      const brut = (err as { error?: { message?: unknown } })?.error?.message;
      this.toast.show({
        kind: 'error',
        title: 'Action impossible',
        message:
          typeof brut === 'string' && brut.trim()
            ? brut
            : 'L\'action n\'a pas pu être transmise. Réessayez dans un instant.',
      });
    } finally {
      this.envoi.set(false);
    }
  }
}
