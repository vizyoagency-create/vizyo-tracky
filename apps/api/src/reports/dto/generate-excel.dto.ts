import { Transform } from 'class-transformer';
import { IsDateString, IsOptional, IsUUID, Matches } from 'class-validator';
import { CONDUCTEUR_AUCUN, FILTRE_CONDUCTEUR_REGEX, normaliserDriverIdDto } from '../../common/driver-scope';

/**
 * Sprint 5 — Body du POST /api/reports/excel.
 *
 * L'export Excel « soigné » couvre UN VÉHICULE ou TOUT UN PÉRIMÈTRE (société, groupe)
 * sur une période → un classeur .xlsx mis en forme. Le périmètre utilisateur est vérifié
 * côté service (ReportExcelService) : ce qui est demandé est toujours intersecté avec les
 * véhicules réellement accessibles à l'appelant, sinon 403.
 */
export class GenerateExcelDto {
  /**
   * ── L'EXCEL N'EXISTAIT QUE PAR VÉHICULE ────────────────────────────────────────────
   *
   * Un gestionnaire qui voulait le mois de son parc devait lancer quarante exports et les
   * recoller à la main, ou se rabattre sur le CSV brut. `vehicleId` devient donc FACULTATIF :
   * absent, le classeur porte tout le périmètre demandé, avec une feuille de synthèse par
   * véhicule en tête.
   *
   * ⚠️ Ces trois champs ne DESSERRENT rien : le service intersecte toujours avec les
   * véhicules réellement accessibles à l'appelant.
   */
  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  /** Restreint à un groupe de véhicules. Ignoré si `vehicleId` est fourni. */
  @IsOptional()
  @IsUUID()
  groupId?: string;

  /** Société visée — un super-administrateur doit pouvoir la désigner. */
  @IsOptional()
  @IsUUID()
  fleetId?: string;

  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;

  /**
   * ── LE FILTRE CONDUCTEUR SUIT LE CLASSEUR (F13) ──────────────────────────────────────
   *
   * Un classeur ouvert après un écran filtré sur une personne se lit comme le sien. Sans ce
   * champ, il portait tout le parc — et c'est le pire des fichiers faux : celui qui a l'air
   * juste, qu'on met sur une table de réunion, et qu'on ne rapproche jamais de l'écran qui
   * l'a produit.
   *
   * Deux formes, comme partout : un identifiant de conducteur, ou `none` pour les trajets
   * SANS conducteur. Même expression partagée que `resolveDriverScope`, qui la revalide dans
   * le contrôleur avant de descendre dans les `where` du service.
   *
   * ⚠️ Le classeur DIT sur quel conducteur il porte — la feuille de synthèse porte la
   * mention, et la feuille des passages en station précise ce qu'elle ne peut PAS filtrer
   * (une station est un arrêt du véhicule, pas de la personne).
   */
  // ⚠️ NORMALISÉ AVANT D'ÊTRE VALIDÉ. `@Matches` porte sur la valeur BRUTE et `@IsOptional()` ne
  // saute que `null`/`undefined` : sans cette ligne, `?driverId=` et `?driverId=%20none` étaient
  // refusés ICI (400) et acceptés par les trois routes qui lisent des `@Query()` bruts — le
  // tableau en panne au-dessus de compteurs qui décrivaient tranquillement une population.
  @Transform(({ value }) => normaliserDriverIdDto(value))
  @IsOptional()
  @Matches(FILTRE_CONDUCTEUR_REGEX, {
    message: `driverId doit être un identifiant de conducteur ou « ${CONDUCTEUR_AUCUN} ».`,
  })
  driverId?: string;
}
