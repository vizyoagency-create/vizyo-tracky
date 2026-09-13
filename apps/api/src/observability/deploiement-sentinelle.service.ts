import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { formatFleetDateTime } from '../common/utils/datetime';
import { ErrorLogger } from './error-logger.service';
import { RefroidissementAlerteService } from './refroidissement-alerte.service';

/** Source des lignes écrites au centre d'alerte. */
export const SOURCE_DEPLOIEMENT = 'deploiement';

/** Là où `deploy/vps/deploy.sh` inscrit ce qu'il a fait — monté `:ro` par le compose de production. */
const JOURNAL_PAR_DEFAUT = '/app/deploiements/journal.jsonl';

/** Ce qu'une ligne du journal porte (voir `journaliser` dans deploy.sh). */
interface LigneDeploiement {
  at: string;
  sha: string;
  branche?: string;
  apiContainerId: string;
  webContainerId?: string;
  force?: boolean;
  attente?: boolean;
  repli?: string | null;
  par?: string;
  dureeS?: number;
}

export type VerdictDeploiement = 'sans-journal' | 'par-script' | 'hors-script' | 'illisible';

/**
 * ── LE SCRIPT DE DÉPLOIEMENT EST INCONTOURNABLE — parce qu'un contournement SE VOIT ──────
 *
 * Décision D1 du propriétaire (2026-09-13, depuis le poste de commande) : `deploy/vps/deploy.sh`
 * est le seul chemin vers la production. Il porte la garde qui refuse de recréer l'API pendant
 * — ou juste avant — un passage d'automatisation (TRK-077 : un passage tué le 09/09 par un
 * déploiement qui n'était pas passé par lui, et rien ne pouvait le prouver).
 *
 * Rien n'empêche techniquement un `docker compose up` tapé à la main. Ce service fait qu'il
 * ne passe jamais inaperçu : le script inscrit au journal l'identifiant du conteneur API qu'il
 * vient de créer ; au démarrage, l'API compare l'identifiant du conteneur qui l'exécute — son
 * hostname, Docker l'y met — au dernier journalisé. Un conteneur que le script n'a pas créé
 * produit une ligne ERROR au centre d'alerte, que l'audit du lendemain transforme en tâche.
 *
 * Un simple redémarrage (crash, OOM, reboot du VPS) garde le même conteneur, donc le même
 * identifiant : il ne déclenche rien. Seule une RECRÉATION — un déploiement — change
 * l'identifiant, et c'est exactement ce qu'on veut voir.
 *
 * ⚠️ Différé de 90 s après le démarrage : le script écrit le journal JUSTE APRÈS le `up -d`,
 * pendant que l'API démarre. Lire trop tôt accuserait à tort le déploiement légitime.
 */
@Injectable()
export class DeploiementSentinelleService implements OnApplicationBootstrap {
  static readonly DELAI_VERIFICATION_MS = 90_000;
  /** Une ligne par conteneur : une API qui redémarre en boucle ne remplit pas le centre d'alerte. */
  static readonly REFROIDISSEMENT_MS = 24 * 3_600_000;

  private readonly logger = new Logger(DeploiementSentinelleService.name);

  constructor(
    private readonly errorLogger: ErrorLogger,
    private readonly refroidissement: RefroidissementAlerteService,
  ) {}

  onApplicationBootstrap(): void {
    const minuteur = setTimeout(() => {
      void this.verifier().catch((e) => {
        this.logger.warn(`vérification du déploiement impossible : ${e instanceof Error ? e.message : String(e)}`);
      });
    }, DeploiementSentinelleService.DELAI_VERIFICATION_MS);
    // Ne retient pas le processus : un arrêt propre n'attend pas la sentinelle.
    minuteur.unref?.();
  }

  /**
   * Compare ce conteneur au dernier déploiement journalisé. Publique et paramétrable pour les
   * tests ; le démarrage l'appelle sans argument.
   */
  async verifier(chemin = process.env.DEPLOIEMENT_JOURNAL ?? JOURNAL_PAR_DEFAUT, moi = hostname()): Promise<VerdictDeploiement> {
    let contenu: string;
    try {
      contenu = await readFile(chemin, 'utf8');
    } catch {
      // Pas de montage (démo, poste de développement) : pas d'avis. Le dire sans crier.
      this.logger.log(`journal des déploiements absent (${chemin}) — aucun avis sur l'origine de ce conteneur.`);
      return 'sans-journal';
    }
    const derniere = contenu.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).pop();
    if (!derniere) {
      this.logger.log('journal des déploiements vide — le script n\'est encore jamais passé.');
      return 'sans-journal';
    }

    let ligne: LigneDeploiement;
    try {
      ligne = JSON.parse(derniere) as LigneDeploiement;
      if (typeof ligne.apiContainerId !== 'string') throw new Error('apiContainerId manquant');
    } catch (e) {
      // Un journal cassé est un défaut du SCRIPT — pas une preuve de contournement.
      await this.ecrire(
        `Journal des déploiements illisible : la dernière ligne de ${chemin} n'est pas du JSON attendu ` +
          `(${e instanceof Error ? e.message : String(e)}). deploy/vps/deploy.sh l'écrit ; vérifier sa fonction journaliser.`,
        { conteneur: moi, ligne: derniere.slice(0, 300) },
      );
      return 'illisible';
    }

    if (ligne.apiContainerId.startsWith(moi)) {
      this.logger.log(`conteneur créé par deploy.sh — ${ligne.sha} (${ligne.branche ?? 'main'}) le ${formatFleetDateTime(ligne.at)} par ${ligne.par ?? '?'}.`);
      return 'par-script';
    }

    const emettre = await this.refroidissement.tenterEmission(
      `deploiement-hors-script:${moi}`,
      DeploiementSentinelleService.REFROIDISSEMENT_MS,
    );
    if (emettre) {
      await this.ecrire(
        `Déploiement hors script : ce conteneur (${moi}) n'a pas été créé par deploy/vps/deploy.sh — ` +
          `dernier déploiement journalisé : ${ligne.sha} le ${formatFleetDateTime(ligne.at)} par ${ligne.par ?? '?'}, ` +
          `conteneur ${ligne.apiContainerId.slice(0, 12)}. Décision D1 (13/09/2026) : le script est le seul chemin — ` +
          `sa garde empêche de tuer un passage d'automatisation, un « docker compose up » à la main ne la voit pas. ` +
          `Prochain déploiement : bash /opt/vizyo-tracky/deploy/vps/deploy.sh.`,
        { conteneur: moi, dernierDeploiement: ligne },
      );
    }
    return 'hors-script';
  }

  /** Le centre d'alerte est le contrat ; s'il refuse, le démarrage n'en souffre pas. */
  private async ecrire(message: string, contexte: Record<string, unknown>): Promise<void> {
    this.logger.error(message);
    try {
      await this.errorLogger.record(new Error(message), SOURCE_DEPLOIEMENT, contexte, 'ERROR');
    } catch (e) {
      this.logger.warn(`ligne non écrite au centre d'alerte : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
