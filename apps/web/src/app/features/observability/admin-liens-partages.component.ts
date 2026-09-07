import { HttpClient, type HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ArrowLeft, Link2, LucideAngularModule, RefreshCw, ShieldOff, Timer } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { PLAFOND_VIE_LIEN_MS } from '@vizyo/tracky-shared';
import type {
  DureeProlongation,
  EtatLienPartage,
  LienPartageAdminDto,
  TypeLienPartage,
  VueLiensPartagesDto,
} from '@vizyo/tracky-shared';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { corpsErreur } from '../../core/interceptors/auth.interceptor';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LES ACCÈS PUBLICS OUVERTS — TOUTES SOCIÉTÉS, LES DEUX MÉCANISMES
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le produit ouvre des URL publiques par deux portes : le PARTAGE DE TRAJET (un replay envoyé
 * à un conducteur, un assureur, un client) et le SUIVI DE LIVRAISON (une mission suivie par un
 * dépôt). Chacune avait son écran de surveillance, par société. Aucune ne répondait à la
 * question du propriétaire : « qu'est-ce qui est ouvert, en ce moment, chez TOUS mes clients ? »
 *
 * ⚠️ UN LIEN QU'ON NE VOIT QU'EN PENSANT À ALLER LE CHERCHER — dans la bonne société, sur le
 * bon écran — est, en pratique, un lien qu'on ne voit pas. C'est la définition d'un accès
 * fantôme, et c'est ce que cet écran existe pour empêcher.
 *
 * ── CE QUE L'ÉCRAN SAIT, ET CE QU'IL DIT NE PAS SAVOIR ───────────────────────────────────
 *
 * Il ne sait PAS qui a ouvert un lien, et ce n'est pas une lacune : un destinataire n'a pas de
 * compte, il n'y a personne à nommer. L'écran l'écrit noir sur blanc plutôt que de laisser
 * croire qu'il nomme des visiteurs. Ce qu'il sait, et qui suffit à décider : qui a CRÉÉ
 * l'accès, combien de fois il a été consulté, quand, et une empreinte tronquée de l'appelant.
 */
@Component({
  selector: 'app-admin-liens-partages',
  standalone: true,
  imports: [LucideAngularModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lp">
      <a routerLink="/admin" class="lp-retour">
        <lucide-icon [img]="ArrowLeft" [size]="15" /> Administration
      </a>

      <h1 class="lp-titre">Liens de partage ouverts</h1>
      <p class="lp-sous">
        Tous les accès publics du parc, les deux mécanismes réunis : partages de trajet et
        suivis de livraison. Un lien vit sans compte et sans mot de passe — la seule protection
        est qu'il expire, et la seule garantie qu'il n'a pas été oublié est cette liste.
      </p>

      <div class="lp-actions">
        <button class="lp-b" (click)="charger()" [disabled]="chargement()">
          <lucide-icon [img]="RefreshCw" [size]="14" [class.lp-spin]="chargement()" />
          {{ chargement() ? 'Chargement…' : 'Rafraîchir' }}
        </button>
      </div>

      @if (erreur(); as e) {
        <p class="lp-erreur">{{ e }}</p>
      }

      @if (vue(); as v) {
        <!-- ── LES COMPTEURS DE TÊTE ── -->
        <div class="lp-resume">
          <div class="lp-kpi lp-kpi--fort">
            <span class="lp-kpi-v">{{ v.resume.actifs }}</span>
            <span class="lp-kpi-l">actifs</span>
          </div>
          <div class="lp-kpi">
            <span class="lp-kpi-v">{{ v.resume.actifsConsultes }}</span>
            <span class="lp-kpi-l">déjà consultés</span>
          </div>
          <div class="lp-kpi" [class.lp-kpi--chaud]="v.resume.actifsExpirantSous24h > 0">
            <span class="lp-kpi-v">{{ v.resume.actifsExpirantSous24h }}</span>
            <span class="lp-kpi-l">expirent sous 24 h</span>
          </div>
          <div class="lp-kpi">
            <span class="lp-kpi-v">{{ v.resume.societesConcernees }}</span>
            <span class="lp-kpi-l">sociétés concernées</span>
          </div>
          <div class="lp-kpi lp-kpi--pale">
            <span class="lp-kpi-v">{{ v.resume.expires }}</span>
            <span class="lp-kpi-l">expirés</span>
          </div>
          <div class="lp-kpi lp-kpi--pale">
            <span class="lp-kpi-v">{{ v.resume.revoques }}</span>
            <span class="lp-kpi-l">révoqués</span>
          </div>
        </div>

        <!-- ── FILTRES ── -->
        <div class="lp-filtres">
          @for (f of ETATS; track f.cle) {
            <button class="lp-chip" [class.lp-chip--on]="etat() === f.cle" (click)="basculerEtat(f.cle)">
              {{ f.libelle }}
            </button>
          }
          <span class="lp-sep"></span>
          @for (f of TYPES; track f.cle) {
            <button class="lp-chip" [class.lp-chip--on]="type() === f.cle" (click)="basculerType(f.cle)">
              {{ f.libelle }}
            </button>
          }
        </div>

        @if (v.tronquee) {
          <p class="lp-tronque">
            Liste bornée à 500 lignes : affinez les filtres pour voir le reste. Les compteurs
            ci-dessus, eux, portent sur la totalité.
          </p>
        }

        <!-- ⚠️ LA LIMITE, ÉCRITE. Sans cette phrase, la colonne << Ouvertures >> laisserait
             croire qu'on sait QUI a ouvert. On ne le sait pas, et c'est voulu. -->
        <p class="lp-note">
          <lucide-icon [img]="ShieldOff" [size]="13" />
          <!-- ⚠️ LE TEXTE DOIT ÊTRE UN SEUL ELEMENT FLEXIBLE. .lp-note est en display: flex :
               sans cette enveloppe, chaque noeud de texte ET le strong deviennent des elements
               distincts, poses cote a cote — la phrase sortait en trois colonnes. Constate sur
               la capture de production du 2026-09-07. -->
          <span>
            Les destinataires n'ont pas de compte : personne à nommer. On sait qui a
            <strong>créé</strong> l'accès, combien de fois il a été consulté et depuis quelle
            empreinte tronquée — jamais l'adresse complète, jamais l'identité du visiteur.
          </span>
        </p>

        @if (lignes().length === 0) {
          <p class="lp-vide">Aucun lien ne correspond à ce filtre.</p>
        } @else {
          <div class="lp-table-wrap">
            <table class="lp-table">
              <thead>
                <tr>
                  <th>Société</th>
                  <th>Lien</th>
                  <th>Créé par</th>
                  <th class="lp-num">Ouvertures</th>
                  <th>Échéance</th>
                  <th>État</th>
                  <th class="lp-th-act">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (l of lignes(); track l.type + l.id) {
                  <tr [class.lp-tr--mort]="l.etat !== 'ACTIF'">
                    <td>{{ l.fleetNom ?? '—' }}</td>
                    <td>
                      <span class="lp-type" [class.lp-type--mission]="l.type === 'MISSION'">
                        {{ l.type === 'TRAJET' ? 'Trajet' : 'Livraison' }}
                      </span>
                      <span class="lp-cible mono">{{ cible(l) }}</span>
                    </td>
                    <td>{{ l.creePar ?? 'compte supprimé' }}</td>
                    <td class="lp-num">
                      @if (l.nbOuvertures === 0) {
                        <span class="lp-jamais">jamais</span>
                      } @else {
                        <strong>{{ l.nbOuvertures }}</strong>
                        <span class="lp-detail">
                          dernière {{ relatif(l.derniereOuvertureAt) }}
                          @if (l.derniereOuvertureDe) { · {{ l.derniereOuvertureDe }} }
                        </span>
                      }
                    </td>
                    <td>
                      {{ dateCourte(l.expireAt) }}
                      <span class="lp-detail">{{ echeance(l) }}</span>
                      @if (l.nbProlongations > 0) {
                        <!-- ⚠️ UNE ÉCHÉANCE REPOUSSÉE DOIT SE VOIR. Sans cette mention, un lien
                             prolongé trois fois est indiscernable d'un lien récent. -->
                        <span class="lp-prolonge">
                          <lucide-icon [img]="Timer" [size]="11" />
                          prolongé {{ l.nbProlongations }}×
                        </span>
                      }
                    </td>
                    <td>
                      <span class="lp-etat" [class]="'lp-etat--' + l.etat.toLowerCase()">
                        {{ libelleEtat(l.etat) }}
                      </span>
                    </td>
                    <td class="lp-th-act">
                      @if (l.etat !== 'REVOQUE') {
                        <span class="lp-prolong-grp">
                          @for (d of DUREES; track d.cle) {
                            <!-- ⚠️ LA CONTRAINTE SE VOIT AVANT LE CLIC. Le serveur refuse au-dela
                                 de 30 jours de vie totale ; laisser le bouton actif ferait
                                 decouvrir la regle par un echec, alors qu'elle est calculable
                                 ici avec les memes donnees. -->
                            <button class="lp-mini" [disabled]="occupe() === cleDe(l) || !possible(l, d.cle)"
                                    (click)="prolonger(l, d.cle)"
                                    [attr.title]="possible(l, d.cle)
                                      ? 'Repousser l’échéance de ' + d.libelle
                                      : 'Impossible : un lien ne peut pas vivre plus de 30 jours après sa création.'">
                              +{{ d.court }}
                            </button>
                          }
                        </span>
                      }
                      @if (l.etat === 'ACTIF') {
                        <button class="lp-mini lp-mini--danger" [disabled]="occupe() === cleDe(l)"
                                (click)="revoquer(l)">
                          Révoquer
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      } @else if (!chargement() && !erreur()) {
        <p class="lp-vide">Aucun lien de partage n'a jamais été créé.</p>
      }
    </div>
  `,
  styles: [`
    /* ⚠️ AUCUN ACCENT GRAVE DANS CE BLOC : on est dans un litteral gabarit, un seul le
       refermerait et la compilation echouerait loin d'ici sans nommer la cause. */
    .lp { padding: 20px 22px 60px; max-width: 1400px; }
    .lp-retour {
      display: inline-flex; align-items: center; gap: 6px; min-height: 44px;
      color: var(--fg-tertiary); font-size: 13px; font-weight: 600; text-decoration: none;
    }
    .lp-retour:hover { color: var(--texte-succes); }
    .lp-titre { margin: 6px 0 4px; font-size: 26px; font-weight: 800; letter-spacing: -.02em; }
    .lp-sous { margin: 0 0 18px; max-width: 78ch; color: var(--fg-secondary); font-size: 13.5px; line-height: 1.55; }

    .lp-actions { display: flex; gap: 8px; margin-bottom: 16px; }
    .lp-b {
      display: inline-flex; align-items: center; gap: 7px; min-height: 44px; padding: 0 14px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 12px;
      color: var(--fg-primary); font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .lp-b:hover:not(:disabled) { border-color: var(--border-strong); }
    .lp-b:disabled { opacity: .55; cursor: default; }
    .lp-spin { animation: lp-rot 1s linear infinite; }
    @keyframes lp-rot { to { transform: rotate(360deg); } }

    .lp-erreur { padding: 10px 12px; border-radius: 10px; background: var(--bg-tertiary); color: var(--texte-alerte); font-size: 13px; }

    .lp-resume { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
    .lp-kpi {
      display: flex; flex-direction: column; gap: 2px; min-width: 120px; padding: 10px 14px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 12px;
    }
    /* Le chiffre ne se tronque JAMAIS : c'est la raison d'etre de la carte. */
    .lp-kpi-v { font-size: 22px; font-weight: 800; line-height: 1; white-space: nowrap; }
    .lp-kpi-l { font-size: 11px; font-weight: 600; color: var(--fg-tertiary); }
    .lp-kpi--fort .lp-kpi-v { color: var(--texte-succes); }
    .lp-kpi--chaud .lp-kpi-v { color: var(--texte-orange); }
    .lp-kpi--pale .lp-kpi-v { color: var(--fg-tertiary); }

    .lp-filtres { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; }
    .lp-chip {
      min-height: 44px; padding: 0 12px; border-radius: 999px; cursor: pointer;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      color: var(--fg-secondary); font-size: 12.5px; font-weight: 600;
    }
    .lp-chip--on { border-color: var(--texte-succes); color: var(--texte-succes); }
    .lp-sep { width: 1px; height: 22px; background: var(--border-subtle); margin: 0 4px; }

    .lp-note {
      display: flex; align-items: flex-start; gap: 8px; margin: 0 0 14px; padding: 10px 12px;
      background: var(--bg-tertiary); border-radius: 10px;
      color: var(--fg-secondary); font-size: 12.5px; line-height: 1.5; max-width: 92ch;
    }
    .lp-note lucide-icon { flex-shrink: 0; margin-top: 2px; color: var(--fg-tertiary); }
    .lp-tronque { margin: 0 0 10px; color: var(--texte-orange); font-size: 12.5px; }
    .lp-vide { padding: 24px 0; color: var(--fg-tertiary); font-size: 13.5px; }

    /* Le tableau defile DANS son cadre : la page, elle, ne defile jamais lateralement. */
    .lp-table-wrap { overflow-x: auto; border: 1px solid var(--border-subtle); border-radius: 14px; }
    .lp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .lp-table th {
      position: sticky; top: 0; z-index: 1; padding: 10px 12px; text-align: left;
      background: var(--bg-secondary); color: var(--fg-tertiary);
      font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
      border-bottom: 1px solid var(--border-subtle); white-space: nowrap;
    }
    .lp-table td { padding: 10px 12px; border-bottom: 1px solid var(--border-subtle); vertical-align: top; }
    .lp-table tr:last-child td { border-bottom: none; }
    .lp-tr--mort { opacity: .62; }
    .lp-num { text-align: right; }
    .lp-th-act { text-align: right; white-space: nowrap; }

    .lp-type {
      display: inline-block; margin-right: 8px; padding: 2px 7px; border-radius: 6px;
      background: var(--bg-tertiary); color: var(--fg-secondary);
      font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em;
    }
    .lp-type--mission { color: var(--texte-lime); }
    .lp-cible { font-family: var(--font-mono); font-size: 12px; }
    .lp-detail { display: block; margin-top: 2px; color: var(--fg-tertiary); font-size: 11px; }
    .lp-jamais { color: var(--fg-tertiary); font-style: italic; }
    .lp-prolonge {
      display: inline-flex; align-items: center; gap: 3px; margin-top: 3px;
      color: var(--texte-orange); font-size: 11px; font-weight: 700;
    }

    .lp-etat { padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; white-space: nowrap; }
    .lp-etat--actif { background: color-mix(in srgb, var(--tracky-light) 12%, transparent); color: var(--texte-succes); }
    .lp-etat--expire { background: var(--bg-tertiary); color: var(--fg-tertiary); }
    .lp-etat--revoque { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--texte-alerte); }

    .lp-prolong-grp { display: inline-flex; gap: 4px; margin-right: 6px; }
    .lp-mini {
      min-height: 44px; padding: 0 10px; border-radius: 9px; cursor: pointer;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      color: var(--fg-primary); font-size: 12px; font-weight: 700;
    }
    .lp-mini:hover:not(:disabled) { border-color: var(--texte-succes); color: var(--texte-succes); }
    .lp-mini:disabled { opacity: .45; cursor: default; }
    .lp-mini--danger { color: var(--texte-alerte); }
    .lp-mini--danger:hover:not(:disabled) { border-color: var(--texte-alerte); color: var(--texte-alerte); }

    @media (max-width: 720px) {
      .lp { padding: 14px 12px 60px; }
      .lp-titre { font-size: 21px; }
    }
  `],
})
export class AdminLiensPartagesComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(ToastService);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly RefreshCw = RefreshCw;
  protected readonly ShieldOff = ShieldOff;
  protected readonly Timer = Timer;
  protected readonly Link2 = Link2;

  protected readonly ETATS: { cle: EtatLienPartage | null; libelle: string }[] = [
    { cle: null, libelle: 'Tous' },
    { cle: 'ACTIF', libelle: 'Actifs' },
    { cle: 'EXPIRE', libelle: 'Expirés' },
    { cle: 'REVOQUE', libelle: 'Révoqués' },
  ];
  protected readonly TYPES: { cle: TypeLienPartage | null; libelle: string }[] = [
    { cle: null, libelle: 'Les deux' },
    { cle: 'TRAJET', libelle: 'Trajets' },
    { cle: 'MISSION', libelle: 'Livraisons' },
  ];
  protected readonly DUREES: { cle: DureeProlongation; libelle: string; court: string }[] = [
    { cle: 'HOUR_1', libelle: '1 heure', court: '1 h' },
    { cle: 'HOUR_24', libelle: '24 heures', court: '24 h' },
    { cle: 'DAY_7', libelle: '7 jours', court: '7 j' },
  ];

  protected readonly vue = signal<VueLiensPartagesDto | null>(null);
  protected readonly chargement = signal(false);
  protected readonly erreur = signal<string | null>(null);
  protected readonly etat = signal<EtatLienPartage | null>('ACTIF');
  protected readonly type = signal<TypeLienPartage | null>(null);
  /** La clé de la ligne en cours d'action — désarme ses boutons, pas ceux des autres. */
  protected readonly occupe = signal<string | null>(null);

  /**
   * ⚠️ LE FILTRAGE EST REFAIT ICI, en plus du serveur. Le serveur borne la lecture ; ce filtre
   * rend la bascule d'un état INSTANTANÉE, sans aller-retour. Les deux appliquent la même
   * règle : si elles divergeaient, l'écran mentirait entre deux chargements.
   */
  protected readonly lignes = computed(() => {
    const v = this.vue();
    if (!v) return [];
    const e = this.etat();
    const t = this.type();
    return v.liens.filter((l) => (!e || l.etat === e) && (!t || l.type === t));
  });

  ngOnInit(): void {
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set(null);
    try {
      const v = await firstValueFrom(this.http.get<VueLiensPartagesDto>('/api/admin/liens-partages'));
      this.vue.set(v);
    } catch {
      this.erreur.set("La liste n'a pas pu être chargée. Réessayez dans un instant.");
    } finally {
      this.chargement.set(false);
    }
  }

  protected cleDe(l: LienPartageAdminDto): string {
    return l.type + l.id;
  }

  protected basculerEtat(cle: EtatLienPartage | null): void {
    this.etat.set(cle);
  }

  protected basculerType(cle: TypeLienPartage | null): void {
    this.type.set(cle);
  }

  protected libelleEtat(e: EtatLienPartage): string {
    return e === 'ACTIF' ? 'Actif' : e === 'EXPIRE' ? 'Expiré' : 'Révoqué';
  }

  protected cible(l: LienPartageAdminDto): string {
    const bouts = [l.cible.reference, l.cible.plaque].filter(Boolean);
    if (l.cible.debutAt) bouts.push(this.dateCourte(l.cible.debutAt));
    return bouts.length ? bouts.join(' · ') : 'cible supprimée';
  }

  protected dateCourte(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  /** « dans 3 h », « il y a 2 j » — l'échéance se lit en durée, pas en date. */
  protected echeance(l: LienPartageAdminDto): string {
    const delta = Date.parse(l.expireAt) - Date.now();
    if (l.etat === 'REVOQUE') return 'coupé le ' + this.dateCourte(l.revoqueAt);
    return delta > 0 ? 'dans ' + this.duree(delta) : 'expiré depuis ' + this.duree(-delta);
  }

  protected relatif(iso: string | null): string {
    if (!iso) return '—';
    return 'il y a ' + this.duree(Date.now() - Date.parse(iso));
  }

  /**
   * Cette prolongation-là passerait-elle ?
   *
   * ⚠️ LA MÊME RÈGLE QUE LE SERVEUR, PAS UNE APPROXIMATION. Le plafond (`PLAFOND_VIE_LIEN_MS`)
   * et la base de calcul (`max(maintenant, échéance)`) viennent du contrat partagé : si les
   * deux divergeaient, le bouton promettrait ce que l'API refuse — ou l'inverse, ce qui est
   * pire, car on cesserait d'offrir une prolongation légitime.
   *
   * Le serveur reste l'autorité : ceci ne fait qu'éviter un aller-retour et une erreur.
   */
  protected possible(l: LienPartageAdminDto, duree: DureeProlongation): boolean {
    const ms = duree === 'HOUR_1' ? 3600_000 : duree === 'DAY_7' ? 7 * 24 * 3600_000 : 24 * 3600_000;
    const base = Math.max(Date.now(), Date.parse(l.expireAt));
    return base + ms <= Date.parse(l.creeAt) + PLAFOND_VIE_LIEN_MS;
  }

  private duree(ms: number): string {
    const min = Math.round(ms / 60000);
    if (min < 60) return Math.max(1, min) + ' min';
    const h = Math.round(min / 60);
    if (h < 48) return h + ' h';
    return Math.round(h / 24) + ' j';
  }

  /**
   * PROLONGER — repousser l'échéance.
   *
   * ⚠️ AUCUNE CONFIRMATION : le geste est réversible d'un clic (« Révoquer » juste à côté) et
   * borné par le serveur (plafond de 30 jours de vie totale). Demander confirmation pour un
   * geste réversible apprend à cliquer « oui » sans lire — et affaiblit la confirmation de la
   * révocation, qui, elle, ne se défait pas.
   */
  protected async prolonger(l: LienPartageAdminDto, duree: DureeProlongation): Promise<void> {
    this.occupe.set(this.cleDe(l));
    try {
      const maj = await firstValueFrom(
        this.http.post<LienPartageAdminDto>(`/api/admin/liens-partages/${l.type}/${l.id}/prolonger`, { duree }),
      );
      this.remplacer(maj);
      this.toast.success('Échéance repoussée', `Ce lien expire maintenant ${this.echeance(maj)}.`);
    } catch (e) {
      /**
       * ⚠️ ON SERT LE MESSAGE DU SERVEUR, pas un « une erreur est survenue ».
       *
       * Les deux refus possibles — plafond de vie atteint, lien révoqué — expliquent quoi
       * faire à la place (« créez-en un nouveau »). Les remplacer par un message générique
       * transformerait une règle compréhensible en mur.
       */
      const corps = corpsErreur(e as HttpErrorResponse);
      const message = typeof corps?.['message'] === 'string' ? corps['message'] : null;
      this.toast.error(
        corps?.code === 'PLAFOND_VIE_ATTEINT' ? 'Plafond de vie atteint' : 'Prolongation refusée',
        message ?? "Le lien n'a pas pu être prolongé.",
      );
    } finally {
      this.occupe.set(null);
    }
  }

  /**
   * RÉVOQUER — couper l'accès.
   *
   * ⚠️ CONFIRMATION EXIGÉE, contrairement à la prolongation : une révocation ne se défait pas
   * (le serveur refuse de prolonger un lien révoqué, par conception), et le destinataire perd
   * l'accès sans être prévenu. Un clic de trop doit être rattrapable ; celui-ci ne l'est pas.
   */
  protected async revoquer(l: LienPartageAdminDto): Promise<void> {
    const quoi = this.cible(l);
    if (!confirm(`Couper définitivement ce lien (${quoi}) ?\n\nLe destinataire perdra l'accès immédiatement, sans notification. Un lien révoqué ne se prolonge pas : il faudra en créer un nouveau.`)) return;

    this.occupe.set(this.cleDe(l));
    try {
      await firstValueFrom(this.http.delete<void>(`/api/admin/liens-partages/${l.type}/${l.id}`));
      await this.charger();
      this.toast.success('Lien coupé', 'Il ne répond plus.');
    } catch {
      this.toast.error('Révocation impossible', "Le lien n'a pas pu être coupé. Réessayez.");
    } finally {
      this.occupe.set(null);
    }
  }

  /**
   * Remplace une ligne SANS recharger toute la vue.
   *
   * ⚠️ Les compteurs de tête, eux, deviennent périmés — une prolongation peut faire sortir un
   * lien de « expirent sous 24 h ». On les recalcule donc localement plutôt que de laisser un
   * chiffre faux à l'écran jusqu'au prochain rafraîchissement.
   */
  private remplacer(maj: LienPartageAdminDto): void {
    const v = this.vue();
    if (!v) return;
    const liens = v.liens.map((l) => (l.id === maj.id && l.type === maj.type ? maj : l));
    const maintenant = Date.now();
    const actifs = liens.filter((l) => l.etat === 'ACTIF');
    this.vue.set({
      ...v,
      liens,
      resume: {
        ...v.resume,
        actifs: actifs.length,
        actifsConsultes: actifs.filter((l) => l.nbOuvertures > 0).length,
        actifsExpirantSous24h: actifs.filter((l) => Date.parse(l.expireAt) - maintenant < 24 * 3600_000).length,
        expires: liens.filter((l) => l.etat === 'EXPIRE').length,
        revoques: liens.filter((l) => l.etat === 'REVOQUE').length,
      },
    });
  }
}
