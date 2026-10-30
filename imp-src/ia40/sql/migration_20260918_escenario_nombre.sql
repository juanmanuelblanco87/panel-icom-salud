-- Migración 18/09/2026 -- nombre libre para cada escenario guardado del
-- Calculador de Importación (ej. "Con 10k de Shipping - escenario
-- competitivo"). Idempotente. app/api/calc/scenarios/route.ts ya corre este
-- mismo ALTER solo la primera vez, así que correrla a mano es opcional.
alter table calc_scenarios add column if not exists nombre_escenario text;
