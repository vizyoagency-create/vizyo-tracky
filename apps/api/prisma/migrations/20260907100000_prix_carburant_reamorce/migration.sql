-- Prix carburant : reamorcage du defaut, et correction des societes existantes.
--
-- Le defaut valait 1.85 EUR/L depuis sa creation (<< moyenne FR fin 2025 >>). Mesure le
-- 2026-09-07 contre l'API officielle data.economie.gouv.fr : moyenne nationale du gazole
-- 2.277 EUR/L sur 9555 stations, E10 2.114 EUR/L sur 6856. Le defaut se trouvait donc 21 %
-- sous le marche, et AUCUNE societe ne l'avait jamais surcharge -- il n'existe pas d'ecran
-- pour le faire. Le cout carburant de tous les rapports etait sous-estime d'un cinquieme.
--
-- /!\ CE N'EST PAS UN CORRECTIF DURABLE, c'est un reamorcage. Un nombre ecrit en dur se
-- perimera de nouveau. La correction de fond -- deriver le prix des passages en station deja
-- captes, ou rafraichir ce champ automatiquement depuis la meme API -- est a decider.
ALTER TABLE "fleets" ALTER COLUMN "fuelPriceEurL" SET DEFAULT 2.277;

-- Les societes qui portaient encore la valeur perimee, ou une valeur inferieure au marche.
-- Chacune recoit le prix de son carburant DOMINANT : gazole pour un parc diesel, E10 sinon.
-- Idempotent : ne touche que ce qui est reste sous l'ancien defaut.
UPDATE "fleets" f SET "fuelPriceEurL" = CASE
  WHEN (
    SELECT COUNT(*) FILTER (WHERE v."energy" = 'DIESEL')
         > COUNT(*) FILTER (WHERE v."energy" IS DISTINCT FROM 'DIESEL')
    FROM "vehicles" v WHERE v."fleetId" = f."id"
  ) THEN 2.277
  ELSE 2.114
END
WHERE f."fuelPriceEurL" <= 1.85;
