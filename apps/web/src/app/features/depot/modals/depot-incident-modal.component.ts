import { ChangeDetectionStrategy, Component, inject, input, OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { DepotIncidentReason, DepotMissionDto } from '@vizyo/tracky-shared';
import { swallow } from '../../../core/error/swallow';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { DepotApiService } from '../depot-api.service';
import { DepotModalComponent } from './depot-modal.component';

/**
 * Espace dépôt (2026-08) — signaler un incident (A3 § 5).
 *
 * L'une des DEUX SEULES écritures d'un dépôt (l'autre étant le lien de partage, A4).
 *
 * ┌─ OÙ ATTERRIT LE SIGNALEMENT ──────────────────────────────────────────────┐
 * │ Dans l'AGENDA du transporteur, comme un événement — pas dans une boîte de   │
 * │ messages. « Il doit atterrir là où le gestionnaire regarde » (A3 § 5).      │
 * │                                                                            │
 * │ L'événement est OUVERT mais N'IMMOBILISE PAS le camion : un dépôt qui       │
 * │ pourrait rendre un véhicule indisponible écrirait sur la flotte de son      │
 * │ transporteur, ce que le rôle interdit. Cf. `DepotIncidentService`.          │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

const MOTIFS: Array<{ valeur: DepotIncidentReason; libelle: string }> = [
  { valeur: 'DELAY', libelle: 'Retard' },
  { valeur: 'GOODS', libelle: 'Marchandise' },
  { valeur: 'DEPOT_ACCESS', libelle: 'Accès dépôt' },
  { valeur: 'OTHER', libelle: 'Autre' },
];

const MESSAGE_MAX = 1000;

@Component({
  selector: 'app-depot-incident-modal',
  standalone: true,
  imports: [FormsModule, DepotModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-depot-modal
      titre="Signaler un incident"
      sousTitre="Votre transporteur le recevra dans son agenda"
      (fermer)="fermer.emit()"
    >
      <label class="dim-label" for="dim-mission">Mission concernée</label>
      <select id="dim-mission" class="dim-select" [(ngModel)]="missionChoisie">
        @for (m of missions(); track m.id) {
          <option [value]="m.id">{{ m.ref }} · {{ m.origin }} → {{ m.destination }}</option>
        }
      </select>

      <p class="dim-label">Motif</p>
      <div class="dim-motifs" role="radiogroup" aria-label="Motif de l'incident">
        @for (m of motifs; track m.valeur) {
          <button
            type="button"
            role="radio"
            [attr.aria-checked]="motif() === m.valeur"
            class="dim-motif"
            [class.dim-motif--actif]="motif() === m.valeur"
            (click)="motif.set(m.valeur)"
          >{{ m.libelle }}</button>
        }
      </div>

      <label class="dim-label" for="dim-msg">Précisions (facultatif)</label>
      <textarea
        id="dim-msg"
        class="dim-texte"
        rows="4"
        maxlength="1000"
        [(ngModel)]="message"
        placeholder="Ce que vous constatez, et ce que vous attendez."
      ></textarea>
      <p class="dim-compteur">{{ message.length }} / {{ MESSAGE_MAX }}</p>

      <footer pied class="dim-pied">
        <button type="button" class="dim-btn" (click)="fermer.emit()">Annuler</button>
        <button
          type="button"
          class="dim-btn dim-btn--accent"
          [disabled]="envoi() || !missionChoisie"
          (click)="envoyer()"
        >{{ envoi() ? 'Envoi…' : 'Envoyer le signalement' }}</button>
      </footer>
    </app-depot-modal>
  `,
  styles: [`
    .dim-label { display: block; margin: 0 0 7px; font-size: 12px; font-weight: 600; color: var(--depot-attenue) }
    .dim-label:not(:first-child) { margin-top: 16px }
    .dim-select, .dim-texte {
      width: 100%; padding: 10px 12px; border-radius: 11px;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
      color: var(--text-primary); font-family: inherit; font-size: 13.5px;
    }
    .dim-texte { resize: vertical; line-height: 1.55 }
    .dim-select:focus, .dim-texte:focus { outline: 2px solid var(--violet); outline-offset: 1px }
    .dim-compteur { margin: 6px 0 0; text-align: right; font-size: 11px; color: var(--depot-attenue) }

    .dim-motifs { display: flex; gap: 8px; flex-wrap: wrap }
    .dim-motif {
      min-height: 38px; padding: 8px 15px; border-radius: 9999px;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
      color: var(--text-secondary); font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .dim-motif--actif {
      background: color-mix(in srgb, var(--violet) 14%, transparent);
      border-color: color-mix(in srgb, var(--violet) 36%, transparent); color: var(--violet);
    }

    .dim-pied {
      flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 20px 16px; border-top: 1px solid var(--border-color);
    }
    .dim-btn {
      min-height: 40px; padding: 9px 17px; border-radius: 11px;
      border: 1px solid var(--border-color); background: var(--surface-tertiary);
      color: var(--text-secondary); font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .dim-btn--accent { background: var(--color-tracky-light); border-color: transparent; color: var(--accent-ink) }
    .dim-btn:disabled { opacity: .5; cursor: not-allowed }

    @media (max-width: 767px) {
      .dim-motif, .dim-btn { min-height: 44px }
      .dim-pied .dim-btn { flex: 1 }
    }
  `],
})
export class DepotIncidentModalComponent implements OnInit {
  readonly missions = input<DepotMissionDto[]>([]);
  /** Pré-remplie depuis la sélection courante : le dépôt signale ce qu'il regarde. */
  readonly missionInitiale = input<string | null>(null);
  readonly fermer = output<void>();

  private readonly api = inject(DepotApiService);
  private readonly toast = inject(ToastService);

  protected readonly motifs = MOTIFS;
  protected readonly MESSAGE_MAX = MESSAGE_MAX;
  protected readonly motif = signal<DepotIncidentReason>('DELAY');
  protected readonly envoi = signal(false);
  protected missionChoisie = '';
  protected message = '';

  ngOnInit(): void {
    // À défaut de sélection, la première mission de la liste — qui est triée retards
    // en tête : c'est statistiquement celle qu'on vient signaler.
    this.missionChoisie = this.missionInitiale() ?? this.missions()[0]?.id ?? '';
  }

  protected async envoyer(): Promise<void> {
    if (!this.missionChoisie) return;
    this.envoi.set(true);
    try {
      await this.api.signalerIncident(this.missionChoisie, this.motif(), this.message);
      this.toast.show({
        kind: 'success',
        title: 'Signalement envoyé',
        // On dit OÙ il atterrit : un signalement dont on ignore le sort se re-signale
        // par téléphone dix minutes plus tard.
        message: 'Votre transporteur le voit dans son agenda et reçoit un e-mail.',
      });
      this.fermer.emit();
    } catch (err) {
      swallow('depot-incident-modal:envoyer', err);
      this.toast.show({
        kind: 'error',
        title: 'Envoi impossible',
        message: 'Le signalement n\'a pas pu être transmis. Réessayez dans un instant.',
      });
    } finally {
      this.envoi.set(false);
    }
  }
}
