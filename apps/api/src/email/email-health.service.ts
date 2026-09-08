import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EmailStatus } from '@prisma/client';
import { DemoModeService } from '../demo/demo-mode.service';
import { ErrorLogger } from '../observability/error-logger.service';
import type { NiveauErreur } from '../observability/niveaux-erreur';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from './email.service';

/**
 * ═══ SENTINELLE DES COURRIELS BLOQUÉS ═══════════════════════════════════════════════════════
 *
 * `EmailLog.status` vaut `QUEUED` dès que Resend accepte l'envoi, et n'avance QUE si le webhook
 * revient. Tout repose donc sur un événement qui, dans un cas précis, ne vient jamais : quand
 * l'adresse est sur la LISTE DE SUPPRESSION du fournisseur. Resend accepte, rend un identifiant,
 * n'envoie rien, et n'émet aucun événement. Pas de rebond, pas de code d'erreur, pas de trace.
 *
 * Mesuré le 2026-09-08 sur la production :
 *   · `admin@cdef31.org`, société cliente active — SEPT rapports hebdomadaires consécutifs non
 *     reçus, du 27/07 au 07/09, tous `QUEUED`, aucun rejet ;
 *   · `admin@vizyoagency.com`, l'adresse d'alerte interne — même état.
 *
 * La seconde explique pourquoi la première a duré sept semaines : le canal censé prévenir était
 * lui-même muet. C'est pourquoi cette sentinelle N'ENVOIE PAS DE COURRIEL. Elle écrit au centre
 * d'alerte, qui se lit dans l'application, et ne dépend donc pas de ce qu'elle surveille.
 */
@Injectable()
export class EmailHealthService {
  private readonly logger = new Logger(EmailHealthService.name);

  /**
   * Au-delà de ce délai, un message accepté mais jamais confirmé est tenu pour bloqué.
   * Vingt-quatre heures : un `delivery_delayed` légitime se résout en quelques heures, et le
   * rapport hebdomadaire doit se signaler le jour même, pas la semaine suivante.
   */
  private static readonly SEUIL_BLOCAGE_MS = 24 * 60 * 60 * 1000;

  /**
   * On ne regarde pas au-delà. Sans cette borne, la sentinelle rouvrirait chaque matin le
   * dossier de messages de juillet que personne ne renverra : du bruit qui ferait perdre à
   * l'alerte le seul mérite qu'elle doit avoir, être lue.
   */
  private static readonly FENETRE_MS = 30 * 24 * 60 * 60 * 1000;

  /** Au-delà, on cesse de lire : la première centaine dit déjà tout ce qu'il y a à dire. */
  private static readonly PLAFOND_LIGNES = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly errorLogger: ErrorLogger,
    // Démonstration : ses invitations restent en file par conception, et personne n'a à en
    // être alerté. Optionnel pour les specs, qui instancient ce service à la main.
    @Optional() private readonly demoMode?: DemoModeService,
  ) {}

  /**
   * Une fois par jour. La panne qu'on cherche se compte en semaines, pas en minutes : un
   * passage quotidien la trouve toujours à temps, et n'ajoute qu'une ligne par adresse fautive.
   */
  @Cron(CronExpression.EVERY_DAY_AT_7AM)
  async verifierCourrielsBloques(maintenant = new Date()): Promise<void> {
    if (this.demoMode?.enabled) return;

    const bloques = await this.prisma.emailLog.findMany({
      where: {
        status: EmailStatus.QUEUED,
        providerId: { not: null },
        createdAt: {
          lt: new Date(maintenant.getTime() - EmailHealthService.SEUIL_BLOCAGE_MS),
          gte: new Date(maintenant.getTime() - EmailHealthService.FENETRE_MS),
        },
      },
      select: { toAddress: true, template: true, providerId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: EmailHealthService.PLAFOND_LIGNES,
    });

    if (bloques.length === 0) {
      // ⚠️ `log` et non `debug` : en production le niveau `debug` n'est pas émis, si bien qu'un
      // passage PROPRE ne laissait aucune trace. Le silence de cette sentinelle devenait alors
      // indistinguable de sa mort — exactement la panne qu'elle existe pour empêcher, d'un cran
      // plus haut. Une ligne par jour, c'est le prix de savoir qu'elle a tourné.
      this.logger.log('Passage effectué : aucun courriel accepté puis jamais confirmé.');
      return;
    }

    // UNE alerte par ADRESSE, pas par message : sept rapports vers la même boîte décrivent un
    // seul problème, et sept lignes identiques le rendraient plus difficile à voir, pas moins.
    const parAdresse = new Map<
      string,
      { nombre: number; modeles: Set<string>; plusAncien: Date; dernierProviderId: string }
    >();
    for (const m of bloques) {
      const entree = parAdresse.get(m.toAddress);
      if (entree) {
        entree.nombre += 1;
        entree.modeles.add(m.template);
        if (m.createdAt < entree.plusAncien) entree.plusAncien = m.createdAt;
      } else {
        parAdresse.set(m.toAddress, {
          nombre: 1,
          modeles: new Set([m.template]),
          // `orderBy` décroissant : le premier vu est le plus récent, donc celui qu'il faut
          // interroger — un identifiant trop vieux peut avoir été purgé chez le fournisseur.
          dernierProviderId: m.providerId!,
          plusAncien: m.createdAt,
        });
      }
    }

    for (const [adresse, e] of parAdresse) {
      const statut = await this.email.statutFournisseur(e.dernierProviderId);
      const jours = Math.floor((maintenant.getTime() - e.plusAncien.getTime()) / 86_400_000);
      const message =
        `${e.nombre} courriel(s) accepté(s) mais jamais confirmé(s) vers ${adresse} ` +
        `— le plus ancien remonte à ${jours} jour(s) — ` +
        `fournisseur : ${statut ?? 'sans réponse'} — modèle(s) : ${[...e.modeles].join(', ')}`;

      this.logger.warn(message);
      await this.errorLogger.record(message, 'email-bloque', {
        toAddress: adresse,
        nombre: e.nombre,
        statutFournisseur: statut,
        templates: [...e.modeles],
      }, this.niveau(statut));
    }
  }

  /**
   * `suppressed` et `bounced` sont des verdicts : le destinataire ne recevra rien, et rien ne
   * changera tant qu'on n'agit pas chez le fournisseur. Le reste peut n'être qu'un retard ou un
   * webhook manqué — anormal, mais pas définitif.
   */
  private niveau(statut: string | null): NiveauErreur {
    return statut === 'suppressed' || statut === 'bounced' ? 'CRITICAL' : 'ERROR';
  }
}
