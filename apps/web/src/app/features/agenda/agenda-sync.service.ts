import { Injectable, signal } from '@angular/core';

/**
 * ── SYNCHRONISATION DE LA PAGE AGENDA (revue du 29/09) ──────────────────────────────────────
 *
 * Les vues Assistant IA et Parc sont DÉTRUITES dès qu'on change de vue ; leurs traitements longs
 * (« Tout réserver » sur vingt propositions, un passage de l'agent, une application de fiches)
 * continuent, eux. Une sortie `output()` émise après la destruction ne parvient plus à la page :
 * le calendrier, les propositions en pointillé et le badge restaient périmés.
 *
 * Ce service (racine, donc vivant tant que l'application l'est) porte deux compteurs. Une vue les
 * incrémente quand elle a changé quelque chose ; la page les observe et recharge. Aucun appel HTTP
 * ici : il ne fait que dire « c'est changé ».
 */
@Injectable({ providedIn: 'root' })
export class AgendaSyncService {
  /** Réservations ou propositions modifiées (réserver, écarter, passage de l'agent). */
  readonly propositions = signal(0);
  /** Fiches véhicule ou sièges modifiés (application de capacités, vue Parc). */
  readonly vehicules = signal(0);
  /**
   * Contre-revue du 29/09 — lots « Tout réserver / Tout écarter » EN COURS, par clé (société +
   * véhicule). Tenus ici et non dans la vue : la vue est détruite quand on change d'onglet, le lot
   * continue ; en revenant, ses boutons doivent rester grisés tant qu'il tourne.
   */
  readonly lotsEnCours = signal<ReadonlySet<string>>(new Set());

  debutLot(cle: string): void {
    this.lotsEnCours.update((s) => new Set([...s, cle]));
  }

  finLot(cle: string): void {
    this.lotsEnCours.update((s) => {
      const n = new Set(s);
      n.delete(cle);
      return n;
    });
  }

  propositionsModifiees(): void {
    this.propositions.update((v) => v + 1);
  }

  vehiculesModifies(): void {
    this.vehicules.update((v) => v + 1);
  }
}
