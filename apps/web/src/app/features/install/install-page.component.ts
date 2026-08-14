import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideAngularModule,
  Download, Share, Plus, Monitor, Smartphone, Tablet, CheckCircle,
  Moon, Sun, Zap, Maximize2, Bell, Info,
} from 'lucide-angular';
import { InstallPromptService } from '../../core/services/install-prompt.service';
import { LogoComponent } from '../../shared/ui/logo/logo.component';
import { ThemeService } from '../../core/theme/theme.service';

type Platform = 'android' | 'ios' | 'desktop';
type DesktopOS = 'windows' | 'mac' | 'linux';

/**
 * Page publique /install (maquette 01e). Refonte DS : page centrée sur fond
 * branded, sélecteur segmenté Android / iPhone / Ordinateur (présélectionné sur
 * la plateforme détectée), carte par plateforme (bouton natif si
 * `beforeinstallprompt` dispo, sinon pas-à-pas manuel), badges Léger / Plein
 * écran / Notifications push. Logique PWA INCHANGÉE (InstallPromptService).
 */
@Component({
  selector: 'app-install-page',
  standalone: true,
  imports: [RouterLink, LucideAngularModule, LogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ip-page">
      <div class="ip-grid" aria-hidden="true"></div>
      <div class="ip-glow" aria-hidden="true"></div>

      <button type="button" class="ip-theme" (click)="theme.toggle()" aria-label="Changer de thème">
        <lucide-icon [img]="theme.theme() === 'dark' ? MoonIcon : SunIcon" [size]="17"></lucide-icon>
      </button>

      <div class="ip-wrap">
        <!-- Logo + titre -->
        <div class="ip-head">
          <app-logo variant="icon" [size]="56" />
          <h1 class="ip-title">Installer Vizyo Tracky</h1>
          <p class="ip-sub">Accès rapide, plein écran, notifications en temps réel — comme une vraie application.</p>
        </div>

        @if (installService.isStandalone()) {
          <!-- Déjà installé -->
          <div class="ip-card ip-card--ok">
            <span class="ip-ic ip-ic--ok"><lucide-icon [img]="CheckCircleIcon" [size]="26"></lucide-icon></span>
            <p class="ip-ok-t">Tracky est déjà installé sur cet appareil</p>
            <p class="ip-ok-s">Vous pouvez fermer cette page et ouvrir l'application.</p>
          </div>
        } @else {
          <!-- Sélecteur de plateforme -->
          <div class="ip-seg">
            <button type="button" class="ip-seg-btn" [class.on]="selectedPlatform() === 'android'" (click)="selectedPlatform.set('android')">
              <lucide-icon [img]="SmartphoneIcon" [size]="15"></lucide-icon>Android
            </button>
            <button type="button" class="ip-seg-btn" [class.on]="selectedPlatform() === 'ios'" (click)="selectedPlatform.set('ios')">
              <lucide-icon [img]="TabletIcon" [size]="15"></lucide-icon>iPhone
            </button>
            <button type="button" class="ip-seg-btn" [class.on]="selectedPlatform() === 'desktop'" (click)="selectedPlatform.set('desktop')">
              <lucide-icon [img]="MonitorIcon" [size]="15"></lucide-icon>Ordinateur
            </button>
          </div>

          <!-- ANDROID -->
          @if (selectedPlatform() === 'android') {
            <div class="ip-card ip-plat">
              <div class="ip-card-head">
                <span class="ip-ic"><lucide-icon [img]="SmartphoneIcon" [size]="22"></lucide-icon></span>
                <div><div class="ip-card-t">Android</div><div class="ip-card-s">Chrome ou Edge</div></div>
              </div>
              @if (installService.canInstall()) {
                <button type="button" class="ip-btn" (click)="onInstall()">
                  <lucide-icon [img]="DownloadIcon" [size]="18"></lucide-icon>Installer l'application
                </button>
              }
              <div class="ip-manual" [class.ip-manual--solo]="!installService.canInstall()">
                @if (installService.canInstall()) { <div class="ip-manual-h">Ou manuellement</div> }
                <ol class="ip-steps">
                  <li><span class="ip-step-n">1</span>Ouvrez cette page dans <strong>Chrome</strong></li>
                  <li><span class="ip-step-n">2</span>Menu <strong>⋮</strong> en haut à droite</li>
                  <li><span class="ip-step-n">3</span>Touchez <strong>« Installer l'application »</strong></li>
                </ol>
              </div>
            </div>
          }

          <!-- iOS -->
          @if (selectedPlatform() === 'ios') {
            <div class="ip-card ip-plat">
              <div class="ip-card-head">
                <span class="ip-ic"><lucide-icon [img]="TabletIcon" [size]="22"></lucide-icon></span>
                <div><div class="ip-card-t">iPhone / iPad</div><div class="ip-card-s">Safari</div></div>
              </div>
              <div class="ip-note">
                <lucide-icon [img]="InfoIcon" [size]="16"></lucide-icon>
                <span>Sur iOS, l'installation se fait manuellement depuis Safari.</span>
              </div>
              <ol class="ip-steps">
                <li><span class="ip-step-n">1</span>Ouvrez cette page dans <strong>Safari</strong></li>
                <li><span class="ip-step-n">2</span>Touchez <lucide-icon [img]="ShareIcon" [size]="15" class="ip-inl"></lucide-icon> <strong>Partager</strong></li>
                <li><span class="ip-step-n">3</span>Touchez <lucide-icon [img]="PlusIcon" [size]="15" class="ip-inl"></lucide-icon> <strong>« Sur l'écran d'accueil »</strong></li>
              </ol>
            </div>
          }

          <!-- DESKTOP -->
          @if (selectedPlatform() === 'desktop') {
            <div class="ip-card ip-plat">
              <div class="ip-card-head">
                <span class="ip-ic"><lucide-icon [img]="MonitorIcon" [size]="22"></lucide-icon></span>
                <div><div class="ip-card-t">{{ desktopLabel() }}</div><div class="ip-card-s">Windows · macOS · Linux — Chrome/Edge</div></div>
              </div>
              @if (installService.canInstall()) {
                <button type="button" class="ip-btn" (click)="onInstall()">
                  <lucide-icon [img]="DownloadIcon" [size]="18"></lucide-icon>Installer
                </button>
              }
              <div class="ip-manual" [class.ip-manual--solo]="!installService.canInstall()">
                @if (installService.canInstall()) { <div class="ip-manual-h">Ou manuellement</div> }
                <ol class="ip-steps">
                  <li><span class="ip-step-n">1</span>Ouvrez dans <strong>Chrome</strong> ou <strong>Edge</strong></li>
                  <li><span class="ip-step-n">2</span>Cliquez <strong>⊕</strong> dans la barre d'adresse</li>
                  <li><span class="ip-step-n">3</span>Cliquez <strong>« Installer »</strong></li>
                </ol>
              </div>
            </div>
          }
        }

        <!-- Badges -->
        <div class="ip-badges">
          <span class="ip-badge"><lucide-icon [img]="ZapIcon" [size]="14"></lucide-icon>Léger</span>
          <span class="ip-badge"><lucide-icon [img]="MaximizeIcon" [size]="14"></lucide-icon>Plein écran</span>
          <span class="ip-badge"><lucide-icon [img]="BellIcon" [size]="14"></lucide-icon>Notifications push</span>
        </div>

        <p class="ip-foot">Déjà un compte ? <a routerLink="/login">Se connecter</a></p>
      </div>
    </div>
  `,
  styles: [`
    /* Cibles tactiles — critère « iPhone 390 px : cibles ≥ 44 px ». Cette page s'ouvre
       depuis un QR code, donc TOUJOURS sur un téléphone : c'est le dernier endroit où
       une commande devrait demander de la précision. */
    @media (max-width: 768px) {
      .ip-seg-btn, .ip-theme { min-width: 44px; min-height: 44px }
    }
    .ip-page { position: relative; min-height: 100svh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 44px max(22px, env(safe-area-inset-left)); background: var(--bg-primary); overflow: hidden; }
    .ip-grid {
      position: absolute; inset: 0; pointer-events: none;
      background-image:
        linear-gradient(color-mix(in srgb, var(--fg-primary) 4%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in srgb, var(--fg-primary) 4%, transparent) 1px, transparent 1px);
      background-size: 46px 46px;
      -webkit-mask-image: radial-gradient(ellipse 64% 50% at 50% 32%, #000, transparent 78%);
      mask-image: radial-gradient(ellipse 64% 50% at 50% 32%, #000, transparent 78%);
    }
    .ip-glow { position: absolute; top: -8%; left: 50%; transform: translateX(-50%); width: 620px; height: 380px; pointer-events: none; background: radial-gradient(ellipse at center, color-mix(in srgb, var(--tracky-light) 12%, transparent), transparent 66%); filter: blur(8px); }
    .ip-theme { position: absolute; top: 22px; right: 22px; z-index: 2; display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 10px; border: 1px solid var(--border-subtle); background: var(--bg-secondary); color: var(--fg-secondary); cursor: pointer; transition: color .2s, border-color .2s; }
    .ip-theme:hover { color: var(--fg-primary); border-color: var(--border-strong); }

    .ip-wrap { position: relative; z-index: 1; width: 100%; max-width: 412px; }
    .ip-head { text-align: center; margin-bottom: 24px; }
    .ip-head app-logo { display: inline-block; margin-bottom: 14px; }
    .ip-title { margin: 0; font-family: var(--font-display, inherit); font-size: 1.7rem; font-weight: 800; letter-spacing: -.02em; color: var(--fg-primary); }
    .ip-sub { margin: 10px 0 0; font-size: .94rem; color: var(--fg-secondary); line-height: 1.5; }

    .ip-seg { display: flex; gap: 4px; padding: 4px; border-radius: 13px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); margin-bottom: 16px; }
    .ip-seg-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 9px 6px; border-radius: 10px; border: none; background: transparent; color: var(--fg-tertiary); font-family: inherit; font-size: .84rem; font-weight: 700; cursor: pointer; transition: color .18s, background .18s; }
    .ip-seg-btn:hover { color: var(--fg-secondary); }
    /* Convention du kit (styles.css) : l'etat actif prend --texte-succes, pas
       le vert de marque. Sur --bg-secondary clair : 3,43 -> 5,97:1. */
    .ip-seg-btn.on { background: var(--bg-secondary); color: var(--texte-succes); box-shadow: 0 1px 2px rgba(0,0,0,.2); }

    .ip-card { padding: 22px; border-radius: 20px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); box-shadow: 0 1px 2px rgba(0,0,0,.35), 0 30px 70px -22px rgba(0,0,0,.5); animation: ip-fade .3s cubic-bezier(.16,1,.3,1); }
    @keyframes ip-fade { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
    @media (prefers-reduced-motion: reduce) { .ip-card { animation: none } }
    .ip-card--ok { text-align: center; }
    .ip-card-head { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
    .ip-ic { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 13px; flex-shrink: 0; background: color-mix(in srgb, var(--tracky-light) 12%, transparent); color: var(--tracky-light); }
    .ip-ic--ok { width: 48px; height: 48px; border-radius: 50%; margin-bottom: 12px; }
    .ip-card-t { font-size: 1rem; font-weight: 700; color: var(--fg-primary); }
    .ip-card-s { font-family: var(--font-mono, monospace); font-size: .72rem; color: var(--fg-tertiary); margin-top: 2px; }
    .ip-ok-t { margin: 0; font-size: 1.05rem; font-weight: 700; color: var(--fg-primary); }
    .ip-ok-s { margin: 6px 0 0; font-size: .88rem; color: var(--fg-tertiary); }

    .ip-btn { width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 9px; padding: 14px; border-radius: 12px; border: none; background: var(--tracky-light); color: var(--accent-ink); font-family: inherit; font-weight: 700; font-size: .96rem; cursor: pointer; box-shadow: 0 10px 26px -8px color-mix(in srgb, var(--tracky-light) 45%, transparent); transition: transform .2s, box-shadow .2s; }
    .ip-btn:hover { transform: translateY(-2px); box-shadow: 0 16px 34px -10px color-mix(in srgb, var(--tracky-light) 55%, transparent); }

    .ip-manual { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-subtle); }
    .ip-manual--solo { margin-top: 0; padding-top: 0; border-top: none; }
    .ip-manual-h { font-family: var(--font-mono, monospace); font-size: .64rem; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--fg-tertiary); margin-bottom: 12px; }
    .ip-note { display: flex; gap: 9px; align-items: flex-start; padding: 11px 13px; border-radius: 11px; margin-bottom: 16px; background: color-mix(in srgb, var(--tracky-light) 10%, transparent); border: 1px solid color-mix(in srgb, var(--tracky-light) 24%, transparent); }
    .ip-note lucide-icon { color: var(--tracky-light); flex-shrink: 0; margin-top: 1px; }
    .ip-note span { font-size: .82rem; color: var(--fg-secondary); line-height: 1.45; }

    .ip-steps { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 12px; }
    .ip-steps li { display: flex; gap: 12px; align-items: center; font-size: .88rem; color: var(--fg-secondary); }
    .ip-steps strong { color: var(--fg-primary); font-weight: 700; }
    .ip-step-n { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 50%; background: var(--bg-tertiary); color: var(--fg-secondary); font-size: .78rem; font-weight: 700; }
    .ip-inl { color: var(--tracky-light); vertical-align: middle; }

    .ip-badges { display: flex; flex-wrap: wrap; justify-content: center; gap: 9px; margin-top: 20px; }
    .ip-badge { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 999px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); font-size: .8rem; font-weight: 600; }
    .ip-badge lucide-icon { color: var(--tracky-light); }

    .ip-foot { margin: 24px 0 0; text-align: center; font-size: .86rem; color: var(--fg-tertiary); }
    /* 3,34:1 en clair. La sonde de recette signale aussi sa cible a 80x18 — c'est
       son angle mort n° 3 : un lien EN LIGNE dans une phrase, l'elargir casserait
       le texte. Seule la couleur change. */
    .ip-foot a { color: var(--texte-succes); font-weight: 600; }
    .ip-foot a:hover { text-decoration: underline; }
  `],
})
export class InstallPageComponent {
  protected readonly installService = inject(InstallPromptService);
  protected readonly theme = inject(ThemeService);

  protected readonly DownloadIcon = Download;
  protected readonly ShareIcon = Share;
  protected readonly PlusIcon = Plus;
  protected readonly MonitorIcon = Monitor;
  protected readonly SmartphoneIcon = Smartphone;
  protected readonly TabletIcon = Tablet;
  protected readonly CheckCircleIcon = CheckCircle;
  protected readonly MoonIcon = Moon;
  protected readonly SunIcon = Sun;
  protected readonly ZapIcon = Zap;
  protected readonly MaximizeIcon = Maximize2;
  protected readonly BellIcon = Bell;
  protected readonly InfoIcon = Info;

  /** Plateforme détectée (UA) — sert de présélection au sélecteur segmenté. */
  private detectPlatform(): Platform {
    const ua = navigator.userAgent;
    if (/Android/i.test(ua)) return 'android';
    if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
    return 'desktop';
  }

  /** Plateforme affichée : présélectionnée sur la détection, changeable via le segmented. */
  protected readonly selectedPlatform = signal<Platform>(this.detectPlatform());

  protected readonly desktopOS = computed<DesktopOS>(() => {
    const ua = navigator.userAgent;
    if (/Macintosh|Mac OS/i.test(ua)) return 'mac';
    if (/Linux/i.test(ua)) return 'linux';
    return 'windows';
  });

  protected readonly desktopLabel = computed(() => {
    switch (this.desktopOS()) {
      case 'mac': return 'macOS';
      case 'linux': return 'Linux';
      default: return 'Ordinateur';
    }
  });

  protected onInstall(): void {
    this.installService.promptInstall();
  }
}
