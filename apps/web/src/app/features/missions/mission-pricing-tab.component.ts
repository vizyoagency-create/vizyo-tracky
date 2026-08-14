import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Calculator, Plus, Save, Trash2, TriangleAlert } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { httpFailureMessage } from '../../core/services/http-failure';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * A6 / T3 — l'onglet Parametres de `/missions` : la grille tarifaire d'une societe.
 * Cf. docs/A6-DEMANDES-ET-DEVIS.md § 3 et § 7bis.
 *
 * ┌─ POURQUOI UN SIMULATEUR, ET PAS SEULEMENT UN TABLEAU ─────────────────────┐
 * │ Une grille qu'on ne peut pas essayer se regle a l'aveugle. Une borne mal   │
 * │ posee ne se voit pas dans un tableau de neuf lignes — elle se decouvre sur │
 * │ un devis DEJA PARTI chez le client final du client. Le simulateur rend     │
 * │ l'erreur visible avant l'enregistrement, pas apres la facture.             │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

interface TrancheDto {
  position: number;
  fromKm: number;
  toKm: number | null;
  priceCents: number | null;
}

interface GrilleDto {
  fleetId: string;
  enabled: boolean;
  vatPct: number;
  quoteValidityHours: number;
  extraStopCents: number;
  waitingHourCents: number;
  quoteFooterNote: string | null;
  category: string;
  tiers: TrancheDto[];
  updatedAt: string;
}

type Simulation =
  | { statut: 'TARIF'; trancheLibelle: string; distanceKm: number; htCents: number; tvaCents: number; ttcCents: number }
  | { statut: 'SUR_DEVIS'; distanceKm: number; motif: string }
  | { statut: 'PAS_DE_GRILLE'; motif: string };

@Component({
  selector: 'app-mission-pricing-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LucideAngularModule],
  template: `
    @if (chargement()) {
      <div class="mp-sk">@for (i of [1,2,3,4]; track i) { <div class="sk mp-sk-l"></div> }</div>
    } @else if (erreur()) {
      <div class="mp-panne">
        <p>{{ erreur() }}</p>
        <button type="button" class="mp-btn" (click)="charger()">Réessayer</button>
      </div>
    } @else if (!grille()) {
      <!-- Aucune grille : un etat NORMAL, pas une panne. On dit la consequence — sans
           tarif, le depot ne peut pas demander de mission (arbitrage J). -->
      <div class="mp-vide">
        <lucide-icon [img]="TriangleAlert" [size]="20" />
        <div>
          <p class="mp-vide-t">Aucune grille tarifaire pour cette société.</p>
          <p class="mp-vide-s">
            Les missions restent créables, mais aucun devis n'est proposé — et vos
            dépôts ne peuvent pas déposer de demande, faute de tarif à leur présenter.
          </p>
        </div>
        <button type="button" class="mp-btn mp-btn--primaire" (click)="creerGrilleType()">
          Partir d'une grille type
        </button>
      </div>
    } @else {
      <div class="mp-corps">
        <!-- ═══ L'INTERRUPTEUR ═══════════════════════════════════════════════ -->
        <section class="mp-bloc">
          <label class="mp-bascule">
            <input type="checkbox" [(ngModel)]="active" />
            <span>
              <strong>Tarification active</strong>
              <em>Décochée, la grille est conservée mais aucun devis n'est calculé.</em>
            </span>
          </label>
        </section>

        <!-- ═══ LES TRANCHES ═════════════════════════════════════════════════ -->
        <section class="mp-bloc">
          <h3 class="mp-titre">Tranches de distance</h3>
          <p class="mp-aide">
            La tranche retenue est la première dont la borne haute couvre la distance.
            La dernière ligne peut rester sans borne et sans tarif : elle vaut alors
            <strong>sur devis</strong>.
          </p>

          <div class="mp-tab" role="table">
            <div class="mp-tr mp-tr--tete" role="row">
              <span role="columnheader">De (km)</span>
              <span role="columnheader">À (km)</span>
              <span role="columnheader">Tarif HT (€)</span>
              <span></span>
            </div>
            @for (t of tranches(); track t.position; let i = $index) {
              <div class="mp-tr" role="row">
                <input type="number" min="0" inputmode="numeric"
                       [ngModel]="t.fromKm" (ngModelChange)="majTranche(i, 'fromKm', $event)"
                       [attr.aria-label]="'Borne basse de la tranche ' + (i + 1)" />
                <input type="number" min="0" inputmode="numeric" placeholder="sans limite"
                       [ngModel]="t.toKm" (ngModelChange)="majTranche(i, 'toKm', $event)"
                       [attr.aria-label]="'Borne haute de la tranche ' + (i + 1)" />
                <input type="number" min="0" step="1" inputmode="decimal" placeholder="sur devis"
                       [ngModel]="euros(t.priceCents)" (ngModelChange)="majPrix(i, $event)"
                       [attr.aria-label]="'Tarif de la tranche ' + (i + 1)" />
                <button type="button" class="mp-suppr" (click)="retirer(i)"
                        [attr.aria-label]="'Retirer la tranche ' + (i + 1)">
                  <lucide-icon [img]="Trash2" [size]="15" />
                </button>
              </div>
            }
          </div>

          <button type="button" class="mp-btn mp-ajout" (click)="ajouter()">
            <lucide-icon [img]="Plus" [size]="15" /> Ajouter une tranche
          </button>

          @if (incoherence(); as motif) {
            <p class="mp-alerte">{{ motif }}</p>
          }
        </section>

        <!-- ═══ LE SIMULATEUR ════════════════════════════════════════════════ -->
        <section class="mp-bloc">
          <h3 class="mp-titre">
            <lucide-icon [img]="Calculator" [size]="15" /> Essayer la grille
          </h3>
          <p class="mp-aide">
            Sur les tarifs <strong>enregistrés</strong> — modifiez puis enregistrez
            pour essayer une nouvelle grille.
          </p>
          <div class="mp-simu">
            <label>
              <span>Distance</span>
              <input type="number" min="0" inputmode="numeric" [(ngModel)]="kmSimules" />
            </label>
            <span class="mp-simu-u">km</span>
            <button type="button" class="mp-btn" (click)="simuler()" [disabled]="simulation() === 'encours'">
              Calculer
            </button>
          </div>

          @if (simulation(); as s) {
            @if (s !== 'encours') {
              @switch (s.statut) {
                @case ('TARIF') {
                  <p class="mp-resu">
                    <strong>{{ s.distanceKm }} km</strong> — tranche {{ s.trancheLibelle }} :
                    <strong>{{ euros(s.htCents) }} € HT</strong>,
                    TVA {{ euros(s.tvaCents) }} €,
                    <strong>{{ euros(s.ttcCents) }} € TTC</strong>
                  </p>
                }
                @case ('SUR_DEVIS') {
                  <p class="mp-resu mp-resu--devis">
                    <strong>{{ s.distanceKm }} km</strong> — {{ s.motif }}
                  </p>
                }
                @default {
                  <p class="mp-resu mp-resu--devis">{{ s.motif }}</p>
                }
              }
            }
          }
        </section>

        <!-- ═══ LES RÉGLAGES ═════════════════════════════════════════════════ -->
        <section class="mp-bloc">
          <h3 class="mp-titre">Réglages du devis</h3>
          <div class="mp-grid">
            <label class="mp-champ">
              <span>TVA (%)</span>
              <input type="number" min="0" max="100" [(ngModel)]="tva" />
            </label>
            <label class="mp-champ">
              <span>Validité d'un devis (heures)</span>
              <input type="number" min="1" [(ngModel)]="validite" />
            </label>
            <label class="mp-champ">
              <span>Supplément par arrêt (€)</span>
              <input type="number" min="0" [(ngModel)]="supplementArret" />
            </label>
            <label class="mp-champ">
              <span>Attente sur site (€ / h)</span>
              <input type="number" min="0" [(ngModel)]="attente" />
            </label>
          </div>
          <label class="mp-champ mp-champ--large">
            <span>Mention affichée sous le devis <em>facultatif</em></span>
            <textarea rows="2" [(ngModel)]="mention"
                      placeholder="Conditions, délais de paiement…"></textarea>
          </label>
        </section>

        <div class="mp-pied">
          @if (messageEnregistrement(); as m) { <p class="mp-alerte">{{ m }}</p> }
          <button type="button" class="mp-btn mp-btn--primaire"
                  [disabled]="enregistrement() || !!incoherence()" (click)="enregistrer()">
            <lucide-icon [img]="Save" [size]="15" />
            {{ enregistrement() ? 'Enregistrement…' : 'Enregistrer la grille' }}
          </button>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block }
    .mp-corps { display: flex; flex-direction: column; gap: 18px }
    .mp-bloc { padding: 16px 18px; border-radius: 14px;
               background: var(--bg-secondary); border: 1px solid var(--border-subtle) }
    .mp-titre { display: flex; align-items: center; gap: 7px; margin: 0 0 6px;
                font-size: 14px; font-weight: 700; color: var(--fg-primary) }
    /* ⚠️ --fg-secondary, et NON --fg-tertiary. Ce texte explique la regle de selection
       d'une tranche — il se LIT, il ne decore pas. Sur --bg-secondary, le jeton
       tertiaire donne 3,16:1 en clair et 3,75:1 en sombre : sous le seuil dans les DEUX
       themes. Cet ecran n'avait jamais ete mesure ; c'est ce que la garde a trouve en
       premier. Mesure dans scripts/verif-contraste.mjs, section « Grille tarifaire ». */
    .mp-aide { margin: 0 0 12px; font-size: 12.5px; line-height: 1.55; color: var(--fg-secondary) }

    .mp-bascule { display: flex; align-items: flex-start; gap: 11px; cursor: pointer }
    .mp-bascule input { margin-top: 3px; width: 18px; height: 18px; flex-shrink: 0 }
    .mp-bascule strong { display: block; font-size: 13.5px; color: var(--fg-primary) }
    .mp-bascule em { display: block; margin-top: 2px; font-style: normal;
                     font-size: 12.5px; color: var(--fg-tertiary) }

    .mp-tab { display: flex; flex-direction: column; gap: 6px }
    .mp-tr { display: grid; grid-template-columns: 1fr 1fr 1.2fr 44px; gap: 8px;
             align-items: center; min-width: 0 }
    .mp-tr > * { min-width: 0 }
    /* Meme raison : « De (km) », « A (km) », « Tarif HT » nomment les colonnes d'une
       grille de PRIX. A 11 px en majuscules, le jeton tertiaire etait le pire couple
       de l'ecran. */
    .mp-tr--tete span { font-size: 11px; font-weight: 700; text-transform: uppercase;
                        letter-spacing: .06em; color: var(--fg-secondary) }
    .mp-tr input, .mp-champ input, .mp-champ textarea {
      width: 100%; min-height: 44px; padding: 8px 11px; border-radius: 10px;
      font-size: 14px; font-family: inherit;
      background: var(--bg-primary); border: 1px solid var(--border-subtle);
      color: var(--fg-primary) }
    .mp-suppr { display: inline-flex; align-items: center; justify-content: center;
                width: 44px; height: 44px; border-radius: 10px; cursor: pointer;
                background: transparent; border: 1px solid var(--border-subtle);
                color: var(--fg-tertiary) }
    .mp-suppr:hover { color: var(--texte-alerte); border-color: var(--texte-alerte) }

    .mp-ajout { margin-top: 12px }
    .mp-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px;
              min-height: 44px; padding: 0 16px; border-radius: 10px; cursor: pointer;
              font-size: 13.5px; font-weight: 600; font-family: inherit;
              background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
              color: var(--fg-primary) }
    .mp-btn--primaire { background: var(--color-tracky-light); border-color: transparent;
                        color: var(--accent-ink); font-weight: 700 }
    .mp-btn:disabled { opacity: .5; cursor: not-allowed }

    .mp-simu { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap }
    .mp-simu label { display: flex; flex-direction: column; gap: 5px; min-width: 0 }
    .mp-simu label span { font-size: 12px; font-weight: 600; color: var(--fg-secondary) }
    .mp-simu input { width: 120px; min-height: 44px; padding: 8px 11px; border-radius: 10px;
                     font-size: 14px; font-family: inherit; background: var(--bg-primary);
                     border: 1px solid var(--border-subtle); color: var(--fg-primary) }
    .mp-simu-u { padding-bottom: 12px; font-size: 13px; color: var(--fg-secondary) }
    .mp-resu { margin: 12px 0 0; padding: 11px 13px; border-radius: 10px; font-size: 13px;
               line-height: 1.6; color: var(--texte-succes);
               background: color-mix(in srgb, var(--tracky-light) 10%, transparent) }
    .mp-resu--devis { color: var(--texte-attente);
                      background: color-mix(in srgb, var(--warning) 10%, transparent) }

    .mp-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px }
    .mp-champ { display: flex; flex-direction: column; gap: 5px; min-width: 0 }
    .mp-champ--large { margin-top: 12px }
    .mp-champ > span { font-size: 12px; font-weight: 600; color: var(--fg-secondary) }
    .mp-champ > span em { font-style: normal; font-weight: 500; color: var(--fg-secondary) }

    .mp-alerte { margin: 12px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--texte-alerte) }
    .mp-pied { display: flex; align-items: center; justify-content: flex-end; gap: 14px;
               flex-wrap: wrap }
    .mp-pied .mp-alerte { margin: 0; flex: 1 1 220px }

    .mp-vide { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap;
               padding: 18px; border-radius: 14px; color: var(--texte-attente);
               background: color-mix(in srgb, var(--warning) 9%, transparent);
               border: 1px solid color-mix(in srgb, var(--warning) 26%, transparent) }
    .mp-vide-t { margin: 0; font-size: 13.5px; font-weight: 700 }
    .mp-vide-s { margin: 4px 0 0; font-size: 12.5px; line-height: 1.6; color: var(--fg-secondary) }
    .mp-vide > div { flex: 1 1 260px; min-width: 0 }

    .mp-panne { display: flex; flex-direction: column; align-items: center; gap: 12px;
                padding: 32px 16px; text-align: center }
    .mp-panne p { margin: 0; max-width: 34ch; font-size: 13.5px; color: var(--texte-alerte) }
    .mp-sk { display: flex; flex-direction: column; gap: 10px }
    .mp-sk-l { height: 52px; border-radius: 12px }

    /* Telephone : le tableau garde ses quatre colonnes mais respire moins. Passer en
       cartes empilees couperait le lien visuel entre « de », « a » et le tarif, qui
       est justement ce qu'on relit pour verifier une borne. */
    @media (max-width: 560px) {
      .mp-tr { grid-template-columns: 1fr 1fr 1.1fr 40px; gap: 6px }
      .mp-tr input { padding: 8px 8px; font-size: 13.5px }
      .mp-suppr { width: 40px }
      .mp-grid { grid-template-columns: 1fr }
    }
  `],
})
export class MissionPricingTabComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly toast = inject(ToastService);

  protected readonly Calculator = Calculator;
  protected readonly Plus = Plus;
  protected readonly Save = Save;
  protected readonly Trash2 = Trash2;
  protected readonly TriangleAlert = TriangleAlert;

  protected readonly chargement = signal(true);
  protected readonly erreur = signal<string | null>(null);
  protected readonly grille = signal<GrilleDto | null>(null);
  protected readonly tranches = signal<TrancheDto[]>([]);
  protected readonly enregistrement = signal(false);
  protected readonly messageEnregistrement = signal<string | null>(null);
  protected readonly simulation = signal<Simulation | 'encours' | null>(null);

  protected active = true;
  protected tva = 20;
  protected validite = 48;
  protected supplementArret = 0;
  protected attente = 0;
  protected mention = '';
  protected kmSimules = 87;

  /**
   * L'incoherence detectee AVANT l'envoi. Le serveur refuse de toute facon — mais un
   * refus apres clic oblige a relire neuf lignes pour trouver laquelle cloche.
   */
  protected readonly incoherence = computed<string | null>(() => {
    const t = this.tranches();
    if (t.length === 0) return 'Une grille comporte au moins une tranche.';
    for (let i = 0; i < t.length; i++) {
      const derniere = i === t.length - 1;
      if (t[i].toKm !== null && t[i].toKm! <= t[i].fromKm) {
        return `Tranche ${i + 1} : la borne haute doit dépasser la borne basse.`;
      }
      if (t[i].toKm === null && !derniere) {
        return `Tranche ${i + 1} : seule la dernière peut être sans borne haute.`;
      }
      if (t[i].priceCents === null && !derniere) {
        return `Tranche ${i + 1} : seule la dernière peut être « sur devis ».`;
      }
      if (i > 0 && t[i - 1].toKm !== null && t[i].fromKm <= t[i - 1].toKm!) {
        return `Tranches ${i} et ${i + 1} : elles se recouvrent.`;
      }
    }
    return null;
  });

  ngOnInit(): void {
    this.charger();
  }

  protected charger(): void {
    this.chargement.set(true);
    this.erreur.set(null);
    this.http
      .get<GrilleDto | null>(`/api/missions/pricing${this.paramSociete()}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (g) => {
          this.grille.set(g);
          if (g) this.amorcer(g);
          this.chargement.set(false);
        },
        error: (err) => {
          swallow('pricing:charger', err);
          this.erreur.set(httpFailureMessage(err, 'la grille tarifaire'));
          this.chargement.set(false);
        },
      });
  }

  private amorcer(g: GrilleDto): void {
    this.active = g.enabled;
    this.tva = g.vatPct;
    this.validite = g.quoteValidityHours;
    this.supplementArret = g.extraStopCents / 100;
    this.attente = g.waitingHourCents / 100;
    this.mention = g.quoteFooterNote ?? '';
    this.tranches.set(g.tiers.map((t) => ({ ...t })));
  }

  /** La grille type du client — un point de départ, pas une obligation. */
  protected creerGrilleType(): void {
    const forfaits = [7900, 16900, 25900, 34900, 44900, 53900, 62900, 71900];
    const tiers: TrancheDto[] = forfaits.map((priceCents, i) => ({
      position: i,
      fromKm: i === 0 ? 0 : i * 50 + 1,
      toKm: (i + 1) * 50,
      priceCents,
    }));
    tiers.push({ position: tiers.length, fromKm: 401, toKm: null, priceCents: null });
    this.tranches.set(tiers);
    this.grille.set({
      fleetId: '', enabled: true, vatPct: 20, quoteValidityHours: 48,
      extraStopCents: 0, waitingHourCents: 0, quoteFooterNote: null,
      category: 'Transport de marchandise', tiers, updatedAt: '',
    });
    this.amorcer(this.grille()!);
  }

  protected majTranche(i: number, champ: 'fromKm' | 'toKm', valeur: unknown): void {
    const n = valeur === '' || valeur === null ? null : Number(valeur);
    this.tranches.update((liste) => {
      const copie = [...liste];
      copie[i] = {
        ...copie[i],
        [champ]: champ === 'fromKm' ? (n ?? 0) : n,
      } as TrancheDto;
      return copie;
    });
  }

  /** Saisi en euros, stocké en centimes. Vide = « sur devis », jamais zéro. */
  protected majPrix(i: number, valeur: unknown): void {
    const vide = valeur === '' || valeur === null || valeur === undefined;
    const cents = vide ? null : Math.round(Number(valeur) * 100);
    this.tranches.update((liste) => {
      const copie = [...liste];
      copie[i] = { ...copie[i], priceCents: Number.isFinite(cents as number) ? cents : null };
      return copie;
    });
  }

  protected ajouter(): void {
    this.tranches.update((liste) => {
      const derniere = liste[liste.length - 1];
      const depart = derniere?.toKm != null ? derniere.toKm + 1 : (derniere?.fromKm ?? 0) + 1;
      return [...liste, { position: liste.length, fromKm: depart, toKm: null, priceCents: null }];
    });
  }

  protected retirer(i: number): void {
    this.tranches.update((liste) =>
      liste.filter((_, j) => j !== i).map((t, j) => ({ ...t, position: j })),
    );
  }

  protected euros(cents: number | null): number | null {
    return cents === null ? null : Math.round(cents) / 100;
  }

  protected simuler(): void {
    this.simulation.set('encours');
    this.http
      .get<Simulation>(`/api/missions/pricing/simulate?km=${this.kmSimules}${this.paramSociete('&')}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => this.simulation.set(s),
        error: (err) => {
          swallow('pricing:simuler', err);
          this.simulation.set({ statut: 'PAS_DE_GRILLE', motif: httpFailureMessage(err, 'la simulation') });
        },
      });
  }

  protected enregistrer(): void {
    if (this.incoherence()) return;
    this.enregistrement.set(true);
    this.messageEnregistrement.set(null);
    this.http
      .put<GrilleDto>(`/api/missions/pricing${this.paramSociete()}`, {
        enabled: this.active,
        vatPct: Math.round(this.tva),
        quoteValidityHours: Math.round(this.validite),
        extraStopCents: Math.round(this.supplementArret * 100),
        waitingHourCents: Math.round(this.attente * 100),
        quoteFooterNote: this.mention.trim() || null,
        category: this.grille()?.category || 'Transport de marchandise',
        tiers: this.tranches(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (g) => {
          this.grille.set(g);
          this.amorcer(g);
          this.enregistrement.set(false);
          this.toast.success('Grille tarifaire enregistrée.');
        },
        error: (err) => {
          swallow('pricing:enregistrer', err);
          // Le message du SERVEUR d'abord : il nomme la tranche en cause, là où un
          // repli générique laisserait relire les neuf lignes.
          const brut = (err as { error?: { message?: unknown } })?.error?.message;
          this.messageEnregistrement.set(
            typeof brut === 'string' && brut.trim()
              ? brut
              : httpFailureMessage(err, 'la grille tarifaire'),
          );
          this.enregistrement.set(false);
        },
      });
  }

  /** Le super-admin travaille dans la société choisie au bandeau. */
  private paramSociete(prefixe: '?' | '&' = '?'): string {
    const id = this.fleetFilter.selectedFleetId();
    return id ? `${prefixe}fleetId=${encodeURIComponent(id)}` : '';
  }
}
