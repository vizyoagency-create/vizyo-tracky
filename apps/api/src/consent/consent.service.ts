import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CONSENT_DOC_TYPES, CONSENT_VERSION } from './consent.constants';

/**
 * Consentements RGPD. Deux surfaces :
 *  - Utilisateurs de l'app : acceptation CGU + Confidentialité, versionnée, avec
 *    IP + userAgent (preuve CNIL). Le gate d'accès exige la version courante.
 *  - Visiteurs LP : choix accepter/refuser du bandeau, anonyme, avec IP.
 *
 * Cache mémoire des users à jour : le gate tourne à chaque requête ; sans cache ce
 * serait un SELECT par requête. Un user consentant est mis en cache pour la durée du
 * process (le consentement d'une version ne « se retire » pas — un bump de version
 * = nouveau déploiement = process neuf = cache vide → re-check).
 */
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);
  private readonly consented = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  isCached(userId: string): boolean {
    return this.consented.has(userId);
  }

  /** true si l'utilisateur a accepté CGU ET PRIVACY à la version courante. */
  async hasCurrentConsent(userId: string): Promise<boolean> {
    if (this.consented.has(userId)) return true;
    const rows = await this.prisma.userConsent.findMany({
      where: { userId, version: CONSENT_VERSION, accepted: true },
      select: { docType: true },
    });
    const types = new Set(rows.map((r) => r.docType));
    const ok = CONSENT_DOC_TYPES.every((t) => types.has(t));
    if (ok) this.consented.add(userId);
    return ok;
  }

  /** Statut détaillé (pour l'écran de gate côté front). */
  async status(
    userId: string,
  ): Promise<{ version: string; cgu: boolean; privacy: boolean; required: boolean }> {
    const rows = await this.prisma.userConsent.findMany({
      where: { userId, version: CONSENT_VERSION, accepted: true },
      select: { docType: true },
    });
    const types = new Set(rows.map((r) => r.docType));
    const cgu = types.has('CGU');
    const privacy = types.has('PRIVACY');
    return { version: CONSENT_VERSION, cgu, privacy, required: !(cgu && privacy) };
  }

  /** Enregistre l'acceptation CGU + Confidentialité à la version courante (idempotent). */
  async acceptCurrent(
    userId: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ version: string }> {
    const existing = await this.prisma.userConsent.findMany({
      where: { userId, version: CONSENT_VERSION, accepted: true },
      select: { docType: true },
    });
    const have = new Set(existing.map((r) => r.docType));
    const data = CONSENT_DOC_TYPES.filter((t) => !have.has(t)).map((docType) => ({
      userId,
      docType,
      version: CONSENT_VERSION,
      accepted: true,
      ip,
      userAgent: userAgent ? userAgent.slice(0, 400) : null,
    }));
    if (data.length) await this.prisma.userConsent.createMany({ data });
    this.consented.add(userId);
    return { version: CONSENT_VERSION };
  }

  /** Enregistre le choix de consentement d'un VISITEUR LP (anonyme, avec IP). */
  async recordLp(input: {
    choice: string;
    sessionId?: string | null;
    categories?: unknown;
    ip: string | null;
    userAgent: string | null;
    page?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.lpConsent.create({
        data: {
          choice: input.choice === 'granted' ? 'granted' : 'denied',
          sessionId: input.sessionId ? input.sessionId.slice(0, 64) : null,
          categories:
            input.categories == null ? undefined : (input.categories as Prisma.InputJsonValue),
          ip: input.ip,
          userAgent: input.userAgent ? input.userAgent.slice(0, 400) : null,
          page: input.page ? input.page.slice(0, 120) : null,
        },
      });
    } catch (e) {
      this.logger.warn(`recordLp a échoué: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
