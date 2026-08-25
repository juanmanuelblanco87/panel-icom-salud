// api/_alquileres-formula.js
//
// Alquileres -- fórmula de precio sugerido, simplificada a pedido del
// usuario a partir de un prototipo que mezclaba 3 señales con pesos
// (IPC/Payback/Mercado, global + override por producto): "quedó súper
// complejo por demás". Se reemplaza por 2 números claros:
//   - Piso de amortización = precio del producto nuevo ÷ usos máximos
//     (nunca se sugiere por debajo de esto -- es un LÍMITE, no un peso
//     más en una mezcla).
//   - Precio vigente ajustado por inflación (el precio real vigente,
//     derivado de Oppen -- ver alquileres-data.js -- compuesto por la
//     inflación mensual estimada, durante los meses que ese precio
//     lleva SIN CAMBIAR -- ver mesesDesdeUltimoCambioDePrecio).
// La sugerencia final es el MAYOR de los dos. El precio de mercado
// queda afuera de esta cuenta a propósito -- el usuario mismo dice que
// esa fuente no es confiable, así que se muestra sólo como referencia
// (con link) en la UI, nunca mezclado matemáticamente en el número que
// la gente va a usar.
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
// Mismo criterio que calcularDiasVacaciones en Gestión de Talento:
// esta función vive server-side (fuente de verdad para el snapshot
// mensual) y se porta literalmente al cliente (mismo cálculo, sólo
// para previsualizar en pantalla antes de guardar).

function round(v, inc) {
  if (v == null || !inc) return v;
  return Math.round(v / inc) * inc;
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

// config: { usosMaximos, precioProductoNuevo, overrideManual }
// precioVigenteOppen: number|null (derivado de Oppen, ver alquileres-data.js)
// mesesSinActualizar: number|null (ver mesesDesdeUltimoCambioDePrecio)
// g: { monthlyPct, redondeo }
function calcularSugerencia(config, precioVigenteOppen, mesesSinActualizar, g) {
  const redondeo = (g && g.redondeo) || 100;

  if (config && config.overrideManual != null) {
    return { sugerido: config.overrideManual, metodo: 'manual', piso: null, ajustadoInflacion: null, mesesSinActualizar };
  }

  const piso = (config && config.usosMaximos > 0 && config.precioProductoNuevo > 0)
    ? round(config.precioProductoNuevo / config.usosMaximos, redondeo)
    : null;

  const ajustadoInflacion = (precioVigenteOppen != null && mesesSinActualizar != null)
    ? round(precioVigenteOppen * (1 + inflacionCompuesta((g && g.monthlyPct) || 0, mesesSinActualizar)), redondeo)
    : null;

  const candidatos = [piso, ajustadoInflacion].filter(v => v != null);
  if (!candidatos.length) {
    return { sugerido: null, metodo: 'sin datos', piso, ajustadoInflacion, mesesSinActualizar };
  }
  const sugerido = Math.max(...candidatos);
  const metodo = sugerido === piso ? 'piso amortización' : 'ajuste inflación';
  return { sugerido, metodo, piso, ajustadoInflacion, mesesSinActualizar };
}

module.exports = {
  round, mesActual, mesesEntre, inflacionCompuesta,
  mesesDesdeUltimoCambioDePrecio, calcularSugerencia,
};
