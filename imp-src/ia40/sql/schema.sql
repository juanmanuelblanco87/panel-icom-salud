-- Esquema para el dashboard IA40 (Cobus Group)
-- Pensado para crecer por categorias (sillas de ruedas, andadores, bastones, ...)
-- sin tener que rehacer el modelo cada vez.

create table if not exists categories (
  id serial primary key,
  slug text unique not null,          -- 'sillas_de_ruedas', 'andadores', 'bastones'
  name text not null,                 -- nombre para mostrar en el front
  created_at timestamptz not null default now()
);

-- Una categoria puede mapear a una o varias posiciones arancelarias (NCM).
create table if not exists category_ncm_codes (
  id serial primary key,
  category_id int not null references categories(id) on delete cascade,
  ncm_code text not null,             -- ej: '8713.10.00'
  description text,
  unique (category_id, ncm_code)
);

-- Mapeo de campos: como el 'schema' que devuelve la API es dinamico y todavia
-- no confirmamos los nombres exactos de marca/modelo para sillas de ruedas,
-- cada categoria define de que campo del JSON crudo sale cada dimension.
-- Asi, agregar una categoria nueva con campos distintos no requiere tocar codigo.
create table if not exists field_mappings (
  id serial primary key,
  category_id int not null references categories(id) on delete cascade,
  target_field text not null check (target_field in ('marca','modelo','proveedor','fecha','fob_dolars','unidades')),
  source_json_path text not null,     -- ej: 'marca_comercial', 'modelo_producto'
  unique (category_id, target_field)
);

-- Registro crudo: una fila por registro devuelto por POST /data.
-- Se guarda todo el JSON tal cual viene, mas algunas columnas indexadas
-- para no tener que parsear JSONB en cada query.
create table if not exists trade_records (
  id bigserial primary key,
  category_id int not null references categories(id) on delete cascade,
  ncm_code text not null,
  period date not null,               -- primer dia del mes del registro (YYYY-MM-01)
  cuit text,
  raw jsonb not null,                 -- fila completa devuelta por la API
  fob_dolars numeric,
  marca text,                         -- calculado por el parser de la categoria (lib/parsers), si tiene uno
  modelo text,                        -- idem
  color text,                         -- idem (paso 10 del parser de sillas de ruedas)
  segmento text,                      -- idem (paso 11 del parser de sillas de ruedas)
  ingested_at timestamptz not null default now(),
  source_hash text unique             -- hash del registro para evitar duplicados en re-sync
);

create index if not exists idx_trade_records_cat_period on trade_records (category_id, period);
create index if not exists idx_trade_records_ncm on trade_records (ncm_code);
create index if not exists idx_trade_records_raw_gin on trade_records using gin (raw);

-- Agregado mensual por marca/modelo/proveedor, para que el front no tenga
-- que agregar en el momento. Se recalcula en cada sync (ver /api/sync).
create table if not exists monthly_brand_model_agg (
  id bigserial primary key,
  category_id int not null references categories(id) on delete cascade,
  period date not null,
  marca text,
  modelo text,
  proveedor text,
  color text,
  segmento text,
  total_fob_dolars numeric not null default 0,
  total_unidades numeric not null default 0,
  record_count int not null default 0,
  unique (category_id, period, marca, modelo, proveedor, color, segmento)
);

create index if not exists idx_monthly_agg_lookup on monthly_brand_model_agg (category_id, period);

-- IA40 no siempre trae marca/modelo directo en el JSON. Cuando no viene, se
-- identifica manualmente por empresa importadora (campo "nombre") y se carga
-- aca via la pantalla /admin. Se va completando de a poco.
create table if not exists provider_brand_map (
  id serial primary key,
  category_id int not null references categories(id) on delete cascade,
  importer_name text not null,
  marca text not null,
  modelo text,
  updated_at timestamptz not null default now(),
  unique (category_id, importer_name)
);

-- Un importador puede traer varias marcas, y una marca varios modelos.
-- Cuando la clasificacion por importador entero (provider_brand_map) no
-- alcanza, se puede clasificar cada linea de detalle (cada registro de
-- trade_records) por separado aca. Tiene prioridad sobre provider_brand_map.
create table if not exists record_brand_map (
  id serial primary key,
  trade_record_id bigint not null references trade_records(id) on delete cascade,
  marca text not null,
  modelo text,
  updated_at timestamptz not null default now(),
  unique (trade_record_id)
);

-- Historial de corridas de sync, para debug y para saber desde que fecha
-- retomar la proxima vez (sync incremental).
create table if not exists sync_runs (
  id serial primary key,
  category_id int not null references categories(id) on delete cascade,
  ncm_code text not null,
  period_start date not null,
  period_end date not null,
  rows_ingested int not null default 0,
  status text not null default 'ok',  -- 'ok' | 'error'
  error_message text,
  run_at timestamptz not null default now()
);

-- Imagen representativa por marca/modelo, conseguida via Google Custom
-- Search API (busqueda de imagenes). Se completa de a poco en un cron
-- separado (/api/sync-images, ver vercel.json) para no gastar de una toda
-- la cuota diaria gratis de la API. "status" evita re-buscar lo mismo en
-- cada corrida: 'found' y 'not_found' quedan fijos, solo 'error' se
-- reintenta en la proxima corrida.
create table if not exists model_images (
  id serial primary key,
  category_id int not null references categories(id) on delete cascade,
  marca text not null,
  modelo text not null,
  image_url text,
  thumbnail_url text,
  source_url text,
  status text not null default 'pending', -- 'pending' | 'found' | 'not_found' | 'error'
  error_message text,
  fetched_at timestamptz,
  created_at timestamptz not null default now(),
  unique (category_id, marca, modelo)
);

create index if not exists idx_model_images_status on model_images (category_id, status);

-- Precio de Venta al Publico (PVP) estimado en USD por marca/modelo,
-- conseguido via OpenAI (tool web_search): o bien ON DEMAND (click en
-- "Consultar" en la tabla, ver lib/pvpFinder.ts) o bien aprovechando la
-- MISMA busqueda que ya hace el tamizador de segmentos para identificar el
-- producto (ver lib/aiClassifier.ts + app/api/sieve/route.ts) -- en ambos
-- casos el modelo busca varios precios en la web y elige el valor que mas se
-- repite (o el mas consistente/representativo). "status" evita re-consultar
-- lo mismo en cada click: 'found' y 'not_found' quedan cacheados para
-- siempre, solo 'error' se reintenta. "fuente_url" guarda el link de la
-- publicacion de donde salio el precio, para poder verificarlo (se muestra
-- como link clickeable en el dashboard).
create table if not exists model_pvp (
  id serial primary key,
  category_id int not null references categories(id) on delete cascade,
  marca text not null,
  modelo text not null,
  pvp_usd numeric,
  confianza text, -- 'alta' | 'media' | 'baja'
  fuentes_consistentes int,
  razonamiento text,
  fuente_url text,
  status text not null default 'pending', -- 'pending' | 'found' | 'not_found' | 'error'
  error_message text,
  fetched_at timestamptz,
  created_at timestamptz not null default now(),
  unique (category_id, marca, modelo)
);

create index if not exists idx_model_pvp_status on model_pvp (category_id, status);

-- Seed inicial: categoria piloto.
insert into categories (slug, name) values ('sillas_de_ruedas', 'Sillas de ruedas')
  on conflict (slug) do nothing;

-- ===================== Calculador de Importacion (20/07/2026) =====================
-- Modulo nuevo e independiente del catalogo de categorias de IA40 de arriba
-- (esas 9 categorias sirven para clasificar datos de importacion YA
-- OCURRIDOS). El calculador evalua productos HIPOTETICOS/nuevos a partir de
-- un FOB, con su propio catalogo abierto de "tipos de producto" -- pedido
-- explicito del usuario: "hay que dejar la logica abierta a cualquier
-- categoria, si mañana quisiera traer televisores con una consulta a IA
-- deberiamos cambiar los supuestos que aplican en esa NCM". Ver racional
-- completo y formulas en docs/PROYECTO.md.

-- Supuestos generales: fila unica (id=1), editable desde la UI de la
-- calculadora. El "costo fijo por CBM utilizable" (USD/CBM) NO se guarda:
-- se calcula en el momento como
--   (flete_maritimo_usd + forwarder_usd + despachante_usd + thc_usd +
--    flete_local_usd + manipuleo_usd) / capacidad_cbm_contenedor
-- para que cualquier edicion de un componente se refleje al instante.
create table if not exists calc_supuestos (
  id int primary key default 1,
  tipo_cambio_ars numeric not null default 1450,
  comision_ml_pct numeric not null default 0.15,
  iibb_pct numeric not null default 0.045,
  pads_pct numeric not null default 0.01,
  tasa_estadistica_pct numeric not null default 0.03,
  -- Tope real en USD de la Tasa de Estadistica de Aduana (21/07/2026,
  -- pedido explicito del usuario: "Aplica el tope"): sin este tope el
  -- calculo la aplicaba como % puro sobre el CIF sin limite, lo cual no
  -- refleja la normativa real (tiene un techo en USD).
  tasa_estadistica_tope_usd numeric not null default 180,
  ley_25413_pct numeric not null default 0.01,
  seguro_usd_unidad numeric not null default 1.00,
  -- Costo de envio de Mercado Envios (20/07/2026, pedido explicito del
  -- usuario con los numeros reales de la tabla de MeLi): si el PVP con IVA
  -- es MENOR a umbral_bajo_valor_ars, el vendedor paga solo este Fee fijo
  -- de "producto de bajo valor" (no el costo de envio real).
  fee_bajo_ticket_ars numeric not null default 2000,
  -- Si el PVP con IVA es MAYOR O IGUAL a este umbral, en vez del Fee de
  -- bajo valor se paga el costo de envio real segun el tamaño del producto
  -- (envio_chico_ars / envio_mediano_ars / envio_grande_ars, mas abajo).
  umbral_bajo_valor_ars numeric not null default 33000,
  -- PVP a Distribucion = PVP MeLi x (1 - este %). Pedido explicito del
  -- usuario: "sobre el PVP de MeLi colocar un 35% de descuento (35% GM
  -- para el minorista)".
  descuento_distribucion_pct numeric not null default 0.35,
  -- Flete maritimo internacional (China -> Buenos Aires, contenedor 40HQ):
  -- estimado por IA (ver lib/calcAi.ts), editable a mano si se consigue una
  -- cotizacion mejor -- pedido explicito del usuario, 20/07/2026.
  flete_maritimo_usd numeric not null default 3300,
  flete_confianza text,      -- 'alta' | 'media' | 'baja'
  flete_razonamiento text,
  flete_status text not null default 'pending', -- 'pending' | 'found' | 'error'
  flete_fetched_at timestamptz,
  -- Resto de costos fijos por contenedor (no se piden por IA, se cargan a
  -- mano igual que en la planilla original del cliente):
  forwarder_usd numeric not null default 800,
  despachante_usd numeric not null default 750,
  thc_usd numeric not null default 1300,
  flete_local_usd numeric not null default 380,
  manipuleo_usd numeric not null default 250,
  capacidad_cbm_contenedor numeric not null default 64.6,
  -- Capacidad util de un contenedor 20FT en m3, usada solo para mostrar
  -- "Unidades por contenedor: 40HC / 20FT" en pantalla (21/07/2026, pedido
  -- explicito del usuario) -- capacidad_cbm_contenedor de arriba sigue
  -- siendo la referencia para el 40HC.
  capacidad_20ft_m3 numeric not null default 28,
  -- Costo de envio de Mercado Envios (ARS con IVA) segun el tamaño del
  -- producto -- pedido explicito del usuario (20/07/2026): "productos
  -- chicos (8000 ar$) productos medianos 12000 productos grandes (silla
  -- de ruedas) 32000". Solo aplica si PVP con IVA >= umbral_bajo_valor_ars.
  envio_chico_ars numeric not null default 8000,
  envio_mediano_ars numeric not null default 12000,
  envio_grande_ars numeric not null default 32000,
  -- Fecha (segun el BCRA) de la ultima vez que se actualizo el tipo de
  -- cambio via /api/calc/supuestos/refresh-tipo-cambio (21/07/2026) -- null
  -- si nunca se uso ese boton (el tipo de cambio se sigue editando a mano).
  tipo_cambio_fuente_fecha text,
  updated_at timestamptz not null default now(),
  check (id = 1)
);
insert into calc_supuestos (id) values (1) on conflict (id) do nothing;

-- Catalogo abierto de "tipos de producto" del calculador (no confundir con
-- la tabla `categories`: esta es exclusiva del calculador y se crea sobre
-- la marcha, sin lista fija). Arancel, IVA y CBM se estiman por IA (OpenAI
-- + tool web_search, ver lib/calcAi.ts) la primera vez que se calcula ese
-- tipo de producto, y quedan cacheados aca -- editables a mano y con boton
-- de "recalcular" (mismo patron que model_pvp/model_images). El PVP de
-- mercado tambien se estima por IA, pero SOLO si el usuario no carga un
-- PVP manual al correr un calculo -- pedido explicito del usuario: "el PVP
-- es algo que tambien quiero colocar yo manualmente, pero si no se coloca
-- que lo calcule por IA".
create table if not exists calc_product_types (
  id serial primary key,
  nombre text not null unique,
  ncm_code text, -- opcional, solo informativo/referencia

  arancel_pct numeric,
  arancel_confianza text,
  arancel_razonamiento text,
  arancel_status text not null default 'pending', -- 'pending' | 'found' | 'error'
  arancel_fetched_at timestamptz,

  iva_pct numeric,
  iva_confianza text,
  iva_razonamiento text,
  iva_status text not null default 'pending',
  iva_fetched_at timestamptz,

  -- Trader NO es por IA: default 0%, se edita a mano solo para el caso
  -- puntual donde SI se paga comision de agente de compra -- pedido
  -- explicito del usuario: "el trader dejalo 0% y dejalo editable en el
  -- caso que tengamos que abonarlo".
  trader_pct numeric not null default 0,

  -- Categoria de tamaño para el costo de envio de Mercado Envios (ver
  -- calc_supuestos.envio_chico_ars/envio_mediano_ars/envio_grande_ars) --
  -- reemplaza al viejo campo manual "envio_ars_con_iva" (20/07/2026): el
  -- usuario aclaro que MeLi cobra segun una tabla de tamaño, no un monto
  -- libre por producto. NO aplica al canal Distribucion (el distribuidor
  -- arregla su propia logistica).
  tamano_envio text not null default 'mediano'
    check (tamano_envio in ('chico', 'mediano', 'grande')),

  cbm_m3 numeric,
  cbm_confianza text,
  cbm_razonamiento text,
  cbm_status text not null default 'pending',
  cbm_fetched_at timestamptz,

  pvp_ars_estimado numeric, -- con IVA
  pvp_confianza text,
  pvp_razonamiento text,
  pvp_status text not null default 'pending',
  pvp_fetched_at timestamptz,

  -- ===== Integracion API publica de Mercado Libre (20/07/2026) =====
  -- Pedido explicito del usuario: "como hacemos para que le pegue
  -- realmente a la api?" -- ver lib/meliApi.ts. category_id se predice
  -- automaticamente (domain_discovery) y se cachea; peso_kg se estima por
  -- IA como el resto de los campos; envio_meli_api_ars es el resultado de
  -- la ultima consulta exitosa a listing_prices (se usa en el calculo SI
  -- esta disponible, si no se cae a la tabla fija tamano_envio de arriba).
  ml_category_id text,
  ml_category_nombre text,
  peso_kg numeric,
  peso_confianza text,
  peso_razonamiento text,
  peso_status text not null default 'pending',
  peso_fetched_at timestamptz,
  envio_meli_api_ars numeric,
  envio_meli_api_status text not null default 'pending', -- 'pending'|'found'|'error'
  envio_meli_api_razonamiento text, -- guarda el JSON crudo (recortado) o el error, para poder auditar
  envio_meli_api_fetched_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Tokens OAuth de la cuenta real de Mercado Libre de Cobus (20/07/2026).
-- Fila unica (id=1). Necesario porque el costo de envio con
-- logistic_type=fulfillment (Mercado Envios Full) depende del contrato de
-- fulfillment de la cuenta -- la API publica sin auth devuelve 403 para
-- ese caso (confirmado en produccion). Ver lib/meliApi.ts y
-- app/api/calc/meli-oauth/*. client_id/client_secret NO se guardan aca,
-- viven como variables de entorno (MELI_CLIENT_ID / MELI_CLIENT_SECRET).
create table if not exists meli_oauth (
  id int primary key default 1,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  check (id = 1)
);
insert into meli_oauth (id) values (1) on conflict (id) do nothing;

-- Repositorio de escenarios guardados del Calculador de Importacion
-- (21/07/2026, pedido explicito del usuario: "Hay que dejar un repositorio
-- para guardar la simulacion de escenarios ya creados y que guarde todas
-- las variables estaticas (dolar a ese momento, cbm, pvp etc.) y antes de
-- guardarlo preguntar usuario para luego poder filtrar por usuario"). Cada
-- fila es una FOTO completa de un calculo puntual (supuestos + producto +
-- resultado, tal cual estaban en pantalla al momento de guardar) -- no una
-- referencia viva: si despues cambia el tipo de cambio o el CBM del
-- producto, los escenarios viejos no se ven afectados. Las columnas
-- sueltas son solo para poder filtrar/listar rapido sin tener que parsear
-- el JSON; el detalle completo vive en las 3 columnas jsonb.
create table if not exists calc_scenarios (
  id serial primary key,
  usuario text not null,
  product_type_id int references calc_product_types(id) on delete set null,
  nombre_producto text not null,
  fob_usd numeric not null,
  pvp_meli_ars_con_iva numeric,
  pvp_fuente text, -- 'manual' | 'cache' | 'ia'
  tipo_cambio_ars numeric,
  arancel_pct numeric,
  iva_pct numeric,
  cbm_m3 numeric,
  tamano_envio text,
  envio_fuente text, -- 'api' | 'tabla_fija'
  margen_meli_pct numeric,
  margen_distribucion_pct numeric,
  supuestos_json jsonb not null,
  product_type_json jsonb not null,
  resultado_json jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists calc_scenarios_usuario_idx on calc_scenarios (usuario);
