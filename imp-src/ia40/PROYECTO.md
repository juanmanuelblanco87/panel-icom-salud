# Módulo de Importaciones — Icom Salud / Cobus Group

Documentación técnica completa del proyecto. Última actualización: 17/07/2026.

Este documento describe qué hace la app, cómo está armada, de dónde salen los
datos, y el historial de bugs importantes ya resueltos (para no repetirlos).
Está pensado para que cualquiera (incluida una sesión nueva de Claude sin
contexto previo) pueda entender el proyecto entero leyendo solo este archivo.

## 1. Qué es esto

Dashboard interno de inteligencia comercial que trackea, mes a mes, las
importaciones argentinas de equipamiento médico/ortopédico (sillas de ruedas,
andadores, bastones, camas hospitalarias, etc.), agrupadas por marca, modelo,
proveedor/importador, color y segmento. Los datos crudos salen de **IA40**
(la plataforma de inteligencia de comercio exterior de **Cobus Group**), que
expone despachos de aduana filtrados por posición arancelaria (NCM).

La app corre en **Vercel** (Next.js 14, App Router) contra una base
**Postgres en Neon**. Un cron diario sincroniza los datos nuevos.

**Flujo de trabajo del equipo (importante):** no se usa git localmente. Los
cambios de código se editan pegando el contenido completo del archivo en la
interfaz web de GitHub (Add file / editar archivo existente), y el SQL se
corre a mano en la consola de Neon. No hay `git push` ni deploy por CLI.

## 2. Arquitectura general

```
IA40 (Cobus Group)  →  /api/sync (cron diario, Vercel)  →  Neon Postgres  →  Dashboard (Next.js)
        ↑                                                        ↑
        |                                                        |
  refresh_token.py (PC del usuario, Windows)            /admin (correcciones manuales)
  mantiene el JWT de IA40 actualizado en la tabla
  app_settings, vía login automatizado con Playwright
```

Dos flujos de lectura de IA40 conviven, según si la categoría tiene un
parser de marca/modelo registrado o no:

- **`lib/ia40.ts`** — cliente del endpoint viejo `POST /data`, paginado. Lee
  el JWT directo de la variable de entorno `IA40_JWT`. Se usa para categorías
  **sin** parser registrado (`categoryUsesExportFlow(slug)` da `false`).
- **`lib/ia40Export.ts`** — cliente del flujo de **exportación** (`/export/data`
  + polling de `/notification/{id}` + descarga de un ZIP/CSV en S3). Es el
  único que trae la columna `SUB ITEMS - SUFIJOS`, necesaria para identificar
  marca/modelo automáticamente. Lee el JWT de la tabla `app_settings`
  (`key='ia40_jwt'`), **no** de una variable de entorno. Se usa para todas las
  categorías con parser registrado en `lib/parsers`.

## 3. Stack técnico

- Next.js 14.2 (App Router), React 18, TypeScript.
- Postgres (Neon), driver `pg` directo (sin ORM). Ver `lib/db.ts` (pool
  singleton, `ssl: rejectUnauthorized:false`, `max:5`).
- Recharts para gráficos.
- `jszip` para descomprimir el export de IA40 cuando llega zippeado.
- Deploy: Vercel, con un cron job (`vercel.json`) y despliegue automático al
  actualizar archivos desde la web de GitHub.
- Sin test suite ni CI configurados.

## 4. Categorías y códigos NCM

Actualmente hay **9 categorías** activas (la tabla `categories` en la base es
la fuente de verdad; `sql/schema.sql` solo trae el seed original de una sola
categoría piloto — ver sección 11 sobre desactualización del schema).

| Categoría | Slug | NCM | Notas |
|---|---|---|---|
| Sillas de Ruedas | `sillas_de_ruedas` | 8713.10.00 | Categoría piloto original |
| Sillas de Ruedas Eléctricas | `sillas_ruedas_electricas` | 8713.90.00 | — |
| Andadores | `andadores` | 9021.10.10 | **NCM compartido** (ver abajo) |
| Bastones | `bastones` | 9021.10.10 | **NCM compartido** (ver abajo) |
| Calzado Ortopédico | `calzado_ortopedico` | 9021.10.10 | **NCM compartido**, agregada después del resto |
| Almohadas y Cojines | `almohadones_ortopedicos` | 9404.90.00 | Renombrada 17/07/2026 (antes "Almohadones Ortopédicos" — ver nota abajo) |
| Sillas y Asientos | `sillas_ducha` | 9401.79.00 | Renombrada 17/07/2026 (antes "Sillas de Ducha" — ver nota abajo) |
| Elevadores de Inodoro | `elevadores_inodoro` | 3922.20.00 | — |
| Camas Hospitalarias | `camas_hospitalarias` | 9402.90.20 | — |

La investigación completa de estos códigos (metodología, confianza,
alternativas descartadas) está en `docs/ncm_nuevas_categorias.md`.

**Nota sobre los renombres (17/07/2026):** los `slug` internos
(`almohadones_ortopedicos`, `sillas_ducha`) NO cambiaron — solo la columna
`name` de `categories` (vía `UPDATE` manual en Neon), porque bajo esas NCM
en la práctica entra mucha data que no es ortopédica (ver "Patrón A/B y
segmentación por NCM" en la sección 8). Como los slugs no cambian, no hizo
falta tocar `category_ncm_codes` ni ningún foreign key.

### Caso especial: NCM 9021.10.10 compartido

Andadores, Bastones y Calzado Ortopédico declaran aduaneramente bajo el
**mismo** código NCM (9021.10.10). En vez de pedirle a IA40 el mismo export
tres veces, `/api/sync` lo pide **una sola vez** y lo reparte por fila según
`parseOrtopedia9021Row()` (`lib/parsers/index.ts`), que interpreta el texto de
la columna "sufijos" (formato `"<MARCA> SIN MODELO <código> (CA00)"`) contra
un diccionario de marcas conocidas (`ORTOPEDIA_MARCA_DICT`) para decidir a
qué categoría y segmento pertenece cada fila. Filas que no matchean ninguna
marca del diccionario se aproximan por la descripción de la posición
arancelaria; si tampoco matchean nada específico, se descartan
(`categoriaSlug: null`, contado como `descartadas_otras_categorias` en la
respuesta de `/api/sync`).

Este código y este diccionario fueron la fuente de un bug importante de
contaminación de datos — ver sección 10.

## 5. Esquema de base de datos

⚠️ **`sql/schema.sql` en el repo está desactualizado.** Le faltan tablas
que sí existen en la base real de Neon (creadas ahí a mano, nunca
retro-documentadas en este archivo):

- **`app_settings`** — tabla clave/valor genérica. Hoy solo se usa para
  guardar el JWT de IA40 (`key='ia40_jwt'`, columnas `value`, `updated_at`).
  La lee `lib/ia40Export.ts` → `getStoredJwt()`.
- **`model_segmento_override`** (columnas: `category_id`, `marca`, `modelo`,
  `segmento`, `updated_at`, unique en `category_id+marca+modelo`) — permite
  corregir a mano el segmento calculado por el parser para una combinación
  marca+modelo puntual, sin esperar al próximo sync. La usa `/api/evolution`
  (con `LEFT JOIN` + `coalesce`) y `/api/model-overrides`.
- **`model_sieve_log`** (nueva, 17/07/2026; columnas: `category_id`, `marca`,
  `modelo`, `checked_at`, `result`, `detail`, unique en
  `category_id+marca+modelo`) — registra qué combinaciones ya validó el
  "tamizador de segmentos" (sección 10.1), para no re-procesarlas ni re-gastar
  cuota de búsqueda/IA en corridas futuras.

Si se reconstruye la base desde cero, hay que crear estas tres tablas a mano
además de correr `sql/schema.sql`.

Tablas que **sí** están documentadas en `sql/schema.sql` (141 líneas):
`categories`, `category_ncm_codes`, `field_mappings`, `trade_records` (la
tabla principal, una fila por línea de despacho, con `source_hash` único para
deduplicar en re-syncs), `monthly_brand_model_agg` (agregado mensual
precalculado que lee el front), `provider_brand_map` y `record_brand_map`
(correcciones manuales de marca/modelo por importador o por línea individual),
`sync_runs` (historial de corridas de sync), `model_images` (cache de
imágenes por marca/modelo), `model_pvp` (cache de PVP en USD por
marca/modelo, ver sección 10.2).

## 6. Flujo de sincronización (`/api/sync`)

Endpoint: `GET /api/sync` (protegido por `CRON_SECRET`, ver sección 12).
Acepta `?category=<slug>` opcional para sincronizar una sola categoría (más
rápido, útil para diagnosticar una categoría puntual sin esperar a las otras
8 — importante en el plan Hobby de Vercel, con límite de 60s por request salvo
que se suba a Pro, que es lo que permite el `maxDuration=300` declarado).

**Disparo automático:** un Cron Job de Vercel (`vercel.json` → `crons`, NO un
scheduler externo — decisión ya tomada, correr el cron directo en Vercel en
vez de en un servicio aparte) llama a este endpoint **1 vez por día**. Ver
sección 15 (18/09/2026) por qué, con la config actual, esa corrida diaria
casi siempre falla igual — el problema no es DÓNDE corre el cron (eso ya está
resuelto, vive en Vercel), sino que depende de un token que sólo se mantiene
fresco mientras una PC física está encendida (sección 7).

**Rango de fechas (`dateRangeLastNMonths`):** trae por defecto los últimos 24
meses (`SYNC_MONTHS_BACK`). Nunca incluye el mes calendario actual: aplica un
"período de gracia" (`SYNC_DATA_LAG_DAYS`, default 15 días) porque los datos
de aduana tardan en cargarse completos. Si hoy es el día 15 del mes o antes,
el rango retrocede un mes extra. **Consecuencia práctica:** cualquier fila en
`trade_records` con `period` igual o posterior al mes calendario en curso es,
por construcción, sintética/errónea (nunca la trae el sync real) — ver el bug
de la sección 10.

**Para cada categoría:**
1. Si es una de las 3 de NCM compartido (sección 4), usa el bloque especial
   que pide el export una sola vez y reparte por `parseOrtopedia9021Row`.
2. Si no, recorre sus NCM (`category_ncm_codes`) y por cada uno decide el
   flujo de lectura: exportación (`lib/ia40Export.ts`) si la categoría tiene
   parser registrado, o `/data` paginado (`lib/ia40.ts`) si no.
3. Cada fila se upsertea en `trade_records` vía `upsertRawRecords` /
   `upsertPreParsedRecords` (`lib/aggregate.ts`), dedupeando por
   `source_hash` (hash SHA-256 del JSON crudo de la fila — mismo despacho
   físico = mismo hash, sin importar qué categoría lo clasificó).
4. Se recalcula `monthly_brand_model_agg` para la categoría
   (`recomputeMonthlyAgg`).
5. Se registra el resultado en `sync_runs` y se devuelve un JSON con
   diagnóstico detallado por categoría (`fetched`, `inserted`,
   `skipped_sin_fecha`, hashes de muestra, conteos de verificación).

## 7. Mecanismo de autenticación con IA40

Hay **dos mecanismos separados** conviviendo, uno por cada cliente:

**a) `lib/ia40.ts` (flujo `/data`, categorías sin parser):** lee el JWT
directo de la variable de entorno `IA40_JWT` en Vercel. Si vence, hay que
actualizar la variable a mano en Vercel.

**b) `lib/ia40Export.ts` (flujo de exportación, categorías con parser —
la mayoría hoy):** lee el JWT de la tabla `app_settings` en Neon, con un
chequeo de antigüedad (`MAX_TOKEN_AGE_MIN = 20` minutos — si el token
guardado tiene más de 20 min, tira `Ia40AuthError` y el sync de esa
categoría falla ese día hasta que se actualice). Este token se mantiene
fresco automáticamente mediante:

- **`CobusSync_Installer/`** — instalador para Windows (`Instalar.bat` +
  `install.ps1` + `refresh_token.py`) que el usuario corre una vez en su PC.
  Programa una tarea de Windows que corre `refresh_token.py` cada 10 minutos
  (incluso después de reiniciar la PC), y deja un log en
  `%LOCALAPPDATA%\CobusSync\log.txt`. También crea un ícono de escritorio que
  abre el dashboard en una ventana propia.
- **`refresh_token.py`** — abre un Chrome real headless (Playwright), con
  scripts anti-detección (`STEALTH_JS`: oculta `navigator.webdriver`, etc.),
  hace login real en cobusgroup.com con usuario/contraseña de Cobus
  (hardcodeados en el script — el archivo advierte explícitamente "no lo
  compartas fuera del equipo"), captura el JWT de la URL de redirect, y lo
  **envía por POST a `VERCEL_TOKEN_ENDPOINT`** (configurado como
  `.../api/token`) con `Authorization: Bearer <TOKEN_UPDATE_SECRET>`.

✅ **Verificado en producción (17/07/2026):** el mecanismo está funcionando.
Se confirmó corriendo en la consola de Neon:
```sql
select key, value, updated_at, now() - updated_at as antiguedad
from app_settings where key = 'ia40_jwt';
```
y `antiguedad` da unos pocos minutos (se actualiza solo cada 10 min, como se
espera).

⚠️ **Detalle raro para tener en cuenta:** no se encontró el archivo
`app/api/token/route.ts` (ni ningún archivo con "token" en el nombre fuera
de `refresh_token.py`) en esta copia local del repo. Como el mecanismo
funciona en producción, ese endpoint necesariamente existe en el código que
está desplegado en Vercel — solo que no está presente en esta carpeta local.
Probablemente se subió en algún momento directo desde la interfaz web de
GitHub y nunca se bajó/copió de vuelta a esta carpeta. **Recomendación:**
antes de editar o resubir cualquier archivo relacionado (`lib/ia40Export.ts`,
o cualquier cosa que toque `app_settings`), conviene entrar a GitHub y
confirmar si existe `app/api/token/route.ts` ahí, para no terminar con esta
carpeta local y el repo real desincronizados en otros archivos también.

### Cómo verificar que el token se está actualizando solo

Correr en la consola SQL de Neon:

```sql
select key, value, updated_at, now() - updated_at as antiguedad
from app_settings
where key = 'ia40_jwt';
```

- `antiguedad` de pocos minutos (menos de 20) → el mecanismo anda bien:
  `refresh_token.py` está corriendo en la PC del usuario cada 10 minutos y
  actualizando la base sin problema.
- `antiguedad` de varias horas/días, o la consulta no devuelve filas → el
  token dejó de actualizarse. Primer lugar donde mirar: el archivo
  `%LOCALAPPDATA%\CobusSync\log.txt` en la PC donde corre el instalador — ahí
  queda registrado "OK: token actualizado..." en cada corrida exitosa, o el
  motivo del error si falla (usuario/contraseña de Cobus vencidos, abono de
  Cobus vencido, usuario deshabilitado, etc. — ver los mensajes de error que
  arma `refresh_token.py`).

⚠️ **Caso frecuente, no es un error real:** un gap de varias horas en
`log.txt` seguido de `net::ERR_NETWORK_IO_SUSPENDED` es la PC durmiéndose (no
un fallo de Cobus) — el refresh retoma solo cuando la PC despierta. El
problema real es que esto coincide casi todas las noches con el horario del
cron diario (sección 6/15/16): agosto 2026 nunca se sincronizó por esto.

## 8. Parsers (marca / modelo / color / segmento)

`lib/parsers/index.ts` (~1740 líneas) y `lib/parsers/sillasDeRuedas.ts` (269
líneas, parece ser el parser original/piloto — no está claro si sigue en uso
o quedó reemplazado por la lógica generalizada en `index.ts`, revisar si se
puede borrar).

`CATEGORY_PARSERS` es un diccionario `slug → función parser`. Cada parser
recibe la fila cruda de IA40 y devuelve `{ marca, modelo, color?, segmento? }`
o `null`. `categoryUsesExportFlow(slug)` decide si una categoría necesita el
flujo de exportación: es `true` si tiene parser registrado en
`CATEGORY_PARSERS` o si es una de las 3 categorías de NCM compartido
(sección 4).

### Patrón A vs. Patrón B (¡importante, fuente de un bug grande!)

El texto de aduana ("SUB ITEMS - SUFIJOS") viene en dos formatos distintos
según la categoría, y **no son intercambiables**:

- **Patrón A** — `"<MARCA> <MODELO> SIN CODIGO (CA00)"`: marca y modelo van
  juntos, hay que separarlos por diccionario (`createCategoryParser`,
  motor genérico original armado para "Sillas de ruedas"). Lo usan
  `sillas_de_ruedas` y `sillas_ruedas_electricas`.
- **Patrón B** — `"<MARCA> SIN MODELO <código> (CA00)"`: `"SIN MODELO"` es
  un separador explícito, no hace falta diccionario para saber dónde
  termina la marca. Lo usan `andadores`/`bastones`/`calzado_ortopedico`
  (vía `parseOrtopedia9021Row`) y las 4 categorías reescritas el
  17/07/2026: `almohadones_ortopedicos`, `sillas_ducha`,
  `elevadores_inodoro`, `camas_hospitalarias`.

**Bug corregido (17/07/2026):** esas 4 últimas categorías usaban
`createCategoryParser` (Patrón A) aunque su texto real es Patrón B — el
parser viejo intentaba separar marca/modelo de un texto combinado que en
realidad ya venía separado por `"SIN MODELO"`, con diccionarios de marca
genéricos (los mismos de sillas de ruedas) que no tenían nada que ver con
las marcas reales de cada NCM (sanitarios, muebles, colchones, etc.). Se
reescribieron como funciones standalone (`almohadasCojinesParser`,
`sillasAsientosParser`, `elevadoresInodoroParser`, `camasHospitalariasParser`),
cada una con su propio diccionario de marcas y árbol de Segmento, usando el
helper compartido `splitPatternB()` para la extracción y
`extractColorGeneric()` para el color (default `"S/D"` en vez de `"Negro"`
en estas 4 — la mayoría de estos productos no traen color declarado).

El caso especial `parseOrtopedia9021Row()` (descripto en la sección 4) tiene
su propia lógica de normalización de texto (mayúsculas, corrección de typos
de marca vía `normalizeOrtopediaMarcaTypo`) y un diccionario de marca →
categoría/segmento armado a mano sobre el dataset real. Desde el 17/07/2026,
cuando una fila resuelve a la categoría `andadores`, se aplica además
`subSegmentoAndador()`, que refina el segmento genérico "Andadores y Ayudas
de Marcha" en 3 subtipos (Andador Fijo / Andador 2 Ruedas / Andador 4 Ruedas
— Rollator) usando reglas de marca + código de modelo (sufijo `"LH"` =
señal más confiable de rollator). Filas con `"HIP BRACE"` en el modelo
(marca Jianwei) se excluyen — no son andadores, son una órtesis de cadera
mal clasificada por el NCM — y quedan marcadas como
`"Andador Fijo (revisar - posible ortesis de cadera, no andador)"` para que
se puedan filtrar y corregir a mano en vez de contarse como un andador real.

**Filtro de Segmento por defecto (frontend):** ya que Almohadas y Cojines,
Sillas y Asientos y Elevadores de Inodoro traen de fondo mucha data no
relacionada al uso ortopédico (ver renombres arriba), `app/page.tsx`
(`DEFAULT_SEGMENTO_FILTER`) preselecciona el segmento relevante apenas se
elige la categoría (`"Cojín Ortopédico / Antiescaras"`,
`"Sillas de Ducha / Sanitarias"`, `"Elevador / Asiento Sanitario
Ortopédico"` respectivamente). Los datos de los demás segmentos igual están
sincronizados — el usuario puede ampliar el filtro para verlos.

⚠️ **Confianza de las reglas de Segmento de Camas Hospitalarias:** a
diferencia de las otras categorías (donde el texto trae palabras
descriptivas), en Camas Hospitalarias el texto de aduana NO indica si es
eléctrica o manual — se infiere por prefijo de código según catálogo de
cada fabricante (ej. Medik `YA-D...`=eléctrica / `YA-M...`=manual, Magesa
`D...`=eléctrica / `V...`=manual). Son heurísticas de mejor esfuerzo;
conviene revisar los conteos del primer sync real contra lo esperado
(~21% del dataset original quedaba en "Tipo no especificado").

## 9. Corrección manual de datos (`/admin`)

Cuando el parser automático no identifica bien una fila, hay tres niveles de
corrección manual, de más general a más específico (cada uno tiene prioridad
sobre el nivel anterior y se aplica **sin esperar al próximo sync**):

1. **Por importador entero** (`provider_brand_map`, `POST /api/providers`) —
   asigna marca/modelo/color a todas las filas de un importador.
2. **Por línea individual** (`record_brand_map`, `POST /api/records`) — un
   mismo importador puede traer varias marcas; esto corrige una fila puntual.
3. **Por segmento/imagen de un modelo** (`model_segmento_override` +
   `model_images`, `POST /api/model-overrides`) — corrige el segmento
   calculado por el parser, o carga una imagen a mano, para una combinación
   marca+modelo específica.

Los tres disparan `recomputeMonthlyAgg(categoryId)` (los dos primeros) o se
aplican en el momento de la consulta vía `LEFT JOIN` (el tercero, en
`/api/evolution`), así el dashboard refleja el cambio al instante.

## 10. Imágenes de modelos

`lib/imageSearch.ts` — cliente de SerpApi (Google Images), necesita
`SERPAPI_API_KEY`. 250 búsquedas gratis por mes. Tira `QuotaExceededError` si
se agota la cuota.

`lib/modelImages.ts` — `getOrSearchModelImage()` busca (o devuelve de cache)
la imagen de una combinación marca+modelo puntual, **on-demand**: se llama
desde el botón "Ver imagen" del dashboard (`POST /api/model-images/search`).
Solo re-busca si el estado guardado no es `'found'` ni `'not_found'`.

También existe `backfillModelImages()` y el endpoint `GET /api/sync-images`
para precalentar el catálogo en bloque, pero **no está enganchado a ningún
cron** (`vercel.json` solo declara el cron de `/api/sync`) — es manual, para
correrlo a mano si se quiere.

## 10.1 Tamizador de segmentos (validación con IA, 17/07/2026)

**Por qué existe:** la clasificación automática de marca/modelo/segmento
(sección 8) es un árbol de reglas (marca declarada + palabras clave +, para
el NCM compartido, descripción de posición arancelaria) — funciona bien en
general, pero un mismo fabricante puede vender productos de tipos distintos
bajo códigos parecidos, y ahí la regla se puede equivocar. Caso real que
motivó esta feature: "Double Care Medical HY7300L" quedó clasificado como
`andadores` (por su marca + descripción genérica "LOS DEMÁS"), pero una
búsqueda real en Google muestra que es un **bastón trípode**, no un andador.

**Cómo funciona:** botón "🔎 Tamizar categoría" en el dashboard (junto a los
filtros). Al clickearlo, dispara `GET /api/sieve?category=<slug>`, que:

1. Busca combinaciones marca+modelo de la categoría actual que **todavía no
   se validaron** (tabla `model_sieve_log`, nueva — ver sección 5), ordenadas
   por **FOB total acumulado descendente** (suma de `total_fob_dolars` de
   todos los meses) — así se revisan primero los modelos con más peso real
   en el negocio, no alfabéticamente.
2. Para cada una (en lotes de `SIEVE_BATCH_LIMIT`, default 100 por click,
   procesadas de a `SIEVE_CONCURRENCY` en paralelo, default 10): le pide a
   OpenAI (`lib/aiClassifier.ts`, modelo `gpt-5.4-mini` vía Responses API)
   que decida el segmento real. **El modelo busca en la web por su cuenta**
   (tool nativo `web_search`) — no se usa SerpApi para esto. La IA **siempre
   elige el segmento que mejor aplique**, incluso con evidencia parcial o
   ambigua (pedido explícito del usuario, 17/07/2026: prefiere una mejor
   estimación de la IA antes que dejar el modelo sin clasificar) — el campo
   "confianza" indica qué tan segura estuvo, pero ya no se usa para bloquear
   la corrección del segmento.
3. Para las 3 categorías de NCM compartido (`andadores`/`bastones`/
   `calzado_ortopedico`), además le pregunta a la IA si el producto está en
   la categoría correcta. Este cambio de categoría sigue siendo conservador:
   solo se aplica con confianza alta/media (a diferencia del segmento), por
   ser un cambio estructural más grande. Si corresponde mover (como el caso
   de Double Care Medical), **se mueve automáticamente**: `UPDATE
   trade_records` cambia el `category_id` (y el segmento) de esa
   combinación marca+modelo, se recalcula `monthly_brand_model_agg` de
   ambas categorías (la vieja y la nueva), y se migran (si existían) la
   imagen cacheada y el override de segmento.
4. Al terminar el lote, el dashboard muestra un resumen: procesados, sin
   cambios, segmento corregido, categoría movida, sin evidencia (caso
   residual: la IA no devolvió ningún segmento pese a la instrucción de
   siempre elegir uno — debería ser raro), y errores.

Solo corre bajo demanda (no hay cron) — hace falta clickear el botón una o
más veces por categoría hasta agotar los pendientes (`model_sieve_log` evita
reprocesar lo ya validado).

**UI (17/07/2026, segunda vuelta):** el botón "🔎 Tamizar categoría" se movió
al panel superior del dashboard, en el lugar donde antes estaba el link
"☁️ Cargar/editar marcas por importador → " hacia `/admin` (se quitó porque,
con el tamizador corrigiendo automáticamente, ese flujo manual por
importador pierde sentido para segmento). Junto al botón se muestra:

- Una barra de progreso + `{tamizado}/{total} tamizado (X%)`, calculado por
  `GET /api/sieve/status?category=<slug>` (nuevo endpoint liviano, **no**
  gasta cuota de OpenAI ni de SerpApi — solo cuenta filas de
  `monthly_brand_model_agg` vs. `model_sieve_log`).
- Un tiempo estimado restante (`≈Xm restante`), calculado en el cliente
  como `pendientes × segundos-por-item-del-último-lote-corrido` (no hay
  forma de estimarlo sin haber corrido al menos un lote en la sesión).
- El panel de resultados también lista `detalle_errores` (el texto real de
  cada error), antes calculado en el backend pero nunca mostrado —
  necesario para diagnosticar por qué un lote da errores en vez de solo ver
  el contador. Se puede ocultar/mostrar con el botón "Ver errores".

**Variables de entorno:**
- `OPENAI_API_KEY` — obligatoria para que funcione el tamizador. Key del
  proyecto "cobus" en platform.openai.com (facturación por uso, pagada por
  la empresa). **Ojo:** esto es la API de OpenAI, no una suscripción de
  ChatGPT Plus/Pro — son sistemas de facturación totalmente distintos, hace
  falta una key generada en platform.openai.com con método de pago propio.
  Costo aproximado: el tool `web_search` cuesta USD 0.01 por búsqueda (10
  USD / 1.000 llamadas) + tokens de la respuesta al precio normal del
  modelo — un lote de 100 productos sale centavos de dólar.
- `SIEVE_BATCH_LIMIT` — opcional, tamaño del lote por click (default 100,
  antes 20 — con SerpApi ya no en el medio no hace falta ser tan
  conservador con la cuota, así que se subió al tope máximo para que cada
  click cubra más terreno).
- `SIEVE_CONCURRENCY` — opcional, cuántos ítems se procesan EN PARALELO
  dentro de cada lote (default 10). La llamada a OpenAI no pasa por el pool
  de Postgres (`lib/db.ts`, max 5 conexiones) — solo las queries cortas de
  insert/update lo usan, así que se puede paralelizar más que esas 5
  conexiones sin problema (el exceso de queries hace cola un instante nomás).
- `SIEVE_TIME_BUDGET_MS` — opcional (default 260000 = 260s), presupuesto de
  tiempo total del request, bien por debajo de `maxDuration` (300s). Ver
  incidente abajo — sin esto, un lote de 100 podía exceder el límite de
  Vercel y la función moría sin devolver ninguna respuesta al navegador.

**Incidente 17/07/2026 (segunda vuelta) — lote de 100 lento y sin
respuesta:** con el `SIEVE_BATCH_LIMIT` subido a 100, un lote real quedó
"colgado" y terminó devolviendo el error genérico "No se pudo correr el
tamizador" en el frontend, aunque 60 de los 100 ítems sí se habían
procesado y guardado bien (se veía en la barra de progreso). Causa: la
función de `/api/sieve` excedió los 300s de `maxDuration` y Vercel la mató
de golpe — el navegador nunca recibe una respuesta cuando eso pasa, así que
cae en el `.catch()` genérico del fetch en vez de mostrar un error
específico. Tres cambios para esto:
1. **Menos latencia por ítem** (`lib/aiClassifier.ts`): el prompt le pedía
   al modelo reintentar la búsqueda con variantes si la primera fallaba —
   se sacó esa instrucción (una sola búsqueda). Se agregó también
   `reasoning: { effort: "low" }` en el request a OpenAI (no hace falta
   razonamiento profundo para elegir de una lista fija de segmentos) y un
   timeout defensivo de 45s por request individual (`AbortController`).
2. **Más concurrencia** (`SIEVE_CONCURRENCY`, default 5 → 10).
3. **Presupuesto de tiempo** (`app/api/sieve/route.ts`): antes de cada
   tanda paralela se chequea cuánto tiempo pasó desde que arrancó el
   request; si ya se acerca a `SIEVE_TIME_BUDGET_MS`, se corta ahí mismo y
   se devuelve el resumen con `parcial: true` en vez de seguir y arriesgarse
   a que Vercel mate la función sin respuesta. El frontend (`app/page.tsx`)
   muestra un aviso ("⏱️ Se alcanzó el límite de tiempo... clickeá de nuevo
   para seguir") cuando esto pasa. Como cada ítem procesado se loguea en
   `model_sieve_log` al momento (no al final), no se pierde ni se reprocesa
   nada — el próximo click retoma justo donde quedó.

**Incidente 17/07/2026 (tercera vuelta) — el tamizador volvió a ponerse
lento después de agregar PVP:** al fusionar la pregunta de PVP (sección
10.2) en la misma búsqueda del tamizador, una versión intermedia del prompt
le decía al modelo "si no encontrás el precio del modelo exacto, buscá el de
productos similares" — esa instrucción contradice la regla de "UNA sola
búsqueda" de arriba, y en la práctica el modelo terminaba disparando 2 o 3
llamadas al tool `web_search` por ítem (identificación del producto + precio
+ a veces un fallback a productos similares) en vez de 1, multiplicando la
latencia por ítem sobre un lote de 100 (reporte del usuario: "queda muy
lento el tamizador"). Fix: la instrucción de PVP dentro de `lib/aiClassifier.ts`
ahora es **puramente oportunista** — solo aprovecha lo que ya apareció en la
ÚNICA búsqueda hecha para identificar el producto, sin pedir ni permitir una
búsqueda adicional. Esto significa que `pvp_usd` va a quedar en `null` con
más frecuencia que en la versión "agresiva" (trade-off intencional para
mantener el tamizador rápido); el comportamiento exhaustivo (búsqueda
dedicada de precio, con fallback a productos similares y foco en Argentina)
se mantiene **solo** en `lib/pvpFinder.ts`, usado por el botón manual
"Consultar precio" — como ese camino procesa un modelo a la vez por click
del usuario, un par de segundos extra de búsqueda ahí no se sienten como
lentitud de la misma forma que en un lote de 100.

**Historial de proveedores de IA para el tamizador (todo el 17/07/2026):**
esta feature pasó por 3 proveedores distintos en el mismo día, cada cambio
motivado por una limitación real encontrada en producción:

1. **Anthropic (Claude)** — primera versión. Se descartó por pedido del
   usuario: quería empezar con una opción gratuita.
2. **Gemini** (`gemini-2.5-flash-lite`, después `gemini-3.1-flash-lite` tras
   un 404 de Google a API keys nuevas) — funcionó bien en un primer test
   pasándole a Gemini snippets de SerpApi como texto (JSON mode clásico).
   Después, por pedido del usuario de que la IA "buscara de verdad" en vez
   de depender de SerpApi, se cambió a que Gemini buscara solo con su tool
   nativo `google_search` (grounding) — pero ese tool devuelve 429 en el
   100% de los casos si el proyecto de Google AI Studio no tiene
   **facturación activada** (confirmado en la
   [página oficial de precios](https://ai.google.dev/gemini-api/docs/pricing):
   grounding figura como "No disponible" en el tier gratis puro). Activar
   facturación en Google requería cargar una tarjeta igual, así que en vez
   de eso la empresa decidió pagar la API de OpenAI.
3. **OpenAI** (`gpt-5.4-mini` vía Responses API, tool `web_search`) — la
   versión actual. La empresa ya factura este proveedor (proyecto "cobus"),
   así que no hace falta activar nada adicional del lado de Google. Mismo
   patrón que con Gemini: el modelo busca en la web por su cuenta durante
   la misma llamada, sin SerpApi.

Detalle técnico importante (aplica igual que con Gemini): **no** se combina
"structured output" (`text.format: json_schema` en la Responses API) con el
tool `web_search` — hay reportes de la comunidad de OpenAI de que esa
combinación corta la respuesta a la mitad y rompe el JSON. Por eso se le
pide al modelo en el prompt que responda solo con JSON en texto plano, y
`extractJson()` en `lib/aiClassifier.ts` lo extrae con un parser de llaves
balanceadas (tolerante a texto extra alrededor).

`lib/webSearch.ts` (cliente de SerpApi para texto, usado por la versión
Gemini-con-snippets) quedó sin uso en el repo — se puede borrar si se
quiere, no rompe nada. SerpApi sigue usándose exclusivamente para imágenes
del catálogo (`lib/imageSearch.ts`), sin relación con el tamizador.

## 10.2 FOB unitario y PVP estimado (Share por Modelo, 17/07/2026)

En la tabla "Share por Modelo" del dashboard (`ModelShareTable` en
`app/page.tsx`) se agregaron dos columnas nuevas:

**FOB Unit.**: `fob / unidades` del período elegido (últimos 12 meses
móviles), calculado en el front dentro de `computeShareByModel()` —no
requiere ninguna llamada externa, es aritmética simple sobre los mismos
datos que ya se traen del `/api/evolution`.

**PVP USD**: precio de venta al público estimado en USD. Se completa de
**dos formas** (pedido explicito del usuario, 17/07/2026: "aprovechar mas la
Api con OpenIA... cuando va a buscar una info tambien trae la otra"):

1. **Automática, dentro del tamizador**: la misma búsqueda web que
   `lib/aiClassifier.ts` ya hace para identificar el segmento/categoría de
   cada modelo (sección 10.1) también le pide a OpenAI el PVP que haya
   encontrado en esa búsqueda — sin gastar una segunda llamada. El resultado
   lo guarda `guardarPvp()` en `app/api/sieve/route.ts`, en la misma tabla
   `model_pvp`. El resumen del tamizador muestra "PVP encontrado: N" y, si
   hubo alguno, el front recarga la columna sola al terminar (`reloadModelPvp()`
   en `app/page.tsx`).
2. **Manual, on demand**: para un modelo puntual que el tamizador todavía no
   procesó (o que dio `'not_found'`/`'error'`), el botón "Consultar" de la
   columna dispara `POST /api/model-pvp/search`, que llama a
   `lib/pvpFinder.ts` — una llamada de OpenAI independiente, pensada
   específicamente para este caso.

Ambos caminos escriben en la misma tabla `model_pvp` con la misma regla: si
la búsqueda encuentra un precio, siempre pisa el valor anterior (dato más
fresco gana); si NO encuentra nada, solo marca `'not_found'` si todavía no
había ningún valor `'found'` guardado (no borra un precio bueno con un
intento que no encontró nada).

- `lib/pvpFinder.ts` — `findModelPvp(marca, modelo, categoryName)`: misma
  Responses API de OpenAI que el tamizador (`gpt-5.4-mini`, tool
  `web_search`, sin structured output, mismo parser de JSON balanceado).
  Devuelve `pvpUsd | null`, `confianza` y `razonamiento`. Si no encuentra
  nada confiable devuelve `pvpUsd: null` en vez de inventar un número.
  `lib/aiClassifier.ts` pide el mismo campo `pvp_usd` (más
  `pvp_razonamiento`) dentro de su propio JSON de respuesta.
- **ACTUALIZACIÓN (17/07/2026, misma tarde)**: la primera versión le pedía
  al modelo que comparara precios de varias fuentes, eligiera "el que más se
  repita" y devolviera un `fuente_url` de origen — en la práctica terminaba
  agarrando el precio de UNA ficha técnica encontrada (a veces de un
  producto relacionado pero no exacto), dando valores incorrectos. Se
  simplificó a una pregunta directa: *"¿Cuál es el precio promedio actual de
  venta al público de MARCA MODELO?"*, pidiéndole que promedie si encuentra
  varios precios en vez de "elegir una fuente ganadora". Se sacaron por
  completo `fuente_url` y `fuentes_consistentes` de ambos prompts (y de
  `SieveClassifyResult`/`PvpResult`/`ModelPvpEntry`) — el precio en el
  dashboard ya NO es un link, es texto plano (con el razonamiento como
  tooltip). La tabla `model_pvp` conserva las columnas `fuente_url` y
  `fuentes_consistentes` en la base (no se borraron por prolijidad de no
  tocar el esquema sin necesidad), pero el código ya no las llena ni las
  lee.
- **ACTUALIZACIÓN 2 (17/07/2026, misma tarde)**: la pregunta directa seguía
  exigiendo el precio "de este modelo específico", lo que en la práctica
  devolvía `'not_found'` ("Sin dato" en el dashboard) para la mayoría de los
  modelos — códigos de importación muy puntuales no suelen tener una ficha
  de venta propia online (pedido explícito del usuario: *"es una simple
  pregunta, debería dar datos"*). Ahora, si no encuentra el precio del
  modelo EXACTO, el prompt le pide que estime usando precios de productos
  equivalentes/similares de la misma marca y tipo de producto, marcando
  `confianza: "baja"` — mismo criterio que ya se usa para el segmento
  (sección 10.1: siempre elegir la mejor estimación disponible en vez de
  dejarlo sin clasificar). `pvp_usd` solo queda en `null` si de verdad no
  hay ningún precio relacionado, ni del modelo exacto ni de similares.
  Como consecuencia, `getOrSearchModelPvp()` (`lib/modelPvp.ts`) cambió de
  comportamiento: antes cacheaba `'not_found'` para siempre (igual que
  `'found'`); ahora **`'not_found'` se reintenta en cada click** (el botón ya
  mostraba un ícono de "reintentar" ↻ para ese estado, así que el
  comportamiento pasa a coincidir con lo que se ve en pantalla). Solo
  `'found'` sigue siendo definitivo.
- **ACTUALIZACIÓN 3 (17/07/2026, misma tarde)**: se agregó *"para el mercado
  de Argentina"* a la pregunta (pedido explícito del usuario) — el PVP de
  equipamiento médico/ortopédico varía bastante entre países, así que ahora
  se le pide puntualmente el precio de venta en Argentina; si no encuentra
  oferta local ni del modelo exacto ni de un similar, recién ahí puede usar
  un precio internacional como estimación (aclarándolo en el
  razonamiento/`pvp_razonamiento`).
- Es un archivo deliberadamente independiente de `lib/aiClassifier.ts`
  (repite ~40 líneas de boilerplate de la llamada a OpenAI en vez de
  compartir un helper) para no tocar el código del tamizador, que ya está
  probado en producción. Si en el futuro aparece un tercer consumidor de la
  API de OpenAI, ahí sí conviene extraer un `lib/openai.ts` común.
- `lib/modelPvp.ts` — `getOrSearchModelPvp()`: capa de cache en la tabla
  `model_pvp`, calcada de `lib/modelImages.ts`/`getOrSearchModelImage()`.
- No usa ninguna variable de entorno nueva: reutiliza `OPENAI_API_KEY` (la
  misma del tamizador).
- Tanto **FOB Unit.** como **PVP USD** se muestran **redondeados, sin
  decimales** (mismo formato que la columna FOB USD).

**Botón "🧹 Limpiar tamizado"** (17/07/2026): la columna PVP se agregó
DESPUÉS de que varias categorías ya estuvieran 100% tamizadas, y la query de
`GET /api/sieve` excluye cualquier combinación marca+modelo que ya tenga fila
en `model_sieve_log` (para no re-gastar OpenAI en algo ya validado) -- eso
significa que esas categorías nunca iban a completar la columna PVP por su
cuenta, porque nunca vuelven a pasar por `procesarItem`. Para destrabarlo se
agregó `DELETE /api/sieve?category=<slug>` (borra el `model_sieve_log` de esa
categoría, sin tocar `model_pvp` ni `trade_records`) y un botón al lado de
"Tamizar categoría" que lo llama (con un `confirm()` antes, porque el
próximo tamizado va a volver a gastar una llamada a OpenAI por CADA modelo
de la categoría, no solo por los pendientes). Aparece solo cuando
`sieveStatus.tamizado > 0` (no tiene sentido si todavía no se tamizó nada).

También se cambió el botón "Ver imagen" por un ícono de lupa (🔍) para
ocupar menos espacio en la fila; el texto descriptivo ("Ver imagen", "Sin
imagen", "Reintentar", etc.) ahora vive en el atributo `title` (tooltip al
pasar el mouse) en vez de en el botón mismo.

**Botón "💲 Completar PVP"** (17/07/2026): consecuencia directa de la
ACTUALIZACIÓN 2 de más arriba — al volver el PVP del tamizador puramente
oportunista (para no revivir el problema de lentitud), la mayoría de los
modelos queda sin PVP después de tamizar (ej. reporte real del usuario: 10
de 100). Clickear "Consultar" fila por fila para completar el resto no
escala, así que se agregó un batch dedicado:

- `GET /api/pvp-sieve?category=<slug>&limit=<n>` (`app/api/pvp-sieve/route.ts`):
  busca, priorizado por FOB total (mismo criterio que `/api/sieve`), todos
  los modelos de una categoría cuyo `model_pvp.status` todavía no sea
  `'found'`, y corre sobre cada uno la búsqueda EXHAUSTIVA de
  `getOrSearchModelPvp()` (`lib/modelPvp.ts` → `lib/pvpFinder.ts` — la misma
  que usa el botón manual "Consultar precio": foco en Argentina, con
  fallback a productos similares). Mismo patrón de lote que `/api/sieve`:
  `limit` default 60 / máximo 100, `PVP_SIEVE_CONCURRENCY` (default 8) items
  en paralelo, `PVP_SIEVE_TIME_BUDGET_MS` (default 260000) para cortar antes
  de que Vercel mate la función y devolver `parcial: true` en vez de perder
  la respuesta completa (mismo mecanismo que el incidente de lentitud del
  tamizador, sección 15).
- `GET /api/pvp-sieve/status?category=<slug>` (`app/api/pvp-sieve/status/route.ts`):
  cuenta cuántas combinaciones marca+modelo tiene la categoría vs. cuántas
  ya tienen `model_pvp.status = 'found'`, para la barra de progreso — no
  gasta OpenAI, es liviano, igual que `/api/sieve/status`.
- El botón "💲 Completar PVP" en `app/page.tsx` corre este batch y muestra un
  resumen (`Procesados X de Y · PVP encontrado: N · Sin evidencia: N ·
  Errores: N`), con el mismo aviso de `parcial` que el tamizador de
  segmentos. Al terminar, si encontró algo nuevo, recarga la columna PVP USD
  de la tabla (`reloadModelPvp()`) sin que el usuario tenga que refrescar la
  página. Aparece en la MISMA fila que "Tamizar categoría" (no en una fila
  aparte — pedido explícito del usuario).
- **Fix (17/07/2026, misma tarde) — "no completa el PVP con errores":**
  primera versión real en producción: de 60 pedidos, 49 procesados y 7 en
  error (6 de ellos timeout de 45s). Causa raíz: el lote usaba
  `Promise.all()` por tandas de `PVP_SIEVE_CONCURRENCY` (8) — si UN item de
  la tanda tardaba el timeout completo, los otros 7 (aunque ya hubieran
  terminado) quedaban esperando ese mismo tiempo antes de que arrancara la
  tanda siguiente, desperdiciando gran parte de `PVP_SIEVE_TIME_BUDGET_MS`
  en espera inútil. Se cambió a un **pool de workers independientes**: cada
  worker agarra el siguiente item de la cola en cuanto termina el suyo, sin
  esperar a los demás de su tanda original — mismo fix aplicado
  preventivamente en `/api/sieve/route.ts` (el tamizador de segmentos tiene
  la misma estructura de tandas y el mismo riesgo, aunque no se haya
  reportado el problema ahí todavía). Además, se detectó un caso real de
  JSON mal formado (el modelo escribió una comilla sin escapar dentro de
  `"razonamiento"` al citar un precio, lo que rompía `JSON.parse` aunque
  `pvp_usd` y `confianza` estuvieran bien) — `lib/pvpFinder.ts` ahora tiene
  un fallback por expresión regular que recupera `pvp_usd`/`confianza`
  directo del texto crudo cuando el parseo estricto falla, en vez de perder
  un precio válido por un problema de formato en el texto explicativo.
- Como reusa `getOrSearchModelPvp()` tal cual, correr este batch varias
  veces sobre la misma categoría es seguro: los `'found'` no se vuelven a
  consultar (no se duplica gasto de OpenAI), solo se reintentan los
  `'not_found'`/`'error'`/sin fila todavía.
- **Fix (17/07/2026, misma tarde) — "no pega los PVP de mayor a menor peso
  del SOM%":** la query de priorización (tanto en `/api/pvp-sieve` como en
  `/api/sieve`) sumaba el FOB de TODA la historia de
  `monthly_brand_model_agg` para decidir qué modelo procesar primero. En
  categorías con años de datos, eso podía hacer que un modelo viejo con
  mucho FOB acumulado (pero irrelevante hoy) le ganara en prioridad a los
  modelos que realmente pesan en el share ACTUAL — mientras que la tabla
  "Share por Modelo" del dashboard ordena por FOB de los "Últimos N meses
  móviles" (`periodInfo.last12Set` en `app/page.tsx`), no por el histórico
  completo. Resultado visible: el batch procesaba modelos que no aparecían
  ni cerca del tope de la tabla, dejando sin PVP a los que sí se ven arriba.
  Fix: ambas queries ahora usan un CTE (`periodos_recientes`) que limita la
  suma de FOB a los últimos 12 períodos de la categoría, alineando la
  prioridad del backend con lo que se ve en pantalla.

- **Fix (20/07/2026) — reintento automático ante timeout en "Completar
  PVP":** en un lote real de 60 modelos, 1 dio error de timeout (45s, ver
  `lib/pvpFinder.ts`) mientras los otros 59 respondieron bien — un caso
  puntual de lentitud pasajera de OpenAI, no un problema del modelo en sí.
  `app/api/pvp-sieve/route.ts` ahora reintenta UNA vez automáticamente
  cuando el error es un timeout, siempre que quede presupuesto de tiempo de
  sobra (al menos 45s) dentro de `PVP_SIEVE_TIME_BUDGET_MS` — si no, lo deja
  como error igual que antes. No aplica a la consulta manual individual
  (`/api/model-pvp/search`, `maxDuration = 60`) porque ahí un segundo intento
  de 45s podría hacer que Vercel mate la función antes de responder; el
  botón "Consultar" ya deja reintentar con un solo click si hace falta.

- **Aclaración (20/07/2026) — barra de progreso de "Completar PVP":** ya
  existe en `app/page.tsx` (misma UI que la barra del tamizador, alimentada
  por `/api/pvp-sieve/status`) — si no se ve en producción es porque esta
  versión de `page.tsx` todavía no se subió a GitHub.

- **UX (20/07/2026) — click en el logo de Icom Salud recarga la página:**
  pedido explícito del usuario, para tener un "volver al inicio" rápido sin
  usar el botón de refresh del navegador. Cambio en `AppHeader()`
  (`app/page.tsx`): `onClick={() => window.location.reload()}` sobre el
  `<img>` del logo, con `cursor: pointer` y tooltip "Actualizar página".

- **Fix (20/07/2026) — "Completar PVP" seguía sin pegarle a los modelos
  visibles, aun después del fix de FOB reciente:** causa real encontrada
  con un caso concreto (categoría "Cojín Ortopédico / Antiescaras", que
  vive bajo el mismo NCM que otros segmentos de `almohadones_ortopedicos`):
  la query de prioridad de `/api/pvp-sieve` no filtraba por Segmento, así
  que un segmento distinto al que el dashboard preselecciona por defecto
  (ver `DEFAULT_SEGMENTO_FILTER`) podía tener más FOB reciente y comerse
  todo el cupo del lote (`limit=60`) — el batch reportaba "PVP encontrado:
  59" real, pero ninguno de esos 59 coincidía con los modelos que se veían
  en la tabla "Share por Modelo" filtrada por segmento. Fix: el frontend
  ahora manda el filtro de Segmento activo (`?segmento=...`, repetible) a
  `/api/pvp-sieve` y a `/api/pvp-sieve/status`, y ambas queries lo respetan
  (join a `model_segmento_override` + `coalesce` con `agg.segmento`, mismo
  criterio que ya usaba `/api/sieve`). El % de avance de la barra también
  se recalcula sobre el subconjunto filtrado, no sobre toda la categoría.
  Nota: el mismo filtro NO se aplicó a la query de prioridad de
  `/api/sieve` (tamizador de segmentos) a propósito — ese endpoint existe
  justamente para encontrar modelos mal clasificados en OTRO segmento, así
  que filtrar por el segmento "actual" iría en contra de su propósito.

- **Recordatorio (20/07/2026) — verificar que `/api/pvp-sieve/status/route.ts`
  esté subido a GitHub:** la barra de progreso de "Completar PVP" (idéntica
  a la del tamizador) depende de este endpoint. Si el código de
  `app/page.tsx` que la dibuja ya está en producción pero la barra sigue
  sin aparecer, lo más probable es que este archivo puntual nunca se haya
  pegado en GitHub (es fácil de saltear por estar en una subcarpeta nueva).

- **Fix (20/07/2026) — PVP con valores que no reflejan la realidad (bug de
  formato de números argentino):** caso real detectado por el usuario
  comparando contra Gemini: "ASIENTO ESPUMA INTEL" (MELEJ S.R.L) mostraba
  "pvp_usd": 498, cuando el precio real rondaba los USD 21-27 ($27.000-
  $32.000 pesos argentinos). Hipótesis: el modelo encontró un precio
  escrito con el formato numérico argentino (punto = separador de miles,
  ej. "$498.000" = cuatrocientos noventa y ocho MIL pesos) y lo tomó
  directamente como si "498" ya fuera el valor en USD, sin dividir por el
  tipo de cambio. Fix en `lib/pvpFinder.ts` y `lib/aiClassifier.ts`: se
  agregó al prompt una explicación explícita del formato numérico
  argentino, el pedido de anotar el monto en pesos y el tipo de cambio
  usado en el razonamiento (para poder auditar desde la tabla), y un
  chequeo de sensatez ("si el resultado te da sospechosamente alto o bajo,
  revisá si confundiste el separador de miles"). Además, en `app/page.tsx`
  se agregó un punto de color junto al precio (verde=alta, amarillo=media,
  rojo=baja confianza) para que la confianza de la IA sea visible de un
  vistazo, no solo en el tooltip — así se puede priorizar qué precios
  conviene chequear a mano. Esto reduce el riesgo pero no lo elimina del
  todo: sigue siendo una estimación de IA con búsqueda web, no una fuente
  de precios verificada.

- **UX (20/07/2026) — "Completar PVP" encadena lotes automáticamente:**
  cada click corría UN solo lote (hasta 60 modelos, cortado a los ~4-5 min
  de presupuesto de `/api/pvp-sieve`) — para categorías con muchos modelos
  pendientes, terminarla entera significaba clickear el botón una y otra
  vez cada pocos minutos. Reporte real del usuario: la "corrida general"
  de Completar PVP se sentía como "casi 10 minutos" de estar reclickeando.
  Fix en `app/page.tsx` (`runPvpSieve()`): ahora un solo click encadena
  lotes automáticamente (sin volver a tocar el botón) hasta que ya no
  queden modelos pendientes en la categoría/segmento actual, mostrando el
  resumen ACUMULADO de todas las vueltas y actualizando la barra de
  progreso en cada una. Tope de seguridad: 30 vueltas seguidas (hasta 1800
  modelos) para no quedar en un loop infinito ante algún bug de backend.
  Se agregó un botón "⏹ Detener" (visible mientras corre) para interrumpir
  en cualquier momento — lo ya encontrado en vueltas anteriores queda
  guardado, no se pierde. El tiempo real total para una categoría grande
  sigue acotado por la latencia de OpenAI (no se resolvió el fondo de la
  lentitud, que depende del proveedor), pero ya no requiere babysitting
  manual del botón.

- **Fix (20/07/2026) — barra de "Completar PVP" quedaba estática mientras
  se tamizaba la categoría:** reporte real del usuario: "cuando voy
  tamizando la categoría se van sumando productos y el completar PVP sigue
  estático (...) referenciando a los modelos existentes antes de
  tamizar". Causa: el tamizador puede reclasificar el segmento de un
  modelo (via `model_segmento_override`), haciendo que entre o salga del
  filtro de Segmento activo — y "Completar PVP" calcula su total/% sobre
  ESE mismo filtro (ver fix anterior de esta misma sección). `runSieve()`
  en `app/page.tsx` recargaba la serie (`reloadSeries()`) cuando había
  segmentos corregidos o categorías movidas, pero nunca volvía a pedir
  `/api/pvp-sieve/status` — así que el total/% de Completar PVP quedaba
  fijo con el valor de ANTES del tamizado, aunque el conjunto de modelos
  del segmento visible hubiera cambiado. Fix: `runSieve()` ahora también
  llama a `reloadPvpSieveStatus()` en esos casos.

## 10.3 Calculador de Importación (20/07/2026)

Nueva sub-app, separada del Módulo de Importaciones, que reconstruye en la
web la lógica de costeo que el cliente ya usaba en su planilla
`STOKE_FOB_Objetivo_Fase1.xlsx`. El usuario carga un tipo de producto y un
FOB, aprieta "Calcular" y obtiene toda la cascada de costos hasta el Costo
Nacionalizado, más el margen (absoluto y %) vendiendo por Mercado Libre y
vendiendo a Distribución. Vive en `app/calculo-importacion/page.tsx`, con
navegación cruzada desde/hacia el Módulo de Importaciones vía un botón nuevo
en el header compartido (`components/AppHeader.tsx`, extraído de
`app/page.tsx` para poder reusar el logo/estilos en ambas páginas).

- **Catálogo abierto de tipos de producto (`calc_product_types`), no atado a
  las 9 categorías de IA40:** pedido explícito del usuario ("hay que dejar
  la lógica abierta a cualquier categoría, si mañana quisiera traer
  televisores con una consulta a IA deberíamos cambiar los supuestos que
  aplican en esa NCM"). Cada tipo de producto es una fila independiente con
  su propio arancel %, IVA %, CBM, PVP de mercado y Trader % — no hay un
  enum fijo de categorías, el usuario puede crear "Silla de Ruedas", "TV 32
  pulgadas" y "TV 65 pulgadas" como tres entradas separadas, cada una con su
  propia caché de IA (pedido explícito: "no es lo mismo una TV de 32 que una
  de 65").

- **Supuestos generales (`calc_supuestos`, fila única):** parámetros que
  aplican a TODOS los tipos de producto por igual — tipo de cambio, comisión
  ML, IIBB, PADS, tasa estadística, Ley 25413, seguro por unidad, fee bajo
  ticket + umbral de envío gratis, descuento de Distribución, flete
  marítimo + costos fijos de logística (forwarder, despachante, THC, flete
  local, manipuleo) y capacidad del contenedor en CBM. Todo editable a mano
  desde un modal ("⚙️ Supuestos generales").

- **Arancel, IVA, CBM y PVP de mercado se estiman por IA la primera vez que
  se crea un tipo de producto** (`lib/calcAi.ts`, mismo patrón de OpenAI
  Responses API + `web_search` + `gpt-5.4-mini` ya usado en
  `lib/aiClassifier.ts` y `lib/pvpFinder.ts` — deliberadamente duplicado en
  vez de compartido, siguiendo el criterio ya establecido en este proyecto
  de no tocar código ya probado). Quedan cacheados en `calc_product_types`
  con su propio nivel de confianza (alta/media/baja, mismo punto de color
  verde/amarillo/rojo que ya existía para el PVP del módulo principal) y
  razonamiento auditable. Cada campo se puede editar a mano o volver a
  consultar a la IA individualmente con un botón "🔄" (modal "✎ Editar").
  El endpoint `/api/calc/run` además actúa como red de seguridad: si algún
  campo quedó sin estimar (falla parcial al crear el tipo de producto),
  lo completa on-the-fly antes de calcular.

- **Trader % es 0% por defecto y siempre editable a mano** (pedido
  explícito: "el trader dejalo 0% y dejalo editable en el caso que tengamos
  que abonarlo") — no se estima por IA, es una decisión comercial del
  usuario caso a caso.

- **Flete marítimo se estima por IA (China → Buenos Aires, contenedor
  40HQ) y queda editable** ("el valor del flete también consultarlo a la
  IA y dejarlo editable en el caso que consigamos algo mejor") — tiene su
  propio botón "🔄" en el modal de Supuestos generales, independiente del
  refresco de arancel/IVA/CBM/PVP de cada tipo de producto (el flete es un
  supuesto global, no por producto).

- **Resolución del PVP de Mercado Libre — prioridad manual > caché > IA**
  (pedido explícito: "el PVP es algo que también quiero colocar yo
  manualmente, pero si no se coloca que lo calcule por IA"): si el usuario
  carga un PVP en el formulario de cálculo, se usa ese valor y NUNCA
  pisa el valor cacheado en el catálogo (es un dato de ese cálculo puntual,
  no una corrección permanente). Si lo deja vacío, se usa el PVP cacheado
  en `calc_product_types.pvp_ars_estimado`; si tampoco hay caché, se estima
  por IA en el momento y esa estimación sí se guarda en el catálogo para la
  próxima vez.

- **Canal Distribución: PVP = 65% del PVP de MeLi, solo se descuenta IIBB**
  (pedido explícito: "sobre el PVP de MeLi colocar un 35% de descuento —
  35% GM para el minorista"; y en la pregunta de aclaración sobre qué otras
  deducciones aplicar a Distribución, el usuario eligió "Solo IIBB
  (recomendado)"). El % de descuento es parte de los Supuestos generales
  (`descuento_distribucion_pct`), editable.

- **Fórmulas verificadas contra el caso real "SILLA RUEDAS CLASSIC"** de la
  hoja "Margen por FOB Conseguido" del Excel del cliente, para confirmar
  cada fórmula antes de programarla (`lib/importCalc.ts`, motor de cálculo
  puro sin llamadas a red/DB):
  - `CIF = FOB + Seguro` — el Trader se suma DESPUÉS del CIF, no antes
    (confirmado cruzando contra el número real de la planilla).
  - `Arancel / Tasa estadística / Ley 25413` se calculan como % sobre el
    CIF.
  - `Costo fijo por CBM = (flete marítimo + forwarder + despachante + THC +
    flete local + manipuleo) / capacidad del contenedor en CBM`; la
    logística de cada producto es `CBM del producto × ese costo fijo por
    CBM`.
  - `Costo Nacionalizado (USD) = CIF + Arancel + Tasa estadística + Ley
    25413 + Logística + Trader`, convertido a ARS con el tipo de cambio de
    Supuestos generales.
  - MeLi: `PVP neto = PVP con IVA / (1 + IVA%)`; se descuentan comisión ML,
    envío (neto, $0 si el PVP con IVA supera el umbral de envío gratis),
    IIBB y PADS (este último calculado sobre el PVP CON IVA, no sobre el
    neto — confirmado contra la planilla) y, si corresponde, el fee de
    "bajo ticket"; `Margen = PVP neto − deducciones − Costo Nacionalizado`.
  - El costo de envío al cliente (`envio_ars_con_iva`) queda como campo
    manual editable por tipo de producto (default $0): la planilla original
    ya aclaraba que es "proporcional al tamaño/peso... ajustar con
    cotización real por SKU", sin una fórmula limpia que reproducir.

- **Navegación:** botón "🧮 Cálculo de Importación" en el header del Módulo
  de Importaciones (`app/page.tsx`) que lleva a `/calculo-importacion`; ahí,
  un botón "← Volver al módulo de importaciones" para volver. Estilo nuevo
  `.app-header-nav-btn` en `app/globals.css` (pill semi-transparente, pensado
  para leerse bien sobre el fondo oscuro del header).

- **UX (20/07/2026) — spinner de carga en las consultas de IA del
  Calculador de Importación:** los botones que disparan una llamada a
  OpenAI (crear tipo de producto, los 4 "🔄" de recalcular en el modal de
  edición, "Calcular", y el "🔄" de flete en Supuestos generales) ahora
  muestran un spinner animado (`.spinner` en `app/globals.css`) mientras
  esperan la respuesta, en vez de solo texto -- pedido explicito del
  usuario ("colocar algun relojito animado para saber que esta
  pensando").

- **Fix de lógica (20/07/2026) — costo de envío de Mercado Libre corregido
  a la tabla real de MeLi:** el modelo anterior (campo manual
  `envio_ars_con_iva` por tipo de producto + "envío gratis" arriba de un
  umbral) no reflejaba cómo cobra MeLi en realidad. Reporte del usuario:
  "si el producto vale menos de 33000 entonces solo paga 2mil en concepto
  de Fee por producto de bajo valor, si vale mas de 33000 entonces:
  productos chicos (8000 ar$) productos medianos 12000 productos grandes
  (silla de ruedas) 32000". Cambios:
  - `calc_product_types.envio_ars_con_iva` (manual, ARS libre) se reemplazó
    por `tamano_envio` ('chico' | 'mediano' | 'grande'), elegible con un
    `<select>` en el modal "✎ Editar" en vez de un input numérico.
  - `calc_supuestos` gana 3 columnas nuevas: `envio_chico_ars` ($8.000
    default), `envio_mediano_ars` ($12.000), `envio_grande_ars` ($32.000);
    y la columna `umbral_envio_gratis_ars` se renombró a
    `umbral_bajo_valor_ars` (default $33.000, antes $30.000); el default de
    `fee_bajo_ticket_ars` subió de $1.200 a $2.000.
  - `lib/importCalc.ts`: si `pvpMeliArsConIva < umbralBajoValorArs` se
    cobra solo `feeBajoTicketArs`; si es mayor o igual, se cobra el costo
    de Mercado Envíos según `producto.tamanoEnvio` (nunca ambos a la vez,
    igual que antes). El campo `envioGratisAplica` se renombró a
    `envioPorTamanoAplica` porque el envío de MeLi nunca es gratis para el
    vendedor -- siempre paga el Fee de bajo valor O el costo por tamaño.
  - Investigamos si se podía consultar el costo real via la API pública de
    Mercado Libre (`GET /sites/MLA/listing_prices`, ver
    [Costos por vender](https://developers.mercadolibre.com.ar/es_ar/comision-por-vender)
    y [Costos de envío](https://developers.mercadolibre.com.ar/costos-de-envios))
    en vez de hardcodear los 3 montos. La API existe y es pública (sin
    auth), pero para que devuelva el costo de envío EXACTO en Argentina
    exige mandar `category_id`, `logistic_type`, `shipping_mode` y
    `billable_weight` -- datos que dependen de la configuración real de
    Mercado Envíos de la cuenta de Cobus (no solo del producto), y que no
    pudimos verificar en vivo esta sesión (herramientas de red/browser
    caídas). Se optó por dejar los 3 montos como supuestos editables
    (`calc_supuestos`) en vez de una integración en vivo no verificada;
    queda como mejora futura si se quiere una integración real con esa
    API una vez se puedan probar las llamadas end-to-end.

- **Integración (20/07/2026) — costo de envío real vía la API pública de
  Mercado Libre:** el usuario pidió explícitamente "como hacemos para que
  le pegue realmente a la api?" en vez de depender solo de la tabla fija
  chico/mediano/grande. Config confirmada con el usuario: Mercado Envíos
  **Full** (`logistic_type=fulfillment`) + Publicación **Clásica**
  (`listing_type_id=gold_special`). Implementación (`lib/meliApi.ts`):
  - `predecirCategoriaMeli(nombre)`: llama a
    `GET /sites/MLA/domain_discovery/search?q=...` (pública, sin auth) para
    predecir la categoría de MELI a partir del nombre del tipo de
    producto, y la cachea en `calc_product_types.ml_category_id` /
    `ml_category_nombre`.
  - `consultarCostosMeli({price, categoryId, billableWeightKg})`: llama a
    `GET /sites/MLA/listing_prices` con esos parámetros + `shipping_modes=me2`
    y devuelve el costo de envío real. El peso facturable
    (`calc_product_types.peso_kg`) se estima por IA igual que arancel/IVA/CBM
    (`estimarPesoKg` en `lib/calcAi.ts`).
  - `/api/calc/run` intenta esta consulta en cada cálculo (prediciendo
    categoría/peso si faltan y cacheándolos); si CUALQUIER paso falla (no
    hay categoría, no hay peso, la API no responde, JSON inesperado), cae
    automáticamente a la tabla fija de `tamano_envio` -- el cálculo nunca
    se rompe por esto. La respuesta de `/api/calc/run` incluye
    `envioFuente: "api" | "tabla_fija"` y el frontend lo muestra
    explícitamente ("Costo de envío usado: dato real de la API de Mercado
    Libre ✓" o "tabla fija").
  - **Limitación importante, léer antes de confiar en el resultado:**
    no se pudo probar NINGUNA llamada en vivo a esta API durante la sesión
    en que se escribió este código (las herramientas de red del entorno de
    desarrollo devolvían respuestas vacías o timeout incluso contra APIs
    ajenas a MELI, ver detalle en el historial de la conversación del
    20/07/2026). El parseo de `listing_prices` en `extraerCostoEnvio()`
    prueba varias claves candidatas (`shipping.list_cost`, `shipping.cost`,
    etc.) basadas en la documentación pública, pero NO están confirmadas
    contra una respuesta real. La primera vez que se use en producción,
    revisar `calc_product_types.envio_meli_api_status` /
    `envio_meli_api_razonamiento` (guarda el JSON crudo devuelto o el
    error) para confirmar si encontró el campo correcto -- si
    `envioFuente` sigue devolviendo `"tabla_fija"` siempre, lo más probable
    es que `extraerCostoEnvio()` necesite ajustarse a la forma real del
    JSON.

- **Integración (20/07/2026) — OAuth de Mercado Libre, confirmado
  necesario en producción:** al probar la integración de arriba contra
  producción, `listing_prices` con `logistic_type=fulfillment` devolvió
  **403** -- confirma que el costo de Mercado Envíos Full depende del
  contrato real de fulfillment de la cuenta de Cobus, no es un dato
  público genérico (a diferencia de `domain_discovery`, que sí funcionó
  sin auth: predijo bien "Sillas de Ruedas" para el producto de prueba).
  El usuario pidió avanzar con el registro OAuth completo. Implementado:
  - Tabla `meli_oauth` (fila única, `sql/schema.sql`): guarda
    `access_token` / `refresh_token` / `expires_at` de la cuenta real de
    Mercado Libre de Cobus. Las credenciales de la app (`MELI_CLIENT_ID` /
    `MELI_CLIENT_SECRET`) NO se guardan en la base, viven como variables de
    entorno en Vercel.
  - `GET /api/calc/meli-oauth/authorize`: redirige a la pantalla de login/
    autorización de Mercado Libre.
  - `GET /api/calc/meli-oauth/callback`: recibe el `code`, lo cambia por
    tokens (`lib/meliApi.ts` → `intercambiarCodigoOAuth()`) y los guarda;
    vuelve a `/calculo-importacion?meli_oauth=ok|error`.
  - `GET /api/calc/meli-oauth/status`: si hay `refresh_token` guardado, se
    considera "conectada" (usado por el botón "🔗 Conectar cuenta de
    Mercado Libre" / indicador "🟢 Mercado Libre conectado" en el frontend).
  - `getAccessToken()` en `lib/meliApi.ts`: devuelve el access_token
    vigente, refrescándolo automáticamente (Mercado Libre ROTA el
    refresh_token en cada uso -- siempre se guarda el nuevo). Si todavía no
    se conectó ninguna cuenta, tira `MeliAuthError` y `consultarCostosMeli`
    lo captura como cualquier otro error -- cae a la tabla fija, no rompe
    el cálculo.
  - **Setup pendiente del lado del usuario** (una sola vez): crear una app
    en developers.mercadolibre.com.ar con la cuenta real de Mercado Libre
    de Cobus, con Redirect URI EXACTO
    `https://ia40-dashboard-hztm.vercel.app/api/calc/meli-oauth/callback`;
    cargar `MELI_CLIENT_ID` y `MELI_CLIENT_SECRET` en Vercel (Environment
    Variables); y clickear "🔗 Conectar cuenta de Mercado Libre" una vez en
    el Calculador para autorizar.

- **Corrección (21/07/2026) — endpoint real del costo de envío:** con
  OAuth funcionando, `listing_prices` respondió 200 pero se confirmó en
  producción que ese endpoint sólo describe la COMISIÓN por vender
  (`sale_fee_amount` / `sale_fee_details.fixed_fee` -- este último dio 0,
  no es el costo de envío). El endpoint correcto (el mismo que usa
  https://www.mercadolibre.com.ar/simulador-de-costos) es
  `GET /users/$USER_ID/shipping_options/free`, confirmado en producción:
  dado `item_price` + `dimensions` (aproximadas con un cubo equivalente al
  CBM, ya que no se guardan L×A×H reales) + `logistic_type=fulfillment` +
  `listing_type_id=gold_special`, devuelve
  `coverage.all_country.list_cost` -- para la silla de ruedas de prueba dio
  **$33.570**, muy cerca de la estimación manual del usuario ($32.000 para
  "grande"). `lib/meliApi.ts` → `consultarCostosMeli()` y
  `extraerCostoEnvio()` se reescribieron para usar este endpoint.
  - **Fix de IVA (21/07/2026):** el costo que devuelve la API viene SIN
    IVA (a diferencia de la tabla fija editable, que se carga CON IVA) --
    el motor de cálculo dividía este valor por (1+IVA) igual que a la
    tabla fija, subestimando el costo real. `CalcProducto.envioArsNetoApi`
    (antes `envioArsConIvaApi`) ahora se usa directo como neto en
    `lib/importCalc.ts`, sin la división extra.

- **Tope de la Tasa de Estadística (21/07/2026):** comparado contra una
  calculadora pública de costos de importación, se detectó que la Tasa de
  Estadística de Aduana (3% sobre CIF) tiene un tope máximo en USD (la
  calculadora pública usa USD 180) que el motor no aplicaba. Se agregó
  `CalcSupuestos.tasaEstadisticaTopeUsd` (editable en "Supuestos
  generales", default 180) y `lib/importCalc.ts` ahora calcula
  `Math.min(cifUsd * tasaEstadisticaPct, tasaEstadisticaTopeUsd)`. No
  se agregaron las demás percepciones que muestra esa calculadora pública
  (IVA adicional 20%, Percepción Ganancias 6%, IIBB/SIRPEI 2.5%) -- pedido
  explícito del usuario: son recuperables como crédito fiscal para
  Responsable Inscripto, así que el calculador sigue mostrando el costo
  NETO real (post-recuperación), no el desembolso bruto en el momento del
  despacho.

- **Tipo de cambio automático vía API del BCRA (21/07/2026):** pedido
  explícito del usuario ("veamos de integrar a la api de BCRA para el
  tipo de cambio parece super sencilla"). Nuevo archivo `lib/bcra.ts` →
  `obtenerTipoCambioOficialBcra()`: llama a
  `GET https://api.bcra.gob.ar/estadisticascambiarias/v1.0/Cotizaciones/USD`
  (API de Estadísticas Cambiarias, sin autenticación, confirmada en vivo:
  devuelve `results[].detalle[].tipoCotizacion`, ej. `1389.50` con fecha
  `2026-05-21`). Nuevo endpoint `POST /api/calc/supuestos/refresh-tipo-cambio`
  y botón 🔄 al lado del campo "Tipo de cambio" en Supuestos generales.
  Solo corre cuando el usuario aprieta el botón -- el tipo de cambio sigue
  siendo editable a mano en cualquier momento (pedido explícito: "es un
  valor bastante oscilante").

## 10.5 Dólar oficial en el header + Portal de acceso (21/07/2026)

- **Dólar oficial en el header:** `components/AppHeader.tsx` consulta
  `GET /api/bcra/tipo-cambio` al montar (una sola vez, sin IA, sin guardar
  nada en la base) y muestra "USD oficial: $X.XXX" en el header de TODAS
  las páginas. Reusa `lib/bcra.ts` (mismo cliente del BCRA que el botón 🔄
  de "Tipo de cambio" en Supuestos del Calculador), pero es un dato
  puramente informativo -- no toca `calc_supuestos.tipo_cambio_ars`, que
  sigue siendo el que se usa para calcular y sigue siendo editable a mano.

- **Portal de acceso:** pedido explícito del usuario ("limitar los accesos
  de cualquier persona con acceso al link"), reutilizando el criterio de
  otro proyecto de Icom Salud (`icom_panel_unificado.html`, compartido como
  referencia): usuario/contraseña COMPARTIDOS para todo el equipo, sin
  cuentas individuales. Diferencia importante: la referencia validaba todo
  en el navegador (`const USERS = {...}` a la vista en el código fuente,
  saltable con la consola) -- acá se hace cumplir en el servidor:
  - `middleware.ts` (raíz del proyecto): corre antes de CUALQUIER página o
    API. Si la cookie `icom_auth` no coincide con `AUTH_SESSION_TOKEN`
    (variable de entorno), redirige a `/login` (o devuelve 401 si es una
    ruta `/api/*`). Si `AUTH_SESSION_TOKEN` no está configurado, no
    bloquea nada (evita dejar la app inaccesible por un olvido).
  - **Excluidas del gate a propósito** (las llama un tercero, no un
    navegador logueado): `/api/sync`, `/api/sync-images` (cron), todo
    `/api/calc/meli-oauth/*` (callback de Mercado Libre) y
    `/api/calc/meli-webhook` (notificaciones de Mercado Libre). También
    cualquier archivo estático (logos, `_next/*`).
  - `POST /api/login`: valida `{usuario, contrasena}` contra `AUTH_USERS`
    (variable de entorno, JSON, ej. `{"icom":"2026"}`) y si coincide guarda
    la cookie httpOnly `icom_auth = AUTH_SESSION_TOKEN`.
  - `POST /api/logout`: borra la cookie. Botón "Salir" agregado en
    `AppHeader.tsx`.
  - `app/login/page.tsx`: pantalla de login con la misma paleta/estilo del
    resto de la app (no se copió el HTML de la referencia, solo el
    criterio de usuario/contraseña compartidos).
  - **Setup pendiente del usuario** (una sola vez, Vercel → Environment
    Variables): `AUTH_USERS` (ej. `{"icom":"2026"}`) y
    `AUTH_SESSION_TOKEN` (cualquier string largo al azar).

## 10.6 Mejoras del Calculador: tamaño por CBM, unidades por contenedor, PVP persistente y repositorio de escenarios (21/07/2026)

Cuatro pedidos explícitos del usuario en la misma tanda, todos sobre
`app/calculo-importacion/page.tsx` y el motor de cálculo:

- **Tamaño de envío automático según CBM** (`lib/importCalc.ts`,
  `tamanoEnvioPorCbm()`): reemplaza la elección manual de tamaño (chico /
  mediano / grande) por una regla fija sobre el CBM del producto —
  `< 0,05 m³ = chico`, `0,05–0,12 m³ = mediano`, `> 0,12 m³ = grande`. Se
  aplica automáticamente cada vez que se estima o recalcula el CBM por IA
  (alta de producto, botón 🔄 CBM, y el "safety net" dentro de
  `/api/calc/run` cuando todavía no hay CBM cacheado). El campo sigue
  siendo editable a mano en "Editar" por si el usuario quiere forzar otro
  tamaño para un caso puntual.

- **Unidades por contenedor (40HC y 20FT)**: nuevo supuesto
  `capacidad20ftM3` (además del ya existente `capacidadCbmContenedor`, que
  representa el 40HC) — editable en Supuestos generales. La página
  calcula `Math.floor(capacidad / cbmProducto)` para cada tipo de
  contenedor y lo muestra en una barra informativa junto al resto de datos
  del producto ("Unidades por contenedor: 40HC: X un · 20FT: Y un"). Es
  puramente un cálculo de UI, no se guarda en la base por producto.

- **PVP manual persiste como PVP cacheado**: antes, cargar un PVP a mano
  en "Calcular" era un valor de un solo uso (no tocaba
  `calc_product_types.pvp_ars_estimado`). Pedido explícito del usuario:
  si carga el PVP MeLi a mano, eso debe actualizar el PVP de mercado
  cacheado (mostrado arriba, en la ficha del producto) — si no carga nada,
  se sigue usando el cacheado existente o, si no hay ninguno, se estima
  por IA como antes. `app/api/calc/run/route.ts` ahora hace un `update
  calc_product_types set pvp_ars_estimado=...` cuando `pvpArsManual` viene
  en el body.

- **Repositorio de escenarios guardados**: botón "💾 Guardar escenario" en
  el panel de resultados — al tocarlo pide (con un `prompt()`) quién
  guarda el escenario, y manda una foto completa del cálculo (supuestos +
  producto + resultado, tal cual están en pantalla en ese momento) a
  `POST /api/calc/scenarios`. Nueva tabla `calc_scenarios` (ver
  `sql/schema.sql`): cada fila es una foto fija, no una referencia — si
  después cambia el tipo de cambio o el CBM del producto, los escenarios
  viejos guardados no se ven afectados (es el punto: poder comparar qué
  hubiera dado el cálculo en cada momento). Nuevo panel "Historial de
  escenarios" debajo de los resultados, con un filtro por usuario
  (`GET /api/calc/scenarios?usuario=X`) y botón de borrado por fila
  (`DELETE /api/calc/scenarios/:id`). El campo "usuario" acá es solo una
  etiqueta de texto libre para filtrar — no tiene relación con las
  credenciales compartidas del Portal de acceso (sección 10.5).

- **Migración SQL pendiente** (correr en Neon antes de usar estas 4
  mejoras en producción): ver `sql/migration_20260721_escenarios.sql`
  (agrega `capacidad_20ft_m3`, `tasa_estadistica_tope_usd` y
  `tipo_cambio_fuente_fecha` a `calc_supuestos` si todavía no estaban, y
  crea la tabla `calc_scenarios`).

## 11. Endpoints API

| Endpoint | Método | Qué hace |
|---|---|---|
| `/api/sync` | GET | Sincroniza datos desde IA40 (todas las categorías, o una con `?category=`). Cron diario 6am UTC. |
| `/api/sync-images` | GET | Backfill manual de imágenes (no automático). |
| `/api/categories` | GET | Lista categorías con sus NCM asociados. |
| `/api/evolution` | GET | Serie mensual filtrable (marca/modelo/importador/color/segmento) para el gráfico y tablas del dashboard. Aplica `model_segmento_override`. |
| `/api/providers` | GET/POST | Lista importadores de una categoría (GET) / mapea importador→marca/modelo/color (POST). |
| `/api/records` | GET/POST | Lista líneas de detalle de una categoría, opcionalmente por importador (GET) / clasifica una línea puntual (POST). |
| `/api/model-images` | GET | Estado de búsqueda de imagen por marca/modelo de una categoría. |
| `/api/model-images/search` | POST | Busca (o cachea) la imagen de un modelo puntual, on-demand. |
| `/api/model-pvp` | GET | PVP en USD cacheado por marca/modelo de una categoría (ver sección 10.2). |
| `/api/model-pvp/search` | POST | Consulta (o cachea) el PVP en USD de un modelo puntual via OpenAI, on-demand. |
| `/api/model-overrides` | POST | Corrige a mano segmento y/o imagen de una combinación marca+modelo. |
| `/api/token` | POST (asumido) | Recibe el JWT que manda `refresh_token.py` y lo guarda en `app_settings`. Confirmado funcionando en producción, pero su archivo fuente no está en esta carpeta local (ver sección 7). |
| `/api/sieve` | GET | Tamizador de segmentos: busca en la web + IA y corrige/mueve modelos no validados de una categoría; de paso, completa el PVP en `model_pvp` con la misma búsqueda (ver secciones 10.1 y 10.2). Bajo demanda, sin cron. |
| `/api/sieve` | DELETE | "Limpiar tamizado": borra `model_sieve_log` de una categoría para poder re-tamizarla de cero (ver sección 10.2, botón "🧹 Limpiar tamizado"). |
| `/api/sieve/status` | GET | Progreso del tamizador para una categoría (`{total, tamizado, pendientes, porcentaje}`). Liviano, sin llamadas externas — usado para la barra de progreso. |
| `/api/pvp-sieve` | GET | "Completar PVP": corre en lote la búsqueda exhaustiva de precio (`lib/pvpFinder.ts`) sobre los modelos sin PVP `'found'` de una categoría (ver sección 10.2, botón "💲 Completar PVP"). |
| `/api/pvp-sieve/status` | GET | Progreso de PVP para una categoría (`{total, encontrados, pendientes, porcentaje}`). Liviano — usado para la barra de progreso del botón "Completar PVP". |
| `/api/calc/product-types` | GET/POST | Lista el catálogo de tipos de producto del Calculador de Importación (GET) / crea uno nuevo y dispara la estimación por IA de arancel, IVA y CBM en paralelo (POST, ver sección 10.3). |
| `/api/calc/product-types/:id` | PATCH/DELETE | Edita a mano cualquier campo de un tipo de producto (los campos de IA editados quedan marcados `razonamiento='(editado a mano)'`) / borra el tipo de producto. |
| `/api/calc/product-types/:id/refresh` | POST | `?field=arancel\|iva\|cbm\|pvp` — fuerza una nueva consulta a la IA para un solo campo puntual de un tipo de producto. |
| `/api/calc/supuestos` | GET/PATCH | Lee (y crea si no existe) / edita la fila única de Supuestos generales del Calculador de Importación. |
| `/api/calc/supuestos/refresh-flete` | POST | Fuerza una nueva consulta a la IA para el costo de flete marítimo internacional (China → Buenos Aires, contenedor 40HQ). |
| `/api/calc/run` | POST | `{productTypeId, fobUsd, pvpArsManual?}` — corre el cálculo completo (Costo Nacionalizado + margen MeLi/Distribución) para un tipo de producto y un FOB dados; ver sección 10.3 para la prioridad de resolución del PVP y del costo de envío (API de MeLi vs tabla fija). |
| `/api/calc/meli-oauth/authorize` | GET | Redirige a la pantalla de login/autorización de Mercado Libre (paso 1 del OAuth). |
| `/api/calc/meli-oauth/callback` | GET | Recibe el `code` de Mercado Libre, lo cambia por tokens y los guarda (paso 2 del OAuth). |
| `/api/calc/meli-oauth/status` | GET | `{conectado, expiresAt, updatedAt}` — si hay una cuenta de Mercado Libre conectada. |
| `/api/calc/meli-webhook` | GET/POST | Receptor de notificaciones (webhooks) de Mercado Libre — requerido por ML al tildar "Seleccionar Todo" en Tópicos al crear la app OAuth. Por ahora solo loguea y responde `{ok:true}`, no procesa nada. |
| `/api/calc/supuestos/refresh-tipo-cambio` | POST | Trae el dólar oficial más reciente de la API del BCRA (Estadísticas Cambiarias) y actualiza el Tipo de cambio de Supuestos generales. |
| `/api/bcra/tipo-cambio` | GET | Dólar oficial mayorista del BCRA para mostrar en el header (informativo, ver sección 10.5). |
| `/api/login` | POST | `{usuario, contrasena}` — valida contra `AUTH_USERS` y guarda la cookie de sesión (ver sección 10.5, Portal de acceso). |
| `/api/logout` | POST | Borra la cookie de sesión. |
| `/api/calc/scenarios` | GET/POST | Lista escenarios guardados, con filtro opcional `?usuario=` (GET) / guarda una foto completa de un cálculo ya corrido (POST, ver sección 10.6). |
| `/api/calc/scenarios/:id` | DELETE | Borra un escenario guardado puntual. |

## 12. Variables de entorno

⚠️ `.env.example` en el repo está desactualizado (todavía sugiere `IA40_JWT`
como único mecanismo de auth). Lista real de variables usadas en el código:

| Variable | Usada en | Propósito |
|---|---|---|
| `DATABASE_URL` | `lib/db.ts` | Conexión a Neon. |
| `IA40_JWT` | `lib/ia40.ts` | JWT para el flujo `/data` (categorías sin parser). Se actualiza a mano en Vercel. |
| `CRON_SECRET` | `app/api/sync/route.ts`, `app/api/sync-images/route.ts` | Protege los endpoints (`Authorization: Bearer` o `?secret=`). Si no está seteada, no bloquea (pensado para dev local). |
| `SYNC_MONTHS_BACK` | `app/api/sync/route.ts` | Meses de historial a traer en cada sync (default 24). |
| `SYNC_DATA_LAG_DAYS` | `app/api/sync/route.ts` | Días de gracia antes de considerar completo el mes anterior (default 15). |
| `SERPAPI_API_KEY` | `lib/imageSearch.ts` | Búsqueda de imágenes. |
| `IMAGE_BACKFILL_LIMIT` | `app/api/sync-images/route.ts` | Límite de imágenes a buscar por categoría en el backfill manual (default 80). |
| `TOKEN_UPDATE_SECRET` | referenciada por `refresh_token.py` | Secreto compartido para el endpoint `/api/token` (que hoy no existe — ver sección 7). |
| `OPENAI_API_KEY` | `lib/aiClassifier.ts` | Clasificación con IA del tamizador de segmentos (sección 10.1). Proyecto "cobus" en platform.openai.com, facturación por uso pagada por la empresa (no es lo mismo que ChatGPT Plus). |
| `SIEVE_BATCH_LIMIT` | `app/api/sieve/route.ts` | Cuántas combinaciones marca+modelo procesa el tamizador por click (default 100). |
| `SIEVE_CONCURRENCY` | `app/api/sieve/route.ts` | Cuántas de esas combinaciones procesa en paralelo (default 10). |
| `SIEVE_TIME_BUDGET_MS` | `app/api/sieve/route.ts` | Presupuesto de tiempo total del request antes de cortar el lote y devolver un resumen parcial (default 260000 = 260s). |
| `MELI_CLIENT_ID` | `lib/meliApi.ts`, `app/api/calc/meli-oauth/*` | Client ID de la app creada en developers.mercadolibre.com.ar con la cuenta real de Mercado Libre de Cobus (Calculador de Importación, sección 10.3). |
| `MELI_CLIENT_SECRET` | `lib/meliApi.ts` | Client Secret de esa misma app -- usado para intercambiar/refrescar tokens OAuth. Nunca se expone al frontend. |
| `AUTH_USERS` | `app/api/login/route.ts` | JSON con usuario/contraseña compartidos del Portal de acceso, ej. `{"icom":"2026"}` (sección 10.5). |
| `AUTH_SESSION_TOKEN` | `middleware.ts`, `app/api/login/route.ts` | String largo al azar (ej. `openssl rand -hex 32`) usado como valor de la cookie de sesión del Portal de acceso. Si no está seteada, el portal queda desactivado (no bloquea nada). |

## 13. Frontend

- **`app/page.tsx`** — dashboard principal: selector de categoría, filtros
  (marca/modelo/importador/color/segmento, con dropdown multi-selección
  buscable, `components/MultiSelectDropdown.tsx`), KPIs de header (último
  mes y últimos 12 meses, FOB y unidades), gráfico de evolución
  (`components/EvolutionChart.tsx`, Recharts, top 9 + "Otros"), tablas de
  share por importador/marca/modelo/segmento, y modal de imagen por modelo
  con edición inline de segmento/imagen.
- **`app/admin/page.tsx`** — pantalla de corrección manual: mapeo
  importador→marca/modelo/color y clasificación línea por línea.
- **`app/layout.tsx`** — layout raíz, carga la tipografía Poppins.
- **Diseño responsive** (`app/globals.css`): clases utilitarias
  (`.filter-field`, `.kpi-row`/`.stack-row` + `.panel`, `.chart-wrap`/
  `.pie-wrap`, `.table-scroll`, `.app-header-logo`) con breakpoints en
  900px, 640px (mobile), 1400px (pantallas anchas) y una regla especial por
  `orientation:landscape` + `max-height:480px` (celulares acostados). El
  ancho máximo del contenido es `min(1600px, 96vw)` — fluido en pantallas
  anchas/apaisadas, pero se comporta como los ~1180px de siempre en
  pantallas normales.

## 14. Deploy

Vercel + GitHub (deploy automático al actualizar un archivo desde la web de
GitHub, sin acción manual extra). `vercel.json` declara un único cron:
`/api/sync` todos los días a las 6am UTC. No hay cron para `/api/sync-images`
(ver sección 10).

## 15. Historial de bugs importantes (para no repetirlos)

- **Inflación de FOB 10x-100x** — `parseArgNumber` se aplicaba sin distinguir
  el formato argentino (miles con ".", decimal con ",") del formato plano
  (solo "." decimal) que usa `SUB ITEMS - FOB U$S`. Corregido con detección
  de formato antes de parsear (`parseMoneyOrPlain`).
- **Pérdida de datos por ZIP** — el export de IA40 a veces llega
  comprimido en ZIP en vez de CSV plano; `downloadExportFile` ahora detecta
  el ZIP por sus magic bytes y lo descomprime con `jszip` antes de parsear.
- **`ON CONFLICT` no actualizaba `category_id`** — al re-procesar una fila ya
  insertada (mismo `source_hash`) bajo una categoría distinta a la original
  (por ejemplo, tras corregir el diccionario de marcas de ortopedia), el
  `ON CONFLICT ... DO UPDATE` solo tocaba marca/modelo/color/segmento, y la
  fila quedaba pegada para siempre a la categoría vieja. Corregido agregando
  `category_id`, `ncm_code`, `period`, `cuit`, `raw`, `fob_dolars` al
  `DO UPDATE SET` en ambas funciones de upsert (`lib/aggregate.ts`).
- **Contaminación de NCM legacy en "bastones"** — antes de la arquitectura de
  NCM compartido, bastones usaba un NCM histórico distinto (6602.00.00); tras
  migrar a 9021.10.10 compartido, quedaron ~737 filas viejas mezcladas con
  las ~371 correctas. Se limpiaron con un DELETE dirigido por NCM. **Pendiente
  de confirmación final del usuario** (tarea #57 en el historial de trabajo).
- **"Último mes" mostrando 0 USD / 0 unidades** — cuando una fila traía una
  fecha no parseable, el código la insertaba igual usando **la fecha de HOY**
  como fallback de período. Esto creaba un mes falso (ej. el mes calendario
  en curso) con `record_count > 0` pero FOB/unidades en 0, que — por ser
  cronológicamente el más reciente — ganaba como "Último mes" en el
  dashboard y tapaba el mes real anterior. Corregido: esas filas ahora se
  **descartan** en vez de insertarse con fecha inventada (contador
  `skippedSinFecha` en `lib/aggregate.ts`). Cualquier fila con
  `period >= <mes calendario actual>` en `trade_records` es sospechosa de
  ser basura de este bug (el sync nunca trae el mes en curso, ver sección 6)
  y es seguro borrarla. **Pendiente de confirmación final del usuario**
  (tarea #59).
- **El sync diario nunca llega a agosto 2026 (PC dormida a las 03:00 ART)**
  — reportado 18/09/2026 ("chequea porque no actualizo a agosto"). El cron
  de Vercel (`vercel.json`, `/api/sync`) corre a las 06:00 UTC = 03:00 en
  Argentina. A esa hora la PC del usuario (donde corre `refresh_token.py`
  cada 10 min, sección 7) está normalmente dormida — confirmado en
  `%LOCALAPPDATA%\CobusSync\log.txt`: el 17/09/2026 el último refresh
  exitoso antes de dormirse la PC fue a las 17:26 ART, con un error de red
  (`net::ERR_NETWORK_IO_SUSPENDED`, típico de que Windows suspende la red al
  dormir) a las 21:08 ART, y recién retomó a las 08:35 ART del día
  siguiente. Como el token guardado vence a los 20 min (`MAX_TOKEN_AGE_MIN`,
  sección 7), CUALQUIER corrida del cron mientras la PC duerme falla con
  `Ia40AuthError` para TODAS las categorías. Confirmado también consultando
  `/api/evolution` en vivo: el período más nuevo en la base es
  `2026-07-01`, ninguna fila de agosto. Esto no es un bug puntual — pasa
  TODAS las noches con la configuración actual, así que el sync automático
  probablemente nunca tuvo éxito desde que se instaló `CobusSync_Installer`
  (los datos hasta julio deben venir de alguna corrida manual en horario de
  oficina). Corrección propuesta en sección 16.
- **4 parsers usando el patrón de aduana equivocado** — `almohadones_ortopedicos`,
  `sillas_ducha`, `elevadores_inodoro` y `camas_hospitalarias` usaban el
  motor genérico de Patrón A (pensado para "Sillas de ruedas": marca+modelo
  juntos en un texto) cuando su texto real es Patrón B (`"SIN MODELO"` como
  separador explícito) — ver sección 8. Se reescribieron los 4 como
  funciones standalone con sus propios diccionarios de marca y árboles de
  Segmento. De paso se renombraron 2 categorías ("Almohadones Ortopédicos"
  → "Almohadas y Cojines", "Sillas de Ducha" → "Sillas y Asientos") porque
  sus NCM traen en la práctica mucha data no ortopédica, y se agregó
  preselección de Segmento por defecto en el frontend para esas 3
  categorías + Elevadores de Inodoro. **Pendiente de confirmación del
  usuario tras el primer sync real con el parser nuevo** (tarea #71).

## 16. Deuda técnica conocida / pendientes

- `sql/schema.sql` no incluye `app_settings` ni `model_segmento_override`
  (sección 5) — reconstruir la base desde este archivo solo no alcanza.
- `README.md` y `.env.example` describen una versión vieja del proyecto (una
  sola categoría piloto, auth solo por variable de entorno) — no reflejan el
  estado actual. Convendría actualizarlos o al menos linkearlos a este
  documento.
- El endpoint `/api/token` que necesita `refresh_token.py` está confirmado
  funcionando en producción (sección 7), pero su archivo fuente no aparece
  en esta carpeta local — conviene confirmar en GitHub que existe y, si es
  posible, traer ese archivo de vuelta a esta carpeta para que quede
  completa y sincronizada con lo que realmente corre en Vercel.
- `lib/parsers/sillasDeRuedas.ts` podría estar huérfano (reemplazado por la
  lógica generalizada de `lib/parsers/index.ts`) — revisar si se puede
  eliminar.
- El backfill de imágenes (`/api/sync-images`) no corre automáticamente
  (sección 10) — es 100% manual hoy.
- Limpiezas de datos pendientes de confirmación final (sección 15, bastones
  y filas fantasma de julio 2026).
- Reglas de Segmento de Camas Hospitalarias basadas en prefijo de código son
  heurísticas de mejor esfuerzo (sección 8) — revisar contra el primer sync
  real.
- Filas "HIP BRACE" (marca Jianwei, dentro de `andadores`) quedan marcadas
  como "(revisar)" en vez de reclasificarse automáticamente fuera de la
  categoría — requiere decisión del usuario sobre dónde deberían ir (el
  tamizador de segmentos, sección 10.1, debería terminar corrigiendo estas
  también al pasar por esa categoría).
- El tamizador de segmentos (sección 10.1) es nuevo y no se validó todavía a
  gran escala — conviene revisar los primeros resultados reales (sobre todo
  los "categoria_movida", que tocan datos entre categorías) antes de confiar
  en él a ciegas para categorías enteras.
- **Cron diario en un horario en que la PC de `refresh_token.py` está
  dormida** (sección 15, 18/09/2026) — el sync automático probablemente
  nunca tuvo éxito desde que se instaló `CobusSync_Installer`. **Corrección
  propuesta, no aplicada todavía (pendiente de confirmar con el usuario):**
  cambiar `vercel.json` de `"0 6 * * *"` (06:00 UTC = 03:00 ART) a un
  horario dentro de la ventana en que la PC está despierta según 3 días
  seguidos de `log.txt` (ej. `"0 14 * * *"` = 14:00 UTC = 11:00 ART) — no
  soluciona el caso puntual de que la PC esté apagada justo ese día, pero
  deja de fallar SIEMPRE como hoy. Corrección más robusta a futuro: mover
  el refresh del token a un entorno que no dependa de una PC física
  encendida (ej. un navegador headless corriendo en un servicio cloud), no
  en la PC del usuario.

## 17. Cómo agregar una categoría nueva (receta rápida)

1. Confirmar el código NCM real contra IA40 (ver metodología en
   `docs/ncm_nuevas_categorias.md`).
2. Insertar en `categories` y `category_ncm_codes` (SQL manual en Neon).
3. Insertar los `field_mappings` necesarios si los nombres de campo del JSON
   crudo no son los default (`marca_comercial`, etc. — ver
   `getFieldMappings`/`mappingLookup` en `lib/aggregate.ts`).
4. Si necesita identificar marca/modelo automáticamente, registrar un parser
   en `CATEGORY_PARSERS` (`lib/parsers/index.ts`) — esto activa
   automáticamente el flujo de exportación para esa categoría.
5. Correr `/api/sync?category=<slug>` para probar en aislado antes del sync
   completo.
