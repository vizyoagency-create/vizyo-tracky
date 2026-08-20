import {
  comparerRecensements,
  messageDisparition,
  type RecensementParTable,
} from './recensement-suppressions.service';

/**
 * ══ TRK-035 — DISTINGUER « LA RÉTENTION A FAIT SON TRAVAIL » DE « QUELQU'UN EST PASSÉ » ══
 *
 * Le 2026-08-19, **41 709 alertes et au moins 89 lignes d'erreur ont disparu**. Le ménage
 * automatique déclarait pourtant `errorDeleted: 0`, aucune suppression d'alertes n'existe
 * dans le code servi, et la migration du jour n'ajoutait que deux colonnes. La suppression a
 * été faite **directement en base**, et on ne l'a vue qu'un jour plus tard, dans les
 * statistiques internes de PostgreSQL.
 *
 * 🔑 **Aucun code ne peut empêcher un `DELETE` en base.** Cette règle n'empêche rien — elle
 * empêche que ça passe inaperçu. C'est la seule chose qui restait possible.
 *
 * ⚠️ Le piège à éviter est symétrique et il est mortel pour une sonde : crier sur la
 * rétention normale. Une sonde qui se trompe tous les jours n'est plus lue le jour où elle a
 * raison. D'où la question posée ici — non pas « des lignes ont-elles disparu ? » mais
 * **« la disparition est-elle EXPLIQUÉE ? »**.
 */
const recensement = (n: number, plusAncienne: string | null): RecensementParTable['x'] => ({
  n,
  plusAncienne,
});

describe('Recensement des suppressions — expliquée ou non ?', () => {
  it('🔴 LE CAS RÉEL DU 19/08 : 41 709 alertes parties, aucune purge revendiquée', () => {
    const avant = { alerts: recensement(51_735, '2026-04-28T12:35:25Z') };
    const apres = { alerts: recensement(10_055, '2026-04-28T12:35:25Z') };

    const [d] = comparerRecensements(avant, apres, {});

    expect(d).toBeDefined();
    expect(d!.table).toBe('alerts');
    expect(d!.lignesPerdues).toBe(41_680);
  });

  it('🔴 LE SECOND SIGNAL : la borne basse bondit de 22 jours pendant que la purge dit 0', () => {
    // C'est exactement ce qu'a fait `error_logs` : la plus ancienne ligne est passée du 28/07
    // au 19/08 alors que le ménage automatique déclarait n'avoir rien supprimé.
    const avant = { error_logs: recensement(50, '2026-07-28T10:46:32Z') };
    const apres = { error_logs: recensement(14, '2026-08-19T09:35:00Z') };

    const [d] = comparerRecensements(avant, apres, { error_logs: 0 });

    expect(d!.bondJours).toBe(22);
  });

  it('✅ une purge qui REVENDIQUE sa baisse ne déclenche rien', () => {
    // ⚠️ Le test qui protège la sonde d'elle-même. La rétention supprime des lignes chaque
    // nuit ; crier là-dessus reviendrait à signaler tous les jours que le passé est passé.
    const avant = { error_logs: recensement(500, '2026-05-01T00:00:00Z') };
    const apres = { error_logs: recensement(400, '2026-05-15T00:00:00Z') };

    expect(comparerRecensements(avant, apres, { error_logs: 100 })).toEqual([]);
  });

  it('une purge qui n’explique QU’UNE PARTIE de la baisse déclenche sur le reste', () => {
    // 100 revendiquées, 150 disparues : les 50 de trop n'ont pas d'explication.
    const avant = { error_logs: recensement(500, '2026-05-01T00:00:00Z') };
    const apres = { error_logs: recensement(350, '2026-05-15T00:00:00Z') };

    const [d] = comparerRecensements(avant, apres, { error_logs: 100 });

    expect(d!.lignesPerdues).toBe(50);
  });

  it('🔴 une suppression AU MILIEU de l’historique est vue, alors que la borne ne bouge pas', () => {
    // ⚠️ C'est pourquoi on regarde DEUX signaux. Un `DELETE` ciblé ne touche pas la plus
    // ancienne ligne : s'en remettre à la borne seule laisserait passer ce cas entier.
    const avant = { alerts: recensement(1_000, '2026-04-28T12:00:00Z') };
    const apres = { alerts: recensement(600, '2026-04-28T12:00:00Z') };

    const [d] = comparerRecensements(avant, apres, {});

    expect(d!.lignesPerdues).toBe(400);
    expect(d!.bondJours).toBeNull();
  });

  it('✅ une table qui GROSSIT ne déclenche rien — c’est le cas normal', () => {
    const avant = { error_logs: recensement(14, '2026-08-19T09:35:00Z') };
    const apres = { error_logs: recensement(31, '2026-08-19T09:35:00Z') };
    expect(comparerRecensements(avant, apres, {})).toEqual([]);
  });

  it('✅ rien ne bouge : silence', () => {
    const stable = { alerts: recensement(10_055, '2026-04-28T12:35:25Z') };
    expect(comparerRecensements(stable, stable, {})).toEqual([]);
  });

  it('une table apparue depuis le dernier relevé est ignorée, pas signalée', () => {
    // Sans ça, ajouter une table à surveiller produirait une fausse alerte au premier passage.
    const avant = { alerts: recensement(10, null) };
    const apres = { alerts: recensement(10, null), error_logs: recensement(5, null) };
    expect(comparerRecensements(avant, apres, {})).toEqual([]);
  });

  it('une table VIDÉE entièrement est signalée, borne à null comprise', () => {
    const avant = { error_logs: recensement(50, '2026-07-28T10:46:32Z') };
    const apres = { error_logs: recensement(0, null) };

    const [d] = comparerRecensements(avant, apres, {});

    expect(d!.lignesPerdues).toBe(50);
    expect(d!.bondJours).toBeNull(); // pas de borne « après » : rien à comparer, on ne devine pas
  });

  it('le message se lit sans ouvrir la base', () => {
    const avant = { error_logs: recensement(50, '2026-07-28T10:46:32Z') };
    const apres = { error_logs: recensement(14, '2026-08-19T09:35:00Z') };

    const texte = messageDisparition(comparerRecensements(avant, apres, {})[0]!);

    expect(texte).toContain('error_logs');
    expect(texte).toContain('36 ligne(s)');
    expect(texte).toContain('22 jour(s)');
    expect(texte).toContain('2026-07-28');
  });
});
