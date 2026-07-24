import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InstallationEnergy } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

/**
 * ⚠️ ALLOWLIST — la SEULE surface que le partenaire peut écrire (doc 25 §3.3).
 *
 * JAMAIS la plaque (clé de jointure + opérationnelle : commandes SMS, rapports),
 * JAMAIS le kilométrage (fait mesuré par le boîtier), JAMAIS l'opérationnel
 * (tracker, planning, coupure). Étendre cette liste est une décision produit,
 * pas un patch.
 */
const WRITABLE_FIELDS = ['brand', 'model', 'year', 'energy'] as const;
type WritableField = (typeof WRITABLE_FIELDS)[number];

/**
 * L'écriture ENTRANTE du partenaire — la première, et volontairement la plus
 * bornée possible (étape 4, doc 25 §3.3).
 *
 * Elle n'existe que pour UNE opération : le client a tranché un écart en faveur
 * de Maestroo (« Garder Maestroo »), et la valeur choisie doit atterrir ici.
 * Quatre gardes, dans l'ordre :
 *  1. le jeton de bail + le scope vivant `VEHICLE_WRITEBACK` (au contrôleur) ;
 *  2. l'allowlist de champs ci-dessus ;
 *  3. la valeur est revalidée dans NOTRE vocabulaire (une énergie inconnue ne
 *     s'écrit pas) ;
 *  4. CAS : la valeur actuelle doit être celle que le client voyait en
 *     tranchant — sinon l'écart a bougé, on refuse, la synchro re-détectera.
 */
@Injectable()
export class PartnerWritebackService {
  private readonly logger = new Logger(PartnerWritebackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: SystemActivityService,
  ) {}

  async apply(input: {
    fleetId: string;
    linkId: string;
    vehicleId: string;
    field: string;
    value: unknown;
    /** Ce que le client voyait comme valeur Tracky au moment de trancher. */
    expectedValue: unknown;
    /** Id de l'écart côté partenaire — pour l'audit croisé. */
    resolutionId: string;
  }) {
    const field = input.field as WritableField;
    if (!WRITABLE_FIELDS.includes(field)) {
      throw new BadRequestException(`Champ non autorise en ecriture : ${input.field}`);
    }
    const value = castValue(field, input.value);
    const expected = castValue(field, input.expectedValue);

    // ⚠️ Scopé par la FLOTTE du jeton : un partenaire ne peut jamais écrire dans
    // le véhicule d'une autre flotte, même avec un id valide.
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: input.vehicleId, fleetId: input.fleetId },
      select: { id: true, plate: true, brand: true, model: true, year: true, energy: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicule introuvable dans cette flotte');

    const current = vehicle[field] ?? null;

    // Idempotence naturelle : la valeur est déjà là (rejeu, double-clic côté
    // partenaire) — succès sans réécrire, l'audit ne gonfle pas.
    if (current === value) {
      return { status: 'ALREADY_APPLIED' as const, field, value };
    }

    // CAS : la décision du client portait sur `expected`. Si la valeur a bougé
    // entre-temps (corrigée ici même), sa décision porte sur un état disparu.
    if (current !== expected) {
      this.logger.warn(
        `Writeback refuse (CAS) : ${field} de ${vehicle.plate} vaut ${String(current)}, le partenaire attendait ${String(expected)}`,
      );
      throw new ConflictException('La valeur a change depuis la detection de l\'ecart');
    }

    await this.prisma.$transaction([
      this.prisma.vehicle.update({ where: { id: vehicle.id }, data: { [field]: value } }),
      // L'audit du LIEN : visible dans le journal de l'écran Intégrations du
      // client — c'est lui qui a autorisé ce scope, il doit voir chaque usage.
      this.prisma.partnerLinkEvent.create({
        data: {
          linkId: input.linkId,
          action: 'writeback_applied',
          actorType: 'PARTNER',
          scope: 'VEHICLE_WRITEBACK',
          detail: `${vehicle.plate} · ${field} : ${String(current ?? '—')} → ${String(value ?? '—')}`,
        },
      }),
    ]);

    this.activity.record({
      category: 'PARTNER',
      action: 'partner_writeback_applied',
      status: 'SUCCESS',
      actor: 'MAESTROO',
      target: vehicle.plate,
      detail: `${field} : ${String(current ?? '—')} → ${String(value ?? '—')} (resolution ${input.resolutionId})`,
      fleetId: input.fleetId,
    });
    this.logger.log(`Writeback applique : ${vehicle.plate}.${field} (fleet=${input.fleetId})`);

    return { status: 'APPLIED' as const, field, value };
  }
}

/** Revalidation dans NOTRE vocabulaire — le JSON du fil ne fait pas foi. */
function castValue(field: WritableField, raw: unknown): string | number | InstallationEnergy | null {
  if (raw === null || raw === undefined) return null;
  switch (field) {
    case 'brand':
    case 'model': {
      if (typeof raw !== 'string' || raw.length > 80) {
        throw new BadRequestException(`Valeur invalide pour ${field}`);
      }
      return raw.trim() || null;
    }
    case 'year': {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1900 || raw > 2100) {
        throw new BadRequestException('Annee invalide');
      }
      return raw;
    }
    case 'energy': {
      if (typeof raw !== 'string' || !(raw in InstallationEnergy)) {
        throw new BadRequestException('Energie inconnue');
      }
      return raw as InstallationEnergy;
    }
  }
}
