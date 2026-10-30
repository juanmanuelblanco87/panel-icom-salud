-- 01/09/2026 ("crear las principales categorias -- replicar las del
-- arbol de importacion -- y guardar un snap diario para documentar el
-- sell-out"): pipeline de sell-out de Mercado Libre por categoria,
-- mismo criterio que ya usa el modulo de importaciones (crudo diario +
-- agregado, ver trade_records/monthly_brand_model_agg) -- reusa la
-- MISMA tabla `categories` (las 9 categorias del arbol de importacion
-- ya existen ahi), no se crea una taxonomia paralela.
--
-- Fuente del dato: actor de Apify karamelo/mercadolibre-scraper-
-- espanol-castellano (ver app/api/meli-sellout-snapshot/route.ts) --
-- elegido en vivo el 01/09/2026 sobre scrapers_lat/mercadolibre-
-- scraper: mas barato ($1.20 vs $6.15 cada 1000) Y scrapers_lat quedo
-- bloqueado por el anti-bot de MercadoLibre en el plan gratis de Apify
-- (pide upgrade pago o proxy propio), mientras que karamelo funciono
-- limpio a la primera.

-- Mapeo categoria -> termino de busqueda en Mercado Libre + cuanto
-- traer por dia. max_results es POR CATEGORIA (no un numero global) --
-- pedido explicito del usuario ("depende de la cantidad de
-- publicaciones de la categoria"), 50 alcanza para sillas de ruedas
-- (2.354 resultados totales reales, confirmado en vivo) pero otras
-- categorias mas chicas pueden necesitar menos, o mas grandes mas --
-- se ajusta por fila sin tocar codigo.
create table if not exists category_meli_keywords (
  id serial primary key,
  category_id int not null references categories(id) on delete cascade,
  keyword text not null,
  max_results int not null default 50,
  activo boolean not null default true,
  unique (category_id)
);

-- Snapshot crudo: una fila por publicacion encontrada, por categoria,
-- por dia. `raw` guarda la fila completa del actor tal cual vino (por
-- si hace falta re-derivar un campo despues sin re-scrapear).
create table if not exists meli_daily_snapshot (
  id bigserial primary key,
  category_id int not null references categories(id) on delete cascade,
  snapshot_date date not null,
  listing_id text not null,
  title text,
  price numeric,
  currency text,
  seller_name text,
  official_store boolean,
  sold_quantity numeric,
  position int,
  free_shipping boolean,
  total_results_category int,
  raw jsonb not null,
  ingested_at timestamptz not null default now(),
  unique (category_id, snapshot_date, listing_id)
);
create index if not exists idx_meli_snapshot_cat_date on meli_daily_snapshot (category_id, snapshot_date);

-- Agregado diario por categoria -- para graficos de tendencia sin
-- tener que sumar sobre meli_daily_snapshot en cada carga, mismo
-- criterio que monthly_brand_model_agg.
create table if not exists meli_daily_agg (
  id bigserial primary key,
  category_id int not null references categories(id) on delete cascade,
  snapshot_date date not null,
  total_listings_scraped int not null default 0,
  total_results_category int,
  total_sold_quantity numeric not null default 0,
  avg_price numeric,
  min_price numeric,
  max_price numeric,
  unique (category_id, snapshot_date)
);
create index if not exists idx_meli_agg_cat_date on meli_daily_agg (category_id, snapshot_date);

-- Seed inicial de keywords -- primera pasada razonable, editable
-- después sin tocar código (UPDATE directo sobre esta tabla). Algunas
-- categorías (almohadones_ortopedicos, sillas_ducha) ya se sabe que su
-- NCM trae ruido no-ortopédico (ver docs/PROYECTO.md) -- el término de
-- búsqueda de Meli intenta acotar a lo ortopédico específicamente,
-- pero conviene revisar el primer snapshot antes de confiar en él.
insert into category_meli_keywords (category_id, keyword, max_results)
select id, keyword, 50 from (values
  ('sillas_de_ruedas', 'silla de ruedas'),
  ('sillas_ruedas_electricas', 'silla de ruedas electrica'),
  ('andadores', 'andador ortopedico'),
  ('bastones', 'baston ortopedico'),
  ('calzado_ortopedico', 'calzado ortopedico'),
  ('almohadones_ortopedicos', 'almohadon ortopedico antiescaras'),
  ('sillas_ducha', 'silla de ducha ortopedica'),
  ('elevadores_inodoro', 'elevador de inodoro'),
  ('camas_hospitalarias', 'cama hospitalaria ortopedica')
) as k(slug, keyword)
join categories c on c.slug = k.slug
on conflict (category_id) do nothing;
