import { Injectable, signal } from '@angular/core';

/**
 * 06/10/2026 — le signal « l'état de disponibilité d'un véhicule vient peut-être de changer ».
 *
 * Une maintenance posée dans l'agenda doit mettre la clé sur la carte (demande du propriétaire :
 * « si on ajoute une maintenance à une voiture, elle doit passer avec le rond marron et la clé »).
 * Mais l'état ne voyage pas par le WebSocket : il vit dans l'instantané que `RealtimeService` relit.
 *
 * Plutôt que d'injecter le service temps réel (socket, authentification, routeur…) dans chaque
 * service d'appels qui modifie un état, ceux-ci lèvent ce drapeau sans dépendance ; le service
 * temps réel l'écoute et relit les états. Aucun cycle d'injection, aucun poids dans les specs.
 */
@Injectable({ providedIn: 'root' })
export class EtatsVehiculesBus {
  /** Incrémenté à chaque geste qui peut changer l'état d'un véhicule (agenda, fiche). */
  readonly revision = signal(0);

  signaler(): void {
    this.revision.update((n) => n + 1);
  }
}
