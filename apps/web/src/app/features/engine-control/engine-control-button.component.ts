import { swallow } from '../../core/error/swallow';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, DestroyRef, effect, inject, input, OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Power, PowerOff } from 'lucide-angular';
import {
  DORMANT_STOP_ACTING_MS,
  formatSilenceLabel,
  trackerSilenceMs,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import {
  EngineControlService,
  type EngineControlCommandDto,
} from '../../core/services/engine-control.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { VehicleSchedulesApiService } from '../../core/services/vehicle-schedules.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { ToastService } from '../../shared/ui/toast/toast.service';

/** Sprint 2 — fenêtre d'attente de confirmation côté UI (aligne le défaut backend 90s). */
const CONFIRM_WINDOW_MS = 90_000;

@Component({
  selector: 'app-engine-control-button',
  standalone: true,
  imports: [LucideAngularModule, ConfirmModalComponent, FormsModule],
  template: `
    <div class="inline-flex items-center shrink-0" (click)="$event.stopPropagation()">
      @if (canCut().allowed || canRestore()) {
        @if (isCutActive()) {
          <button
            (click)="openAction('restore')"
            [attr.data-track]="trackLabel() ? trackLabel() + ' — rallumer' : null"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                   bg-tracky/20 text-tracky-light border border-tracky/30
                   hover:bg-tracky/30 transition-all cursor-pointer whitespace-nowrap"
          >
            <lucide-icon [img]="Power" [size]="14"></lucide-icon>
            <span class="hidden sm:inline">Rallumer le moteur</span>
            <span class="sm:hidden">Rallumer</span>
          </button>
        } @else {
          <button
            (click)="canCut().allowed ? openAction('cut') : null"
            [disabled]="!canCut().allowed"
            [title]="canCut().reason ?? ''"
            [attr.data-track]="trackLabel() ? trackLabel() + ' — couper' : null"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                   transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
            [class]="canCut().allowed
              ? 'bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/30'
              : 'bg-bg-tertiary text-fg-tertiary border border-border-subtle'"
          >
            <lucide-icon [img]="PowerOff" [size]="14"></lucide-icon>
            <span class="hidden sm:inline">Couper le moteur</span>
            <span class="sm:hidden">Couper</span>
          </button>
        }

        <!-- Boîtier muet : affiché pour la coupe COMME pour le rallumage. Sur les deux
             l'opérateur doit savoir que rien ne reviendra confirmer son geste. Une
             infobulle ne suffit pas : elle n'existe pas au doigt, et le mobile est
             l'usage principal (cas réel FV-941-LZ, 89 j de silence). -->
        @if (dormantWarning(); as d) {
          <span class="ml-2 text-[11px] font-medium text-amber-400 leading-tight"
                [title]="d.title">
            Boîtier muet depuis {{ d.silence }} — envoi non garanti
          </span>
        }
      }

      <!-- Sprint 2 — etat honnete de la derniere commande (jamais de faux succes). -->
      @if (commandState(); as st) {
        <span class="ml-2 inline-flex items-center gap-1 text-[11px] font-medium {{ st.textClass }} whitespace-nowrap"
              [title]="st.label">
          <span class="w-1.5 h-1.5 rounded-full shrink-0 {{ st.dotClass }}"></span>
          {{ st.short }}
        </span>
      }

      <!--
        NIVEAU CRITIQUE, ET SEULEMENT SUR LA COUPURE (decision du 2026-08-11).
        Couper IMMOBILISE un bien, parfois avec quelqu'un dedans, et se trompe de vehicule
        en un clic depuis une liste. Rallumer ne fait que deblocker : c'est reversible, et
        ca reste une confirmation standard. C'est la meme asymetrie que le mode veilleur,
        qui peut rallumer mais pas couper.
        La plaque a retaper n'est pas une formalite : elle force a LIRE quelle ligne on a
        ouverte. Le kit compare sans casse ni espaces — on verifie qu'on a lu, pas qu'on
        sait taper.
      -->
      <app-confirm-modal
        [open]="isOpen() === 'cut'"
        title="Couper le moteur ?"
        [description]="cutDescription()"
        [consequences]="cutConsequences()"
        confirmLabel="Couper le moteur"
        cancelLabel="Annuler"
        [danger]="true"
        [critique]="true"
        [etat]="etatVehicule()"
        [confirmationAttendue]="vehiclePlate()"
        [loading]="loading()"
        (confirmed)="onConfirm('CUT')"
        (cancelled)="isOpen.set(null)"
      >
        <textarea
          [ngModel]="reason()"
          (ngModelChange)="reason.set($event)"
          placeholder="Raison (ex: véhicule volé, non-paiement...)"
          maxlength="500"
          rows="2"
          class="w-full mt-3 px-3 py-2 text-sm rounded-lg bg-bg-tertiary border border-border-subtle
                 text-fg-primary placeholder:text-fg-tertiary resize-none
                 focus:outline-none focus:border-tracky"
        ></textarea>
        @if (scheduleEnabled()) {
          <label class="flex items-start gap-2 mt-3 text-xs text-fg-secondary cursor-pointer">
            <input
              type="checkbox"
              [ngModel]="durableImmobilize()"
              (ngModelChange)="durableImmobilize.set($event)"
              class="mt-0.5 accent-red-500 shrink-0"
            />
            <span>
              <strong>Immobilisation durable</strong> — sort du planning horaire : le véhicule
              reste coupé jusqu'à un rallumage manuel (vol, non-paiement…). Sinon, le mode horaire
              reste actif et reprend à la prochaine bascule.
            </span>
          </label>
        }
      </app-confirm-modal>

      <app-confirm-modal
        [open]="isOpen() === 'restore'"
        title="Rallumer le moteur ?"
        [description]="restoreDescription()"
        confirmLabel="Oui, rallumer"
        cancelLabel="Annuler"
        [danger]="false"
        [loading]="loading()"
        (confirmed)="onConfirm('RESTORE')"
        (cancelled)="isOpen.set(null)"
      />
    </div>
  `,
})
export class EngineControlButtonComponent implements OnInit {
  readonly trackerId = input.required<string>();
  readonly vehicleId = input<string | undefined>(undefined);
  readonly vehiclePlate = input.required<string>();
  readonly currentSpeedKmh = input<number | undefined>(undefined);
  readonly validFix = input(false);
  readonly positionAge = input<number | undefined>(undefined);
  readonly ignition = input(true);
  /**
   * Dernier signal reçu du BOÎTIER (pas de la position) — source unique de la dormance.
   *
   * Optionnel : laissé à `undefined`, le composant retombe sur l'entrée snapshot du
   * RealtimeService pour ce tracker (hydratée au login, rafraîchie par les trames WS).
   * On distingue volontairement `undefined` (fait INCONNU → on ne bloque rien, le serveur
   * reste seul juge) de `null` (boîtier connu qui n'a JAMAIS émis → pas « devenu muet »).
   */
  readonly trackerLastSeenAt = input<string | Date | null | undefined>(undefined);
  /** Si true, un schedule horaire est actif sur ce véhicule (input ou chargé dynamiquement). */
  readonly scheduleEnabledInput = input(false, { alias: 'scheduleEnabled' });
  /** Libellé de traçage d'activité posé sur les boutons d'action (data-track). Vide = fallback texte. */
  readonly trackLabel = input<string>('');
  /** Emis quand une action manuelle désactive le schedule horaire. */
  readonly scheduleDisabled = output<void>();

  protected readonly isOpen = signal<'cut' | 'restore' | null>(null);
  protected readonly loading = signal(false);
  protected readonly reason = signal('');
  /** Case optionnelle « immobilisation durable » (CUT + mode horaire actif) : sort du planning. */
  protected readonly durableImmobilize = signal(false);
  protected readonly recentCommands = signal<EngineControlCommandDto[]>([]);
  private readonly _scheduleEnabled = signal(false);
  protected readonly scheduleEnabled = computed(() => this.scheduleEnabledInput() || this._scheduleEnabled());

  protected readonly Power = Power;
  protected readonly PowerOff = PowerOff;

  private readonly authService = inject(AuthService);
  private readonly engineControl = inject(EngineControlService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);
  private readonly realtime = inject(RealtimeService);
  private readonly schedulesApi = inject(VehicleSchedulesApiService);

  /**
   * V1.11 Phase 1 — VehicleId effectif : prend l'input si fourni, sinon resout
   * via le snapshot realtime (compat avec usages historiques). Nécessaire pour
   * la vérification de permission per-vehicle (engine_control).
   */
  protected readonly effectiveVehicleId = computed<string | undefined>(() => {
    const direct = this.vehicleId();
    if (direct) return direct;
    return this.realtime.snapshot().find((v) => v.trackerId === this.trackerId())?.vehicleId;
  });

  readonly isCutActive = computed(() => {
    const cmds = this.recentCommands();
    // Sprint 3 — VEILLEUR (NIGHT_WATCHMAN) : `GET /engine-control/commands` = 403 → la liste
    // `recentCommands` reste TOUJOURS vide pour lui. L'état coupé vient alors du suivi temps
    // réel de RealtimeService (`cutActiveTrackerIds`, hydraté au login + MAJ par les events
    // `ENGINE_COMMAND_UPDATED` reçus via `ops:fleet`), même sémantique (CUT ACKNOWLEDGED =
    // coupé, RESTORE = rallumé). Sans ce repli le bouton restait bloqué sur « Couper » → le
    // veilleur ne pouvait JAMAIS rallumer (il recoupait à chaque clic).
    if (cmds.length === 0) {
      // Coupé CONFIRMÉ (cutActiveTrackerIds) OU coupé EN ATTENTE de confirmation
      // (cutPendingTrackerIds) → on propose « Rétablir » dans les deux cas. Sinon le
      // veilleur — privé du détail des commandes (commandState) — reste sur « Couper »
      // tant que la coupe n'est pas confirmée et reclique en boucle (observé en prod :
      // 3 CUT d'affilée, véhicule bloqué « en attente »). Un RESTORE ou un FAILED nettoie
      // les DEUX ensembles côté RealtimeService → le bouton revient à « Couper ».
      const tid = this.trackerId();
      return this.realtime.cutActiveTrackerIds().has(tid) || this.realtime.cutPendingTrackerIds().has(tid);
    }
    // Sprint 2 (Obj 3) — etat "coupe" = derniere commande CONFIRMEE (ACKNOWLEDGED),
    // TOUTES sources incluses (DEVICE_OBSERVED = coupure SMS/externe detectee par la
    // chute d'ignition). Une coupure seulement SENT (pas encore confirmee) NE compte
    // PAS : l'etat ne bascule qu'a la preuve reelle — jamais de faux succes.
    const lastCut = cmds.find((c) => c.action === 'CUT' && c.status === 'ACKNOWLEDGED');
    // Revue #1 — un RESTORE nettoie l'etat des l'ENVOI (SENT||ACK) : rallumer est
    // toujours sur, on ne requiert PAS de preuve device pour CESSER d'afficher
    // "coupe". Sinon le bouton resterait colle sur « Rallumer » (un RESTORE app
    // n'atteint jamais ACKNOWLEDGED : seul un CUT est confirme par la chute d'ignition).
    const lastRestore = cmds.find(
      (c) => c.action === 'RESTORE' && (c.status === 'SENT' || c.status === 'ACKNOWLEDGED'),
    );
    if (!lastCut) return false;
    if (!lastRestore) return true;
    return new Date(lastCut.createdAt) > new Date(lastRestore.createdAt);
  });

  // Sprint 2 — tick 5s : fait basculer l'affichage "en attente" -> "non confirmee"
  // au depassement de la fenetre, sans refetch.
  private readonly _now = signal(Date.now());
  constructor() {
    const id = setInterval(() => this._now.set(Date.now()), 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  /** Sprint 2 — derniere commande APP (hors DEVICE_OBSERVED) = l'action en cours. */
  private readonly lastAppCommand = computed<EngineControlCommandDto | null>(() => {
    const fromList = this.recentCommands().find((c) => c.source !== 'DEVICE_OBSERVED');
    if (fromList) return fromList;
    // Sprint 3 — veilleur : recentCommands est vide (GET /commands = 403). On reconstruit la
    // dernière commande app depuis l'event WS ENGINE_COMMAND_UPDATED (reçu via ops:fleet) pour
    // que commandState (pastille « confirmée / non vérifiable / échec ») s'affiche aussi pour
    // lui — sinon le veilleur n'a AUCUN retour d'état après la coupe (cf. revue B5).
    const ev = this.realtime.engineCommandUpdates().get(this.trackerId());
    if (!ev || ev.source === 'DEVICE_OBSERVED') return null;
    return {
      id: ev.commandId,
      trackerId: ev.trackerId,
      action: ev.action,
      status: ev.status,
      reason: null,
      source: ev.source ?? 'MANUAL',
      lastError: ev.lastError,
      requestedBy: '',
      createdAt: ev.sentAt ?? ev.ackedAt ?? '',
      sentAt: ev.sentAt ?? null,
      confirmationExpected: ev.confirmationExpected ?? false,
      ackedAt: ev.ackedAt ?? null,
    };
  });

  /**
   * Sprint 2 — etat honnete de la derniere commande app : en attente / confirmee /
   * non confirmee / non verifiable / echec. Garantit qu'on n'affiche JAMAIS un faux
   * succes (l'etat "coupe" du bouton ne passe qu'a la confirmation reelle).
   */
  readonly commandState = computed<{ short: string; label: string; textClass: string; dotClass: string } | null>(() => {
    const c = this.lastAppCommand();
    if (!c || c.status === 'PENDING' || c.status === 'REJECTED_SPEED') return null;
    const verb = c.action === 'CUT' ? 'Coupure' : 'Rallumage';
    if (c.status === 'ACKNOWLEDGED') {
      return {
        short: c.action === 'CUT' ? 'Coupure confirmée' : 'Rallumage confirmé',
        label: `${verb} confirmé(e) par le boîtier (chute d'ignition).`,
        textClass: 'text-tracky-light',
        dotClass: 'bg-tracky-light',
      };
    }
    if (c.status === 'FAILED') {
      return {
        short: 'Échec d\'envoi',
        label: c.lastError ?? 'La commande n\'a pas pu être envoyée au boîtier.',
        textClass: 'text-red-400',
        dotClass: 'bg-red-500',
      };
    }
    // status === 'SENT'
    if (c.confirmationExpected === false) {
      return {
        short: 'Envoyée',
        label: `${verb} envoyée — confirmation par ignition indisponible (véhicule à l'arrêt). À vérifier physiquement.`,
        textClass: 'text-fg-tertiary',
        dotClass: 'bg-fg-tertiary',
      };
    }
    const ageMs = this._now() - new Date(c.sentAt ?? c.createdAt).getTime();
    if (ageMs < CONFIRM_WINDOW_MS) {
      return {
        short: 'En attente…',
        label: `${verb} envoyée — en attente de confirmation du boîtier…`,
        textClass: 'text-amber-400',
        dotClass: 'bg-amber-400 animate-pulse',
      };
    }
    return {
      short: 'Non confirmée',
      label: `${verb} envoyée mais NON confirmée par le boîtier — à vérifier.`,
      textClass: 'text-red-400',
      dotClass: 'bg-red-500',
    };
  });

  /**
   * Dernier signal du boîtier, résolu : input explicite d'abord, snapshot realtime ensuite.
   *
   * Retourne `undefined` quand le fait est INCONNU (aucun input, aucune entrée snapshot —
   * c'est le cas du VEILLEUR, à qui le serveur ne sert aucune donnée véhicule). On ne
   * grise JAMAIS sur une ignorance : sans fait, aucune garde.
   */
  private readonly resolvedLastSeenAt = computed<string | Date | null | undefined>(() => {
    const direct = this.trackerLastSeenAt();
    if (direct !== undefined) return direct;
    const snap = this.realtime.snapshot().find((v) => v.trackerId === this.trackerId());
    return snap ? snap.lastSeenAt : undefined;
  });

  /**
   * BOÎTIER MUET (seuil AGIR = 72 h) — non null quand le boîtier ne parle plus du tout.
   *
   * Cas réel : FV-941-LZ, muet depuis 89 jours. L'opérateur cliquait « Couper », lisait
   * « Coupure envoyée » et croyait le véhicule immobilisé. Ce n'est PAS le clic qu'il faut
   * empêcher (le serveur tente encore le repli SMS, cf. canCut) — c'est la CROYANCE au
   * succès. On date donc le silence partout où l'action se décide : sur le bouton, dans la
   * confirmation, dans le toast.
   *
   * DORMANT_STOP_ACTING_MS (72 h) et PAS le seuil de comptage (7 j) : c'est le seuil
   * d'ACTION, celui que le serveur applique à ses automatismes. Un véhicule simplement
   * garé une semaine ne doit jamais être signalé ici.
   *
   * Dépend de `_now()` (tick 5 s) : dès la première trame reçue, `lastSeenAt` redevient
   * frais et l'avertissement disparaît seul — aucun drapeau, aucune action manuelle.
   */
  protected readonly dormantWarning = computed<{ silence: string; title: string } | null>(() => {
    const lastSeen = this.resolvedLastSeenAt();
    // undefined = fait inconnu ; null = jamais émis (« pas configuré », pas « devenu muet »).
    if (lastSeen === undefined || lastSeen === null) return null;
    const now = this._now();
    const silent = trackerSilenceMs(lastSeen, now);
    if (silent == null || silent <= DORMANT_STOP_ACTING_MS) return null;
    const silence = formatSilenceLabel(lastSeen, now) ?? '—';
    return {
      silence,
      title:
        `Le boîtier n'a plus émis depuis ${silence} (batterie débranchée, SIM coupée ou boîtier déposé). ` +
        `La commande sera tout de même tentée, par SMS : ne considérez l'action faite qu'une fois ` +
        `confirmée par le boîtier, ou vérifiée physiquement.`,
    };
  });

  readonly canCut = computed(() => {
    // ⚠️ AUCUNE porte « boîtier muet » ici, et c'est VÉRIFIÉ, pas supposé : côté serveur
    // (EngineControlService) la dormance ne suspend QUE la coupe automatique du planning
    // (`source === 'SCHEDULER'`). Une coupe MANUELLE part toujours, TCP puis repli SMS —
    // un boîtier peut avoir perdu sa data tout en recevant encore ses SMS, et c'est
    // exactement sur un véhicule volé qu'on veut tenter sa chance. Griser ce bouton
    // supprimerait le dernier levier disponible sur le seul cas qui compte vraiment.
    // On ne cache donc pas le fait : il est AFFICHÉ (cf. dormantWarning) dans le bouton,
    // dans la confirmation et dans le toast, pour que personne ne croie à un succès.

    // V1.11 Phase 1 — Permission per-vehicle. Admin bypass deja gere par perms.can.
    const vid = this.effectiveVehicleId();
    if (!vid) {
      return { allowed: false as const, reason: 'Vehicule non identifie' };
    }
    if (!this.perms.can('engine_control', vid)) {
      return { allowed: false as const, reason: 'Permission insuffisante' };
    }

    // Sprint 3 — VEILLEUR (NIGHT_WATCHMAN) : aucune donnée de position ne lui est servie
    // (le client ne reçoit ni vitesse, ni fix, ni âge — cf. liste épurée « zéro donnée »).
    // On NE peut donc PAS pré-valider l'immobilité côté client : on autorise l'envoi et on
    // laisse le SERVEUR seul juge (engine-control.service, bloc NIGHT_WATCHMAN, refuse une
    // coupe en mouvement avec un message clair affiché en toast). Sans ce court-circuit le
    // bouton resterait désactivé (« Aucune position connue ») et le veilleur ne pourrait
    // jamais couper depuis la liste.
    if (this.authService.isWatchman()) {
      // Fix veilleur — le client veilleur ne reçoit AUCUNE position, mais reçoit un flag
      // « en mouvement » minimal (hydraté via /vehicles + transitions WS VEHICLE_MOVEMENT).
      // Si le véhicule roule, on grise le bouton (au lieu d'un rouge trompeur) : la coupe
      // est réservée à l'arrêt. Si l'état est inconnu / à l'arrêt, on autorise l'envoi et
      // le SERVEUR reste seul juge (refus clair en toast si mouvement détecté côté backend).
      if (this.realtime.movingTrackerIds().has(this.trackerId())) {
        return {
          allowed: false as const,
          reason: 'Véhicule en mouvement — coupure réservée à l\'arrêt',
        };
      }
      return { allowed: true as const, reason: null };
    }

    const age = this.positionAge();
    if (age === undefined) {
      return { allowed: false as const, reason: 'Aucune position connue' };
    }
    const speed = this.currentSpeedKmh();
    // À l'arrêt (≤5 km/h) → pas de seuil stale, véhicule garé sans risque.
    // En mouvement → position fraîche (<60s) exigée pour confirmer la vitesse.
    const isAtRest = speed === undefined || speed <= 5;
    if (!isAtRest && age > 60) {
      return { allowed: false as const, reason: `Position trop ancienne (${Math.round(age)}s)` };
    }
    if (!this.validFix()) {
      return { allowed: false as const, reason: 'Fix GPS invalide' };
    }
    if (speed !== undefined && speed > 20) {
      return { allowed: false as const, reason: `Vitesse trop élevée (${speed.toFixed(1)} km/h)` };
    }
    return { allowed: true as const, reason: null };
  });

  readonly canRestore = computed(() => {
    const vid = this.effectiveVehicleId();
    if (!vid) return false;
    return this.perms.can('engine_control', vid);
  });

  /**
   * Avertissement inséré dans les DEUX confirmations quand le boîtier est muet.
   *
   * C'est le moment décisif : l'opérateur s'apprête à considérer le geste comme fait.
   * Le dire ici, avant le clic, est ce qui empêche la fausse certitude — pas un grisage
   * qui, lui, retirerait le seul levier restant sur un véhicule volé.
   */
  private readonly dormantConfirmNotice = computed(() => {
    const d = this.dormantWarning();
    if (!d) return '';
    return (
      `<br><br><span class="text-amber-400 text-xs">Attention : le boîtier n'a plus émis depuis ` +
      `<strong>${d.silence}</strong>. La commande sera tentée (repli SMS) mais aucune confirmation ` +
      `n'est à attendre — à vérifier physiquement.</span>`
    );
  });

  /**
   * L'ETAT DE L'OBJET, rappele dans la confirmation (marqueur n° 2 du niveau critique).
   *
   * On ne demande pas « etes-vous sur ? » dans le vide : on redit ce que le vehicule fait
   * A CET INSTANT. « Roule a 74 km/h » n'est pas la meme decision que « a l'arret ». Les
   * trois faits qui changent le sens du geste, dans l'ordre de gravite : il roule, son
   * boitier est muet, le contact est coupe.
   */
  protected readonly etatVehicule = computed<string>(() => {
    const bouts: string[] = [];
    const v = this.currentSpeedKmh();
    if (v != null && v > 0) bouts.push(`roule à ${Math.round(v)} km/h`);
    else if (this.ignition()) bouts.push("à l'arrêt, contact mis");
    else bouts.push('contact coupé');

    const muet = this.dormantWarning();
    if (muet) bouts.push(`boîtier muet depuis ${muet.silence}`);
    else if (!this.validFix()) bouts.push('position non confirmée');

    return `${this.vehiclePlate()} — ${bouts.join(' · ')}`;
  });

  protected readonly cutDescription = computed(
    () =>
      `Vous êtes sur le point d'immobiliser le véhicule <strong>${this.vehiclePlate()}</strong>.<br><br>` +
      `Le conducteur sera impacté immédiatement et le véhicule deviendra inutilisable ` +
      `jusqu'à réactivation manuelle.<br><br>` +
      `<span class="text-fg-secondary text-xs">Cette action sera enregistrée dans l'audit trail.</span>` +
      this.dormantConfirmNotice(),
  );

  /**
   * Ce que la coupure coûte, en clair. La description dit le geste ; ceci dit le prix —
   * un véhicule immobilisé jusqu'à une action HUMAINE, pas jusqu'à la fin d'un délai.
   * Le kit exige que la conséquence soit nommée à part du reste : c'est elle qu'on lit
   * quand on hésite.
   *
   * Le niveau CRITIQUE de la modale (liseré rouge, état rappelé, plaque à retaper) est
   * spécifié pour cet écran par `B1-PAGES.md` § F « Coupure moteur ». Il se branche au
   * lot B-pages : ajouter une saisie à un geste d'urgence est une décision d'écran, pas
   * une décision de kit.
   */
  protected readonly cutConsequences = computed(
    () =>
      `Le véhicule ${this.vehiclePlate()} ne redémarrera plus tant que personne ne l'aura `
      + 'réactivé depuis Tracky. Le conducteur en cours de trajet est concerné dès la '
      + 'prochaine coupure du contact.',
  );

  protected readonly restoreDescription = computed(() => {
    const base = `Le véhicule <strong>${this.vehiclePlate()}</strong> sera à nouveau utilisable.`;
    if (this.scheduleEnabled()) {
      return (
        base +
        `<br><br><span class="text-fg-secondary text-xs">Le mode horaire reste actif : cette action ` +
        `tient jusqu'à la prochaine bascule, puis le planning reprend automatiquement.</span>` +
        this.dormantConfirmNotice()
      );
    }
    return base + this.dormantConfirmNotice();
  });

  // React to real-time engine command updates for this tracker (field initializer = injection context)
  private readonly engineUpdateEffect = effect(() => {
    const updates = this.realtime.engineCommandUpdates();
    const update = updates.get(this.trackerId());
    if (update) {
      this.loadRecentCommands();
    }
  });

  ngOnInit(): void {
    this.loadRecentCommands();
    this.loadScheduleStatus();
  }

  protected async openAction(action: 'cut' | 'restore'): Promise<void> {
    // Rafraîchir l'état schedule avant d'ouvrir le modal (état le plus frais)
    await this.loadScheduleStatus();
    this.durableImmobilize.set(false);
    this.isOpen.set(action);
  }

  protected async onConfirm(action: 'CUT' | 'RESTORE'): Promise<void> {
    if (this.loading()) return; // Protection double-clic
    this.loading.set(true);
    const reasonText = action === 'CUT' ? this.reason() || undefined : undefined;
    // « Immobilisation durable » (case optionnelle, CUT uniquement) → désactive le planning (sortie
    // du mode horaire, cas anti-vol). Sinon l'action suspend juste le planning jusqu'à la prochaine
    // bascule côté backend (le mode reste actif).
    const durable = action === 'CUT' && this.durableImmobilize();
    // Fermer la modal DÈS la soumission (avant l'attente réseau), succès comme erreur/409 :
    // sinon elle reste ouverte par-dessus et masque le toast + la pastille. Cf smoke prod 2026-06-18.
    this.isOpen.set(null);
    this.reason.set('');
    this.durableImmobilize.set(false);
    try {
      const cmd = await firstValueFrom(
        this.engineControl.requestCommand(this.trackerId(), action, reasonText, durable || undefined),
      );
      if (durable) {
        this._scheduleEnabled.set(false);
        this.scheduleDisabled.emit();
      }
      // Sprint 2 — PAS de faux succes : on annonce "envoyee" ; la confirmation
      // (chute d'ignition) fera basculer l'etat coupe via le WS + commandState.
      // Boîtier muet : « en attente de confirmation » deviendrait mensonger — il n'y aura
      // PAS de confirmation. On le dit dans le toast, dernière chose lue avant de partir.
      const dormant = this.dormantWarning();
      this.toast.success(
        action === 'CUT' ? 'Coupure envoyée' : 'Rallumage envoyé',
        dormant
          ? `Commande ${cmd.id.slice(0, 8)} — boîtier muet depuis ${dormant.silence} : aucune confirmation à attendre, à vérifier physiquement.`
          : action === 'CUT'
            ? `Commande ${cmd.id.slice(0, 8)} — en attente de confirmation du boîtier…`
            : `Commande ${cmd.id.slice(0, 8)} transmise au véhicule.`,
      );
      await this.loadRecentCommands();
    } catch (err) {
      swallow('engine-control-button:onConfirm', err);
      if (err instanceof HttpErrorResponse && err.status === 409) {
        this.toast.error(
          'Commande déjà en cours',
          'Une coupure est déjà en attente de confirmation sur ce véhicule.',
        );
      } else {
        this.toast.error(
          action === 'CUT' ? 'Coupure refusée' : 'Rallumage refusé',
          this.extractErrorMessage(err),
        );
      }
    } finally {
      this.loading.set(false);
    }
  }

  private async loadScheduleStatus(): Promise<void> {
    // Trouver le vehicleId depuis l'input ou le snapshot (fallback)
    let vid = this.vehicleId();
    if (!vid) {
      const snap = this.realtime.snapshot().find((v) => v.trackerId === this.trackerId());
      vid = snap?.vehicleId;
    }
    if (!vid) return;
    try {
      const schedule = await firstValueFrom(this.schedulesApi.get(vid));
      this._scheduleEnabled.set(!!schedule?.enabled);
    } catch (err) {
      swallow('engine-control-button:loadScheduleStatus', err);
      // Non critique
    }
  }

  private async loadRecentCommands(retries = 2): Promise<void> {
    try {
      const cmds = await firstValueFrom(
        this.engineControl.listCommands(this.trackerId(), 5),
      );
      this.recentCommands.set(cmds);
    } catch (err) {
      swallow('engine-control-button:loadRecentCommands', err);
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, 1000));
        return this.loadRecentCommands(retries - 1);
      }
      // Après retries épuisés, le bouton garde le dernier état connu
    }
  }

  private extractErrorMessage(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      // L'API enveloppe ses erreurs : `{ error: { code, message, requestId } }`.
      // On lit d'abord le message de l'enveloppe, puis les formes plates en repli —
      // sinon l'opérateur verrait « Http failure response … 403 » au lieu de la vraie
      // raison (ex. « Véhicule en mouvement (10 km/h) — coupure réservée à l'arrêt »).
      const body = err.error as { error?: { message?: string }; message?: string } | null;
      return body?.error?.message ?? body?.message ?? err.message ?? 'Erreur inconnue';
    }
    return String(err);
  }
}
