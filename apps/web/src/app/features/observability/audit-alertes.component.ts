import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { ArrowLeft, LucideAngularModule, RefreshCw, Search } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

interface LigneAudit {
  id: string; creeLe: string; type: string; severite: string; titre: string;
  message: string | null; acquittee: boolean; plaque: string | null; flotte: string | null;
  alarmeDecodee: string | null; trameBrute: string | null; imeiTrame: string | null;
  batterie: number | null; vitesseKmh: number | null; contact: boolean | null;
}
interface Cause {
  type: string; alarmeDecodee: string | null; imeiTrame: string | null; plaque: string | null;
  nombre: number; premiere: string; derniere: string;
}

/**
 * Audit des alertes — l'écran qui aurait évité deux heures d'enquête.
 *
 * ── CE QU'IL RÉPARE ──────────────────────────────────────────────────────────────────
 *
 * 41 713 fausses alertes sont parties aux clients. Pour comprendre, il a fallu restaurer
 * une sauvegarde de 140 Mo dans une base temporaire et écrire du SQL à la main. Tout ce
 * qu'il fallait était pourtant déjà stocké : chaque alerte porte la trame brute qui l'a
 * produite. Personne ne pouvait la voir.
 *
 * ── L'ONGLET « CAUSES » D'ABORD, ET C'EST VOULU ──────────────────────────────────────
 *
 * Face à un déluge, la première question n'est pas « quelle est la 1ère alerte ? » mais
 * « d'où viennent-elles toutes ? ». Le regroupement par boîtier d'origine répond en une
 * ligne — et c'est lui qui aurait montré du premier coup 41 468 alertes attribuées à un
 * IMEI ne équipant plus aucun véhicule.
 */
@Component({
  selector: 'app-audit-alertes',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="aa">
      <a routerLink="/admin" class="aa-retour">
        <lucide-icon [img]="ArrowLeft" [size]="15" /> Administration
      </a>
      <h1 class="aa-titre">Audit des alertes</h1>
      <p class="aa-sous">
        Chaque alerte avec la trame que le boîtier a réellement envoyée. C'est elle qui
        tranche : « ac alarm » ou « oil » n'est pas une question d'interprétation.
      </p>

      <div class="aa-filtres">
        <input class="aa-i" [(ngModel)]="plaque" (keyup.enter)="charger()" placeholder="Plaque" />
        <select class="aa-i" [(ngModel)]="type" (change)="charger()">
          <option value="">Tous les types</option>
          @for (t of TYPES; track t) { <option [value]="t">{{ t }}</option> }
        </select>
        <input class="aa-i" type="date" [(ngModel)]="depuis" (change)="charger()" />
        <button class="aa-b" (click)="charger()">
          <lucide-icon [img]="Search" [size]="15" /> Filtrer
        </button>
        <button class="aa-b" (click)="charger()" [disabled]="chargement()">
          <lucide-icon [img]="RefreshCw" [size]="15" /> Rafraîchir
        </button>
      </div>

      <div class="aa-onglets">
        <button class="aa-o" [class.aa-o--on]="vue() === 'causes'" (click)="vue.set('causes')">
          Par cause
        </button>
        <button class="aa-o" [class.aa-o--on]="vue() === 'lignes'" (click)="vue.set('lignes')">
          Alertes ({{ total() }})
        </button>
      </div>

      @if (chargement()) {
        <p class="aa-vide">Chargement…</p>
      } @else if (erreur()) {
        <p class="aa-vide aa-err">{{ erreur() }}</p>
      } @else if (vue() === 'causes') {
        @if (causes().length === 0) {
          <p class="aa-vide">Aucune alerte sur cette période. C'est une bonne nouvelle.</p>
        } @else {
          <div class="aa-scroll">
            <table class="aa-t">
              <thead>
                <tr>
                  <th>Volume</th><th>Type</th><th>Alarme brute</th>
                  <th>Boîtier d'origine</th><th>Véhicule</th><th>Période</th>
                </tr>
              </thead>
              <tbody>
                @for (c of causes(); track c.type + c.imeiTrame + c.plaque) {
                  <tr>
                    <td class="aa-n">{{ c.nombre }}</td>
                    <td>{{ c.type }}</td>
                    <td class="aa-mono">{{ c.alarmeDecodee ?? '—' }}</td>
                    <!-- L'IMEI de la TRAME, pas celui du vehicule : ils different quand
                         un boitier a ete remplace, et c'est ce qui resout l'enquete. -->
                    <td class="aa-mono">{{ c.imeiTrame ?? '—' }}</td>
                    <td>{{ c.plaque ?? '—' }}</td>
                    <td class="aa-p">{{ jour(c.premiere) }} → {{ jour(c.derniere) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      } @else {
        <div class="aa-scroll">
          <table class="aa-t">
            <thead>
              <tr>
                <th>Quand</th><th>Véhicule</th><th>Type</th><th>Batterie</th>
                <th>Trame brute</th>
              </tr>
            </thead>
            <tbody>
              @for (l of lignes(); track l.id) {
                <tr>
                  <td class="aa-p">{{ heure(l.creeLe) }}</td>
                  <td>{{ l.plaque ?? '—' }}</td>
                  <td>
                    {{ l.type }}
                    @if (l.acquittee) { <span class="aa-acq">acquittée</span> }
                  </td>
                  <td [class.aa-bas]="l.batterie !== null && l.batterie < 90">
                    {{ l.batterie !== null ? l.batterie + ' %' : '—' }}
                  </td>
                  <td class="aa-mono aa-trame">{{ l.trameBrute ?? '(pas de trame — alerte créée par un cron)' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (total() > lignes().length) {
          <p class="aa-vide">{{ lignes().length }} sur {{ total() }} — affinez les filtres pour voir le reste.</p>
        }
      }
    </div>
  `,
  styles: [
    `
      .aa { display: flex; flex-direction: column; gap: 10px; padding: 16px }
      .aa-retour { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; font-size: 12px; color: var(--fg-secondary); text-decoration: none }
      .aa-titre { margin: 0; font-size: 22px; font-weight: 700; color: var(--fg-primary) }
      .aa-sous { margin: 0; font-size: 12px; color: var(--fg-secondary); max-width: 70ch }

      .aa-filtres { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px }
      .aa-i, .aa-b {
        min-height: 44px; padding: 0 12px; border-radius: 10px; font-size: 13px;
        border: 1px solid var(--border-strong); background: var(--bg-tertiary); color: var(--fg-primary);
      }
      .aa-b { display: inline-flex; align-items: center; gap: 6px; background: transparent; color: var(--fg-secondary); cursor: pointer }

      .aa-onglets { display: flex; gap: 6px; margin-top: 4px }
      .aa-o {
        min-height: 44px; padding: 0 14px; border-radius: 10px; font-size: 13px; font-weight: 600;
        border: 1px solid var(--border-subtle); background: transparent; color: var(--fg-secondary); cursor: pointer;
      }
      .aa-o--on { border-color: var(--tracky); color: var(--texte-succes); background: color-mix(in srgb, var(--tracky-light) 8%, transparent) }

      /* Les trames sont longues : elles defilent DANS leur boite, la page ne bouge pas. */
      .aa-scroll { overflow-x: auto; border: 1px solid var(--border-subtle); border-radius: 12px }
      .aa-t { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 760px }
      .aa-t th {
        position: sticky; top: 0; text-align: left; padding: 9px 10px; white-space: nowrap;
        background: var(--bg-tertiary); color: var(--fg-tertiary); font-size: 11px;
        text-transform: uppercase; letter-spacing: .04em;
      }
      .aa-t td { padding: 8px 10px; border-top: 1px solid var(--border-subtle); color: var(--fg-secondary); vertical-align: top }
      .aa-mono { font-family: ui-monospace, monospace; font-size: 11px; color: var(--fg-primary) }
      .aa-trame { max-width: 460px; word-break: break-all }
      .aa-n { font-weight: 700; color: var(--fg-primary); font-variant-numeric: tabular-nums }
      .aa-p { white-space: nowrap; color: var(--fg-tertiary) }
      .aa-acq { margin-left: 6px; font-size: 10px; color: var(--fg-tertiary) }
      /* Sous 90 %, l'alerte est credible : la batterie se vide vraiment. */
      .aa-bas { color: var(--danger); font-weight: 700 }
      .aa-vide { margin: 14px 2px; font-size: 12px; color: var(--fg-secondary) }
      .aa-err { color: var(--danger) }
    `,
  ],
})
export class AuditAlertesComponent implements OnInit {
  private readonly http = inject(HttpClient);

  protected readonly TYPES = [
    'POWER_CUT', 'GPS_LOST', 'OVERSPEED', 'SOS', 'LOW_BATTERY',
    'GEOFENCE_EXIT', 'GEOFENCE_ENTER', 'VIBRATION', 'TOW', 'TAMPER',
  ];
  protected plaque = '';
  protected type = '';
  protected depuis = '';

  protected readonly vue = signal<'causes' | 'lignes'>('causes');
  protected readonly lignes = signal<LigneAudit[]>([]);
  protected readonly causes = signal<Cause[]>([]);
  protected readonly total = signal(0);
  protected readonly chargement = signal(false);
  protected readonly erreur = signal('');

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly RefreshCw = RefreshCw;
  protected readonly Search = Search;

  ngOnInit(): void {
    void this.charger();
  }

  protected jour(iso: string): string {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  }

  protected heure(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    const params: Record<string, string> = { taille: '200' };
    if (this.plaque.trim()) params['plaque'] = this.plaque.trim();
    if (this.type) params['type'] = this.type;
    if (this.depuis) params['depuis'] = new Date(this.depuis).toISOString();
    try {
      const [l, c] = await Promise.all([
        firstValueFrom(
          this.http.get<{ total: number; lignes: LigneAudit[] }>('/api/admin/audit-alertes', { params }),
        ),
        firstValueFrom(this.http.get<Cause[]>('/api/admin/audit-alertes/causes', { params })),
      ]);
      this.lignes.set(l.lignes);
      this.total.set(l.total);
      this.causes.set(c);
    } catch {
      this.erreur.set("Chargement impossible — cet écran demande un accès super-administrateur.");
    } finally {
      this.chargement.set(false);
    }
  }
}
