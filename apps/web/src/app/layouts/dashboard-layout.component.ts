import { Component, computed, HostListener, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterOutlet, RouterLink, RouterLinkActive, NavigationEnd, NavigationStart, NavigationCancel, NavigationError, Router } from '@angular/router';
import {
  LucideAngularModule,
  LayoutDashboard,
  Map,
  Truck,
  Bell,
  FileBarChart,
  Gauge as GaugeIcon,
  Calendar,
  Users,
  Settings,
  Menu,
  X,
  MoreHorizontal,
  Activity,
  AlertTriangle,
  MessageSquare,
  Terminal,
  ClipboardList,
  CreditCard,
  UserCircle2,
  LogOut,
  Sun,
  Moon,
  Sparkles,
  AlarmClock,
  MapPin, ShieldCheck, Plug,
  // Espace dépôt (2026-08) — `Route` = la mission (design/ICONS.md, décision D-I3).
  Route,
  // Lot A3 — les trois autres onglets de l'espace dépôt.
  History, FileText } from 'lucide-angular';
import { ThemeService } from '../core/theme/theme.service';
import { AlertsBellComponent } from '../shared/ui/alerts-bell/alerts-bell.component';
import { FleetSelectorComponent } from '../shared/ui/super-admin-context/fleet-selector.component';
import { AuthService } from '../core/services/auth.service';
import { DepotLiveStore } from '../features/depot/depot-live.store';
import { NetworkStatusService } from '../core/services/network-status.service';
import { RealtimeService } from '../core/services/realtime.service';
import { ActivityTrackerService } from '../core/services/activity-tracker.service';
import { NotificationsApiService } from '../core/services/notifications.service';
import { FleetCacheService } from '../core/services/fleet-cache.service';
import { OnboardingService } from '../core/services/onboarding.service';
import { PermissionsService } from '../core/services/permissions.service';
import { LogoComponent } from '../shared/ui/logo/logo.component';
import { InstallBannerComponent } from '../shared/ui/install-banner/install-banner.component';
import { PushPromptComponent } from '../shared/ui/push-prompt/push-prompt.component';
import { BottomSheetComponent } from '../shared/ui/bottom-sheet/bottom-sheet.component';
import { OnboardingWizardComponent } from '../features/onboarding/onboarding-wizard.component';
import { ConsentGateComponent } from '../features/consent/consent-gate.component';
import { ConsentService } from '../core/services/consent.service';
import { PermissionsGateComponent } from '../features/consent/permissions-gate.component';
import { PermissionOnboardingService } from '../core/services/permission-onboarding.service';
import { DeviceVerificationGateComponent } from '../features/security/device-verification-gate.component';
import { TwoFactorProposalComponent } from '../features/security/two-factor-proposal.component';
import { SecurityService } from '../core/services/security.service';
import { BaanoolMapOverlayComponent } from '../features/baanool/baanool-map-overlay.component';
import { MenuStateService } from '../core/services/menu-state.service';

/** Élément de navigation (sidebar / bottom-sheet). */
interface NavItem {
  label: string;
  route: string;
  icon: typeof LayoutDashboard;
}
/** Groupe de navigation : une section (eyebrow) + ses items.
 *  `section: null` = groupe sans en-tête (modes veilleur / baanool). */
interface NavGroup {
  section: string | null;
  items: NavItem[];
}

@Component({
  selector: 'app-dashboard-layout',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LucideAngularModule, AlertsBellComponent, FleetSelectorComponent, LogoComponent, InstallBannerComponent, PushPromptComponent, BottomSheetComponent, OnboardingWizardComponent, ConsentGateComponent, PermissionsGateComponent, DeviceVerificationGateComponent, TwoFactorProposalComponent, BaanoolMapOverlayComponent],
  template: `
    <a href="#main-content" class="skip-link">Aller au contenu principal</a>
    <div class="layout" [class.layout--fullscreen]="fullscreen()" [class.layout--ios-pwa]="isIosPwa" [class.layout--baanool]="isBaanoolMode()" [class.layout--depot]="auth.isDepot()">
      @if (!network.online()) {
        <div class="offline-banner" role="status" aria-live="polite">
          <span class="offline-dot"></span>
          Hors-ligne — les données affichees datent de votre dernière session
        </div>
      }

      <!-- DESKTOP SIDEBAR -->
      <aside class="desktop-sidebar" [class.collapsed]="collapsed()" aria-label="Navigation principale">
        <div class="sidebar-top">
          @if (collapsed()) {
            <!-- Replié : logo centré, cliquable pour déplier (fini le logo collé à gauche + burger serré). -->
            <button type="button" (click)="collapsed.set(false)" class="sidebar-expand"
                    aria-label="Déplier le menu" [attr.aria-expanded]="false">
              <app-logo variant="icon" [size]="28" />
            </button>
          } @else {
            <app-logo variant="icon" [size]="30" />
            <!-- Espace dépôt (2026-08) — LA MARQUE DU TRANSPORTEUR EN TÊTE, Tracky en
                 pied de menu à 12 px (A3 § 7, règle 5). Un dépôt ne connaît pas notre
                 marque : il connaît celle du transporteur qui lui a ouvert l'accès. -->
            <span class="sidebar-brand" [class.text-tracky-light]="!auth.isDepot()">
              {{ auth.isDepot() ? (depotStore.carrierName() || 'Suivi de livraison') : 'Tracky' }}
            </span>
            <button (click)="collapsed.set(true)" class="sidebar-toggle"
                    aria-label="Replier le menu" [attr.aria-expanded]="true">
              <lucide-icon [img]="MenuIcon" [size]="18"></lucide-icon>
            </button>
          }
        </div>
        <nav class="sidebar-nav" aria-label="Sections">
          @for (group of navItems(); track group.section ?? $index; let first = $first) {
            @if (collapsed()) {
              @if (!first) { <span class="sidebar-divider" aria-hidden="true"></span> }
            } @else if (group.section) {
              <span class="vt-section-label sidebar-section">{{ group.section }}</span>
            }
            @for (item of group.items; track item.label) {
              <a [routerLink]="item.route" routerLinkActive="active"
                 #rla="routerLinkActive"
                 class="sidebar-link"
                 [attr.aria-current]="rla.isActive ? 'page' : null"
                 [attr.aria-label]="collapsed() ? item.label : null">
                <lucide-icon [img]="item.icon" [size]="20" aria-hidden="true"></lucide-icon>
                @if (!collapsed()) { <span>{{ item.label }}</span> }
              </a>
            }
          }
        </nav>
        <!-- Le pied de menu du dépôt : Vizyo Tracky à 12 px, discret et assumé.
             L'espace appartient visuellement au transporteur ; nous en sommes le
             moteur, pas l'enseigne (A3 § 7, règle 5). -->
        @if (!collapsed() && auth.isDepot()) {
          <div class="sidebar-foot">
            <span class="depot-propulse">Propulsé par Vizyo Tracky</span>
          </div>
        }
        @if (!collapsed() && showAiPromo()) {
          <div class="sidebar-foot">
            <a routerLink="/agenda" class="ai-promo">
              <span class="ai-promo-head">
                <lucide-icon [img]="SparklesIcon" [size]="15" aria-hidden="true"></lucide-icon>
                <span>Agent IA</span>
              </span>
              <span class="ai-promo-text">Optimisez vos tournées et réaffectations.</span>
              <span class="ai-promo-cta">Découvrir →</span>
            </a>
          </div>
        }
      </aside>

      <!-- MOBILE BOTTOM SHEET — remplace l'ancien drawer lateral.
           Pattern UX iOS/Android natif : glisse depuis le bas, accessible
           au pouce. Ouvert via le hamburger top-left ou le bouton "Plus" du
           bottom-bar — tous deux pointent vers le meme signal mobileMenuOpen. -->
      <app-bottom-sheet
        [open]="mobileMenuOpen()"
        ariaLabel="Menu de navigation"
        (closed)="mobileMenuOpen.set(false)">
        <div class="bs-header">
          <app-logo variant="icon" [size]="22" />
          <span class="bs-brand text-tracky-light">Tracky</span>
        </div>
        <nav class="bs-nav-wrap" aria-label="Sections">
          @for (group of navItems(); track group.section ?? $index) {
            @if (group.section) { <span class="vt-section-label bs-section">{{ group.section }}</span> }
            <div class="bs-nav">
              @for (item of group.items; track item.label) {
                <a [routerLink]="item.route" routerLinkActive="active"
                   #rla="routerLinkActive"
                   class="bs-link"
                   [attr.aria-current]="rla.isActive ? 'page' : null"
                   (click)="mobileMenuOpen.set(false)">
                  <lucide-icon [img]="item.icon" [size]="20" aria-hidden="true"></lucide-icon>
                  <span>{{ item.label }}</span>
                </a>
              }
            </div>
          }
        </nav>
      </app-bottom-sheet>

      <!-- MAIN CONTENT -->
      <div class="main-area">
        <header class="top-bar" role="banner">
          <!-- Wave layers (effet vague glassy tracky) — wrapper a overflow:hidden
               pour ne pas couper les popups (alerts-bell) qui debordent du top-bar. -->
          <div class="top-bar-waves" aria-hidden="true">
            <span class="top-bar-wave top-bar-wave--1"></span>
            <span class="top-bar-wave top-bar-wave--2"></span>
          </div>

          <!-- §2.3 — barre de progression de route (navigations lentes uniquement). -->
          @if (routeLoading()) {
            <div class="route-progress" role="progressbar" aria-label="Chargement de la page" aria-busy="true"></div>
          }

          <div class="top-bar-left">
            <!-- Sprint 3 — veilleur : pas de menu burger (sa nav = « Véhicules » seul). -->
            @if (!auth.isWatchman()) {
              <button (click)="mobileMenuOpen.set(true)"
                      class="mobile-burger"
                      aria-label="Ouvrir le menu de navigation"
                      [attr.aria-expanded]="mobileMenuOpen()">
                <lucide-icon [img]="MenuIcon" [size]="18" aria-hidden="true"></lucide-icon>
              </button>
            }
            <!-- V1.12 — En mode Baanool le /dashboard n'est pas accessible
                 (filtre dans navItems), donc le logo redirige vers /map pour
                 eviter d'atterrir sur une page vide/redirigee. -->
            <!-- Espace dépôt (2026-08), lot A3 — la marque du TRANSPORTEUR, et un lien
                 vers /depot : un dépôt n'a pas de tableau de bord, le logo l'envoyait
                 sur une route que son propre garde refuse. -->
            <a [routerLink]="auth.isDepot() ? '/depot' : (isBaanoolMode() ? '/map' : '/dashboard')"
               class="top-bar-brand"
               [attr.aria-label]="auth.isDepot() ? 'Suivi de livraison — carte' : (isBaanoolMode() ? 'Vizyo Tracky — Carte' : 'Vizyo Tracky — Tableau de bord')">
              <app-logo variant="icon" [size]="26" />
              <span class="top-bar-brand-text" aria-hidden="true">
                <span class="top-bar-brand-name" [class.top-bar-brand-name--accent]="!auth.isDepot()">
                  {{ auth.isDepot() ? (depotStore.carrierName() || 'Suivi de livraison') : 'Tracky' }}
                </span>
              </span>
            </a>
            <h2 class="top-title">{{ pageTitle() }}</h2>
          </div>
          <div class="top-actions">
            @if (auth.isWatchman()) {
              <!-- Sprint 3 — veilleur « zéro donnée » : pas de cloche d'alertes, pas de
                   menu profil (Mon profil / Paramètres retirés). On garde UNIQUEMENT
                   l'icône de bascule de thème (à la place du profil) + la déconnexion
                   (seul point de sortie : /account et /settings sont bloqués pour ce rôle). -->
              <button (click)="toggleTheme()" class="top-icon-btn"
                      [attr.aria-label]="themeService.theme() === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre'">
                <lucide-icon [img]="themeService.theme() === 'dark' ? SunIcon : MoonIcon" [size]="18"></lucide-icon>
              </button>
              <button (click)="confirmLogout()" class="top-icon-btn top-icon-btn--danger"
                      aria-label="Se déconnecter">
                <lucide-icon [img]="LogOutIcon" [size]="18"></lucide-icon>
              </button>
            } @else {
            <!-- Pastille « Connecté » — état du socket temps réel (RealtimeService).
                 Masquée en mode dépôt : ce socket-là n'est pas le sien, et sa carte
                 porte un indicateur bien plus utile — « rafraîchie il y a 12 s », qui
                 date la DONNÉE plutôt que le tuyau (A3 § 1). -->
            @if (!auth.isDepot()) {
              <span class="top-connected vt-status"
                    [class.vt-status--on]="realtime.connected()"
                    [class.vt-status--offline]="!realtime.connected()"
                    role="status" aria-live="polite">
                <span class="vt-status__dot" aria-hidden="true"></span>
                {{ realtime.connected() ? 'Connecté' : 'Hors ligne' }}
              </span>
            }
            <!-- Filtre societe global — SUPER_ADMIN uniquement (rend rien sinon).
                 Ecrit dans FleetFilterService, consomme par les pages liste.
                 ⚠️ Espace dépôt (2026-08), lot A3 — ni sélecteur de société ni cloche
                 d'alertes : un dépôt n'appartient à aucune société qu'il choisirait, et
                 les alertes sont l'outil du transporteur (A3 § 7). La cloche appelait
                 l'API des alertes, qui lui répond 403 — une icône qui ne peut rien
                 afficher promet une fonction qui n'existe pas.
                 (Aucun accent grave dans ce commentaire : il terminerait le littéral
                 de template — piège payé trois fois sur ce chantier.) -->
            @if (!auth.isDepot()) {
              <app-fleet-selector />
              <app-alerts-bell />
            }
            <div class="user-menu-wrapper">
              <button (click)="userMenuOpen.set(!userMenuOpen())" class="user-menu-trigger">
                <span class="user-avatar">{{ userInitials() }}</span>
              </button>
              @if (userMenuOpen()) {
                <div class="user-menu-backdrop" (click)="userMenuOpen.set(false)"></div>
                <div class="user-menu">
                  <div class="user-menu-header">
                    <span class="user-avatar user-avatar--lg">{{ userInitials() }}</span>
                    <div>
                      <p class="user-menu-name">{{ userEmail().split('&#64;')[0] }}</p>
                      <p class="user-menu-email">{{ userEmail() }}</p>
                    </div>
                  </div>
                  <div class="user-menu-divider"></div>
                  <a routerLink="/account" class="user-menu-item" (click)="userMenuOpen.set(false)">
                    <lucide-icon [img]="UserCircle2Icon" [size]="16"></lucide-icon>
                    Mon profil
                  </a>
                  <a routerLink="/settings" class="user-menu-item" (click)="userMenuOpen.set(false)">
                    <lucide-icon [img]="SettingsIcon" [size]="16"></lucide-icon>
                    Paramètres
                  </a>
                  @if (isSuperAdmin()) {
                    <a routerLink="/admin" class="user-menu-item" (click)="userMenuOpen.set(false)">
                      <lucide-icon [img]="TerminalIcon" [size]="16"></lucide-icon>
                      Administration
                    </a>
                  }
                  <div class="user-menu-divider"></div>
                  <button class="user-menu-item" (click)="toggleTheme(); userMenuOpen.set(false)">
                    <lucide-icon [img]="themeService.theme() === 'dark' ? SunIcon : MoonIcon" [size]="16"></lucide-icon>
                    {{ themeService.theme() === 'dark' ? 'Mode clair' : 'Mode sombre' }}
                  </button>
                  <div class="user-menu-divider"></div>
                  <button class="user-menu-item user-menu-item--danger" (click)="confirmLogout()">
                    <lucide-icon [img]="LogOutIcon" [size]="16"></lucide-icon>
                    Se déconnecter
                  </button>
                </div>
              }
            </div>
            }
          </div>
        </header>
        <main id="main-content" class="content" [class.fullscreen]="fullscreen()" tabindex="-1">
          <router-outlet />
        </main>
      </div>

      <!-- MOBILE BOTTOM BAR — cachee en mode fullscreen (page /map) pour
           liberer toute la hauteur ecran a la carte. -->
      <nav class="bottom-bar" [class.bottom-bar--hidden]="fullscreen() && !auth.isDepot()">
        @for (item of bottomItems(); track item.label) {
          @if (item.route === 'more') {
            <button (click)="mobileMenuOpen.set(true)" class="bottom-item press-feedback">
              <lucide-icon [img]="item.icon" [size]="20"></lucide-icon>
              <span>{{ item.label }}</span>
            </button>
          } @else {
            <a [routerLink]="item.route" routerLinkActive="active" class="bottom-item press-feedback">
              <lucide-icon [img]="item.icon" [size]="20"></lucide-icon>
              <span>{{ item.label }}</span>
            </a>
          }
        }
      </nav>

      <app-install-banner />
      <app-push-prompt />
      <app-onboarding-wizard />
      <app-consent-gate />
      <app-device-verification-gate />
      <app-two-factor-proposal />
      <app-permissions-gate />

      <!-- V1.12 — Mode Baanool : overlay UI style Baanool affiche UNIQUEMENT
           sur la page /map. Boutons cercles flottants (burger, recentrer,
           alertes, profile) + boutons droite verticaux (vehicules, coupe-
           circuit, GPS, satellite) + panel central toggleable. -->
    </div>

    <!-- V1.12 — Mode Baanool : overlay HORS du .layout pour eviter que
         overflow:hidden de .layout ne piege le position:fixed sur iOS
         Safari standalone (cree un containing block parasite).
         L'overlay ouvre le menu via MenuStateService directement
         (l'EventEmitter ne propageait pas son listener). -->
    @if (isBaanoolMapPage()) {
      <app-baanool-map-overlay />
    }
  `,
  styles: [`
    .layout {
      /* Hauteur viewport :
       *   - 100vh : fallback navigateurs anciens (≈ lvh sur iOS).
       *   - 100svh : "small viewport height", STABLE — ne change pas quand Safari
       *     replie/deploie sa barre navigateur. Sans ca, en mode browser iOS,
       *     le layout entier se redimensionne pendant le scroll = jitter et top-bar
       *     qui "saute". En PWA standalone le viewport est de toute facon stable
       *     donc svh = lvh = dvh.
       *   - On evite 100dvh qui s'anime en continu et provoque le bug "tout
       *     decale au scroll" rapporte par les utilisateurs iPhone.
       */
      height: 100vh;
      height: 100svh;
      display: flex;
      background: var(--bg-primary);
      overflow: hidden;
      position: relative;
    }

    /* ─── OFFLINE BANNER ─── */
    .offline-banner {
      position: absolute;
      top: 0; left: 0; right: 0;
      z-index: 9500;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      height: 28px;
      background: #f59e0b;
      color: #1f1300;
      font-size: 12px; font-weight: 600;
      padding-top: env(safe-area-inset-top);
      box-sizing: content-box;
      animation: offline-slide 200ms ease-out;
    }
    .offline-dot {
      width: 6px; height: 6px; border-radius: 9999px; background: currentColor;
      animation: offline-pulse 1.4s ease-in-out infinite;
    }
    @keyframes offline-slide { from { transform: translateY(-100%) } to { transform: translateY(0) } }
    @keyframes offline-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.45 } }

    /* ─── DESKTOP SIDEBAR ─── */
    .desktop-sidebar {
      display: flex; flex-direction: column;
      /* flex: 0 0 240px au lieu de width: 240px : en flex-row, le shorthand
       * fixe flex-basis (taille de reference) ce qui evite le delta entre la
       * width fixe et le calcul flex-basis: auto. Sans ca, lors du toggle de
       * la classe .collapsed, la transition CSS sur width ne se reflete pas
       * dans le flex-basis et la .main-area ne reprend pas l'espace libere. */
      flex: 0 0 248px;
      width: 248px;
      border-right: 1px solid var(--border-subtle);
      background: var(--surface-rail); transition: flex-basis .3s, width .3s;
    }
    .desktop-sidebar.collapsed { flex-basis: 64px; width: 64px }
    /* Repliée : tout est centré (icônes + burger), sinon l'alignement label
       laisse les icônes collées à gauche dans les 64px. */
    .desktop-sidebar.collapsed .sidebar-top { padding: 0; justify-content: center }
    .desktop-sidebar.collapsed .sidebar-toggle { margin-left: 0 }
    .desktop-sidebar.collapsed .sidebar-nav { padding: 14px 8px }
    .desktop-sidebar.collapsed .sidebar-link { justify-content: center; padding: 10px 0; gap: 0 }
    /* Repliée : le logo centré sert de bouton « déplier ». */
    .sidebar-expand {
      display: flex; align-items: center; justify-content: center;
      width: 44px; height: 44px; margin: 0 auto; border-radius: 12px;
      border: none; background: transparent; cursor: pointer; transition: background .15s;
    }
    .sidebar-expand:hover { background: var(--bg-tertiary) }
    .sidebar-top {
      display: flex; align-items: center; gap: 10px; padding: 0 16px; height: 60px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .sidebar-brand { font-size: 15px; font-weight: 800; letter-spacing: -.01em; color: var(--fg-primary); white-space: nowrap }
    .sidebar-toggle {
      margin-left: auto; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
      color: var(--fg-tertiary); background: transparent; border: none; cursor: pointer;
    }
    .sidebar-toggle:hover { color: var(--fg-primary); background: var(--bg-tertiary) }
    .sidebar-nav { flex: 1; display: flex; flex-direction: column; gap: 2px; padding: 14px 12px; overflow-y: auto }
    /* En-tête de groupe (eyebrow mono) — .vt-section-label fournit la typo. */
    .sidebar-section { padding: 6px 12px 4px }
    .sidebar-section:not(:first-child) { padding-top: 16px }
    /* Séparateur entre groupes quand la sidebar est repliée (pas d'eyebrows). */
    .sidebar-divider { height: 1px; background: var(--border-subtle); margin: 8px 10px }
    .sidebar-link {
      display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 12px;
      color: var(--fg-secondary); text-decoration: none; font-size: 13.5px; font-weight: 600;
      border: 1px solid transparent; transition: all .2s;
    }
    .sidebar-link:hover { background: var(--bg-tertiary); color: var(--fg-primary) }
    .sidebar-link.active { background: var(--bg-tertiary); color: var(--tracky-light); border-color: var(--border-strong) }
    /* Espace dépôt — l'accent sur fond teinté donne 3,24:1 à 13,5 px, sous le seuil
       du critère n° 10. La règle vit ICI et non dans styles.css : l'encapsulation
       émulée ajoute un attribut au sélecteur du composant, ce qui le rend plus
       spécifique qu'une règle globale de même forme. */
    .layout--depot .sidebar-link.active,
    .layout--depot .bottom-item.active { color: var(--depot-succes) }
    /* Pied de sidebar — carte promo « Agent IA » (réf. maquette). */
    .sidebar-foot { padding: 12px; border-top: 1px solid var(--border-subtle) }
    .ai-promo {
      display: block; text-decoration: none;
      padding: 12px 13px; border-radius: 14px;
      background: var(--bg-tertiary); border: 1px solid var(--border-strong);
      transition: border-color .2s;
    }
    .ai-promo:hover { border-color: var(--tracky-light) }
    .ai-promo-head { display: flex; align-items: center; gap: 8px; color: var(--fg-primary); font-size: 13px; font-weight: 700 }
    .ai-promo-head lucide-icon { color: var(--tracky-light); display: flex }
    .ai-promo-text { display: block; margin: 7px 0 9px; font-size: 12px; color: var(--fg-secondary); line-height: 1.45 }
    .ai-promo-cta { font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--tracky-light) }

    /* ─── MOBILE DRAWER ─── */
    /* Anciens drawers mobiles supprimes (remplaces par <app-bottom-sheet>). */

    /* ─── TOP BAR avec effet vague glassy ─── */
    .top-bar {
      display: flex; align-items: center; justify-content: space-between;
      height: 60px;
      flex-shrink: 0;
      position: relative;
      /* Pas d'overflow:hidden ici : la popup alerts-bell deborde et serait clippee.
         L'overflow est confine au .top-bar-waves wrapper ci-dessous. */
      /* z-index: 1800 -- doit etre superieur aux FAB de la map (jusqu'a 1700)
         pour que la popup alerts-bell (rendue dans le top-bar) s'affiche
         au-dessus de ces boutons. Reste sous les modals (toast 6000, drawer 8000). */
      z-index: 1800;
      border-bottom: 1px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 14%, var(--border-subtle));
      background: color-mix(in srgb, var(--surface-rail) 72%, transparent);
      backdrop-filter: blur(14px) saturate(1.5);
      -webkit-backdrop-filter: blur(14px) saturate(1.5);
      /* Safe-area :
       *   - top : env(safe-area-inset-top) clear le notch/Dynamic Island en PWA iOS
       *     standalone, MAIS sans buffer additionnel les icones se retrouvent a
       *     ~10px de la status bar iOS, visuellement colles. On ajoute +10px de
       *     respiration entre le bord bas de la status bar et le contenu du top-bar.
       *   - lateral : iPhone Pro Max paysage.
       */
      padding-top: calc(env(safe-area-inset-top) + 10px);
      padding-left: max(20px, env(safe-area-inset-left));
      padding-right: max(20px, env(safe-area-inset-right));
      box-sizing: content-box;
    }
    .top-bar-waves {
      position: absolute;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
      z-index: 0;
      border-bottom-left-radius: inherit;
      border-bottom-right-radius: inherit;
    }
    /* Barre de progression de route (§2.3) — épinglée sur la bordure basse du top-bar.
       Réutilise le keyframe global vt-route (styles.css) : se remplit puis disparaît. */
    .route-progress {
      position: absolute; left: 0; bottom: 0; height: 2px; width: 0;
      z-index: 3; pointer-events: none; border-radius: 0 2px 2px 0;
      background: linear-gradient(90deg, var(--tracky, #0A9E6C), var(--tracky-light, #10E0A0));
      box-shadow: 0 0 8px color-mix(in srgb, var(--tracky-light, #10E0A0) 55%, transparent);
      animation: vt-route 900ms ease-out both;
    }
    @media (prefers-reduced-motion: reduce) {
      .route-progress { animation: none; width: 100%; opacity: .9; }
    }
    .top-bar-wave {
      content: '';
      position: absolute;
      top: 0; bottom: 0;
      width: 250%;
      pointer-events: none;
      z-index: 0;
    }
    .top-bar-wave--1 {
      left: -75%;
      background:
        radial-gradient(ellipse 30% 140% at 20% 50%, rgba(16,224,160,.30), transparent 70%),
        radial-gradient(ellipse 25% 120% at 55% 40%, rgba(94,234,212,.20), transparent 60%),
        radial-gradient(ellipse 20% 100% at 80% 55%, rgba(167,243,208,.14), transparent 55%);
      animation: tracky-nav-wave-1 8s ease-in-out infinite alternate;
    }
    .top-bar-wave--2 {
      right: -75%;
      background:
        radial-gradient(ellipse 28% 130% at 35% 55%, rgba(52,211,153,.22), transparent 65%),
        radial-gradient(ellipse 22% 110% at 65% 45%, rgba(103,232,249,.16), transparent 55%),
        radial-gradient(ellipse 30% 120% at 85% 50%, rgba(16,224,160,.28), transparent 60%);
      animation: tracky-nav-wave-2 11s ease-in-out infinite alternate;
    }
    @keyframes tracky-nav-wave-1 {
      0%   { transform: translateX(0%);  opacity: .55 }
      30%  { opacity: .85 }
      50%  { transform: translateX(18%); opacity: .6 }
      70%  { opacity: .9 }
      100% { transform: translateX(35%); opacity: .65 }
    }
    @keyframes tracky-nav-wave-2 {
      0%   { transform: translateX(0%);   opacity: .5 }
      25%  { opacity: .8 }
      50%  { transform: translateX(-12%); opacity: .55 }
      75%  { opacity: .85 }
      100% { transform: translateX(-30%); opacity: .6 }
    }
    /* Light theme : version plus douce (le fond est déjà clair) */
    :host-context([data-theme='light']) .top-bar-wave--1 {
      background:
        radial-gradient(ellipse 30% 140% at 20% 50%, rgba(16,224,160,.16), transparent 70%),
        radial-gradient(ellipse 25% 120% at 55% 40%, rgba(94,234,212,.10), transparent 60%),
        radial-gradient(ellipse 20% 100% at 80% 55%, rgba(5,150,105,.06), transparent 55%);
    }
    :host-context([data-theme='light']) .top-bar-wave--2 {
      background:
        radial-gradient(ellipse 28% 130% at 35% 55%, rgba(52,211,153,.10), transparent 65%),
        radial-gradient(ellipse 22% 110% at 65% 45%, rgba(103,232,249,.08), transparent 55%),
        radial-gradient(ellipse 30% 120% at 85% 50%, rgba(16,224,160,.14), transparent 60%);
    }
    /* Respecter prefers-reduced-motion */
    @media (prefers-reduced-motion: reduce) {
      .top-bar-wave--1, .top-bar-wave--2 { animation: none }
    }

    .top-bar-left { display: flex; align-items: center; gap: 10px; min-width: 0; position: relative; z-index: 1 }
    .top-bar-brand {
      display: none;
      /* 44 x 44 : en mobile le libelle est masque, il ne reste que l icone. */
      min-width: 44px;
      min-height: 44px;
      justify-content: center;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      transition: opacity .2s;
    }
    .top-bar-brand:hover { opacity: .85 }
    .top-bar-brand-text {
      display: flex; align-items: baseline; gap: 4px;
      font-size: 14px; font-weight: 800;
      letter-spacing: -.01em;
      line-height: 1;
    }
    .top-bar-brand-name { color: var(--fg-primary) }
    .top-bar-brand-name--accent { color: var(--tracky-light) }

    .mobile-burger { display: none }
    .top-title { font-size: 16px; font-weight: 700; color: var(--fg-primary); position: relative; z-index: 1 }
    .top-actions { display: flex; align-items: center; gap: 8px; position: relative; z-index: 1 }
    .top-connected { flex-shrink: 0 }
    /* Sprint 3 — veilleur : boutons icône top-bar (thème + déconnexion) qui
       remplacent l'avatar profil. Même gabarit cercle 40px bordé pour la cohérence. */
    .top-icon-btn {
      display: flex; align-items: center; justify-content: center;
      width: 40px; height: 40px; border-radius: 9999px;
      background: transparent; border: 2px solid var(--border-subtle);
      color: var(--fg-secondary); cursor: pointer; padding: 0; transition: all .2s;
    }
    .top-icon-btn:hover { border-color: var(--tracky-light); color: var(--fg-primary) }
    .top-icon-btn--danger:hover { border-color: var(--danger); color: var(--danger) }
    /* User menu dropdown */
    .user-menu-wrapper { position: relative }
    .user-menu-trigger {
      display: flex; align-items: center; justify-content: center;
      background: transparent; border: 2px solid var(--border-subtle);
      border-radius: 9999px; cursor: pointer; padding: 0;
      transition: border-color .2s;
    }
    .user-menu-trigger:hover { border-color: var(--tracky-light) }
    /* 44 px sur le DECLENCHEUR : la pastille garde ses 36 px visuels, c est le
       bouton qui porte la cible. Mesure a 39 x 39 avant. */
    .user-menu-trigger { min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }
    .user-avatar {
      width: 36px; height: 36px; border-radius: 9999px;
      background: var(--color-tracky-light); color: var(--accent-ink);
      font-size: 12px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
    }
    .user-avatar--lg { width: 40px; height: 40px; font-size: 14px }
    .user-menu-backdrop { position: fixed; inset: 0; z-index: 8999 }
    .user-menu {
      position: absolute; top: calc(100% + 8px); right: 0; z-index: 9000;
      width: 240px; background: var(--bg-secondary);
      border: 1px solid var(--border-subtle); border-radius: 14px;
      box-shadow: 0 8px 30px rgba(0,0,0,.25); overflow: hidden;
      animation: menuFadeIn .15s ease-out;
    }
    @keyframes menuFadeIn { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: translateY(0) } }
    .user-menu-header {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 16px;
    }
    .user-menu-name { font-size: 13px; font-weight: 700; color: var(--fg-primary); margin: 0 }
    .user-menu-email { font-size: 11px; color: var(--fg-tertiary); margin: 2px 0 0 }
    .user-menu-divider { height: 1px; background: var(--border-subtle) }
    .user-menu-item {
      display: flex; align-items: center; gap: 10px;
      width: 100%; padding: 10px 16px;
      background: transparent; border: 0;
      color: var(--fg-secondary); font-size: 13px; font-weight: 500;
      text-decoration: none; cursor: pointer; transition: all .12s;
    }
    .user-menu-item:hover { background: var(--bg-tertiary); color: var(--fg-primary) }
    .user-menu-item--danger { color: var(--fg-tertiary) }
    .user-menu-item--danger:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent) }

    /* ─── MAIN ─── */
    .main-area { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0 }
    /* .content est LE seul scroller du shell PWA.
     *   - overscroll-behavior: contain : sur un scroller interne, ca MARCHE sur iOS
     *     (contrairement au document body). Bloque le rubber band et empeche le
     *     scroll de "fuir" vers le parent fixed.
     *   - -webkit-overflow-scrolling: touch : active le momentum scrolling iOS
     *     (smooth, inertie). Toujours utile en 2026 meme si officiellement deprecate
     *     (iOS continue de l'honorer pour ne pas casser des millions de sites).
     *   - min-height: 0 sur le flex parent : sans ca, le flex item peut depasser
     *     son parent et casser overflow:auto (bug flexbox classique). */
    .content {
      flex: 1;
      min-height: 0;
      padding: 24px;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      position: relative;
    }
    .content.fullscreen { padding: 0; overflow: hidden }

    /* ════════════════════════════════════════════════════════
       MODE BAANOOL (V1.12) — UI simplifiee per-user
       Cache sidebar desktop + bottom-bar mobile, la navigation se fait
       UNIQUEMENT via le burger top-left qui ouvre le bottom-sheet existant.
       Le content prend toute la largeur, comportement equivalent au mode
       fullscreen mais applique sur TOUTES les pages.
       Toggle dans /settings > Apparence > "Mode interface simplifiee".
       ════════════════════════════════════════════════════════ */
    .layout--baanool .desktop-sidebar { display: none !important; }
    .layout--baanool .bottom-bar { display: none !important; }
    .layout--baanool .main-area { width: 100%; }

    /* ══ ESPACE DÉPÔT (2026-08), lot A3 — L'ÉCART iOS / ANDROID ══════════════
     *
     * iOS   : barre d'onglets basse à 4 entrées (Carte · Missions · Historique · Compte).
     * Android : PAS de barre d'onglets — les trois boutons système occupent déjà le
     *           bas de l'écran. Le menu latéral (hamburger → feuille basse) prend le
     *           relais, et un FAB étendu « Partager » occupe le coin bas droit.
     *
     * L'écart est VOLONTAIRE : « les aplatir donne une application étrangère sur les
     * deux plateformes » (design/B1-PAGES.md).
     *
     * ⚠️ :host-context() est OBLIGATOIRE pour atteindre body.plat-android depuis un
     * composant à encapsulation émulée : un sélecteur d'ancêtre ordinaire serait
     * réécrit en body.plat-android[_ngcontent-xxx] — attribut posé sur body, qui ne
     * le porte pas — et la règle échouerait EN SILENCE.
     * (Aucun accent grave ici : il terminerait le littéral de styles.)
     * ════════════════════════════════════════════════════════ */
    /* ⚠️ CETTE REGLE MASQUAIT LA BARRE D'ONGLETS DU DEPOT SUR ANDROID.
       Elle appliquait A3 § 1 : les trois boutons systeme occupent deja le bas, une
       barre de plus y serait illisible, le menu lateral prenant le relais. Le relais
       existe bien — le burger reste affiche pour un depot — mais a l'usage le compte
       depot se retrouvait SANS ONGLETS, et cherchait une navigation qu'aucun repere
       ne signalait. Retire le 2026-08-12 sur retour d'usage.
       L'argument d'illisibilite ne tient plus : la barre porte deja
       padding-bottom: calc(env(safe-area-inset-bottom) + 6px), qui la place au-dessus
       des boutons systeme comme de la barre de gestes. */

    /* Vizyo Tracky en pied de menu, à 12 px : l'espace appartient visuellement au
       transporteur (A3 § 7, règle 5). */
    .depot-propulse { display: block; font-size: 12px; color: var(--depot-attenue, var(--fg-secondary)); text-align: center }
    /* Bug fix V1.12 : overflow:hidden ne doit s'appliquer qu'au /map fullscreen,
       sinon les pages avec contenu defilant (vehicle-detail, alerts, account)
       sont tronquees. On garde un padding horizontal pour que le contenu
       (onglets vehicle-detail, listes) ne colle pas aux bords de l'ecran. */
    .layout--baanool .content { padding: 0 16px; }
    .layout--baanool .content.fullscreen { overflow: hidden; }
    /* En mode baanool sur la page /map, on cache aussi le top-bar standard
     * car l'overlay Baanool fournit ses propres boutons (burger, alertes,
     * profile) en cercles flottants. Sur les autres pages, le top-bar reste
     * visible pour avoir le titre + retour. */
    .layout--baanool.layout--fullscreen .top-bar { display: none !important; height: 0 !important; min-height: 0 !important; overflow: hidden !important; }

    /* iOS PWA standalone en mode baanool : la .bottom-bar cachee laissait la
     * safe-area-inset-bottom (home indicator) en noir. On force un fond clair
     * et on etend le .content pour couvrir cette zone, en ajoutant un pseudo
     * en bas qui peint la safe-area-bottom de la meme couleur que la map. */
    body.ios-pwa .layout--baanool,
    body.ios-pwa .layout--baanool .main-area,
    body.ios-pwa .layout--baanool .content {
      background: var(--bg-primary, white);
    }
    body.ios-pwa .layout--baanool .content {
      padding-bottom: env(safe-area-inset-bottom);
    }
    /* Fullscreen (page /map) en baanool : la map doit occuper 100% — pas de
       padding-bottom qui reduit l'espace. Le ::after ci-dessous couvre deja
       la safe-area bottom. */
    body.ios-pwa .layout--baanool .content.fullscreen {
      padding-bottom: 0 !important;
    }
    /* Pseudo apres .layout qui colore la safe-area bottom (au cas ou un pixel
     * fuit, eviter le noir natif du body). */
    body.ios-pwa .layout--baanool::after {
      content: '';
      position: fixed;
      bottom: 0; left: 0; right: 0;
      height: env(safe-area-inset-bottom, 0px);
      /* Transparent pour laisser la map visible sous le home indicator.
         Le bg-primary creait une bande de couleur theme visible. */
      background: transparent;
      z-index: 0;
      pointer-events: none;
    }
    /* Note : les overrides pour cacher les overlays UI natifs du map.component
       en mode baanool (.tracky-mobile-topbar, .tracky-mobile-fab-main, etc.)
       sont dans styles.css global car ils traversent l'encapsulation Angular
       de map.component. */


    /* ════════════════════════════════════════════════════════
       MOBILE BOTTOM BAR (visible < 768px uniquement)
       ════════════════════════════════════════════════════════ */
    .bottom-bar { display: none }


    /* ════════════════════════════════════════════════════════
       MOBILE (< 768px)
       ════════════════════════════════════════════════════════ */
    @media (max-width: 768px) {
      .desktop-sidebar { display: none }

      .bottom-bar {
        display: flex;
        position: fixed;
        bottom: 0; left: 0; right: 0;
        z-index: 7000;
        background: var(--bg-secondary);
        border-top: 1px solid var(--border-subtle);
        backdrop-filter: blur(12px);
        padding: 6px 8px;
        padding-bottom: calc(env(safe-area-inset-bottom) + 6px);
        gap: 4px;
      }
      /* Quand la page est en fullscreen (route data { fullscreen:true }, ex: /map),
         on cache la barre du bas pour donner toute la place a la carte. */
      .bottom-bar.bottom-bar--hidden { display: none !important; }
      .bottom-item {
        flex: 1;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 3px;
        padding: 8px 4px;
        background: transparent; border: 0;
        color: var(--fg-tertiary);
        font-size: 10px; font-weight: 600;
        text-decoration: none;
        border-radius: 10px;
        transition: color .15s, background .15s;
        min-height: 48px;
      }
      .bottom-item:hover { background: var(--bg-tertiary) }
      .bottom-item.active { color: var(--tracky-light); background: var(--bg-tertiary) }
      .bottom-item lucide-icon { display: block }

      /* Mobile : touch targets 44x44 minimum (Apple HIG iOS, materiel design Android).
         Sur l'ancien 36x36 le user reportait "trop petit pour mon doigt" + clics
         rates 2-3 fois (cible too small, finger covers the icon entirely). */
      .mobile-burger {
        display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 10px;
        background: transparent; border: none; color: var(--fg-secondary); cursor: pointer;
      }
      .mobile-burger:hover { background: var(--bg-tertiary) }

      /* Bottom-sheet content (remplace l'ancien drawer lateral) */
      .bs-header {
        display: flex; align-items: center; gap: 8px;
        padding: 4px 4px 12px;
        border-bottom: 1px solid var(--border-subtle);
        margin-bottom: 8px;
      }
      .bs-brand {
        font-size: 13px; font-weight: 800; text-transform: uppercase;
        letter-spacing: .08em; color: var(--fg-primary);
      }
      .bs-nav-wrap { display: flex; flex-direction: column; gap: 4px }
      .bs-section { padding: 12px 4px 2px }
      .bs-nav {
        display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;
        padding: 2px 0 6px;
      }
      .bs-link {
        display: flex; align-items: center; gap: 12px;
        padding: 14px 14px; border-radius: 14px;
        color: var(--fg-secondary); text-decoration: none;
        font-size: 14px; font-weight: 600;
        background: var(--bg-tertiary);
        border: 1px solid transparent;
        transition: all .15s;
        min-height: 56px;
      }
      .bs-link:active { transform: scale(.97) }
      .bs-link.active {
        background: rgba(16,224,160,.1);
        color: var(--tracky-light);
        border-color: rgba(16,224,160,.25);
      }
      /* Mode sombre : un peu plus de contraste sur les cartes */
      :host-context([data-theme="dark"]) .bs-link {
        background: rgba(255,255,255,.04);
      }

      /* Mobile : on conserve le padding-top: env(safe-area-inset-top) de la regle de base
         (notch / Dynamic Island en PWA iOS standalone). Utiliser les longhand
         left/right au lieu du shorthand qui ecraserait le padding-top.
         Height: 64px sur mobile (vs 56 desktop) pour respirer les nouveaux
         tap-targets 44x44 et ne pas que les icones touchent les bords du top-bar. */
      .top-bar { padding-left: 14px; padding-right: 14px; height: 64px }
      /* Sur mobile, on cache le titre de page (présent dans la page) et on affiche
         le logo + brand pour rappeler l'identité Vizyo Tracky. */
      .top-title { display: none }
      .top-connected { display: none }
      .top-bar-brand { display: flex; flex-shrink: 0 }
      .top-bar-brand-text { font-size: 13px }
      /* Place réduite sur mobile (sélecteur société SA) : on garde le logo + « Tracky »
         seul, on masque « Vizyo » pour éviter que la barre soit trop tassée. */
      .top-bar-brand-name:not(.top-bar-brand-name--accent) { display: none }

      /* Padding-bottom du content : reserve la place pour la bottom-bar fixe.
         Bottom-bar = padding-top 6px + bottom-item (52px ios-pwa) +
                      padding-bottom (6px + safe-area-inset-bottom)
                    ≈ 64px (base) + safe-area-inset-bottom.
         On reserve 80px + safe-area-inset-bottom :
           - sur iPhone Pro (env=34) -> total 114px, bar=98px, gap=16px ✓
           - sur iPhone sans notch (env=0) -> total 80px, bar=64px, gap=16px ✓
         Gap visuel constant de ~16px au-dessus de la bar, peu importe le device.
         Avant : 160+env donnait jusqu'a 194px de padding = vaste zone vide
         visible sur les pages courtes (ex: "Mon compte"). */
      .content {
        padding: 16px;
        padding-bottom: calc(80px + env(safe-area-inset-bottom));
      }
      /* En fullscreen la bottom-bar est cachee : pas besoin de reserver de place
         pour elle, juste la safe-area pour les iPhones a notch. */
      .content.fullscreen {
        padding-bottom: env(safe-area-inset-bottom);
        padding-left: env(safe-area-inset-left);
        padding-right: env(safe-area-inset-right);
      }
    }

    @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
    @keyframes slideRight { from { transform: translateX(-100%) } to { transform: translateX(0) } }
  `],
})
export class DashboardLayoutComponent {
  protected readonly isIosPwa = (() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
    const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches
      || (navigator as any).standalone === true;
    return isIos && isStandalone;
  })();
  protected readonly menuState = inject(MenuStateService);
  protected readonly collapsed = signal(false);
  protected readonly fullscreen = signal(false);
  protected readonly pageTitle = signal('Tableau de bord');
  /** Barre de progression de route (§2.3) — affichée seulement pour les navigations
   *  « lentes » (> ~220ms). Les routes préchargées naviguent instantanément, donc
   *  aucun flash de barre à chaque clic (règle « loaders tardifs »). */
  protected readonly routeLoading = signal(false);
  private routeBarTimer: ReturnType<typeof setTimeout> | null = null;
  /** Alias vers le service partage (lecture seule depuis le template).
   *  V1.12 — Le state du menu mobile vit dans MenuStateService pour permettre
   *  au BaanoolMapOverlay de l'ouvrir sans passer par EventEmitter
   *  (bug iOS PWA + HMR : (menuClick) listener pas attache). */
  protected readonly mobileMenuOpen = this.menuState.mobileMenuOpen;
  /** V1.12 — Mode UI Baanool : layout simplifie, sidebar+bottom-bar cachees,
   *  navigation via burger uniquement, contenu en pleine largeur. */
  protected readonly isBaanoolMode = computed(() =>
    this.auth.user()?.preferences?.uiMode === 'baanool',
  );
  /** URL courante (mise à jour via NavigationEnd) — utilisee pour ne montrer
   *  l'overlay Baanool QUE sur la page /map. */
  protected readonly currentUrl = signal('');
  protected readonly isBaanoolMapPage = computed(() =>
    this.isBaanoolMode() && this.currentUrl().startsWith('/map'),
  );
  protected readonly MenuIcon = Menu;
  protected readonly XIcon = X;
  protected readonly MoreIcon = MoreHorizontal;
  protected readonly UserCircle2Icon = UserCircle2;
  protected readonly LogOutIcon = LogOut;
  protected readonly SunIcon = Sun;
  protected readonly MoonIcon = Moon;
  protected readonly SettingsIcon = Settings;
  protected readonly TerminalIcon = Terminal;
  protected readonly SparklesIcon = Sparkles;

  /** Carte promo « Agent IA » en pied de sidebar. L'agent IA est une fonction DE L'AGENDA
   *  (on y accède via /agenda) → on l'affiche seulement si l'utilisateur a réellement accès
   *  à l'agenda (`agenda_view`). Pas d'agenda = pas de carte IA. Masquée pour le veilleur. */
  protected readonly showAiPromo = computed(() =>
    !this.auth.isWatchman() && this.perms.can('agenda_view'),
  );

  protected isSuperAdmin(): boolean {
    return this.auth.user()?.role === 'SUPER_ADMIN';
  }
  /** Exposé au template pour la pastille « Connecté » (état socket temps réel). */
  protected readonly realtime = inject(RealtimeService);
  private readonly activityTracker = inject(ActivityTrackerService);
  protected readonly themeService = inject(ThemeService);
  protected readonly userMenuOpen = signal(false);

  /** V1.12 — Ferme le user-menu quand on click ailleurs que dans son wrapper.
   *  Avant : la cloche notif (sibling du wrapper) ouvrait son popup mais le
   *  user-menu restait en transparency en arriere-plan (z-index conflict, le
   *  bouton bell ne traversait pas le backdrop du menu). Le HostListener au
   *  document level capture tous les clicks et ferme le menu si la cible
   *  n'est pas dans `.user-menu-wrapper` — couvre bell, sidebar, n'importe ou. */
  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: MouseEvent): void {
    if (!this.userMenuOpen()) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.user-menu-wrapper')) {
      this.userMenuOpen.set(false);
    }
  }

  protected userInitials(): string {
    return (this.auth.user()?.email ?? '??').slice(0, 2).toUpperCase();
  }

  protected userEmail(): string {
    return this.auth.user()?.email ?? '';
  }

  protected toggleTheme(): void {
    this.themeService.setTheme(this.themeService.theme() === 'dark' ? 'light' : 'dark');
  }

  protected confirmLogout(): void {
    this.userMenuOpen.set(false);
    if (confirm('Se déconnecter de Vizyo Tracky ?')) {
      this.activityTracker.markSessionEnd('manual');
      this.realtime.disconnect();
      this.auth.logout();
      this.router.navigate(['/login']);
    }
  }

  protected logout(): void {
    this.activityTracker.markSessionEnd('manual');
    this.realtime.disconnect();
    this.auth.logout();
    this.router.navigate(['/login']);
  }

  protected readonly bottomItems = computed(() => {
    // Sprint 3 — veilleur de nuit : barre mobile réduite à « Véhicules ».
    if (this.auth.isWatchman()) {
      return [{ label: 'Véhicules', route: '/vehicles', icon: Truck }];
    }
    // Espace dépôt (2026-08), lot A3 — barre d'onglets à 4 entrées sur iOS.
    // Sur Android elle est masquée par CSS : les trois boutons système occupent déjà
    // le bas de l'écran, une barre de plus y serait illisible et le menu latéral
    // prend le relais (A3 § 1). C'est un écart VOLONTAIRE entre les plateformes.
    if (this.auth.isDepot()) {
      return [
        { label: 'Carte', route: '/depot', icon: Map },
        { label: 'Missions', route: '/depot/missions', icon: Route },
        { label: 'Historique', route: '/depot/history', icon: History },
        { label: 'Compte', route: '/account', icon: UserCircle2 },
      ];
    }
    return [
      { label: 'Dashboard', route: '/dashboard', icon: LayoutDashboard },
      ...(this.perms.can('vehicles_view') ? [
        { label: 'Carte', route: '/map', icon: Map },
        { label: 'Véhicules', route: '/vehicles', icon: Truck },
      ] : []),
      ...(this.perms.can('alerts_view') ? [{ label: 'Alertes', route: '/alerts', icon: Bell }] : []),
      { label: 'Plus', route: 'more', icon: MoreHorizontal },
    ];
  });

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly onboarding = inject(OnboardingService);
  private readonly consent = inject(ConsentService);
  private readonly permsOnboard = inject(PermissionOnboardingService);
  private readonly security = inject(SecurityService);
  private readonly notif = inject(NotificationsApiService);
  /** V1.15 — Cache fleet pour les badges contextuels SUPER_ADMIN. */
  private readonly fleetCache = inject(FleetCacheService);

  constructor() {
    // V1.10 (Sprint 5 stabilite) — takeUntilDestroyed evite l'accumulation de
    // subscriptions sur router.events si le layout est detruit/recree (cas
    // logout puis re-login dans la meme session navigateur).
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      // Barre de route (§2.3) — armée en différé au départ, coupée à l'arrivée.
      if (event instanceof NavigationStart) {
        if (this.routeBarTimer) clearTimeout(this.routeBarTimer);
        this.routeBarTimer = setTimeout(() => this.routeLoading.set(true), 220);
      } else if (event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError) {
        if (this.routeBarTimer) { clearTimeout(this.routeBarTimer); this.routeBarTimer = null; }
        this.routeLoading.set(false);
      }
      if (event instanceof NavigationEnd) {
        // Lot A3 — on descend jusqu'à la route la PLUS PROFONDE. Avant, on ne lisait
        // que le premier enfant : les quatre onglets de `/depot`, servis par un
        // `loadChildren`, portaient donc tous le titre de leur route parente. Chaque
        // écran d'un module chargé à la demande peut désormais nommer sa page.
        let child = this.route.firstChild;
        while (child?.firstChild) child = child.firstChild;
        const data = child?.snapshot.data ?? {};
        this.fullscreen.set(data['fullscreen'] === true);
        const title = typeof data['title'] === 'string' ? data['title'] : 'Tableau de bord';
        this.pageTitle.set(title);
        this.currentUrl.set(event.urlAfterRedirects);
        // V1.12 — Mode Baanool : /dashboard n'est pas accessible (filtre dans
        // navItems). Si on y atterrit (deep link, back depuis une page qui
        // route en dur vers /dashboard, redirect post-login residuel), on
        // renvoie vers /map en remplacant l'entree d'historique pour eviter
        // un piege "back -> dashboard -> back -> dashboard" en boucle.
        if (this.isBaanoolMode() && event.urlAfterRedirects === '/dashboard') {
          void this.router.navigate(['/map'], { replaceUrl: true });
        }
      }
    });
    // V1.5 (Sprint J) — au mount du layout (= apres login), charger le profil
    // et ouvrir le wizard si onboardingCompletedAt est null.
    //
    // ⚠️ Espace dépôt (2026-08), lot A3 — PAS pour un compte DEPOT. Le wizard de
    // flotte lui promettait « Prêt à piloter votre flotte ? » et « Coupure moteur
    // sécurisée à distance » : deux capacités que son rôle interdit, présentées comme
    // les siennes dès son premier écran. Le dépôt a son propre onboarding, celui
    // d'A3 § 5, qui explique ce qu'il verra et quand.
    if (!this.auth.isDepot()) void this.onboarding.loadProfileAndDecide();
    // Gate RGPD : lève l'écran de consentement obligatoire si la version courante
    // n'a pas été acceptée (le back renvoie aussi 403 CONSENT_REQUIRED en secours).
    void this.consent.load();
    // Sécurité — enregistre la connexion (appareil + position géo-IP) et applique la
    // décision adaptative : code e-mail si anomalie (2FA activé), ou proposition douce
    // d'activer le 2FA (non opt-in). Charge aussi l'état 2FA pour les Réglages.
    void this.security.connect();
    void this.security.loadTwoFactorStatus();
    // P3 — onboarding des permissions device (notif/GPS/hors-ligne) au 1er lancement.
    this.permsOnboard.init();
    // V1.8 (web-push-finalize) — bridge SW <-> client pose des le boot session,
    // pour que les actions "Acquitter" / "Voir" depuis une notif systeme soient
    // capturees meme si l'utilisateur n'a pas visite /account dans cette session.
    this.notif.installSwMessageBridge();
    void this.notif.loadStatus();
    // V1.12 — Refresh user au mount + au regain de focus pour synchroniser
    // les preferences (uiMode, role, permissions) modifiees ailleurs : autre
    // tab, admin update, ou session laissee ouverte plusieurs heures. Avant :
    // le cache localStorage restait stale jusqu'au prochain logout/login.
    void this.auth.refreshMe();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    // V1.15 — Pre-charge la liste des flottes pour SUPER_ADMIN, afin que les
    // badges contextuels (Société) apparaissent partout dans les listes sans
    // un round-trip API par card. No-op si pas SA (cf. FleetCacheService).
    void this.fleetCache.loadIfNeeded();
  }

  /** Refresh au regain de focus de l'onglet (visible apres background). */
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      void this.auth.refreshMe();
    }
  };

  protected readonly auth = inject(AuthService);
  /**
   * Espace dépôt (2026-08) — la marque du transporteur en tête du menu.
   *
   * Lu depuis le store du dépôt plutôt qu'ajouté à `AuthUser` : enrichir le contrat
   * du jeton pour un libellé d'en-tête modifierait un contrat d'API existant, ce que
   * le chantier réserve à un accord explicite (règle 5). Le store est peuplé dès la
   * première lecture de `/depot/live` ; d'ici là un repli neutre s'affiche.
   */
  protected readonly depotStore = inject(DepotLiveStore);
  private readonly perms = inject(PermissionsService);
  protected readonly network = inject(NetworkStatusService);

  protected readonly navItems = computed<NavGroup[]>(() => {
    // Sprint 3 — veilleur de nuit : navigation réduite à « Véhicules » (liste groupée + détail).
    // Cosmétique : le périmètre réel est garanti serveur (403) + watchmanChildGuard.
    if (this.auth.isWatchman()) {
      // Demande CDEF (2026-07) — un veilleur DÉSIGNÉ (permission `schedules_manage` accordée)
      // voit en plus la page « Horaires flotte ». Sinon, périmètre inchangé (liste véhicules).
      const items: NavItem[] = [{ label: 'Véhicules', route: '/vehicles', icon: Truck }];
      if (this.perms.can('schedules_manage')) {
        items.push({ label: 'Horaires flotte', route: '/fleet-schedules', icon: AlarmClock });
        // Lot 2 — visibilité de la couverture vie privée (véhicules non protégés hors travail).
        if (this.perms.can('privacy_manage')) {
          items.push({ label: 'Couverture vie privée', route: '/privacy-coverage', icon: ShieldCheck });
        }
      }
      return [{ section: null, items }];
    }
    // Espace dépôt (2026-08) — troisième mode spécial du shell, après le veilleur et
    // le mode simplifié. Quatre entrées, et rien d'autre : le dépôt n'est pas un
    // utilisateur de la flotte, c'est un tiers en lecture seule (A1 § 5).
    //
    // Les trois entrées à venir (Missions, Historique, Documents) sont livrées par le
    // lot A3. Les déclarer maintenant pointerait vers des routes inexistantes — un menu
    // qui promet ce qu'il ne tient pas est précisément le défaut que B1 § J relève sur
    // le mode simplifié. On les ajoute avec leurs écrans.
    if (this.auth.isDepot()) {
      return [
        {
          section: null,
          items: [
            { label: 'Carte live', route: '/depot', icon: Map },
            { label: 'Mes missions', route: '/depot/missions', icon: Route },
            { label: 'Historique', route: '/depot/history', icon: History },
            { label: 'Documents', route: '/depot/documents', icon: FileText },
          ],
        },
      ];
    }
    // V1.12 — Mode Baanool : menu reduit aux essentiels (un seul groupe, sans
    // en-tête). Pas de dashboard, groupes, geofences, rapports. Groupes =
    // onglet de Véhicules, Conducteurs = onglet d'Utilisateurs.
    if (this.isBaanoolMode()) {
      const items: NavItem[] = [
        ...(this.perms.can('vehicles_view') ? [
          { label: 'Carte', route: '/map', icon: Map },
          { label: 'Véhicules', route: '/vehicles', icon: Truck },
        ] : []),
        ...(this.perms.can('alerts_view') ? [{ label: 'Alertes', route: '/alerts', icon: Bell }] : []),
        ...(this.perms.can('users_view') ? [{ label: 'Utilisateurs', route: '/users', icon: Users }] : []),
        { label: 'Paramètres', route: '/settings', icon: Settings },
      ];
      return [{ section: null, items }];
    }
    // Regroupement en sections (eyebrows mono) — refonte DS §3.
    const supervision: NavItem[] = [
      { label: 'Tableau de bord', route: '/dashboard', icon: LayoutDashboard },
      // Consolidation IA : « Groupes » est un onglet DANS Véhicules.
      ...(this.perms.can('vehicles_view') ? [
        { label: 'Carte', route: '/map', icon: Map },
        { label: 'Véhicules', route: '/vehicles', icon: Truck },
      ] : []),
      // Consolidation IA : « Géofences » est un onglet DANS Alertes.
      ...(this.perms.can('alerts_view') ? [{ label: 'Alertes', route: '/alerts', icon: Bell }] : []),
      // Demande CDEF (2026-07) — Page flotte des horaires (coupe/reprise auto).
      ...(this.perms.can('schedules_manage') ? [{ label: 'Horaires flotte', route: '/fleet-schedules', icon: AlarmClock }] : []),
      ...(this.perms.can('privacy_manage') ? [{ label: 'Couverture vie privée', route: '/privacy-coverage', icon: ShieldCheck }] : []),
      // Lieux clés (2026-07) — stations-service validées + parkings / stationnements récurrents.
      ...(this.perms.can('places_view') ? [{ label: 'Lieux clés', route: '/places', icon: MapPin }] : []),
    ];
    const analyse: NavItem[] = [
      ...(this.perms.can('reports_view') ? [{ label: 'Rapports', route: '/reports', icon: FileBarChart }] : []),
      // Notation — score de conduite noté par véhicule / conducteur / groupe.
      ...(this.perms.can('reports_view') ? [{ label: 'Scores de conduite', route: '/scores', icon: GaugeIcon }] : []),
      // Sprint 7/9 — Agenda = hub calendrier unique (maintenance, incidents,
      // réservations, optimisation, copilote IA). Visible dès qu'un accès lié existe.
      ...(this.perms.can('agenda_view') || this.perms.can('reservations_view') || this.perms.can('reservations_request') || this.perms.can('ai_optimize')
        ? [{ label: 'Agenda', route: '/agenda', icon: Calendar }] : []),
    ];
    const administration: NavItem[] = [
      // Consolidation IA : « Conducteurs » est un onglet DANS Utilisateurs.
      ...(this.perms.can('users_view') ? [{ label: 'Utilisateurs', route: '/users', icon: Users }] : []),
      // Parc SIM — RÉSERVÉ au SUPER_ADMIN (l'abonnement inclut la SIM : gestion côté
      // opérateur uniquement). Accès via l'espace admin (/admin/sims), retiré de la nav client.
      // V1.15 — Suivi installation : réservé au FLEET_ADMIN (consultation + réordonnancement).
      ...(this.auth.user()?.role === 'FLEET_ADMIN' ? [{ label: 'Installation', route: '/installations', icon: ClipboardList }] : []),
      // Demande 2026-07 — « Activité flotte » : contrôle des coupures/rallumages moteur + présence
      // + historique de SA flotte. FLEET_ADMIN uniquement (le super-admin a son propre /admin/activity).
      ...(this.auth.user()?.role === 'FLEET_ADMIN' ? [{ label: 'Activité flotte', route: '/fleet-admin/activity', icon: Activity }] : []),
      // ⚠️ ECRAN SANS CHEMIN DE RETOUR (audit du 2026-08-03).
      //
      // Le client consent au partage partenaire depuis un lien d'e-mail, sur un ecran qui
      // promet « vous pouvez le couper à tout moment ». La route existait et etait gardee,
      // mais AUCUN lien de l'application n'y menait : passe le mail, la seule facon d'y
      // revenir etait de connaitre l'URL. Une promesse de reversibilite sans porte de
      // sortie n'est pas une promesse.
      ...(this.perms.can('integrations_manage') ? [{ label: 'Intégrations', route: '/integrations', icon: Plug }] : []),
    ];
    return ([
      { section: 'Supervision', items: supervision },
      { section: 'Analyse', items: analyse },
      { section: 'Administration', items: administration },
    ] satisfies NavGroup[]).filter((g) => g.items.length > 0);
  });
}
