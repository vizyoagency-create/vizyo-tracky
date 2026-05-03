import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ThemeService } from '../../../core/theme/theme.service';

type LogoVariant = 'icon' | 'lockup';
type LogoTheme = 'dark' | 'light' | 'auto';

@Component({
  selector: 'app-logo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <img [src]="src()" [style.height.px]="size()" [alt]="'Vizyo Tracky'" style="width:auto;display:block" />
  `,
})
export class LogoComponent {
  readonly variant = input<LogoVariant>('lockup');
  readonly theme = input<LogoTheme>('auto');
  readonly size = input(32);

  private readonly themeService = inject(ThemeService);

  protected readonly src = computed(() => {
    const resolvedTheme = this.theme() === 'auto' ? this.themeService.theme() : this.theme();
    const v = this.variant();

    if (v === 'icon') {
      return resolvedTheme === 'dark'
        ? 'logos/svg/vizyo-tracky-icon-white.svg'
        : 'logos/svg/vizyo-tracky-icon-green.svg';
    }

    return resolvedTheme === 'dark'
      ? 'logos/png/vizyo-tracky-icon-white-lockup-gradient-green.png'
      : 'logos/png/vizyo-tracky-icon-black-lockup-gradient-green.png';
  });
}
