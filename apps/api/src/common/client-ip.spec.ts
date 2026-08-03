import type { Request } from 'express';
import { clientIp } from './client-ip';

/**
 * ── Ce que ces tests VERROUILLENT (constat du 2026-08-03) ────────────────────────────
 *
 * Six endroits du code lisaient l'adresse du client ainsi :
 *
 *     const first = req.headers['x-forwarded-for'].split(',')[0]?.trim();
 *
 * `X-Forwarded-For` est une LISTE que chaque intermédiaire complète EN AJOUTANT À LA FIN.
 * Sa première entrée est donc celle écrite par le client — un simple en-tête de requête.
 *
 * Il suffisait d'envoyer `X-Forwarded-For: 1.2.3.4` pour que son propre événement de
 * connexion soit enregistré à cette adresse. Ces valeurs alimentent la détection
 * « connexion depuis un lieu inhabituel », la géolocalisation des appareils de confiance
 * et le journal de trafic : trois mécanismes de sécurité qui faisaient confiance à une
 * donnée fournie par la personne qu'ils surveillent.
 */
describe('clientIp — l’adresse que le client ne choisit pas', () => {
  /** Requête minimale : seulement ce que la fonction lit. */
  const req = (over: Partial<Request> = {}): Request =>
    ({ headers: {}, socket: {}, ...over }) as Request;

  it('rend `req.ip`, dérivé de « trust proxy » par Express', () => {
    expect(clientIp(req({ ip: '82.67.153.51' }))).toBe('82.67.153.51');
  });

  it('IGNORE un X-Forwarded-For forgé par le client', () => {
    // ⚠️ LE test de ce module. Avant, cet en-tête l'emportait sur tout le reste : un
    // client pouvait choisir l'adresse enregistrée dans les journaux de sécurité.
    const r = req({
      ip: '82.67.153.51',
      headers: { 'x-forwarded-for': '1.2.3.4' } as Request['headers'],
    });
    expect(clientIp(r)).toBe('82.67.153.51');
    expect(clientIp(r)).not.toBe('1.2.3.4');
  });

  it('IGNORE aussi une liste entière forgée', () => {
    // Un attaquant averti envoie plusieurs entrées pour tromper un parseur naïf.
    const r = req({
      ip: '82.67.153.51',
      headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 7.7.7.7' } as Request['headers'],
    });
    expect(clientIp(r)).toBe('82.67.153.51');
  });

  it('retombe sur l’adresse de la socket si `req.ip` manque', () => {
    // Repli DÉGRADÉ mais non falsifiable : la socket est la connexion TCP réelle.
    const r = req({ ip: undefined, socket: { remoteAddress: '10.0.0.7' } as Request['socket'] });
    expect(clientIp(r)).toBe('10.0.0.7');
  });

  it('rend `null` plutôt qu’une chaîne vide quand rien n’est disponible', () => {
    // `null` se distingue en base et à la lecture ; une chaîne vide passerait pour une
    // adresse enregistrée, et se confondrait avec un vrai relevé.
    expect(clientIp(req({ ip: undefined, socket: {} as Request['socket'] }))).toBeNull();
  });

  it('ne lit JAMAIS l’en-tête, même en l’absence de `req.ip`', () => {
    // Sans cette garantie, il suffirait d'une requête sans `req.ip` pour rouvrir la
    // faille — exactement le repli que l'ancien code appliquait en premier.
    const r = req({
      ip: undefined,
      socket: {} as Request['socket'],
      headers: { 'x-forwarded-for': '1.2.3.4' } as Request['headers'],
    });
    expect(clientIp(r)).toBeNull();
  });
});
