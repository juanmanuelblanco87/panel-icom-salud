/**
 * Motor de calculo del "Calculador de Importacion" (20/07/2026).
 *
 * Reconstruye la logica de la planilla STOKE_FOB_Objetivo_Fase1.xlsx del
 * cliente (hoja "Margen por FOB Conseguido"), verificada numero por numero
 * contra esa planilla antes de escribir este archivo -- ej. fila SILLA
 * RUEDAS CLASSIC: FOB=24, Trader=1.20 (5%), CIF=25 (=FOB+Seguro, el Trader
 * NO entra al CIF), Arancel=3.65 (=CIF*14.6%), Tasa=0.75 (=CIF*3%),
 * Ley25413=0.25 (=CIF*1%), Costo Nacionalizado USD = CIF+Arancel+Tasa+
 * Ley25413+Logistica+Trader = 48.31 -- coincide exacto con la planilla.
 *
 * A diferencia de la planilla original del cliente (pedidos explicitos del
 * usuario, 20/07/2026):
 *   - Arancel, IVA y CBM ya NO son fijos por categoria cerrada: son
 *     propiedades editables de un catalogo ABIERTO de "tipos de producto"
 *     (tabla calc_product_types), estimadas por IA la primera vez que se
 *     usa cada tipo (ver lib/calcAi.ts) y cacheadas ahi.
 *   - Trader default 0% (la planilla original asumia 5% siempre) --
 *     editable por tipo de producto para el caso puntual donde si se pague.
 *   - Se agrega el canal "Distribucion" (no existia en la planilla): PVP
 *     Distribucion = PVP MeLi x (1 - descuento_distribucion_pct, default
 *     35%), con SOLO IIBB como deduccion (sin comision ML, sin envio, sin
 *     PADS, sin fee de bajo ticket -- no se vende por MeLi).
 *
 * Esta funcion es pura (no toca la DB ni hace llamadas de red): recibe los
 * supuestos y los datos del tipo de producto ya resueltos (arancel/iva/cbm
 * ya sea cacheados o recien estimados por IA, y el PVP de MeLi ya sea
 * manual o estimado), y devuelve toda la cascada + ambos canales.
 */

export type TamanoEnvio = "chico" | "mediano" | "grande";

/**
 * Deriva el tamaño de envío (Mercado Envíos) a partir del CBM del producto
 * -- pedido explícito del usuario (21/07/2026): "si <0,05cbm = pequeño;
 * entre 0,05 y 0,12 = mediano; >0,12 = grande". Se aplica automáticamente
 * cada vez que el CBM se (re)estima por IA (ver app/api/calc/product-types
 * y su endpoint /refresh?field=cbm) -- si el usuario edita el tamaño a
 * mano en el modal de "Editar" después, esa elección manual se respeta
 * (no se vuelve a pisar hasta la próxima vez que cambie el CBM).
 */
export function tamanoEnvioPorCbm(cbmM3: number): TamanoEnvio {
  if (cbmM3 < 0.05) return "chico";
  if (cbmM3 <= 0.12) return "mediano";
  return "grande";
}

export interface CalcSupuestos {
  tipoCambioArs: number;
  comisionMlPct: number;
  iibbPct: number;
  padsPct: number;
  tasaEstadisticaPct: number;
  /** Tope de la Tasa de Estadistica, en USD equivalentes (21/07/2026,
   * pedido explicito del usuario tras comparar contra una calculadora
   * publica): la Tasa de Estadistica de Aduana es 3% sobre CIF pero con un
   * tope maximo fijo en USD (la calculadora publica que compartio el
   * usuario usa USD 180) -- sin este tope, productos de FOB alto quedarian
   * sobreestimados en este concepto. */
  tasaEstadisticaTopeUsd: number;
  ley25413Pct: number;
  seguroUsdUnidad: number;
  /** Fee fijo por "producto de bajo valor" que cobra Mercado Libre cuando el
   * PVP con IVA es MENOR a umbralBajoValorArs -- pedido explicito del
   * usuario (20/07/2026): "si el producto vale menos de 33000 entonces solo
   * paga 2mil en concepto de Fee por producto de bajo valor". Default $2.000. */
  feeBajoTicketArs: number;
  /** Umbral de PVP (ARS con IVA) que separa el Fee de bajo valor del costo
   * de envio real de Mercado Envios (por tamaño). Default $33.000. */
  umbralBajoValorArs: number;
  /** PVP Distribucion = PVP MeLi x (1 - este %). Default 0.35 (35%). */
  descuentoDistribucionPct: number;
  fleteMaritimoUsd: number;
  forwarderUsd: number;
  despachanteUsd: number;
  thcUsd: number;
  fleteLocalUsd: number;
  manipuleoUsd: number;
  /** Capacidad util (m3) de un contenedor 40HC/40HQ -- usada para el costo
   * fijo por CBM (ver mas abajo) y para "unidades por contenedor" en el
   * frontend (21/07/2026, pedido explicito del usuario). */
  capacidadCbmContenedor: number;
  /** Capacidad util (m3) de un contenedor 20FT -- solo se usa para mostrar
   * "unidades por contenedor" en el frontend, no afecta el costo logistico
   * (ese sigue calculado sobre el 40HC). */
  capacidad20ftM3: number;
  /** Costo de envio de Mercado Envios (ARS, CON IVA) segun el tamaño del
   * producto, cuando el PVP con IVA es MAYOR O IGUAL a umbralBajoValorArs --
   * pedido explicito del usuario (20/07/2026): "productos chicos (8000 ar$)
   * productos medianos 12000 productos grandes (silla de ruedas) 32000". */
  envioChicoArs: number;
  envioMedianoArs: number;
  envioGrandeArs: number;
}

export interface CalcProducto {
  arancelPct: number;
  ivaPct: number;
  /** Comision de agente de compra sobre FOB. Default 0 (ver nota arriba). */
  traderPct: number;
  cbmM3: number;
  /** Categoria de tamaño para el costo de envio de Mercado Envios (ver
   * CalcSupuestos.envioChicoArs/envioMedianoArs/envioGrandeArs). Reemplaza
   * al viejo campo manual "envioArsConIva" (20/07/2026): el usuario aclaro
   * que el costo real de MeLi se define por una tabla de tamaño, no por un
   * monto libre por producto. */
  tamanoEnvio: TamanoEnvio;
  /** Costo de envio obtenido en vivo de la API de Mercado Libre
   * (`/users/$USER_ID/shipping_options/free`, ver lib/meliApi.ts) para
   * ESTE calculo puntual -- a diferencia de la tabla fija editable
   * (envioChicoArs/envioMedianoArs/envioGrandeArs, que se carga CON IVA),
   * este valor viene SIN IVA (confirmado por el usuario 21/07/2026: el
   * costo que factura MeLi por Mercado Envios se factura neto, con el IVA
   * discriminado aparte -- por eso NO hay que volver a sacarle el IVA acá).
   * Si viene definido, reemplaza a la tabla fija por tamaño -- pero el Fee
   * de bajo valor sigue aplicando igual si el PVP no llega al umbral, sin
   * importar este valor. undefined/null = usar la tabla fija (comportamiento
   * anterior, sirve de respaldo si la API no responde). */
  envioArsNetoApi?: number | null;
}

export interface CalcInput {
  fobUsd: number;
  /** PVP de MeLi ya resuelto (manual o estimado por IA), ARS CON IVA. */
  pvpMeliArsConIva: number;
  supuestos: CalcSupuestos;
  producto: CalcProducto;
}

export interface CalcCostoNacionalizado {
  traderUsd: number;
  seguroUsd: number;
  cifUsd: number;
  arancelUsd: number;
  tasaEstadisticaUsd: number;
  ley25413Usd: number;
  costoFijoPorCbmUsd: number;
  logisticaUsd: number;
  costoNacionalizadoUsd: number;
  costoNacionalizadoArs: number;
}

export interface CalcCanal {
  pvpConIva: number;
  pvpNeto: number;
  comisionMlArs: number;
  envioNetoArs: number;
  iibbArs: number;
  padsArs: number;
  feeBajoTicketArs: number;
  /** true si el PVP con IVA supera el umbral de bajo valor y por lo tanto
   * se usa el costo de envio de Mercado Envios por tamaño (en vez del Fee
   * de bajo valor). Solo relevante en MeLi. Nombre anterior:
   * "envioGratisAplica" -- se renombro (20/07/2026) porque el envio de
   * MeLi NUNCA es gratis para el vendedor, siempre paga el Fee de bajo
   * valor O el costo por tamaño. */
  envioPorTamanoAplica: boolean;
  margenArs: number;
  /** Margen sobre venta neta de IVA (misma base que usa la planilla del cliente). */
  margenPctSobreNeto: number;
  /** Margen sobre PVP con IVA (precio de lista). */
  margenPctSobreConIva: number;
}

export interface CalcResult {
  costoNacionalizado: CalcCostoNacionalizado;
  meli: CalcCanal;
  distribucion: CalcCanal;
}

export function calcularImportacion(input: CalcInput): CalcResult {
  const { fobUsd, pvpMeliArsConIva, supuestos, producto } = input;

  // ---- 1) Del FOB al Costo Nacionalizado (USD -> ARS) ----
  const traderUsd = fobUsd * producto.traderPct;
  const seguroUsd = supuestos.seguroUsdUnidad;
  // CIF = FOB + Seguro. El Trader NO entra al CIF (verificado contra la
  // planilla del cliente: la comision del agente de compra no es parte
  // del valor aduanero declarado, se suma al costo nacionalizado aparte).
  const cifUsd = fobUsd + seguroUsd;
  const arancelUsd = cifUsd * producto.arancelPct;
  // Tasa de Estadistica: 3% sobre CIF, pero con un tope maximo en USD
  // (21/07/2026, ver CalcSupuestos.tasaEstadisticaTopeUsd) -- sin el tope
  // no afecta a FOBs bajos como los que se cargaron hasta ahora, pero
  // sobreestimaria el costo en productos de FOB alto.
  const tasaEstadisticaUsd = Math.min(cifUsd * supuestos.tasaEstadisticaPct, supuestos.tasaEstadisticaTopeUsd);
  const ley25413Usd = cifUsd * supuestos.ley25413Pct;

  const costoFijoContenedorUsd =
    supuestos.fleteMaritimoUsd +
    supuestos.forwarderUsd +
    supuestos.despachanteUsd +
    supuestos.thcUsd +
    supuestos.fleteLocalUsd +
    supuestos.manipuleoUsd;
  const costoFijoPorCbmUsd =
    supuestos.capacidadCbmContenedor > 0 ? costoFijoContenedorUsd / supuestos.capacidadCbmContenedor : 0;
  const logisticaUsd = producto.cbmM3 * costoFijoPorCbmUsd;

  const costoNacionalizadoUsd =
    cifUsd + arancelUsd + tasaEstadisticaUsd + ley25413Usd + logisticaUsd + traderUsd;
  const costoNacionalizadoArs = costoNacionalizadoUsd * supuestos.tipoCambioArs;

  const costoNacionalizado: CalcCostoNacionalizado = {
    traderUsd,
    seguroUsd,
    cifUsd,
    arancelUsd,
    tasaEstadisticaUsd,
    ley25413Usd,
    costoFijoPorCbmUsd,
    logisticaUsd,
    costoNacionalizadoUsd,
    costoNacionalizadoArs,
  };

  // ---- 2) Canal MeLi ----
  // Costo de envio de Mercado Envios (20/07/2026, reemplaza el viejo modelo
  // de "envio gratis" -- pedido explicito del usuario, con los numeros
  // reales de la tabla de MeLi): si el PVP con IVA es MENOR al umbral, el
  // vendedor paga un Fee fijo de "producto de bajo valor"; si es MAYOR O
  // IGUAL, paga el costo real de envio segun el tamaño del producto
  // (chico/mediano/grande). Nunca es realmente "gratis" para el vendedor.
  const envioPorTamanoAplica = pvpMeliArsConIva >= supuestos.umbralBajoValorArs;
  // Prioridad: API de Mercado Libre (si se pudo consultar para este
  // calculo) > tabla fija por tamaño (respaldo). Ver CalcProducto.envioArsNetoApi.
  // OJO: la API ya devuelve el costo SIN IVA, la tabla fija se carga CON
  // IVA -- por eso cada una sigue un camino distinto para llegar al neto
  // (21/07/2026, corregido tras confirmar con el usuario que dividir el
  // valor de la API por (1+IVA) de nuevo lo estaba subestimando).
  let envioNetoMeliArs = 0;
  if (envioPorTamanoAplica) {
    if (producto.envioArsNetoApi != null) {
      envioNetoMeliArs = producto.envioArsNetoApi;
    } else {
      const envioTablaArsConIva =
        producto.tamanoEnvio === "chico"
          ? supuestos.envioChicoArs
          : producto.tamanoEnvio === "grande"
          ? supuestos.envioGrandeArs
          : supuestos.envioMedianoArs;
      envioNetoMeliArs = envioTablaArsConIva / (1 + producto.ivaPct);
    }
  }
  const pvpMeliNeto = pvpMeliArsConIva / (1 + producto.ivaPct);
  const comisionMlArs = pvpMeliNeto * supuestos.comisionMlPct;
  const iibbMeliArs = pvpMeliNeto * supuestos.iibbPct;
  // PADS se calcula sobre el PVP CON IVA (no sobre el neto) -- verificado
  // contra la planilla.
  const padsMeliArs = pvpMeliArsConIva * supuestos.padsPct;
  const feeBajoTicketMeliArs = envioPorTamanoAplica ? 0 : supuestos.feeBajoTicketArs;

  const margenMeliArs =
    pvpMeliNeto -
    comisionMlArs -
    envioNetoMeliArs -
    iibbMeliArs -
    padsMeliArs -
    feeBajoTicketMeliArs -
    costoNacionalizadoArs;

  const meli: CalcCanal = {
    pvpConIva: pvpMeliArsConIva,
    pvpNeto: pvpMeliNeto,
    comisionMlArs,
    envioNetoArs: envioNetoMeliArs,
    iibbArs: iibbMeliArs,
    padsArs: padsMeliArs,
    feeBajoTicketArs: feeBajoTicketMeliArs,
    envioPorTamanoAplica,
    margenArs: margenMeliArs,
    margenPctSobreNeto: pvpMeliNeto > 0 ? margenMeliArs / pvpMeliNeto : 0,
    margenPctSobreConIva: pvpMeliArsConIva > 0 ? margenMeliArs / pvpMeliArsConIva : 0,
  };

  // ---- 3) Canal Distribucion (no existe en la planilla original) ----
  // Pedido explicito del usuario: "sobre el PVP de MeLi colocar un 35% de
  // descuento (35% GM para el minorista)" -- solo se descuenta IIBB (nada
  // de comision ML, envio, PADS ni fee de bajo ticket, porque no se vende
  // por MeLi).
  const pvpDistConIva = pvpMeliArsConIva * (1 - supuestos.descuentoDistribucionPct);
  const pvpDistNeto = pvpDistConIva / (1 + producto.ivaPct);
  const iibbDistArs = pvpDistNeto * supuestos.iibbPct;
  const margenDistArs = pvpDistNeto - iibbDistArs - costoNacionalizadoArs;

  const distribucion: CalcCanal = {
    pvpConIva: pvpDistConIva,
    pvpNeto: pvpDistNeto,
    comisionMlArs: 0,
    envioNetoArs: 0,
    iibbArs: iibbDistArs,
    padsArs: 0,
    feeBajoTicketArs: 0,
    envioPorTamanoAplica: false,
    margenArs: margenDistArs,
    margenPctSobreNeto: pvpDistNeto > 0 ? margenDistArs / pvpDistNeto : 0,
    margenPctSobreConIva: pvpDistConIva > 0 ? margenDistArs / pvpDistConIva : 0,
  };

  return { costoNacionalizado, meli, distribucion };
}
