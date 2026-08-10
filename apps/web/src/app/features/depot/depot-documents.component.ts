import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import type { DepotDocumentDto, DepotDocumentsDto } from '@vizyo/tracky-shared';
import { CalendarClock, Download, FileText, LucideAngularModule, Package } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { DepotApiService } from './depot-api.service';
import { DepotLiveStore } from './depot-live.store';
import { DepotExportModalComponent } from './modals/depot-export-modal.component';

/**
 * Espace dépôt (2026-08) — l'onglet Documents (A3 § 4).
 *
 * Trois origines, une seule liste : le rapport hebdomadaire (généré le lundi 08:00),
 * le bon de livraison (un par mission terminée), l'export de période (à la demande).
 *
 * ┌─ L'ÉTAT VIDE N'EST PAS UNE ERREUR ────────────────────────────────────────┐
 * │ « Si le transporteur n'en produit pas, l'onglet affiche son état vide sans  │
 * │ erreur » (A3 § 8). Un dépôt dont aucune mission n'est encore terminée n'a   │
 * │ aucun document, et c'est un état NORMAL — pas une panne à signaler.         │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * L'interrupteur du rapport automatique est ACTIF par défaut : c'est lui qui apprend
 * au dépôt que le rapport existe. Il peut le couper — c'est l'un des rares réglages
 * d'un espace en lecture seule, et il n'écrit que sur son propre compte.
 */
@Component({
  selector: 'app-depot-documents',
  standalone: true,
  imports: [LucideAngularModule, DepotExportModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="dd">
      <header class="dd-tete">
        <div>
          <h1>Documents</h1>
          <p>Rapports et bons de livraison de vos missions</p>
        </div>
        <button type="button" class="dd-btn dd-btn--accent" (click)="exportOuvert.set(true)">
          <lucide-icon [img]="Download" [size]="15" aria-hidden="true" />Nouvel export
        </button>
      </header>

      <!-- ═══ Le rapport automatique ═══════════════════════════════════════ -->
      <div class="dd-reglage">
        <span class="dd-reglage-ico"><lucide-icon [img]="CalendarClock" [size]="18" /></span>
        <div class="dd-reglage-txt">
          <p class="dd-reglage-titre">Rapport hebdomadaire automatique</p>
          <p class="dd-reglage-sous">Chaque lundi à 08:00, par e-mail — vos missions de la semaine écoulée.</p>
        </div>
        <button
          type="button"
          class="dd-switch"
          role="switch"
          [attr.aria-checked]="rapportActif()"
          [class.dd-switch--on]="rapportActif()"
          [disabled]="enregistrement()"
          (click)="basculerRapport()"
        ><span class="dd-switch-pouce"></span></button>
      </div>

      @if (chargement()) {
        <div class="dd-sks">
          @for (i of [1, 2, 3]; track i) { <div class="sk" style="height:60px;border-radius:13px"></div> }
        </div>
      } @else if (documents().length === 0) {
        <div class="dd-vide">
          <span class="vt-icon-tile dd-vide-ico"><lucide-icon [img]="FileText" [size]="24" /></span>
          <p class="dd-vide-titre">Aucun document pour l'instant</p>
          <p class="dd-vide-txt">
            Vos bons de livraison apparaîtront ici dès qu'une mission sera terminée,
            et votre premier rapport hebdomadaire au prochain lundi.
          </p>
          <button type="button" class="dd-btn" (click)="exportOuvert.set(true)">Exporter une période</button>
        </div>
      } @else {
        <ul class="dd-liste">
          @for (d of documents(); track d.id) {
            <li class="dd-doc">
              <span class="dd-doc-ico" [class.dd-doc-ico--bon]="d.kind === 'DELIVERY_NOTE'">
                <lucide-icon [img]="d.kind === 'DELIVERY_NOTE' ? Package : FileText" [size]="17" />
              </span>
              <div class="dd-doc-txt">
                <p class="dd-doc-l">{{ d.label }}</p>
                <p class="dd-doc-m">{{ jour(d.at) }} · {{ d.format }}</p>
              </div>
              <button type="button" class="dd-doc-dl" (click)="telecharger(d)" [attr.aria-label]="'Télécharger ' + d.label">
                <lucide-icon [img]="Download" [size]="15" aria-hidden="true" />
                <span>Télécharger</span>
              </button>
            </li>
          }
        </ul>
      }
    </section>

    @if (exportOuvert()) { <app-depot-export-modal (fermer)="exportOuvert.set(false)" /> }
  `,
  styles: [`
    .dd { max-width: 780px; margin: 0 auto; padding: 20px 18px 40px }
    .dd-tete { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 18px }
    .dd-tete h1 {
      margin: 0; font-family: var(--font-display); font-size: 22px; font-weight: 800;
      letter-spacing: -.02em; color: var(--text-primary);
    }
    .dd-tete p { margin: 5px 0 0; font-size: 13px; color: var(--depot-attenue) }

    .dd-reglage {
      display: flex; align-items: center; gap: 13px; margin-bottom: 18px;
      padding: 14px 16px; border-radius: 14px;
      background: var(--surface-secondary); border: 1px solid var(--border-color);
    }
    .dd-reglage-ico {
      flex: 0 0 auto; display: grid; place-items: center; width: 38px; height: 38px; border-radius: 11px;
      background: color-mix(in srgb, var(--violet) 13%, transparent); color: var(--violet);
    }
    .dd-reglage-txt { flex: 1; min-width: 0 }
    .dd-reglage-titre { margin: 0; font-size: 13.5px; font-weight: 700; color: var(--text-primary) }
    .dd-reglage-sous { margin: 3px 0 0; font-size: 12px; line-height: 1.5; color: var(--depot-attenue) }
    .dd-switch {
      flex: 0 0 auto; position: relative; width: 46px; height: 27px; border-radius: 9999px;
      border: 1px solid var(--border-color); background: var(--surface-tertiary);
      cursor: pointer; transition: background .18s ease, border-color .18s ease;
    }
    .dd-switch--on { background: var(--color-tracky-light); border-color: transparent }
    .dd-switch:disabled { opacity: .6; cursor: wait }
    .dd-switch-pouce {
      position: absolute; top: 2px; left: 2px; width: 21px; height: 21px; border-radius: 50%;
      background: var(--surface-secondary); box-shadow: 0 1px 3px rgba(0, 0, 0, .3);
      transition: transform .18s cubic-bezier(.16, 1, .3, 1);
    }
    .dd-switch--on .dd-switch-pouce { transform: translateX(19px) }

    .dd-sks { display: flex; flex-direction: column; gap: 8px }
    .dd-liste { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px }
    .dd-doc {
      display: flex; align-items: center; gap: 13px; padding: 12px 14px; border-radius: 13px;
      background: var(--surface-secondary); border: 1px solid var(--border-color);
      min-height: var(--densite-liste);
    }
    .dd-doc-ico {
      flex: 0 0 auto; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px;
      background: color-mix(in srgb, var(--blue) 13%, transparent); color: var(--blue);
    }
    /* Bon de livraison = la livraison est faite → vert (succès). Rapport = information
       → bleu. « Une couleur, une signification » (design/TOKENS.md). */
    .dd-doc-ico--bon { background: color-mix(in srgb, var(--color-tracky-light) 13%, transparent); color: var(--depot-succes) }
    .dd-doc-txt { flex: 1; min-width: 0 }
    .dd-doc-l { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--text-primary) }
    .dd-doc-m { margin: 3px 0 0; font-family: var(--font-mono); font-size: 11.5px; color: var(--depot-attenue) }
    .dd-doc-dl {
      flex: 0 0 auto; display: inline-flex; align-items: center; gap: 7px;
      min-height: 36px; padding: 8px 14px; border-radius: 10px;
      border: 1px solid var(--border-color); background: var(--surface-tertiary);
      color: var(--text-secondary); font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
    }
    .dd-doc-dl:hover { color: var(--text-primary); border-color: var(--border-strong-color) }

    .dd-vide { display: flex; flex-direction: column; align-items: center; gap: 11px; padding: 48px 20px; text-align: center }
    .dd-vide-ico { width: 54px; height: 54px; border-radius: 16px }
    .dd-vide-titre { margin: 0; font-size: 16px; font-weight: 700; color: var(--text-primary) }
    .dd-vide-txt { margin: 0; max-width: 420px; font-size: 13.5px; line-height: 1.6; color: var(--text-secondary) }

    .dd-btn {
      display: inline-flex; align-items: center; gap: 7px;
      min-height: 38px; padding: 9px 16px; border-radius: 11px;
      border: 1px solid var(--border-color); background: var(--surface-secondary);
      color: var(--text-secondary); font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .dd-btn--accent { background: var(--color-tracky-light); border-color: transparent; color: var(--accent-ink) }

    @media (max-width: 767px) {
      .dd { padding: 16px 14px 32px }
      .dd-btn, .dd-doc-dl { min-height: 44px }
      .dd-doc-dl span { display: none }
      .dd-switch { width: 52px; height: 32px }
      .dd-switch-pouce { width: 26px; height: 26px }
      .dd-switch--on .dd-switch-pouce { transform: translateX(20px) }
    }
  `],
})
export class DepotDocumentsComponent implements OnInit {
  private readonly api = inject(DepotApiService);
  private readonly toast = inject(ToastService);
  private readonly store = inject(DepotLiveStore);

  protected readonly CalendarClock = CalendarClock;
  protected readonly Download = Download;
  protected readonly FileText = FileText;
  protected readonly Package = Package;

  protected readonly donnees = signal<DepotDocumentsDto | null>(null);
  protected readonly chargement = signal(true);
  protected readonly enregistrement = signal(false);
  protected readonly exportOuvert = signal(false);

  protected readonly documents = computed(() => this.donnees()?.documents ?? []);
  protected readonly rapportActif = computed(() => this.donnees()?.weeklyReportEnabled ?? true);

  async ngOnInit(): Promise<void> {
    // La marque du transporteur en tête du menu, même sur un accès direct à cet
    // onglet : cf. `DepotLiveStore.assurerMarque`.
    void this.store.assurerMarque();
    try {
      this.donnees.set(await this.api.documents());
    } catch (err) {
      swallow('depot-documents:charger', err);
    } finally {
      this.chargement.set(false);
    }
  }

  protected jour(iso: string): string {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  }

  protected async basculerRapport(): Promise<void> {
    const cible = !this.rapportActif();
    this.enregistrement.set(true);
    try {
      const r = await this.api.setRapportHebdo(cible);
      const actuel = this.donnees();
      if (actuel) this.donnees.set({ ...actuel, weeklyReportEnabled: r.weeklyReportEnabled });
      this.toast.show({
        kind: 'success',
        title: cible ? 'Rapport hebdomadaire activé' : 'Rapport hebdomadaire désactivé',
        message: cible
          ? 'Vous le recevrez chaque lundi à 08:00.'
          : 'Vous pouvez toujours exporter une période à la demande.',
      });
    } catch (err) {
      swallow('depot-documents:reglage', err);
      this.toast.show({ kind: 'error', title: 'Réglage non enregistré', message: 'Réessayez dans un instant.' });
    } finally {
      this.enregistrement.set(false);
    }
  }

  /**
   * Les rapports hebdomadaires sont dérivés, pas stockés : seuls les bons de livraison
   * ont un téléchargement direct. Pour un rapport, on ouvre l'export de période — qui
   * produit exactement le même contenu, à la demande.
   */
  protected async telecharger(d: DepotDocumentDto): Promise<void> {
    if (d.kind !== 'DELIVERY_NOTE') {
      this.exportOuvert.set(true);
      return;
    }
    try {
      const blob = await this.api.bonDeLivraison(d.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${d.label.replace(/[^\w-]+/g, '_')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      swallow('depot-documents:telecharger', err);
      this.toast.show({
        kind: 'error',
        title: 'Document indisponible',
        message: 'Le fichier n\'a pas pu être généré.',
      });
    }
  }
}
