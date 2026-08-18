import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Camera, Keyboard, LucideAngularModule, X, Zap, ZapOff } from 'lucide-angular';
import { candidatsDepuisScan, type CandidatIdentifiant } from '@vizyo/tracky-shared';

/**
 * Lecteur de code-barré pour les étiquettes de boîtier (IMEI / ICCID).
 *
 * ── CE QU'IL REND, ET CE QU'IL NE DÉCIDE PAS ─────────────────────────────────────────
 *
 * Il émet des CANDIDATS, pas un verdict. Un IMEI et un numéro SIM font tous deux quinze
 * chiffres sur ce parc : c'est l'inventaire, côté serveur, qui dira lequel existe. Le
 * scanner se contente de lire proprement et de proposer dans le bon ordre.
 *
 * ── SUPPORT NAVIGATEUR, DIT FRANCHEMENT ──────────────────────────────────────────────
 *
 * `BarcodeDetector` est natif sur Chrome Android — le cas d'usage terrain. Safari iOS ne
 * l'implémente pas, et aucune bibliothèque n'est embarquée ici : sur iPhone on bascule
 * donc sur la saisie manuelle, en le DISANT. Un scanner qui échoue en silence sur un
 * quai, gants aux mains, est pire que pas de scanner du tout.
 */
type DetecteurCode = {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
};

@Component({
  selector: 'app-scanner-code',
  standalone: true,
  imports: [LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sc-ov" (click)="fermer()">
      <div class="sc-modal" (click)="$event.stopPropagation()">
        <header class="sc-head">
          <span class="sc-title">Scanner l'étiquette du boîtier</span>
          <button type="button" class="sc-x" (click)="fermer()" aria-label="Fermer">
            <lucide-icon [img]="X" [size]="18" />
          </button>
        </header>

        @if (etat() === 'demarrage') {
          <div class="sc-msg">
            <span class="sc-spin" aria-hidden="true"></span>
            Ouverture de la caméra…
          </div>
        }

        @if (etat() === 'indisponible') {
          <div class="sc-msg sc-msg--info">
            <lucide-icon [img]="Keyboard" [size]="22" />
            <p>{{ raison() }}</p>
            <p class="sc-sub">Saisissez l'IMEI ou le numéro SIM à la main, juste en dessous.</p>
          </div>
        }

        @if (etat() === 'scan') {
          <div class="sc-viseur">
            <video #video class="sc-video" playsinline muted autoplay></video>
            <div class="sc-cadre" aria-hidden="true">
              <span class="sc-coin sc-coin--hg"></span><span class="sc-coin sc-coin--hd"></span>
              <span class="sc-coin sc-coin--bg"></span><span class="sc-coin sc-coin--bd"></span>
              <span class="sc-laser"></span>
            </div>
          </div>
          <p class="sc-aide">Cadrez le code-barré de l'étiquette. La lecture est automatique.</p>
          @if (torcheDispo()) {
            <button type="button" class="sc-torche" (click)="basculerTorche()">
              <lucide-icon [img]="torcheOn() ? ZapOff : Zap" [size]="16" />
              {{ torcheOn() ? 'Éteindre la lampe' : 'Allumer la lampe' }}
            </button>
          }
        }

        @if (etat() === 'lu') {
          <div class="sc-msg sc-msg--ok">
            <span class="sc-check" aria-hidden="true">✓</span>
            <p class="sc-code">{{ dernierCode() }}</p>
          </div>
        }

        <button type="button" class="sc-manuel" (click)="fermer()">
          <lucide-icon [img]="Camera" [size]="15" />
          Saisir à la main
        </button>
      </div>
    </div>
  `,
  styles: [
    `
      .sc-ov {
        position: fixed;
        inset: 0;
        z-index: 9000;
        display: grid;
        place-items: center;
        padding: 16px;
        background: rgba(0, 0, 0, 0.62);
      }
      .sc-modal {
        width: 100%;
        max-width: 420px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-subtle);
        border-radius: 16px;
        overflow: hidden;
      }
      .sc-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--border-subtle);
      }
      .sc-title { font-size: 14px; font-weight: 600; color: var(--fg-primary); }
      .sc-x {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        border: 0;
        border-radius: 10px;
        background: transparent;
        color: var(--fg-secondary);
        cursor: pointer;
      }

      .sc-viseur { position: relative; aspect-ratio: 4 / 3; background: #000; }
      .sc-video { width: 100%; height: 100%; object-fit: cover; display: block; }

      .sc-cadre { position: absolute; inset: 12% 8%; pointer-events: none; }
      .sc-coin {
        position: absolute;
        width: 26px;
        height: 26px;
        border: 3px solid var(--tracky-light);
      }
      .sc-coin--hg { top: 0; left: 0; border-right: 0; border-bottom: 0; border-radius: 8px 0 0 0 }
      .sc-coin--hd { top: 0; right: 0; border-left: 0; border-bottom: 0; border-radius: 0 8px 0 0 }
      .sc-coin--bg { bottom: 0; left: 0; border-right: 0; border-top: 0; border-radius: 0 0 0 8px }
      .sc-coin--bd { bottom: 0; right: 0; border-left: 0; border-top: 0; border-radius: 0 0 8px 0 }

      /* Le balayage dit que ça CHERCHE. Une image figée laisse croire au gel. */
      .sc-laser {
        position: absolute;
        left: 6%;
        right: 6%;
        height: 2px;
        border-radius: 2px;
        background: linear-gradient(90deg, transparent, var(--tracky-light), transparent);
        animation: sc-balayage 2.1s ease-in-out infinite;
      }
      @keyframes sc-balayage {
        0%, 100% { top: 8%; opacity: .35 }
        50% { top: 90%; opacity: 1 }
      }

      .sc-aide { margin: 0; padding: 10px 14px 0; font-size: 12px; color: var(--fg-secondary); text-align: center }

      .sc-msg {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 28px 18px;
        text-align: center;
        color: var(--fg-secondary);
        font-size: 13px;
      }
      .sc-msg p { margin: 0 }
      .sc-sub { color: var(--fg-tertiary); font-size: 12px }
      .sc-msg--ok { color: var(--texte-succes) }
      .sc-code { font-family: ui-monospace, monospace; font-size: 15px; letter-spacing: .04em; color: var(--fg-primary) }
      .sc-check {
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--tracky-light) 18%, transparent);
        color: var(--tracky-light);
        font-size: 20px;
      }

      .sc-spin {
        width: 20px;
        height: 20px;
        border: 2px solid color-mix(in srgb, var(--tracky-light) 26%, transparent);
        border-top-color: var(--tracky-light);
        border-radius: 50%;
        animation: sc-tourne .8s linear infinite;
      }
      @keyframes sc-tourne { to { transform: rotate(360deg) } }

      .sc-torche, .sc-manuel {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        width: calc(100% - 28px);
        min-height: 44px;
        margin: 10px 14px 14px;
        border: 1px solid var(--border-strong);
        border-radius: 10px;
        background: transparent;
        color: var(--fg-secondary);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }
    `,
  ],
})
export class ScannerCodeComponent implements OnInit, OnDestroy {
  /** Candidats déduits du code lu — ordonnés, jamais tranchés ici. */
  readonly scanne = output<CandidatIdentifiant[]>();
  readonly ferme = output<void>();

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly destroyRef = inject(DestroyRef);

  protected readonly etat = signal<'demarrage' | 'scan' | 'lu' | 'indisponible'>('demarrage');
  protected readonly raison = signal('');
  protected readonly dernierCode = signal('');
  protected readonly torcheDispo = signal(false);
  protected readonly torcheOn = signal(false);

  protected readonly X = X;
  protected readonly Camera = Camera;
  protected readonly Keyboard = Keyboard;
  protected readonly Zap = Zap;
  protected readonly ZapOff = ZapOff;

  private flux: MediaStream | null = null;
  private detecteur: DetecteurCode | null = null;
  private boucle = 0;
  private arrete = false;

  async ngOnInit(): Promise<void> {
    const fabrique = (globalThis as unknown as { BarcodeDetector?: new (o: unknown) => DetecteurCode })
      .BarcodeDetector;
    if (!fabrique) {
      // ⚠️ On NOMME l'empêchement. « Scanner indisponible » sans raison laisse
      // l'utilisateur croire à une panne et retenter dix fois.
      this.raison.set("Ce navigateur ne sait pas lire les codes-barrés (c'est le cas de Safari sur iPhone).");
      this.etat.set('indisponible');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.raison.set("L'accès à la caméra n'est pas disponible ici.");
      this.etat.set('indisponible');
      return;
    }

    try {
      this.flux = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
    } catch (e) {
      const refus = (e as Error)?.name === 'NotAllowedError';
      this.raison.set(
        refus
          ? "L'accès à la caméra a été refusé. Autorisez-le dans les réglages du navigateur."
          : "La caméra n'a pas pu être ouverte.",
      );
      this.etat.set('indisponible');
      return;
    }

    this.detecteur = new fabrique({
      formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'itf', 'codabar', 'qr_code', 'data_matrix'],
    });
    this.etat.set('scan');
    // Le <video> n'existe qu'une fois l'état passé à 'scan' : on attend le rendu.
    queueMicrotask(() => void this.brancherEtLire());
    this.destroyRef.onDestroy(() => this.liberer());
  }

  ngOnDestroy(): void {
    this.liberer();
  }

  private async brancherEtLire(): Promise<void> {
    const el = this.video()?.nativeElement;
    if (!el || !this.flux) return;
    el.srcObject = this.flux;
    try {
      await el.play();
    } catch {
      /* autoplay refusé : la boucle tournera quand même dès que la vidéo démarre */
    }
    this.detecterTorche();
    this.lireEnBoucle(el);
  }

  private detecterTorche(): void {
    const piste = this.flux?.getVideoTracks()[0];
    const cap = piste?.getCapabilities?.() as { torch?: boolean } | undefined;
    this.torcheDispo.set(Boolean(cap?.torch));
  }

  protected async basculerTorche(): Promise<void> {
    const piste = this.flux?.getVideoTracks()[0];
    if (!piste) return;
    const suivant = !this.torcheOn();
    try {
      // `torch` n'est pas dans la definition standard de MediaTrackConstraints : c'est une
      // extension implementee par Chrome Android. On passe par `unknown` plutot que de
      // pretendre a une compatibilite de types qui n'existe pas.
      await piste.applyConstraints({ advanced: [{ torch: suivant }] } as unknown as MediaTrackConstraints);
      this.torcheOn.set(suivant);
    } catch {
      this.torcheDispo.set(false);
    }
  }

  /**
   * Boucle de lecture calée sur le rafraîchissement de l'écran.
   *
   * ⚠️ On ne lit pas à chaque image : `detect()` coûte cher et saturerait le fil
   * principal, ce qui figerait l'aperçu — l'utilisateur croirait à un plantage au moment
   * précis où il cadre. Un passage tous les ~200 ms suffit largement à attraper un
   * code-barré tenu à la main.
   */
  private lireEnBoucle(el: HTMLVideoElement): void {
    let dernier = 0;
    const passe = async (t: number) => {
      if (this.arrete) return;
      this.boucle = requestAnimationFrame(passe);
      if (t - dernier < 200 || el.readyState < 2) return;
      dernier = t;
      try {
        const trouves = await this.detecteur!.detect(el);
        const brut = trouves[0]?.rawValue?.trim();
        if (!brut) return;
        const candidats = candidatsDepuisScan(brut);
        if (candidats.length === 0) return; // bruit : on continue de chercher
        this.arrete = true;
        this.dernierCode.set(candidats[0].valeur);
        this.etat.set('lu');
        this.vibrer();
        this.scanne.emit(candidats);
        setTimeout(() => this.ferme.emit(), 550);
      } catch {
        /* image illisible : la passe suivante retentera */
      }
    };
    this.boucle = requestAnimationFrame(passe);
  }

  /** Retour physique : sur un quai, l'écran n'est pas toujours regardé au bon moment. */
  private vibrer(): void {
    try {
      navigator.vibrate?.(60);
    } catch {
      /* sans importance */
    }
  }

  protected fermer(): void {
    this.liberer();
    this.ferme.emit();
  }

  private liberer(): void {
    this.arrete = true;
    if (this.boucle) cancelAnimationFrame(this.boucle);
    this.boucle = 0;
    // La caméra DOIT être relâchée : une piste laissée ouverte garde le voyant allumé
    // et bloque l'appareil pour les autres applications.
    this.flux?.getTracks().forEach((p) => p.stop());
    this.flux = null;
  }
}
