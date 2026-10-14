// api/_cmv-historico-core.js
//
// 26/09/2026 ("Primero el ajuste institucional... y luego backfill de todos los meses"):
// capa de ajuste sobre el CMV en vivo (api/oppen-invoices.js) para replicar la metodología
// real de Finanzas -- arma sobre la infraestructura que ya se había dejado lista el
// 24/09/2026 para este mismo propósito (ver comentarios de api/listas-precios-guardar.js y
// api/actualizar-supplier-items.js, "recalcular el CMV de enero a agosto con estas listas").
//
// METODOLOGÍA (confirmada contra el cruce real de julio 2026 -- CMV_cruce_v3.xlsx, hoja "CMV
// por Unidad (Dashboard)" columnas G/H que armó Juan Manuel a mano: Costo Total crudo por
// unidad MENOS el ajuste de las hojas "Detalle Pagadores"/"Detalle Instituciones" = CMV real
// de Finanzas, SIN residuo):
//   - Cada línea de factura vendida a un cliente de Grupo "OOSS" usa como costo el precio de
//     la lista PAYERS (Sedesa) del trimestre en vez del OperativeCost de Oppen -- Payers es
//     un precio negociado especial para Obras Sociales, más bajo que el costo de línea que
//     trae el sistema (que refleja el costo de REPOSICIÓN, no el acuerdo comercial real).
//   - Cada línea vendida a "INSTITUCIÓN PRIVADA"/"INSTITUCIÓN PÚBLICA" usa el precio de la
//     lista DISTRIBUIDORES del trimestre (catálogo completo de precios floor).
//   - El resto de los clientes (Consumidor Final, Profesional, Sub-Dist, etc.) sigue con el
//     OperativeCost real de Oppen, sin cambios -- el ajuste sólo aplica a estos 2 grupos.
//   - Las listas identifican cada producto por CÓDIGO DE PROVEEDOR ("Material"), no por
//     nuestro SKU (ArtCode) -- se cruza vía SupplierItem (api/actualizar-supplier-items.js,
//     blob supplier_items.json).
//   - Fallback SIEMPRE hacia el OperativeCost original (nunca se descarta la línea ni se
//     infla el CMV inventando un precio) cuando: el cliente no tiene grupo resuelto, la línea
//     no tiene SupplierItem mapeado, o el material no está en la lista de ese trimestre (ej.
//     producto nuevo, o trimestre sin lista cargada todavía -- ver cargarListaPrecios).
//
// Trimestre por mes: Q1=Ene-Mar, Q2=Abr-Jun, Q3=Jul-Sep, Q4=Oct-Dic (mismo criterio que
// api/listas-precios-guardar.js). Ojo: Q3 2026 sólo tiene la lista de JULIO cargada (Finanzas
// no mandó una lista separada para agosto/septiembre) -- se usa igual para todo el
// trimestre, mismo criterio que ya usaba el análisis manual previo a este archivo.
//
// Requiere 3 blobs ya sincronizados por sus propios crons diarios (sin cambios acá):
// customer_grupos.json (grupoCliente ya viene adjunto en cada fila de oppen-invoices.js,
// no hace falta releerlo acá), supplier_items.json (ArtCode->SupItemCode),
// lista_precios_<tipo>_<trimestre>.json (api/listas-precios-guardar.js).
const { head: headBlob } = require('@vercel/blob');

const SELF_BASE = 'https://icomdash-p2aa.vercel.app'; // mismo dominio interno que ya usa _pnl-gastos-core.js

const GRUPO_A_LISTA = {
  'OOSS': 'payers',
  'INSTITUCIÓN PRIVADA': 'distribuidores',
  'INSTITUCIÓN PÚBLICA': 'distribuidores',
};

function trimestreDe(mesYYYYMM) {
  const [anio, mesStr] = mesYYYYMM.split('-');
  const q = Math.ceil(Number(mesStr) / 3);
  return `${anio}-Q${q}`;
}

async function leerBlobJson(pathname) {
  const info = await headBlob(pathname);
  const r = await fetch(info.url);
  if (!r.ok) throw new Error(`HTTP ${r.status} leyendo ${pathname}`);
  return r.json();
}

async function cargarListaPrecios(tipo, trimestre) {
  try {
    const data = await leerBlobJson(`lista_precios_${tipo}_${trimestre}.json`);
    return data.precios || {};
  } catch (e) {
    return null; // no cargada todavía para ese trimestre -- se sigue sin ajustar esas líneas
  }
}

async function fetchInvoiceRows(fromDate, toDate) {
  const qs = new URLSearchParams({ from: fromDate, to: toDate });
  const res = await fetch(`${SELF_BASE}/api/oppen-invoices?${qs.toString()}`);
  if (!res.ok) throw new Error(`Error consultando oppen-invoices (${res.status}): ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.rows || [];
}

// Misma guardia de sanidad que ya usa oppen-invoices.js para byUnidadNegocio[u].totalCosto
// (ver comentario grande ahí, "OperativeCost disparatado") -- se replica acá para que
// cmvOriginal (nuestro punto de partida, antes de ajustar) coincida EXACTO con ese totalCosto.
function esCostoSospechoso(costoLinea, neto) {
  return (neto > 0 && costoLinea > neto * 5) || costoLinea > 10_000_000;
}

// Devuelve, para el rango de fechas pedido, el CMV "crudo" (idéntico al que ya usa
// api/oppen-invoices.js) y el CMV ajustado por lista de precios (Payers/Distribuidores),
// separado por unidad de negocio Y por subcanal de Minorista (mismos 2 agrupamientos que ya
// arma _pnl-gastos-core.js a partir de byUnidadNegocio/byCanal).
async function calcularCmvAjustado(fromDate, toDate) {
  const mesYYYYMM = fromDate.slice(0, 7);
  const trimestre = trimestreDe(mesYYYYMM);

  const [rows, supplierItemsData, listaPayers, listaDistribuidores] = await Promise.all([
    fetchInvoiceRows(fromDate, toDate),
    leerBlobJson('supplier_items.json').catch(() => ({ mapa: {} })),
    cargarListaPrecios('payers', trimestre),
    cargarListaPrecios('distribuidores', trimestre),
  ]);
  const supplierItems = supplierItemsData.mapa || {};
  const listas = { payers: listaPayers, distribuidores: listaDistribuidores };

  function nuevoAcumulador() {
    return {
      cmvOriginal: 0, cmvAjustado: 0,
      lineasCandidatas: 0, lineasCorregidas: 0, lineasSinSupplierItem: 0, lineasSinPrecioEnLista: 0,
    };
  }
  const porUnidad = {};
  const porCanal = {};

  for (const row of rows) {
    // OJO (26/09/2026, bug encontrado validando contra byUnidadNegocio.totalCosto -- daba
    // 17,2M de más en Cirugía General de julio): el corte tiene que ser sobre costoUnit
    // (=0 cuando Oppen no tiene OperativeCost cargado para esa línea), NO sobre costoLinea.
    // Una nota de crédito (u negativo) con costoUnit>0 da costoLinea NEGATIVO -- eso SÍ
    // aporta (restando) a totalCosto en oppen-invoices.js (esa función nunca filtra por
    // signo, sólo por costoSospechoso) -- filtrar acá "costoLinea<=0" salteaba esas 20
    // líneas de devolución en vez de restarlas, perdiendo $17,2M de correcciones reales.
    const u = row.u || 0;
    const costoUnit = row.costoUnit || 0;
    if (costoUnit <= 0) continue; // sin costo cargado -- no aporta a totalCosto en oppen-invoices.js tampoco
    const costoLinea = costoUnit * u;
    if (esCostoSospechoso(costoLinea, row.f || 0)) continue; // excluido de totalCosto, igual que oppen-invoices.js

    const tipoLista = GRUPO_A_LISTA[row.grupoCliente];
    let costoAjustadoLinea = costoLinea;
    let candidata = false, corregida = false, sinSupplierItem = false, sinPrecioEnLista = false;
    if (tipoLista) {
      candidata = true;
      const lista = listas[tipoLista];
      if (!lista) {
        // trimestre sin lista cargada todavía -- se deja el costo original
      } else {
        const si = supplierItems[row.sku];
        if (!si) {
          sinSupplierItem = true;
        } else {
          const precio = lista[si.supItemCode];
          if (precio == null) {
            sinPrecioEnLista = true;
          } else {
            costoAjustadoLinea = precio * u;
            corregida = true;
          }
        }
      }
    }

    const aplicar = (bucket, key) => {
      if (!bucket[key]) bucket[key] = nuevoAcumulador();
      const a = bucket[key];
      a.cmvOriginal += costoLinea;
      a.cmvAjustado += costoAjustadoLinea;
      if (candidata) a.lineasCandidatas++;
      if (corregida) a.lineasCorregidas++;
      if (sinSupplierItem) a.lineasSinSupplierItem++;
      if (sinPrecioEnLista) a.lineasSinPrecioEnLista++;
    };
    if (row.unidadNegocio) aplicar(porUnidad, row.unidadNegocio); // IOMA/sin clasificar queda afuera, igual que byUnidadNegocio
    if (row.canal) aplicar(porCanal, row.canal);
  }

  for (const bucket of [porUnidad, porCanal]) {
    for (const key of Object.keys(bucket)) {
      bucket[key].ajusteInstitucional = bucket[key].cmvAjustado - bucket[key].cmvOriginal;
    }
  }

  return {
    trimestre,
    listasDisponibles: { payers: !!listaPayers, distribuidores: !!listaDistribuidores },
    porUnidad,
    porCanal,
  };
}

module.exports = { calcularCmvAjustado, trimestreDe };
