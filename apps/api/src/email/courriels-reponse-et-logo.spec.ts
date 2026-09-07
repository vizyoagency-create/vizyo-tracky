import { EmailService, type EmailTemplateId } from './email.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE CHAQUE COURRIEL PROMET AU LECTEUR : PEUT-IL RÉPONDRE, OUI OU NON ?
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * L'expéditeur est passé de `contact@` à `noreply@` : la quasi-totalité de ce que le produit
 * envoie est automatique, et poser l'adresse d'un humain en expéditeur promet une conversation
 * que personne ne tient.
 *
 * Mais un expéditeur muet ne suffit pas — encore faut-il le DIRE. Sept gabarits sur vingt-trois
 * portaient la mention, sous quatre formulations différentes ; les seize autres n'en portaient
 * aucune. Le rapport du lundi, celui que la plupart des gestionnaires ouvrent vraiment, était
 * du deuxième groupe.
 *
 * ── DEUX POLITIQUES, ET LE COMPILATEUR FORCE À CHOISIR ───────────────────────────────────
 *
 *   `automatique`  — rien à répondre : le courrier constate ou notifie. Il DOIT porter la
 *                    mention, et toujours la même : « E-mail automatique, ne pas répondre. »
 *   `conversation` — une réponse est la suite NORMALE : un devis, une demande d'installation,
 *                    un prospect. Il ne doit surtout PAS porter la mention.
 *
 * Le `Record<EmailTemplateId, …>` ci-dessous ne compile pas si un modèle manque : ajouter un
 * gabarit oblige à trancher, plutôt qu'à hériter d'un défaut silencieux.
 *
 * ⚠️ « CONVERSATION » N'EST PAS UNE EXCEPTION DE CONFORT. Trois de ces courriels sont des
 * notifications INTERNES qui portent la demande d'un client : y répondre doit écrire au client,
 * ce que leur `replyTo` fait désormais. Les dire « automatiques » aurait été faux, et cette
 * fausseté aurait coûté des réponses jamais envoyées.
 */

type Politique = 'automatique' | 'conversation';

const POLITIQUE: Record<EmailTemplateId, Politique> = {
  // ── Automatiques : le produit constate, notifie, sécurise ──
  invitation: 'automatique',
  password_reset: 'automatique',
  device_verification: 'automatique',
  two_factor_disable: 'automatique',
  weekly_report: 'automatique',
  alert: 'automatique',
  error_rate_alert: 'automatique',
  audio_activation: 'automatique',
  audio_info: 'automatique',
  partner_consent_invitation: 'automatique',
  mission_request: 'automatique',
  mission_assigned: 'automatique',
  mission_tournee_modifiee: 'automatique',
  depot_incident: 'automatique',
  reservation_requested: 'automatique',
  reservation_confirmed: 'automatique',

  // ── Conversations : une réponse est la suite normale ──
  // Vers l'extérieur : un prospect, un client.
  lead_welcome: 'conversation',
  quote_client: 'conversation',
  installation_slot_confirmed: 'conversation',
  // Vers l'intérieur : la notification porte la demande de quelqu'un, et `replyTo` fait que
  // « répondre » écrit à cette personne — pas à notre propre boîte.
  lead: 'conversation',
  quote_signed: 'conversation',
  installation_slot_requested: 'conversation',
  ai_invoice_request: 'conversation',
};

const MENTION = 'E-mail automatique, ne pas répondre.';
const TOUS = Object.keys(POLITIQUE) as EmailTemplateId[];

/**
 * `previewTemplate()` ne lit que `APP_BASE_URL`, et `RESEND_API_KEY` vide met le service en
 * mode no-op — aucune instanciation de Resend, aucun envoi possible depuis ce fichier.
 */
function service() {
  const config = {
    get: (k: string) => (k === 'APP_BASE_URL' ? 'https://app.test' : ''),
  } as never;
  return new EmailService(config, {} as never, {} as never, {} as never);
}

describe('Courriels — « puis-je répondre à ça ? » a une réponse dans chaque pied de page', () => {
  const email = service();

  for (const id of TOUS.filter((i) => POLITIQUE[i] === 'automatique')) {
    it(`${id} — porte la mention, et la formulation commune`, () => {
      expect(email.previewTemplate(id).html).toContain(MENTION);
    });
  }

  for (const id of TOUS.filter((i) => POLITIQUE[i] === 'conversation')) {
    it(`${id} — ne la porte PAS : y répondre est la suite normale`, () => {
      expect(email.previewTemplate(id).html).not.toContain(MENTION);
    });
  }

  /**
   * ⚠️ UNE SEULE FORMULATION, PARTOUT. Elles étaient quatre — « E-mail automatique, ne pas
   * répondre. », « Ne pas répondre. », « E-mail automatique de sécurité. Ne pas répondre. »,
   * « Notification automatique. » — pour dire la même chose. Un lecteur qui reçoit trois de nos
   * courriels dans la semaine lit trois phrases différentes ; c'est ce que ce test interdit.
   */
  it('aucune variante ne subsiste à côté de la formulation commune', () => {
    const variantes = [
      'de sécurité. Ne pas répondre',
      'suite à une invitation. Ne pas répondre',
      'Vizyo Tracky. E-mail automatique',
    ];
    for (const id of TOUS) {
      const html = email.previewTemplate(id).html;
      for (const v of variantes) expect(html).not.toContain(v);
    }
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE LOGO DES COURRIELS EST CELUI DE L'APPLICATION — LE MÊME FICHIER
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Il pointait sur une COPIE hébergée par la page vitrine (`/email/vizyo-logo.png`, déposée en
 * juillet). Elle avait divergé : la goutte intérieure de la pastille manquait. Personne ne
 * pouvait le voir — le courrier du lundi porte ce logo depuis des mois, et il n'existe aucun
 * écran où les deux images se croisent.
 *
 * ⚠️ CE N'EST PAS « LE MÊME DESSIN », C'EST LE MÊME FICHIER : celui que sert l'application,
 * donc celui de la barre du haut et de l'écran de connexion. Deux fichiers finissent toujours
 * par diverger ; un seul ne le peut pas.
 */
describe('Courriels — le logo vient de l’application, pas d’une copie', () => {
  it('l’adresse par défaut est l’asset servi par l’application', () => {
    const html = service().previewTemplate('weekly_report').html;

    expect(html).toContain('https://app.test/logos/png/vizyo-tracky-icon-green.png');
  });

  it('plus aucune trace de la copie de la page vitrine', () => {
    for (const id of TOUS) {
      expect(service().previewTemplate(id).html).not.toContain('/email/vizyo-logo.png');
    }
  });

  /**
   * L'override reste possible — pour un DOMAINE différent (recette, prévisualisation), jamais
   * pour une autre image. C'est la seule raison qui justifie de ne pas suivre l'application.
   */
  it('EMAIL_LOGO_URL, si elle est remplie, l’emporte', () => {
    const config = {
      get: (k: string) =>
        k === 'EMAIL_LOGO_URL' ? 'https://recette.test/logo.png'
          : k === 'APP_BASE_URL' ? 'https://app.test' : '',
    } as never;
    const html = new EmailService(config, {} as never, {} as never, {} as never)
      .previewTemplate('weekly_report').html;

    expect(html).toContain('https://recette.test/logo.png');
  });
});
