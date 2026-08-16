import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { Car, Eye, LogOut, LucideAngularModule, ShieldCheck, Unlock } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import { AuthService } from '../../core/services/auth.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { DriverPrivacyPanelComponent } from './driver-privacy-panel.component';

/**
 * Espace dépôt (2026-08) — une mission telle que son CONDUCTEUR la voit.
 * `depotWatching` est décidé côté serveur : c'est une obligation d'information, elle ne
 * doit pas dépendre d'un calcul côté client qu'on pourrait retirer par mégarde.
 */
interface MissionConducteur {
  id: string;
  ref: string;
  origin: string;
  destination: string;
  startAt: string;
  endAt: string;
  plate: string;
  depotWatching: boolean;
}

/**
 * feat/comptes-conducteurs (6) — espace conducteur « Mes véhicules ».
 *
 * Shell FOCALISÉ (hors app d'admin) : le rôle DRIVER est redirigé ici par
 * `driverAwayFromDashboardGuard`. Le conducteur voit uniquement les véhicules de son périmètre
 * (l'API `/vehicles` est scopée serveur) et peut en déverrouiller un (flux proximité in-app,
 * réutilise l'écran `/driver/unlock?vehicleId=`).
 */
@Component({
  selector: 'app-driver-home',
  standalone: true,
  imports: [LucideAngularModule, RouterLink, DriverPrivacyPanelComponent],
  template: `
    <div class="min-h-dvh bg-bg-primary text-fg-primary">
      <header class="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div class="flex items-center gap-2">
          <span class="w-8 h-8 rounded-lg bg-tracky/15 flex items-center justify-center">
            <lucide-icon [img]="Car" [size]="18" class="text-tracky-light" />
          </span>
          <div>
            <div class="text-sm font-semibold leading-tight">Mes véhicules</div>
            <div class="text-[11.5px] text-fg-secondary leading-tight">{{ email() }}</div>
          </div>
        </div>
        <button (click)="logout()" class="dh-deco">
          <lucide-icon [img]="LogOut" [size]="16" /> Déconnexion
        </button>
      </header>

      <main class="p-4 max-w-md mx-auto">
        <!-- Espace dépôt (2026-08) — la mission du jour, avec sa mention d'information.
             Placée AVANT la liste des véhicules : c'est ce qui structure la journée du
             conducteur, et la mention doit être vue sans avoir à faire défiler. -->
        @for (m of missions(); track m.id) {
          <article class="mb-3 rounded-[14px] border border-border-subtle bg-bg-secondary p-3.5">
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono text-[11.5px] font-semibold text-fg-secondary">{{ m.ref }}</span>
              <span class="text-[11.5px] font-semibold text-fg-secondary">{{ heure(m.startAt) }} → {{ heure(m.endAt) }}</span>
            </div>
            <p class="mt-1 text-sm font-semibold leading-snug">{{ m.origin }} → {{ m.destination }}</p>
            <p class="mt-0.5 font-mono text-[11.5px] text-fg-secondary">{{ m.plate }}</p>

            @if (m.depotWatching) {
              <!-- ⚠️ OBLIGATION D'INFORMATION, pas une politesse : le conducteur doit
                   savoir qu'un tiers voit sa position pendant la mission. C'est la
                   condition de conformité du dispositif (A2 § 3.4). Le drapeau est
                   décidé côté serveur — ce bloc ne fait que le rendre visible. -->
              <p class="dh-mention">
                <lucide-icon [img]="Eye" [size]="14" class="mt-px shrink-0" />
                <span>Le dépôt destinataire suit la position de ce véhicule pendant le créneau de la mission.</span>
              </p>
            }
          </article>
        }

        @if (loading()) {
          <div class="py-16 flex justify-center">
            <span class="w-6 h-6 border-2 border-fg-secondary border-t-tracky-light rounded-full animate-spin"></span>
          </div>
        } @else if (erreur()) {
          <!--
            ⚠️ UNE PANNE N'EST PAS UNE ABSENCE D'AFFECTATION. Le gestionnaire d'erreur ne
            faisait que couper le chargement : l'ecran affichait donc « Aucun vehicule ne
            vous est attribue », ce qui, pour un conducteur devant son camion, veut dire
            « on ne vous a rien confie ». Le mensonge est en plus impossible a lever : il
            n'a personne a qui demander sur cet ecran.
          -->
          <div class="dh-etat">
            <p class="dh-etat-t">Impossible de charger vos véhicules</p>
            <p class="dh-etat-s">Ce n'est pas une question d'affectation : la liste n'a pas pu être récupérée.</p>
            <button type="button" class="dh-recours" (click)="charger()">Réessayer</button>
          </div>
        } @else if (vehicles().length === 0) {
          <div class="dh-etat">
            <p class="dh-etat-t">Aucun véhicule ne vous est attribué</p>
            <p class="dh-etat-s">Votre responsable de flotte peut vous en affecter un.</p>
          </div>
        } @else {
          <p class="text-[13px] text-fg-secondary mb-3 leading-relaxed">Choisissez un véhicule pour le déverrouiller — vous devez être à proximité — ou scannez son QR.</p>
          <div class="flex flex-col gap-2.5">
            @for (v of vehicles(); track v.id) {
              <!--
                UNE MAIN (B1 § B). L'action principale etait une pastille douce de 33 px
                coincee en haut a droite de la ligne — la zone la moins accessible au pouce,
                et la meme affordance qu'un bouton secondaire. La planche en fait une BARRE
                PLEINE de 48 px en accent solide : c'est le geste de l'ecran.
              -->
              <div class="dh-carte">
                <div class="flex items-center gap-3">
                  <span class="dh-tuile"><lucide-icon [img]="Car" [size]="24" /></span>
                  <div class="flex-1 min-w-0">
                    <div class="dh-plaque">{{ v.plate }}</div>
                    @if (v.brand || v.model) {
                      <div class="dh-modele">{{ v.brand }} {{ v.model }}</div>
                    }
                  </div>
                </div>
                <div class="flex gap-2.5">
                  <button type="button" (click)="privacyFor.set(v)" class="dh-bouclier"
                          aria-label="Vie privée et horaires de ce véhicule">
                    <lucide-icon [img]="ShieldCheck" [size]="20" />
                  </button>
                  <a [routerLink]="['/driver/unlock']" [queryParams]="{ vehicleId: v.id }" class="dh-unlock">
                    <lucide-icon [img]="Unlock" [size]="18" /> Déverrouiller
                  </a>
                </div>
              </div>
            }
          </div>
        }
      </main>

      @if (privacyFor(); as pv) {
        <app-driver-privacy-panel [vehicleId]="pv.id" [plate]="pv.plate" (close)="privacyFor.set(null)"></app-driver-privacy-panel>
      }
    </div>
  `,
  styles: [`
    /*
     * CONTRASTE EXTERIEUR (B1 § B). Cet ecran se lit dehors, souvent en plein soleil, sur un
     * telephone dont la luminosite ne suffit jamais. Le texte secondaire y etait en
     * --fg-tertiary a 11 px : un jeton a 3:1, deja limite en interieur.
     */
    .dh-mention {
      display: flex; align-items: flex-start; gap: 8px; margin-top: 10px;
      padding: 8px 10px; border-radius: 10px; font-size: 12px; line-height: 1.55;
      background: color-mix(in srgb, var(--violet) 12%, transparent);
      color: var(--texte-violet);
    }
    .dh-mention lucide-icon { margin-top: 1px; flex-shrink: 0; }

    .dh-deco {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      min-height: 44px; padding: 0 10px; border-radius: 10px;
      background: transparent; border: none; cursor: pointer;
      color: var(--fg-secondary); font-size: 13px; font-family: inherit;
    }

    /* La carte vehicule : identite en haut, LE GESTE en bas, pleine largeur. */
    .dh-carte {
      display: flex; flex-direction: column; gap: 12px; padding: 13px;
      border-radius: 16px; background: var(--bg-secondary); border: 1px solid var(--border-subtle);
    }
    .dh-tuile {
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      width: 46px; height: 46px; border-radius: 16px;
      background: var(--surface-quaternary); color: var(--fg-secondary);
    }
    .dh-plaque { font-family: var(--font-mono); font-size: 16px; font-weight: 600; color: var(--fg-primary); }
    .dh-modele { font-size: 12.5px; color: var(--fg-secondary); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dh-bouclier {
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      width: 48px; height: 48px; border-radius: 13px; cursor: pointer;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary);
    }
    /*
     * Le geste de l'ecran : barre PLEINE de 48 px en accent solide, atteignable au pouce.
     * Il etait une pastille douce de 33 px en haut a droite de la ligne — la zone la moins
     * accessible d'un telephone tenu d'une main, et l'affordance d'un bouton secondaire.
     */
    .dh-unlock {
      flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      height: 48px; border-radius: 13px; text-decoration: none;
      background: var(--color-tracky-light); color: var(--accent-ink);
      font-size: 14px; font-weight: 800; white-space: nowrap;
    }

    .dh-etat { padding: 48px 12px; text-align: center; }
    .dh-etat-t { margin: 0; font-size: 15px; font-weight: 700; color: var(--fg-primary); }
    .dh-etat-s { margin: 6px auto 0; max-width: 300px; font-size: 13px; line-height: 1.55; color: var(--fg-secondary); text-wrap: pretty; }
    .dh-recours {
      display: inline-flex; align-items: center; justify-content: center;
      min-height: 44px; margin-top: 16px; padding: 0 18px; border-radius: 12px;
      background: var(--bg-tertiary); border: 1px solid var(--border-strong);
      color: var(--fg-primary); font-size: 14px; font-weight: 600; font-family: inherit; cursor: pointer;
    }
    @media (prefers-reduced-motion: reduce) { .animate-spin { animation: none; } }
  `],
})
export class DriverHomeComponent implements OnInit {
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  /** La liste n'a pas pu être chargée — à ne PAS confondre avec « aucun véhicule attribué ». */
  protected readonly erreur = signal(false);
  protected readonly vehicles = signal<VehicleDetailDto[]>([]);
  /** Véhicule dont on ouvre le panneau « Vie privée & horaires » (overlay). */
  protected readonly privacyFor = signal<VehicleDetailDto | null>(null);

  /** Espace dépôt (2026-08) — les missions du jour de ce conducteur. */
  protected readonly missions = signal<MissionConducteur[]>([]);

  protected readonly Car = Car;
  protected readonly LogOut = LogOut;
  protected readonly Unlock = Unlock;
  protected readonly ShieldCheck = ShieldCheck;
  protected readonly Eye = Eye;

  protected email(): string {
    return this.auth.user()?.email ?? '';
  }

  protected heure(iso: string): string {
    return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  ngOnInit(): void {
    this.charger();

    // Les missions ne bloquent PAS l'écran : un échec laisse la liste vide et le
    // conducteur garde ses véhicules. Le bandeau d'information n'apparaît que s'il y a
    // réellement une mission suivie.
    this.http
      .get<MissionConducteur[]>('/api/missions/mine')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (m) => this.missions.set(m ?? []),
        error: (err) => swallow('driver-home:missions', err),
      });
  }

  /**
   * ⚠️ Une PANNE et une absence d'affectation sont deux choses. Le `catch` ne posait que
   * `loading = false`, donc l'ecran affichait « Aucun vehicule ne vous est attribue » — ce
   * qui, pour un conducteur debout devant son camion, veut dire « on ne vous a rien
   * confie ». Et il n'a personne a qui demander depuis cet ecran.
   */
  protected charger(): void {
    this.erreur.set(false);
    this.loading.set(true);
    this.vehiclesApi
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (v) => {
          this.vehicles.set(v ?? []);
          this.loading.set(false);
        },
        error: (err) => {
          swallow('driver-home:vehicles', err);
          this.erreur.set(true);
          this.loading.set(false);
        },
      });
  }

  protected logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
