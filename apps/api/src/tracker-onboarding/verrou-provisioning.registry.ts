import { Injectable, Logger } from '@nestjs/common';

/**
 * Le verrou de mise en service — un seul poste à la fois en ÉCOUTE AVEUGLE.
 *
 * ── POURQUOI UN VERROU, ET POURQUOI SEULEMENT LÀ ─────────────────────────────────────
 *
 * Quand on ne connaît pas l'IMEI d'avance, la seule façon de trouver le boîtier est de
 * dire « le prochain inconnu qui se présente en TCP, c'est le mien ». Si deux personnes
 * font ce pari en même temps, rien ne permet de savoir quel boîtier appartient à qui —
 * et se tromper met les positions d'une camionnette sur une autre.
 *
 * ⚠️ CE VERROU NE SERT QU'À CE PARI. Quand le code-barré a été scanné, ou que la puce est
 * connue de l'inventaire, l'IMEI est certain : dix boîtiers peuvent frapper à la porte,
 * on prend le bon. Verrouiller là serait bloquer sans raison — et pousserait les
 * installateurs à se marcher dessus pour rien.
 *
 * ── EN MÉMOIRE, ET C'EST ASSUMÉ ──────────────────────────────────────────────────────
 *
 * Comme le registre des boîtiers inconnus. Un redémarrage libère tout : c'est le bon
 * défaut pour un verrou de coordination — un verrou qui survivrait à un crash en gardant
 * un détenteur mort bloquerait le parc jusqu'à intervention. Le prix est une fenêtre de
 * quelques secondes après un déploiement où deux personnes pourraient l'obtenir ; le
 * rattachement demandant de toute façon une confirmation quand l'identité est incertaine,
 * ce cas se rattrape à l'écran plutôt que de se transformer en mauvaise affectation.
 */
export interface DetenteurVerrou {
  userId: string;
  nom: string;
  email: string;
  /** Ce qu'il est en train de créer, pour que le message soit parlant. */
  contexte: string | null;
  prisA: number;
  dernierBattement: number;
}

export interface EtatVerrou {
  libre: boolean;
  parMoi: boolean;
  detenteurNom: string | null;
  detenteurEmail: string | null;
  contexte: string | null;
  depuisSecondes: number | null;
  expireDansSecondes: number | null;
}

@Injectable()
export class VerrouProvisioningRegistry {
  private readonly logger = new Logger(VerrouProvisioningRegistry.name);

  /**
   * 90 s sans battement et le verrou tombe. Le client bat toutes les 20 s : il faut donc
   * rater quatre battements d'affilée. Un onglet fermé, un portable qui s'endort ou un
   * réseau coupé libèrent ainsi tout seuls, sans que personne ait à appeler l'assistance.
   */
  static readonly EXPIRATION_MS = 90_000;

  private detenteur: DetenteurVerrou | null = null;

  /** Prend le verrou, ou le rafraîchit si l'appelant le détient déjà. */
  prendre(u: { userId: string; nom: string; email: string; contexte?: string | null }): EtatVerrou {
    const actuel = this.actuel();
    if (actuel && actuel.userId !== u.userId) return this.etat(u.userId);

    const maintenant = Date.now();
    this.detenteur = {
      userId: u.userId,
      nom: u.nom,
      email: u.email,
      contexte: u.contexte ?? actuel?.contexte ?? null,
      prisA: actuel?.prisA ?? maintenant,
      dernierBattement: maintenant,
    };
    if (!actuel) this.logger.log(`Verrou de mise en service pris par ${u.email}`);
    return this.etat(u.userId);
  }

  /** Rend le verrou. Sans effet si l'appelant ne le détient pas. */
  rendre(userId: string): EtatVerrou {
    if (this.detenteur?.userId === userId) {
      this.logger.log(`Verrou rendu par ${this.detenteur.email}`);
      this.detenteur = null;
    }
    return this.etat(userId);
  }

  /**
   * Libération forcée — réservée au super-admin côté contrôleur.
   *
   * L'évincé ne l'apprend pas par une notification poussée : son prochain battement lui
   * répondra `parMoi: false`, et son écran basculera. Au pire vingt secondes de décalage,
   * pour un événement rare — contre une room temps réel par utilisateur à créer et à
   * maintenir dans une passerelle que d'autres écrans partagent.
   */
  forcer(parQui: string): EtatVerrou {
    if (this.detenteur) {
      this.logger.warn(`Verrou de ${this.detenteur.email} libéré de force par ${parQui}`);
      this.detenteur = null;
    }
    return this.etat(null);
  }

  etat(pourUserId: string | null): EtatVerrou {
    const d = this.actuel();
    if (!d) {
      return {
        libre: true,
        parMoi: false,
        detenteurNom: null,
        detenteurEmail: null,
        contexte: null,
        depuisSecondes: null,
        expireDansSecondes: null,
      };
    }
    const maintenant = Date.now();
    return {
      libre: false,
      parMoi: d.userId === pourUserId,
      detenteurNom: d.nom,
      detenteurEmail: d.email,
      contexte: d.contexte,
      depuisSecondes: Math.round((maintenant - d.prisA) / 1000),
      expireDansSecondes: Math.max(
        0,
        Math.round((d.dernierBattement + VerrouProvisioningRegistry.EXPIRATION_MS - maintenant) / 1000),
      ),
    };
  }

  /** Le détenteur, ou `null` s'il a cessé de battre. L'expiration est paresseuse. */
  private actuel(): DetenteurVerrou | null {
    if (!this.detenteur) return null;
    const perime =
      Date.now() - this.detenteur.dernierBattement > VerrouProvisioningRegistry.EXPIRATION_MS;
    if (perime) {
      this.logger.log(`Verrou de ${this.detenteur.email} expiré (plus de battement).`);
      this.detenteur = null;
    }
    return this.detenteur;
  }
}
