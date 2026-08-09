import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LucideAngularModule, Route, Warehouse } from 'lucide-angular';

/**
 * Espace dépôt — écran d'accueil (lot A1).
 *
 * Ce que cet écran EST : l'état vide d'A3 § 2, celui qu'un dépôt fraîchement invité
 * voit à sa première connexion. Le livrable le désigne comme « le plus important à
 * soigner » — un dépôt qui arrive sur une carte muette croit que l'outil est cassé.
 *
 * Ce qu'il n'est PAS encore : les quatre onglets (Carte live · Missions · Historique ·
 * Documents), livrés par le lot A3. La carte, les cartes de mission et le rail
 * Documents viendront s'articuler autour de cet état vide, qui restera.
 */
@Component({
  selector: 'app-depot-home',
  standalone: true,
  imports: [LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mx-auto flex max-w-2xl flex-col items-center gap-5 px-5 py-16 text-center">
      <span class="vt-icon-tile" style="width:56px;height:56px;border-radius:16px">
        <lucide-icon [img]="Warehouse" [size]="26" />
      </span>

      <div class="flex flex-col gap-2">
        <h1 class="font-display text-[1.55rem] font-extrabold leading-tight text-fg-primary">
          Aucune mission pour l'instant
        </h1>
        <p class="text-[0.95rem] leading-relaxed text-fg-secondary">
          Votre transporteur vous assignera des missions depuis son espace.
          Vous recevrez un e-mail à chaque nouvelle mission.
        </p>
      </div>

      <!-- L'encart qui NOMME ce qui est absent. Sans lui, un dépôt qui sait que son
           transporteur a sept camions se demande si l'outil est cassé ; avec lui,
           l'absence devient une garantie — et c'est l'argument qui a permis au
           transporteur d'ouvrir l'accès (A3 § 1). -->
      <div
        class="mt-2 flex w-full items-start gap-3 rounded-[14px] border border-dashed
               border-border-strong px-4 py-3.5 text-left"
      >
        <lucide-icon [img]="Route" [size]="17" class="mt-0.5 shrink-0 text-fg-tertiary" />
        <p class="text-[0.83rem] leading-relaxed text-fg-tertiary">
          Vous ne voyez que les camions engagés sur <strong>vos</strong> missions, et
          seulement pendant leur créneau. Les autres véhicules de votre transporteur ne
          vous sont pas visibles.
        </p>
      </div>
    </section>
  `,
})
export class DepotHomeComponent {
  protected readonly Warehouse = Warehouse;
  protected readonly Route = Route;

  // À FAIRE (lot A3) — nommer le transporteur plutôt que « Votre transporteur ».
  // Le canal existe déjà : `DepotMissionDto.carrierName` porte `Fleet.name`. On ne
  // l'ajoute PAS à `AuthUser` : ce serait modifier un contrat d'API existant, ce que
  // le livrable réserve à un accord explicite (PROMPT § « Ce que tu ne fais pas »).
}
