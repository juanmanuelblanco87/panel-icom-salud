// api/_alquileres-formula.js
//
// Alquileres -- fórmula de precio sugerido.
//
// 25/08/2026 ("la inflación acumulada se debe [medir] desde la última
// actualización de precios, para eso es necesario ir guardando mes a
// mes los registros"): la primera versión pedía un "% acumulado" a
// mano, sin ningún ancla temporal -- un número que alguien tenía que
// acordarse de actualizar, exactamente el problema que esta
// herramienta buscaba evitar. Ahora los MESES no se tipean: se derivan
// del historial mensual (alquilerSnapshot, ya se guarda solo vía el
// cron) buscando desde cuándo el precio vigente de Oppen viene siendo
// el mismo -- sólo el % de inflación MENSUAL es un parámetro (mucho
// más estable en el tiempo que un acumulado que hay que ir corriendo).
//
// 25/08/2026 (2do rediseño, "no me gusta la logica... casi la mitad de
// precio que la competencia"): la versión anterior tomaba el MAYOR
// entre 2 pisos (amortización simple del 100% del precio nuevo, y
// ajuste por inflación) y nunca miraba el mercado -- si el precio
// vigente arrancó bajo, se quedaba bajo para siempre (la inflación lo
// ajusta, pero nunca lo corrige contra la realidad del mercado). Pedido
// explícito del usuario, con números concretos:
//   - PISO (mínimo aceptable, cuida rentabilidad): costo real por uso
//     (50% del precio de venta del producto nuevo, dividido la
//     cantidad de usos) con el margen bruto objetivo aplicado --
//     precio = costo / (1 - GM%) -- MISMO criterio que ya usa
//     ajustadoInflacion (el mayor de los pisos disponibles gana).
//   - TECHO (tope duro, nunca se sugiere por encima): el menor entre
//     (a) 90% del precio de la competencia -- "quedemos siempre un 10%
//     por debajo" -- y (b) 35% del precio del producto nuevo --
//     "que el costo del alquiler no supere el 35% de lo que cuesta uno
//     nuevo". A diferencia del piso (siempre gana el juego), el techo
//     es una restricción de negocio que NUNCA se cruza -- si el piso
//     (costo+margen) pide más de lo que el techo permite, se avisa el
//     conflicto (`limitadoPorTecho:true`) y se sugiere el techo, nunca
//     el piso -- mejor perder margen a propósito, con aviso, que
//     sugerir un precio que el usuario dijo explícitamente que no
//     quiere.
// El precio de mercado (competencia) sigue siendo un dato scrapeado,
// no siempre confiable -- pedido explícito del usuario igual, así que
// entra como TECHO (nunca mezclado/promediado). OJO: a diferencia del
// diseño anterior (donde mercado no participaba en absoluto), un dato
// de competencia scrapeado MAL (ej. un precio irrisorio de otra
// sección de la página, el mismo bug que ya se corrigió una vez en
// alquileres-scrape.js) ahora SÍ puede arrastrar el precio sugerido
// para abajo -- por eso conviene revisar el precio de competencia
// scrapeado ("revisá este valor") antes de confiar en la sugerencia
// resultante, mismo criterio de "una persona en el medio" del resto
// del módulo.

// 26/08/2026 ("patron de redondeo 99"): el redondeo pasa de "al
// múltiplo más cercano" (ej. $5.234 -> $5.000) a precios psicológicos
// terminados en 99 (ej. $5.234 -> $4.999, con inc=1000) -- se redondea
// al múltiplo más cercano de `inc` y se le resta 1.
//
// 01/09/2026 ("en alquileres diarios estas sugiriendo alquilar a -1"):
// bug real confirmado -- `inc` (redondeo, un parámetro GLOBAL calibrado
// para precios de escala mensual, ej. $1000) es demasiado grueso para
// un valor chico como un alquiler diario. Si Math.round(v/inc)*inc daba
// 0 (v menor a medio `inc`), el "-1" de más arriba lo dejaba en -$1 --
// un precio negativo sin sentido. Guard: si el redondeo al múltiplo más
// grueso se come el valor entero, se cae a redondear al entero más
// cercano sin el patrón "99" (ese patrón psicológico tampoco tiene
// sentido en números tan chicos).
function round(v, inc) {
  if (v == null || !inc) return v;
  const r = Math.round(v / inc) * inc;
  if (r <= 0) return v > 0 ? Math.max(1, Math.round(v)) : v;
  return r - 1;
}

// 02/09/2026 ("El costo en alquileres no deberia quedar redondeado en
// .999 deberia ser el exacto"): round() de arriba está pensado para el
// PRECIO de venta (terminación psicológica ".999", pensada para que el
// cliente la vea) -- costoPorUso es un dato interno (cuánto cuesta de
// verdad proveer el alquiler), no un precio que se le muestra al
// cliente, no tiene sentido "deflactarlo" -- se redondea al peso más
// cercano, exacto, sin el "-1".
function roundCosto(v) {
  if (v == null) return v;
  return Math.round(v);
}

function mesActual() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// 'YYYY-MM' -> 'YYYY-MM', cantidad de meses de diferencia (siempre >= 0
// para el uso que le damos acá, mesB posterior o igual a mesA).
function mesesEntre(mesA, mesB) {
  const [ay, am] = mesA.split('-').map(Number);
  const [by, bm] = mesB.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

// Inflación compuesta durante `meses` meses a la tasa mensual `monthlyPct`.
function inflacionCompuesta(monthlyPct, meses) {
  if (!meses || meses <= 0) return 0;
  return Math.pow(1 + (monthlyPct || 0) / 100, meses) - 1;
}

// snapshotsOrdenadosAsc: [{mes:'YYYY-MM', precioVigenteOppen}] del
// producto, ya ordenados de más viejo a más nuevo (ver alquileres-data.js).
// precioActual: el precio vigente de Oppen HOY (puede no estar todavía
// en ningún snapshot, si cambió después del último corte mensual).
// Devuelve null si no hay ningún snapshot guardado todavía (recién
// arrancó el historial, ver el cron en alquileres-snapshot.js) -- en
// ese caso el ajuste por inflación queda sin dato hasta el primer
// snapshot, en vez de inventar un número.
function mesesDesdeUltimoCambioDePrecio(snapshotsOrdenadosAsc, precioActual, mesActualStr) {
  if (!snapshotsOrdenadosAsc || !snapshotsOrdenadosAsc.length || precioActual == null) return null;
  // Si ni siquiera el snapshot más reciente coincide con el precio de
  // hoy, el precio cambió DESPUÉS del último corte -- la racha "recién
  // empieza" (0 meses, no "desconocido").
  let mesInicioRacha = mesActualStr;
  for (let i = snapshotsOrdenadosAsc.length - 1; i >= 0; i--) {
    if (snapshotsOrdenadosAsc[i].precioVigenteOppen === precioActual) {
      mesInicioRacha = snapshotsOrdenadosAsc[i].mes;
    } else {
      break;
    }
  }
  return mesesEntre(mesInicioRacha, mesActualStr);
}

const GM_DEFAULT_PCT = 50; // ver comentario de arriba -- confirmado con el usuario, 25/08/2026
const COSTO_ADMINISTRATIVO_DEFAULT = 1000; // "dejalo con default 1000 pero editable" -- confirmado con el usuario, 25/08/2026
const FRACCION_COSTO_DEL_NUEVO = 0.5; // "el costo es el 50% del precio de venta"
const DESCUENTO_VS_COMPETENCIA = 0.10; // "quedemos siempre por debajo de la competencia, un 10%"
const TOPE_PCT_DEL_NUEVO = 0.35; // "que el costo del alquiler no supere el 35% de lo que cuesta uno nuevo"
// 27/08/2026 ("no me gusta esta formula... el valor actual no debería
// pesar, deberíamos usar el mismo criterio para todos inicialmente, y
// recién mes 2/3/4 corregir por inflación"): antes, CUALQUIER producto
// con al menos 1 snapshot guardado (aunque sea de este mismo mes, 0
// meses de antigüedad) ya competía con precioVigenteOppen -- el precio
// que HOY tiene cargado en Oppen, sin ninguna lógica de costo/margen/
// mercado detrás -- como un piso alternativo, muchas veces más alto
// que costo+margen. 2 productos con el mismo costo y el mismo margen
// objetivo podían terminar sugiriendo precios muy distintos (ej. caso
// real: $8.999 vs $14.999) sólo porque uno tenía snapshot y el otro
// no -- un escalón de golpe el día que al segundo le llega su primer
// snapshot, sin que cambie nada del negocio.
const MESES_MIN_DEFAULT = 3;

// 01/09/2026 (2do rediseño, "invierte los botones... el precio que
// 'manda' es el mensual, desde ahi se re-calculan automaticamente el
// resto" + "cuantos menos dias alquilen mas rentable debe ser para
// ICOM y mas honeroso -precio unitario- para el cliente"): la 1ra
// versión de "selector de Período" evaluaba piso/techo/inflación de
// forma INDEPENDIENTE en cada período, sólo escalando costo/techo por
// los días -- con montos chicos y un `redondeo` calibrado para precios
// mensuales, esto degeneraba en resultados sin sentido (ver el fix de
// `round()` más arriba, "-1"). Rediseño: sólo el período MENSUAL corre
// la fórmula completa de piso+techo+inflación (siempre a 30 días, sea o
// no el período canónico del producto en Oppen) -- Diario/Semanal/
// Quincenal se DERIVAN de ese precio mensual con un factor > 1 por
// período (editable en Parámetros globales, ver FACTOR_*_DEFAULT):
// encarece el precio POR DÍA cuanto más corto el alquiler, a propósito
// -- más rentable para ICOM, más honeroso para el cliente, mismo
// criterio que cualquier mercado real de alquileres. Ver
// derivarSugeridoDesdeMensual más abajo (usado desde alquileres-data.js/
// alquileres-snapshot.js) -- calcularSugerencia en sí queda para
// MENSUAL (y para "manual", que gana en cualquier período).
// 02/09/2026 ("Haz todavia mas oneroso y con mayor margen los precios
// por dia, semana y quincena, que se vaya incrementando el ratio"):
// factores más altos que la 1ra versión, con un INCREMENTO creciente
// mes->quincena->semana->dia (+0.5 / +0.8 / +1.2 -- el escalón se
// agranda cuanto más corto el período, no un paso parejo).
const FACTOR_DIARIO_DEFAULT = 3.5;
const FACTOR_SEMANAL_DEFAULT = 2.3;
const FACTOR_QUINCENAL_DEFAULT = 1.5;
// Mapa por DÍAS del período (no por nombre) -- mismo dato que
// `periodoDias` en el catálogo, evita otro nivel de traducción.
const FACTOR_POR_PERIODO_DIAS_DEFAULT = { 1: FACTOR_DIARIO_DEFAULT, 7: FACTOR_SEMANAL_DEFAULT, 15: FACTOR_QUINCENAL_DEFAULT, 30: 1 };

// 02/09/2026 ("chequea los margenes... no puede tener menos margen
// alquilando por dia que por mes" -- luego, mismo día: "El factor por
// periodo esta bien, pero quita el margen asegurado porque traba la
// formula del factor"): se había agregado un piso de margen mínimo
// por período (costo/(1-gm%), el mayor entre esto y el factor) para
// garantizar la ordenación de márgenes -- pedido explícito de sacarlo,
// el piso terminaba "compitiendo" con el factor y ganándole casi
// siempre (tapaba el efecto del factor, que es el que el usuario
// quiere controlar directamente). Vuelve a ser SÓLO el factor -- el
// usuario ajusta el margen resultante subiendo el factor a mano si
// hace falta (ver la columna Costo/Margen de la tabla).

// Costo real por uso (informativo -- SIEMPRE se calcula, sea cual sea
// el método que termine definiendo el precio, ver comentario junto a
// conMargen más abajo) -- extraído de calcularSugerencia para poder
// reusarlo también en las filas DERIVADAS (Diario/Semanal/Quincenal),
// que ya no pasan por calcularSugerencia pero igual necesitan un costo
// de referencia propio para mostrar margenPct.
// `vidaUtilDias` reinterpreta usosMaximos (cargado pensando en SU
// período canónico, ej. 20 alquileres mensuales) en días totales de
// vida útil del producto físico (20*30 = 600 días) -- de ahí sale un
// costo POR DÍA, multiplicado por la duración del período pedido.
// costoAdministrativo NO se escala por período a propósito: es un
// costo fijo por operación de entrega/retiro/limpieza, se paga igual
// si el alquiler dura 1 día o 30.
function calcularCostoPorUso(config, periodoDias, periodoDiasCanonico, costoAdministrativo) {
  const diasCotizados = periodoDias || 30;
  const diasCanonico = periodoDiasCanonico || 30;
  const vidaUtilDias = (config && config.usosMaximos > 0) ? config.usosMaximos * diasCanonico : null;
  const costoProductoPorUso = (vidaUtilDias != null && config.precioProductoNuevo > 0)
    ? (config.precioProductoNuevo * FRACCION_COSTO_DEL_NUEVO / vidaUtilDias) * diasCotizados
    : null;
  return costoProductoPorUso != null ? costoProductoPorUso + (costoAdministrativo || 0) : null;
}

// 01/09/2026 (encontrado probando con números reales, "chequea que en
// alquileres diarios estas sugiriendo alquilar a -1"): el `redondeo`
// GLOBAL (calibrado para precios de escala MENSUAL, ej. $1000) es
// demasiado grueso para valores Diario/Semanal/Quincenal, que son
// naturalmente mucho más chicos -- aplicado tal cual, el ruido del
// redondeo terminaba siendo del mismo orden de magnitud que la prima
// del 20-80% que estos factores buscan reflejar, y en algunos casos
// invertía el orden esperado (Semanal terminaba pareciendo más barato
// por día que Quincenal, pura casualidad del redondeo, no de la
// fórmula). Estos 3 períodos SIEMPRE redondean fino ($100), sin
// importar qué `redondeo` haya elegido el usuario para Mensual --
// mantiene la precisión relativa de la prima por período, que es
// justamente lo que hay que preservar acá.
const REDONDEO_DERIVADO = 100;

// mensualSugerido: number|null -- el `sugerido` YA resuelto de la fila
// Mensual de este producto (piso+techo+inflación, o manual -- lo que
// haya ganado ahí, ver calcularSugerencia). periodoDias: 1|7|15 (nunca
// 30 -- Mensual no se deriva de sí mismo). factores: { 1, 7, 15 } (ver
// FACTOR_POR_PERIODO_DIAS_DEFAULT) -- multiplicador sobre la tarifa
// DIARIA implícita del mensual (mensual/30). Devuelve null si todavía
// no hay precio mensual del que partir (producto sin costear).
function derivarSugeridoDesdeMensual(mensualSugerido, periodoDias, factores) {
  if (mensualSugerido == null) return null;
  const factor = (factores && factores[periodoDias] != null) ? factores[periodoDias] : (FACTOR_POR_PERIODO_DIAS_DEFAULT[periodoDias] || 1);
  const precioPorDia = (mensualSugerido / 30) * factor;
  return round(precioPorDia * periodoDias, REDONDEO_DERIVADO);
}

// config: { usosMaximos, precioProductoNuevo, precioMercado, overrideManual }
// precioVigenteOppen: number|null (derivado de Oppen, ver alquileres-data.js)
// mesesSinActualizar: number|null (ver mesesDesdeUltimoCambioDePrecio)
// periodoDias/periodoDiasCanonico: ver calcularCostoPorUso -- en la
// práctica esta función sólo se llama con periodoDias=30 (Mensual,
// ver comentario grande de arriba) o para "manual" en cualquier período.
// g: { monthlyPct, redondeo, gmObjetivoPct, costoAdministrativo }
function calcularSugerencia(config, precioVigenteOppen, mesesSinActualizar, periodoDias, periodoDiasCanonico, g) {
  const redondeo = (g && g.redondeo) || 100;
  const gmObjetivoPct = (g && g.gmObjetivoPct != null) ? g.gmObjetivoPct : GM_DEFAULT_PCT;
  const costoAdministrativo = (g && g.costoAdministrativo != null) ? g.costoAdministrativo : COSTO_ADMINISTRATIVO_DEFAULT;
  const mesesMinInflacion = (g && g.mesesMinInflacion != null) ? g.mesesMinInflacion : MESES_MIN_DEFAULT;

  // Juan Manuel, 25/08/2026 ("Agrega el costo y margen al lado de
  // periodo"): costoPorUso se calcula SIEMPRE (aunque el método
  // ganador termine siendo otro, ej. 'manual' o 'ajuste inflación') --
  // es el dato de costo real, útil como referencia en la tabla
  // independientemente de qué método haya definido el precio final.
  // margenPct se calcula al final, contra el `sugerido` DEFINITIVO (ya
  // topeado si correspondía) -- es el margen REAL que se obtiene al
  // precio que efectivamente se va a cobrar, no el objetivo teórico.
  const costoPorUso = calcularCostoPorUso(config, periodoDias, periodoDiasCanonico, costoAdministrativo);
  function conMargen(resultado) {
    const margenPct = (costoPorUso != null && resultado.sugerido > 0)
      ? ((resultado.sugerido - costoPorUso) / resultado.sugerido) * 100
      : null;
    return Object.assign({ costoPorUso: roundCosto(costoPorUso), margenPct }, resultado);
  }

  if (config && config.overrideManual != null) {
    return conMargen({
      sugerido: config.overrideManual, metodo: 'manual', mesesSinActualizar,
      pisoCostoMargen: null, ajustadoInflacion: null, techoCompetencia: null, techoReposicion: null, limitadoPorTecho: false,
    });
  }

  // PISO: el mayor de los 2 disponibles (mismo criterio de siempre --
  // "el mayor de los pisos gana", nunca se promedian).
  // Margen bruto = (precio - costo) / precio  =>  precio = costo / (1 - GM%)
  const pisoCostoMargen = (costoPorUso != null && gmObjetivoPct != null && gmObjetivoPct < 100)
    ? round(costoPorUso / (1 - gmObjetivoPct / 100), redondeo)
    : null;

  // 27/08/2026 ("mismo criterio para todos inicialmente, recién mes
  // 2/3/4 corregir por inflación"): antes alcanzaba con
  // mesesSinActualizar != null (0 meses ya calificaba) -- ahora hace
  // falta al menos `mesesMinInflacion` meses de precio estable en
  // Oppen para que ese precio vigente empiece a competir como piso.
  // Con menos, TODOS los productos arrancan del mismo lugar (costo +
  // margen objetivo), tengan o no snapshot todavía -- ver
  // pisoCostoMargen arriba.
  const ajustadoInflacion = (precioVigenteOppen != null && mesesSinActualizar != null && mesesSinActualizar >= mesesMinInflacion)
    ? round(precioVigenteOppen * (1 + inflacionCompuesta((g && g.monthlyPct) || 0, mesesSinActualizar)), redondeo)
    : null;

  const candidatosPiso = [pisoCostoMargen, ajustadoInflacion].filter(v => v != null);
  const base = candidatosPiso.length ? Math.max(...candidatosPiso) : null;

  // TECHO: el MENOR de los 2 disponibles -- a diferencia del piso, acá
  // "el más restrictivo gana" (nunca se sugiere por encima de NINGUNO
  // de los 2 límites de negocio).
  const techoCompetencia = (config && config.precioMercado > 0)
    ? round(config.precioMercado * (1 - DESCUENTO_VS_COMPETENCIA), redondeo)
    : null;
  const techoReposicion = (config && config.precioProductoNuevo > 0)
    ? round(config.precioProductoNuevo * TOPE_PCT_DEL_NUEVO, redondeo)
    : null;
  const techos = [techoCompetencia, techoReposicion].filter(v => v != null);
  const techo = techos.length ? Math.min(...techos) : null;

  if (base == null) {
    return conMargen({ sugerido: null, metodo: 'sin datos', mesesSinActualizar, pisoCostoMargen, ajustadoInflacion, techoCompetencia, techoReposicion, limitadoPorTecho: false });
  }

  const limitadoPorTecho = techo != null && base > techo;
  const sugerido = limitadoPorTecho ? techo : base;
  let metodo;
  if (limitadoPorTecho) {
    metodo = techo === techoCompetencia ? 'topeado por competencia' : 'topeado por costo de reposición';
  } else {
    metodo = base === pisoCostoMargen ? 'piso costo + margen' : 'ajuste inflación';
  }

  return conMargen({ sugerido, metodo, mesesSinActualizar, pisoCostoMargen, ajustadoInflacion, techoCompetencia, techoReposicion, limitadoPorTecho });
}

module.exports = {
  round, roundCosto, mesActual, mesesEntre, inflacionCompuesta,
  mesesDesdeUltimoCambioDePrecio, calcularSugerencia,
  calcularCostoPorUso, derivarSugeridoDesdeMensual,
  GM_DEFAULT_PCT, MESES_MIN_DEFAULT, REDONDEO_DERIVADO,
  FACTOR_DIARIO_DEFAULT, FACTOR_SEMANAL_DEFAULT, FACTOR_QUINCENAL_DEFAULT,
};
