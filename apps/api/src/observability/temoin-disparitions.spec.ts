import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TEMOIN DES DISPARITIONS — TRK-035.
 *
 * Le declencheur est du SQL : aucun test unitaire ne peut l'executer. Ce qui SUIT
 * verrouille donc les trois proprietes dont la perte serait SILENCIEUSE — le
 * declencheur continuerait d'exister, de ne rien casser, et de ne rien voir.
 *
 * C'est exactement le defaut de TRK-026 : une sonde qui ne peut pas rendre « en
 * panne ». On ne le rejoue pas ici.
 *
 * (Le comportement, lui, a ete exerce en base le 22/08 : DELETE de 2 lignes sur 3
 * → 1 constat avec les bonnes bornes ; DELETE sans effet → AUCUN constat ;
 * TRUNCATE de 209 lignes → 1 constat a 209.)
 */
describe('Temoin des disparitions — proprietes du declencheur', () => {
  const dossier = join(__dirname, '..', '..', 'prisma', 'migrations');
  const migration = readdirSync(dossier).find((d) => d.includes('temoin_disparitions'));
  const sql = readFileSync(join(dossier, migration!, 'migration.sql'), 'utf8');

  it('🔑 TRUNCATE est intercepte AVANT — sinon il compterait une table deja vide', () => {
    // Un `AFTER TRUNCATE` s'executerait sur une table vidée : le constat dirait
    // « 0 ligne ». Le temoin existerait, ne casserait rien, et ne verrait rien —
    // precisement l'operation qui ne laissait deja aucune trace.
    expect(sql).toMatch(/BEFORE TRUNCATE ON error_logs/);
    expect(sql).toMatch(/BEFORE TRUNCATE ON alerts/);
    expect(sql).not.toMatch(/AFTER TRUNCATE/);
  });

  it('🔑 le DELETE est au niveau INSTRUCTION, avec table de transition', () => {
    // `FOR EACH ROW` ecrirait 170 000 constats pour la purge nocturne des wire logs
    // appliquee un jour a une grosse table : le temoin deviendrait la panne.
    expect(sql).toMatch(/REFERENCING OLD TABLE AS supprimees/);
    expect(sql).toMatch(/FOR EACH STATEMENT/);
    expect(sql).not.toMatch(/FOR EACH ROW/);
  });

  it("🔑 une instruction sans effet n'ecrit AUCUN constat", () => {
    // La purge nocturne passe a vide sur error_logs depuis des mois. Sans ce test,
    // elle ecrirait un constat par nuit et noierait le vrai signal.
    expect(sql).toMatch(/IF nb IS NULL OR nb = 0 THEN\s*\n\s*RETURN NULL;/);
  });

  it('couvre les DEUX tables dont des lignes ont reellement disparu', () => {
    for (const table of ['error_logs', 'alerts']) {
      expect(sql).toMatch(new RegExp(`AFTER DELETE ON ${table}`));
      expect(sql).toMatch(new RegExp(`BEFORE TRUNCATE ON ${table}`));
    }
  });

  it("capture de quoi NOMMER l'auteur, pas seulement le compter", () => {
    for (const champ of ['current_user', 'session_user', 'inet_client_addr', 'current_query', 'pg_backend_pid']) {
      expect(sql).toContain(champ);
    }
  });

  it('ne bloque jamais : aucun RAISE EXCEPTION dans le chemin nominal', () => {
    // Un temoin qui fait echouer la purge transformerait une observation en panne.
    expect(sql).not.toMatch(/RAISE EXCEPTION/);
  });
});
