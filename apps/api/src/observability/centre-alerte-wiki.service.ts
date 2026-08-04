import { Injectable } from '@nestjs/common';
import { DocsWikiService, WikiDescriptor } from './docs-wiki.service';

/**
 * WIKI DU CENTRE D'ALERTE — sert `docs/centre-alerte/` à l'écran d'administration.
 *
 * Le référentiel des erreurs, la procédure d'audit et les rapports quotidiens vivaient
 * uniquement dans le dépôt. Or ce sont exactement les documents qu'on veut sous les yeux
 * AU MOMENT où l'on regarde une alerte — pas dans un éditeur, sur une autre machine.
 *
 * Toute la mécanique (découverte disque, manifeste facultatif, refus de traversée de
 * chemin) vit dans {@link DocsWikiService}. Ici, on ne déclare que ce qui distingue ce
 * wiki-là. Voir `docs-wiki.service.ts` pour le raisonnement de sécurité.
 *
 * `.sql` est servi : le collecteur fait partie de la documentation.
 */
@Injectable()
export class CentreAlerteWikiService extends DocsWikiService {
  protected readonly descriptor: WikiDescriptor = {
    folder: 'centre-alerte',
    envVar: 'CENTRE_ALERTE_DOCS_DIR',
    defaultTitle: "Centre d'alerte — documentation",
    loggerName: 'CentreAlerteWiki',
    formats: { '.md': 'markdown', '.sql': 'sql' },
  };
}
