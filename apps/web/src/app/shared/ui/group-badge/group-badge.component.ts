import { Component, computed, input } from '@angular/core';
import { Layers, LucideAngularModule } from 'lucide-angular';

/**
 * Les cinq teintes d'identité des groupes. Ce sont les jetons de PETIT TEXTE déjà
 * mesurés — la maquette `Kit Partage Refonte` habille ses quatre groupes d'exemple
 * exactement avec eux (accent, rouge, bleu, violet, ambre) plutôt que d'inventer une
 * palette de plus.
 *
 * ⚠️ Ici la couleur ne porte AUCUNE sémantique : « Chantier Nord » n'est pas en danger
 * parce qu'il est rouge. La règle « une couleur = une signification » ne s'applique pas
 * à une couleur d'IDENTITÉ, et le contexte lève l'ambiguïté — un chip de groupe porte
 * un nom de groupe, jamais un état.
 */
const TEINTES = [
  '--texte-succes',
  '--texte-alerte',
  '--texte-info',
  '--texte-violet',
  '--texte-attente',
] as const;

/**
 * Empreinte stable d'une chaîne. `djb2` — court, sans dépendance, et surtout
 * DÉTERMINISTE d'une session à l'autre et d'un écran à l'autre.
 */
function empreinte(valeur: string): number {
  let h = 5381;
  for (let i = 0; i < valeur.length; i += 1) h = ((h << 5) + h + valeur.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Badge de groupe — le même groupe, la même couleur, partout.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ LA COULEUR VIENT DE L'IDENTIFIANT, PAS DE L'ORDRE D'AFFICHAGE             │
 * │                                                                            │
 * │ Règle du kit : « "Chantier Nord" reste rouge sur la carte, dans les listes │
 * │ et dans les rapports ». C'est toute l'utilité du badge — reconnaître un    │
 * │ groupe sans le lire.                                                       │
 * │                                                                            │
 * │ Une couleur tirée du RANG (le 1ᵉʳ vert, le 2ᵉ bleu…) donne l'inverse :     │
 * │ elle change dès qu'on trie autrement, dès qu'un groupe est filtré, dès     │
 * │ qu'on en crée un nouveau. Le badge devient alors pire qu'inutile : il      │
 * │ apprend une association qu'il dément à l'écran suivant.                    │
 * │                                                                            │
 * │ D'où l'empreinte de `id`. Le repli sur `name` n'est pas équivalent — deux  │
 * │ écrans qui ne chargent pas l'identifiant s'accorderont entre eux, mais un  │
 * │ renommage changera la couleur. Passez `id` dès que vous l'avez.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Usage :
 *   <app-group-badge [group]="vehicle.group" />
 *   <app-group-badge [group]="vehicle.group" [showEmpty]="true" />
 */
@Component({
  selector: 'app-group-badge',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    @if (group(); as g) {
      <span
        class="group-badge"
        [style.color]="'var(' + teinte() + ')'"
        [style.background]="'color-mix(in srgb, var(' + teinte() + ') 13%, transparent)'"
        [attr.title]="'Groupe : ' + g.name">
        <lucide-icon [img]="LayersIcon" [size]="10" aria-hidden="true"></lucide-icon>
        <span class="group-badge-name">{{ g.name }}</span>
      </span>
    } @else if (showEmpty()) {
      <span class="group-badge group-badge--empty" title="Sans groupe">
        <lucide-icon [img]="LayersIcon" [size]="10" aria-hidden="true"></lucide-icon>
        <span class="group-badge-name">Sans groupe</span>
      </span>
    }
  `,
  styles: [`
    .group-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 6px;
      font-size: 10px;
      line-height: 1.2;
      font-weight: 600;
      border-radius: 9999px;
      border: 1px solid transparent;
      white-space: nowrap;
      max-width: 160px;
      overflow: hidden;
    }
    .group-badge-name {
      text-overflow: ellipsis;
      overflow: hidden;
    }
    /* « Sans groupe » n'est pas un groupe : il reste gris et TIRETÉ, comme le
       « Non configuré » du badge de présence. Une absence ne prend pas de couleur
       d'identité, sans quoi elle se lit comme un groupe de plus. */
    .group-badge--empty {
      background: var(--bg-tertiary);
      color: var(--fg-tertiary);
      font-weight: 500;
      border-color: var(--border-subtle);
      border-style: dashed;
    }
  `],
})
export class GroupBadgeComponent {
  /** Groupe à afficher, ou null/undefined pour « sans groupe ». */
  readonly group = input<{ id?: string; name: string } | null | undefined>(null);
  /** Si true, affiche un chip muet « Sans groupe » au lieu de ne rien rendre. */
  readonly showEmpty = input<boolean>(false);

  protected readonly LayersIcon = Layers;

  /** Le jeton de teinte de ce groupe — stable tant que son identifiant ne change pas. */
  protected readonly teinte = computed(() => {
    const g = this.group();
    if (!g) return TEINTES[0];
    return TEINTES[empreinte(g.id ?? g.name) % TEINTES.length]!;
  });
}

/** Exporté pour les tests : la teinte d'un groupe donné, sans monter de composant. */
export function teinteDeGroupe(idOuNom: string): string {
  return TEINTES[empreinte(idOuNom) % TEINTES.length]!;
}
