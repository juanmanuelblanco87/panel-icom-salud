// api/_pnl-gastos-core.js
// 22/09/2026 -- Juan Manuel: "Vamos a traernos los datos de Oppen para reconstruir este
// P&L". Reconstruye la sección de GASTOS (directos + indirectos asignados) del P&L mensual
// por unidad de negocio, pidiendo la data directo a Oppen en vez del proceso manual mensual
// en Excel ("Balance por etiquetas"/"P&L" que arma Juan Manuel a mano).
//
// ALCANCE (a propósito, NO es el P&L completo): sólo GASTOS. "Ventas facturadas"/"Ventas de
// fcn"/CMV NO se reconstruyen acá -- en el Excel real esas 3 líneas son valores pegados a
// mano con ajustes de criterio (ver "EERR resumido"!B10, fórmula manual tipo
// "=-550586797.7+55539467.56+77282563.81" para el CMV de Cirugía General), no una fórmula
// mecánica reproducible. Los Gastos, en cambio, SÍ son 100% mecánicos en el Excel real: cada
// cuenta contable mapea a una única línea de P&L (VLOOKUP fijo, ver 'EERR horizontal' del
// archivo real) y cada Etiqueta contable mapea a una única unidad de negocio (o a un
// departamento compartido que se reparte por % de ventas) -- exactamente lo que este módulo
// reproduce. La venta por unidad (usada sólo como PESO de reparto de los gastos indirectos,
// igual que hace el Excel real con su fila "Asignación") se pide aparte a Invoice
// (soloUnidadNegocio=1), no a NLT.
//
// METODOLOGÍA validada a mano contra el Excel real de julio 2026 (coincide EXACTO, centavo a
// centavo, en 4 cuentas de prueba con hasta 15 etiquetas cada una):
//   1. NLT (no NLTRowLabelAD -- esa tabla no filtra por fecha del lado del server, sólo
//      paginación de sus ~270k filas históricas) filtrado por TransDate del mes, Status=1,
//      Invalid=0 -- trae los ASIENTOS del período con sus NLTRows anidadas.
//   2. Sólo Cuentas de Resultados (Account empieza con "4.") -- mismo criterio que el reporte
//      real ("Mostrar Cuenta: Cuentas de Resultados").
//   3. El campo `Labels` de cada NLTRow es una lista separada por comas que MEZCLA 2 cosas:
//      códigos de atributo de producto/implante (AMED, TEXTU, PALTO, REDO, LISA, PMPLUS...) y
//      la Etiqueta CONTABLE real (MENTOR, BELL-OFI, COMPRAS...). Sólo se toma el token que
//      matchea la whitelist cerrada de abajo (extraída del Excel real, columna "Código").
//   4. 3 buckets por línea: Labels==='' -> Sin Etiqueta; matchea 1 token de la whitelist ->
//      esa etiqueta; tiene tags pero ninguno de la whitelist (líneas de trazabilidad de
//      inventario, no contables) -> se EXCLUYEN del todo, igual que hace el reporte real.
//
// Variables de entorno requeridas (Vercel): OPPEN_USER_API / OPPEN_PASS_API (las mismas que
// ya usan oppen-invoices.js/oppen-stock.js -- proyecto ICOMGENERAL).
//
// LIMITACIONES CONOCIDAS (reconciliación completa contra julio 2026, las 4 unidades, ~90
// líneas comparadas -- documentadas acá para que se entiendan como diferencias esperadas, no
// como bugs, si algún mes no calza 100% contra el Excel manual de Juan Manuel):
//   - No incluye reclasificaciones manuales puntuales que Juan Manuel hace leyendo la
//     descripción de asientos individuales (ej. gastos de "obra" que saca de Gastos de
//     infraestructura, o un asesoramiento puntual tipo "outlandish" cargado a mano sin
//     cuenta contable propia) -- son juicio caso a caso, no una regla de cuenta/etiqueta.
//   - 24/09/2026 (Finanzas, cruce de julio -- "hay un GAP importante, nosotros tomamos la
//     cuenta completa de ML y ellos restan algo"): YA CORREGIDO -- ver CUENTA_COMISION_ML
//     más abajo. La cuenta de Comisión ML mezclaba 2 orígenes de asiento: la Factura de
//     Compra real que emite Mercado Libre (RecordSource "PurchaseInvoice!...") y un asiento
//     espejo por cada Factura de VENTA de ese mismo período (RecordSource "Invoice!..."),
//     que Finanzas resta a mano porque ya está neteado dentro de la propia venta. Confirmado
//     contra julio real: $31,1M en asientos "PurchaseInvoice" (el gasto real, coincide con
//     lo que reporta Finanzas) vs $24,3M en asientos "Invoice" (el duplicado) -- ahora sólo
//     se suman los "PurchaseInvoice".
//   - El reparto de gastos indirectos (DIRECTORIO/RRHH/MARKETING/OPERACIONES/COMPRAS/
//     FINANZAS) usa como peso "Ventas facturadas" (Invoice) -- el Excel real usa "Ventas
//     totales" (facturadas + "Ventas de fcn"/financiación), un dato que no sale de Invoice.
//     Desvío típico observado: <1 punto porcentual del % de reparto.
//   - Todos los totales/líneas DIRECTAS sin estos casos puntuales coinciden EXACTO (a la
//     centena de pesos) contra el Excel real.
//   - Meses MUY recientes pueden mostrar "Gastos del personal" artificialmente bajo -- Oppen
//     carga los asientos de sueldos con demora (confirmado 23/09/2026: agosto 2026 completo,
//     las 4 unidades, sólo tenía $5,8M cargados en las cuentas de personal contra >100M de
//     meses anteriores -- no es un bug de mapeo, el asiento real todavía no estaba en el
//     libro mayor al momento de la consulta). Se autocorrige solo apenas Oppen registra el
//     asiento real -- no hace falta ningún ajuste de este lado.
const BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOMGENERAL';

// Universo COMPLETO y cerrado de Etiquetas contables (columna "Código" del Excel real,
// "Balance por etiquetas 07.2026.xlsx" -- 20 valores, sin contar "- Sin Etiqueta -").
const ETIQUETAS_CONTABLES = new Set([
  'BELL-99', 'BELL-OFI', 'COMPRAS', 'DIRECTORIO', 'ECOMMERCE', 'FINANZAS', 'ICEN-99',
  'ICOM-CEN', 'ICOM-JCP', 'IJCP-99', 'MARKETING', 'MENTOR', 'ML', 'MONTANESES',
  'OPERACIONES', 'ORTOPEDIA', 'PROSALUD', 'PSAL-99', 'RRHH', 'TALLER',
]);

// Etiqueta contable -> unidad de negocio del SHELL (mismas 4 unidades que ya usa
// DASH_GROUP_CONFIG en el panel: minorista/movilidad/cirugia_estetica/cirugia_general).
// Extraído de las fórmulas reales de 'EERR' (cada unidad tiene su propio bloque de 4
// columnas con las filas de Balance-por-Etiqueta que le corresponden) -- Minorista agrupa
// los 5 canales que el Excel real muestra por separado (ML/Ecommerce/Icom/Prosa/Jcp), igual
// que la columna "Total Minorista" de 'EERR resumido'.
const UNIDAD_ETIQUETAS = {
  cirugia_general: ['BELL-OFI', 'BELL-99'],
  cirugia_estetica: ['MENTOR'],
  movilidad: ['MONTANESES', 'ORTOPEDIA'],
  minorista: ['ML', 'ECOMMERCE', 'ICOM-CEN', 'ICEN-99', 'PROSALUD', 'PSAL-99', 'ICOM-JCP', 'IJCP-99'],
};
// 24/09/2026 (Finanzas, respuesta al cruce de julio -- "Taller: sumémoslo como una unidad
// más, con sus gastos separados. La única excepción es el Taller de Montañeses, que lo
// estamos considerando dentro del costo de Movilidad"): el Taller de Montañeses YA estaba
// (etiqueta MONTANESES dentro de UNIDAD_ETIQUETAS.movilidad, sin cambios). El Taller general
// (etiqueta TALLER) hasta ahora quedaba afuera de las 4 unidades -- entraba en
// totalGastoDirectoCompania pero en NINGÚN porUnidad puntual. Se agrega separado de
// UNIDAD_ETIQUETAS (no mezclado ahí) a propósito: "unidades" más abajo (el denominador de
// venta para repartir Gastos Indirectos, "Asignación %") tiene que seguir siendo SÓLO las 4
// unidades reales con venta -- Taller no vende nada, no tiene sentido darle % de Asignación
// de indirectos ni prorratearlo contra CMV/Utilidad Bruta.
const UNIDADES_SIN_VENTA = { taller: ['TALLER'] };
const ETIQUETAS_UNIDAD_CONOCIDA = new Set([...Object.values(UNIDAD_ETIQUETAS).flat(), ...Object.values(UNIDADES_SIN_VENTA).flat()]);

// 23/09/2026 ("agrega un selector de canales arriba en el dash de Ortopedia... que filtre
// todo el dashboard"): Minorista se abre en sus 5 canales de venta -- mismos 5 canales
// normalizados que ya usa el resto del shell (ver ERP_CANAL_ICONS en icom_panel_unificado.html
// / OFFICE_CANAL_MAP en oppen-invoices.js) -- CADA etiqueta contable de Minorista mapea 1 a 1
// a uno de estos canales (confirmado: son EXACTAMENTE las 8 etiquetas de UNIDAD_ETIQUETAS.
// minorista, sólo agrupadas distinto). Una línea de gasto entra en 2 grupos a la vez: su
// unidad (minorista, ya existía) Y su subcanal (nuevo) -- por eso el loop de abajo ya NO usa
// "la primera unidad que matchea" sino TODAS las que matcheen.
const SUBCANAL_ETIQUETAS = {
  'Mercado Libre': ['ML'],
  'Tienda Online': ['ECOMMERCE'],
  'Central': ['ICOM-CEN', 'ICEN-99'],
  'ProSalud': ['PROSALUD', 'PSAL-99'],
  'JCP': ['ICOM-JCP', 'IJCP-99'],
};
// Todos los "grupos" posibles para un gasto directo -- las 4 unidades + Taller + los 5
// subcanales de Minorista, unificados en un solo mapa para que el loop principal
// (pullYAgregarGastos) no tenga que tratarlos distinto.
const TODOS_LOS_GRUPOS = Object.assign({}, UNIDAD_ETIQUETAS, UNIDADES_SIN_VENTA, SUBCANAL_ETIQUETAS);

// Etiquetas de departamentos COMPARTIDOS -- su costo total (todas las cuentas "4.", no sólo
// las de ACCOUNT_TO_LINEA) se reparte entre las 4 unidades por % de venta facturada del
// período (misma fila "Asignación" que usa 'EERR horizontal'!E83:L83 en el Excel real).
const ETIQUETAS_INDIRECTAS = ['DIRECTORIO', 'RRHH', 'MARKETING', 'OPERACIONES', 'COMPRAS', 'FINANZAS'];
// Ajuste manual que también hace el Excel real (fórmulas N86/N87 de 'EERR horizontal'):
// una diferencia de cambio de activos de $5 y $380 se excluye de MARKETING/OPERACIONES por
// no ser un gasto operativo del departamento -- montos irrelevantes, se replica por fidelidad.
const AJUSTE_INDIRECTO_EXCLUIR = {
  MARKETING: [{ account: '4.1.04.02.00.00' }],
  OPERACIONES: [{ account: '4.1.04.02.00.00' }],
};

// 24/09/2026 -- ver comentario grande en LIMITACIONES CONOCIDAS (cabecera del archivo) y en
// pullYAgregarGastos más abajo: esta cuenta puntual necesita un filtro extra por origen del
// asiento (RecordSource), no sólo el mapeo cuenta->línea genérico del resto del módulo.
const CUENTA_COMISION_ML = '4.2.03.24.00.00';

// Cuenta contable -> línea del P&L (extraído literal de 'EERR horizontal'!C:D del Excel
// real, filas 10-79 -- el VLOOKUP fijo que arma Juan Manuel a mano todos los meses).
const ACCOUNT_TO_LINEA = {
  '4.2.07.02.00.00': 'Impuesto Ingresos Brutos',
  // 4.2.01.03.00.00 ("Gastos de reparación taller") A PROPÓSITO no está mapeada: en el
  // Excel real ('EERR horizontal' fila 11) esta cuenta no tiene ninguna línea de P&L
  // asociada (columna B vacía) -- no aparece en NINGÚN lado de 'EERR resumido', ni en
  // "total gastos directos" ni en ninguna otra línea. Mapearla habría inflado el total por
  // encima del Excel real (confirmado con la reconciliación de julio 2026).
  '4.1.02.04.00.00': 'Recupero de Seguro (extraordinario)',
  '4.1.04.03.00.00': 'Intereses FCI (extraordinario)',
  '4.1.04.01.00.00': 'Dif. Cotización Saldo Bancos (extraordinario)',
  '4.2.07.08.00.00': 'Seguridad e Higiene',
  '4.2.02.01.00.00': 'Gastos del personal',
  '4.2.02.05.00.00': 'Gastos del personal',
  '4.2.02.11.00.00': 'Gastos del personal',
  '4.2.02.12.00.00': 'Gastos del personal',
  '4.2.02.17.00.00': 'Gastos del personal',
  '4.2.02.08.00.00': 'Gastos del personal',
  '4.2.03.01.00.00': 'Gastos de comercialización (alquileres)',
  '4.2.04.17.00.00': 'Gastos de comercialización (alquileres)',
  '4.2.03.02.00.00': 'Gastos de comercialización (general)',
  '4.2.02.13.00.00': 'Gastos de comercialización (general)',
  '4.2.03.03.00.00': 'Gastos de comercialización (general)',
  '4.2.03.09.00.00': 'Gastos de comercialización (general)',
  '4.2.03.10.00.00': 'Gastos de comercialización (general)',
  '4.2.03.19.00.00': 'Gastos de comercialización (comisiones)',
  '4.2.06.07.00.00': 'Gastos de comercialización (general)',
  '4.2.03.25.00.00': 'Gastos de comercialización (general)',
  '4.2.04.09.00.00': 'Gastos de comercialización (general)',
  '4.2.03.28.00.00': 'Gastos de comercialización (general)',
  '4.2.03.24.00.00': 'Gastos de comercialización (general)',
  '4.2.03.04.00.00': 'Gastos de comercialización (marketing)',
  '4.2.03.05.00.00': 'Gastos de comercialización (marketing)',
  '4.2.03.06.00.00': 'Gastos de comercialización (marketing)',
  '4.2.03.07.00.00': 'Gastos de comercialización (movilidad y viáticos)',
  '4.2.03.17.00.00': 'Gastos de comercialización (movilidad y viáticos)',
  '4.2.03.18.00.00': 'Gastos de comercialización (movilidad y viáticos)',
  '4.2.03.20.00.00': 'Gastos de comercialización (movilidad y viáticos)',
  '4.2.03.21.00.00': 'Gastos de comercialización (movilidad y viáticos)',
  '4.2.03.26.00.00': 'Gastos de comercialización (movilidad y viáticos)',
  '4.2.03.13.00.00': 'Gastos de comercialización (logistica)',
  '4.2.03.27.00.00': 'Gastos de comercialización (comisiones)',
  '4.2.03.29.00.00': 'Gastos de comercialización (profed)',
  '4.2.03.30.00.00': 'Gastos de comercialización (profed)',
  '4.2.04.03.00.00': 'Gastos de administración',
  '4.2.04.04.00.00': 'Gastos de administración',
  '4.2.04.05.00.00': 'Gastos de administración',
  '4.2.04.06.00.00': 'Gastos de administración',
  '4.2.04.07.00.00': 'Gastos de administración',
  '4.2.04.08.00.00': 'Gastos de administración',
  '4.2.04.10.00.00': 'Gastos de administración',
  '4.2.04.11.00.00': 'Gastos de administración',
  '4.2.04.12.00.00': 'Gastos de administración',
  '4.2.04.13.00.00': 'Gastos de administración',
  '4.2.04.14.00.00': 'Gastos de administración',
  '4.2.04.15.00.00': 'Gastos de administración',
  '4.2.04.16.00.00': 'Gastos de administración',
  '4.2.04.18.00.00': 'Gastos de administración',
  '4.2.05.02.00.00': 'Gastos de infraestructura',
  '4.2.05.03.00.00': 'Gastos de infraestructura',
  // 24/09/2026 (Finanzas, respuesta a la pregunta del cruce de julio -- "tomemos siempre la
  // cuenta 4.2.05.04.00.00 como gasto extraordinario... de ahora en adelante debería
  // tratarse siempre como extraordinario"): antes cayendo en "Gastos de infraestructura"
  // -- se mueve a su propia línea "(extraordinario)" (ver LINEAS_EXTRAORDINARIAS más abajo),
  // mismo tratamiento que Recupero de Seguro/Intereses FCI/etc -- queda AFUERA de "Total
  // Gastos Directos"/"Utilidad Neta", en gastoExtraordinarioPorLinea.
  '4.2.05.04.00.00': 'Conservación de edificios (extraordinario)',
  '4.2.05.05.00.00': 'Gastos de infraestructura',
  '4.2.05.06.00.00': 'Gastos de infraestructura',
  '4.2.05.07.00.00': 'Gastos de infraestructura',
  '4.2.06.01.00.00': 'Intereses por prestamos',
  '4.2.06.03.00.00': 'Gastos financieros',
  '4.2.06.04.00.00': 'Gastos financieros',
  '4.2.06.05.00.00': 'Gastos financieros',
  '4.2.06.08.00.00': 'Gastos financieros',
  '4.2.07.06.00.00': 'Impuestos y tasas (extraordinario)',
  '4.2.07.11.00.00': 'Impuestos y tasas',
  '4.2.07.04.00.00': 'Impuestos y tasas',
  '4.2.07.09.00.00': 'Impuestos y tasas',
  '4.2.07.13.00.00': 'Impuestos y tasas',
  '4.2.07.12.00.00': 'Impuestos y tasas',
};
// Líneas "(extraordinario)" -- el Excel real las deja FUERA de "total gastos directos"/
// "utilidad neta" (van en una sección aparte, debajo). Se marcan para que el cliente las
// pueda separar igual que hace 'EERR resumido'.
const LINEAS_EXTRAORDINARIAS = new Set([
  'Recupero de Seguro (extraordinario)',
  'Intereses FCI (extraordinario)',
  'Dif. Cotización Saldo Bancos (extraordinario)',
  'Impuestos y tasas (extraordinario)',
  'Conservación de edificios (extraordinario)',
  // 22/09/2026: aunque el nombre no dice "(extraordinario)", el Excel real ('EERR
  // resumido') SÍ la agrupa junto a las demás, debajo de "utilidad neta" -- confirmado
  // en su layout real, no en la etiqueta de la línea.
  'Intereses por prestamos',
]);
// 22/09/2026 (bug real encontrado en la reconciliación de julio 2026 -- "total gastos
// directos" de mi 1ra versión daba ~9.4M de más para cada unidad): en el Excel real,
// "Impuesto Ingresos Brutos" y "Seguridad e Higiene" NO forman parte de "total gastos
// directos" ('EERR resumido'!B35 = SUM(B22:B34)) -- van en un "Subtotal impuestos" APARTE
// (filas 15-17), restado ANTES de "Utilidad después de impuestos" (fila 19), que a su vez
// es lo que alimenta "utilidad después de gs directos" (fila 37 = B19-B35). Sacarlas del
// bucket de "gastos directos" y tratarlas como su propio subtotal reproduce el Excel real
// exacto (confirmado centavo a centavo en las 13 líneas restantes, las 4 unidades, julio
// 2026 -- únicas diferencias remanentes: reclasificaciones manuales puntuales que Juan
// Manuel hace a mano leyendo la descripción de cada asiento, ej. "obra" en Gastos de
// infraestructura o "Asesoramiento técnico outlandish", <0.6% del total).
const LINEAS_SUBTOTAL_IMPUESTOS = new Set(['Impuesto Ingresos Brutos', 'Seguridad e Higiene']);

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) return cachedToken;
  const user = process.env.OPPEN_USER_API;
  const pass = process.env.OPPEN_PASS_API;
  if (!user || !pass) throw new Error('Faltan las variables de entorno OPPEN_USER_API / OPPEN_PASS_API en Vercel.');
  const res = await fetch(`${BASE_URL}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!res.ok) throw new Error(`Fallo de autenticación contra oppen.io (${res.status}): ${await res.text().catch(() => '')}`);
  const data = await res.json();
  if (!data.ok || !data.token) throw new Error('La respuesta de autenticación no trajo token válido.');
  cachedToken = data.token;
  cachedTokenExpiresAt = now + (data.expires || 3600) * 1000;
  return cachedToken;
}

function primerDiaDelMes() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
function ultimoDiaDelMes() {
  const d = new Date();
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return `${ultimo.getUTCFullYear()}-${String(ultimo.getUTCMonth() + 1).padStart(2, '0')}-${String(ultimo.getUTCDate()).padStart(2, '0')}`;
}

async function fetchNltPage(token, fromDate, toDate, offset, limit) {
  const qs = new URLSearchParams({
    TransDate__gte: fromDate, TransDate__lte: toDate, Status: '1', Invalid: '0',
    __limit__: String(limit), __offset__: String(offset), __total_records__: '1',
  });
  const res = await fetch(`${BASE_URL}/NLT?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { cachedToken = null; throw new Error('Token rechazado por oppen.io (401).'); }
  if (!res.ok) throw new Error(`Error consultando NLT (${res.status}): ${await res.text().catch(() => '')}`);
  return res.json();
}

// Etiqueta contable "efectiva" de una línea de asiento (ver metodología arriba).
// Devuelve '' (sin etiqueta), un código de la whitelist, o null (línea no contable -- se
// descarta, igual que el reporte real).
function etiquetaEfectiva(labelsRaw) {
  const raw = labelsRaw || '';
  if (raw === '') return '';
  const tokens = raw.split(',').map(s => s.trim()).filter(Boolean);
  const match = tokens.find(t => ETIQUETAS_CONTABLES.has(t));
  return match || null;
}

// Recorre TODO julio (paginado) UNA sola vez y devuelve los 2 acumuladores que necesita el
// P&L de gastos: gastoDirectoPorUnidadYLinea (para las líneas mapeadas) y
// totalIndirectoPorEtiqueta (para el reparto de departamentos compartidos, sobre TODAS las
// cuentas "4.", no sólo las mapeadas -- mismo criterio que el SUMIF real).
async function pullYAgregarGastos(fromDate, toDate) {
  const token = await getToken();
  const limit = 200;
  let offset = 0, hasMore = true, pages = 0, headersSeen = 0;
  // grupo (unidad O subcanal de Minorista) -> { linea -> monto }
  const gastoDirectoPorUnidad = Object.fromEntries(Object.keys(TODOS_LOS_GRUPOS).map(u => [u, {}]));
  // etiqueta indirecta -> monto total (compañía completa)
  const totalIndirectoPorEtiqueta = Object.fromEntries(ETIQUETAS_INDIRECTAS.map(e => [e, 0]));
  let totalGastoDirectoCompania = 0; // control cruzado (equivalente a 'EERR horizontal'!N80)

  while (hasMore) {
    const page = await fetchNltPage(token, fromDate, toDate, offset, limit);
    pages++;
    const data = page.data || [];
    headersSeen += data.length;
    for (const h of data) {
      for (const r of (h.NLTRows || [])) {
        const acct = r.Account || '';
        if (!acct.startsWith('4.')) continue;
        const etiqueta = etiquetaEfectiva(r.Labels);
        if (etiqueta === null) continue; // línea de producto, no contable -- se descarta
        // 24/09/2026 (Finanzas, cruce de julio -- "el gap de la comisión ML"): esta cuenta
        // puntual mezcla el asiento real (Factura de Compra que emite Mercado Libre,
        // RecordSource "PurchaseInvoice!...") con un asiento espejo por cada Factura de
        // VENTA del período (RecordSource "Invoice!..."), que ya está neteado dentro de esa
        // misma venta -- sumar los 2 duplica el gasto. Se descarta la línea entera (no sólo
        // se resta) si el asiento no vino de una Factura de Compra real.
        if (acct === CUENTA_COMISION_ML && !String(h.RecordSource || '').startsWith('PurchaseInvoice!')) continue;
        const monto = r.ValueBase1 || 0;

        // 1) Departamentos indirectos: SUMIF por TODAS las cuentas "4." con esa etiqueta,
        //    con el mismo ajuste puntual que hace el Excel real.
        if (ETIQUETAS_INDIRECTAS.includes(etiqueta)) {
          const excluir = (AJUSTE_INDIRECTO_EXCLUIR[etiqueta] || []).some(a => a.account === acct);
          if (!excluir) totalIndirectoPorEtiqueta[etiqueta] += monto;
        }

        // 2) Gasto directo por unidad Y por subcanal: sólo cuentas mapeadas a una línea de
        //    P&L, sólo etiquetas que pertenecen a alguna de las 4 unidades del shell. Una
        //    etiqueta de Minorista matchea 2 grupos a la vez (su unidad Y su subcanal) --
        //    por eso se acumula en TODOS los grupos que matcheen, no sólo el primero.
        const linea = ACCOUNT_TO_LINEA[acct];
        if (linea) totalGastoDirectoCompania += monto;
        if (!linea || !ETIQUETAS_UNIDAD_CONOCIDA.has(etiqueta)) continue;
        for (const grupo of Object.keys(TODOS_LOS_GRUPOS)) {
          if (!TODOS_LOS_GRUPOS[grupo].includes(etiqueta)) continue;
          gastoDirectoPorUnidad[grupo][linea] = (gastoDirectoPorUnidad[grupo][linea] || 0) + monto;
        }
      }
    }
    hasMore = !!page.has_more;
    offset += limit;
    if (pages > 150) break; // guard de seguridad -- un mes normal entra en ~80-90 páginas
  }
  return { gastoDirectoPorUnidad, totalIndirectoPorEtiqueta, totalGastoDirectoCompania, pages, headersSeen };
}

// Ventas facturadas + CMV por unidad del período -- Ventas se usa como peso de reparto de
// los gastos indirectos (misma fila "Asignación" del Excel real) Y como línea informativa;
// CMV (costo de mercadería vendida) se resolvió así (22/09/2026, "Construir también el CMV
// desde Oppen" -- Juan Manuel eligió esta opción entre 3 después de probar las otras):
//   - El libro mayor (NLT) NO tiene el costo de mercadería vendida etiquetado por unidad de
//     negocio -- validado contra julio 2026: 445,97M de 446M de las cuentas 4.2.01.x caen en
//     "- Sin Etiqueta -" (sin ningún tag de unidad), a diferencia de los Gastos (sección de
//     arriba), que sí están etiquetados casi en su totalidad. No se puede repartir por
//     Etiqueta como el resto de este módulo.
//   - Se usa en cambio el costo REAL de cada línea de venta (OperativeCost de Invoice, ya
//     convertido a pesos si la factura era USD) -- exactamente lo que ya usa Stocks/Seguimiento
//     como costoUnit (ver comentario en oppen-invoices.js, "validado contra ~3000 líneas
//     reales: 94.8% con costo cargado"). Se agregó byUnidadNegocio.totalCosto a
//     oppen-invoices.js (cambio aditivo, mismo loop ya probado, no se reimplementa acá).
//   - OJO: este CMV NO va a coincidir con el CMV manual del Excel de Juan Manuel -- probado
//     contra julio 2026, desvíos de 10% a 35% según la unidad, porque el CMV manual incluye
//     ajustes de inventario/valuación que no están ni en el libro mayor etiquetado ni en el
//     costo de línea de factura. Es un costo real y en vivo, pero un concepto distinto
//     (costo de lo efectivamente facturado en el período, sin esos ajustes).
const SELF_BASE = 'https://icomdash-p2aa.vercel.app'; // mismo dominio interno que ya usa actualizar-venta-30d.js
const { calcularCmvAjustado } = require('./_cmv-historico-core');
// 23/09/2026 ("selector de canales... que filtre todo el dashboard"): además de
// byUnidadNegocio (4 unidades), ahora también se lee byCanal -- los 5 canales de venta de
// Minorista (Mercado Libre/Tienda Online/Central/ProSalud/JCP, mismos nombres normalizados
// que ya usa el resto del shell, ver ERP_CANAL_ICONS) -- para el "Asignación %" de cada
// canal individual se sigue usando la venta TOTAL de la compañía como denominador (mismo
// criterio que las 4 unidades, no sólo el total de Minorista).
//
// 26/09/2026 ("el ajuste institucional"): además del CMV crudo (OperativeCost de Oppen), se
// pide en paralelo el CMV ajustado por lista de precios Payers/Distribuidores (ver
// api/_cmv-historico-core.js -- metodología completa ahí, validada contra el cruce real de
// julio). Si esa llamada falla (lista del trimestre todavía no cargada, blob de
// SupplierItem/CustomerGrupos caído, etc.) se sigue con el CMV crudo de siempre -- ajuste
// puramente aditivo, nunca bloquea el P&L.
//
// 28/09/2026 ("el proyectado de arriba dice 340M pero el P&L calcula 330M, deben coincidir"):
// exportada aparte (ver api/pnl-gastos.js) para poder re-pedirla EN VIVO en cada lectura del
// mes en curso, sin recalcular todo el P&L de Gastos (eso sí es caro, ver comentario de
// cabecera del archivo). El gráfico de arriba ("Evolución mensual") ya pedía Ventas en vivo
// directo a Oppen en cada carga -- el P&L, en cambio, sólo se actualizaba 1 vez al día (Cron,
// ver actualizar-pnl-gastos.js), así que su "acumulado a hoy" quedaba congelado en el valor de
// esta madrugada. Como ambos aplican la MISMA fórmula de proyección (acumulado ÷ día
// transcurrido × días del mes) sobre acumulados distintos, el faltante de ventas de todo el
// día se amplificaba en la proyección -- de ahí el 340M vs 330M. Los Gastos (NLT, caros) siguen
// viniendo del blob diario sin cambios; sólo Ventas/CMV/Utilidad se refrescan en vivo.
async function fetchVentasYCmvPorUnidad(fromDate, toDate) {
  const qs = new URLSearchParams({ from: fromDate, to: toDate, soloUnidadNegocio: '1', fcn: '1' }); // fcn=1: suma el IVA de las ventas FCN (oficinas *-99), ver oppen-invoices.js
  const [res, ajuste] = await Promise.all([
    fetch(`${SELF_BASE}/api/oppen-invoices?${qs.toString()}`),
    calcularCmvAjustado(fromDate, toDate).catch(() => null),
  ]);
  if (!res.ok) throw new Error(`Error consultando oppen-invoices (${res.status}): ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const byUnidad = data.byUnidadNegocio || {};
  const byCanal = data.byCanal || {};
  const unidades = ['minorista', 'movilidad', 'cirugia_estetica', 'cirugia_general'];
  const canales = Object.keys(SUBCANAL_ETIQUETAS);
  const ventas = {}, cmv = {}, ivaFcn = {};
  // 07/10/2026 ("FCN son ventas no facturadas todavía... hay que sumarle el IVA"): la venta de cada
  // grupo incluye el IVA de sus ventas FCN (oficinas *-99) -- Oppen las guarda netas y Finanzas las
  // muestra con IVA. ivaFcn queda aparte para poder mostrarlo/auditarlo (ver ventaIvaFcnPeriodo).
  for (const u of unidades) {
    ivaFcn[u] = byUnidad[u] ? (byUnidad[u].ivaFcn || 0) : 0;
    ventas[u] = (byUnidad[u] ? byUnidad[u].totalNeto : 0) + ivaFcn[u];
    const cmvCrudo = byUnidad[u] ? byUnidad[u].totalCosto : 0;
    cmv[u] = (ajuste && ajuste.porUnidad[u]) ? ajuste.porUnidad[u].cmvAjustado : cmvCrudo;
  }
  for (const c of canales) {
    ivaFcn[c] = byCanal[c] ? (byCanal[c].ivaFcn || 0) : 0;
    ventas[c] = (byCanal[c] ? byCanal[c].totalNeto : 0) + ivaFcn[c];
    const cmvCrudo = byCanal[c] ? byCanal[c].totalCosto : 0;
    cmv[c] = (ajuste && ajuste.porCanal[c]) ? ajuste.porCanal[c].cmvAjustado : cmvCrudo;
  }
  return { ventas, cmv, ivaFcn, ajusteInstitucional: ajuste };
}

// 29/09/2026 ("no estoy de acuerdo con ese proyectado de cierre, en promedio dias de semana
// vendemos entre 10 y 14M, todavia resta todo el dia y todo el dia de mañana, no hay feriados
// ni fines de semana, mejora la formula"): la proyección vieja (acumulado ÷ día transcurrido ×
// días del mes) trata TODOS los días del mes como si vendieran lo mismo -- un mes que ya tuvo
// varios findes de semana (venta mucho más baja, a veces $0, para las unidades que no operan
// sábado/domingo) arrastra ese promedio hacia abajo, y la distorsión se aplica IGUAL a los días
// que faltan, aunque esos días que faltan sean todos hábiles (como en este caso puntual). Fix:
// separa el promedio diario en 2 baldes -- día hábil (Lun-Vie) y fin de semana (Sáb-Dom) --
// calculados SÓLO con días de este mes que ya cerraron del todo (nunca HOY, que está a mitad de
// transcurrir). El día de HOY y cada día que falta se estima con el promedio de SU tipo de día;
// el de HOY nunca baja de lo que ya se facturó hoy en la realidad (Math.max), para no mostrar
// una proyección menor a lo ya vendido. LIMITACIÓN CONOCIDA: no hay calendario de feriados
// cargado -- un feriado entre semana se sigue proyectando como día hábil normal (a propósito,
// no por descuido: agregar un calendario de feriados es una mejora aparte, no pedida acá).
// 01/10/2026 ("funciona mal el proyectado... para todas las unidades de negocios y para
// ICOM ventas en vivo", reportado el dia 1 del mes a las 15:56 ARG): avgHabil/avgFinde
// caian a 0 cuando todavia no habia NINGUN dia de ese tipo ya cerrado este mes -- el caso
// extremo es justamente el dia 1 del mes, donde nHabil=nFinde=0 siempre (todavia no cerro
// ni un solo dia). Con los 2 promedios en 0, el bucle de "futuro" sumaba 0 por cada uno de
// los ~30 dias restantes del mes, y la proyeccion total quedaba igual a lo vendido en lo
// que iba de HOY nomas (caso real: 8,78M en vez de rondar los 250-350M habituales). Fix:
// tasaSimple es la formula vieja (acumulado del mes hasta hoy inclusive / dia calendario
// de hoy) -- se usa SOLO como respaldo para el/los tipo(s) de dia que todavia no tienen
// ningun dia cerrado este mes, nunca pisa avgHabil/avgFinde una vez que ya hay al menos 1
// dia real de ese tipo para promediar (el caso ya validado el 29/09 sigue igual).
// 01/10/2026 ("despues de las 16:15 vamos a seguir vendiendo algo mas, sobre todo hasta las
// 19/20hs, despues baja bastante el volumen -- podemos estimar mejor el cierre del dia?"):
// hoyEstimado comparaba lo real de hoy sólo contra el promedio de un DÍA ENTERO (avgParaTipo),
// sin usar nada de la hora actual -- temprano en el día eso ya "daba por cerrado" el día con el
// promedio completo, y tarde en el día (como acá) ignoraba que a las 16:15 de un día hábil
// típico TODAVÍA falta vender una porción real de lo que falta hasta el cierre. horasPorGrupo
// (ver fetchVentasDiariasYAcumuladoPorUnidad) trae, por día, la lista de {hora, monto} de cada
// línea -- con eso se arma una curva "qué fracción de la venta total de un día típico de este
// tipo ya había ocurrido a esta misma hora", promediada sobre los días YA CERRADOS de este mes
// del mismo tipo (hábil/finde) que hoy. hoyEstimado = hoyReal ÷ esa fracción -- si a las 16:15
// un día hábil normal ya lleva vendido, en promedio, el 55% de su total, y hoy a esa hora ya se
// vendieron $X, el cierre esperado es X/0.55. Se descarta la fracción si da < 5% (muy temprano
// a la mañana, división ruidosa) o si no hay NINGÚN día cerrado de ese tipo con datos de hora
// todavía (mismo problema del "día 1 del mes" del fix anterior) -- en esos casos cae al
// promedio plano de siempre (avgParaTipo), sin romper nada de lo ya validado.
function calcularProyeccionPorGrupo(dailyPorGrupo, fromDate, horasPorGrupo) {
  const ARG_OFFSET_MS = 3 * 60 * 60 * 1000; // Argentina no tiene horario de verano, siempre UTC-3
  const hoyArg = new Date(Date.now() - ARG_OFFSET_MS);
  const hoyISO = hoyArg.toISOString().slice(0, 10);
  const [y, m] = fromDate.split('-').map(Number); // fromDate = primer día del mes, "YYYY-MM-01"
  const ultimoDiaMes = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const diaDelMesHoy = hoyArg.getUTCDate();
  const hoyDow = hoyArg.getUTCDay();
  const horaActualDecimal = hoyArg.getUTCHours() + hoyArg.getUTCMinutes() / 60 + hoyArg.getUTCSeconds() / 3600;

  const resultado = {};
  for (const [grupo, daily] of Object.entries(dailyPorGrupo)) {
    let sumaElapsedExcHoy = 0;
    let sumaHabil = 0, nHabil = 0, sumaFinde = 0, nFinde = 0;
    const horasGrupo = (horasPorGrupo && horasPorGrupo[grupo]) || {};
    let sumaFraccion = 0, nFraccion = 0;

    let dia = new Date(Date.UTC(y, m - 1, 1));
    while (true) {
      const iso = dia.toISOString().slice(0, 10);
      if (iso >= hoyISO) break; // hoy nunca cuenta como "ya cerrado"
      const v = daily[iso] || 0;
      sumaElapsedExcHoy += v;
      const dow = dia.getUTCDay();
      if (dow === 0 || dow === 6) { sumaFinde += v; nFinde++; } else { sumaHabil += v; nHabil++; }

      // Curva horaria: sólo entre días cerrados del MISMO tipo (hábil/finde) que hoy.
      if ((dow === 0 || dow === 6) === (hoyDow === 0 || hoyDow === 6) && v > 0) {
        const registros = horasGrupo[iso];
        if (registros && registros.length) {
          const hastaAhora = registros.reduce((s, r) => s + (r.hora <= horaActualDecimal ? r.monto : 0), 0);
          const fraccion = hastaAhora / v;
          if (fraccion > 0.05) { sumaFraccion += fraccion; nFraccion++; }
        }
      }
      dia = new Date(dia.getTime() + 86400000);
    }
    const hoyReal = daily[hoyISO] || 0;
    const tasaSimple = diaDelMesHoy > 0 ? (sumaElapsedExcHoy + hoyReal) / diaDelMesHoy : 0;
    const avgHabil = nHabil > 0 ? sumaHabil / nHabil : tasaSimple;
    const avgFinde = nFinde > 0 ? sumaFinde / nFinde : tasaSimple;
    const avgParaTipo = (dow) => (dow === 0 || dow === 6) ? avgFinde : avgHabil;

    const fraccionTipica = nFraccion > 0 ? sumaFraccion / nFraccion : null;
    const hoyEstimadoIntradia = fraccionTipica != null ? hoyReal / fraccionTipica : null;
    const hoyEstimado = hoyEstimadoIntradia != null
      ? Math.max(hoyReal, hoyEstimadoIntradia)
      : Math.max(hoyReal, avgParaTipo(hoyDow));

    // "Mañana" en adelante, hasta fin de mes -- Date.UTC normaliza solo el desborde de día
    // (ej. día 31+1 pasa de mes), por eso el corte real es comparar mes/año contra hoyArg.
    let futuro = 0;
    let d2 = new Date(Date.UTC(hoyArg.getUTCFullYear(), hoyArg.getUTCMonth(), hoyArg.getUTCDate() + 1));
    while (d2.getUTCDate() <= ultimoDiaMes && d2.getUTCMonth() === hoyArg.getUTCMonth() && d2.getUTCFullYear() === hoyArg.getUTCFullYear()) {
      futuro += avgParaTipo(d2.getUTCDay());
      d2 = new Date(d2.getTime() + 86400000);
    }
    resultado[grupo] = sumaElapsedExcHoy + hoyEstimado + futuro;
  }
  return resultado;
}

// Mismo dato que fetchVentasYCmvPorUnidad (ventas/cmv acumulados por unidad+canal), pero pide
// la respuesta COMPLETA de oppen-invoices (con `rows`, detalle por línea con fecha) en vez del
// modo liviano `soloUnidadNegocio` -- necesario para poder armar la serie diaria que alimenta
// calcularProyeccionPorGrupo. Mismo costo en TIEMPO que la versión liviana (pagina las mismas
// facturas igual, sólo cambia qué campos devuelve la respuesta) -- se usa sólo acá, en el Cron
// de 15 min (ver api/actualizar-pnl-venta-vivo.js), no en el Cron diario de Gastos.
async function fetchVentasDiariasYAcumuladoPorUnidad(fromDate, toDate) {
  const qs = new URLSearchParams({ from: fromDate, to: toDate, fcn: '1' }); // SIN soloUnidadNegocio -- hace falta `rows`; fcn=1 suma el IVA de las ventas FCN (ver oppen-invoices.js)
  const [res, ajuste] = await Promise.all([
    fetch(`${SELF_BASE}/api/oppen-invoices?${qs.toString()}`),
    calcularCmvAjustado(fromDate, toDate).catch(() => null),
  ]);
  if (!res.ok) throw new Error(`Error consultando oppen-invoices (${res.status}): ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const byUnidad = data.byUnidadNegocio || {};
  const byCanal = data.byCanal || {};
  const unidades = ['minorista', 'movilidad', 'cirugia_estetica', 'cirugia_general'];
  const canales = Object.keys(SUBCANAL_ETIQUETAS);
  const grupos = [...unidades, ...canales];

  const ventas = {}, cmv = {};
  for (const u of unidades) {
    ventas[u] = (byUnidad[u] ? byUnidad[u].totalNeto : 0) + (byUnidad[u] ? (byUnidad[u].ivaFcn || 0) : 0); // + IVA de las FCN
    const cmvCrudo = byUnidad[u] ? byUnidad[u].totalCosto : 0;
    cmv[u] = (ajuste && ajuste.porUnidad[u]) ? ajuste.porUnidad[u].cmvAjustado : cmvCrudo;
  }
  for (const c of canales) {
    ventas[c] = (byCanal[c] ? byCanal[c].totalNeto : 0) + (byCanal[c] ? (byCanal[c].ivaFcn || 0) : 0);
    const cmvCrudo = byCanal[c] ? byCanal[c].totalCosto : 0;
    cmv[c] = (ajuste && ajuste.porCanal[c]) ? ajuste.porCanal[c].cmvAjustado : cmvCrudo;
  }

  // Serie diaria por grupo -- una línea suma a la vez a su unidad de negocio Y a su canal (ej.
  // una venta de Minorista por Mercado Libre suma tanto a "minorista" como a "Mercado Libre").
  //
  // 01/10/2026 ("podemos estimar mejor el cierre del dia... hasta las 19/20hs despues baja
  // bastante el volumen"): además de la serie diaria, se arma horasPorGrupo -- por grupo y por
  // día, la lista de {hora, monto} de cada línea (ver horaDecimal en oppen-invoices.js) -- para
  // que calcularProyeccionPorGrupo pueda construir una curva horaria típica y estimar el cierre
  // de HOY según cuánto suele faltar vender a esta hora, en vez de sólo compararlo contra el
  // promedio de un día entero (ver el comentario grande junto a esa función).
  const dailyPorGrupo = {};
  const horasPorGrupo = {};
  for (const g of grupos) { dailyPorGrupo[g] = {}; horasPorGrupo[g] = {}; }
  for (const r of (data.rows || [])) {
    const partes = String(r.fecha || '').split('/'); // "DD/MM/YYYY"
    if (partes.length !== 3) continue;
    const [dd, mm, yyyy] = partes;
    const fechaISO = `${yyyy}-${mm}-${dd}`;
    const horaDecimal = typeof r.horaDecimal === 'number' ? r.horaDecimal : null;
    for (const g of [r.unidadNegocio, r.canal]) {
      if (!g || !dailyPorGrupo[g]) continue;
      const montoConIva = r.f + (r.ivaFcn || 0); // misma venta que `ventas` (incluye el IVA de las FCN)
      dailyPorGrupo[g][fechaISO] = (dailyPorGrupo[g][fechaISO] || 0) + montoConIva;
      if (horaDecimal != null) {
        if (!horasPorGrupo[g][fechaISO]) horasPorGrupo[g][fechaISO] = [];
        horasPorGrupo[g][fechaISO].push({ hora: horaDecimal, monto: montoConIva });
      }
    }
  }

  const ventaProyectada = calcularProyeccionPorGrupo(dailyPorGrupo, fromDate, horasPorGrupo);

  return { ventas, cmv, ventaProyectada, ajusteInstitucional: ajuste };
}

async function construirPnlGastos(overrideFrom, overrideTo) {
  const t0 = Date.now();
  const fromDate = overrideFrom || primerDiaDelMes();
  const toDate = overrideTo || ultimoDiaDelMes();
  const [{ gastoDirectoPorUnidad, totalIndirectoPorEtiqueta, totalGastoDirectoCompania, pages, headersSeen }, ventasYCmv] = await Promise.all([
    pullYAgregarGastos(fromDate, toDate),
    fetchVentasYCmvPorUnidad(fromDate, toDate).catch(() => null), // si falla, se sigue sin reparto indirecto ni Ventas/CMV
  ]);
  const ventasPorUnidad = ventasYCmv ? ventasYCmv.ventas : null;
  const cmvPorUnidad = ventasYCmv ? ventasYCmv.cmv : null;

  const unidades = Object.keys(UNIDAD_ETIQUETAS);
  // OJO: el denominador de "Asignación %" es SIEMPRE la venta de las 4 unidades (= venta de
  // toda la compañía) -- nunca se le suman también los 5 canales de Minorista, que son un
  // SUBCONJUNTO de la unidad "minorista" (sumarlos de nuevo duplicaría esa porción).
  const ventaTotal = ventasPorUnidad ? unidades.reduce((a, u) => a + (ventasPorUnidad[u] || 0), 0) : 0;
  // 23/09/2026 ("selector de canales... que filtre todo el dashboard"): se calcula el
  // MISMO resultado (Ventas/CMV/Utilidad/Gastos/Asignación) para los 5 canales de Minorista,
  // reusando exactamente la misma lógica de abajo -- por eso el loop ahora recorre las 4
  // unidades + los 5 canales juntos (TODOS_LOS_GRUPOS), no sólo las unidades.
  const gruposATratar = Object.keys(TODOS_LOS_GRUPOS);

  const resultado = {};
  for (const unidad of gruposATratar) {
    const directo = gastoDirectoPorUnidad[unidad] || {};
    const subtotalImpuestos = Object.fromEntries(Object.entries(directo).filter(([l]) => LINEAS_SUBTOTAL_IMPUESTOS.has(l)));
    const directoOperativo = Object.fromEntries(Object.entries(directo).filter(([l]) => !LINEAS_EXTRAORDINARIAS.has(l) && !LINEAS_SUBTOTAL_IMPUESTOS.has(l)));
    const directoExtraordinario = Object.fromEntries(Object.entries(directo).filter(([l]) => LINEAS_EXTRAORDINARIAS.has(l)));
    const totalSubtotalImpuestos = Object.values(subtotalImpuestos).reduce((a, v) => a + v, 0);
    const totalDirecto = Object.values(directoOperativo).reduce((a, v) => a + v, 0);

    const asignacionPct = (ventasPorUnidad && ventaTotal > 0) ? (ventasPorUnidad[unidad] || 0) / ventaTotal : null;
    const indirecto = {};
    let totalIndirecto = 0;
    if (asignacionPct != null) {
      for (const etq of ETIQUETAS_INDIRECTAS) {
        const monto = (totalIndirectoPorEtiqueta[etq] || 0) * asignacionPct;
        indirecto[etq] = monto;
        totalIndirecto += monto;
      }
    }

    // Utilidad bruta/neta: Ventas facturadas (Invoice) - CMV (Invoice, OperativeCost) -
    // Gastos (NLT, validado). Mezcla 2 fuentes de costo distintas a propósito (ver nota de
    // fetchVentasYCmvPorUnidad) -- por eso NO se llama "Utilidad Neta real" en la UI, es un
    // resultado operativo aproximado, útil para seguimiento en vivo, no un reemplazo del
    // cierre contable mensual de Juan Manuel.
    const ventaFacturadaPeriodo = ventasPorUnidad ? (ventasPorUnidad[unidad] || 0) : null;
    const cmvPeriodo = cmvPorUnidad ? (cmvPorUnidad[unidad] || 0) : null;
    const utilidadBruta = (ventaFacturadaPeriodo != null && cmvPeriodo != null) ? (ventaFacturadaPeriodo - cmvPeriodo) : null;
    const totalGasto = totalSubtotalImpuestos + totalDirecto + totalIndirecto;
    const utilidadNeta = utilidadBruta != null ? (utilidadBruta - totalGasto) : null;
    const utilidadNetaPct = (utilidadNeta != null && ventaFacturadaPeriodo) ? (utilidadNeta / ventaFacturadaPeriodo) : null;

    resultado[unidad] = {
      subtotalImpuestosPorLinea: subtotalImpuestos, // Impuesto Ingresos Brutos + Seguridad e Higiene -- fuera de "gastos directos", igual que el Excel real
      totalSubtotalImpuestos,
      gastoDirectoPorLinea: directoOperativo,
      gastoExtraordinarioPorLinea: directoExtraordinario,
      totalGastoDirecto: totalDirecto,
      asignacionPct,
      gastoIndirectoPorDepartamento: indirecto,
      totalGastoIndirecto: totalIndirecto,
      totalGasto,
      ventaFacturadaPeriodo,
      ventaIvaFcnPeriodo: ventasYCmv && ventasYCmv.ivaFcn ? (ventasYCmv.ivaFcn[unidad] || 0) : 0, // IVA de las ventas FCN que ya está sumado dentro de ventaFacturadaPeriodo
      cmvPeriodo,
      utilidadBruta,
      utilidadNeta,
      utilidadNetaPct,
    };
  }

  // Separar el resultado combinado en porUnidad (4 unidades del shell + Taller, sin cambios
  // de forma/nombre respecto a como ya lo consume el Dashboard) y porSubcanal (los 5 canales
  // de Minorista, nuevo -- para el selector "arriba en el dash de Ortopedia"). 24/09/2026:
  // Taller (UNIDADES_SIN_VENTA) entra en porUnidad.taller -- por ahora sin tarjeta propia en
  // el shell, sólo se suma al total ICOM (ver erpRenderIcomGastos en icom_panel_unificado.html).
  const porUnidad = {}, porSubcanal = {};
  for (const grupo of gruposATratar) {
    if (UNIDAD_ETIQUETAS[grupo] || UNIDADES_SIN_VENTA[grupo]) porUnidad[grupo] = resultado[grupo];
    else porSubcanal[grupo] = resultado[grupo];
  }

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    periodo: { from: fromDate, to: toDate },
    porUnidad,
    porSubcanal,
    totalIndirectoPorEtiquetaCompania: totalIndirectoPorEtiqueta,
    totalGastoDirectoCompania,
    nota: 'Gastos en vivo desde Oppen (Balance por Etiquetas). No incluye reclasificaciones manuales puntuales (ej. gastos de obra, asesoramientos puntuales) ni el neteo de comisión ML dentro de "Gastos de comercialización (general)" -- ver comentario de cabecera en api/_pnl-gastos-core.js para el detalle completo.',
    // 26/09/2026: CMV ahora incluye el ajuste por lista de precios Payers/Distribuidores para
    // ventas a OOSS/Instituciones (ver api/_cmv-historico-core.js) -- ya no es sólo el
    // OperativeCost crudo de Oppen. Validado contra julio 2026: cierra exacto contra el
    // desglose que Finanzas armó a mano. Igual sigue sin incluir ajustes de inventario/
    // valuación del cierre contable mensual (la brecha remanente, mucho más chica que antes).
    notaUtilidad: 'CMV = costo real de cada línea vendida (Invoice), ajustado por lista de precios Payers/Distribuidores para ventas a OOSS/Instituciones (misma metodología que usa Finanzas) -- puede seguir sin coincidir exacto con el cierre contable mensual (que además incluye ajustes de inventario/valuación que no están en las facturas). "Utilidad Neta" acá es un resultado operativo aproximado para seguimiento en vivo, no un cierre contable.',
    ajusteInstitucional: ventasYCmv ? ventasYCmv.ajusteInstitucional : null,
    debug: { ms: Date.now() - t0, pages, headersSeen },
  };
}

module.exports = { construirPnlGastos, fetchVentasYCmvPorUnidad, fetchVentasDiariasYAcumuladoPorUnidad, ETIQUETAS_CONTABLES, UNIDAD_ETIQUETAS, ACCOUNT_TO_LINEA };
