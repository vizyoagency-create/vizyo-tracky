import type { Request } from 'express';

/**
 * ADRESSE IP DU CLIENT — la version qu'il ne peut pas choisir.
 *
 * ══ Pourquoi ce module existe (constat du 2026-08-03) ═════════════════════════════════
 *
 * Six endroits du code lisaient l'adresse ainsi :
 *
 *     const xff = req.headers['x-forwarded-for'];
 *     const first = xff.split(',')[0]?.trim();      // ⚠️ LE PREMIER HOP
 *     return first || req.ip || …;
 *
 * `X-Forwarded-For` est une LISTE que chaque intermédiaire complète en ajoutant à la fin.
 * Sa première entrée est donc celle écrite par le client lui-même — un simple en-tête de
 * requête, qu'il choisit librement.
 *
 * Concrètement, il suffisait d'envoyer `X-Forwarded-For: 1.2.3.4` pour que son propre
 * événement de connexion soit enregistré à cette adresse. Or ces valeurs alimentent la
 * détection « connexion depuis un lieu inhabituel », la géolocalisation des appareils de
 * confiance et le journal de trafic : trois mécanismes de sécurité qui reposaient sur une
 * donnée fournie par la personne qu'ils surveillent.
 *
 * ══ Ce qui rend `req.ip` fiable ═══════════════════════════════════════════════════════
 *
 * Express dérive `req.ip` du réglage `trust proxy`, posé à `1` dans `main.ts` : il ne
 * remonte que d'UN cran et retient l'adresse ajoutée par Traefik — la seule entrée de la
 * liste que le client ne peut pas écrire, puisque c'est le proxy qui l'appose.
 *
 * ⚠️ Ce module DÉPEND donc de ce réglage. Sans lui, `req.ip` vaudrait l'adresse du
 * conteneur Traefik (`::ffff:172.18.0.4` dans les journaux avant correction) : toutes les
 * requêtes se ressembleraient, ce qui est faux mais NON falsifiable. Le repli est donc
 * dégradé, jamais dangereux — contrairement à la lecture du premier hop.
 */
export function clientIp(req: Request): string | null {
  // ⚠️ NE PAS relire `x-forwarded-for` ici. Toute la raison d'être de ce module est de
  // ne plus faire confiance à ce que le client écrit : Express l'a déjà interprété, avec
  // le nombre de proxys de confiance configuré.
  return req.ip ?? req.socket?.remoteAddress ?? null;
}
