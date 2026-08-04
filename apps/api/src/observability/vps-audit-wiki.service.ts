import { Injectable } from '@nestjs/common';
import { DocsWikiService, WikiDescriptor } from './docs-wiki.service';

/**
 * WIKI DE L'AUDIT VPS — sert `docs/vps-audit/` à l'écran d'administration.
 *
 * Même besoin que le centre d'alerte, autre objet : là où celui-ci raconte ce que
 * l'application casse, celui-ci raconte ce que la MACHINE subit — disque, mémoire,
 * conteneurs, sécurité. Un rapport par passage, plus le référentiel des constats qui
 * survit à la rotation des logs système.
 *
 * Toute la mécanique vit dans {@link DocsWikiService} ; voir ce fichier pour le
 * raisonnement de sécurité (traversée de chemin impossible par construction).
 *
 * `.sh` est servi : le collecteur est un script shell, et c'est lui qu'on veut relire
 * quand on se demande d'où sort un chiffre.
 */
@Injectable()
export class VpsAuditWikiService extends DocsWikiService {
  protected readonly descriptor: WikiDescriptor = {
    folder: 'vps-audit',
    envVar: 'VPS_AUDIT_DOCS_DIR',
    defaultTitle: 'Audit VPS — performances, données et sécurité',
    loggerName: 'VpsAuditWiki',
    formats: { '.md': 'markdown', '.sh': 'bash', '.sql': 'sql' },
  };
}
