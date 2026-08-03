import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Bell, LucideAngularModule, MapPin, WifiOff } from 'lucide-angular';
import { ConsentService } from '../../core/services/consent.service';
import { NotificationsApiService } from '../../core/services/notifications.service';
import { PermissionOnboardingService } from '../../core/services/permission-onboarding.service';

type PState = 'idle' | 'busy' | 'granted' | 'denied';

/**
 * P3 — Écran d'onboarding des permissions device (premier lancement). Rendu par
 * DashboardLayout quand `perms.shouldOnboard()` ET que le consentement ne bloque
 * pas (l'écran de consentement passe en premier). Demande Notifications + GPS
 * (via les prompts natifs) et rappelle le mode hors-ligne / installation.
 */
@Component({
  selector: 'app-permissions-gate',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  template: `
    @if (perms.shouldOnboard() && !consent.mustAccept()) {
      <div class="pg-overlay" role="dialog" aria-modal="true" aria-labelledby="pg-title">
        <div class="pg-shell">
          <h1 id="pg-title" class="pg-title">Activez votre application</h1>
          <p class="pg-lead">
            Pour profiter pleinement de Vizyo Tracky sur cet appareil, autorisez ces
            accès. Vous pourrez les modifier à tout moment depuis votre compte.
          </p>

          <div class="pg-item">
            <span class="pg-ico"><lucide-icon [img]="Bell" [size]="20"></lucide-icon></span>
            <div class="pg-txt">
              <div class="pg-h">Notifications</div>
              <div class="pg-d">Alertes critiques de votre flotte en temps réel (SOS, excès de vitesse, sortie de zone, batterie…), même application fermée.</div>
            </div>
            <button type="button" class="pg-btn" (click)="grantNotif()"
                    [class.pg-btn--ok]="notifState()==='granted'"
                    [disabled]="notifState()==='busy' || notifState()==='granted'">{{ label(notifState()) }}</button>
          </div>

          <div class="pg-item">
            <span class="pg-ico"><lucide-icon [img]="MapPin" [size]="20"></lucide-icon></span>
            <div class="pg-txt">
              <div class="pg-h">Localisation</div>
              <div class="pg-d">Utile pour déverrouiller un véhicule par QR code : nous vérifions que vous êtes à proximité avant d'autoriser l'ouverture. Utilisée uniquement au moment de l'action — vous pourrez l'autoriser à ce moment-là si vous préférez.</div>
              @if (geoState() === 'denied') {
                <div class="pg-warn">Localisation bloquée. Autorisez-la dans votre navigateur (icône cadenas de la barre d'adresse → Localisation → Autoriser), puis réessayez.</div>
              }
            </div>
            <button type="button" class="pg-btn" (click)="grantGeo()"
                    [class.pg-btn--ok]="geoState()==='granted'"
                    [disabled]="geoState()==='busy' || geoState()==='granted'">{{ geoLabel() }}</button>
          </div>

          <div class="pg-item pg-item--muted">
            <span class="pg-ico"><lucide-icon [img]="WifiOff" [size]="20"></lucide-icon></span>
            <div class="pg-txt">
              <div class="pg-h">Mode hors-ligne</div>
              <div class="pg-d">Installez Tracky sur votre écran d'accueil (menu du navigateur → « Ajouter à l'écran d'accueil ») pour un accès rapide et une meilleure résilience réseau.</div>
            </div>
          </div>

          <!--
            ⚠️ CE BOUTON ETAIT DESACTIVE tant que la geolocalisation n'etait pas accordee,
            et il n'existait AUCUNE autre porte. Un utilisateur qui refusait le GPS — ou
            dont le navigateur ne le propose pas — restait enferme dehors, definitivement.
          -->
          <button type="button" class="pg-continue" (click)="finish()">Continuer vers l'application</button>
        </div>
      </div>
    }
  `,
  styles: [
    `
    .pg-overlay {
      position: fixed; inset: 0; z-index: 3900;
      background: color-mix(in srgb, var(--bg-primary) 92%, transparent);
      backdrop-filter: blur(8px) saturate(1.2);
      display: flex; align-items: center; justify-content: center; padding: 16px; font-family: inherit;
    }
    .pg-shell {
      width: 100%; max-width: 540px; background: var(--bg-secondary);
      border: 1px solid var(--border-subtle); border-radius: var(--radius-card, 18px);
      box-shadow: 0 30px 80px -20px rgba(0,0,0,.55); padding: 26px 24px 22px;
      max-height: calc(100dvh - 32px); overflow-y: auto;
    }
    .pg-title { margin: 0 0 6px; font-size: 1.3rem; font-weight: 800; letter-spacing: -.02em; color: var(--fg-primary); }
    .pg-lead { margin: 0 0 18px; font-size: .92rem; line-height: 1.55; color: var(--fg-secondary); }
    .pg-item {
      display: flex; align-items: flex-start; gap: 13px; padding: 14px 0;
      border-top: 1px solid var(--border-subtle);
    }
    .pg-item--muted { opacity: .82; }
    .pg-ico {
      width: 40px; height: 40px; border-radius: 11px; flex: none;
      background: color-mix(in srgb, var(--tracky-light) 15%, transparent);
      color: var(--tracky-light); display: flex; align-items: center; justify-content: center;
    }
    .pg-txt { flex: 1; min-width: 0; }
    .pg-h { font-weight: 700; font-size: .96rem; color: var(--fg-primary); }
    .pg-d { font-size: .84rem; line-height: 1.5; color: var(--fg-tertiary); margin-top: 2px; }
    .pg-btn {
      flex: none; align-self: center; font: inherit; font-weight: 700; font-size: .82rem;
      padding: 8px 14px; border-radius: 10px; cursor: pointer; white-space: nowrap;
      border: 1px solid var(--border-strong); background: transparent; color: var(--fg-primary);
    }
    .pg-btn:disabled { cursor: default; }
    .pg-btn--ok { border-color: transparent; background: color-mix(in srgb, var(--tracky-light) 16%, transparent); color: var(--tracky-light); }
    .pg-req {
      display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px;
      font-size: .62rem; font-weight: 800; letter-spacing: .04em; text-transform: uppercase;
      vertical-align: middle; background: color-mix(in srgb, var(--tracky-light) 18%, transparent); color: var(--tracky-light);
    }
    .pg-warn {
      margin-top: 8px; padding: 8px 10px; border-radius: 9px; font-size: .78rem; line-height: 1.45;
      background: color-mix(in srgb, #f2a33c 13%, transparent); color: #e6952f;
      border: 1px solid color-mix(in srgb, #f2a33c 30%, transparent);
    }
    .pg-hint { margin: 16px 0 0; font-size: .82rem; color: var(--fg-tertiary); text-align: center; }
    .pg-continue {
      width: 100%; margin-top: 20px; font: inherit; font-weight: 700; font-size: .95rem;
      padding: 13px; border-radius: 12px; border: 0; cursor: pointer;
      background: var(--tracky-light); color: #04130d;
    }
    .pg-continue:disabled { opacity: .45; cursor: not-allowed; }
    `,
  ],
})
export class PermissionsGateComponent {
  readonly perms = inject(PermissionOnboardingService);
  readonly consent = inject(ConsentService);
  private readonly notif = inject(NotificationsApiService);

  readonly Bell = Bell;
  readonly MapPin = MapPin;
  readonly WifiOff = WifiOff;

  readonly notifState = signal<PState>('idle');
  readonly geoState = signal<PState>('idle');

  label(s: PState): string {
    return s === 'granted' ? 'Autorisé' : s === 'denied' ? 'Refusé' : s === 'busy' ? '…' : 'Autoriser';
  }

  /** Sur refus on propose « Réessayer » — sans jamais bloquer l'entrée dans l'application. */
  geoLabel(): string {
    const s = this.geoState();
    return s === 'granted' ? 'Autorisé' : s === 'denied' ? 'Réessayer' : s === 'busy' ? '…' : 'Autoriser';
  }

  async grantNotif(): Promise<void> {
    this.notifState.set('busy');
    try {
      const r = await this.notif.subscribePush();
      const ok = !!r?.ok;
      this.notifState.set(ok ? 'granted' : 'denied');
      await this.perms.record('PUSH', ok);
    } catch {
      this.notifState.set('denied');
      await this.perms.record('PUSH', false);
    }
  }

  grantGeo(): void {
    this.geoState.set('busy');
    if (!('geolocation' in navigator)) {
      this.geoState.set('denied');
      void this.perms.record('GEOLOCATION', false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      () => {
        this.geoState.set('granted');
        void this.perms.record('GEOLOCATION', true);
      },
      () => {
        this.geoState.set('denied');
        void this.perms.record('GEOLOCATION', false);
      },
      { timeout: 10000, maximumAge: 60000 },
    );
  }

  finish(): void {
    // ══ POURQUOI PLUS AUCUNE CONDITION ICI (constat du 2026-08-03) ═══════════════════
    //
    // Cette methode refusait de passer tant que la geolocalisation n'etait pas accordee,
    // et le bouton etait desactive. Il n'existait aucune autre sortie : un utilisateur
    // qui refusait le GPS ne pouvait PLUS UTILISER L'APPLICATION DU TOUT.
    //
    // Quatre situations menaient a ce blocage definitif, et aucune n'est un cas limite :
    //   - le refus, qui est un droit ;
    //   - une politique d'entreprise qui bloque la geolocalisation ;
    //   - un navigateur sans l'API (le code posait alors « denied » sans recours — et le
    //     message d'aide « icone cadenas → Autoriser » ne s'appliquait meme pas) ;
    //   - un refus anterieur, le navigateur ne redemandant plus.
    //
    // Le motif invoque etait le deverrouillage d'un vehicule par QR code. Or :
    //   1. `driver-unlock.component.ts` demande DEJA la position au moment du
    //      deverrouillage — la bloquer ici n'apporte donc rien a cette fonction ;
    //   2. ce deverrouillage concerne le role DRIVER, alors que cet ecran barrait la
    //      route a TOUS les roles, gestionnaires compris.
    //
    // On bloquait donc l'acces entier au produit pour une fonction que la plupart des
    // comptes n'utiliseront jamais, et qui redemande l'autorisation de toute facon.
    //
    // ⚠️ Au-dela de l'ergonomie : conditionner l'acces a un service a une autorisation de
    // geolocalisation qui ne lui est pas necessaire est difficilement defendable vis-a-vis
    // du RGPD. Le consentement doit rester libre.
    this.perms.finish();
  }
}
