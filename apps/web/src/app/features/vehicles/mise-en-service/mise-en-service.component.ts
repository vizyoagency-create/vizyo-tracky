import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, OnDestroy, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CheckCircle2, LucideAngularModule, MessageSquare, ScanLine, Search, ShieldAlert, TriangleAlert } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  MiseEnServiceApi,
  type EtatProvisioningDto,
  type EtatVerrouDto,
  type ResolutionIdentifiantDto,
} from '../../../core/services/mise-en-service.service';
import { AuthService } from '../../../core/services/auth.service';
import { ScannerCodeComponent } from '../../../shared/ui/scanner-code/scanner-code.component';

/** Fenêtre d'écoute avant de proposer la configuration par SMS. */
const ECOUTE_S = 60;
/** Le boîtier réémet toutes les ~30 s : sonder plus vite ne trouve rien de plus. */
const SONDAGE_MS = 3000;
/** Un battement bien plus court que l'expiration serveur (90 s) : trois essais de marge. */
const BATTEMENT_MS = 20_000;
/** Une salve de 6 a 8 SMS avec accuse : quelques minutes. On sonde sans presser. */
const SONDAGE_SMS_MS = 4000;

type Etape = 'saisie' | 'resolution' | 'resolu' | 'rattachement' | 'attente' | 'sms' | 'reussi' | 'echec';

@Component({
  selector: 'app-mise-en-service',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, ScannerCodeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (scannerOuvert()) {
      <app-scanner-code (scanne)="surScan($event)" (ferme)="scannerOuvert.set(false)" />
    }

    <section class="mes">
      <p class="mes-titre">Boîtier GPS</p>

      @if (verrou(); as v) {
        @if (!v.libre && !v.parMoi) {
          <div class="mes-verrou">
            <lucide-icon [img]="ShieldAlert" [size]="15" />
            <div>
              <strong>{{ v.detenteurNom }}</strong> met un boîtier en service
              @if (v.contexte) { (<strong>{{ v.contexte }}</strong>) }
              depuis {{ minutes(v.depuisSecondes) }}.
              <span class="mes-verrou-d">Attendez la fin pour éviter de confondre deux boîtiers.</span>
            </div>
            @if (estSuperAdmin()) {
              <button type="button" class="mes-liberer" (click)="libererDeForce()">Libérer</button>
            }
          </div>
        }
      }

      @switch (etape()) {
        @case ('saisie') {
          <p class="mes-aide">
            Scannez l'étiquette du boîtier. Le code-barré, l'IMEI ou le numéro SIM font
            tous l'affaire — on retrouve le reste.
          </p>
          <div class="mes-ligne">
            <input
              type="text"
              class="mes-input"
              [(ngModel)]="code"
              (keyup.enter)="resoudre()"
              placeholder="IMEI, ICCID ou n° SIM"
              inputmode="numeric"
              autocomplete="off"
            />
            <button type="button" class="mes-scan" (click)="scannerOuvert.set(true)" aria-label="Scanner">
              <lucide-icon [img]="ScanLine" [size]="18" />
            </button>
          </div>
          <button type="button" class="mes-cta" [disabled]="code.trim().length < 8" (click)="resoudre()">
            <lucide-icon [img]="Search" [size]="15" /> Identifier le boîtier
          </button>
          <button type="button" class="mes-sortie" (click)="passer.emit()">
            Le boîtier n'est pas encore posé — passer cette étape
          </button>
        }

        @case ('resolution') {
          <div class="mes-attente">
            <span class="mes-spin" aria-hidden="true"></span>
            <p>Recherche du boîtier…</p>
          </div>
        }

        @case ('resolu') {
          @if (resolution(); as r) {
            <div class="mes-carte" [class.mes-carte--ko]="r.voie === 'deja_rattache' || r.voie === 'inconnu'">
              @if (r.imei) {
                <div class="mes-l"><span>Boîtier</span><strong class="mes-mono">{{ r.imei }}</strong></div>
              }
              @if (r.msisdn) {
                <div class="mes-l"><span>Carte SIM</span><strong class="mes-mono">{{ r.msisdn }}</strong></div>
              }
              @if (r.simStatutLibelle) {
                <div class="mes-l"><span>Statut</span><strong>{{ r.simStatutLibelle }}</strong></div>
              }
              <p class="mes-verdict">{{ r.message }}</p>
            </div>

            @if (r.voie === 'rattacher_maintenant' || r.voie === 'attente_tcp') {
              <button type="button" class="mes-cta" (click)="rattacher()">
                Rattacher à {{ plaque() || 'ce véhicule' }}
              </button>
            } @else {
              <div class="mes-bloc">
                <lucide-icon [img]="TriangleAlert" [size]="15" />
                {{ conseil(r) }}
              </div>
            }
            <button type="button" class="mes-sortie" (click)="recommencer()">Scanner un autre boîtier</button>
          }
        }

        @case ('rattachement') {
          <div class="mes-attente">
            <span class="mes-spin" aria-hidden="true"></span>
            <p>Rattachement en cours…</p>
          </div>
        }

        @case ('attente') {
          <!-- ⚠️ LE COMPTEUR N'EST PAS DECORATIF. Sans lui, soixante secondes d'ecran
               fige se lisent comme un plantage, et l'installateur recharge la page au
               milieu de l'operation. L'anneau montre que ca avance ; le texte dit ce
               qu'on attend et ce qui se passera au bout. -->
          <div class="mes-compteur">
            <svg viewBox="0 0 120 120" class="mes-anneau" aria-hidden="true">
              <circle class="mes-anneau-fond" cx="60" cy="60" r="52" />
              <circle
                class="mes-anneau-jauge"
                cx="60" cy="60" r="52"
                [style.stroke-dashoffset]="offsetAnneau()"
              />
            </svg>
            <div class="mes-compteur-txt">
              <span class="mes-secondes">{{ restant() }}</span>
              <span class="mes-unite">s</span>
            </div>
          </div>
          <p class="mes-attente-t" role="status" aria-live="polite">{{ phraseAttente() }}</p>
          <p class="mes-attente-d">
            Le boîtier est déclaré. Il sera accepté dès qu'il ouvrira une session —
            vous pouvez fermer cette fenêtre, le rattachement se poursuit.
          </p>
          <button type="button" class="mes-sortie" (click)="passer.emit()">Fermer et continuer plus tard</button>
        }

        @case ('reussi') {
          <div class="mes-ok">
            <lucide-icon [img]="CheckCircle2" [size]="30" />
            <p class="mes-ok-t">Boîtier rattaché à {{ plaque() }}</p>
            @if (positions() > 0) {
              <p class="mes-ok-d">{{ positions() }} position{{ positions() > 1 ? 's' : '' }} déjà reçue{{ positions() > 1 ? 's' : '' }}.</p>
            } @else {
              <p class="mes-ok-d">En ligne. Les positions arriveront au premier trajet.</p>
            }
          </div>
          <button type="button" class="mes-cta" (click)="termine.emit()">Terminer</button>
        }

        @case ('sms') {
          <!-- ⚠️ SUITE NATURELLE DE L'ECHEC TCP, PAS UN ECRAN SEPARE. L'ancienne version
               s'arretait sur « lancez la configuration par SMS » sans dire ou : il fallait
               connaitre /admin/sms, y etre SUPER_ADMIN, et retaper six champs. -->
          <p class="mes-attente-t">Configuration par SMS</p>
          <p class="mes-attente-d">
            @if (provisioning(); as p) {
              {{ etapesFaites(p) }} / {{ p.steps.length }} commandes acquittées par le boîtier.
            } @else {
              Envoi de la première commande…
            }
          </p>
          <ol class="mes-etapes">
            @for (e of provisioning()?.steps ?? []; track e.step) {
              <li class="mes-etape" [attr.data-s]="e.status">
                <span class="mes-puce" aria-hidden="true"></span>
                <span class="mes-etape-l">{{ e.label }}</span>
                <span class="mes-etape-s">{{ libelleEtape(e.status) }}</span>
              </li>
            }
          </ol>
          @if (provisioning()?.failureReason; as raison) {
            <div class="mes-bloc mes-bloc--ko">
              <lucide-icon [img]="TriangleAlert" [size]="15" /> {{ raison }}
            </div>
          }
          <button type="button" class="mes-sortie" (click)="passer.emit()">
            Fermer — la configuration se poursuit
          </button>
        }

        @case ('echec') {
          <div class="mes-bloc mes-bloc--ko">
            <lucide-icon [img]="TriangleAlert" [size]="15" />
            {{ erreur() }}
          </div>
          <!-- La configuration SMS n'est proposee que si elle a un sens : il faut un
               boitier declare (donc un trackerId) et un numero pour le joindre. -->
          @if (peutProvisionner()) {
            <button type="button" class="mes-cta" (click)="lancerSms()">
              <lucide-icon [img]="MessageSquare" [size]="15" />
              Lancer la configuration par SMS
            </button>
            <p class="mes-aide">
              Six à huit commandes seront envoyées au boîtier, chacune attendant son
              accusé de réception. Comptez deux à trois minutes.
            </p>
          }
          <button type="button" class="mes-sortie" (click)="recommencer()">Reprendre</button>
        }
      }
    </section>
  `,
  styles: [
    `
      .mes { display: flex; flex-direction: column; gap: 10px }
      .mes-titre { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-tertiary) }
      .mes-aide { margin: 0; font-size: 12px; color: var(--fg-secondary) }

      .mes-ligne { display: flex; gap: 8px }
      .mes-input {
        flex: 1; min-height: 44px; padding: 0 12px;
        border: 1px solid var(--border-strong); border-radius: 10px;
        background: var(--bg-tertiary); color: var(--fg-primary);
        font-family: ui-monospace, monospace; letter-spacing: .05em; font-size: 14px;
      }
      .mes-scan {
        display: inline-flex; align-items: center; justify-content: center;
        width: 44px; min-height: 44px; flex: 0 0 44px;
        border: 1px solid var(--border-strong); border-radius: 10px;
        background: transparent; color: var(--tracky-light); cursor: pointer;
      }

      .mes-cta {
        display: inline-flex; align-items: center; justify-content: center; gap: 7px;
        min-height: 44px; padding: 0 16px; border: 0; border-radius: 10px;
        background: var(--tracky); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
      }
      .mes-cta:disabled { opacity: .45; cursor: not-allowed }
      .mes-sortie {
        min-height: 44px; border: 0; background: transparent;
        color: var(--fg-secondary); font-size: 12px; text-decoration: underline; cursor: pointer;
      }

      .mes-carte {
        display: flex; flex-direction: column; gap: 5px;
        padding: 11px 13px; border-radius: 11px;
        border: 1px solid color-mix(in srgb, var(--tracky-light) 26%, transparent);
        background: color-mix(in srgb, var(--tracky-light) 7%, transparent);
      }
      .mes-carte--ko {
        border-color: color-mix(in srgb, #ef4444 32%, transparent);
        background: rgba(239, 68, 68, .07);
      }
      .mes-l { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; color: var(--fg-secondary) }
      .mes-l strong { color: var(--fg-primary) }
      .mes-mono { font-family: ui-monospace, monospace; letter-spacing: .04em }
      .mes-verdict { margin: 4px 0 0; font-size: 12px; color: var(--fg-secondary) }

      .mes-bloc {
        display: flex; align-items: flex-start; gap: 8px;
        padding: 10px 12px; border-radius: 10px; font-size: 12px;
        background: color-mix(in srgb, var(--warning) 12%, transparent);
        color: var(--fg-secondary);
      }
      .mes-bloc--ko { background: rgba(239, 68, 68, .1) }

      .mes-verrou {
        display: flex; align-items: flex-start; gap: 8px;
        padding: 10px 12px; border-radius: 10px; font-size: 12px;
        background: color-mix(in srgb, var(--warning) 13%, transparent);
        color: var(--fg-secondary);
      }
      .mes-verrou-d { display: block; color: var(--fg-tertiary) }
      .mes-liberer {
        margin-left: auto; min-height: 44px; padding: 0 12px; white-space: nowrap;
        border: 1px solid var(--border-strong); border-radius: 9px;
        background: transparent; color: var(--fg-secondary); font-size: 12px; font-weight: 600; cursor: pointer;
      }

      .mes-attente { display: flex; align-items: center; gap: 10px; padding: 18px 4px; color: var(--fg-secondary); font-size: 13px }
      .mes-attente p { margin: 0 }
      .mes-spin {
        width: 18px; height: 18px; flex: 0 0 18px;
        border: 2px solid color-mix(in srgb, var(--tracky-light) 26%, transparent);
        border-top-color: var(--tracky-light); border-radius: 50%;
        animation: mes-tourne .8s linear infinite;
      }
      @keyframes mes-tourne { to { transform: rotate(360deg) } }

      .mes-compteur { position: relative; width: 120px; height: 120px; margin: 6px auto 0 }
      .mes-anneau { width: 120px; height: 120px; transform: rotate(-90deg) }
      .mes-anneau-fond, .mes-anneau-jauge { fill: none; stroke-width: 7; stroke-linecap: round }
      .mes-anneau-fond { stroke: color-mix(in srgb, var(--fg-tertiary) 22%, transparent) }
      .mes-anneau-jauge {
        stroke: var(--tracky-light);
        stroke-dasharray: 326.7;
        transition: stroke-dashoffset 1s linear;
      }
      .mes-compteur-txt {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 2px;
      }
      .mes-secondes { font-size: 30px; font-weight: 700; color: var(--fg-primary); font-variant-numeric: tabular-nums }
      .mes-unite { font-size: 13px; color: var(--fg-tertiary); align-self: flex-end; padding-bottom: 7px }
      .mes-attente-t { margin: 8px 0 0; text-align: center; font-size: 13px; font-weight: 600; color: var(--fg-primary) }
      .mes-attente-d { margin: 0; text-align: center; font-size: 12px; color: var(--fg-secondary) }

      .mes-ok { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 16px 4px; color: var(--texte-succes) }
      .mes-ok-t { margin: 0; font-size: 14px; font-weight: 600; color: var(--fg-primary) }
      .mes-ok-d { margin: 0; font-size: 12px; color: var(--fg-secondary) }

      .mes-etapes { display: flex; flex-direction: column; gap: 2px; margin: 6px 0 0; padding: 0; list-style: none }
      .mes-etape { display: flex; align-items: center; gap: 8px; padding: 7px 2px; font-size: 12px; color: var(--fg-secondary) }
      .mes-puce { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: var(--fg-tertiary) }
      .mes-etape-l { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
      .mes-etape-s { font-size: 11px; color: var(--fg-tertiary) }
      /* L'etat se lit a la couleur ET au mot : la couleur seule exclut les daltoniens. */
      .mes-etape[data-s='sent'] .mes-puce { background: var(--warning); animation: mes-pulse 1.1s ease-in-out infinite }
      .mes-etape[data-s='acked'] .mes-puce { background: var(--tracky-light) }
      .mes-etape[data-s='acked'] .mes-etape-s { color: var(--texte-succes) }
      .mes-etape[data-s='no-ack'] .mes-puce,
      .mes-etape[data-s='failed'] .mes-puce { background: var(--danger) }
      .mes-etape[data-s='no-ack'] .mes-etape-s,
      .mes-etape[data-s='failed'] .mes-etape-s { color: var(--danger) }
      @keyframes mes-pulse { 50% { opacity: .35 } }
    `,
  ],
})
export class MiseEnServiceComponent implements OnDestroy {
  readonly vehicleId = input.required<string>();
  readonly plaque = input<string>('');
  /** Le boîtier est rattaché et vu en ligne. */
  readonly termine = output<void>();
  /** L'installateur remet la pose à plus tard : le véhicule existe déjà, c'est valide. */
  readonly passer = output<void>();

  private readonly api = inject(MiseEnServiceApi);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  protected code = '';
  protected readonly etape = signal<Etape>('saisie');
  protected readonly resolution = signal<ResolutionIdentifiantDto | null>(null);
  protected readonly verrou = signal<EtatVerrouDto | null>(null);
  protected readonly erreur = signal('');
  protected readonly restant = signal(ECOUTE_S);
  protected readonly positions = signal(0);
  protected readonly scannerOuvert = signal(false);
  protected readonly provisioning = signal<EtatProvisioningDto | null>(null);

  protected readonly ScanLine = ScanLine;
  protected readonly Search = Search;
  protected readonly CheckCircle2 = CheckCircle2;
  protected readonly TriangleAlert = TriangleAlert;
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly MessageSquare = MessageSquare;

  private trackerId = '';
  private tickCompteur = 0;
  private tickSondage = 0;
  private tickBattement = 0;
  private tickSms = 0;

  constructor() {
    this.destroyRef.onDestroy(() => this.tousArretes());
  }

  ngOnDestroy(): void {
    this.tousArretes();
  }

  protected estSuperAdmin(): boolean {
    return this.auth.user()?.role === 'SUPER_ADMIN';
  }

  /** « depuis 2 min » se lit mieux que « depuis 137 s ». */
  protected minutes(s: number | null): string {
    if (s === null) return '';
    return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
  }

  protected offsetAnneau(): number {
    const circonference = 2 * Math.PI * 52;
    return circonference * (1 - this.restant() / ECOUTE_S);
  }

  /**
   * La phrase change au fil de l'attente.
   *
   * Un texte figé pendant soixante secondes cesse d'être lu, et ne dit plus si le
   * système avance. Ces trois paliers correspondent à ce qui se passe réellement : le
   * boîtier réémet toutes les ~30 s, donc on a vraiment franchi un cap à 40 s puis à 20 s.
   */
  protected phraseAttente(): string {
    const r = this.restant();
    if (r > 40) return 'On écoute le boîtier…';
    if (r > 20) return 'Toujours à l’écoute — un boîtier réémet toutes les 30 secondes.';
    return 'Dernières secondes avant de proposer la configuration par SMS.';
  }

  protected conseil(r: ResolutionIdentifiantDto): string {
    switch (r.voie) {
      case 'sim_a_activer':
        return "Activez la puce depuis l'écran Cartes SIM, puis revenez ici.";
      case 'provisioning_sms':
        return 'Le boîtier doit être configuré par SMS. Vérifiez qu’il est alimenté, puis relancez une identification.';
      case 'deja_rattache':
        return 'Détachez-le de son véhicule actuel avant de le réaffecter.';
      default:
        return 'Vérifiez le code, ou saisissez l’IMEI à la main.';
    }
  }

  protected surScan(candidats: { valeur: string }[]): void {
    if (candidats.length === 0) return;
    this.code = candidats[0]!.valeur;
    void this.resoudre();
  }

  protected async resoudre(): Promise<void> {
    const c = this.code.trim();
    if (c.length < 8) return;
    this.etape.set('resolution');
    try {
      this.resolution.set(await firstValueFrom(this.api.resoudre(c)));
      this.etape.set('resolu');
    } catch (e) {
      this.erreur.set(this.messageErreur(e, "Le boîtier n'a pas pu être identifié."));
      this.etape.set('echec');
    }
  }

  protected async rattacher(): Promise<void> {
    const r = this.resolution();
    if (!r?.imei) return;
    this.etape.set('rattachement');
    try {
      const fait = await firstValueFrom(
        this.api.rattacher({ vehicleId: this.vehicleId(), imei: r.imei, msisdn: r.msisdn }),
      );
      this.trackerId = fait.trackerId;
      await this.verifierUneFois();
      if (this.etape() !== 'reussi') this.demarrerEcoute();
    } catch (e) {
      this.erreur.set(this.messageErreur(e, 'Le rattachement a échoué.'));
      this.etape.set('echec');
    }
  }

  private demarrerEcoute(): void {
    this.etape.set('attente');
    this.restant.set(ECOUTE_S);
    void this.battre();
    this.tickBattement = window.setInterval(() => void this.battre(), BATTEMENT_MS);
    this.tickCompteur = window.setInterval(() => {
      const r = this.restant() - 1;
      this.restant.set(Math.max(0, r));
      if (r <= 0) this.finEcoute();
    }, 1000);
    this.tickSondage = window.setInterval(() => void this.verifierUneFois(), SONDAGE_MS);
  }

  private async verifierUneFois(): Promise<void> {
    if (!this.trackerId) return;
    try {
      const e = await firstValueFrom(this.api.attente(this.trackerId));
      if (e.connecte) {
        this.positions.set(e.positions);
        this.tousArretes();
        this.etape.set('reussi');
        return;
      }
      /**
       * ⚠️ Le boîtier frappe encore en INCONNU alors qu'il vient d'être déclaré : l'IMEI
       * saisi n'est pas le sien. Attendre plus longtemps ne servirait à rien, et l'écran
       * mentirait en affichant « on écoute ».
       */
      if (e.encoreInconnu) {
        this.tousArretes();
        this.erreur.set(
          "Un boîtier se présente avec un AUTRE identifiant que celui déclaré. L'IMEI saisi ne correspond pas — vérifiez l'étiquette.",
        );
        this.etape.set('echec');
      }
    } catch {
      /* un sondage raté n'est pas un échec : le suivant retentera */
    }
  }

  private finEcoute(): void {
    this.tousArretes();
    this.erreur.set(
      "Le boîtier ne s'est pas connecté en 60 secondes. Il est déclaré : il sera rattaché tout seul dès qu'il parlera. Vérifiez qu'il est alimenté, ou lancez la configuration par SMS.",
    );
    this.etape.set('echec');
  }

  /** Maintient le verrou tant que l'écran vit, et détecte une éviction. */
  private async battre(): Promise<void> {
    try {
      this.verrou.set(await firstValueFrom(this.api.prendreVerrou(this.plaque() || null)));
    } catch {
      /* sans importance : le verrou n'est qu'une coordination */
    }
  }

  protected async libererDeForce(): Promise<void> {
    try {
      this.verrou.set(await firstValueFrom(this.api.forcerVerrou()));
    } catch {
      /* le bouton n'apparaît qu'au super-admin ; un échec reste sans conséquence */
    }
  }

  /**
   * La configuration SMS n'a de sens que si le boîtier est DÉCLARÉ et qu'on sait le
   * joindre. Proposer le bouton sans l'un des deux offrirait une action qui échouerait
   * — pire qu'une action absente, parce qu'elle fait espérer.
   */
  protected peutProvisionner(): boolean {
    return this.trackerId !== '' && !!this.resolution()?.msisdn;
  }

  protected etapesFaites(p: EtatProvisioningDto): number {
    return p.steps.filter((e) => e.status === 'acked' || e.status === 'noop').length;
  }

  /** Le mot compte autant que la couleur : un daltonien ne lit que le mot. */
  protected libelleEtape(statut: string): string {
    switch (statut) {
      case 'acked': return 'confirmé';
      case 'sent': return 'envoyé…';
      case 'no-ack': return 'sans réponse';
      case 'failed': return 'échec';
      case 'noop': return 'ignoré';
      default: return 'en attente';
    }
  }

  protected async lancerSms(): Promise<void> {
    const r = this.resolution();
    if (!r?.imei) return;
    this.etape.set('sms');
    this.provisioning.set(null);
    try {
      const lance = await firstValueFrom(this.api.provisionner(r.imei));
      this.tickSms = window.setInterval(() => void this.sonderSms(lance.provisioningId), SONDAGE_SMS_MS);
      void this.sonderSms(lance.provisioningId);
    } catch (e) {
      this.erreur.set(this.messageErreur(e, "La configuration par SMS n'a pas pu démarrer."));
      this.etape.set('echec');
    }
  }

  private async sonderSms(id: string): Promise<void> {
    try {
      const etat = await firstValueFrom(this.api.etatProvisionnement(id));
      this.provisioning.set(etat);
      if (etat.status === 'COMPLETED') {
        // Le boîtier vient d'être configuré : il va se connecter. On repart écouter,
        // plutôt que d'annoncer un succès que rien n'a encore prouvé.
        if (this.tickSms) window.clearInterval(this.tickSms);
        this.tickSms = 0;
        this.demarrerEcoute();
      } else if (etat.status === 'FAILED') {
        if (this.tickSms) window.clearInterval(this.tickSms);
        this.tickSms = 0;
      }
    } catch {
      /* un sondage raté n'est pas un échec : le suivant retentera */
    }
  }

  protected recommencer(): void {
    this.tousArretes();
    this.code = '';
    this.resolution.set(null);
    this.provisioning.set(null);
    this.erreur.set('');
    this.etape.set('saisie');
  }

  private tousArretes(): void {
    for (const t of [this.tickCompteur, this.tickSondage, this.tickBattement, this.tickSms]) {
      if (t) window.clearInterval(t);
    }
    this.tickCompteur = this.tickSondage = this.tickBattement = this.tickSms = 0;
    // On rend le verrou : le garder après coup bloquerait le poste suivant 90 s pour rien.
    if (this.verrou()?.parMoi) void firstValueFrom(this.api.rendreVerrou()).catch(() => undefined);
  }

  private messageErreur(e: unknown, defaut: string): string {
    const m = (e as { error?: { error?: { message?: string }; message?: string } })?.error;
    return m?.error?.message ?? m?.message ?? defaut;
  }
}
