import { domaineDe } from './reservation-qr-dialog.component';

/**
 * LA CARTE IMPRIMÉE ANNONÇAIT UN DOMAINE QUI N'EXISTE PAS.
 *
 * Relevé le 2026-09-23 en production. Le pied de la carte QR de réservation affichait
 * `tracky.vizyoagency.com` — le défaut de `buildQrCardHtml`, hérité de la carte de déverrouillage —
 * alors que l'application est servie sur `app-tracky.vizyoagency.com`. Le QR encodait bien la
 * bonne URL, donc le scan marchait ; mais la carte est faite pour être IMPRIMÉE et affichée au
 * dépôt, et un conducteur qui ne peut pas scanner retape ce qu'il lit. Il tombait sur un 404.
 *
 * La règle : le domaine imprimé se lit dans le lien, jamais dans une constante.
 */
describe('domaineDe', () => {
  it('lit le domaine dans le lien public', () => {
    expect(domaineDe('https://app-tracky.vizyoagency.com/reserve/abc123')).toBe(
      'app-tracky.vizyoagency.com',
    );
  });

  it('garde le port quand il y en a un — sinon l’adresse retapée ne mène nulle part', () => {
    expect(domaineDe('http://localhost:4200/reserve/abc')).toBe('localhost:4200');
  });

  it('retombe sur le domaine courant plutôt que sur une adresse inventée', () => {
    expect(domaineDe('pas une url', 'app-tracky.vizyoagency.com')).toBe('app-tracky.vizyoagency.com');
    expect(domaineDe('', 'app-tracky.vizyoagency.com')).toBe('app-tracky.vizyoagency.com');
  });

  it('n’invente jamais « tracky.vizyoagency.com »', () => {
    expect(domaineDe('https://app-tracky.vizyoagency.com/reserve/x')).not.toBe('tracky.vizyoagency.com');
    expect(domaineDe('cassé', 'demo-tracky.vizyoagency.com')).not.toBe('tracky.vizyoagency.com');
  });
});
