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
  /**
   * Lot V6 — SENTINELLES DE COHÉRENCE. Quatre de ces clés sont des PRÉFIXES : la société
   * concernée est suffixée (`…:<fleetId>`), pour qu'une flotte bruyante n'impose pas le
   * silence aux autres. Les deux dernières sont globales — elles décrivent des comptes et
   * un état d'ensemble, pas une société.
   */
  SENTINELLE_EXCES_SANS_ALERTE: 'sentinelle-exces-sans-alerte',
  SENTINELLE_VITESSE_NON_CORROBOREE: 'sentinelle-vitesse-non-corroboree',
  SENTINELLE_LIMITE_INVRAISEMBLABLE: 'sentinelle-limite-invraisemblable',
  SENTINELLE_COUVERTURE_LIMITES: 'sentinelle-couverture-limites',
  SENTINELLE_SANS_APPAREIL: 'sentinelle-destinataire-sans-appareil',
  SENTINELLE_ALERTES_NON_ACQUITTEES: 'sentinelle-alertes-non-acquittees',
  /**
   * TRK-064 — l'angle mort de la sentinelle « excès sans alerte » : la chaîne n'est armée
   * NULLE PART. Clé globale (aucune société n'est concernée, c'est justement le sujet) et
   * rappel hebdomadaire : c'est un état durable, pas une nouvelle du matin.
   */
  SENTINELLE_CHAINE_JAMAIS_ARMEE: 'sentinelle-chaine-vitesse-jamais-armee',
  /**
   * ── LES TROIS GARDES DU BRUIT (2026-09-04) ────────────────────────────────────────
   *
   * « Il ne faut pas spammer les administrateurs, sinon ils désactivent les notifications,
   * et là on est pour les faire réactiver. » C'est le risque le plus cher du produit : un
   * client qui coupe ne se plaint pas, il devient silencieux — et le jour où un SOS part,
   * il ne le reçoit pas non plus. Ces trois clés surveillent notre propre volume.
   *
   * Les deux premières sont préfixées par le compte concerné : un destinataire saturé ne
   * doit pas faire taire l'alerte sur un autre.
   */
  SENTINELLE_DESTINATAIRE_SATURE: 'sentinelle-destinataire-sature',
  SENTINELLE_PLAFOND_HORAIRE: 'sentinelle-plafond-horaire-atteint',
  SENTINELLE_NOTIFICATIONS_COUPEES: 'sentinelle-notifications-coupees',
  /**
   * C3 point 1 (2026-09-05) — repli du routeur IA vers un autre moteur. PRÉFIXE, suffixé
   * `:<moteur>:<sorte>` (`ai-repli:claude:provider_unfunded`) : un compte Anthropic à sec ne
   * doit pas faire taire l'alerte d'un quota OpenAI. Une ligne par 6 h et par épisode.
   */
  AI_REPLI: 'ai-repli',
  /** Le moteur de repli a échoué à son tour — suffixé :<moteur>:<sorte>, 6 h (revue C3). */
  AI_REPLI_ECHEC: 'ai-repli-echec',
  /** Un modèle inconnu de la grille tarifaire — suffixé :<modele>, 7 j (C3 point 4). */
  AI_TARIF_INCONNU: 'tarif-inconnu',
  /** Échec passager de tous les moteurs (quota, saturation, délai, réseau, plafond) — suffixé :<moteur>:<sorte>, 1 h (C3 point 5). */
  AI_ECHEC_PASSAGER: 'ai-echec',
  /** Travail de la file du poste passé en échec définitif — suffixé par l'id du travail, 30 j (chantier C3). */
  TRAVAUX_IA_ECHEC: 'travaux-ia:echec',
  /**
   * PS du chantier C3 (2026-09-05) — sentinelle des agents du poste. PRÉFIXE, suffixé
   * `:<agent>:<motif>` (`agent-local:agent-recit-trajet:manque`) : une ligne par agent, par
   * épisode et par jour (24 h), pour que « PC éteint la nuit » se lise le matin comme cinq
   * lignes — une par agent — et non comme cinq lignes par heure. La clé est OUBLIÉE dès que
   * l'agent repasse avec succès : l'épisode suivant doit crier sans délai.
   */
  AGENT_LOCAL: 'agent-local',
  /**
   * VPS-038 (2026-09-06) — boîtiers rattachés à un véhicule et muets depuis plus de trois
   * jours. PRÉFIXE, suffixé `:<fleetId>:<nombre>`.
   *
   * ⚠️ **Le NOMBRE fait partie de la clé, et ce n'est pas un accident.** Ce constat décrit un
   * état DURABLE — six boîtiers d'une même société se sont tus le 31/08 et l'étaient encore le
   * 06/09, six jours plus tard. Une clé fixe avec un rappel hebdomadaire dirait la même chose
   * tous les sept jours, y compris le jour où un SEPTIÈME se tait : la nouvelle serait noyée
   * dans la répétition. En faisant entrer le compte dans la clé, un effectif qui bouge produit
   * une clé neuve, donc une ligne immédiate ; un effectif stable se tait pour la semaine.
   *
   * C'est la mise en pratique de VPS-M78 : *ne pas comparer les totaux d'un passage à l'autre,
   * comparer ce qui a changé.* Ici, c'est le changement lui-même qui déclenche.
   */
  SENTINELLE_BOITIERS_MUETS: 'sentinelle-boitiers-muets',
} as const;
