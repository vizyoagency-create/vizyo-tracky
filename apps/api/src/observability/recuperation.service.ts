import { Injectable } from '@nestjs/common';
import { formatFleetDate, parisDayKey, parisDayStart } from '../common/utils/datetime';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ── TRK-016 / T28 (2026-09-13) — « À LA CLÔTURE » SE DÉFINIT PAR LE TEMPS ─────────────────
 *
 * Un trajet clôturé est recalculé par le passage horaire (HH:45), et recalé dans la foulée :
 * au pire, ~70 min après sa fin. Deux heures laissent de la marge. Au-delà, le tracé est venu
 * du rattrapage de l'historique ou d'un rejeu — un travail après coup, qui ne dit rien de ce
 * que la chaîne fait sur un trajet neuf.
 *
 * Défini par le TEMPS et non par le chemin : un trajet recalculé des jours plus tard (arriéré)
 * porterait la signature « cloture » sans l'être. La date, elle, ne ment pas — et c'est elle
 * qui rend le chiffre d'une journée close immuable une fois deux heures passées.
 */
export const DELAI_CLOTURE_MS = 2 * 3_600_000;

/** Ce que la requête sur la journée close rend — des entiers, castés côté SQL. */
interface JourneeClose {
  total: number;
  aLaCloture: number;
  apresCoup: number;
  sansRecalage: number;
  origineInconnue: number;
}

/**
 * Ce que nos services d'enrichissement ont RÉELLEMENT récupéré — trajets et lieux.
 *
 * ── POURQUOI CET ÉCRAN EXISTE ────────────────────────────────────────────────────────
 *
 * L'application enrichit les trajets par plusieurs couches indépendantes : analyse
 * déterministe, limites de vitesse OpenStreetMap, consommation, récit, station-service,
 * géocodage, lieux de flotte. Chacune peut échouer en silence, et rien ne le montrait.
 *
 * Ce que ça a coûté : pendant des semaines, 98,8 % du cache des limites de vitesse était
 * marqué « inconnu » à tort. Conséquence, les trois quarts des trajets ne pouvaient
 * mathématiquement porter aucun excès de vitesse, et le score de conduite moyen affichait
 * 93,4/100 — un chiffre qui ne mesurait rien. Personne ne pouvait le voir, parce qu'aucun
 * écran ne comparait « ce qu'on aurait dû enrichir » à « ce qu'on a enrichi ».
 *
 * ── LA RÈGLE DE CET ÉCRAN ────────────────────────────────────────────────────────────
 *
 * ⚠️ ON COMPTE, ON N'ESTIME PAS. Chaque ligne est une paire de `count()` sur la base : un
 *    dénominateur (ce qui était éligible) et un numérateur (ce qui a abouti). Aucune moyenne,
 *    aucune extrapolation, aucun ratio calculé sur un échantillon. Un écran de contrôle qui
 *    arrondit finit par rassurer à tort — c'est précisément ce qu'on répare.
 *
 * Une couche sans dénominateur connu (les lieux de flotte sont saisis à la main, il n'existe
 * pas de « nombre attendu ») affiche son volume sans pourcentage, plutôt qu'un taux inventé.
 */

export interface LigneRecuperation {
  id: string;
  /** Regroupement d'affichage. */
  famille: 'Trajets' | 'Lieux';
  libelle: string;
  /** Ce que la couche apporte, et ce qu'on perd sans elle. */
  role: string;
  /** Éligibles. `null` quand la notion n'a pas de sens (saisie manuelle). */
  attendu: number | null;
  /** Effectivement enrichis. */
  obtenu: number;
  /** 0..100, ou null si `attendu` est inconnu. */
  taux: number | null;
  /** Ce qui manque encore, formulé en clair. */
  manque: string | null;
}

@Injectable()
export class RecuperationService {
  constructor(private readonly prisma: PrismaService) {}

  private taux(obtenu: number, attendu: number | null): number | null {
    if (attendu === null || attendu === 0) return null;
    return Math.round((1000 * obtenu) / attendu) / 10;
  }

  /** T28 — ce qui n'a pas été recalé à la clôture, part par part : la réponse à « pourquoi pas 100 ? ». */
  private manqueCloture(j: JourneeClose): string | null {
    const parts: string[] = [];
    if (j.apresCoup > 0) parts.push(`${j.apresCoup.toLocaleString('fr-FR')} recalé(s) après coup`);
    if (j.sansRecalage > 0) parts.push(`${j.sansRecalage.toLocaleString('fr-FR')} sans tracé recalé`);
    if (j.origineInconnue > 0) parts.push(`${j.origineInconnue.toLocaleString('fr-FR')} d’origine inconnue (recalé(s) avant le 13/09)`);
    return parts.length > 0 ? parts.join(' · ') : null;
  }

  async etat(maintenant = new Date()): Promise<{ lignes: LigneRecuperation[]; mesureLe: string }> {
    /**
     * ⚠️ LE DÉNOMINATEUR HONNÊTE EXCLUT L'IMPOSSIBLE.
     *
     * Les positions sont purgées au-delà de 60 jours (`POSITIONS_RETENTION_DAYS`). Un trajet plus
     * ancien n'a plus AUCUN point : il ne peut pas être analysé, et le forcer produirait une
     * analyse vide — distance nulle, aucun arrêt — indiscernable d'un vrai trajet immobile.
     *
     * Relevé du 2026-08-19 : 2 691 trajets dans ce cas, tous antérieurs au 18/06. Les compter
     * comme « à rattraper » affichait un objectif inatteignable et un taux faussement bas. On les
     * sort du dénominateur, et on les montre sur une ligne à part qui dit pourquoi.
     */
    const limiteRetention = new Date(Date.now() - 60 * 86_400_000);

    const [
      trajets,
      trajetsHorsRetention,
      analyses,
      avecLimites,
      avecRecit,
      avecCarburant,
      lieux,
      arretsCarburant,
      geocodages,
      cacheTotal,
      cacheResolu,
    ] = await Promise.all([
      this.prisma.trip.count({ where: { endedAt: { not: null }, startedAt: { gte: limiteRetention } } }),
      this.prisma.trip.count({ where: { endedAt: { not: null }, startedAt: { lt: limiteRetention } } }),
      this.prisma.tripAnalysis.count(),
      this.prisma.tripAnalysis.count({ where: { limitsKnown: true } }),
      this.prisma.tripAnalysis.count({ where: { narrative: { not: null } } }),
      this.prisma.tripAnalysis.count({ where: { fuelLiters: { not: null } } }),
      this.prisma.fleetPlace.count(),
      this.prisma.tripFuelStop.count(),
      this.prisma.geocodeCache.count(),
      this.prisma.speedLimitCache.count(),
      this.prisma.speedLimitCache.count({ where: { maxspeed: { not: null } } }),
    ]);

    /**
     * ── T28 — LE RECALAGE, EN DEUX GRANDEURS QUI NE SE MÉLANGENT PLUS ─────────────────────
     *
     * 1. La QUALITÉ À LA CLÔTURE, sur la journée CLOSE d'hier (minuit à minuit, heure de Paris) :
     *    parmi les trajets clôturés ce jour-là, combien portaient un tracé recalé dans les deux
     *    heures. Une journée close ne bouge plus : la re-mesurer demain rend le même chiffre.
     *    C'est la propriété qui manquait — le taux glissant se réécrivait chaque nuit.
     * 2. L'AVANCEMENT DU RATTRAPAGE : ce qu'il a recalé sur ce qu'il avait à faire. Compté
     *    depuis le 13/09, jour où les tracés ont commencé à porter leur origine.
     *
     * La première demande de comparer deux colonnes (date du recalage contre date de clôture),
     * ce que Prisma ne sait pas écrire : une requête brute, bornée par les deux instants.
     */
    const cleAujourdhui = parisDayKey(maintenant);
    const finHier = parisDayStart(cleAujourdhui);
    const debutHier = parisDayStart(parisDayKey(new Date(finHier.getTime() - 1)));
    const [journee] = await this.prisma.$queryRaw<JourneeClose[]>`
      SELECT
        count(*)::int AS "total",
        count(*) FILTER (WHERE "polylineMatchedAt" IS NOT NULL
                           AND "polylineMatchedAt" <= "endedAt" + (${DELAI_CLOTURE_MS / 1000} * interval '1 second'))::int AS "aLaCloture",
        count(*) FILTER (WHERE "polylineMatchedAt" IS NOT NULL
                           AND "polylineMatchedAt" >  "endedAt" + (${DELAI_CLOTURE_MS / 1000} * interval '1 second'))::int AS "apresCoup",
        count(*) FILTER (WHERE "polylineMatched" IS NULL)::int AS "sansRecalage",
        count(*) FILTER (WHERE "polylineMatched" IS NOT NULL AND "polylineMatchedAt" IS NULL)::int AS "origineInconnue"
      FROM "trips"
      WHERE "endedAt" >= ${debutHier} AND "endedAt" < ${finHier} AND "polyline" IS NOT NULL
    `;
    const hier = journee ?? { total: 0, aLaCloture: 0, apresCoup: 0, sansRecalage: 0, origineInconnue: 0 };
    const [rattrapes, resteARecaler] = await Promise.all([
      this.prisma.trip.count({ where: { polylineMatchedSource: 'rattrapage' } }),
      this.prisma.trip.count({ where: { polylineMatched: null, polyline: { not: null }, endedAt: { not: null } } }),
    ]);

    const reste = (n: number) => (n > 0 ? `${n.toLocaleString('fr-FR')} restant(s)` : null);

    const lignes: LigneRecuperation[] = [
      {
        id: 'analyse',
        famille: 'Trajets',
        libelle: 'Analyse du trajet',
        role: "Distance, durée, arrêts, freinages, score de conduite. Sans elle, un trajet n'est qu'une trace sur la carte. Compté sur les trajets ENCORE ANALYSABLES, c'est-à-dire dont les positions n'ont pas été purgées.",
        attendu: trajets,
        obtenu: Math.min(analyses, trajets),
        taux: this.taux(Math.min(analyses, trajets), trajets),
        manque: reste(Math.max(0, trajets - analyses)),
      },
      {
        id: 'hors-retention',
        famille: 'Trajets',
        libelle: 'Trajets définitivement inanalysables',
        role: "Leurs positions ont été purgées au-delà de 60 jours (POSITIONS_RETENTION_DAYS). Sans points, une analyse serait vide — distance nulle, aucun arrêt — et indiscernable d'un vrai trajet immobile. On préfère l'absence à une donnée fausse.",
        attendu: null,
        obtenu: trajetsHorsRetention,
        taux: null,
        manque: null,
      },
      {
        id: 'limites',
        famille: 'Trajets',
        libelle: 'Limites de vitesse (OpenStreetMap)',
        role: "Transforme « il roulait vite » en excès CERTAIN. Sans elle, aucun excès n'est calculable et le score de conduite ne mesure rien.",
        attendu: analyses,
        obtenu: avecLimites,
        taux: this.taux(avecLimites, analyses),
        manque: reste(analyses - avecLimites),
      },
      {
        id: 'carburant',
        famille: 'Trajets',
        libelle: 'Consommation estimée',
        role: 'Litres et CO2 par trajet, à partir du profil du véhicule.',
        attendu: analyses,
        obtenu: avecCarburant,
        taux: this.taux(avecCarburant, analyses),
        manque: reste(analyses - avecCarburant),
      },
      {
        id: 'recit',
        famille: 'Trajets',
        libelle: 'Récit rédigé (IA)',
        role: "Résumé en clair du trajet. Couche facultative et payante : son absence ne fausse aucun chiffre.",
        attendu: analyses,
        obtenu: avecRecit,
        taux: this.taux(avecRecit, analyses),
        manque: reste(analyses - avecRecit),
      },
      {
        id: 'recalage-cloture',
        famille: 'Trajets',
        libelle: `Tracé recalé à la clôture — journée du ${formatFleetDate(debutHier)}`,
        role:
          "Un trajet clôturé doit suivre la route dans les deux heures : le passage horaire le recalcule et le recale. " +
          "Mesuré sur la journée close d'hier, minuit à minuit en heure de Paris — ce chiffre ne bouge plus. " +
          "Ce qui est recalé plus tard compte « après coup » : c'est le travail du rattrapage, pas celui de la clôture, " +
          "et le mélanger avec elle réécrivait le passé chaque nuit.",
        attendu: hier.total,
        obtenu: hier.aLaCloture,
        taux: this.taux(hier.aLaCloture, hier.total),
        manque: this.manqueCloture(hier),
      },
      {
        id: 'recalage-rattrapage',
        famille: 'Trajets',
        libelle: 'Rattrapage des tracés (historique)',
        role:
          "Quinze tracés d'historique par passage horaire, en fin de course, tant qu'il en reste. " +
          "Compté depuis le 13/09, jour où les tracés ont commencé à porter leur origine : ceux recalés avant " +
          "ne sont ni dans l'obtenu ni dans le reste. Une autre grandeur que la clôture, exprès.",
        attendu: rattrapes + resteARecaler,
        obtenu: rattrapes,
        taux: this.taux(rattrapes, rattrapes + resteARecaler),
        manque: reste(resteARecaler),
      },
      {
        id: 'portions',
        famille: 'Lieux',
        libelle: 'Portions de route résolues',
        role: "Chaque portion parcourue, avec sa limite légale. C'est le socle des excès de vitesse.",
        attendu: cacheTotal,
        obtenu: cacheResolu,
        taux: this.taux(cacheResolu, cacheTotal),
        manque: reste(cacheTotal - cacheResolu),
      },
      {
        id: 'stations',
        famille: 'Lieux',
        libelle: 'Passages en station-service',
        role: 'Arrêts rapprochés d\'une station connue, avec le prix du carburant du jour.',
        attendu: null,
        obtenu: arretsCarburant,
        taux: null,
        manque: null,
      },
      {
        id: 'geocodage',
        famille: 'Lieux',
        libelle: 'Adresses géocodées',
        role: "Nomme un point en clair (« Carcassonne ») au lieu d'une paire de coordonnées.",
        attendu: null,
        obtenu: geocodages,
        taux: null,
        manque: null,
      },
      {
        id: 'lieux-flotte',
        famille: 'Lieux',
        libelle: 'Lieux de flotte déclarés',
        role: "Dépôts, chantiers, parkings. Saisis à la main : il n'existe pas de « nombre attendu », d'où l'absence de taux.",
        attendu: null,
        obtenu: lieux,
        taux: null,
        manque: null,
      },
    ];

    return { lignes, mesureLe: new Date().toISOString() };
  }
}
