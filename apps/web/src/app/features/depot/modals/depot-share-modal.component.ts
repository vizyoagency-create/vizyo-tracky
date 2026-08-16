import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnDestroy,
  OnInit,
  output,
  signal,
} from '@angular/core';
import type { DepotMissionDto, MissionShareLinkDto, ShareDurationDto } from '@vizyo/tracky-shared';
import { Check, Copy, LucideAngularModule, Share2, Trash2 } from 'lucide-angular';
import { swallow } from '../../../core/error/swallow';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { DepotApiService } from '../depot-api.service';
import { DepotModalComponent } from './depot-modal.component';

/**
 * Espace dépôt (2026-08), lot A4 — la modale de partage.
 *
 * ┌─ CE QUE CETTE MODALE DOIT FAIRE COMPRENDRE AVANT DE COPIER ───────────────┐
 * │ « Un lien public à envoyer à votre client final. Il n'affiche que la        │
 * │ position et l'heure d'arrivée du camion de cette mission, et expire         │
 * │ automatiquement. »                                                          │
 * │                                                                            │
 * │ Cette phrase n'est pas de la politesse : le dépôt engage sa responsabilité  │
 * │ en envoyant un lien. Elle lui dit CE QU'IL TRANSMET avant qu'il le          │
 * │ transmette — c'est ce qui évite qu'il se sente responsable d'une fuite      │
 * │ qu'il n'aurait pas comprise (A4 § 5).                                       │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Le compte à rebours est RÉEL, calculé sur `expiresAt` servi par le serveur. Un
 * « expire dans 15 min » figé au chargement mentirait dès la première minute — et
 * c'est précisément la durée qui protège ici.
 */

const DUREES: Array<{ valeur: ShareDurationDto; libelle: string }> = [
  { valeur: 'MIN_15', libelle: '15 min' },
  { valeur: 'HOUR_1', libelle: '1 h' },
  { valeur: 'UNTIL_MISSION_END', libelle: 'Fin de mission' },
];

/** Fenêtre pendant laquelle « Annuler » révoque le lien qu'on vient de créer. */
const FENETRE_ANNULATION_MS = 8_000;

@Component({
  selector: 'app-depot-share-modal',
  standalone: true,
  imports: [LucideAngularModule, DepotModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-depot-modal
      titre="Partager le suivi"
      [sousTitre]="mission().origin + ' → ' + mission().destination + ' · ' + mission().ref"
      (fermer)="fermer.emit()"
    >
      <!-- ═══ LA PHRASE DE PÉRIMÈTRE ═══════════════════════════════════════ -->
      <p class="dsm-perimetre">
        Un lien public à envoyer à votre client final. Il n'affiche que la position et
        l'heure d'arrivée du camion de cette mission, et expire automatiquement.
      </p>

      <p class="dsm-label">Durée de validité</p>
      <div class="dsm-chips" role="radiogroup" aria-label="Durée de validité du lien">
        @for (d of durees; track d.valeur) {
          <button
            type="button" role="radio" [attr.aria-checked]="duree() === d.valeur"
            class="dsm-chip" [class.dsm-chip--actif]="duree() === d.valeur"
            [disabled]="creation()"
            (click)="duree.set(d.valeur)"
          >{{ d.libelle }}</button>
        }
      </div>

      @if (!lien()) {
        <button type="button" class="dsm-generer" [disabled]="creation()" (click)="generer()">
          <lucide-icon [img]="Share2" [size]="16" aria-hidden="true" />
          {{ creation() ? 'Génération…' : 'Générer le lien' }}
        </button>
      } @else {
        <div class="dsm-lien">
          <input
            #champ
            class="dsm-url"
            type="text"
            readonly
            [value]="lien()!.url"
            aria-label="Lien public de suivi"
            (focus)="champ.select()"
          />
          <button type="button" class="dsm-copier" (click)="copier()">
            <lucide-icon [img]="copie() ? Check : Copy" [size]="15" aria-hidden="true" />
            {{ copie() ? 'Copié' : 'Copier' }}
          </button>
        </div>

        <!-- Bouton pleine largeur : sur mobile il ouvre la feuille de partage native,
             pour que le dépôt envoie sans quitter l'écran (A4 § 5). -->
        <button type="button" class="dsm-envoyer" (click)="copierEtEnvoyer()">
          <lucide-icon [img]="Share2" [size]="16" aria-hidden="true" />Copier et envoyer
        </button>

        <!-- ═══ L'ENCART AMBRÉ, avec un COMPTE À REBOURS RÉEL ═══════════════ -->
        <div class="dsm-expire">
          <span class="dsm-expire-dot" aria-hidden="true"></span>
          <p>
            Expire dans <strong>{{ rebours() }}</strong> · révocable à tout moment
          </p>
        </div>
      }

      <!-- ═══ Les liens déjà ouverts, avec leur usage ═══════════════════════ -->
      @if (actifs().length > 0) {
        <p class="dsm-label">Liens actifs</p>
        <ul class="dsm-liste">
          @for (l of actifs(); track l.id) {
            <li class="dsm-actif">
              <div class="dsm-actif-txt">
                <span class="dsm-actif-duree">{{ libelleDuree(l.duration) }}</span>
                <span class="dsm-actif-usage">{{ usage(l) }}</span>
              </div>
              <button type="button" class="dsm-revoquer" (click)="revoquer(l)">
                <lucide-icon [img]="Trash2" [size]="14" aria-hidden="true" />Révoquer
              </button>
            </li>
          }
        </ul>
      }

      <footer pied class="dsm-pied">
        <button type="button" class="dsm-btn" (click)="fermer.emit()">Fermer</button>
      </footer>
    </app-depot-modal>
  `,
  styles: [`
    /* La phrase de périmètre : discrète mais posée AVANT tout, pas en note de bas. */
    .dsm-perimetre {
      margin: 0 0 16px; padding: 11px 13px; border-radius: 12px;
      border: 1px dashed var(--border-strong-color);
      font-size: 12.5px; line-height: 1.6; color: var(--depot-attenue);
    }

    .dsm-label { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--depot-attenue) }
    .dsm-label:not(:first-of-type) { margin-top: 18px }

    .dsm-chips { display: flex; gap: 8px; flex-wrap: wrap }
    .dsm-chip {
      min-height: 38px; padding: 8px 15px; border-radius: 9999px;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
      color: var(--depot-attenue); font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .dsm-chip--actif {
      background: color-mix(in srgb, var(--violet) 14%, transparent);
      border-color: color-mix(in srgb, var(--violet) 36%, transparent); color: var(--violet);
    }
    .dsm-chip:disabled { opacity: .5; cursor: not-allowed }

    .dsm-generer, .dsm-envoyer {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%; min-height: 44px; margin-top: 16px; padding: 11px 18px;
      border-radius: 12px; border: none;
      background: var(--color-tracky-light); color: var(--accent-ink);
      font-family: inherit; font-size: 14px; font-weight: 700; cursor: pointer;
    }
    .dsm-generer:disabled { opacity: .6; cursor: wait }
    .dsm-envoyer { margin-top: 10px }

    .dsm-lien { display: flex; gap: 8px; margin-top: 16px }
    .dsm-url {
      flex: 1; min-width: 0; padding: 10px 12px; border-radius: 11px;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
      color: var(--text-primary); font-family: var(--font-mono); font-size: 12.5px;
    }
    .dsm-copier {
      flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px;
      min-height: 42px; padding: 9px 15px; border-radius: 11px;
      border: 1px solid var(--border-color); background: var(--surface-tertiary);
      color: var(--depot-attenue); font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }

    /* Ambre = attente (design/TOKENS.md). Le lien n'est ni un succès ni une alerte :
       c'est quelque chose qui court et qui va s'arrêter. */
    .dsm-expire {
      display: flex; align-items: center; gap: 10px; margin-top: 14px;
      padding: 11px 14px; border-radius: 12px;
      background: color-mix(in srgb, var(--warning) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
    }
    .dsm-expire-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--depot-attente); flex: 0 0 auto }
    .dsm-expire p { margin: 0; font-size: 12.5px; color: var(--depot-attente) }
    .dsm-expire strong { font-family: var(--font-mono); font-size: 13px }

    .dsm-liste { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px }
    .dsm-actif {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 10px 13px; border-radius: 12px;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
      min-height: var(--densite-liste);
    }
    .dsm-actif-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0 }
    .dsm-actif-duree { font-size: 13px; font-weight: 600; color: var(--text-primary) }
    .dsm-actif-usage { font-size: 11.5px; color: var(--depot-attenue) }
    .dsm-revoquer {
      flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px;
      min-height: 36px; padding: 8px 13px; border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--danger) 32%, transparent);
      background: transparent; color: var(--depot-alerte);
      font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
    }

    .dsm-pied {
      flex: 0 0 auto; display: flex; justify-content: flex-end;
      padding: 12px 20px 16px; border-top: 1px solid var(--border-color);
    }
    .dsm-btn {
      min-height: 40px; padding: 9px 17px; border-radius: 11px;
      border: 1px solid var(--border-color); background: var(--surface-tertiary);
      color: var(--depot-attenue); font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }

    @media (max-width: 767px) {
      .dsm-chip, .dsm-btn, .dsm-copier, .dsm-revoquer { min-height: 44px }
      .dsm-pied .dsm-btn { flex: 1 }
    }
  `],
})
export class DepotShareModalComponent implements OnInit, OnDestroy {
  readonly mission = input.required<DepotMissionDto>();
  readonly fermer = output<void>();

  private readonly api = inject(DepotApiService);
  private readonly toast = inject(ToastService);

  protected readonly durees = DUREES;
  protected readonly Share2 = Share2;
  protected readonly Copy = Copy;
  protected readonly Check = Check;
  protected readonly Trash2 = Trash2;

  protected readonly duree = signal<ShareDurationDto>('MIN_15');
  protected readonly lien = signal<{ id: string; url: string; expiresAt: string } | null>(null);
  protected readonly liens = signal<MissionShareLinkDto[]>([]);
  protected readonly creation = signal(false);
  protected readonly copie = signal(false);
  /** Ré-évalué chaque seconde : c'est ce qui rend le compte à rebours honnête. */
  private readonly maintenant = signal(Date.now());

  protected readonly actifs = computed(() => this.liens().filter((l) => l.active));

  /** « 14:52 ». Zéro quand le lien vient d'expirer — jamais un nombre négatif. */
  protected readonly rebours = computed(() => {
    const expire = this.lien()?.expiresAt;
    if (!expire) return '—';
    const restant = Math.max(0, new Date(expire).getTime() - this.maintenant());
    const minutes = Math.floor(restant / 60_000);
    const secondes = Math.floor((restant % 60_000) / 1000);
    return `${minutes}:${String(secondes).padStart(2, '0')}`;
  });

  private tic: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.tic = setInterval(() => this.maintenant.set(Date.now()), 1000);
    void this.chargerLiens();
  }

  ngOnDestroy(): void {
    if (this.tic) clearInterval(this.tic);
  }

  private async chargerLiens(): Promise<void> {
    try {
      this.liens.set(await this.api.partages(this.mission().id));
    } catch (err) {
      swallow('depot-share:liste', err);
    }
  }

  protected async generer(): Promise<void> {
    this.creation.set(true);
    try {
      const cree = await this.api.creerPartage(this.mission().id, this.duree());
      this.lien.set({ id: cree.id, url: cree.url, expiresAt: cree.expiresAt });
      await this.copierPressePapier(cree.url);
      await this.chargerLiens();
      // ┌─ LE SNACKBAR AVEC « ANNULER » ────────────────────────────────────────┐
      // │ Plus qu'une commodité : c'est la sortie du GESTE RATÉ, dans les huit   │
      // │ secondes, sans ouvrir de menu. Un dépôt qui partage la mauvaise        │
      // │ mission n'a pas à chercher comment révoquer — il annule (A4 § 5).      │
      // └────────────────────────────────────────────────────────────────────────┘
      this.toast.show({
        kind: 'success',
        title: 'Lien copié',
        message: `Il expire dans ${this.libelleDuree(this.duree()).toLowerCase()} et reste révocable.`,
        duration: FENETRE_ANNULATION_MS,
        action: { label: 'Annuler', callback: () => void this.annulerCreation(cree.id) },
      });
    } catch (err) {
      swallow('depot-share:generer', err);
      const message = (err as { error?: { error?: { message?: string } } })?.error?.error?.message;
      this.toast.show({
        kind: 'error',
        title: 'Lien non généré',
        message: message ?? 'Réessayez dans un instant.',
      });
    } finally {
      this.creation.set(false);
    }
  }

  /** L'ANNULER du snackbar : on révoque, et on efface le lien de l'écran. */
  private async annulerCreation(lienId: string): Promise<void> {
    try {
      await this.api.revoquerPartage(lienId);
      this.lien.set(null);
      await this.chargerLiens();
      this.toast.show({ kind: 'info', title: 'Lien révoqué', message: 'Il ne fonctionne plus.' });
    } catch (err) {
      swallow('depot-share:annuler', err);
    }
  }

  protected async revoquer(l: MissionShareLinkDto): Promise<void> {
    try {
      await this.api.revoquerPartage(l.id);
      if (this.lien()?.id === l.id) this.lien.set(null);
      await this.chargerLiens();
      this.toast.show({
        kind: 'info',
        title: 'Lien révoqué',
        message: 'Le destinataire voit désormais un lien fermé.',
      });
    } catch (err) {
      swallow('depot-share:revoquer', err);
      this.toast.show({ kind: 'error', title: 'Révocation impossible', message: 'Réessayez.' });
    }
  }

  protected async copier(): Promise<void> {
    const url = this.lien()?.url;
    if (!url) return;
    await this.copierPressePapier(url);
    this.copie.set(true);
    setTimeout(() => this.copie.set(false), 2000);
  }

  /**
   * Copie ET propose la feuille de partage native quand elle existe.
   *
   * L'ordre compte : on copie D'ABORD. Si le partage natif est refusé ou absent, le
   * lien est déjà dans le presse-papier — le dépôt n'a pas fait le geste pour rien.
   */
  protected async copierEtEnvoyer(): Promise<void> {
    const url = this.lien()?.url;
    if (!url) return;
    await this.copierPressePapier(url);
    const partageNatif = (navigator as Navigator & { share?: (d: ShareData) => Promise<void> }).share;
    if (!partageNatif) {
      this.copie.set(true);
      setTimeout(() => this.copie.set(false), 2000);
      return;
    }
    try {
      await partageNatif.call(navigator, {
        title: 'Suivi de livraison',
        text: 'Suivez votre livraison en direct :',
        url,
      });
    } catch {
      /* L'utilisateur a fermé la feuille de partage : le lien reste copié. */
    }
  }

  private async copierPressePapier(texte: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(texte);
    } catch {
      // Presse-papier refusé (contexte non sécurisé) : le champ reste sélectionnable
      // à la main. On ne prétend pas avoir copié.
      this.toast.show({
        kind: 'warning',
        title: 'Copie automatique impossible',
        message: 'Sélectionnez le lien pour le copier.',
      });
    }
  }

  protected libelleDuree(d: ShareDurationDto): string {
    return DUREES.find((x) => x.valeur === d)?.libelle ?? '15 min';
  }

  /** « Ouvert 3 fois, dernière il y a 4 min » — l'information qui permet de décider
   *  s'il faut révoquer (A4 § 4). */
  protected usage(l: MissionShareLinkDto): string {
    if (l.openCount === 0) return 'Jamais ouvert';
    const suffixe = l.openCount > 1 ? `${l.openCount} fois` : '1 fois';
    if (!l.lastOpenedAt) return `Ouvert ${suffixe}`;
    const minutes = Math.floor((this.maintenant() - new Date(l.lastOpenedAt).getTime()) / 60_000);
    const depuis = minutes < 1 ? "à l'instant" : minutes < 60 ? `il y a ${minutes} min` : `il y a ${Math.floor(minutes / 60)} h`;
    return `Ouvert ${suffixe}, dernière ${depuis}`;
  }
}
