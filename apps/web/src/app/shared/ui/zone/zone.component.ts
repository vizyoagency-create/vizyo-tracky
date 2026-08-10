import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  OnDestroy,
  output,
  signal,
} from '@angular/core';
import { LucideAngularModule, AlertTriangle, Inbox, Lock, RefreshCw } from 'lucide-angular';
import { PERMISSION_LABELS, type UserPermissions } from '@vizyo/tracky-shared';
import { PermissionsService } from '../../../core/services/permissions.service';
import { SkeletonComponent } from '../skeleton/skeleton.component';

/**
 * Les SIX ÉTATS d'une zone de contenu — `design/B0-SOCLE.md` § « Les 6 états
 * obligatoires ».
 *
 * Le socle les impose à chaque composant du kit. Le code actuel n'en gère
 * généralement que deux : « chargement » et « rempli ». Les quatre autres sont
 * précisément ceux où l'utilisateur a besoin qu'on lui parle.
 */
export type EtatZone = 'chargement' | 'rempli' | 'vide' | 'erreur' | 'partiel' | 'interdit';

/** Au-delà de ce délai, le squelette cède la place à une sortie (Kit Partage). */
const SEUIL_ATTENTE_MS = 8_000;

/**
 * Zone de contenu — le squelette commun des six états.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI UN COMPOSANT ET PAS UNE CONVENTION                                │
 * │                                                                            │
 * │ « Chaque composant sait montrer ses six états » est une exigence de revue, │
 * │ pas une intention (B0-SOCLE). Écrite composant par composant, elle produit │
 * │ vingt-quatre écrans vides différents, vingt-quatre formulations de l'erreur│
 * │ et — c'est le vrai coût — vingt-quatre occasions d'en oublier un.          │
 * │                                                                            │
 * │ Ici les cinq états non nominaux sont rendus UNE fois. Le composant appelant│
 * │ ne fournit que ce que lui seul sait : ce qui est vide, ce qui a échoué, et │
 * │ quoi faire ensuite.                                                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * LES QUATRE RÈGLES DU KIT QUI VIVENT ICI
 *
 *  · SQUELETTE, JAMAIS UN ROND. « Jamais un rond tournant seul au centre d'une
 *    page. Pour un chargement de page → squelette. Pour une action → rond dans le
 *    bouton, libellé au participe. » Un rond au centre ne dit ni ce qui charge, ni
 *    combien de temps, ni à quoi ressemblera le résultat ; un squelette dit les
 *    trois, et supprime le saut de mise en page à l'arrivée des données.
 *
 *  · AU-DELÀ DE 8 SECONDES, UNE SORTIE. Le squelette cède la place à un message :
 *    « l'utilisateur doit pouvoir abandonner ». Un squelette qui pulse indéfiniment
 *    est un mensonge poli — il promet une arrivée imminente qui ne vient pas.
 *
 *  · UNE ERREUR PORTE UN RECOURS. Jamais un constat seul : toujours le geste qui
 *    suit. Sans recours, la seule issue est de recharger la page, et l'utilisateur
 *    perd ce qu'il avait saisi ailleurs.
 *
 *  · INTERDIT NOMME LA PERMISSION. Aujourd'hui on masque en silence. Un bouton qui
 *    disparaît sans explication produit un ticket de support ; un bloc qui dit
 *    « demande la permission Couper le moteur » n'en produit aucun. Le libellé vient
 *    de la source partagée `PERMISSION_LABELS`, jamais d'une chaîne recopiée.
 *
 * Usage :
 *   <app-zone [etat]="etat()" (reessayer)="charger()">
 *     …le contenu rempli…
 *   </app-zone>
 *
 *   <app-zone [etat]="'interdit'" permission="engine_control" />
 *   <app-zone [etat]="etat()" vide="Aucun trajet sur la période" />
 */
@Component({
  selector: 'app-zone',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, SkeletonComponent],
  template: `
    @switch (etat()) {
      @case ('chargement') {
        @if (tropLong()) {
          <div class="zn-bloc" role="status">
            <lucide-icon [img]="RefreshCw" [size]="22" class="zn-ico"></lucide-icon>
            <p class="zn-titre">{{ quoi() }} met plus de temps que prévu</p>
            <p class="zn-texte">
              La connexion est peut-être lente. Vous pouvez patienter encore, ou revenir
              plus tard sans rien perdre.
            </p>
            <div class="zn-actions">
              <button type="button" class="zn-btn zn-btn--principal" (click)="relancer()">Réessayer</button>
              <button type="button" class="zn-btn" (click)="abandonner.emit()">Abandonner</button>
            </div>
          </div>
        } @else {
          <div class="zn-sk" role="status" [attr.aria-label]="'Chargement : ' + quoi()">
            <ng-content select="[squelette]" />
            @if (!squeletteFourni()) {
              @for (l of lignesSquelette(); track l) {
                <app-skeleton h="14px" [w]="l" />
              }
            }
          </div>
        }
      }

      @case ('vide') {
        <div class="zn-bloc">
          <lucide-icon [img]="Inbox" [size]="22" class="zn-ico"></lucide-icon>
          <p class="zn-titre">{{ vide() || 'Rien à afficher' }}</p>
          @if (videDetail()) { <p class="zn-texte">{{ videDetail() }}</p> }
          <ng-content select="[action-vide]" />
        </div>
      }

      @case ('erreur') {
        <div class="zn-bloc zn-bloc--erreur" role="alert">
          <lucide-icon [img]="AlertTriangle" [size]="22" class="zn-ico zn-ico--erreur"></lucide-icon>
          <p class="zn-titre">{{ erreur() || 'Le chargement a échoué' }}</p>
          <p class="zn-texte">{{ erreurDetail() || 'Rien n\\'a été perdu : la page se recharge sans conséquence.' }}</p>
          <div class="zn-actions">
            <button type="button" class="zn-btn zn-btn--principal" (click)="relancer()">Réessayer</button>
            <ng-content select="[recours]" />
          </div>
        </div>
      }

      @case ('interdit') {
        <div class="zn-bloc zn-bloc--interdit">
          <lucide-icon [img]="Lock" [size]="22" class="zn-ico zn-ico--interdit"></lucide-icon>
          <p class="zn-titre">{{ quoi() }} demande une permission</p>
          <p class="zn-texte">
            Il vous manque
            <strong class="zn-perm">{{ libellePermission() }}</strong>.
            Un administrateur de la flotte peut vous l'accorder depuis Utilisateurs.
          </p>
        </div>
      }

      @default {
        <!-- « partiel » et « rempli » rendent le même contenu : ce qui change est le
             bandeau qui nomme ce qui manque. Masquer un contenu incomplet reviendrait
             à traiter une donnée manquante comme une panne. -->
        @if (etat() === 'partiel') {
          <p class="zn-partiel" role="status">
            <lucide-icon [img]="AlertTriangle" [size]="14"></lucide-icon>
            {{ partiel() || 'Une partie des données n\\'a pas pu être chargée.' }}
          </p>
        }
        <ng-content />
      }
    }
  `,
  styles: [`
    :host { display: block }

    .zn-sk { display: flex; flex-direction: column; gap: 10px; }

    .zn-bloc {
      display: flex; flex-direction: column; align-items: center; text-align: center;
      gap: 6px; padding: 28px 20px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card, 16px);
    }
    .zn-bloc--erreur { border-color: color-mix(in srgb, var(--texte-alerte) 30%, transparent) }
    .zn-bloc--interdit { border-style: dashed }

    .zn-ico { color: var(--fg-tertiary) }
    .zn-ico--erreur { color: var(--texte-alerte) }
    .zn-ico--interdit { color: var(--texte-violet) }

    .zn-titre { margin: 4px 0 0; font-size: .95rem; font-weight: 700; color: var(--fg-primary) }
    .zn-texte { margin: 0; max-width: 42ch; font-size: .82rem; line-height: 1.5; color: var(--fg-secondary) }
    .zn-perm { color: var(--texte-violet); font-weight: 700 }

    .zn-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px }
    .zn-btn {
      min-height: 44px; padding: 8px 14px;
      font: inherit; font-size: .82rem; font-weight: 600;
      border-radius: 10px; cursor: pointer;
      background: var(--bg-tertiary); color: var(--fg-secondary);
      border: 1px solid var(--border-subtle);
    }
    .zn-btn:hover { color: var(--fg-primary) }
    .zn-btn--principal { background: var(--color-tracky-light); color: var(--accent-ink); border-color: transparent }

    .zn-partiel {
      display: flex; align-items: center; gap: 7px;
      margin: 0 0 10px; padding: 8px 11px;
      background: color-mix(in srgb, var(--texte-attente) 12%, transparent);
      border-radius: 10px;
      font-size: .78rem; line-height: 1.4; color: var(--texte-attente);
    }
  `],
})
export class ZoneComponent implements OnDestroy {
  private readonly perms = inject(PermissionsService);

  readonly etat = input.required<EtatZone>();
  /**
   * Ce que la zone contient, au singulier et sans majuscule — « la carte »,
   * « l'historique », « les trajets ». Sert à composer les messages : « l'historique
   * met plus de temps que prévu » se lit, « le contenu met plus de temps » non.
   */
  readonly quoi = input<string>('Le chargement');
  /** Titre de l'état vide. */
  readonly vide = input<string>();
  /** Une phrase de plus sur l'état vide : pourquoi c'est vide, quoi faire. */
  readonly videDetail = input<string>();
  readonly erreur = input<string>();
  readonly erreurDetail = input<string>();
  /** Ce qui manque, quand une partie seulement des données est arrivée. */
  readonly partiel = input<string>();
  /** La permission qui manque. Son libellé vient de la source partagée. */
  readonly permission = input<keyof UserPermissions>();
  /** Nombre de lignes du squelette par défaut, si l'appelant n'en projette pas. */
  readonly lignes = input<number>(3);
  /** Vrai si l'appelant projette son propre squelette (via l'attribut « squelette »). */
  readonly squeletteFourni = input<boolean>(false);

  readonly reessayer = output<void>();
  readonly abandonner = output<void>();

  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Inbox = Inbox;
  protected readonly Lock = Lock;
  protected readonly RefreshCw = RefreshCw;

  /** Le chargement dure-t-il assez pour qu'on doive proposer une sortie ? */
  protected readonly tropLong = signal(false);
  private minuteur: ReturnType<typeof setTimeout> | null = null;

  /**
   * Largeurs décroissantes : un squelette à lignes égales se lit comme un tableau,
   * pas comme du texte en cours d'arrivée.
   */
  protected readonly lignesSquelette = computed(() => {
    const largeurs = ['100%', '92%', '78%', '85%', '70%'];
    return Array.from({ length: Math.max(1, this.lignes()) }, (_, i) => largeurs[i % largeurs.length]!);
  });

  protected readonly libellePermission = computed(() => {
    const p = this.permission();
    return p ? PERMISSION_LABELS[p]?.label ?? p : 'une permission supplémentaire';
  });

  constructor() {
    effect(() => {
      const enChargement = this.etat() === 'chargement';
      this.arreterMinuteur();
      this.tropLong.set(false);
      if (!enChargement) return;
      this.minuteur = setTimeout(() => this.tropLong.set(true), SEUIL_ATTENTE_MS);
    });
  }

  ngOnDestroy(): void {
    this.arreterMinuteur();
  }

  protected relancer(): void {
    this.tropLong.set(false);
    this.minuteur = setTimeout(() => this.tropLong.set(true), SEUIL_ATTENTE_MS);
    this.reessayer.emit();
  }

  private arreterMinuteur(): void {
    if (this.minuteur) {
      clearTimeout(this.minuteur);
      this.minuteur = null;
    }
  }
}
