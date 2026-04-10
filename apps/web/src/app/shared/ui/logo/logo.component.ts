import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

type LogoVariant = 'icon' | 'lockup';
type LogoTheme = 'dark' | 'light' | 'auto';

@Component({
  selector: 'app-logo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <img [src]="src()" [height]="size()" [alt]="'Vizyo Tracky'" class="block" />
  `,
})
export class LogoComponent {
  readonly variant = input<LogoVariant>('lockup');
  readonly theme = input<LogoTheme>('auto');
  readonly size = input(32);

  protected readonly src = computed(() => {
    const resolvedTheme = this.theme() === 'auto' ? 'dark' : this.theme();
    const v = this.variant();

    if (v === 'icon') {
      return resolvedTheme === 'dark'
        ? 'logos/svg/vizyo-tracky-icon-white.svg'
        : 'logos/svg/vizyo-tracky-icon-black.svg';
    }

    return resolvedTheme === 'dark'
      ? 'logos/png/vizyo-tracky-icon-white-lockup-gradient-green.png'
      : 'logos/png/vizyo-tracky-icon-black-lockup-gradient-green.png';
  });
}
