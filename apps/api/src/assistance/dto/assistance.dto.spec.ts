import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { URGENCE_WHATSAPP_RETARD_MAX_S } from '@vizyo/tracky-shared';
import { SignalUrgenceWhatsappBodyDto } from './assistance.dto';

/**
 * ══ L'APPUI SUR LA LIGNE D'URGENCE — CE QUE LE NAVIGATEUR A LE DROIT DE DIRE ═════════════════
 *
 * Ce corps finit LU par un super-admin : dans une notification sur un écran verrouillé, et dans
 * le centre d'activité. Il vient pourtant d'un navigateur, donc de n'importe qui. D'où une règle
 * simple, et ce fichier la tient : aucun texte libre ne traverse. L'écran est pris dans une liste
 * fermée, la plaque n'a que des caractères de plaque, le retard est un entier borné.
 */
describe('SignalUrgenceWhatsappBodyDto — aucun texte libre ne traverse', () => {
  const erreurs = async (corps: Record<string, unknown>): Promise<string[]> =>
    (await validate(plainToInstance(SignalUrgenceWhatsappBodyDto, corps))).map((e) => e.property);

  it('accepte les trois écrans, avec ou sans plaque', async () => {
    for (const ecran of ['assistance', 'vehicules', 'mise-a-jour']) {
      expect(await erreurs({ ecran })).toEqual([]);
      expect(await erreurs({ ecran, plaque: 'GS-187-NY' })).toEqual([]);
    }
  });

  it('🔴 refuse un écran hors liste — le libellé lu par le super-admin ne vient pas du navigateur', async () => {
    expect(await erreurs({ ecran: 'Appelez le 08 99 …' })).toEqual(['ecran']);
    expect(await erreurs({})).toEqual(['ecran']);
  });

  it('🔴 refuse une « plaque » qui porterait autre chose qu’une plaque', async () => {
    expect(await erreurs({ ecran: 'vehicules', plaque: '<b>urgent</b>' })).toEqual(['plaque']);
    expect(await erreurs({ ecran: 'vehicules', plaque: 'AB-123-CD rappelez au 06…' })).toEqual(['plaque']);
    expect(await erreurs({ ecran: 'vehicules', plaque: ' AB-123-CD' })).toEqual(['plaque']);
  });

  it('le retard d’un appui retenu est un entier de secondes, borné à deux heures', async () => {
    expect(await erreurs({ ecran: 'mise-a-jour', retardS: 0 })).toEqual([]);
    expect(await erreurs({ ecran: 'mise-a-jour', retardS: 1800 })).toEqual([]);
    expect(await erreurs({ ecran: 'mise-a-jour', retardS: URGENCE_WHATSAPP_RETARD_MAX_S })).toEqual([]);

    expect(await erreurs({ ecran: 'mise-a-jour', retardS: URGENCE_WHATSAPP_RETARD_MAX_S + 1 })).toEqual(['retardS']);
    expect(await erreurs({ ecran: 'mise-a-jour', retardS: -5 })).toEqual(['retardS']);
    expect(await erreurs({ ecran: 'mise-a-jour', retardS: 12.5 })).toEqual(['retardS']);
    expect(await erreurs({ ecran: 'mise-a-jour', retardS: '1800' })).toEqual(['retardS']);
  });
});
