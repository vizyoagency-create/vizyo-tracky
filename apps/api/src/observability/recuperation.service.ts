import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

  async etat(): Promise<{ lignes: LigneRecuperation[]; mesureLe: string }> {
    const [
      trajets,
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
      this.prisma.trip.count({ where: { endedAt: { not: null } } }),
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

    const reste = (n: number) => (n > 0 ? `${n.toLocaleString('fr-FR')} restant(s)` : null);

    const lignes: LigneRecuperation[] = [
      {
        id: 'analyse',
        famille: 'Trajets',
        libelle: 'Analyse du trajet',
        role: "Distance, durée, arrêts, freinages, score de conduite. Sans elle, un trajet n'est qu'une trace sur la carte.",
        attendu: trajets,
        obtenu: analyses,
        taux: this.taux(analyses, trajets),
        manque: reste(trajets - analyses),
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
