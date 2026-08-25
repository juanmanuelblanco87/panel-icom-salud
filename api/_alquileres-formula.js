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
//     derivado de Oppen -- ver alquileres-data.js -- multiplicado por
//     la inflación acumulada configurada).
// La sugerencia final es el MAYOR de los dos. El precio de mercado
// queda afuera de esta cuenta a propósito -- el usuario mismo dice que
// esa fuente no es confiable, así que se muestra sólo como referencia
// (con link) en la UI, nunca mezclado matemáticamente en el número que
// la gente va a usar.
//
// Mismo criterio que calcularDiasVacaciones en Gestión de Talento:
// esta función vive server-side (fuente de verdad para el snapshot
// mensual) y se porta literalmente al cliente (mismo cálculo, sólo
// para previsualizar en pantalla antes de guardar).

function round(v, inc) {
  if (v == null || !inc) return v;
  return Math.round(v / inc) * inc;
}

// modo 'simple': accumPct ya es el % acumulado a aplicar tal cual.
// modo 'compuesto': monthlyPct compuesto durante monthsN meses.
function accumInflation(g) {
  if (!g) return 0;
  return g.inflationMode === 'compuesto'
    ? Math.pow(1 + (g.monthlyPct || 0) / 100, g.monthsN || 0) - 1
    : (g.accumPct || 0) / 100;
}

// config: { usosMaximos, precioProductoNuevo, overrideManual }
// precioVigenteOppen: number|null (derivado de Oppen, ver alquileres-data.js)
// g: { inflationMode, accumPct, monthlyPct, monthsN, redondeo }
function calcularSugerencia(config, precioVigenteOppen, g) {
  const redondeo = (g && g.redondeo) || 100;

  if (config && config.overrideManual != null) {
    return { sugerido: config.overrideManual, metodo: 'manual', piso: null, ajustadoInflacion: null };
  }

  const piso = (config && config.usosMaximos > 0 && config.precioProductoNuevo > 0)
    ? round(config.precioProductoNuevo / config.usosMaximos, redondeo)
    : null;

  const ajustadoInflacion = (precioVigenteOppen != null)
    ? round(precioVigenteOppen * (1 + accumInflation(g)), redondeo)
    : null;

  const candidatos = [piso, ajustadoInflacion].filter(v => v != null);
  if (!candidatos.length) {
    return { sugerido: null, metodo: 'sin datos', piso, ajustadoInflacion };
  }
  const sugerido = Math.max(...candidatos);
  const metodo = sugerido === piso ? 'piso amortización' : 'ajuste inflación';
  return { sugerido, metodo, piso, ajustadoInflacion };
}

module.exports = { round, accumInflation, calcularSugerencia };
