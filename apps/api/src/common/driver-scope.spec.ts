import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { GenerateExcelDto } from '../reports/dto/generate-excel.dto';
import { GeneratePdfDto } from '../reports/dto/generate-pdf.dto';
import { ListTripsDto } from '../trips/dto/list-trips.dto';
import { normaliserDriverIdDto, resolveDriverScope, type PorteeConducteur } from './driver-scope';

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * LE FILTRE CONDUCTEUR A DEUX PORTES — ET ELLES DOIVENT RENDRE LA MÊME RÉPONSE
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * Les routes qui suivent ce filtre n'entrent pas toutes par le même chemin :
 *
 *   - `GET /trips`, `POST /reports/pdf` et `POST /reports/excel` passent d'abord par un DTO
 *     (`@Transform` + `@IsOptional` + `@Matches`), puis par `resolveDriverScope` ;
 *   - `GET /trips/daily-summary`, `GET /trips/period-charts`, `GET /reports/stats`,
 *     `GET /reports/csv` et `GET /reports/pdf` lisent un `@Query()` BRUT et ne traversent
 *     que `resolveDriverScope`.
 *
 * ── LE DÉFAUT QUE CE FICHIER FIGE ────────────────────────────────────────────────────────
 *
 * Relevé en revue contradictoire : `@Matches` s'applique à la valeur BRUTE et `@IsOptional()`
 * ne saute que `null`/`undefined`, alors que `resolveDriverScope` trime avant de tester. Les
 * deux portes divergeaient donc sur les mêmes entrées, et l'écran Rapports les interroge en
 * PARALLÈLE sur la même valeur :
 *
 *     ?driverId=          → 400 sur le tableau  | 200 sans filtre sur les trois agrégats
 *     ?driverId=%20none   → 400 sur le tableau  | 200 filtrés « sans conducteur »
 *
 * Résultat à l'écran : un bandeau de panne sur le TABLEAU, et juste au-dessus des compteurs,
 * des courbes et une synthèse qui décrivent tranquillement une population. Les deux moitiés
 * d'un même écran qui ne se parlent pas — précisément ce que ce filtre existe pour empêcher.
 *
 * ⚠️ CE QUI SUIT N'EST PAS UNE COLLECTION DE CAS LIMITES, C'EST LA SEULE ASSERTION QUI
 * EMPÊCHE LES DEUX PORTES DE RE-DIVERGER. Chacune est libre d'évoluer ; ce test exige qu'elles
 * évoluent ensemble.
 */

/** Un conducteur, en forme canonique (minuscules) — celle que Postgres stocke et rend. */
const UUID = '3f1c9a2e-5b7d-4c8e-9a1f-2d3e4b5c6a7b';

/**
 * Le pipe RÉEL de `main.ts`, aux mêmes options. Elles ne sont pas décoratives : c'est
 * `transform: true` qui fait tourner le `@Transform` du DTO, et `whitelist: true` qui
 * supprimerait le champ si un jour il perdait ses décorateurs de validation.
 */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

/**
 * L'issue d'une valeur : ce qui finit dans le `where`, ou le refus — avec sa NATURE. Un refus
 * qui ne serait pas un 400 (une `TypeError` non rattrapée, par exemple) est une divergence
 * autant qu'un désaccord sur la portée : le client verrait 500 d'un côté, 400 de l'autre.
 */
type Issue = { refus: true; nature: string } | { refus: false; portee: PorteeConducteur };

function issueDe(calcul: () => PorteeConducteur): Issue {
  try {
    return { refus: false, portee: calcul() };
  } catch (e) {
    return { refus: true, nature: e instanceof BadRequestException ? '400' : (e as Error).constructor.name };
  }
}

/**
 * Les TROIS DTO qui portent ce champ. Ils sont testés tous les trois parce que la
 * normalisation est posée trois fois : en retirer une seule remettrait UNE des routes en
 * désaccord avec les autres, et c'est l'écran Rapports qui les interroge ensemble.
 *
 * `base` porte les champs OBLIGATOIRES du DTO : sans eux le pipe refuserait pour une raison
 * qui n'a rien à voir avec le conducteur, et la comparaison ne prouverait plus rien.
 */
const PORTES_DTO: { nom: string; metatype: new () => object; type: 'query' | 'body'; base: Record<string, unknown> }[] = [
  { nom: 'ListTripsDto — GET /trips', metatype: ListTripsDto, type: 'query', base: {} },
  { nom: 'GeneratePdfDto — POST /reports/pdf', metatype: GeneratePdfDto, type: 'body', base: { from: '2026-06-01', to: '2026-07-01' } },
  { nom: 'GenerateExcelDto — POST /reports/excel', metatype: GenerateExcelDto, type: 'body', base: { from: '2026-06-01', to: '2026-07-01' } },
];

/** La porte AVEC DTO : le pipe, puis la résolution que le service applique à ce qu'il a reçu. */
async function porteAvecDto(porte: (typeof PORTES_DTO)[number], valeur: unknown): Promise<Issue> {
  let dto: { driverId?: string };
  try {
    dto = (await pipe.transform(
      { ...porte.base, driverId: valeur },
      { type: porte.type, metatype: porte.metatype },
    )) as { driverId?: string };
  } catch (e) {
    return { refus: true, nature: e instanceof BadRequestException ? '400' : (e as Error).constructor.name };
  }
  return issueDe(() => resolveDriverScope(dto.driverId));
}

/** La porte SANS DTO : celle des cinq routes qui lisent un `@Query()` brut. */
function porteSansDto(valeur: string | undefined): Issue {
  return issueDe(() => resolveDriverScope(valeur));
}

/**
 * Les entrées qui ont réellement divergé, plus celles qui les encadrent. `' none'` et `'NONE'`
 * ne sont pas des curiosités : le filtre est délibérément PARTAGEABLE PAR URL
 * (`/rapports?driver=…`), donc une adresse recopiée, tronquée ou retapée est le chemin
 * d'entrée normal.
 */
const CAS: [string, string | undefined][] = [
  ['paramètre absent', undefined],
  ['chaîne vide — le « ?driverId= » d’une intégration', ''],
  ['une espace seule', ' '],
  ['une espace devant « none » — une adresse recopiée', ' none'],
  ['une espace derrière « none »', 'none '],
  ['« NONE » en majuscules', 'NONE'],
  ['« None » capitalisé', 'None'],
  ['« none »', 'none'],
  ['un identifiant de conducteur', UUID],
  ['le même identifiant en MAJUSCULES', UUID.toUpperCase()],
  ['un identifiant précédé d’une espace', ` ${UUID}`],
  ['une valeur libre', 'tous'],
  ['une tentative d’injection', "' OR 1=1 --"],
  ['une clé d’imputation, pas un identifiant', `driver:${UUID}`],
];

describe.each(PORTES_DTO)('Filtre conducteur — $nom rend la même issue que la porte sans DTO', (porte) => {
  it.each(CAS)('%s', async (_libelle, valeur) => {
    expect(await porteAvecDto(porte, valeur)).toEqual(porteSansDto(valeur));
  });
});

/**
 * La porte sans DTO, prise pour elle-même. Ce que le test de parité ci-dessus ne peut PAS
 * attraper : les deux côtés l'appellent, donc ils s'accorderaient même sur une réponse fausse.
 */
describe('resolveDriverScope — trois issues, et pas une de plus', () => {
  it('rien de demandé : `undefined`, jamais `null`', () => {
    // ⚠️ La nuance est tout le sujet. `null` s'écrit `driverId IS NULL` dans le `where` : rendre
    // `null` pour « aucun filtre » ne montrerait que les trajets orphelins — 1 905 sur 1 956
    // chez « mh cars », un écran qui a l'air plein et qui a perdu tous les trajets attribués.
    expect(resolveDriverScope(undefined)).toBeUndefined();
    expect(resolveDriverScope(null)).toBeUndefined();
    expect(resolveDriverScope('')).toBeUndefined();
    expect(resolveDriverScope('   ')).toBeUndefined();
  });

  it('« none », quelle que soit la casse ou les blancs, devient `null`', () => {
    for (const v of ['none', 'NONE', 'None', ' none', 'none ', '  NoNe  ']) {
      expect(resolveDriverScope(v)).toBeNull();
    }
  });

  /**
   * ⚠️ LA FORME RENDUE EST LA FORME CANONIQUE, PAS LA VALEUR REÇUE. Un UUID en majuscules
   * descendrait sinon tel quel dans le `where`, pendant que le nom du conducteur imprimé sur
   * le PDF viendrait d'une seconde lecture faite sur une AUTRE écriture du même identifiant.
   * La colonne est `@db.Uuid` : Postgres stocke et rend en minuscules, la mettre en minuscules
   * ici est sans perte et aligne le filtre sur les clés `driver:<id>` de l'imputation.
   */
  it('un identifiant est rendu en MINUSCULES, quelle que soit la casse reçue', () => {
    expect(resolveDriverScope(UUID.toUpperCase())).toBe(UUID);
    expect(resolveDriverScope(` ${UUID.toUpperCase()} `)).toBe(UUID);
    expect(resolveDriverScope(UUID)).toBe(UUID);
  });

  it('tout le reste est refusé — la valeur finit dans un `where` Prisma', () => {
    for (const v of ['tous', 'null', "' OR 1=1 --", `driver:${UUID}`, '12345', 'none ou autre']) {
      expect(() => resolveDriverScope(v)).toThrow(BadRequestException);
    }
  });
});

/**
 * Ce que le DTO pose AVANT de valider. Testé à part parce que sa troisième issue est
 * contre-intuitive et délibérée : sur une valeur qu'il ne reconnaît pas, il rend la valeur
 * BRUTE — pour que `@Matches` échoue et rende le 400 qui NOMME le champ, plutôt qu'un message
 * générique sur un champ devenu `undefined`.
 */
describe('normaliserDriverIdDto — la normalisation posée sur les trois DTO', () => {
  it('vide ou blancs : `undefined`, donc sauté par @IsOptional — « aucun filtre »', () => {
    expect(normaliserDriverIdDto('')).toBeUndefined();
    expect(normaliserDriverIdDto('   ')).toBeUndefined();
  });

  it('forme reconnue : la forme canonique, celle que le résolveur lira ensuite', () => {
    expect(normaliserDriverIdDto(' none')).toBe('none');
    expect(normaliserDriverIdDto('NONE')).toBe('none');
    expect(normaliserDriverIdDto(UUID.toUpperCase())).toBe(UUID);
  });

  it('valeur non reconnue : la valeur BRUTE, pour que le 400 nomme `driverId`', () => {
    expect(normaliserDriverIdDto('tous')).toBe('tous');
    expect(normaliserDriverIdDto("' OR 1=1 --")).toBe("' OR 1=1 --");
  });

  it('ce qui n’est pas une chaîne passe intact — c’est à @Matches de le refuser', () => {
    // Un `?driverId=a&driverId=b` arrive en TABLEAU : le normaliseur ne doit pas le convertir
    // en une chaîne plausible, sinon la valeur validée ne serait plus celle qui a été envoyée.
    expect(normaliserDriverIdDto(['a', 'b'])).toEqual(['a', 'b']);
    expect(normaliserDriverIdDto(undefined)).toBeUndefined();
    expect(normaliserDriverIdDto(null)).toBeNull();
  });
});
