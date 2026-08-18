import { Injectable, Logger } from '@nestjs/common';
import { candidatsDepuisScan, type TypeIdentifiant } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { UnknownTrackerRegistry } from '../unknown-trackers/unknown-trackers.registry';

/** Statut WhereverSIM « Activée » — une puce qui a déjà ouvert une session réseau. */
const SIM_ACTIVEE = 2;

/**
 * Ce qu'il faut faire ensuite, décidé UNE FOIS ici plutôt qu'éparpillé dans l'interface.
 *
 * L'écran se contente de rendre la voie choisie. Recalculer ce verdict côté client
 * dupliquerait une règle métier dans un endroit qu'aucun test n'atteint.
 */
export type VoieOnboarding =
  | 'deja_rattache'
  | 'rattacher_maintenant'
  | 'attente_tcp'
  | 'provisioning_sms'
  | 'sim_a_activer'
  | 'inconnu';

export interface Demandeur {
  role: string;
  fleetId: string | null;
}

export interface ResolutionIdentifiantDto {
  /** Ce qui a été reconnu dans le code fourni, dans l'ordre tenté. */
  candidats: { type: TypeIdentifiant; valeur: string }[];
  imei: string | null;
  iccid: string | null;
  /** E.164, avec le signe plus — comme l'allowlist et la fiche boîtier. */
  msisdn: string | null;
  simStatutId: number | null;
  simStatutLibelle: string | null;
  /** Boîtier déjà présent en base, le cas échéant. */
  trackerId: string | null;
  vehiculePlaque: string | null;
  flotteNom: string | null;
  /** Voie TCP : ce boîtier frappe-t-il à la porte en ce moment ? */
  frappeEnTcp: boolean;
  vuIlYaSecondes: number | null;
  voie: VoieOnboarding;
  message: string;
}

@Injectable()
export class TrackerOnboardingService {
  private readonly logger = new Logger(TrackerOnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inconnus: UnknownTrackerRegistry,
  ) {}

  /**
   * Résout un code scanné (ou saisi) en une identité de boîtier exploitable.
   *
   * ── LA BASE TRANCHE, PAS LA FORME ────────────────────────────────────────────────
   *
   * Un IMEI et un MSISDN font tous deux quinze chiffres sur ce parc : aucune règle de
   * forme ne peut les départager avec certitude. On interroge donc l'inventaire sur
   * CHAQUE candidat, dans l'ordre de vraisemblance, et le premier qui existe vraiment
   * gagne. Deviner ici rattacherait un boîtier au mauvais véhicule — les positions
   * d'une camionnette atterriraient sur une autre.
   *
   * Le code accepte aussi bien la sortie du lecteur que la saisie manuelle : c'est le
   * même chemin, donc le même comportement, donc les mêmes tests.
   */
  async resoudre(code: string, demandeur: Demandeur): Promise<ResolutionIdentifiantDto> {
    const candidats = candidatsDepuisScan(code);
    const vide = this.reponseVide(candidats);
    if (candidats.length === 0) {
      return { ...vide, message: "Ce code ne ressemble à aucun identifiant connu (IMEI, ICCID ou numéro SIM)." };
    }

    // 1. L'inventaire WhereverSIM, interrogé sur chaque candidat dans l'ordre.
    const puce = await this.chercherPuce(candidats);

    /**
     * 2. L'IMEI.
     *
     * ⚠️ LE REPLI SUR LE CANDIDAT « IMEI » N'EST VALIDE QUE SI AUCUNE PUCE N'A REPONDU.
     *
     * Sur ce parc, un MSISDN fait quinze chiffres comme un IMEI : `candidatsDepuisScan`
     * propose donc les DEUX pour un même code. Si l'inventaire a reconnu ce code comme
     * un numéro, reprendre malgré tout le candidat « imei » reviendrait à traiter les
     * chiffres du téléphone comme un identifiant de boîtier — et à déclarer un boîtier
     * fantôme portant le numéro de la puce. C'est précisément la devinette que toute
     * cette classe s'interdit.
     *
     * Le repli ne sert donc qu'au cas légitime : un code-barré lu sur un boîtier dont la
     * puce n'est pas (ou pas encore) au parc.
     */
    const imei = puce
      ? puce.imei
      : candidats.find((c) => c.type === 'imei')?.valeur ?? null;

    const base: ResolutionIdentifiantDto = {
      ...vide,
      imei,
      iccid: puce?.iccid ?? null,
      msisdn: puce?.msisdn ? this.e164(puce.msisdn) : null,
      simStatutId: puce?.statusId ?? null,
      simStatutLibelle: puce?.statusLabel ?? null,
    };

    if (!imei && !puce) {
      return { ...base, message: 'Aucune puce ni aucun boîtier ne correspond à ce code.' };
    }

    // 3. Ce boîtier est-il déjà en base, et déjà monté sur un véhicule ?
    const tracker = imei
      ? await this.prisma.tracker.findUnique({
          where: { imei },
          select: {
            id: true,
            vehicle: { select: { plate: true, fleetId: true, fleet: { select: { name: true } } } },
          },
        })
      : null;

    /**
     * ⚠️ CLOISONNEMENT. Dire « ce boîtier équipe FZ-862-VY (cdef31) » à l'administrateur
     * d'une AUTRE société lui apprend une plaque et un nom de client qui ne le regardent
     * pas. On confirme l'occupation — il en a besoin pour comprendre le refus — sans
     * nommer qui occupe. Le SUPER_ADMIN, lui, voit tout : c'est son rôle.
     */
    const memeFlotte = tracker?.vehicle?.fleetId === demandeur.fleetId;
    const peutVoirLOccupant = demandeur.role === 'SUPER_ADMIN' || memeFlotte;

    const avecTracker: ResolutionIdentifiantDto = {
      ...base,
      trackerId: tracker?.id ?? null,
      vehiculePlaque: peutVoirLOccupant ? tracker?.vehicle?.plate ?? null : null,
      flotteNom: peutVoirLOccupant ? tracker?.vehicle?.fleet?.name ?? null : null,
    };

    if (tracker?.vehicle) {
      return {
        ...avecTracker,
        voie: 'deja_rattache',
        message: peutVoirLOccupant
          ? `Ce boîtier équipe déjà ${tracker.vehicle.plate}${
              tracker.vehicle.fleet ? ` (${tracker.vehicle.fleet.name})` : ''
            }. Détachez-le avant de le réaffecter.`
          : "Ce boîtier est déjà utilisé par une autre société. Contactez l'assistance pour le libérer.",
      };
    }

    // 4. Voie TCP, la plus rapide : le boîtier frappe-t-il en ce moment ?
    const frappe = imei ? this.inconnus.list().find((e) => e.imei === imei) : undefined;
    const vuIlYaSecondes = frappe
      ? Math.max(0, Math.round((Date.now() - new Date(frappe.lastSeenAt).getTime()) / 1000))
      : null;

    if (frappe) {
      return {
        ...avecTracker,
        frappeEnTcp: true,
        vuIlYaSecondes,
        voie: 'rattacher_maintenant',
        message: `Boîtier en ligne, vu il y a ${vuIlYaSecondes} s. Rattachement immédiat, aucun SMS nécessaire.`,
      };
    }

    // 5. Boîtier déjà déclaré mais silencieux : il sera accepté dès sa prochaine trame.
    if (tracker) {
      return {
        ...avecTracker,
        voie: 'attente_tcp',
        message: 'Boîtier déjà déclaré mais silencieux. On écoute sa prochaine connexion.',
      };
    }

    // 6. On connaît l'IMEI (puce en session, ou code-barré) : on peut déclarer et écouter.
    if (imei) {
      return {
        ...avecTracker,
        voie: 'attente_tcp',
        message: 'Boîtier identifié. Il sera rattaché dès sa première connexion au serveur.',
      };
    }

    /**
     * 7. Une puce sans IMEI n'a JAMAIS ouvert de session réseau — le boîtier n'a donc
     * jamais été alimenté avec elle, ou n'est pas configuré. C'est le seul cas qui
     * justifie de payer une salve de SMS. Et si la puce n'est même pas activée, il
     * faut commencer par là : un SMS vers une puce inactive part dans le vide.
     */
    if (puce && puce.statusId !== SIM_ACTIVEE) {
      return {
        ...avecTracker,
        voie: 'sim_a_activer',
        message: `Cette puce est « ${puce.statusLabel ?? 'non activée'} ». Elle doit être activée avant toute configuration.`,
      };
    }

    return {
      ...avecTracker,
      voie: 'provisioning_sms',
      message: "Puce active mais boîtier jamais vu. Configuration par SMS nécessaire.",
    };
  }

  /** Interroge l'inventaire sur chaque candidat, dans l'ordre, et rend le premier trouvé. */
  private async chercherPuce(candidats: { type: TypeIdentifiant; valeur: string }[]) {
    const colonnes: Record<TypeIdentifiant, 'imei' | 'iccid' | 'msisdn'> = {
      imei: 'imei',
      iccid: 'iccid',
      msisdn: 'msisdn',
    };
    for (const c of candidats) {
      const puce = await this.prisma.sim.findFirst({
        where: { [colonnes[c.type]]: c.valeur },
        select: { iccid: true, msisdn: true, imei: true, statusId: true, statusLabel: true },
      });
      if (puce) return puce;
    }
    return null;
  }

  /** L'inventaire stocke le MSISDN sans le signe plus ; l'app le porte partout ailleurs. */
  private e164(numero: string): string {
    const net = numero.trim().replace(/[\s.-]/g, '');
    return net.startsWith('+') ? net : `+${net}`;
  }

  private reponseVide(candidats: { type: TypeIdentifiant; valeur: string }[]): ResolutionIdentifiantDto {
    return {
      candidats: candidats.map((c) => ({ type: c.type, valeur: c.valeur })),
      imei: null,
      iccid: null,
      msisdn: null,
      simStatutId: null,
      simStatutLibelle: null,
      trackerId: null,
      vehiculePlaque: null,
      flotteNom: null,
      frappeEnTcp: false,
      vuIlYaSecondes: null,
      voie: 'inconnu',
      message: '',
    };
  }
}
