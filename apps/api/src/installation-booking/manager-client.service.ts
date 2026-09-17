import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import type { Env } from '../config/env.validation';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * TRACKY → VIZYO MANAGER : CRÉER LE CLIENT D'UN PROSPECT, SANS JAMAIS CRÉER LA FLOTTE SOI-MÊME
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Conception v2 du 16/09, § 2.3. Manager est la SEULE source de vérité d'un client (compte
 * Vizyo Auth, facturation, essai) et le seul à provisionner une flotte Tracky : une flotte créée
 * « dans son coin » par Tracky serait inconnue de Manager, et la prochaine activation depuis
 * Manager en créerait une deuxième. Ce service appelle donc le point d'entrée interne de Manager
 * (`POST /internal/clients`, lot D), qui exécute exactement sa création habituelle et renvoie la
 * flotte provisionnée. Tracky ne fait que rattacher.
 *
 * ┌─ SIGNATURE ─────────────────────────────────────────────────────────────────────────────┐
 * │ Même schéma que le garde `InternalHmacGuard` de Manager : `X-App-Id: tracky`,           │
 * │ `X-App-Timestamp` (secondes, ± 5 min), `X-App-Signature` = HMAC-SHA256(secret,           │
 * │ `${timestamp}.${JSON.stringify(body)}`) en hex. Le secret est CELUI DE L'APPLI TRACKY     │
 * │ DANS VIZYO AUTH (`VIZYO_AUTH_APP_SECRET`) : Manager le connaît déjà sous                  │
 * │ `VIZYO_TRACKY_APP_SECRET` — aucun nouveau secret à distribuer, seulement `tracky` à        │
 * │ ajouter à `INTERNAL_ALLOWED_APPS` côté Manager.                                            │
 * └────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ INACTIF TANT QUE `MANAGER_INTERNAL_URL` EST VIDE. L'écran de validation propose alors le
 * secours : ouvrir Manager avec le formulaire prérempli (`urlNouveauClient`), puis rattacher.
 */
export interface CreationClientManager {
  companyName: string;
  email: string;
  contactFirstName: string | null;
  contactLastName: string | null;
  phone: string | null;
  /** Identifiant de la demande Tracky, pour que Manager sache d'où vient le client. */
  externalRef: string;
}

export interface ClientManagerCree {
  clientId: string;
  trackyFleetId: string;
}

@Injectable()
export class ManagerClientService {
  private readonly logger = new Logger(ManagerClientService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** L'appel direct est-il configuré ? Sinon, seul le formulaire prérempli est proposé. */
  estConfigure(): boolean {
    return !!this.baseInterne() && !!this.secret();
  }

  /** Le formulaire « Nouveau client » de Manager, prérempli — le secours quand l'appel direct manque. */
  urlNouveauClient(prefill: { companyName: string; email: string; phone?: string | null }): string {
    const base = String(this.config.get('MANAGER_WEB_URL', { infer: true }) ?? 'https://manager.vizyoagency.com').replace(/\/+$/, '');
    const q = new URLSearchParams({ companyName: prefill.companyName, email: prefill.email, tracky: '1' });
    if (prefill.phone) q.set('phone', prefill.phone);
    return `${base}/admin/clients/new?${q.toString()}`;
  }

  async creerClient(donnees: CreationClientManager): Promise<ClientManagerCree> {
    const base = this.baseInterne();
    const secret = this.secret();
    if (!base || !secret) {
      throw new ServiceUnavailableException(
        "La création directe dans Vizyo Manager n'est pas configurée sur ce serveur (MANAGER_INTERNAL_URL). Créez le client dans Manager, puis rattachez la flotte.",
      );
    }
    const body = {
      companyName: donnees.companyName,
      email: donnees.email,
      notificationEmail: donnees.email,
      contactFirstName: donnees.contactFirstName ?? undefined,
      contactLastName: donnees.contactLastName ?? undefined,
      phone: donnees.phone ?? undefined,
      trackyEnabled: true,
      trackyFleetName: donnees.companyName,
      origin: 'tracky-rdv',
      externalRef: donnees.externalRef,
    };
    const json = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret).update(`${timestamp}.${json}`).digest('hex');

    let reponse: Response;
    try {
      reponse = await fetch(`${base}/internal/clients`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-App-Id': 'tracky',
          'X-App-Timestamp': timestamp,
          'X-App-Signature': signature,
        },
        body: json,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      this.logger.error(`Vizyo Manager injoignable : ${e instanceof Error ? e.message : e}`);
      throw new ServiceUnavailableException('Vizyo Manager ne répond pas. Réessayez, ou créez le client dans Manager puis rattachez la flotte.');
    }
    const corps = (await reponse.json().catch(() => ({}))) as Record<string, unknown>;
    if (!reponse.ok) {
      // Un 400 de la pipe de validation de Manager porte un TABLEAU de messages : on les montre tous.
      const brut = corps['message'];
      const message = typeof brut === 'string' ? brut
        : Array.isArray(brut) && brut.length > 0 ? brut.map(String).join(' ; ')
        : `Vizyo Manager a refusé la création (${reponse.status}).`;
      this.logger.warn(`Création de client refusée par Manager (${reponse.status}) : ${message}`);
      throw new ServiceUnavailableException(message);
    }
    const clientId = corps['clientId'];
    const trackyFleetId = corps['trackyFleetId'];
    if (typeof clientId !== 'string' || typeof trackyFleetId !== 'string' || !trackyFleetId) {
      // Manager a créé le client mais pas la flotte (sa provision a échoué) : on ne rattache rien,
      // et on le dit — jamais de demi-client rattaché à une flotte fantôme.
      throw new ServiceUnavailableException(
        "Vizyo Manager a créé le client mais n'a pas renvoyé de flotte Tracky. Vérifiez le client dans Manager (« Activer Tracky »), puis rattachez la flotte.",
      );
    }
    return { clientId, trackyFleetId };
  }

  private baseInterne(): string | null {
    const brut = this.config.get('MANAGER_INTERNAL_URL', { infer: true }) as string | undefined;
    const valeur = (brut ?? '').trim().replace(/\/+$/, '');
    return valeur.length > 0 ? valeur : null;
  }

  private secret(): string | null {
    const brut = this.config.get('VIZYO_AUTH_APP_SECRET', { infer: true }) as string | undefined;
    return brut && brut.length > 0 ? brut : null;
  }
}
