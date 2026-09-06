import { BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ReportsController } from './reports.controller';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * UN RAPPORT SANS SOCIÉTÉ DÉSIGNÉE EST REFUSÉ — IL N'EN INVENTE PLUS UNE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `parseRange` prenait `fleet.findFirst({ orderBy: { createdAt: 'asc' } })` quand un
 * super-administrateur n'avait choisi aucune société : LA PLUS ANCIENNE, en silence.
 *
 * Mesuré en production le 2026-09-06 : `GET /reports/stats` sans `fleetId` rendait 1 838
 * trajets et 38 928 km, sous le nom d'une société que personne n'avait demandée.
 *
 * C'est le pire des trois comportements possibles :
 *   - rendre TOUTES les sociétés mélangées serait faux, mais visiblement faux ;
 *   - refuser est juste ;
 *   - en désigner UNE et l'ÉTIQUETER de son nom est faux ET crédible. Le PDF part chez un
 *     client avec le nom d'un autre en en-tête, et rien ne cloche à la lecture.
 *
 * ⚠️ Le repli PAR VÉHICULE reste, et ces tests le figent : demander l'export d'un véhicule
 * précis désigne sa société sans ambiguïté. C'est le seul cas où l'on peut répondre sans
 * que l'utilisateur ait choisi — et le retirer casserait l'export depuis une fiche véhicule.
 */
describe('ReportsController.parseRange — aucune société ne se choisit toute seule', () => {
  const FROM = '2026-08-01';
  const TO = '2026-09-01';

  function prisma(vehicleFleetId?: string) {
    return {
      fleet: {
        // ⚠️ Le simulacre RÉPOND, exprès. Si le code repartait chercher « la plus ancienne »,
        // il la trouverait — et le test tomberait, ce qui est précisément le but.
        findFirst: jest.fn(async () => ({ id: 'flotte-la-plus-ancienne' })),
      },
      vehicle: {
        findUnique: jest.fn(async () => (vehicleFleetId ? { fleetId: vehicleFleetId } : null)),
      },
    };
  }

  function controleur(vehicleFleetId?: string) {
    const p = prisma(vehicleFleetId);
    // Neuf dépendances ; seule la 7e (prisma) compte pour ce test.
    const ctrl = new ReportsController(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, p as never, {} as never, {} as never,
    );
    return { ctrl, p };
  }

  /** `parseRange` est privée : on l'atteint comme le ferait une route. */
  const parse = (ctrl: ReportsController, user: unknown, fleetIdQ?: string, vehicleIds?: string[]) =>
    (ctrl as unknown as {
      parseRange: (r: unknown, f: string | undefined, a: string, b: string, v?: string[]) => Promise<{ fleetId: string }>;
    }).parseRange({ user }, fleetIdQ, FROM, TO, vehicleIds);

  const superAdmin = { role: UserRole.SUPER_ADMIN, fleetId: null };
  const gestionnaire = { role: UserRole.FLEET_ADMIN, fleetId: 'sa-societe' };

  it('super-admin SANS société : REFUS, et le message nomme le geste à faire', async () => {
    const { ctrl, p } = controleur();

    await expect(parse(ctrl, superAdmin)).rejects.toThrow(BadRequestException);
    await expect(parse(ctrl, superAdmin)).rejects.toThrow(/sélecteur en haut de l’écran|sélecteur en haut de l'écran/);
    // La preuve que le repli est bien mort : on ne va même plus CHERCHER une société.
    expect(p.fleet.findFirst).not.toHaveBeenCalled();
  });

  it('le message dit POURQUOI, pas seulement « fleetId requis »', async () => {
    // Un 400 qui nomme un paramètre d'API n'aide personne devant un écran où ce mot
    // n'apparaît nulle part. Le message doit parler de sociétés et de rapport.
    const { ctrl } = controleur();

    await expect(parse(ctrl, superAdmin)).rejects.toThrow(/société/i);
  });

  it('super-admin AVEC société choisie : elle est retenue', async () => {
    const { ctrl } = controleur();

    await expect(parse(ctrl, superAdmin, 'societe-choisie')).resolves.toMatchObject({
      fleetId: 'societe-choisie',
    });
  });

  it('super-admin sans société MAIS avec un véhicule : la société vient du véhicule', async () => {
    // Le seul repli légitime, et il faut qu'il survive : l'export depuis une fiche véhicule
    // ne passe par aucun sélecteur de société.
    const { ctrl, p } = controleur('societe-du-vehicule');

    await expect(parse(ctrl, superAdmin, undefined, ['veh-1'])).resolves.toMatchObject({
      fleetId: 'societe-du-vehicule',
    });
    expect(p.fleet.findFirst).not.toHaveBeenCalled();
  });

  it('véhicule introuvable : on refuse plutôt que de retomber sur une société au hasard', async () => {
    // `findUnique` rend null (véhicule supprimé, identifiant bricolé). Sans garde, l'ancien
    // code enchaînait sur « la plus ancienne » — un rapport au nom d'un autre client.
    const { ctrl } = controleur(undefined);

    await expect(parse(ctrl, superAdmin, undefined, ['veh-fantome'])).rejects.toThrow(BadRequestException);
  });

  it('gestionnaire de société : sa propre société, sans rien avoir à choisir', async () => {
    // Le cas de l'immense majorité des comptes — il ne doit surtout pas être touché.
    const { ctrl } = controleur();

    await expect(parse(ctrl, gestionnaire)).resolves.toMatchObject({ fleetId: 'sa-societe' });
  });
});
