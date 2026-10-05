import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  URGENCE_WHATSAPP_ECRANS,
  URGENCE_WHATSAPP_RETARD_MAX_S,
  type AssistanceAdminDetailDto,
  type AssistanceAdminListItemDto,
  type AssistanceConversationDto,
  type AssistanceListItemDto,
  type ReviewAssistanceDto,
  type SignalUrgenceWhatsappDto,
  type UrgenceWhatsappEcran,
} from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

const URL_URGENCE_WHATSAPP = '/api/assistance/urgence/whatsapp';

/** Préfixe de la clé où attend un appui retenu — suffixé par le COMPTE, voir `retenirAppui`. */
export const CLE_APPUI_RETENU = 'vizyo-tracky-urgence-retenue:';

/** Ce qu'un appui retenu garde de lui : de quoi le redire, et l'instant où il a eu lieu. */
interface AppuiRetenu {
  ecran: UrgenceWhatsappEcran;
  plaque?: string;
  /** `Date.now()` au moment de l'appui — relu sur la MÊME horloge pour en tirer un âge. */
  a: number;
}

/** Les échecs où la requête n'a, selon toute vraisemblance, jamais atteint l'API. */
const estPanneDeTransport = (e: unknown): boolean =>
  e instanceof HttpErrorResponse && [0, 502, 503, 504].includes(e.status);

/**
 * Le seul refus DÉFINITIF : le serveur a lu le corps et l'a jugé invalide. Tout le reste attend la
 * prochaine occasion — un 401 (jeton à renouveler), un 403 de démarrage (consentement, appareil à
 * vérifier : l'intercepteur les lève AVANT que la personne ait pu y répondre), un 429. Oublier
 * l'appui sur l'un d'eux perdrait précisément l'appel à l'aide fait pendant la panne (revue du 05/10).
 */
const estRefusDefinitif = (e: unknown): boolean => e instanceof HttpErrorResponse && e.status === 400;

/**
 * Assistance IA (2026-08) — client HTTP.
 *
 * Deux surfaces distinctes, comme côté serveur : ce qu'un utilisateur voit de SA conversation, et
 * ce qu'un administrateur voit de l'archive. Le cloisonnement est appliqué par le serveur ; ce
 * service ne fait que l'appeler — aucun filtrage ici, qui donnerait l'illusion d'une garde.
 */
@Injectable({ providedIn: 'root' })
export class AssistanceApiService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private retransmissionEnCours = false;

  /** L'assistance est-elle utilisable ? Sert à ne pas proposer un chat mort. */
  disponible(): Observable<{ disponible: boolean }> {
    return this.http.get<{ disponible: boolean }>('/api/assistance/disponible');
  }

  /** Poser une question. Sans `conversationId`, une conversation est ouverte. */
  ask(message: string, conversationId?: string): Observable<AssistanceConversationDto> {
    return this.http.post<AssistanceConversationDto>('/api/assistance/ask', { message, conversationId });
  }

  mesConversations(): Observable<AssistanceListItemDto[]> {
    return this.http.get<AssistanceListItemDto[]>('/api/assistance/conversations');
  }

  conversation(id: string): Observable<AssistanceConversationDto> {
    return this.http.get<AssistanceConversationDto>(`/api/assistance/conversations/${encodeURIComponent(id)}`);
  }

  /** Demander un rappel humain — ne consomme aucun appel IA. */
  rappel(id: string, motif?: string): Observable<AssistanceConversationDto> {
    return this.http.post<AssistanceConversationDto>(
      `/api/assistance/conversations/${encodeURIComponent(id)}/rappel`,
      { motif },
    );
  }

  // ─── Ligne d'urgence WhatsApp (01/10/2026) ─────────────────────────────────

  /**
   * Signale qu'on vient d'ouvrir la ligne d'urgence WhatsApp : le serveur l'écrit au centre
   * d'activité et prévient les super-admins.
   *
   * Tirer-et-oublier, À DESSEIN : appelé dans le clic, pendant que le lien ouvre WhatsApp, et
   * rien ne l'attend. Une erreur ici ne doit ni bloquer ni retarder une urgence — elle est
   * avalée, et l'intercepteur d'erreurs ignore cette route.
   *
   * Sans session, RIEN ne part : l'écran « mise à jour en cours » s'affiche aussi sur la page de
   * connexion et sur la page publique de suivi, où personne n'est à nommer — et où le 401 en
   * retour déclencherait la redirection de l'intercepteur vers `/login`.
   *
   * ⚠️ L'APPUI FAIT PENDANT UNE PANNE est retenu, puis retransmis (`retransmettreAppuiRetenu`).
   * C'est le cas qui compte le plus : l'écran « mise à jour en cours » n'apparaît QUE quand l'API
   * ne répond plus, et un signalement envoyé à cet instant se perdait à coup sûr — précisément le
   * soir où l'on voudrait savoir qui a eu besoin d'aide pendant l'incident. Seul cet écran retient :
   * ailleurs l'API répond, et un échec de transport peut venir du basculement vers WhatsApp alors
   * que la requête était déjà arrivée — la retransmettre doublerait la trace.
   */
  signalerUrgenceWhatsapp(ecran: UrgenceWhatsappEcran, plaque?: string | null): void {
    const userId = this.auth.user()?.sub;
    if (!userId) return;
    const appui: AppuiRetenu = plaque ? { ecran, plaque, a: Date.now() } : { ecran, a: Date.now() };
    const corps: SignalUrgenceWhatsappDto = plaque ? { ecran, plaque } : { ecran };
    this.http.post<void>(URL_URGENCE_WHATSAPP, corps).subscribe({
      error: (e: unknown) => {
        if (ecran === 'mise-a-jour' && estPanneDeTransport(e)) retenirAppui(userId, appui);
      },
    });
  }

  /**
   * Retransmet l'appui retenu pendant une panne — s'il appartient au compte connecté et qu'il a
   * moins de deux heures. Le serveur reçoit son ÂGE (`retardS`) et annonce l'heure réelle de
   * l'appui : un appel à l'aide vieux d'une demi-heure ne doit pas se lire « maintenant ».
   *
   * L'appui n'est oublié qu'une fois REÇU, ou refusé pour de bon (400) : si l'API est encore à
   * terre, ou si un écran de démarrage (consentement, appareil) passe avant, il attend la prochaine
   * occasion. Il expire de lui-même au bout de deux heures.
   */
  retransmettreAppuiRetenu(): void {
    const userId = this.auth.user()?.sub;
    if (!userId || this.retransmissionEnCours) return;
    const retenu = lireAppuiRetenu(userId);
    if (!retenu) return;
    const retardS = Math.round((Date.now() - retenu.a) / 1000);
    // Négatif : l'horloge du téléphone a reculé, l'âge ne veut plus rien dire.
    if (retardS < 0 || retardS > URGENCE_WHATSAPP_RETARD_MAX_S) {
      oublierAppui(userId);
      return;
    }
    const corps: SignalUrgenceWhatsappDto = {
      ecran: retenu.ecran,
      ...(retenu.plaque ? { plaque: retenu.plaque } : {}),
      retardS,
    };
    this.retransmissionEnCours = true;
    this.http.post<void>(URL_URGENCE_WHATSAPP, corps).subscribe({
      next: () => oublierAppui(userId),
      error: (e: unknown) => {
        if (estRefusDefinitif(e)) oublierAppui(userId);
        this.retransmissionEnCours = false;
      },
      complete: () => {
        this.retransmissionEnCours = false;
      },
    });
  }

  // ─── Archive (admin) ───────────────────────────────────────────────────────

  adminListe(statut?: string): Observable<AssistanceAdminListItemDto[]> {
    return this.http.get<AssistanceAdminListItemDto[]>('/api/assistance/admin/conversations', {
      params: statut ? { statut } : {},
    });
  }

  adminDetail(id: string): Observable<AssistanceAdminDetailDto> {
    return this.http.get<AssistanceAdminDetailDto>(
      `/api/assistance/admin/conversations/${encodeURIComponent(id)}`,
    );
  }

  /** Marquer relue + consigner la correction à retenir. */
  relire(id: string, dto: ReviewAssistanceDto): Observable<AssistanceAdminDetailDto> {
    return this.http.post<AssistanceAdminDetailDto>(
      `/api/assistance/admin/conversations/${encodeURIComponent(id)}/review`,
      dto,
    );
  }

  /** Réponse d'un conseiller humain, insérée dans le fil que l'utilisateur voit. */
  repondre(id: string, message: string): Observable<AssistanceAdminDetailDto> {
    return this.http.post<AssistanceAdminDetailDto>(
      `/api/assistance/admin/conversations/${encodeURIComponent(id)}/reply`,
      { message },
    );
  }
}

// ─── L'appui retenu, dans le stockage du navigateur ─────────────────────────
//
// Une clé PAR COMPTE : chez CDEF31 les veilleurs se relaient sur le même appareil. L'appui d'une
// personne ne doit jamais partir sous le nom de la suivante — il attend son auteur, ou expire.
// Chaque accès est protégé : en navigation privée le stockage peut refuser d'écrire, et cela ne
// doit rien casser — WhatsApp est parti quand même, seule la trace manquera.

function lireAppuiRetenu(userId: string): AppuiRetenu | null {
  try {
    const brut = localStorage.getItem(CLE_APPUI_RETENU + userId);
    if (!brut) return null;
    const v = JSON.parse(brut) as Partial<AppuiRetenu>;
    // Relu depuis le stockage, donc revérifié : une valeur illisible serait retentée à chaque
    // démarrage, et refusée à chaque fois par le serveur.
    if (typeof v.a !== 'number' || !URGENCE_WHATSAPP_ECRANS.includes(v.ecran as UrgenceWhatsappEcran)) {
      oublierAppui(userId);
      return null;
    }
    return {
      ecran: v.ecran as UrgenceWhatsappEcran,
      a: v.a,
      ...(typeof v.plaque === 'string' && v.plaque ? { plaque: v.plaque } : {}),
    };
  } catch {
    return null;
  }
}

function retenirAppui(userId: string, appui: AppuiRetenu): void {
  try {
    // Le PREMIER appui compte : c'est lui qui dit depuis quand la personne attend. Trois appuis
    // impatients pendant la même panne ne doivent pas rajeunir l'appel à l'aide.
    const existant = lireAppuiRetenu(userId);
    if (existant && appui.a - existant.a <= URGENCE_WHATSAPP_RETARD_MAX_S * 1000) return;
    localStorage.setItem(CLE_APPUI_RETENU + userId, JSON.stringify(appui));
  } catch {
    /* stockage indisponible : l'appui est perdu, l'urgence, elle, est partie */
  }
}

function oublierAppui(userId: string): void {
  try {
    localStorage.removeItem(CLE_APPUI_RETENU + userId);
  } catch {
    /* rien à faire */
  }
}
