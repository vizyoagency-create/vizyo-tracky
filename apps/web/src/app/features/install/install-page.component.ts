import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideAngularModule,
  Download,
  Share,
  Plus,
  Monitor,
  Smartphone,
  Tablet,
  CheckCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-angular';
import { InstallPromptService } from '../../core/services/install-prompt.service';
import { LogoComponent } from '../../shared/ui/logo/logo.component';

type Platform = 'android' | 'ios' | 'desktop';
type DesktopOS = 'windows' | 'mac' | 'linux';

@Component({
  selector: 'app-install-page',
  standalone: true,
  imports: [RouterLink, LucideAngularModule, LogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="min-h-screen flex flex-col items-center justify-center bg-bg-primary relative overflow-hidden py-8 sm:py-12">
      <div class="absolute inset-0 pointer-events-none"
           style="background: radial-gradient(ellipse at 50% 30%, rgba(16,224,160,0.08) 0%, transparent 60%)">
      </div>

      <div class="relative z-10 w-full max-w-md px-5">
        <!-- Logo -->
        <div class="flex flex-col items-center mb-6 sm:mb-8">
          <app-logo variant="lockup" [size]="72" />
        </div>

        <!-- Title -->
        <div class="text-center mb-6">
          <h1 class="text-2xl font-display font-semibold text-fg-primary mb-2">
            Installer Vizyo Tracky
          </h1>
          <p class="text-fg-tertiary text-sm">
            Acces rapide, plein ecran, notifications en temps reel
          </p>
        </div>

        @if (installService.isStandalone()) {
          <!-- Already installed -->
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-6 text-center mb-6">
            <div class="flex justify-center mb-3">
              <div class="w-12 h-12 rounded-full bg-emerald-500/15 flex items-center justify-center">
                <lucide-icon [img]="CheckCircleIcon" [size]="28" class="text-emerald-400"></lucide-icon>
              </div>
            </div>
            <p class="text-fg-primary font-medium text-lg mb-1">Tracky est deja installe sur cet appareil</p>
            <p class="text-fg-tertiary text-sm">Vous pouvez fermer cette page et ouvrir l'application.</p>
          </div>
        } @else {
          <!-- Primary platform card -->
          @if (detectedPlatform() === 'android') {
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-6 mb-4">
              <div class="flex items-center gap-3 mb-4">
                <div class="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center">
                  <lucide-icon [img]="SmartphoneIcon" [size]="20" class="text-emerald-400"></lucide-icon>
                </div>
                <div>
                  <p class="text-fg-primary font-medium">Android</p>
                  <p class="text-fg-tertiary text-xs">Chrome ou Edge</p>
                </div>
              </div>
              @if (installService.canInstall()) {
                <button (click)="onInstall()"
                  class="w-full py-3 px-6 rounded-xl font-medium text-white bg-tracky-gradient hover:opacity-90 transition-opacity duration-200 cursor-pointer">
                  <div class="flex items-center justify-center gap-2">
                    <lucide-icon [img]="DownloadIcon" [size]="18"></lucide-icon>
                    Installer l'application
                  </div>
                </button>
              } @else {
                <ol class="space-y-3 text-sm text-fg-secondary">
                  <li class="flex gap-3">
                    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-bg-tertiary text-fg-tertiary text-xs flex items-center justify-center font-medium">1</span>
                    <span>Ouvrez cette page dans <strong class="text-fg-primary">Chrome</strong></span>
                  </li>
                  <li class="flex gap-3">
                    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-bg-tertiary text-fg-tertiary text-xs flex items-center justify-center font-medium">2</span>
                    <span>Touchez le menu <strong class="text-fg-primary">&#x22EE;</strong> en haut a droite</span>
                  </li>
                  <li class="flex gap-3">
                    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-bg-tertiary text-fg-tertiary text-xs flex items-center justify-center font-medium">3</span>
                    <span>Touchez <strong class="text-fg-primary">"Installer l'application"</strong></span>
                  </li>
                </ol>
              }
            </div>
          }

          @if (detectedPlatform() === 'ios') {
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-6 mb-4">
              <div class="flex items-center gap-3 mb-4">
                <div class="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center">
                  <lucide-icon [img]="TabletIcon" [size]="20" class="text-emerald-400"></lucide-icon>
                </div>
                <div>
                  <p class="text-fg-primary font-medium">iPhone / iPad</p>
                  <p class="text-fg-tertiary text-xs">Safari</p>
                </div>
              </div>
              <ol class="space-y-3 text-sm text-fg-secondary">
                <li class="flex gap-3">
                  <span class="flex-shrink-0 w-6 h-6 rounded-full bg-bg-tertiary text-fg-tertiary text-xs flex items-center justify-center font-medium">1</span>
                  <span>Ouvrez cette page dans <strong class="text-fg-primary">Safari</strong></span>
                </li>
                <li class="flex gap-3">
                  <span class="flex-shrink-0 w-6 h-6 rounded-full bg-bg-tertiary text-fg-tertiary text-xs flex items-center justify-center font-medium">2</span>
                  <span class="flex items-center gap-1">
                    Touchez l'icone
                    <lucide-icon [img]="ShareIcon" [size]="16" class="text-tracky-light inline-block"></lucide-icon>
                    <strong class="text-fg-primary">Partager</strong>
                  </span>
                </li>
                <li class="flex gap-3">
                  <span class="flex-shrink-0 w-6 h-6 rounded-full bg-bg-tertiary text-fg-tertiary text-xs flex items-center justify-center font-medium">3</span>
                  <span class="flex items-center gap-1">
                    Touchez
                    <lucide-icon [img]="PlusIcon" [size]="16" class="text-tracky-light inline-block"></lucide-icon>
                    <strong class="text-fg-primary">"Sur l'ecran d'accueil"</strong>
                  </span>
                </li>
              </ol>
            </div>
          }

          @if (detectedPlatform() === 'desktop') {
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-6 mb-4">
              <div class="flex items-center gap-3 mb-4">
                <div class="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center">
                  <lucide-icon [img]="MonitorIcon" [size]="20" class="text-emerald-400"></lucide-icon>
                </div>
                <div>
                  <p class="text-fg-primary font-medium">{{ desktopLabel() }}</p>
                  <p class="text-fg-tertiary text-xs">Chrome ou Edge</p>
                </div>
              </div>
              @if (installService.canInstall()) {
                <button (click)="onInstall()"
                  class="w-full py-3 px-6 rounded-xl font-medium text-white bg-tracky-gradient hover:opacity-90 transition-opacity duration-200 cursor-pointer">
                  <div class="flex items-center justify-center gap-2">
                    <lucide-icon [img]="DownloadIcon" [size]="18"></lucide-icon>
                    Installer
                  </div>
                </button>
              } @else {
                <ol class="space-y-3 text-sm text-fg-secondary">
                  <li class="flex gap-3">
                    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-bg-tertiary text-fg-tertiary text-xs flex items-center justify-center font-medium">1</span>
                    <span>Ouvrez cette page dans <strong class="text-fg-primary">Chrome</strong> ou <strong class="text-fg-primary">Edge</strong></span>
                  </li>
                  <li class="flex gap-3">
                    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-bg-tertiary text-fg-tertiary text-xs flex items-center justify-center font-medium">2</span>
                    <span>Cliquez l'icone <strong class="text-fg-primary">&#x2295;</strong> dans la barre d'adresse</span>
                  </li>
                  <li class="flex gap-3">
                    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-bg-tertiary text-fg-tertiary text-xs flex items-center justify-center font-medium">3</span>
                    <span>Cliquez <strong class="text-fg-primary">"Installer"</strong></span>
                  </li>
                </ol>
              }
            </div>
          }

          <!-- Other platforms (collapsible) -->
          <div class="mb-6">
            <button (click)="otherExpanded.set(!otherExpanded())"
              class="w-full flex items-center justify-center gap-2 text-sm text-fg-tertiary hover:text-fg-secondary transition-colors cursor-pointer py-2">
              <span>Autres plateformes</span>
              @if (otherExpanded()) {
                <lucide-icon [img]="ChevronUpIcon" [size]="16"></lucide-icon>
              } @else {
                <lucide-icon [img]="ChevronDownIcon" [size]="16"></lucide-icon>
              }
            </button>

            @if (otherExpanded()) {
              <div class="space-y-3 mt-2">
                @for (p of otherPlatforms(); track p) {
                  @if (p === 'android') {
                    <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-5">
                      <div class="flex items-center gap-3 mb-3">
                        <lucide-icon [img]="SmartphoneIcon" [size]="18" class="text-fg-tertiary"></lucide-icon>
                        <p class="text-fg-primary font-medium text-sm">Android</p>
                      </div>
                      <ol class="space-y-2 text-xs text-fg-secondary">
                        <li>1. Ouvrez dans Chrome</li>
                        <li>2. Menu &#x22EE; en haut a droite</li>
                        <li>3. "Installer l'application"</li>
                      </ol>
                    </div>
                  }
                  @if (p === 'ios') {
                    <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-5">
                      <div class="flex items-center gap-3 mb-3">
                        <lucide-icon [img]="TabletIcon" [size]="18" class="text-fg-tertiary"></lucide-icon>
                        <p class="text-fg-primary font-medium text-sm">iPhone / iPad</p>
                      </div>
                      <ol class="space-y-2 text-xs text-fg-secondary">
                        <li class="flex items-center gap-1">
                          1. Ouvrez dans Safari
                        </li>
                        <li class="flex items-center gap-1">
                          2. Touchez
                          <lucide-icon [img]="ShareIcon" [size]="13" class="text-tracky-light"></lucide-icon>
                          Partager
                        </li>
                        <li class="flex items-center gap-1">
                          3. Touchez
                          <lucide-icon [img]="PlusIcon" [size]="13" class="text-tracky-light"></lucide-icon>
                          "Sur l'ecran d'accueil"
                        </li>
                      </ol>
                    </div>
                  }
                  @if (p === 'desktop') {
                    <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-5">
                      <div class="flex items-center gap-3 mb-3">
                        <lucide-icon [img]="MonitorIcon" [size]="18" class="text-fg-tertiary"></lucide-icon>
                        <p class="text-fg-primary font-medium text-sm">Ordinateur</p>
                      </div>
                      <ol class="space-y-2 text-xs text-fg-secondary">
                        <li>1. Ouvrez dans Chrome ou Edge</li>
                        <li>2. Cliquez &#x2295; dans la barre d'adresse</li>
                        <li>3. Cliquez "Installer"</li>
                      </ol>
                    </div>
                  }
                }
              </div>
            }
          </div>
        }

        <!-- Feature badges -->
        <div class="flex items-center justify-center gap-3 mb-6 flex-wrap">
          <span class="px-3 py-1.5 rounded-full bg-bg-secondary border border-border-subtle text-fg-secondary text-xs font-medium">
            Leger
          </span>
          <span class="px-3 py-1.5 rounded-full bg-bg-secondary border border-border-subtle text-fg-secondary text-xs font-medium">
            Plein ecran
          </span>
          <span class="px-3 py-1.5 rounded-full bg-bg-secondary border border-border-subtle text-fg-secondary text-xs font-medium">
            Notifications push
          </span>
        </div>

        <!-- Footer link -->
        <p class="text-center text-sm text-fg-tertiary">
          Deja un compte ?
          <a routerLink="/login" class="text-tracky-light hover:underline cursor-pointer">Se connecter</a>
        </p>
      </div>
    </div>
  `,
})
export class InstallPageComponent {
  protected readonly installService = inject(InstallPromptService);

  protected readonly DownloadIcon = Download;
  protected readonly ShareIcon = Share;
  protected readonly PlusIcon = Plus;
  protected readonly MonitorIcon = Monitor;
  protected readonly SmartphoneIcon = Smartphone;
  protected readonly TabletIcon = Tablet;
  protected readonly CheckCircleIcon = CheckCircle;
  protected readonly ChevronDownIcon = ChevronDown;
  protected readonly ChevronUpIcon = ChevronUp;

  protected readonly otherExpanded = signal(false);

  protected readonly detectedPlatform = computed<Platform>(() => {
    const ua = navigator.userAgent;
    if (/Android/i.test(ua)) return 'android';
    if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
    return 'desktop';
  });

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
      default: return 'Windows';
    }
  });

  protected readonly otherPlatforms = computed<Platform[]>(() => {
    const all: Platform[] = ['android', 'ios', 'desktop'];
    return all.filter((p) => p !== this.detectedPlatform());
  });

  protected onInstall(): void {
    this.installService.promptInstall();
  }
}
