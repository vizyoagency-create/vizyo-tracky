import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { AlertsService } from '../alerts/alerts.service';
import type { AuthUser } from '../auth/types/auth-user';
import { NO_FLEET, requiredFleetScope } from '../common/tenant-scope';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Espace depot (2026-08), lot A6 — la grille tarifaire d'une flotte.
 * Cf. docs/A6-DEMANDES-ET-DEVIS.md.
 *
 * ┌─ CE QUI REND CE SERVICE PARTICULIER ──────────────────────────────────────┐
 * │ Il calcule de l'ARGENT, qui part chez le client final d'un client. Trois   │
 * │ consequences sur la maniere dont il est ecrit :                            │
 * │                                                                            │
 * │  1. Tout est en ENTIERS — centimes et metres. Aucun flottant n'entre dans  │
 * │     un calcul de prix : la derive d'arrondi finit en facture contestee.    │
 * │                                                                            │
 * │  2. L'arrondi a lieu UNE SEULE FOIS, a la fin. Arrondir chaque ligne        │
 * │     produit des totaux qui ne retombent pas sur leurs composantes — l'ecart │
 * │     d'un centime qu'un comptable remonte six mois plus tard.                │
 * │                                                                            │
 * │  3. « Sur devis » N'EST PAS ZERO. Une tranche sans prix ne produit aucun    │
 * │     montant : on le dit, on ne l'invente pas. Un devis a 0 EUR envoye a un  │
 * │     client final est pire qu'une absence de devis.                          │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

/** Une tranche telle qu'elle est saisie et rendue. */
export interface TrancheDto {
  /** Rang d'affichage et d'evaluation, a partir de 0. */
  position: number;
  /** Borne basse en km, INCLUSE. Sert l'affichage. */
  fromKm: number;
  /** Borne haute en km, INCLUSE. `null` = derniere tranche, sans limite. */
  toKm: number | null;
  /** Forfait HT en centimes. `null` = « sur devis ». */
  priceCents: number | null;
}

export interface GrilleDto {
  fleetId: string;
  enabled: boolean;
  vatPct: number;
  quoteValidityHours: number;
  extraStopCents: number;
  waitingHourCents: number;
  quoteFooterNote: string | null;
  category: string;
  tiers: TrancheDto[];
  updatedAt: string;
}

export interface GrilleEntree {
  enabled: boolean;
  vatPct: number;
  quoteValidityHours: number;
  extraStopCents: number;
  waitingHourCents: number;
  quoteFooterNote?: string | null;
  category: string;
  tiers: TrancheDto[];
}

/** Ce que repond une demande de tarif. Trois issues, jamais un nombre nu. */
export type ResultatTarif =
  | {
      statut: 'TARIF';
      trancheLibelle: string;
      distanceKm: number;
      htCents: number;
      tvaCents: number;
      ttcCents: number;
      /** Le detail, ligne a ligne, tel qu'il sera fige dans le tour de devis. */
      lignes: Array<{ libelle: string; montantCents: number }>;
    }
  | { statut: 'SUR_DEVIS'; distanceKm: number; motif: string }
  | { statut: 'PAS_DE_GRILLE'; motif: string };

/** La categorie par defaut — une seule prestation chez ce client (arbitrage G). */
const CATEGORIE_DEFAUT = 'Transport de marchandise';

@Injectable()
export class MissionPricingService {
  private readonly logger = new Logger(MissionPricingService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** Arbitrage J : l'absence de grille remonte au centre d'alertes, sans rien bloquer. */
    private readonly alerts: AlertsService,
  ) {}

  /**
   * La grille d'une societe. `null` quand aucune n'existe — un cas NORMAL, pas une
   * erreur : l'appelant affiche alors « aucune grille » et propose d'en creer une.
   */
  async lire(user: AuthUser, fleetIdDemande?: string): Promise<GrilleDto | null> {
    const fleetId = this.porteeLecture(user, fleetIdDemande);
    if (!fleetId) return null; // super-admin sans societe choisie : rien a montrer
    const grille = await this.prisma.missionPricingSettings.findUnique({
      where: { fleetId },
      include: { tiers: { orderBy: { position: 'asc' } } },
    });
    return grille ? this.versDto(grille) : null;
  }

  /**
   * Ecrit la grille — creation ou remplacement complet.
   *
   * Les tranches sont REMPLACEES en bloc, jamais fusionnees ligne a ligne : une
   * grille tarifaire se lit comme un tout, et un remplacement partiel laisserait des
   * tranches orphelines qu'aucun ecran ne montrerait.
   */
  async enregistrer(
    user: AuthUser,
    entree: GrilleEntree,
    fleetIdDemande?: string,
  ): Promise<GrilleDto> {
    const fleetId = this.porteeEcriture(user, fleetIdDemande);
    const tranches = this.validerTranches(entree.tiers);
    this.validerReglages(entree);

    const grille = await this.prisma.$transaction(async (tx) => {
      const enregistrement = await tx.missionPricingSettings.upsert({
        where: { fleetId },
        create: {
          fleetId,
          enabled: entree.enabled,
          vatPct: entree.vatPct,
          quoteValidityHours: entree.quoteValidityHours,
          extraStopCents: entree.extraStopCents,
          waitingHourCents: entree.waitingHourCents,
          quoteFooterNote: entree.quoteFooterNote ?? null,
          updatedByUserId: user.id,
        },
        update: {
          enabled: entree.enabled,
          vatPct: entree.vatPct,
          quoteValidityHours: entree.quoteValidityHours,
          extraStopCents: entree.extraStopCents,
          waitingHourCents: entree.waitingHourCents,
          quoteFooterNote: entree.quoteFooterNote ?? null,
          updatedByUserId: user.id,
        },
      });

      await tx.missionPricingTier.deleteMany({ where: { settingsId: enregistrement.id } });
      await tx.missionPricingTier.createMany({
        data: tranches.map((t) => ({
          settingsId: enregistrement.id,
          category: entree.category || CATEGORIE_DEFAUT,
          position: t.position,
          fromKm: t.fromKm,
          toKm: t.toKm,
          priceCents: t.priceCents,
        })),
      });

      return tx.missionPricingSettings.findUniqueOrThrow({
        where: { id: enregistrement.id },
        include: { tiers: { orderBy: { position: 'asc' } } },
      });
    });

    this.logger.log(
      `Grille tarifaire enregistree pour la flotte ${fleetId} : ${tranches.length} tranche(s), ${entree.enabled ? 'active' : 'inactive'}`,
    );
    return this.versDto(grille);
  }

  /**
   * Le tarif applicable a une distance. C'est le cœur du moteur de devis (T4).
   *
   * ⚠️ LA TRANCHE RETENUE EST LA PREMIERE DONT `toKm` COUVRE LA DISTANCE, et non
   * celle dont l'intervalle [fromKm, toKm] la contient. La grille du client saute de
   * « 0 a 50 » a « 51 a 100 » : un encadrement litteral laisserait 50,4 km SANS
   * TRANCHE, et le devis echouerait sur une distance parfaitement ordinaire.
   * `fromKm` sert l'affichage, `toKm` la decision.
   */
  async tarifPour(fleetId: string, distanceM: number): Promise<ResultatTarif> {
    const grille = await this.prisma.missionPricingSettings.findUnique({
      where: { fleetId },
      include: { tiers: { orderBy: { position: 'asc' } } },
    });

    if (!grille || !grille.enabled || grille.tiers.length === 0) {
      const motif =
        grille && !grille.enabled
          ? 'La grille tarifaire de cette société est désactivée.'
          : 'Aucune grille tarifaire n\'est définie pour cette société.';
      // Arbitrage J — la remontee au centre d'alertes. FIRE-AND-FORGET, et pour deux
      // raisons : ce service calcule de l'argent sur un chemin d'ecran, il ne doit ni
      // ralentir pour ecrire une alerte, ni ECHOUER parce qu'une alerte a echoue. Une
      // demande refusee faute de tarif est une reponse claire ; une demande refusee
      // avec « erreur serveur » parce que la table des alertes etait indisponible
      // n'apprend rien a personne. L'alerte est deduplicee cote AlertsService.
      void this.alerts.createPricingGridMissingAlert(fleetId, motif).catch((err) => {
        this.logger.warn(
          `Alerte « grille absente » non levee pour la flotte ${fleetId} : ${err instanceof Error ? err.message : err}`,
        );
      });
      return { statut: 'PAS_DE_GRILLE', motif };
    }

    // Kilometres arrondis au SUPERIEUR : 50 001 m sont 51 km a facturer. Arrondir au
    // plus proche ferait basculer 50 400 m dans la tranche basse — un cadeau
    // involontaire, et surtout une regle que personne n'a decidee.
    const distanceKm = Math.ceil(distanceM / 1000);

    const tranche = grille.tiers.find((t) => t.toKm === null || distanceKm <= t.toKm);
    if (!tranche) {
      // Ne peut se produire que si la derniere tranche porte un `toKm` fini et que
      // la distance le depasse : la grille ne couvre alors pas tout.
      return {
        statut: 'SUR_DEVIS',
        distanceKm,
        motif: `Aucune tranche ne couvre ${distanceKm} km. Le transporteur établira un prix.`,
      };
    }

    if (tranche.priceCents === null) {
      return {
        statut: 'SUR_DEVIS',
        distanceKm,
        motif: `Au-delà de ${tranche.fromKm} km, le tarif est établi sur devis.`,
      };
    }

    const lignes = [
      {
        libelle: `Transport ${this.libelleTranche(tranche)} — ${distanceKm} km`,
        montantCents: tranche.priceCents,
      },
    ];
    const htCents = lignes.reduce((somme, l) => somme + l.montantCents, 0);
    // Arrondi UNIQUE, ici et nulle part ailleurs.
    const tvaCents = Math.round((htCents * grille.vatPct) / 100);

    return {
      statut: 'TARIF',
      trancheLibelle: this.libelleTranche(tranche),
      distanceKm,
      htCents,
      tvaCents,
      ttcCents: htCents + tvaCents,
      lignes,
    };
  }

  // ═══ VALIDATION ═════════════════════════════════════════════════════════════

  /**
   * Les tranches, verifiees et remises en ordre.
   *
   * Une grille incoherente ne se voit pas a l'ecran — elle se voit sur une facture.
   * On refuse donc a l'ecriture plutot que de laisser le moteur choisir au hasard.
   */
  private validerTranches(tiers: TrancheDto[]): TrancheDto[] {
    if (!Array.isArray(tiers) || tiers.length === 0) {
      throw new BadRequestException('Une grille tarifaire comporte au moins une tranche.');
    }

    const triees = [...tiers].sort((a, b) => a.position - b.position);

    triees.forEach((t, i) => {
      const rang = i + 1;
      if (!Number.isInteger(t.fromKm) || t.fromKm < 0) {
        throw new BadRequestException(`Tranche ${rang} : la borne basse doit être un entier positif.`);
      }
      if (t.toKm !== null && (!Number.isInteger(t.toKm) || t.toKm <= t.fromKm)) {
        throw new BadRequestException(
          `Tranche ${rang} : la borne haute doit être un entier supérieur à la borne basse.`,
        );
      }
      if (t.priceCents !== null && (!Number.isInteger(t.priceCents) || t.priceCents < 0)) {
        throw new BadRequestException(`Tranche ${rang} : le tarif doit être un montant positif.`);
      }
      // Une borne haute ouverte, ou un « sur devis », ne se conçoit qu'en DERNIER :
      // placés au milieu, ils rendraient toutes les tranches suivantes inatteignables.
      const derniere = i === triees.length - 1;
      if (t.toKm === null && !derniere) {
        throw new BadRequestException(
          `Tranche ${rang} : seule la dernière tranche peut être sans borne haute.`,
        );
      }
      if (t.priceCents === null && !derniere) {
        throw new BadRequestException(
          `Tranche ${rang} : seule la dernière tranche peut être « sur devis ».`,
        );
      }
    });

    // Pas de recouvrement : chaque tranche commence après la fin de la précédente.
    for (let i = 1; i < triees.length; i++) {
      const precedente = triees[i - 1];
      if (precedente.toKm !== null && triees[i].fromKm <= precedente.toKm) {
        throw new BadRequestException(
          `Tranches ${i} et ${i + 1} : elles se recouvrent (${triees[i].fromKm} km est déjà couvert jusqu'à ${precedente.toKm} km).`,
        );
      }
    }

    // Renumeroter : la position saisie peut etre trouee si l'utilisateur a supprime
    // une ligne au milieu. On ne stocke jamais une numerotation a trous.
    return triees.map((t, i) => ({ ...t, position: i }));
  }

  private validerReglages(entree: GrilleEntree): void {
    if (!Number.isInteger(entree.vatPct) || entree.vatPct < 0 || entree.vatPct > 100) {
      throw new BadRequestException('La TVA doit être un pourcentage entier entre 0 et 100.');
    }
    if (!Number.isInteger(entree.quoteValidityHours) || entree.quoteValidityHours < 1) {
      throw new BadRequestException('La validité d\'un devis est d\'au moins une heure.');
    }
    for (const [champ, valeur] of [
      ['Le supplément par arrêt', entree.extraStopCents],
      ['Le tarif d\'attente', entree.waitingHourCents],
    ] as const) {
      if (!Number.isInteger(valeur) || valeur < 0) {
        throw new BadRequestException(`${champ} doit être un montant positif.`);
      }
    }
  }

  // ═══ OUTILS ═════════════════════════════════════════════════════════════════

  private libelleTranche(t: { fromKm: number; toKm: number | null }): string {
    return t.toKm === null ? `au-delà de ${t.fromKm} km` : `${t.fromKm} à ${t.toKm} km`;
  }

  private versDto(g: {
    fleetId: string;
    enabled: boolean;
    vatPct: number;
    quoteValidityHours: number;
    extraStopCents: number;
    waitingHourCents: number;
    quoteFooterNote: string | null;
    updatedAt: Date;
    tiers: Array<{ position: number; fromKm: number; toKm: number | null; priceCents: number | null; category: string }>;
  }): GrilleDto {
    return {
      fleetId: g.fleetId,
      enabled: g.enabled,
      vatPct: g.vatPct,
      quoteValidityHours: g.quoteValidityHours,
      extraStopCents: g.extraStopCents,
      waitingHourCents: g.waitingHourCents,
      quoteFooterNote: g.quoteFooterNote,
      category: g.tiers[0]?.category ?? CATEGORIE_DEFAUT,
      tiers: g.tiers.map((t) => ({
        position: t.position,
        fromKm: t.fromKm,
        toKm: t.toKm,
        priceCents: t.priceCents,
      })),
      updatedAt: g.updatedAt.toISOString(),
    };
  }

  /**
   * Portee de LECTURE. `undefined` pour un super-admin sans societe choisie — il n'y
   * a alors aucune grille a montrer, une grille etant par nature celle d'une societe.
   */
  private porteeLecture(user: AuthUser, fleetIdDemande?: string): string | undefined {
    const id = requiredFleetScope(user, fleetIdDemande);
    return id === NO_FLEET ? undefined : id;
  }

  /**
   * Portee d'ECRITURE. Une grille appartient a UNE societe : « toutes » n'a pas de
   * sens. Meme message que le reste du module missions, pour que le super-admin
   * reconnaisse le geste attendu — choisir une societe dans le selecteur.
   */
  private porteeEcriture(user: AuthUser, fleetIdDemande?: string): string {
    const id = requiredFleetScope(user, fleetIdDemande);
    if (!id) {
      throw new BadRequestException(
        'Sélectionnez une société avant de modifier sa grille tarifaire.',
      );
    }
    if (id === NO_FLEET) {
      throw new ForbiddenException('Aucune flotte associée à votre compte.');
    }
    return id;
  }
}
