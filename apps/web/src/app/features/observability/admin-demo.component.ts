import { swallow } from '../../core/error/swallow';
import { DatePipe, DecimalPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, type OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ArrowLeft, FlaskConical, LucideAngularModule, RefreshCw, ShieldCheck } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { ToastService } from '../../shared/ui/toast/toast.service';

/** Miroir de `StatutDemo` côté API (apps/api/src/demo/demo-admin.service.ts). */
interface StatutDemo {
  demo: boolean;
  dernierRafraichissement: { at: string; status: string; detail: string | null; meta: unknown } | null;
  demandeEnAttenteDepuis: string | null;
  compteurs: { vehicules: number; boitiersSimules: number; trajets: number; positions: number; tramesRejeu: number } | null;
}

/**
 * Administration → Environnement de démonstration (SUPER_ADMIN).
 *
 * Sur la DÉMO : le dernier passage de l'importeur, les compteurs, et « rafraîchir maintenant ».
 * Sur la PRODUCTION : la même page dit que ce n'est pas la démo, et où elle vit.
 *
 * Le bouton n'importe rien lui-même : il dépose une DEMANDE dans le journal de la démo, que le
 * script du VPS prend en charge dans le quart d'heure (docs/environnement-demo/EXPLOITATION.md).
 * C'est le prix de la garantie n° 1 du plan : le conteneur de la démo n'a aucune route vers la
 * production.
 */
@Component({
  selector: 'app-admin-demo',
  standalone: true,
  imports: [LucideAngularModule, RouterLink, DatePipe, DecimalPipe],
  template: `
    <div class="page">
      <div class="head">
        <a routerLink="/admin" class="back"><lucide-icon [img]="ArrowLeft" [size]="16" /> Administration</a>
        <h1><lucide-icon [img]="FlaskConical" [size]="24" /> Environnement de démonstration</h1>
        <p class="sub">
          Une pile séparée, faite des mêmes images que la production, alimentée par une copie
          pseudonymisée d'une société réelle et un rejeu de ses trames. Aucune commande n'y atteint un
          véhicule : pas de port boîtiers, pas de passerelle SMS, pas de route vers la production.
        </p>
      </div>

      @if (loading()) {
        <div class="carte vide">Chargement…</div>
      } @else if (statut(); as s) {
        @if (!s.demo) {
          <div class="carte">
            <div class="carte-t"><lucide-icon [img]="ShieldCheck" [size]="16" /> Cette instance est la production</div>
            <p class="carte-p">
              L'environnement de démonstration est une autre instance (<code>demo-tracky</code>), avec sa
              propre base et ses propres comptes. Cette page n'y montre rien depuis ici : ouvrez la même page
              sur la démo pour voir l'état de l'import. Procédure et garanties :
              <code>docs/environnement-demo/EXPLOITATION.md</code>.
            </p>
          </div>
        } @else {
          <div class="grille">
            <div class="carte">
              <div class="carte-t"><lucide-icon [img]="RefreshCw" [size]="16" /> Rafraîchissement depuis la production</div>
              @if (s.dernierRafraichissement; as r) {
                <p class="carte-p">
                  Dernier passage le <strong>{{ r.at | date: 'dd/MM/yyyy HH:mm' }}</strong> —
                  <span [class.ok]="r.status === 'SUCCESS'" [class.ko]="r.status !== 'SUCCESS'">
                    {{ r.status === 'SUCCESS' ? 'réussi' : 'en échec' }}
                  </span>
                </p>
                @if (r.detail) { <p class="carte-p detail">{{ r.detail }}</p> }
              } @else {
                <p class="carte-p">Aucun import encore passé : la démo est vide tant que le premier rafraîchissement n'a pas eu lieu.</p>
              }
              @if (s.demandeEnAttenteDepuis; as d) {
                <p class="carte-p attente">
                  Demande enregistrée le {{ d | date: 'dd/MM HH:mm' }} — prise en charge par le prochain passage du
                  timer (15 min au plus). L'API de démo est arrêtée le temps de l'import (une à deux minutes).
                </p>
              } @else {
                <button type="button" class="btn" (click)="demander()" [disabled]="envoi()">
                  <lucide-icon [img]="RefreshCw" [size]="14" />
                  {{ envoi() ? 'Envoi…' : 'Rafraîchir maintenant' }}
                </button>
                <p class="carte-p note">
                  Rafraîchissement automatique chaque dimanche à 04:00 UTC. À la demande : la base est
                  régénérée depuis la production ; les comptes et leurs droits sont conservés.
                </p>
              }
            </div>

            @if (s.compteurs; as c) {
              <div class="carte">
                <div class="carte-t">Ce que la démo contient</div>
                <dl class="kpis">
                  <div><dt>Véhicules</dt><dd>{{ c.vehicules | number: '1.0-0' : 'fr' }}</dd></div>
                  <div><dt>Boîtiers simulés</dt><dd>{{ c.boitiersSimules | number: '1.0-0' : 'fr' }}</dd></div>
                  <div><dt>Trajets</dt><dd>{{ c.trajets | number: '1.0-0' : 'fr' }}</dd></div>
                  <div><dt>Positions</dt><dd>{{ c.positions | number: '1.0-0' : 'fr' }}</dd></div>
                  <div><dt>Trames de rejeu</dt><dd>{{ c.tramesRejeu | number: '1.0-0' : 'fr' }}</dd></div>
                </dl>
                @if (c.boitiersSimules === 0) {
                  <p class="carte-p ko">Aucun boîtier simulé : le rejeu n'a rien à jouer. Vérifier l'import et le journal de l'API.</p>
                }
              </div>
            }

            <div class="carte">
              <div class="carte-t"><lucide-icon [img]="ShieldCheck" [size]="16" /> Ce que la démo ne peut pas faire</div>
              <ul class="liste">
                <li>Atteindre un véhicule : aucun port boîtiers publié, serveur TCP non démarré, aucune clé SMS.</li>
                <li>Écrire dans la production : l'import lit par un rôle Postgres <code>SELECT</code> seulement, et le vérifie.</li>
                <li>Envoyer quoi que ce soit à un vrai client : aucune adresse réelle en base hormis celles des prospects et la vôtre.</li>
                <li>Facturer, provisionner une SIM, appeler un partenaire ou une IA : les clés sont absentes, les modules inertes.</li>
              </ul>
            </div>

            <div class="carte">
              <div class="carte-t">Un prospect demande une démo</div>
              <ol class="liste">
                <li>Depuis <a routerLink="/users">Utilisateurs</a> de la démo, inviter son adresse en <strong>administrateur</strong> de la société de démonstration.</li>
                <li>Il reçoit le courrier (expéditeur dédié), choisit son mot de passe, se connecte — le bandeau et les encarts font le reste.</li>
                <li>Après la démo : désactiver le compte. Son parcours reste lisible dans l'activité utilisateur.</li>
              </ol>
            </div>
          </div>
        }
      } @else {
        <div class="carte ko">Impossible de lire l'état de la démo.</div>
      }
    </div>
  `,
  styles: [
    `
      .page { padding: 20px; max-width: 1080px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
      .head { display: flex; flex-direction: column; gap: 6px; }
      .back { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-secondary); text-decoration: none; min-height: 44px; }
      .back:hover { color: var(--fg-primary); }
      h1 { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 22px; font-weight: 800; color: var(--fg-primary); }
      .sub { margin: 0; font-size: 13px; line-height: 1.5; color: var(--fg-secondary); max-width: 760px; text-wrap: pretty; }
      .grille { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
      .carte {
        padding: 14px 16px; border-radius: 14px;
        background: var(--bg-secondary); border: 1px solid var(--border-subtle);
        display: flex; flex-direction: column; gap: 8px;
      }
      .carte.vide { color: var(--fg-secondary); font-size: 13px; }
      .carte-t { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 800; color: var(--fg-primary); }
      .carte-p { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--fg-secondary); text-wrap: pretty; }
      .carte-p.detail { font-size: 12px; }
      .carte-p.note { font-size: 11.5px; }
      .carte-p.attente { color: var(--texte-attente); font-weight: 600; }
      .ok { color: var(--texte-succes); font-weight: 700; }
      .ko { color: var(--texte-alerte); font-weight: 700; }
      code { font-size: 11.5px; padding: 1px 5px; border-radius: 6px; background: var(--bg-tertiary); color: var(--fg-primary); }
      .btn {
        align-self: flex-start; display: inline-flex; align-items: center; gap: 8px;
        min-height: 44px; padding: 0 14px; border-radius: 10px; cursor: pointer;
        background: color-mix(in srgb, var(--color-tracky-light) 14%, transparent);
        border: 1px solid color-mix(in srgb, var(--color-tracky-light) 40%, transparent);
        color: var(--texte-succes); font: inherit; font-size: 13px; font-weight: 700;
      }
      .btn:disabled { opacity: .55; cursor: wait; }
      .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin: 0; }
      .kpis div { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 10px; background: var(--bg-tertiary); }
      .kpis dt { font-size: 11px; color: var(--fg-secondary); }
      .kpis dd { margin: 0; font-size: 18px; font-weight: 800; color: var(--fg-primary); }
      .liste { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; line-height: 1.5; color: var(--fg-secondary); }
      .liste a { color: var(--texte-succes); font-weight: 700; }
    `,
  ],
})
export class AdminDemoComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(ToastService);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly FlaskConical = FlaskConical;
  protected readonly RefreshCw = RefreshCw;
  protected readonly ShieldCheck = ShieldCheck;

  protected readonly loading = signal(true);
  protected readonly envoi = signal(false);
  protected readonly statut = signal<StatutDemo | null>(null);

  ngOnInit(): void {
    void this.charger();
  }

  private async charger(): Promise<void> {
    try {
      this.statut.set(await firstValueFrom(this.http.get<StatutDemo>('/api/admin/demo/status')));
    } catch (err) {
      swallow('admin-demo:charger', err);
      this.statut.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  protected async demander(): Promise<void> {
    if (this.envoi()) return;
    this.envoi.set(true);
    try {
      await firstValueFrom(this.http.post('/api/admin/demo/refresh-request', {}));
      this.toast.success('Demande enregistrée', 'Le rafraîchissement sera pris en charge dans le quart d\'heure.');
      await this.charger();
    } catch (err) {
      swallow('admin-demo:demander', err);
      this.toast.error('Demande refusée', 'Impossible d\'enregistrer la demande de rafraîchissement.');
    } finally {
      this.envoi.set(false);
    }
  }
}
