import { Component, DestroyRef, computed, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  AlertTriangle, CalendarClock, CheckCircle2, LucideAngularModule, ShieldCheck, ShieldOff,
} from 'lucide-angular';
import { ZoneComponent } from '../../shared/ui/zone/zone.component';
import type { EtatZone } from '../../shared/ui/zone/zone.component';
import {
  ETATS_VIE_PRIVEE,
  WorkScheduleApiService,
  type EtatViePrivee,
  type PrivacyCoverageRow,
} from '../../core/services/work-schedule.service';

interface GroupeCouverture {
  cle: EtatViePrivee;
  titre: string;
  sens: string;
  lignes: PrivacyCoverageRow[];
}

/**
 * Lot 2 — « Couverture vie privée » : quels véhicules sont réellement protégés hors temps de
 * travail, et surtout lesquels ne le sont PAS. L'absence de protection doit être visible, jamais
 * silencieuse (exigence 21/07/2026).
 *
 * Trois états, dont les MOTS viennent de `ETATS_VIE_PRIVEE` — la même source que l'éditeur
 * d'horaires (B1 § E) :
 * - PROTÉGÉ          : usage mixte déclaré ET cadre actif → hors plage, aucune position collectée ;
 * - MIXTE SANS CADRE : usage mixte déclaré mais aucun cadre actif → le véhicule serait privé en
 *                      permanence (à corriger : définir des horaires) ;
 * - NON COUVERT      : véhicule professionnel, suivi en permanence — normal s'il ne rentre pas
 *                      au domicile ; à activer sinon (l'antivol reste actif dans ce mode).
 *
 * ── Lot B-pages (2026-08-11) ────────────────────────────────────────────────────────────
 *
 * Trois changements, tous tirés de la planche :
 *
 *  · LES TROIS ÉTATS DEVIENNENT TROIS GROUPES, « à corriger » en tête. Ils étaient une liste
 *    unique simplement TRIÉE : l'anomalie se lisait pastille par pastille, sur 15 lignes.
 *  · « DÉFINIR LES HORAIRES » EST SUR LA LIGNE. Le défaut à corriger nommait le geste
 *    (« posez-leur des horaires ») sans jamais l'offrir — il fallait deviner qu'il vivait dans
 *    un onglet de la fiche véhicule.
 *  · UNE PANNE NE SE DÉGUISE PLUS EN FLOTTE VIDE. Le `catch` posait `loading=false` et rien
 *    d'autre : une API tombée affichait « 0 véhicule », donc « rien à corriger », sur l'écran
 *    qui sert précisément de preuve que la protection est en place.
 */
@Component({
  selector: 'app-privacy-coverage',
  standalone: true,
  imports: [LucideAngularModule, RouterLink, ZoneComponent],
  template: `
    <div class="pc">
      <header class="pc-head">
        <div>
          <h1 class="pc-title"><lucide-icon [img]="ShieldCheck" [size]="22" /> Couverture vie privée</h1>
          <p class="pc-sub">Quels véhicules cessent d'être suivis hors du temps de travail — et lesquels sont suivis en permanence.</p>
        </div>
      </header>

      <app-zone
        [etat]="etat()"
        quoi="La couverture vie privée"
        vide="Aucun véhicule dans cette flotte"
        videDetail="La couverture s'affichera dès qu'un véhicule sera rattaché à la flotte."
        erreur="Impossible de charger la couverture vie privée"
        erreurDetail="Tant que cet écran ne répond pas, il ne prouve rien : ne le lisez pas comme « tout va bien »."
        permission="privacy_manage"
        (reessayer)="charger()">

        <div class="pc-kpis">
          <div class="pc-kpi pc-kpi--ok">
            <div class="pc-kpi-n">{{ protectedCount() }}</div>
            <div class="pc-kpi-l">protégé{{ protectedCount() > 1 ? 's' : '' }} hors temps de travail</div>
          </div>
          <div class="pc-kpi" [class.pc-kpi--warn]="aCorriger().length > 0">
            <div class="pc-kpi-n">{{ aCorriger().length }}</div>
            <div class="pc-kpi-l">à corriger</div>
          </div>
          <div class="pc-kpi">
            <div class="pc-kpi-n">{{ uncoveredCount() }}</div>
            <div class="pc-kpi-l">suivi{{ uncoveredCount() > 1 ? 's' : '' }} en permanence</div>
          </div>
        </div>

        <!--
          L'anomalie AVANT le reste : un usage mixte sans cadre n'est pas un reglage exotique,
          c'est une protection qui ne s'applique pas alors qu'on croit l'avoir posee.
        -->
        @if (aCorriger().length; as n) {
          <div class="pc-note pc-note--warn">
            <lucide-icon [img]="AlertTriangle" [size]="15" class="pc-note-ic" />
            <span>
              <strong>{{ n }} véhicule{{ n > 1 ? 's' : '' }} déclaré{{ n > 1 ? 's' : '' }} en usage mixte
              n'{{ n > 1 ? 'ont' : 'a' }} aucun cadre horaire.</strong>
              {{ mots.MIXTE_SANS_CADRE.sens }}
              Posez-leur des horaires pour que la protection s'applique au bon moment.
            </span>
          </div>
        }

        @if (uncoveredCount() > 0) {
          <div class="pc-note">
            <lucide-icon [img]="ShieldOff" [size]="15" class="pc-note-ic pc-note-ic--muet" />
            <span>
              <strong>{{ uncoveredCount() }} véhicule{{ uncoveredCount() > 1 ? 's sont suivis' : ' est suivi' }} en permanence.</strong>
              {{ mots.NON_COUVERT.sens }}
              Pour un véhicule de service ramené chez le conducteur, activez l'usage mixte depuis sa fiche.
            </span>
          </div>
        }

        <div class="pc-groupes">
          @for (g of groupes(); track g.cle) {
            <section class="pc-groupe">
              <header class="pc-grp-t" [attr.data-etat]="g.cle">
                <span class="pc-grp-titre">{{ g.titre }} · {{ g.lignes.length }}</span>
              </header>
              <p class="pc-grp-sens">{{ g.sens }}</p>

              @for (r of g.lignes; track r.vehicleId) {
                <div class="pc-row" [attr.data-etat]="g.cle">
                  <lucide-icon [img]="icone(g.cle)" [size]="17" class="pc-ic" [attr.data-etat]="g.cle" />
                  <a class="pc-row-main" [routerLink]="['/vehicles', r.vehicleId]">
                    <span class="pc-plate">{{ r.plate }}</span>
                    <span class="pc-meta">{{ r.fleetName }}@if (r.driverName) { · {{ r.driverName }} }</span>
                  </a>
                  <span class="pc-badge" [attr.data-etat]="g.cle">{{ mots[g.cle].court }}</span>

                  <!-- Le geste EXACT que la phrase d'alerte reclame, la ou il manque. -->
                  @if (g.cle === 'MIXTE_SANS_CADRE') {
                    <a class="pc-cta" [routerLink]="['/vehicles', r.vehicleId]" [queryParams]="{ tab: 'schedule' }">
                      <lucide-icon [img]="CalendarClock" [size]="13" /> Définir les horaires
                    </a>
                  }
                </div>
              }
            </section>
          }
        </div>

        <p class="pc-pied">
          Cette page ne définit rien : elle <strong>lit</strong> les horaires de la flotte.
          Les mêmes plages servent à la coupure moteur et à la protection vie privée —
          un seul réglage, deux effets.
        </p>
      </app-zone>
    </div>
  `,
  styles: [`
    .pc { max-width: 940px; margin: 0 auto; padding: 20px 16px 60px; color: var(--fg-primary); }
    .pc-head { margin-bottom: 18px; }
    .pc-title { display: flex; align-items: center; gap: 9px; font-size: 20px; font-weight: 800; margin: 0; color: var(--fg-primary); }
    .pc-title lucide-icon { color: var(--texte-succes); }
    .pc-sub { margin: 4px 0 0; font-size: 12.5px; color: var(--fg-secondary); }

    .pc-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 14px; }
    .pc-kpi { border: 1px solid var(--border-subtle); border-radius: 13px; background: var(--bg-secondary); padding: 14px; }
    .pc-kpi--ok { border-color: color-mix(in srgb, var(--color-tracky-light) 35%, transparent); }
    .pc-kpi--warn { border-color: color-mix(in srgb, var(--warning) 35%, transparent); }
    .pc-kpi-n { font-size: 26px; font-weight: 800; letter-spacing: -.02em; color: var(--fg-primary); }
    .pc-kpi--ok .pc-kpi-n { color: var(--texte-succes); }
    .pc-kpi--warn .pc-kpi-n { color: var(--texte-attente); }
    .pc-kpi-l { font-size: 11.5px; color: var(--fg-secondary); margin-top: 2px; }

    .pc-note {
      display: flex; gap: 9px; align-items: flex-start; padding: 11px 14px; border-radius: 11px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      font-size: 12.5px; line-height: 1.55; color: var(--fg-secondary); margin-bottom: 12px; text-wrap: pretty;
    }
    .pc-note--warn {
      background: color-mix(in srgb, var(--warning) 10%, transparent);
      border-color: color-mix(in srgb, var(--warning) 30%, transparent);
    }
    .pc-note strong { color: var(--fg-primary); }
    .pc-note--warn strong { color: var(--texte-attente); }
    .pc-note-ic { color: var(--warning); flex: none; margin-top: 2px; }
    .pc-note-ic--muet { color: var(--fg-secondary); }

    /* Trois GROUPES, et non une liste triee : l'anomalie se voit sans lire chaque pastille. */
    .pc-groupes { display: flex; flex-direction: column; gap: 18px; }
    .pc-groupe { display: flex; flex-direction: column; gap: 8px; }
    .pc-grp-t {
      display: flex; align-items: center; gap: 8px; min-height: 26px; padding: 3px 12px;
      border-radius: 8px; background: var(--bg-tertiary);
      font-size: 11px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase;
      color: var(--fg-secondary);
    }
    .pc-grp-t[data-etat='MIXTE_SANS_CADRE'] { background: color-mix(in srgb, var(--warning) 12%, transparent); color: var(--texte-attente); }
    .pc-grp-t[data-etat='PROTEGE'] { background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent); color: var(--texte-succes); }
    .pc-grp-sens { margin: -2px 2px 2px; font-size: 12px; line-height: 1.45; color: var(--fg-secondary); text-wrap: pretty; }

    .pc-row {
      display: flex; align-items: center; gap: 11px; padding: 10px 14px; flex-wrap: wrap;
      border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--bg-secondary);
    }
    .pc-row[data-etat='MIXTE_SANS_CADRE'] { border-color: color-mix(in srgb, var(--warning) 32%, transparent); }
    .pc-ic { flex: none; color: var(--fg-secondary); }
    .pc-ic[data-etat='PROTEGE'] { color: var(--texte-succes); }
    .pc-ic[data-etat='MIXTE_SANS_CADRE'] { color: var(--texte-attente); }
    /* L'ETIQUETTE porte la cible : toute la zone plaque + societe ouvre la fiche. */
    .pc-row-main { display: flex; flex-direction: column; justify-content: center; gap: 1px; flex: 1; min-width: 0; min-height: 44px; text-decoration: none; color: inherit; }
    .pc-plate { font-weight: 700; font-size: 14px; color: var(--fg-primary); }
    .pc-meta { font-size: 11.5px; color: var(--fg-secondary); }
    .pc-badge {
      flex: none; font-size: 11px; font-weight: 700; padding: 4px 9px; border-radius: 7px;
      border: 1px solid var(--border-strong); color: var(--fg-secondary); white-space: nowrap;
    }
    .pc-badge[data-etat='PROTEGE'] { color: var(--texte-succes); border-color: color-mix(in srgb, var(--color-tracky-light) 35%, transparent); }
    .pc-badge[data-etat='MIXTE_SANS_CADRE'] { color: var(--texte-attente); border-color: color-mix(in srgb, var(--warning) 35%, transparent); }
    .pc-cta {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: none;
      min-height: 44px; padding: 0 12px; border-radius: 10px;
      background: var(--color-tracky-light); color: var(--accent-ink);
      font-size: 12px; font-weight: 800; text-decoration: none; white-space: nowrap;
    }

    .pc-pied { margin: 20px 2px 0; font-size: 12px; line-height: 1.5; color: var(--fg-secondary); text-wrap: pretty; }
    .pc-pied strong { color: var(--fg-primary); }
  `],
})
export class PrivacyCoverageComponent implements OnInit {
  private readonly api = inject(WorkScheduleApiService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly ShieldCheck = ShieldCheck;
  protected readonly ShieldOff = ShieldOff;
  protected readonly CheckCircle2 = CheckCircle2;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly CalendarClock = CalendarClock;

  /** Les mots des trois états, lus depuis la source partagée avec l'éditeur d'horaires. */
  protected readonly mots = ETATS_VIE_PRIVEE;

  protected readonly rows = signal<PrivacyCoverageRow[]>([]);
  protected readonly total = signal(0);
  protected readonly protectedCount = signal(0);
  protected readonly uncoveredCount = signal(0);

  private readonly charge = signal(false);
  private readonly enErreur = signal(false);
  private readonly interdit = signal(false);

  /**
   * Une panne et une flotte vide sont DEUX choses. Le code precedent les confondait — il
   * posait `loading = false` sans rien d'autre — et affichait donc « 0 vehicule », soit
   * « rien a corriger », sur l'ecran qui sert de preuve que la protection est en place.
   */
  protected readonly etat = computed<EtatZone>(() => {
    if (this.interdit()) return 'interdit';
    if (this.enErreur()) return 'erreur';
    if (!this.charge()) return 'chargement';
    return this.rows().length ? 'rempli' : 'vide';
  });

  private lignesDe(cle: EtatViePrivee): PrivacyCoverageRow[] {
    return this.rows().filter((r) => r.status === cle);
  }
  protected readonly aCorriger = computed(() => this.lignesDe('MIXTE_SANS_CADRE'));

  /**
   * L'ordre est celui de la DECISION, pas de l'alphabet : ce qui demande un geste d'abord,
   * ce qui est en regle ensuite, ce qui est normal en dernier. Un groupe vide ne s'affiche
   * pas — un en-tete « A corriger · 0 » occupe l'ecran pour ne rien dire.
   */
  protected readonly groupes = computed<GroupeCouverture[]>(() =>
    (['MIXTE_SANS_CADRE', 'PROTEGE', 'NON_COUVERT'] as const)
      .map((cle) => ({
        cle,
        titre: ETATS_VIE_PRIVEE[cle].long,
        sens: ETATS_VIE_PRIVEE[cle].sens,
        lignes: this.lignesDe(cle),
      }))
      .filter((g) => g.lignes.length > 0),
  );

  protected icone(cle: EtatViePrivee) {
    if (cle === 'PROTEGE') return CheckCircle2;
    if (cle === 'MIXTE_SANS_CADRE') return AlertTriangle;
    return ShieldOff;
  }

  ngOnInit(): void {
    this.charger();
  }

  protected charger(): void {
    this.enErreur.set(false);
    this.interdit.set(false);
    this.charge.set(false);
    this.api.coverage().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.rows.set(res.items);
        this.total.set(res.total);
        this.protectedCount.set(res.protectedCount);
        this.uncoveredCount.set(res.uncoveredCount);
        this.charge.set(true);
      },
      error: (err: unknown) => {
        // 403 = la permission manque ; app-zone la NOMME au lieu de laisser un écran muet.
        const statut = (err as { status?: number } | null)?.status;
        if (statut === 403) this.interdit.set(true);
        else this.enErreur.set(true);
        this.charge.set(true);
      },
    });
  }
}
