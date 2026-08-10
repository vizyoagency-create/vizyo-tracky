import { ChangeDetectionStrategy, Component, computed, inject, OnInit, output, signal } from '@angular/core';
import type { DepotExportFormat } from '@vizyo/tracky-shared';
import { swallow } from '../../../core/error/swallow';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { DepotApiService } from '../depot-api.service';
import { DepotModalComponent } from './depot-modal.component';

/**
 * Espace dépôt (2026-08) — l'export d'une période (A3 § 5).
 *
 * Deux règles que la spec pose explicitement, et une conséquence :
 *
 *  1. **Le nombre de trajets concernés s'affiche AVANT de générer.** Un export qu'on
 *     lance sans savoir ce qu'il contient produit un fichier vide qu'on interprète
 *     comme une panne.
 *
 *  2. **Le poids estimé sur mobile.** « Un export lancé en 4G sans avertissement est
 *     une mauvaise surprise » — règle déjà posée pour `pdf-export-modal`.
 *
 *  3. Conséquence : au-delà de 8 s, on annonce « le réseau est lent » avec un bouton
 *     Annuler. Un bouton qui tourne sans fin fait recharger la page, ce qui relance
 *     la génération — et aggrave exactement ce qu'on subit.
 */

const PERIODES = [
  { valeur: 7, libelle: '7 jours' },
  { valeur: 30, libelle: '30 jours' },
  { valeur: 0, libelle: 'Ce mois' },
] as const;

/** Au-delà, on prévient que le réseau est lent plutôt que de laisser tourner. */
const SEUIL_LENTEUR_MS = 8_000;

@Component({
  selector: 'app-depot-export-modal',
  standalone: true,
  imports: [DepotModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-depot-modal
      titre="Exporter vos missions"
      sousTitre="Seules vos missions figurent dans le fichier"
      (fermer)="fermer.emit()"
    >
      <p class="dxm-label">Période</p>
      <div class="dxm-chips" role="radiogroup" aria-label="Période de l'export">
        @for (p of periodes; track p.valeur) {
          <button
            type="button"
            role="radio"
            [attr.aria-checked]="periode() === p.valeur"
            class="dxm-chip"
            [class.dxm-chip--actif]="periode() === p.valeur"
            (click)="choisirPeriode(p.valeur)"
          >{{ p.libelle }}</button>
        }
      </div>

      <p class="dxm-label">Format</p>
      <div class="dxm-chips" role="radiogroup" aria-label="Format de l'export">
        <button
          type="button" role="radio" [attr.aria-checked]="format() === 'PDF'"
          class="dxm-chip" [class.dxm-chip--actif]="format() === 'PDF'"
          (click)="choisirFormat('PDF')"
        >PDF · rapport</button>
        <button
          type="button" role="radio" [attr.aria-checked]="format() === 'CSV'"
          class="dxm-chip" [class.dxm-chip--actif]="format() === 'CSV'"
          (click)="choisirFormat('CSV')"
        >CSV · données brutes</button>
      </div>

      <!-- Ce que le fichier contiendra, AVANT de le générer. -->
      <div class="dxm-apercu">
        @if (apercuEnCours()) {
          <span class="sk" style="display:block;height:16px;width:180px;border-radius:6px"></span>
        } @else if (nbMissions() === 0) {
          <p class="dxm-vide">Aucune mission sur cette période. Choisissez une période plus large.</p>
        } @else {
          <p>
            <strong>{{ nbMissions() }}</strong> {{ nbMissions() > 1 ? 'missions' : 'mission' }} sur la période
            <span class="dxm-poids">· ≈ {{ poidsLisible() }}</span>
          </p>
        }
      </div>

      @if (lent()) {
        <p class="dxm-lent">Le réseau est lent — la génération continue.</p>
      }

      <footer pied class="dxm-pied">
        <button type="button" class="dxm-btn" (click)="fermer.emit()">
          {{ generation() ? 'Annuler' : 'Fermer' }}
        </button>
        <button
          type="button" class="dxm-btn dxm-btn--accent"
          [disabled]="generation() || nbMissions() === 0"
          (click)="generer()"
        >{{ generation() ? 'Génération…' : 'Générer le fichier' }}</button>
      </footer>
    </app-depot-modal>
  `,
  styles: [`
    .dxm-label { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--depot-attenue) }
    .dxm-label:not(:first-child) { margin-top: 16px }
    .dxm-chips { display: flex; gap: 8px; flex-wrap: wrap }
    .dxm-chip {
      min-height: 38px; padding: 8px 15px; border-radius: 9999px;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
      color: var(--text-secondary); font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .dxm-chip--actif {
      background: color-mix(in srgb, var(--violet) 14%, transparent);
      border-color: color-mix(in srgb, var(--violet) 36%, transparent); color: var(--violet);
    }
    .dxm-apercu {
      margin-top: 18px; padding: 13px 15px; border-radius: 13px;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
      font-size: 13.5px; color: var(--text-secondary);
    }
    .dxm-apercu p { margin: 0 }
    .dxm-apercu strong { color: var(--text-primary) }
    /* Le poids : affiché partout, indispensable sur mobile (A3 § 5). */
    .dxm-poids { color: var(--depot-attenue); font-size: 12.5px }
    .dxm-vide { color: var(--depot-attenue) }
    .dxm-lent { margin: 10px 0 0; font-size: 12.5px; font-weight: 600; color: var(--depot-attente) }

    .dxm-pied {
      flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 20px 16px; border-top: 1px solid var(--border-color);
    }
    .dxm-btn {
      min-height: 40px; padding: 9px 17px; border-radius: 11px;
      border: 1px solid var(--border-color); background: var(--surface-tertiary);
      color: var(--text-secondary); font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .dxm-btn--accent { background: var(--color-tracky-light); border-color: transparent; color: var(--accent-ink) }
    .dxm-btn:disabled { opacity: .5; cursor: not-allowed }

    @media (max-width: 767px) {
      .dxm-chip, .dxm-btn { min-height: 44px }
      .dxm-pied .dxm-btn { flex: 1 }
    }
  `],
})
export class DepotExportModalComponent implements OnInit {
  readonly fermer = output<void>();

  private readonly api = inject(DepotApiService);
  private readonly toast = inject(ToastService);

  protected readonly periodes = PERIODES;
  protected readonly periode = signal<number>(7);
  protected readonly format = signal<DepotExportFormat>('PDF');
  protected readonly nbMissions = signal(0);
  protected readonly poidsOctets = signal(0);
  protected readonly apercuEnCours = signal(true);
  protected readonly generation = signal(false);
  protected readonly lent = signal(false);

  protected readonly poidsLisible = computed(() => {
    const o = this.poidsOctets();
    if (o < 1024) return `${o} o`;
    if (o < 1024 * 1024) return `${Math.round(o / 1024)} Ko`;
    return `${(o / (1024 * 1024)).toFixed(1)} Mo`;
  });

  private minuteur: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    void this.rafraichirApercu();
  }

  protected choisirPeriode(valeur: number): void {
    this.periode.set(valeur);
    void this.rafraichirApercu();
  }

  protected choisirFormat(f: DepotExportFormat): void {
    this.format.set(f);
    void this.rafraichirApercu();
  }

  private bornes(): { from: string; to: string } {
    const to = new Date();
    const from = new Date(to);
    if (this.periode() === 0) {
      from.setDate(1);
      from.setHours(0, 0, 0, 0);
    } else {
      from.setDate(from.getDate() - this.periode());
    }
    return { from: from.toISOString(), to: to.toISOString() };
  }

  private async rafraichirApercu(): Promise<void> {
    this.apercuEnCours.set(true);
    try {
      const { from, to } = this.bornes();
      const a = await this.api.apercuExport(from, to, this.format());
      this.nbMissions.set(a.missionCount);
      this.poidsOctets.set(a.estimatedBytes);
    } catch (err) {
      swallow('depot-export-modal:apercu', err);
    } finally {
      this.apercuEnCours.set(false);
    }
  }

  protected async generer(): Promise<void> {
    this.generation.set(true);
    this.lent.set(false);
    this.minuteur = setTimeout(() => this.lent.set(true), SEUIL_LENTEUR_MS);
    try {
      const { from, to } = this.bornes();
      const blob = await this.api.export(from, to, this.format());
      const extension = this.format().toLowerCase();
      this.telecharger(blob, `missions-${from.slice(0, 10)}_${to.slice(0, 10)}.${extension}`);
      this.fermer.emit();
    } catch (err) {
      swallow('depot-export-modal:generer', err);
      this.toast.show({
        kind: 'error',
        title: 'Export impossible',
        message: 'Le fichier n\'a pas pu être généré. Réessayez dans un instant.',
      });
    } finally {
      if (this.minuteur) clearTimeout(this.minuteur);
      this.generation.set(false);
      this.lent.set(false);
    }
  }

  private telecharger(blob: Blob, nom: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nom;
    a.click();
    URL.revokeObjectURL(url);
  }
}
