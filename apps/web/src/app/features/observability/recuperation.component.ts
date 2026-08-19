import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { ArrowLeft, LucideAngularModule, RefreshCw } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

interface LigneRecuperation {
  id: string;
  famille: 'Trajets' | 'Lieux';
  libelle: string;
  role: string;
  attendu: number | null;
  obtenu: number;
  taux: number | null;
  manque: string | null;
}

/**
 * Ce que nos services ont récupéré — trajets et lieux, côte à côte.
 *
 * ── POURQUOI CET ÉCRAN EXISTE ────────────────────────────────────────────────────────
 *
 * L'application enrichit chaque trajet par plusieurs couches indépendantes : analyse, limites
 * de vitesse, consommation, récit, stations, géocodage. Chacune peut échouer en silence.
 *
 * Ce que ça a coûté : pendant des semaines, 98,8 % du cache des limites de vitesse était marqué
 * « inconnu » à tort. Les trois quarts des trajets ne pouvaient donc porter aucun excès, et le
 * score de conduite moyen affichait 93,4/100 — un chiffre qui ne mesurait rien. Aucun écran ne
 * comparait « ce qu'on aurait dû enrichir » à « ce qu'on a enrichi ».
 *
 * ── CE QUE L'ÉCRAN REFUSE DE FAIRE ───────────────────────────────────────────────────
 *
 * Il n'affiche jamais un taux qu'il n'a pas mesuré. Les lieux de flotte sont saisis à la main :
 * il n'existe pas de « nombre attendu », donc pas de barre — un volume nu. Un tableau de bord
 * qui invente un dénominateur pour remplir une barre rassure à tort, et c'est exactement le
 * défaut qu'on répare ici.
 */
@Component({
  selector: 'app-recuperation',
  standalone: true,
  imports: [LucideAngularModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rc">
      <a routerLink="/admin" class="rc-retour">
        <lucide-icon [img]="ArrowLeft" [size]="15" /> Administration
      </a>
      <h1 class="rc-titre">Ce que nos services ont recupere</h1>
      <p class="rc-sous">
        Pour chaque couche d'enrichissement : ce qui etait eligible, ce qui a abouti, ce qui
        manque. Tout est compte en base — aucune estimation, aucune moyenne.
      </p>

      <div class="rc-actions">
        <button class="rc-b" (click)="charger()" [disabled]="chargement()">
          <lucide-icon [img]="RefreshCw" [size]="15" /> Rafraichir
        </button>
        @if (mesureLe(); as m) { <span class="rc-date">mesure a {{ heure(m) }}</span> }
      </div>

      @if (chargement()) {
        <p class="rc-vide">Chargement…</p>
      } @else if (erreur()) {
        <p class="rc-vide rc-err">{{ erreur() }}</p>
      } @else {
        @for (famille of familles(); track famille.nom) {
          <h2 class="rc-famille">{{ famille.nom }}</h2>
          @for (l of famille.lignes; track l.id) {
            <article class="rc-carte">
              <div class="rc-tete">
                <span class="rc-libelle">{{ l.libelle }}</span>
                @if (l.taux !== null) {
                  <span class="rc-taux" [class.rc-taux--bas]="l.taux < 60">{{ l.taux }} %</span>
                } @else {
                  <span class="rc-volume">{{ l.obtenu.toLocaleString('fr-FR') }}</span>
                }
              </div>

              <!-- Pas de barre sans denominateur mesure : une jauge inventee ment. -->
              @if (l.taux !== null) {
                <div class="rc-jauge" role="img" [attr.aria-label]="l.taux + ' pour cent'">
                  <span class="rc-jauge-remplie" [class.rc-jauge-remplie--basse]="l.taux < 60"
                        [style.width.%]="l.taux"></span>
                </div>
                <p class="rc-chiffres">
                  {{ l.obtenu.toLocaleString('fr-FR') }} sur {{ l.attendu!.toLocaleString('fr-FR') }}
                  @if (l.manque) { <span class="rc-manque">· {{ l.manque }}</span> }
                </p>
              }

              <p class="rc-role">{{ l.role }}</p>
            </article>
          }
        }
      }
    </div>
  `,
  styles: [
    `
      .rc { display: flex; flex-direction: column; gap: 10px; padding: 16px }
      .rc-retour { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; font-size: 12px; color: var(--fg-secondary); text-decoration: none }
      .rc-titre { margin: 0; font-size: 22px; font-weight: 700; color: var(--fg-primary) }
      .rc-sous { margin: 0; font-size: 12px; color: var(--fg-secondary); max-width: 70ch }

      .rc-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px }
      .rc-b {
        display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 12px;
        border-radius: 10px; font-size: 13px; cursor: pointer;
        border: 1px solid var(--border-strong); background: transparent; color: var(--fg-secondary);
      }
      .rc-date { font-size: 11px; color: var(--fg-tertiary) }

      .rc-famille { margin: 14px 0 2px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--fg-tertiary) }

      .rc-carte {
        display: flex; flex-direction: column; gap: 7px; padding: 12px;
        border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--bg-secondary);
      }
      .rc-tete { display: flex; align-items: baseline; justify-content: space-between; gap: 10px }
      .rc-libelle { font-size: 14px; font-weight: 600; color: var(--fg-primary) }
      .rc-taux { font-size: 18px; font-weight: 700; color: var(--texte-succes); font-variant-numeric: tabular-nums }
      .rc-taux--bas { color: var(--danger) }
      .rc-volume { font-size: 18px; font-weight: 700; color: var(--fg-primary); font-variant-numeric: tabular-nums }

      .rc-jauge { height: 7px; border-radius: 999px; background: var(--bg-tertiary); overflow: hidden }
      .rc-jauge-remplie { display: block; height: 100%; border-radius: 999px; background: var(--tracky) }
      .rc-jauge-remplie--basse { background: var(--danger) }

      .rc-chiffres { margin: 0; font-size: 12px; color: var(--fg-secondary); font-variant-numeric: tabular-nums }
      .rc-manque { color: var(--danger) }
      .rc-role { margin: 0; font-size: 12px; color: var(--fg-tertiary); line-height: 1.45 }

      .rc-vide { margin: 14px 2px; font-size: 12px; color: var(--fg-secondary) }
      .rc-err { color: var(--danger) }
    `,
  ],
})
export class RecuperationComponent implements OnInit {
  private readonly http = inject(HttpClient);

  protected readonly lignes = signal<LigneRecuperation[]>([]);
  protected readonly mesureLe = signal<string | null>(null);
  protected readonly chargement = signal(false);
  protected readonly erreur = signal('');

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly RefreshCw = RefreshCw;

  /** Regroupe pour l'affichage, en conservant l'ordre voulu par le serveur. */
  protected readonly familles = computed(() => {
    const ordre: LigneRecuperation['famille'][] = ['Trajets', 'Lieux'];
    return ordre
      .map((nom) => ({ nom, lignes: this.lignes().filter((l) => l.famille === nom) }))
      .filter((f) => f.lignes.length > 0);
  });

  ngOnInit(): void {
    void this.charger();
  }

  protected heure(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await firstValueFrom(
        this.http.get<{ lignes: LigneRecuperation[]; mesureLe: string }>('/api/admin/recuperation'),
      );
      this.lignes.set(r.lignes);
      this.mesureLe.set(r.mesureLe);
    } catch {
      this.erreur.set("Chargement impossible — cet ecran demande un acces super-administrateur.");
    } finally {
      this.chargement.set(false);
    }
  }
}
