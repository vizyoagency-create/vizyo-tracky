import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AlertTriangle, Bell, Edit2, LucideAngularModule, Mail, MessageCircle, Plus, Trash2, XCircle } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { FleetsApiService } from '../../core/services/fleets.service';
import { AlertRuleDto, NotificationsApiService } from '../../core/services/notifications.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * « Ce que la flotte ENVOIE » — les règles d'alerte, en CARTE dans la page Paramètres.
 *
 * ── Pourquoi ce composant remplace deux fichiers ────────────────────────────────────────
 * Le même formulaire existait EN DOUBLE : une page autonome `/settings/alert-rules` et un
 * onglet « Réglages » dans la page Alertes. Logique d'enregistrement identique au caractère
 * près, donc bugs identiques des deux côtés — et corriger l'un ne corrigeait pas l'autre.
 * Tout est désormais ici ; la page Alertes n'affiche plus qu'un résumé en lecture avec un
 * lien. Un réglage modifié se voit partout parce qu'il n'existe qu'à UN endroit, pas parce
 * qu'on aurait synchronisé deux écrans.
 *
 * ── Deux corrections de fond ────────────────────────────────────────────────────────────
 * 1. SÉLECTEUR DE FLOTTE. Un SUPER_ADMIN n'appartient à aucune flotte : le formulaire
 *    n'envoyait jamais `fleetId`, donc toute création échouait en 400 « fleetId requis ».
 *    Le backend savait pourtant le recevoir. Le champ apparaît maintenant, pour eux seuls.
 * 2. LE PUSH N'EST PLUS UN CANAL DE RÈGLE. Il est devenu un canal de BASE, toujours actif,
 *    piloté par les préférences personnelles de chacun. Le laisser cochable ici laisserait
 *    croire qu'il faut une règle pour recevoir un push — c'est EXACTEMENT le piège qui a
 *    laissé le push mort pendant des mois. Les règles ne pilotent plus que ce qui coûte.
 */

/** Types d'alerte proposés. Le libellé est en français : jamais l'identifiant brut. */
const ALERT_TYPES: { value: string; label: string }[] = [
  { value: '*', label: 'Tous les types' },
  { value: 'SOS', label: 'SOS conducteur' },
  { value: 'POWER_CUT', label: 'Coupure d’alimentation' },
  { value: 'OFF_SCHEDULE_MOVEMENT', label: 'Sortie hors horaire (hors champ GPS)' },
  { value: 'ACCIDENT', label: 'Accident' },
  { value: 'COLLISION', label: 'Collision' },
  { value: 'TOW', label: 'Remorquage' },
  { value: 'TAMPER', label: 'Retrait du boîtier' },
  { value: 'ILLEGAL_IGNITION', label: 'Démarrage non autorisé' },
  { value: 'LOW_BATTERY', label: 'Batterie faible' },
  { value: 'OVERSPEED', label: 'Excès de vitesse' },
  { value: 'GEOFENCE_ENTER', label: 'Entrée de zone' },
  { value: 'GEOFENCE_EXIT', label: 'Sortie de zone' },
  { value: 'MOVEMENT_IDLE', label: 'Mouvement moteur éteint' },
  { value: 'BONNET', label: 'Capot ouvert' },
  { value: 'DOOR', label: 'Porte ouverte' },
  { value: 'FATIGUE', label: 'Fatigue conducteur' },
  { value: 'HARSH_BRAKING', label: 'Freinage brusque' },
  { value: 'HARSH_ACCELERATION', label: 'Accélération brusque' },
  { value: 'HARSH_TURN', label: 'Virage brusque' },
  { value: 'VIBRATION', label: 'Vibration' },
  { value: 'GPS_LOST', label: 'Signal GPS perdu' },
  { value: 'IDLE_TIME', label: 'Arrêt prolongé' },
];

/**
 * Canaux réglables par une règle — les COÛTEUX uniquement.
 * `WEB_PUSH` en est volontairement absent (cf. en-tête du composant).
 */
const RULE_CHANNELS: { value: 'EMAIL' | 'WHATSAPP'; label: string; hint: string; icon: typeof Mail }[] = [
  { value: 'EMAIL', label: 'E-mail', hint: 'Envoyé aux responsables de la flotte', icon: Mail },
  { value: 'WHATSAPP', label: 'WhatsApp', hint: 'Nécessite un numéro vérifié', icon: MessageCircle },
];

interface RuleForm {
  id: string | null;
  fleetId: string | null;
  vehicleId: string | null;
  alertType: string;
  enabled: boolean;
  channels: ('EMAIL' | 'WHATSAPP')[];
  escalateAfterMin: number | null;
  escalateToUserId: string | null;
}

const EMPTY_FORM: RuleForm = {
  id: null,
  fleetId: null,
  vehicleId: null,
  alertType: '*',
  enabled: true,
  channels: ['EMAIL'],
  escalateAfterMin: null,
  escalateToUserId: null,
};

@Component({
  selector: 'app-alert-rules-card',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, FormsModule],
  template: `
    <section class="card">
      <header class="card-head">
        <div>
          <h2>Ce que la flotte envoie</h2>
          <p class="desc">
            Ces règles décident des envois <strong>par e-mail et WhatsApp</strong>, pour toute
            la flotte. Elles ne concernent pas vos notifications personnelles.
          </p>
        </div>
        @if (canEdit()) {
          <button class="btn-primary" (click)="openCreate()" type="button">
            <lucide-icon [img]="Plus" [size]="15"></lucide-icon>
            Ajouter une règle
          </button>
        }
      </header>

      <!--
        LE texte qui manquait. Sans règle, l'utilisateur croyait ne plus rien recevoir du
        tout — c'est faux depuis que le push est un canal de base, et ne pas le dire est
        précisément ce qui rend le système opaque.
      -->
      <div class="note">
        <lucide-icon [img]="Bell" [size]="16"></lucide-icon>
        <p>
          <strong>Sans aucune règle, vous recevez quand même</strong> les alertes dans
          l’application et les notifications push. Seuls l’e-mail, le WhatsApp et le SMS
          s’arrêtent. Le push se règle plus haut, dans « Mes notifications ».
        </p>
      </div>

      @if (!canEdit()) {
        <p class="readonly">Lecture seule — seul un administrateur de flotte peut modifier ces règles.</p>
      }

      @if (loading()) {
        <p class="muted">Chargement…</p>
      } @else if (rules().length === 0) {
        <div class="empty">
          <p><strong>Aucune règle.</strong> Aucun e-mail ni WhatsApp d’alerte n’est envoyé.</p>
          <p class="muted">L’application et le push continuent de fonctionner normalement.</p>
        </div>
      } @else {
        <ul class="rules">
          @for (rule of rules(); track rule.id) {
            <li class="rule" [class.rule-off]="!rule.enabled">
              <div class="rule-main">
                <span class="rule-type">{{ alertTypeLabel(rule.alertType) }}</span>
                <span class="rule-state" [class.on]="rule.enabled">
                  {{ rule.enabled ? 'Active' : 'Désactivée' }}
                </span>
              </div>
              <div class="rule-meta">
                @for (c of costlyChannels(rule); track c) {
                  <span class="chip">{{ channelLabel(c) }}</span>
                }
                @if (costlyChannels(rule).length === 0) {
                  <span class="chip chip-muted">Aucun envoi externe</span>
                }
                @if (rule.escalateAfterMin) {
                  <span class="chip">Escalade après {{ rule.escalateAfterMin }} min</span>
                }
                <span class="muted">créée le {{ rule.createdAt | date: 'dd/MM/yyyy' }}</span>
              </div>
              @if (canEdit()) {
                <div class="rule-actions">
                  <button class="btn-icon" type="button" (click)="openEdit(rule)" aria-label="Modifier la règle">
                    <lucide-icon [img]="Edit2" [size]="15"></lucide-icon>
                  </button>
                  <button class="btn-icon danger" type="button" (click)="remove(rule)" aria-label="Supprimer la règle">
                    <lucide-icon [img]="Trash2" [size]="15"></lucide-icon>
                  </button>
                </div>
              }
            </li>
          }
        </ul>
      }
    </section>

    @if (formOpen()) {
      <div class="overlay" (click)="close()">
        <div class="sheet" (click)="$event.stopPropagation()">
          <header class="sheet-head">
            <h3>{{ form().id ? 'Modifier la règle' : 'Nouvelle règle' }}</h3>
            <button class="btn-icon" type="button" (click)="close()" aria-label="Fermer">
              <lucide-icon [img]="XCircle" [size]="20"></lucide-icon>
            </button>
          </header>

          <div class="sheet-body">
            <!--
              Visible UNIQUEMENT pour un super-admin : il n'appartient à aucune flotte, donc
              le serveur n'a rien à déduire. Un chef de flotte n'a pas ce champ, sa flotte
              étant implicite — lui montrer un sélecteur à une seule valeur serait du bruit.
            -->
            @if (needsFleet()) {
              <label class="field">
                <span class="field-label">Flotte <em>obligatoire</em></span>
                <select [ngModel]="form().fleetId" (ngModelChange)="patch({ fleetId: $event })">
                  <option [ngValue]="null">Choisir une flotte…</option>
                  @for (f of fleets(); track f.id) {
                    <option [ngValue]="f.id">{{ f.name }}</option>
                  }
                </select>
                <span class="field-hint">Une règle s’applique à une seule flotte.</span>
              </label>
            }

            <label class="field">
              <span class="field-label">Type d’alerte</span>
              <select [ngModel]="form().alertType" (ngModelChange)="patch({ alertType: $event })">
                @for (t of alertTypes; track t.value) {
                  <option [ngValue]="t.value">{{ t.label }}</option>
                }
              </select>
            </label>

            <fieldset class="field">
              <legend class="field-label">Canaux d’envoi</legend>
              @for (c of ruleChannels; track c.value) {
                <label class="toggle">
                  <input type="checkbox"
                         [checked]="form().channels.includes(c.value)"
                         (change)="toggleChannel(c.value, $any($event.target).checked)" />
                  <span class="toggle-txt">
                    <span class="toggle-label">
                      <lucide-icon [img]="c.icon" [size]="14"></lucide-icon> {{ c.label }}
                    </span>
                    <span class="field-hint">{{ c.hint }}</span>
                  </span>
                </label>
              }
              <p class="field-hint">
                Les notifications push ne se règlent pas ici : elles sont toujours actives et
                chacun choisit ce qu’il reçoit dans « Mes notifications ».
              </p>
            </fieldset>

            <label class="field">
              <span class="field-label">Escalader après (minutes)</span>
              <input type="number" min="1" max="120" placeholder="ex. 10"
                     [ngModel]="form().escalateAfterMin"
                     (ngModelChange)="setEscalation($event)" />
              <span class="field-hint">
                Si une alerte critique n’est pas acquittée dans ce délai, le contact
                d’escalade est prévenu à son tour. Laisser vide pour ne pas escalader.
              </span>
              <!--
                Honnêteté sur une dépendance invisible : l'escalade ne part QUE vers le
                « contact d'escalade » d'un destinataire. Constat prod 2026-07-28 : aucun
                des 15 utilisateurs n'en avait un, et aucun écran ne permettait d'en
                définir — le cron d'escalade tournait chaque minute sans jamais pouvoir
                agir. Tant que ce contact n'est pas paramétrable, ce délai ne doit pas
                être présenté comme une garantie.
              -->
              <span class="field-warn">
                Ce délai reste sans effet tant qu’aucun contact d’escalade n’est défini
                sur les profils des destinataires.
              </span>
            </label>

            <label class="toggle">
              <input type="checkbox" [ngModel]="form().enabled" (ngModelChange)="patch({ enabled: $event })" />
              <span class="toggle-txt"><span class="toggle-label">Règle active</span></span>
            </label>

            @if (error()) {
              <p class="error" role="alert">
                <lucide-icon [img]="AlertTriangle" [size]="15"></lucide-icon>
                {{ error() }}
              </p>
            }
          </div>

          <footer class="sheet-foot">
            <button class="btn-ghost" type="button" (click)="close()">Annuler</button>
            <button class="btn-primary" type="button" [disabled]="saving()" (click)="save()">
              {{ saving() ? 'Enregistrement…' : 'Enregistrer' }}
            </button>
          </footer>
        </div>
      </div>
    }
  `,
  styles: [`
    .card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 14px; padding: 1.1rem; }
    .card-head { display: flex; gap: 1rem; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
    h2 { margin: 0 0 .2rem; font-size: 1.02rem; }
    .desc, .field-hint, .muted { color: var(--fg-secondary); font-size: .84rem; line-height: 1.45; }
    .desc { margin: 0; max-width: 60ch; }
    .note { display: flex; gap: .6rem; align-items: flex-start; margin: .9rem 0;
      padding: .7rem .8rem; border-radius: 10px;
      background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent); }
    .note p { margin: 0; font-size: .85rem; line-height: 1.5; }
    .readonly { margin: .6rem 0 0; font-size: .84rem; color: var(--fg-secondary); }
    .empty { padding: .9rem 0; }
    .empty p { margin: 0 0 .25rem; font-size: .88rem; }
    .rules { list-style: none; margin: .9rem 0 0; padding: 0; display: grid; gap: .55rem; }
    .rule { border: 1px solid var(--border-subtle); border-radius: 11px; padding: .7rem .8rem;
      display: grid; grid-template-columns: 1fr auto; gap: .35rem .6rem; align-items: center; }
    .rule-off { opacity: .55; }
    .rule-main { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    .rule-type { font-weight: 600; font-size: .9rem; }
    .rule-state { font-size: .74rem; padding: .1rem .45rem; border-radius: 999px;
      background: var(--bg-quaternary); color: var(--fg-secondary); }
    .rule-state.on { background: color-mix(in srgb, var(--color-tracky-light) 16%, transparent); color: var(--texte-succes); }
    .rule-meta { grid-column: 1 / -1; display: flex; gap: .35rem; flex-wrap: wrap; align-items: center; }
    .chip { font-size: .74rem; padding: .12rem .48rem; border-radius: 999px; border: 1px solid var(--border-subtle); }
    .chip-muted { color: var(--fg-secondary); }
    .rule-actions { display: flex; gap: .3rem; }
    /* 44 px : cible tactile minimale — la page est consultée au téléphone. */
    .btn-icon { min-width: 44px; min-height: 44px; display: inline-flex; align-items: center;
      justify-content: center; border: 1px solid var(--border-subtle); border-radius: 10px;
      background: transparent; color: inherit; cursor: pointer; }
    .btn-icon.danger { color: var(--texte-alerte); }
    .btn-primary, .btn-ghost { min-height: 44px; padding: 0 .95rem; border-radius: 10px;
      font-size: .88rem; cursor: pointer; display: inline-flex; align-items: center; gap: .4rem; }
    /* Encre FONCEE sur l'accent — regle non negociable de B0-SOCLE. Le blanc mesurait
       2,54:1 ici. Le repli hexadecimal etait mort : la variable est toujours definie. */
    .btn-primary { background: var(--color-tracky-light); color: var(--accent-ink); border: none; }
    .btn-primary[disabled] { opacity: .6; cursor: default; }
    .btn-ghost { background: transparent; border: 1px solid var(--border-subtle); color: inherit; }
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 60;
      display: flex; align-items: flex-end; justify-content: center; }
    .sheet { background: var(--bg-secondary); width: min(560px, 100%); max-height: 92vh; max-height: 92dvh;
      display: flex; flex-direction: column; border-radius: 16px 16px 0 0;
      /* Zone sûre iOS : sans ça le bouton passe sous la barre gestuelle. */
      padding-bottom: env(safe-area-inset-bottom, 0); }
    .sheet-head, .sheet-foot { display: flex; align-items: center; gap: .6rem; padding: .9rem 1rem; }
    .sheet-head { justify-content: space-between; border-bottom: 1px solid var(--border-subtle); }
    .sheet-foot { justify-content: flex-end; border-top: 1px solid var(--border-subtle); }
    .sheet-head h3 { margin: 0; font-size: 1rem; }
    .sheet-body { padding: 1rem; overflow-y: auto; display: grid; gap: 1rem; }
    .field { display: grid; gap: .3rem; border: none; padding: 0; margin: 0; }
    .field-label { font-size: .86rem; font-weight: 600; }
    .field-label em { font-style: normal; font-weight: 400; color: var(--fg-secondary); font-size: .78rem; }
    select, input[type="number"] { min-height: 44px; padding: 0 .6rem; border-radius: 10px;
      border: 1px solid var(--border-subtle); background: var(--bg-secondary); color: inherit; font-size: .9rem; width: 100%; }
    .toggle { display: flex; gap: .6rem; align-items: flex-start; min-height: 44px; padding: .25rem 0; cursor: pointer; }
    .toggle input { width: 20px; height: 20px; margin-top: .55rem; flex: none; }
    .toggle-txt { display: grid; gap: .1rem; }
    .toggle-label { display: inline-flex; gap: .35rem; align-items: center; font-size: .89rem; }
    .field-warn { font-size: .8rem; line-height: 1.45; color: var(--texte-attente);
      background: color-mix(in srgb, var(--warning) 12%, transparent);
      border-radius: 8px; padding: .4rem .55rem; }
    .error { display: flex; gap: .45rem; align-items: center; margin: 0; color: var(--texte-alerte); font-size: .85rem; }
    @media (min-width: 640px) {
      .overlay { align-items: center; }
      .sheet { border-radius: 16px; }
    }
  `],
})
export class AlertRulesCardComponent implements OnInit {
  private readonly api = inject(NotificationsApiService);
  private readonly auth = inject(AuthService);
  private readonly fleetsApi = inject(FleetsApiService);
  private readonly toast = inject(ToastService);

  protected readonly Plus = Plus;
  protected readonly Edit2 = Edit2;
  protected readonly Trash2 = Trash2;
  protected readonly XCircle = XCircle;
  protected readonly Bell = Bell;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly alertTypes = ALERT_TYPES;
  protected readonly ruleChannels = RULE_CHANNELS;

  protected readonly rules = signal<AlertRuleDto[]>([]);
  protected readonly fleets = signal<{ id: string; name: string }[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly formOpen = signal(false);
  protected readonly form = signal<RuleForm>(EMPTY_FORM);
  /** Message d'échec RÉEL, affiché dans la feuille (cf. `save`). */
  protected readonly error = signal<string | null>(null);

  protected readonly canEdit = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'SUPER_ADMIN' || role === 'FLEET_ADMIN' || role === 'FLEET_MANAGER';
  });

  /** Seul un compte sans flotte doit désigner explicitement la cible de la règle. */
  protected readonly needsFleet = computed(() => !this.auth.user()?.fleetId);

  async ngOnInit(): Promise<void> {
    await this.reload();
    if (this.needsFleet()) {
      // Best-effort : sans la liste, le sélecteur reste vide et `save` refuse proprement.
      await firstValueFrom(this.fleetsApi.list())
        .then((list) => this.fleets.set(list.map((f) => ({ id: f.id, name: f.name }))))
        .catch(() => this.fleets.set([]));
    }
  }

  private async reload(): Promise<void> {
    this.loading.set(true);
    try {
      await this.api.listRules();
      this.rules.set(this.api.rules());
    } catch {
      this.toast.error('Impossible de charger les règles');
    } finally {
      this.loading.set(false);
    }
  }

  protected alertTypeLabel(value: string): string {
    return ALERT_TYPES.find((t) => t.value === value)?.label ?? value;
  }

  protected channelLabel(value: string): string {
    return RULE_CHANNELS.find((c) => c.value === value)?.label ?? value;
  }

  /**
   * N'affiche que les canaux COÛTEUX. `IN_APP` et `WEB_PUSH` peuvent traîner dans des règles
   * créées avant que le push devienne un canal de base : les montrer laisserait croire
   * qu'ils dépendent de la règle, alors qu'ils partent de toute façon.
   */
  protected costlyChannels(rule: AlertRuleDto): string[] {
    return rule.channels.filter((c) => c === 'EMAIL' || c === 'WHATSAPP');
  }

  protected openCreate(): void {
    this.error.set(null);
    // Une seule flotte possible → pré-remplie : on ne fait pas choisir dans une liste d'un.
    const only = this.fleets().length === 1 ? this.fleets()[0].id : null;
    this.form.set({ ...EMPTY_FORM, fleetId: this.needsFleet() ? only : null });
    this.formOpen.set(true);
  }

  protected openEdit(rule: AlertRuleDto): void {
    this.error.set(null);
    this.form.set({
      id: rule.id,
      fleetId: rule.fleetId ?? null,
      vehicleId: rule.vehicleId,
      alertType: rule.alertType,
      channels: rule.channels.filter((c): c is 'EMAIL' | 'WHATSAPP' => c === 'EMAIL' || c === 'WHATSAPP'),
      enabled: rule.enabled,
      escalateAfterMin: rule.escalateAfterMin,
      escalateToUserId: rule.escalateToUserId,
    });
    this.formOpen.set(true);
  }

  protected close(): void {
    this.formOpen.set(false);
    this.error.set(null);
  }

  protected patch(p: Partial<RuleForm>): void {
    this.form.update((f) => ({ ...f, ...p }));
  }

  /** `Number()` n'est pas accessible depuis un template Angular : la conversion vit ici. */
  protected setEscalation(value: unknown): void {
    const n = Number(value);
    this.patch({ escalateAfterMin: Number.isFinite(n) && n > 0 ? n : null });
  }

  protected toggleChannel(channel: 'EMAIL' | 'WHATSAPP', checked: boolean): void {
    const current = this.form().channels;
    this.patch({ channels: checked ? [...current, channel] : current.filter((c) => c !== channel) });
  }

  protected async save(): Promise<void> {
    const f = this.form();
    this.error.set(null);

    // Validations côté écran : elles évitent un aller-retour, mais ne remplacent PAS
    // celles du serveur — c'est lui qui fait autorité.
    if (this.needsFleet() && !f.fleetId) {
      this.error.set('Choisissez la flotte concernée par cette règle.');
      return;
    }
    if (f.channels.length === 0) {
      this.error.set('Choisissez au moins un canal d’envoi, ou supprimez la règle.');
      return;
    }

    this.saving.set(true);
    try {
      const payload = {
        fleetId: f.fleetId ?? undefined,
        vehicleId: f.vehicleId,
        alertType: f.alertType,
        enabled: f.enabled,
        channels: f.channels as string[],
        escalateAfterMin: f.escalateAfterMin,
        escalateToUserId: f.escalateToUserId,
      };
      if (f.id) {
        await this.api.updateRule(f.id, payload);
        this.toast.success('Règle mise à jour');
      } else {
        await this.api.createRule(payload);
        this.toast.success('Règle créée');
      }
      await this.reload();
      this.formOpen.set(false);
    } catch (e: unknown) {
      // ⚠️ On AFFICHE le motif du serveur. L'ancien écran jetait l'erreur et montrait
      // « Échec de l'enregistrement » : le vrai message était « fleetId requis », et
      // personne ne pouvait le deviner. Un échec muet est un échec qu'on ne corrige pas.
      this.error.set(serverMessage(e) ?? 'Échec de l’enregistrement.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(rule: AlertRuleDto): Promise<void> {
    if (!confirm(`Supprimer la règle « ${this.alertTypeLabel(rule.alertType)} » ?`)) return;
    try {
      await this.api.deleteRule(rule.id);
      this.toast.success('Règle supprimée');
      await this.reload();
    } catch (e: unknown) {
      this.toast.error(serverMessage(e) ?? 'Échec de la suppression');
    }
  }
}

/**
 * Extrait le message porté par une réponse d'erreur HTTP.
 *
 * Nest renvoie `{ message }` — parfois une chaîne, parfois un tableau (erreurs de
 * validation). Exporté pour être testé : c'est ce qui transforme un échec opaque en
 * information exploitable.
 */
export function serverMessage(e: unknown): string | null {
  const err = e as { error?: { message?: unknown } } | undefined;
  const raw = err?.error?.message;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw)) {
    const joined = raw.filter((m) => typeof m === 'string').join(' · ').trim();
    if (joined) return joined;
  }
  return null;
}
