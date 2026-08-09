import { maskPhone, type DepotMissionDto } from './mission.dto';

describe('maskPhone — le masquage se fait cote serveur', () => {
  it('masque un numero francais', () => {
    expect(maskPhone('0612345647')).toBe('06 12 •• •• 47');
  });

  it('ignore les separateurs', () => {
    expect(maskPhone('06 12 34 56 47')).toBe('06 12 •• •• 47');
  });

  it('normalise l\'E.164 francais — le format REELLEMENT stocke en base', () => {
    // `User.phone` est documente en E.164 dans schema.prisma. Sans normalisation, on
    // afficherait « 33 61 •• •• 47 » : un indicatif pays presente comme un debut de
    // numero, que le depot ne reconnait pas.
    expect(maskPhone('+33612345647')).toBe('06 12 •• •• 47');
    expect(maskPhone('+33 6 12 34 56 47')).toBe('06 12 •• •• 47');
  });

  it('laisse les autres indicatifs tels quels', () => {
    // On ne devine pas les plans de numerotation etrangers : masquer suffit.
    expect(maskPhone('+49301234567')).toBe('49 30 •• •• 67');
  });

  it('rend null pour une valeur absente', () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
    expect(maskPhone('')).toBeNull();
  });

  it('ne laisse jamais passer un numero joignable, meme court', () => {
    expect(maskPhone('12345')).toBe('••');
  });

  it('ne restitue jamais la totalite des chiffres', () => {
    // L'invariant qui compte : quel que soit l'entree, le resultat ne doit pas
    // permettre de reconstituer le numero. On verifie qu'au moins 4 chiffres
    // manquent sur un numero francais standard.
    const source = '0612345647';
    const masque = maskPhone(source)!;
    const chiffresRestants = masque.replace(/\D/g, '');
    expect(chiffresRestants.length).toBeLessThanOrEqual(source.length - 4);
    expect(masque).not.toContain('3456');
  });
});

describe('DepotMissionDto — le contrat de fuite', () => {
  it('n\'expose aucun champ interdit', () => {
    // Ce test est une ASSERTION SUR LES CLES, pas sur les valeurs. Il echoue si
    // quelqu'un ajoute un champ au DTO sans passer par la revue — exactement le
    // critere 12 des tests d'isolation d'A1 § 8.
    const dto: DepotMissionDto = {
      id: 'm-1',
      ref: 'M-2481',
      origin: 'Fenouillet',
      destination: 'Muret',
      startAt: '2026-08-09T08:15:00.000Z',
      endAt: '2026-08-09T11:40:00.000Z',
      status: 'IN_PROGRESS',
      vehicle: { plate: 'FR-482-BX', label: 'Renault D 12 t' },
      driver: { displayName: 'Karim B.', phone: '06 12 •• •• 47' },
      etaAt: '2026-08-09T11:34:00.000Z',
      delayMinutes: null,
      carrierName: 'MH CARS',
    };

    const INTERDITS = [
      'vehicleId',
      'imei',
      'trackerId',
      'fleetId',
      'depotUserId',
      'driverId',
      'cost',
      'score',
      'consumption',
      'groupId',
      'notes',
      'polyline',
      'originPlaceId',
      'destPlaceId',
    ];
    const cles = [...Object.keys(dto), ...Object.keys(dto.vehicle), ...Object.keys(dto.driver!)];
    for (const interdit of INTERDITS) {
      expect(cles).not.toContain(interdit);
    }
  });

  it('le vehicule porte la plaque, jamais un identifiant', () => {
    const vehicule: DepotMissionDto['vehicle'] = { plate: 'FR-482-BX', label: null };
    expect(Object.keys(vehicule).sort()).toEqual(['label', 'plate']);
  });

  it('le conducteur peut etre absent — driver_contact_view non accordee', () => {
    const sansConducteur: Pick<DepotMissionDto, 'driver'> = { driver: null };
    expect(sansConducteur.driver).toBeNull();
  });
});
