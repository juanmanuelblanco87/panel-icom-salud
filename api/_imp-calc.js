// api/_imp-calc.js
//
// Motor de cálculo del "Calculador de Importación" -- traslado (30/10/2026) de lib/importCalc.ts del proyecto ia40-dashboard, SIN cambios de lógica.
//
// Reconstruye la planilla STOKE_FOB_Objetivo_Fase1.xlsx del cliente (hoja "Margen por FOB Conseguido"), verificada número por número contra esa planilla
// (ej. SILLA RUEDAS CLASSIC: FOB=24, Trader=1,20 (5%), CIF=25 (=FOB+Seguro: el Trader NO entra al CIF), Arancel=3,65 (=CIF*14,6%), Tasa=0,75 (=CIF*3%),
// Ley25413=0,25 (=CIF*1%), Costo Nacionalizado USD = CIF+Arancel+Tasa+Ley25413+Logística+Trader = 48,31 -- coincide exacto con la planilla).
//
// Diferencias con la planilla original (pedidos del usuario, 20/07/2026):
//   - Arancel, IVA y CBM son propiedades editables de un catálogo ABIERTO de "tipos de producto" (tabla calc_product_types), estimadas por IA la primera
//     vez que se usa cada tipo (ver _imp-ai.js) y cacheadas ahí.
//   - Trader por defecto 0% (la planilla asumía 5%), editable por tipo de producto.
//   - Canal "Distribución": PVP Distribución = PVP MeLi x (1 - descuento_distribucion_pct, 35%), con SOLO IIBB como deducción.
//
// Es una función pura (no toca la base ni la red): recibe los supuestos y los datos del tipo de producto ya resueltos y devuelve toda la cascada y ambos canales.

// Tamaño de envío (Mercado Envíos) según el CBM del producto -- "si < 0,05 cbm = chico; entre 0,05 y 0,12 = mediano; > 0,12 = grande" (21/07/2026).
function tamanoEnvioPorCbm(cbmM3) {
  if (cbmM3 < 0.05) return 'chico';
  if (cbmM3 <= 0.12) return 'mediano';
  return 'grande';
}

/*
 * supuestos: { tipoCambioArs, comisionMlPct, iibbPct, padsPct, tasaEstadisticaPct, tasaEstadisticaTopeUsd (tope de la Tasa de Estadística en USD),
 *   ley25413Pct, seguroUsdUnidad, feeBajoTicketArs (fee fijo de "producto de bajo valor" si el PVP con IVA < umbralBajoValorArs), umbralBajoValorArs,
 *   descuentoDistribucionPct, fleteMaritimoUsd, forwarderUsd, despachanteUsd, thcUsd, fleteLocalUsd, manipuleoUsd, capacidadCbmContenedor (m3 útiles de un 40HC),
 *   capacidad20ftM3, envioChicoArs, envioMedianoArs, envioGrandeArs (costo de Mercado Envíos CON IVA por tamaño cuando el PVP con IVA >= umbral) }
 * producto: { arancelPct, ivaPct, traderPct, cbmM3, tamanoEnvio, envioArsNetoApi (costo de envío SIN IVA de la API de MeLi para este cálculo; null = usar la tabla) }
 */
function calcularImportacion(input) {
  const { fobUsd, pvpMeliArsConIva, supuestos, producto } = input;

  // ---- 1) Del FOB al Costo Nacionalizado (USD -> ARS) ----
  const traderUsd = fobUsd * producto.traderPct;
  const seguroUsd = supuestos.seguroUsdUnidad;
  // CIF = FOB + Seguro. El Trader NO entra al CIF (la comisión del agente de compra no es parte del valor aduanero; se suma al costo nacionalizado aparte).
  const cifUsd = fobUsd + seguroUsd;
  const arancelUsd = cifUsd * producto.arancelPct;
  // Tasa de Estadística: 3% sobre CIF, con tope máximo en USD.
  const tasaEstadisticaUsd = Math.min(cifUsd * supuestos.tasaEstadisticaPct, supuestos.tasaEstadisticaTopeUsd);
  const ley25413Usd = cifUsd * supuestos.ley25413Pct;

  const costoFijoContenedorUsd = supuestos.fleteMaritimoUsd + supuestos.forwarderUsd + supuestos.despachanteUsd + supuestos.thcUsd + supuestos.fleteLocalUsd + supuestos.manipuleoUsd;
  const costoFijoPorCbmUsd = supuestos.capacidadCbmContenedor > 0 ? costoFijoContenedorUsd / supuestos.capacidadCbmContenedor : 0;
  const logisticaUsd = producto.cbmM3 * costoFijoPorCbmUsd;

  const costoNacionalizadoUsd = cifUsd + arancelUsd + tasaEstadisticaUsd + ley25413Usd + logisticaUsd + traderUsd;
  const costoNacionalizadoArs = costoNacionalizadoUsd * supuestos.tipoCambioArs;

  const costoNacionalizado = { traderUsd, seguroUsd, cifUsd, arancelUsd, tasaEstadisticaUsd, ley25413Usd, costoFijoPorCbmUsd, logisticaUsd, costoNacionalizadoUsd, costoNacionalizadoArs };

  // ---- 2) Canal MeLi ----
  // Si el PVP con IVA es MENOR al umbral, el vendedor paga un Fee fijo de "producto de bajo valor"; si es MAYOR O IGUAL, paga el costo real de Mercado Envíos
  // según el tamaño (chico/mediano/grande). Nunca es realmente "gratis" para el vendedor.
  const envioPorTamanoAplica = pvpMeliArsConIva >= supuestos.umbralBajoValorArs;
  // Prioridad: API de Mercado Libre (si se pudo consultar) > tabla fija por tamaño (respaldo). La API ya devuelve el costo SIN IVA; la tabla fija se carga CON IVA.
  let envioNetoMeliArs = 0;
  if (envioPorTamanoAplica) {
    if (producto.envioArsNetoApi != null) {
      envioNetoMeliArs = producto.envioArsNetoApi;
    } else {
      const envioTablaArsConIva = producto.tamanoEnvio === 'chico' ? supuestos.envioChicoArs : producto.tamanoEnvio === 'grande' ? supuestos.envioGrandeArs : supuestos.envioMedianoArs;
      envioNetoMeliArs = envioTablaArsConIva / (1 + producto.ivaPct);
    }
  }
  const pvpMeliNeto = pvpMeliArsConIva / (1 + producto.ivaPct);
  const comisionMlArs = pvpMeliNeto * supuestos.comisionMlPct;
  const iibbMeliArs = pvpMeliNeto * supuestos.iibbPct;
  // PADS se calcula sobre el PVP CON IVA (no sobre el neto) -- verificado contra la planilla.
  const padsMeliArs = pvpMeliArsConIva * supuestos.padsPct;
  const feeBajoTicketMeliArs = envioPorTamanoAplica ? 0 : supuestos.feeBajoTicketArs;

  const margenMeliArs = pvpMeliNeto - comisionMlArs - envioNetoMeliArs - iibbMeliArs - padsMeliArs - feeBajoTicketMeliArs - costoNacionalizadoArs;

  const meli = {
    pvpConIva: pvpMeliArsConIva, pvpNeto: pvpMeliNeto, comisionMlArs, envioNetoArs: envioNetoMeliArs, iibbArs: iibbMeliArs, padsArs: padsMeliArs, feeBajoTicketArs: feeBajoTicketMeliArs,
    envioPorTamanoAplica, margenArs: margenMeliArs,
    margenPctSobreNeto: pvpMeliNeto > 0 ? margenMeliArs / pvpMeliNeto : 0,               // sobre venta neta de IVA (misma base que la planilla del cliente)
    margenPctSobreConIva: pvpMeliArsConIva > 0 ? margenMeliArs / pvpMeliArsConIva : 0,  // sobre el precio de lista
  };

  // ---- 3) Canal Distribución ----
  // "Sobre el PVP de MeLi colocar un 35% de descuento (35% GM para el minorista)": sólo se descuenta IIBB (sin comisión ML, envío, PADS ni fee de bajo ticket).
  const pvpDistConIva = pvpMeliArsConIva * (1 - supuestos.descuentoDistribucionPct);
  const pvpDistNeto = pvpDistConIva / (1 + producto.ivaPct);
  const iibbDistArs = pvpDistNeto * supuestos.iibbPct;
  const margenDistArs = pvpDistNeto - iibbDistArs - costoNacionalizadoArs;

  const distribucion = {
    pvpConIva: pvpDistConIva, pvpNeto: pvpDistNeto, comisionMlArs: 0, envioNetoArs: 0, iibbArs: iibbDistArs, padsArs: 0, feeBajoTicketArs: 0, envioPorTamanoAplica: false,
    margenArs: margenDistArs,
    margenPctSobreNeto: pvpDistNeto > 0 ? margenDistArs / pvpDistNeto : 0,
    margenPctSobreConIva: pvpDistConIva > 0 ? margenDistArs / pvpDistConIva : 0,
  };

  return { costoNacionalizado, meli, distribucion };
}

module.exports = { tamanoEnvioPorCbm, calcularImportacion };
