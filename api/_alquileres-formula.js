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
function round(v, inc) {
  if (v == null || !inc) return v;
  return Math.round(v / inc) * inc - 1;
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

// config: { usosMaximos, precioProductoNuevo, precioMercado, overrideManual }
// precioVigenteOppen: number|null (derivado de Oppen, ver alquileres-data.js)
// mesesSinActualizar: number|null (ver mesesDesdeUltimoCambioDePrecio)
// g: { monthlyPct, redondeo, gmObjetivoPct, costoAdministrativo }
function calcularSugerencia(config, precioVigenteOppen, mesesSinActualizar, g) {
  const redondeo = (g && g.redondeo) || 100;
  const gmObjetivoPct = (g && g.gmObjetivoPct != null) ? g.gmObjetivoPct : GM_DEFAULT_PCT;
  const costoAdministrativo = (g && g.costoAdministrativo != null) ? g.costoAdministrativo : COSTO_ADMINISTRATIVO_DEFAULT;

  // Juan Manuel, 25/08/2026 ("Agrega el costo y margen al lado de
  // periodo"): costoPorUso se calcula SIEMPRE (aunque el método
  // ganador termine siendo otro, ej. 'manual' o 'ajuste inflación') --
  // es el dato de costo real, útil como referencia en la tabla
  // independientemente de qué método haya definido el precio final.
  // margenPct se calcula al final, contra el `sugerido` DEFINITIVO (ya
  // topeado si correspondía) -- es el margen REAL que se obtiene al
  // precio que efectivamente se va a cobrar, no el objetivo teórico.
  //
  // 25/08/2026 (2do pedido, "Agrega un costo Administrativo que se
  // suma al costo de producto"): costoAdministrativo es un parámetro
  // GLOBAL (uno solo para toda la operación, editable en Parámetros
  // globales -- no por producto), pensado para cubrir gastos que el
  // 50%-del-precio-nuevo no captura (entrega/retiro, limpieza,
  // administración). Sólo se suma cuando YA hay un costo de producto
  // (usosMaximos + precioProductoNuevo cargados) -- "se suma AL costo
  // de producto", no reemplaza la necesidad de esos datos.
  const costoProductoPorUso = (config && config.usosMaximos > 0 && config.precioProductoNuevo > 0)
    ? (config.precioProductoNuevo * FRACCION_COSTO_DEL_NUEVO) / config.usosMaximos
    : null;
  const costoPorUso = costoProductoPorUso != null ? costoProductoPorUso + costoAdministrativo : null;
  function conMargen(resultado) {
    const margenPct = (costoPorUso != null && resultado.sugerido > 0)
      ? ((resultado.sugerido - costoPorUso) / resultado.sugerido) * 100
      : null;
    return Object.assign({ costoPorUso: costoPorUso != null ? round(costoPorUso, redondeo) : null, margenPct }, resultado);
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

  const ajustadoInflacion = (precioVigenteOppen != null && mesesSinActualizar != null)
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
  round, mesActual, mesesEntre, inflacionCompuesta,
  mesesDesdeUltimoCambioDePrecio, calcularSugerencia,
  GM_DEFAULT_PCT,
};
