import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * REFROIDISSEMENTS D'ALERTE — « depuis quand n'a-t-on pas crié ? »  (TRK-038)
 *
 * ══ Le défaut d'origine ═══════════════════════════════════════════════════════════════
 *
 * Quatre gardes anti-répétition vivaient dans un **champ d'instance** d'un service
 * `@Injectable()` singleton. Ils n'étaient pas cassés — ils étaient **volatils** : leur seul
 * moyen de retomber à zéro était le redémarrage du processus.
 *
 * Mesuré le 20/08 sur `speed-limit` : garde de 6 h, et pourtant des lignes espacées de 5 h 00,
 * 3 h 59, 1 h 57, 1 h 03. Trois de ces quatre intervalles tombent juste après une remise en
 * service. L'intervalle de 6 h 02 prouve, lui, que la garde fait son travail quand le processus
 * vit.
 *
 * ⚠️ **Le cas le plus embarrassant est la vigie de saturation** : l'instrument chargé de crier
 * quand les erreurs flambent portait son propre anti-flambée en mémoire — donc réarmé par le
 * déploiement, qui est précisément le moment où les erreurs flambent.
 *
 * ══ Pourquoi une table dédiée, et surtout PAS `error_logs` ════════════════════════════
 *
 * Le correctif écrit le 21/08 proposait de tirer la dernière émission de la **donnée** —
 * `SELECT max("createdAt") FROM error_logs WHERE …`. Le principe est juste ; la table choisie
 * ne l'était pas.
 *
 * 🔑 **Mesuré le 22/08 sur [TRK-039]** : l'agent qualité GPS range sa mémoire d'anti-répétition
 * dans `error_logs`. La ligne témoin du 20/08 a été supprimée par l'effaceur de TRK-035, la
 * requête a rendu une liste vide, et l'agent a réémis **deux jours après au lieu de sept**. Le
 * délai fonctionnait exactement comme écrit : on lui avait retiré ce sur quoi il comptait.
 *
 * *Un garde-fou ne doit pas ranger sa mémoire dans la pièce qu'il surveille.* D'où cette table,
 * qui n'est ni `error_logs`, ni `alerts`, ni surveillée par les déclencheurs de disparition.
 *
 * ══ En cas de panne, on ÉMET ═════════════════════════════════════════════════════════
 *
 * Si la base est injoignable, `tenterEmission` rend `true`. Un doublon d'alerte se voit et
 * s'ignore ; une alerte manquée ne se voit pas. C'est le même arbitrage que celui déjà écrit
 * pour l'alarme d'alimentation — devant l'incertitude, le silence est le mauvais défaut.
 */
@Injectable()
export class RefroidissementAlerteService {
  private readonly logger = new Logger(RefroidissementAlerteService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Demande le droit d'émettre, et le consomme dans la MÊME instruction.
   *
   * ⚠️ L'atomicité n'est pas décorative : un `SELECT` puis un `UPDATE` laisserait deux passages
   * concurrents franchir la garde ensemble. Ici, `ON CONFLICT … WHERE` ne met à jour la ligne
   * que si le délai est écoulé, et `RETURNING` ne rend quelque chose **que** dans ce cas.
   *
   * À n'utiliser que lorsque émettre ne peut pas échouer. Quand l'émission peut échouer (un
   * e-mail, par exemple), employer `derniereEmission` + `marquerEmission` : poser le
   * refroidissement avant de savoir si le message est parti rendrait muet pour rien.
   */
  async tenterEmission(cle: string, fenetreMs: number): Promise<boolean> {
    try {
      const lignes = await this.prisma.$queryRaw<Array<{ cle: string }>>`
        INSERT INTO refroidissements_alerte ("cle", "derniereEmissionAt", "emissions", "createdAt", "updatedAt")
        VALUES (${cle}, now(), 1, now(), now())
        ON CONFLICT ("cle") DO UPDATE
          SET "derniereEmissionAt" = now(),
              "emissions" = refroidissements_alerte."emissions" + 1,
              "updatedAt" = now()
          WHERE refroidissements_alerte."derniereEmissionAt"
                <= now() - make_interval(secs => ${fenetreMs / 1000}::double precision)
        RETURNING "cle";`;
      return lignes.length > 0;
    } catch (e) {
      this.logger.error(
        `Refroidissement « ${cle} » illisible (${e instanceof Error ? e.message : String(e)}) — on ÉMET.`,
      );
      return true;
    }
  }

  /** Quand l'émission a-t-elle eu lieu pour la dernière fois ? `null` = jamais. */
  async derniereEmission(cle: string): Promise<Date | null> {
    try {
      const r = await this.prisma.refroidissementAlerte.findUnique({
        where: { cle },
        select: { derniereEmissionAt: true },
      });
      return r?.derniereEmissionAt ?? null;
    } catch (e) {
      this.logger.error(
        `Refroidissement « ${cle} » illisible (${e instanceof Error ? e.message : String(e)}) — on ÉMET.`,
      );
      return null;
    }
  }

  /**
   * Pose le refroidissement. À appeler APRÈS une émission réellement partie.
   *
   * ⚠️ `quand` n'est pas un confort de test : un appelant qui raisonne sur un instant explicite
   * (la vigie de saturation reçoit son `now` en argument) doit pouvoir le transmettre. Sans ça,
   * deux horloges coexistent — celle du raisonnement et celle de l'écriture — et le garde
   * compare des grandeurs qui ne viennent pas du même endroit.
   */
  async marquerEmission(cle: string, quand: Date = new Date()): Promise<void> {
    try {
      await this.prisma.refroidissementAlerte.upsert({
        where: { cle },
        create: { cle, derniereEmissionAt: quand, emissions: 1 },
        update: { derniereEmissionAt: quand, emissions: { increment: 1 }, updatedAt: new Date() },
      });
    } catch (e) {
      // Ne jamais faire échouer l'action métier pour un compteur : au pire on réémettra.
      this.logger.error(`Refroidissement « ${cle} » non posé : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Oublie le refroidissement — la prochaine émission repartira sans délai.
   *
   * Employé quand un ÉPISODE se referme : ce qui reprendra ensuite est un fait nouveau, et le
   * faire taire au motif qu'on a crié pendant l'épisode précédent serait faux.
   */
  async oublier(cle: string): Promise<void> {
    try {
      await this.prisma.refroidissementAlerte.deleteMany({ where: { cle } });
    } catch (e) {
      this.logger.error(`Refroidissement « ${cle} » non oublié : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Les clés, réunies ici pour qu'on voie d'un coup d'œil qui possède un refroidissement.
 *
 * ⚠️ Une clé est un identifiant PERSISTANT : la renommer revient à remettre le garde à zéro,
 * silencieusement, une fois.
 */
export const CLES_REFROIDISSEMENT = {
  /** Overpass injoignable — une ligne au centre d'alerte, pas une par trajet analysé. */
  SPEED_LIMIT_OSM: 'speed-limit-osm',
  /** Vigie de saturation du centre d'alerte : un e-mail par heure au plus. */
  VIGIE_SATURATION: 'error-rate-watchdog',
  /** Trou d'allowlist SMS : rappel périodique tant que l'épisode dure. */
  ALLOWLIST_EPISODE: 'sms-allowlist-episode',
  /**
   * TRK-025 — suppressions de masse retenues par la passerelle. Un épisode d'effacement
   * se compte en dizaines de tentatives horaires (49 entre le 10 et le 17/08) : une ligne
   * par tentative répéterait quarante-neuf fois le même fait. Une alerte à la première,
   * puis un rappel quotidien tant que ça dure — la cadence déjà retenue pour cette source.
   */
  ALLOWLIST_SUPPRESSIONS_BLOQUEES: 'sms-allowlist-removals-blocked',
  /** Résumé des profils de surveillance dormants (journal d'exploitation). */
  SURVEILLANCE_DORMANTS: 'surveillance-dormants',
} as const;
