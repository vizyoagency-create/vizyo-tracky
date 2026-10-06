import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { AlertTriangle, LucideAngularModule, Unplug, Wrench } from 'lucide-angular';
import { LIBELLES_ETAT, type EtatIndisponibilite, type ImmobilisationAgendaDto } from '@vizyo/tracky-shared';

/**
 * Badge « état de disponibilité » d'un véhicule — 06/10/2026, demande du propriétaire : « un
 * système d'état qui fonctionne dans toute l'app ». Débranché, accidenté, immobilisé (fiche), en
 * maintenance ou incident en cours (agenda) : les MÊMES mots (`LIBELLES_ETAT`) et les mêmes
 * icônes que la carte — la barre, le panneau « ! », la clé.
 *
 * Posé sur des surfaces de l'application (liste, fiche) : couleurs du THÈME (`--texte-alerte`,
 * `--texte-attente`), pas la palette du fond de carte.
 *
 * Usage : `<app-etat-vehicule-badge [etat]="etatDe(v)" [immobilisation]="v.immobilisationAgenda" />`
 * — rien n'est rendu quand le véhicule est disponible.
 */
@Component({
  selector: 'app-etat-vehicule-badge',
  standalone: true,
  imports: [LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (etat(); as e) {
      <span class="evb" [attr.data-ton]="ton()" [class.evb--compact]="compact()" [attr.title]="titre()">
        <lucide-icon [img]="icone()" [size]="11" aria-hidden="true"></lucide-icon>
        @if (compact()) {
          <span class="evb-sr">{{ libelle() }}</span>
        } @else {
          <span>{{ libelle() }}</span>
        }
      </span>
    }
  `,
  styles: [`
    .evb {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 9999px;
      font-size: 10.5px;
      font-weight: 700;
      white-space: nowrap;
      color: var(--texte-attente);
      background: color-mix(in srgb, var(--texte-attente) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--texte-attente) 35%, transparent);
    }
    .evb[data-ton='alerte'] {
      color: var(--texte-alerte);
      background: color-mix(in srgb, var(--texte-alerte) 12%, transparent);
      border-color: color-mix(in srgb, var(--texte-alerte) 35%, transparent);
    }
    .evb--compact { padding: 3px; }
    .evb-sr {
      position: absolute; width: 1px; height: 1px; overflow: hidden;
      clip: rect(0 0 0 0); white-space: nowrap;
    }
  `],
})
export class EtatVehiculeBadgeComponent {
  readonly etat = input<EtatIndisponibilite | null>(null);
  /** L'immobilisation d'agenda qui porte l'état (maintenance, incident) : son titre et son échéance. */
  readonly immobilisation = input<ImmobilisationAgendaDto | null>(null);
  /** Icône seule, pour les rangées denses (le libellé reste lu par les lecteurs d'écran). */
  readonly compact = input(false);

  protected readonly ton = computed(() => {
    const e = this.etat();
    return e === 'DEBRANCHE' || e === 'ACCIDENTE' ? 'alerte' : 'attente';
  });

  protected readonly icone = computed(() => {
    switch (this.etat()) {
      case 'DEBRANCHE': return Unplug;
      case 'ACCIDENTE': return AlertTriangle;
      default: return Wrench;
    }
  });

  protected readonly libelle = computed(() => {
    const e = this.etat();
    return e ? LIBELLES_ETAT[e].long : '';
  });

  protected readonly titre = computed(() => {
    const e = this.etat();
    if (!e) return null;
    const im = this.immobilisation();
    if (im && (e === 'MAINTENANCE' || e === 'INCIDENT')) {
      const fin = im.endAt ? new Date(im.endAt) : null;
      const quand = fin && !Number.isNaN(fin.getTime())
        ? `jusqu'au ${fin.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} à ${fin.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
        : 'jusqu’à sa clôture';
      return `${LIBELLES_ETAT[e].long} — « ${im.title} », ${quand} (agenda). Ni réservation ni coupe automatique.`;
    }
    return `${LIBELLES_ETAT[e].long} — déclaré sur la fiche du véhicule. Ni réservation, ni alertes, ni coupe automatique.`;
  });
}
