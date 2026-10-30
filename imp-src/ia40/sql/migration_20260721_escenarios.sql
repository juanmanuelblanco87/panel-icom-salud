-- Migración 21/07/2026 -- correr una sola vez en Neon (SQL Editor).
-- Es idempotente: se puede correr de nuevo sin romper nada si alguna
-- parte ya existiera.

-- 1) Columnas nuevas en calc_supuestos (tope de Tasa de Estadística,
--    capacidad del 20FT, y fecha de la última actualización del tipo de
--    cambio via BCRA). Si ya las agregaste en una sesión anterior, estos
--    ALTER no hacen nada (IF NOT EXISTS).
alter table calc_supuestos add column if not exists tasa_estadistica_tope_usd numeric not null default 180;
alter table calc_supuestos add column if not exists capacidad_20ft_m3 numeric not null default 28;
alter table calc_supuestos add column if not exists tipo_cambio_fuente_fecha text;

-- 2) Repositorio de escenarios guardados del Calculador de Importación.
create table if not exists calc_scenarios (
  id serial primary key,
  usuario text not null,
  product_type_id int references calc_product_types(id) on delete set null,
  nombre_producto text not null,
  fob_usd numeric not null,
  pvp_meli_ars_con_iva numeric,
  pvp_fuente text,
  tipo_cambio_ars numeric,
  arancel_pct numeric,
  iva_pct numeric,
  cbm_m3 numeric,
  tamano_envio text,
  envio_fuente text,
  margen_meli_pct numeric,
  margen_distribucion_pct numeric,
  supuestos_json jsonb not null,
  product_type_json jsonb not null,
  resultado_json jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists calc_scenarios_usuario_idx on calc_scenarios (usuario);
