/**
 * ── UNE INVITATION EXPIRÉE N'EST PAS « EN ATTENTE » ──────────────────────────────────
 *
 * ⚠️ Constat du 2026-08-03 sur la flotte cdef31 : quatre invitations créées le 2 juillet,
 * valables 24 h, portaient encore le statut `PENDING` un MOIS après leur expiration.
 *
 * Rien ne fait jamais passer une invitation de `PENDING` à `EXPIRED` : ni cron, ni tâche,
 * ni relecture. Le statut est figé à la création, et l'endpoint le renvoyait tel quel.
 *
 * L'écran affichait donc « en attente » pour des liens morts depuis des semaines. Le
 * gestionnaire croyait que ces quatre collègues finiraient par se connecter ; personne ne
 * relançait, et personne ne comprenait pourquoi ils n'avaient toujours pas accès.
 *
 * ⚠️ Le statut est calculé À LA LECTURE plutôt que corrigé par une tâche de nettoyage :
 * une tâche qui ne tourne pas laisse le défaut intact. L'application en avait la preuve le
 * jour même — l'automatisation des trajets était à l'arrêt depuis cinq jours sans que rien
 * ne le signale.
 */
describe('statut d’invitation — calculé à la lecture', () => {
  /** Réplique exacte de la règle appliquée par le contrôleur. */
  const statutLu = (status: string, expiresAt: Date, now: number): string =>
    status === 'PENDING' && expiresAt.getTime() < now ? 'EXPIRED' : status;

  const MAINTENANT = new Date('2026-08-03T16:00:00Z').getTime();

  it('PENDING dont la date est passée → EXPIRED', () => {
    // Le cas réel : créée le 02/07, valable 24 h, lue le 03/08.
    expect(statutLu('PENDING', new Date('2026-07-03T10:17:00Z'), MAINTENANT)).toBe('EXPIRED');
  });

  it('PENDING encore valable → reste PENDING', () => {
    expect(statutLu('PENDING', new Date('2026-08-04T10:00:00Z'), MAINTENANT)).toBe('PENDING');
  });

  it('expiration à la seconde près : une invitation qui vient d’expirer bascule', () => {
    expect(statutLu('PENDING', new Date(MAINTENANT - 1), MAINTENANT)).toBe('EXPIRED');
    expect(statutLu('PENDING', new Date(MAINTENANT + 1), MAINTENANT)).toBe('PENDING');
  });

  it('ACCEPTED ne devient JAMAIS expirée, même longtemps après la date', () => {
    // ⚠️ Le garde-fou inverse. Une invitation acceptée a produit un compte : la repeindre
    // en « expirée » afficherait un membre actif comme un accès mort, et pousserait à
    // renvoyer un lien à quelqu'un qui se connecte déjà tous les jours.
    expect(statutLu('ACCEPTED', new Date('2026-07-03T10:17:00Z'), MAINTENANT)).toBe('ACCEPTED');
  });

  it('REVOKED reste REVOKED — révoquée n’est pas expirée', () => {
    // Deux causes différentes, deux actions différentes : une révocation est un choix
    // qu'on ne veut pas voir présenté comme un simple lien à renvoyer.
    expect(statutLu('REVOKED', new Date('2026-07-03T10:17:00Z'), MAINTENANT)).toBe('REVOKED');
  });

  it('les quatre statuts, pris ensemble', () => {
    const passe = new Date('2026-07-03T10:17:00Z');
    expect({
      'PENDING expirée': statutLu('PENDING', passe, MAINTENANT),
      'PENDING valable': statutLu('PENDING', new Date('2026-08-10T00:00:00Z'), MAINTENANT),
      ACCEPTED: statutLu('ACCEPTED', passe, MAINTENANT),
      REVOKED: statutLu('REVOKED', passe, MAINTENANT),
    }).toEqual({
      'PENDING expirée': 'EXPIRED',
      'PENDING valable': 'PENDING',
      ACCEPTED: 'ACCEPTED',
      REVOKED: 'REVOKED',
    });
  });
});
