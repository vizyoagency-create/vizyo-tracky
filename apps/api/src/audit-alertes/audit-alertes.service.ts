import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Audit des alertes : ce qui a été envoyé, et LA TRAME QUI L'A DÉCLENCHÉ.
 *
 * ── POURQUOI CET ÉCRAN EXISTE ────────────────────────────────────────────────────────
 *
 * 41 713 fausses alertes « Alimentation coupée » sont parties aux clients avant que
 * quiconque comprenne pourquoi. Il a fallu restaurer une sauvegarde dans une base
 * temporaire et écrire du SQL à la main pour découvrir que 41 468 venaient d'un boîtier
 * remplacé sept semaines plus tôt.
 *
 * Cette enquête aurait dû être une page. Tout ce qu'il fallait était DÉJÀ en base :
 * chaque alerte porte dans son `payload` la trame brute qui l'a produite, l'alarme
 * décodée, la vitesse et l'état du contact. Personne ne pouvait le voir.
 *
 * ── CE QU'IL MONTRE, ET POURQUOI CHAQUE COLONNE EST LÀ ───────────────────────────────
 *
 *   — la TRAME BRUTE : c'est elle qui tranche. « ac alarm » ou « oil » n'est pas une
 *     question d'opinion, c'est écrit dedans ;
 *   — l'IMEI LU DANS LA TRAME, pas celui du véhicule : ils diffèrent quand un boîtier a
 *     été remplacé, et c'est exactement ce qui a résolu le cas FZ-862-VY ;
 *   — la BATTERIE au moment de l'alerte : le discriminant entre une vraie coupure et un
 *     contact coupé ;
 *   — le regroupement PAR CAUSE, qui répond en un coup d'œil à « d'où viennent ces
 *     milliers de lignes ? ».
 */

export interface LigneAudit {
  id: string;
  creeLe: string;
  type: string;
  severite: string;
  titre: string;
  message: string | null;
  acquittee: boolean;
  plaque: string | null;
  flotte: string | null;
  /** Alarme telle que le décodeur l'a comprise. */
  alarmeDecodee: string | null;
  /** La trame envoyée par le boîtier — la source de vérité. */
  trameBrute: string | null;
  /** IMEI LU DANS LA TRAME : révèle un boîtier remplacé depuis. */
  imeiTrame: string | null;
  /** 4e champ de la trame, quand c'est un pourcentage de batterie. */
  batterie: number | null;
  vitesseKmh: number | null;
  contact: boolean | null;
}

export interface RegroupementCause {
  type: string;
  alarmeDecodee: string | null;
  imeiTrame: string | null;
  plaque: string | null;
  nombre: number;
  premiere: string;
  derniere: string;
}

export interface FiltresAudit {
  type?: string;
  plaque?: string;
  depuis?: string;
  jusqua?: string;
  page?: number;
  taille?: number;
}

@Injectable()
export class AuditAlertesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ⚠️ FENÊTRE TOUJOURS BORNÉE. Sans borne, une table de 50 000 alertes se ferait
   * scanner intégralement au premier affichage — et le jour où elle en contiendra un
   * million, l'écran d'audit deviendrait lui-même l'incident.
   */
  private fenetre(f: FiltresAudit) {
    const jusqua = f.jusqua ? new Date(f.jusqua) : new Date();
    const depuis = f.depuis ? new Date(f.depuis) : new Date(jusqua.getTime() - 30 * 86_400_000);
    return { depuis, jusqua };
  }

  private where(f: FiltresAudit) {
    const { depuis, jusqua } = this.fenetre(f);
    return {
      createdAt: { gte: depuis, lte: jusqua },
      ...(f.type ? { type: f.type as never } : {}),
      ...(f.plaque ? { vehicle: { plate: { contains: f.plaque, mode: 'insensitive' as const } } } : {}),
    };
  }

  /** Extrait un champ de la trame brute — la position est celle du protocole Coban. */
  private champTrame(brut: string | null, index: number): string | null {
    if (!brut) return null;
    const p = brut.split(',');
    return p[index]?.trim() || null;
  }

  async lignes(f: FiltresAudit): Promise<{ total: number; page: number; taille: number; lignes: LigneAudit[] }> {
    const taille = Math.min(200, Math.max(10, f.taille ?? 50));
    const page = Math.max(1, f.page ?? 1);
    const where = this.where(f);

    const [total, rows] = await Promise.all([
      this.prisma.alert.count({ where }),
      this.prisma.alert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * taille,
        take: taille,
        select: {
          id: true, createdAt: true, type: true, severity: true, title: true,
          message: true, acknowledgedAt: true, payload: true,
          vehicle: { select: { plate: true, fleet: { select: { name: true } } } },
        },
      }),
    ]);

    const lignes = rows.map((a): LigneAudit => {
      const p = (a.payload ?? {}) as Record<string, unknown>;
      const brut = typeof p['raw'] === 'string' ? (p['raw'] as string) : null;
      const champ4 = this.champTrame(brut, 3);
      const pourcent = champ4 && /^\d{1,3}%$/.test(champ4) ? Number.parseInt(champ4, 10) : null;
      const imei = brut?.match(/imei:(\d{15})/)?.[1] ?? null;
      return {
        id: a.id,
        creeLe: a.createdAt.toISOString(),
        type: a.type,
        severite: a.severity,
        titre: a.title,
        message: a.message,
        acquittee: a.acknowledgedAt !== null,
        plaque: a.vehicle?.plate ?? null,
        flotte: a.vehicle?.fleet?.name ?? null,
        alarmeDecodee: typeof p['alarm'] === 'string' ? (p['alarm'] as string) : null,
        trameBrute: brut,
        imeiTrame: imei,
        batterie: pourcent,
        vitesseKmh: typeof p['speedKmh'] === 'number' ? (p['speedKmh'] as number) : null,
        contact: typeof p['ignition'] === 'boolean' ? (p['ignition'] as boolean) : null,
      };
    });

    return { total, page, taille, lignes };
  }

  /**
   * Regroupement PAR CAUSE : type d'alerte × alarme décodée × boîtier d'origine.
   *
   * C'est la vue qui répond en une ligne à « d'où viennent ces milliers d'alertes ? ».
   * Sur le cas réel, elle aurait immédiatement montré 41 468 lignes attribuées à un IMEI
   * qui n'équipe plus aucun véhicule — au lieu de deux heures d'enquête.
   */
  async causes(f: FiltresAudit): Promise<RegroupementCause[]> {
    const rows = await this.prisma.alert.findMany({
      where: this.where(f),
      orderBy: { createdAt: 'desc' },
      // Plafond dur : le regroupement se fait en mémoire, il ne doit jamais tirer
      // la table entière.
      take: 20_000,
      select: {
        type: true, createdAt: true, payload: true,
        vehicle: { select: { plate: true } },
      },
    });

    const par = new Map<string, RegroupementCause>();
    for (const a of rows) {
      const p = (a.payload ?? {}) as Record<string, unknown>;
      const brut = typeof p['raw'] === 'string' ? (p['raw'] as string) : null;
      const imei = brut?.match(/imei:(\d{15})/)?.[1] ?? null;
      const alarme = typeof p['alarm'] === 'string' ? (p['alarm'] as string) : null;
      const plaque = a.vehicle?.plate ?? null;
      const cle = `${a.type}|${alarme}|${imei}|${plaque}`;
      const iso = a.createdAt.toISOString();
      const e = par.get(cle);
      if (e) {
        e.nombre += 1;
        if (iso < e.premiere) e.premiere = iso;
        if (iso > e.derniere) e.derniere = iso;
      } else {
        par.set(cle, {
          type: a.type, alarmeDecodee: alarme, imeiTrame: imei, plaque,
          nombre: 1, premiere: iso, derniere: iso,
        });
      }
    }
    return [...par.values()].sort((x, y) => y.nombre - x.nombre);
  }
}
