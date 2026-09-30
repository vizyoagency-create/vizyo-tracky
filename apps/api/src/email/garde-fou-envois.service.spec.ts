import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { EmailTemplateId } from './email.service';
import { EmailService } from './email.service';
import {
  dansLaListeBlanche,
  GardeFouEnvoisService,
  lireListeBlanche,
  MODELES_RETENUS_EN_RECETTE,
  RECETTE_HEURES_MAX,
} from './garde-fou-envois.service';

/**
 * ══ LE GARDE-FOU D'ENVOI (30/09) ═══════════════════════════════════════════════════════════
 *
 * Le 24/09, une demande de recette déposée par le lien public du vrai client a prévenu cinq
 * personnes de cdef31. Ce fichier verrouille les deux protections — la liste blanche (poste de
 * dev) et le mode recette d'une société — et surtout ce qu'elles NE retiennent JAMAIS : un
 * courriel de compte, une alerte, le rapport du lundi.
 */

const SA = { id: 'sa-1', role: 'SUPER_ADMIN', fleetId: null } as never;
const ADMIN_F1 = { id: 'u-1', role: 'FLEET_ADMIN', fleetId: 'f1' } as never;
const DANS_2H = () => new Date(Date.now() + 2 * 3_600_000);
const IL_Y_A_1H = () => new Date(Date.now() - 3_600_000);

function monter(opts: { liste?: string; jusqua?: Date | null; echec?: boolean; absente?: boolean } = {}) {
  const etat = { jusqua: opts.jusqua ?? null };
  const findUnique = jest.fn().mockImplementation(async () => {
    if (opts.echec) throw new Error('base injoignable');
    if (opts.absente) return null;
    return { name: 'CDEF', envoisSuspendusJusqua: etat.jusqua };
  });
  const update = jest.fn().mockImplementation(async ({ data }: { data: { envoisSuspendusJusqua: Date | null } }) => {
    etat.jusqua = data.envoisSuspendusJusqua;
    return {};
  });
  const record = jest.fn();
  const config = { get: (k: string) => (k === 'EMAIL_LISTE_BLANCHE' ? (opts.liste ?? '') : undefined) };
  const garde = new GardeFouEnvoisService(config as never, { fleet: { findUnique, update } } as never, { record } as never);
  return { garde, findUnique, update, record, etat };
}

describe('lireListeBlanche / dansLaListeBlanche', () => {
  it('vide (la prod, la démo) → aucune restriction', () => {
    expect(lireListeBlanche('')).toBeNull();
    expect(lireListeBlanche('  ,  ; ')).toBeNull();
    expect(lireListeBlanche(undefined)).toBeNull();
  });

  it('domaines précédés de « @ » et adresses, séparés par virgules, points-virgules ou espaces — sans casse', () => {
    const l = lireListeBlanche(' @Demo.VizyoAgency.com, Admin@Exemple.fr ; b@y.fr')!;
    expect(l.domaines).toEqual(['demo.vizyoagency.com']);
    expect([...l.adresses].sort()).toEqual(['admin@exemple.fr', 'b@y.fr']);
  });

  it('une liste mal écrite (« @ » seul) RETIENT tout — jamais l’inverse', () => {
    const l = lireListeBlanche('@')!;
    expect(l).not.toBeNull();
    expect(dansLaListeBlanche(l, 'qui@que.ce.soit')).toBe(false);
  });

  it('adresse exacte, domaine EXACT (un sous-domaine se nomme), « Nom <adresse> », casse ignorée', () => {
    const l = lireListeBlanche('@vizyoagency.com,moi@exemple.fr')!;
    expect(dansLaListeBlanche(l, 'contact@vizyoagency.com')).toBe(true);
    expect(dansLaListeBlanche(l, 'CONTACT@VizyoAgency.com')).toBe(true);
    expect(dansLaListeBlanche(l, 'Moi <moi@exemple.fr>')).toBe(true);
    expect(dansLaListeBlanche(l, 'x@demo.vizyoagency.com')).toBe(false);
    expect(dansLaListeBlanche(l, 'x@vizyoagency.com.pirate.fr')).toBe(false);
    expect(dansLaListeBlanche(l, 'autre@exemple.fr')).toBe(false);
    expect(dansLaListeBlanche(l, 'pas-une-adresse')).toBe(false);
    expect(dansLaListeBlanche(l, '')).toBe(false);
  });
});

describe('Les modèles que le mode recette retient', () => {
  it('ce sont les avis de réservation, de demande publique, de mission et de dépôt — des identifiants RÉELS', () => {
    // Typé `EmailTemplateId[]` : un identifiant mal orthographié ne compile pas.
    const attendus: EmailTemplateId[] = [
      'reservation_requested',
      'reservation_request_pending',
      'reservation_confirmed',
      'reservation_refused',
      'mission_request',
      'mission_assigned',
      'mission_tournee_modifiee',
      'depot_incident',
    ];
    expect([...MODELES_RETENUS_EN_RECETTE].sort()).toEqual([...attendus].sort());
  });

  it('JAMAIS un courriel de compte, une alerte ni le rapport du lundi', () => {
    const jamais: EmailTemplateId[] = [
      'invitation',
      'password_reset',
      'device_verification',
      'two_factor_disable',
      'alert',
      'error_rate_alert',
      'critical_error_alert',
      'weekly_report',
    ];
    for (const m of jamais) expect(MODELES_RETENUS_EN_RECETTE.has(m)).toBe(false);
  });
});

describe('GardeFouEnvoisService.motifDeRetenue', () => {
  it('ni liste ni mode recette : tout part — et un modèle hors recette ne lit même pas la base', async () => {
    const { garde, findUnique } = monter();
    expect(await garde.motifDeRetenue({ canal: 'email', destinataire: 'a@b.fr', fleetId: 'f1', modele: 'invitation' })).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
    expect(await garde.motifDeRetenue({ canal: 'email', destinataire: 'a@b.fr', fleetId: 'f1', modele: 'reservation_confirmed' })).toBeNull();
    expect(garde.listeBlancheActive()).toBe(false);
  });

  it('liste blanche : dans la liste → part ; hors liste → RETENU, quel que soit le modèle', async () => {
    const { garde } = monter({ liste: '@vizyoagency.com' });
    expect(garde.listeBlancheActive()).toBe(true);
    expect(await garde.motifDeRetenue({ canal: 'email', destinataire: 'contact@vizyoagency.com', modele: 'invitation' })).toBeNull();
    expect(await garde.motifDeRetenue({ canal: 'email', destinataire: 'client@gmail.com', modele: 'password_reset' }))
      .toMatch(/liste blanche/);
  });

  it('liste blanche, plusieurs destinataires : il suffit d’UN hors liste pour tout retenir', async () => {
    const { garde } = monter({ liste: '@vizyoagency.com' });
    expect(await garde.motifDeRetenue({ canal: 'email', destinataire: 'a@vizyoagency.com, b@vizyoagency.com' })).toBeNull();
    expect(await garde.motifDeRetenue({ canal: 'email', destinataire: 'a@vizyoagency.com, x@gmail.com' })).toMatch(/liste blanche/);
    expect(await garde.motifDeRetenue({ canal: 'email', destinataire: ' , ' })).toMatch(/liste blanche/);
  });

  it('la liste blanche ne juge que le COURRIEL : un SMS ou un push passe', async () => {
    const { garde } = monter({ liste: '@vizyoagency.com' });
    expect(await garde.motifDeRetenue({ canal: 'sms', destinataire: '+33612345678', fleetId: 'f1', modele: 'reservation_confirmed' })).toBeNull();
    expect(await garde.motifDeRetenue({ canal: 'push', destinataire: '', fleetId: 'f1', modele: 'reservation_request_pending' })).toBeNull();
  });

  it('mode recette actif : les avis de la société sont RETENUS, sur les trois canaux', async () => {
    const { garde } = monter({ jusqua: DANS_2H() });
    for (const canal of ['email', 'sms', 'push'] as const) {
      expect(await garde.motifDeRetenue({ canal, destinataire: 'x', fleetId: 'f1', modele: 'reservation_request_pending' }))
        .toMatch(/mode recette jusqu'au/);
    }
    expect(await garde.motifDeRetenue({ canal: 'email', destinataire: 'd@depot.fr', fleetId: 'f1', modele: 'mission_assigned' }))
      .toMatch(/mode recette/);
  });

  it('mode recette actif : un courriel de compte, une alerte, le rapport du lundi PARTENT', async () => {
    const { garde } = monter({ jusqua: DANS_2H() });
    for (const modele of ['invitation', 'password_reset', 'device_verification', 'alert', 'weekly_report'] as const) {
      expect(await garde.motifDeRetenue({ canal: 'email', destinataire: 'a@cdef31.fr', fleetId: 'f1', modele })).toBeNull();
    }
  });

  it('mode recette ÉCHU : tout repart, sans que personne n’ait à le lever', async () => {
    const { garde } = monter({ jusqua: IL_Y_A_1H() });
    expect(await garde.motifDeRetenue({ canal: 'email', destinataire: 'a@cdef31.fr', fleetId: 'f1', modele: 'reservation_confirmed' })).toBeNull();
  });

  it('sans société connue, le mode recette ne peut rien retenir', async () => {
    const { garde, findUnique } = monter({ jusqua: DANS_2H() });
    expect(await garde.motifDeRetenue({ canal: 'email', destinataire: 'a@cdef31.fr', fleetId: null, modele: 'reservation_confirmed' })).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('base illisible : l’avis PART (le garde-fou ne devient jamais, lui, une coupure des avis) — et ne lève pas', async () => {
    const { garde } = monter({ echec: true });
    await expect(
      garde.motifDeRetenue({ canal: 'email', destinataire: 'a@cdef31.fr', fleetId: 'f1', modele: 'reservation_confirmed' }),
    ).resolves.toBeNull();
  });

  it('la société est relue au plus toutes les 15 s — un envoi par lot ne lit pas la base à chaque ligne', async () => {
    const { garde, findUnique } = monter({ jusqua: DANS_2H() });
    for (let i = 0; i < 5; i++) {
      await garde.motifDeRetenue({ canal: 'email', destinataire: `v${i}@cdef31.fr`, fleetId: 'f1', modele: 'reservation_request_pending' });
    }
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('GardeFouEnvoisService.regler / etat', () => {
  it('réservé au super-admin : un administrateur de flotte ne coupe pas les avis de sa société', async () => {
    const { garde, update } = monter();
    await expect(garde.regler(ADMIN_F1, 'f1', 2)).rejects.toBeInstanceOf(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([0, -1, RECETTE_HEURES_MAX + 1, 1.5, Number.NaN])('durée %p refusée : de 1 à 24 heures, entières', async (h) => {
    const { garde, update } = monter();
    await expect(garde.regler(SA, 'f1', h)).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it('société inconnue → 404', async () => {
    const { garde } = monter({ absente: true });
    await expect(garde.regler(SA, 'f-x', 2)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('poser 2 h : la société est écrite, UNE ligne à son journal (qui, jusqu’à quand), et l’envoi suivant est retenu tout de suite', async () => {
    const { garde, update, record } = monter();
    // Un premier envoi met « rien de retenu » en cache…
    expect(await garde.motifDeRetenue({ canal: 'email', destinataire: 'a@cdef31.fr', fleetId: 'f1', modele: 'reservation_confirmed' })).toBeNull();
    const avant = Date.now();
    const r = await garde.regler(SA, 'f1', 2);
    const jusqua = Date.parse(r.suspendusJusqua!);
    expect(jusqua).toBeGreaterThanOrEqual(avant + 2 * 3_600_000);
    expect(jusqua).toBeLessThan(avant + 2 * 3_600_000 + 5_000);
    expect(update).toHaveBeenCalledWith({ where: { id: 'f1' }, data: { envoisSuspendusJusqua: expect.any(Date) } });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'AGENDA',
        action: 'envois_suspendus',
        fleetId: 'f1',
        target: 'CDEF',
        triggeredByUserId: 'sa-1',
      }),
    );
    // …que le réglage vide : pas 15 s d'avis qui partent encore.
    expect(await garde.motifDeRetenue({ canal: 'email', destinataire: 'a@cdef31.fr', fleetId: 'f1', modele: 'reservation_confirmed' }))
      .toMatch(/mode recette/);
  });

  it('rétablir un mode actif : écrit null, et le journal dit « Avis rétablis »', async () => {
    const { garde, update, record } = monter({ jusqua: DANS_2H() });
    const r = await garde.regler(SA, 'f1', null);
    expect(r.suspendusJusqua).toBeNull();
    expect(update).toHaveBeenCalledWith({ where: { id: 'f1' }, data: { envoisSuspendusJusqua: null } });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'envois_retablis', fleetId: 'f1' }));
  });

  it('rétablir ce qui n’était pas actif : aucune ligne de journal (rien ne change pour la société)', async () => {
    const { garde, record } = monter({ jusqua: IL_Y_A_1H() });
    await garde.regler(SA, 'f1', null);
    expect(record).not.toHaveBeenCalled();
  });

  it('état : sa société (ou toutes pour un super-admin), et un mode échu se lit « rien de retenu »', async () => {
    const actif = monter({ jusqua: DANS_2H() });
    expect((await actif.garde.etat(ADMIN_F1, 'f1')).suspendusJusqua).toEqual(expect.any(String));
    expect((await actif.garde.etat(SA, 'f1')).suspendusJusqua).toEqual(expect.any(String));
    await expect(actif.garde.etat(ADMIN_F1, 'f2')).rejects.toBeInstanceOf(NotFoundException);
    const echu = monter({ jusqua: IL_Y_A_1H() });
    expect((await echu.garde.etat(ADMIN_F1, 'f1')).suspendusJusqua).toBeNull();
  });

  it('SMS retenu : une ligne au journal, numéro MASQUÉ', () => {
    const { garde, record } = monter();
    garde.noterSmsRetenu({ numero: '+33 6 12 34 56 78', fleetId: 'f1', modele: 'reservation_confirmed', motif: 'm' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ category: 'SMS', action: 'sms_retenu', status: 'SKIPPED', target: '•••5678' }));
    expect(JSON.stringify(record.mock.calls[0][0])).not.toContain('612345678');
  });
});

describe('EmailService.send — un courriel RETENU ne part pas', () => {
  function service(retenu: string | null) {
    const create = jest.fn().mockResolvedValue({});
    const record = jest.fn();
    const motifDeRetenue = jest.fn().mockResolvedValue(retenu);
    const config = { get: (k: string) => (k === 'APP_BASE_URL' ? 'https://app.test' : '') };
    const svc = new EmailService(config as never, { record } as never, { emailLog: { create } } as never, {} as never, {
      motifDeRetenue,
    } as never);
    // Un client Resend « branché » : s'il était appelé, le courriel partirait.
    const envoi = jest.fn().mockResolvedValue({ data: { id: 're_1' }, error: null });
    Object.assign(svc as object, { enabled: true, client: { emails: { send: envoi } } });
    return { svc, create, record, motifDeRetenue, envoi };
  }
  const params = {
    to: 'valideur@cdef31.fr',
    subject: 'Demande à valider',
    html: '<p>h</p>',
    text: 't',
    template: 'reservation_request_pending' as const,
    fleetId: 'f1',
  };

  it('retenu : Resend n’est PAS appelé, la ligne BLOCKED prouve ce qui serait parti, et ce n’est pas un échec', async () => {
    const { svc, create, record, motifDeRetenue, envoi } = service("société en mode recette jusqu'au 30/09 12:40");
    const r = await svc.send(params);
    expect(motifDeRetenue).toHaveBeenCalledWith({
      canal: 'email',
      destinataire: 'valideur@cdef31.fr',
      fleetId: 'f1',
      modele: 'reservation_request_pending',
    });
    expect(envoi).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, retenu: expect.stringContaining('mode recette') });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'BLOCKED', template: 'reservation_request_pending', fleetId: 'f1', providerId: null }),
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ category: 'EMAIL', action: 'email_retenu', status: 'SKIPPED', fleetId: 'f1' }));
  });

  it('la société lue dans `context.fleetId` quand `fleetId` manque (la demande de mission)', async () => {
    const { svc, motifDeRetenue } = service(null);
    await svc.send({ ...params, fleetId: undefined, template: 'mission_request', context: { fleetId: 'f9' } });
    expect(motifDeRetenue).toHaveBeenCalledWith(expect.objectContaining({ fleetId: 'f9', modele: 'mission_request' }));
  });

  it('non retenu : le courriel part, comme avant', async () => {
    const { svc, envoi, create } = service(null);
    const r = await svc.send(params);
    expect(envoi).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: true, id: 're_1' });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'QUEUED', providerId: 're_1' }) });
  });
});
