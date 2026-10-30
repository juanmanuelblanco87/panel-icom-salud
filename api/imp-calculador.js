// api/imp-calculador.js
//
// Importaciones > Calculador de Importación -- traslado (30/10/2026) de las rutas app/api/calc/* de ia40-dashboard (supuestos, product-types, run, scenarios) a UNA sola
// función del panel (se despacha por ?a=<acción>, para no multiplicar funciones). Misma lógica y mismas tablas de la base Neon (calc_supuestos, calc_product_types,
// calc_scenarios): no se migran datos. Acceso: permiso de app 'importaciones' (o admin), con la sesión del Talento -- igual que importaciones-token.js.
// Respuestas con la MISMA forma que las rutas originales (para que el sub-app del Calculador funcione casi sin cambios).
const { requerirSesion } = require('./_talento-auth');
const { query } = require('./_imp-db');
const { calcularImportacion, tamanoEnvioPorCbm } = require('./_imp-calc');
const ai = require('./_imp-ai');
const { obtenerTipoCambioOficialBcra } = require('./_imp-bcra');
const { predecirCategoriaMeli, consultarCostosMeli } = require('./_imp-meli');

const { CalcAiError } = ai;
const msgErr = (e) => (e instanceof CalcAiError ? e.message : String((e && e.message) || e));
const esTamano = (v) => v === 'chico' || v === 'mediano' || v === 'grande';

// ---------- supuestos ----------
function supuestosToNumbers(row) {
  return {
    tipoCambioArs: Number(row.tipo_cambio_ars), comisionMlPct: Number(row.comision_ml_pct), iibbPct: Number(row.iibb_pct), padsPct: Number(row.pads_pct),
    tasaEstadisticaPct: Number(row.tasa_estadistica_pct), tasaEstadisticaTopeUsd: Number(row.tasa_estadistica_tope_usd), ley25413Pct: Number(row.ley_25413_pct),
    seguroUsdUnidad: Number(row.seguro_usd_unidad), feeBajoTicketArs: Number(row.fee_bajo_ticket_ars), umbralBajoValorArs: Number(row.umbral_bajo_valor_ars),
    descuentoDistribucionPct: Number(row.descuento_distribucion_pct),
    fleteMaritimoUsd: Number(row.flete_maritimo_usd), fleteConfianza: row.flete_confianza, fleteRazonamiento: row.flete_razonamiento, fleteStatus: row.flete_status, fleteFetchedAt: row.flete_fetched_at,
    forwarderUsd: Number(row.forwarder_usd), despachanteUsd: Number(row.despachante_usd), thcUsd: Number(row.thc_usd), fleteLocalUsd: Number(row.flete_local_usd), manipuleoUsd: Number(row.manipuleo_usd),
    capacidadCbmContenedor: Number(row.capacidad_cbm_contenedor), capacidad20ftM3: Number(row.capacidad_20ft_m3),
    envioChicoArs: Number(row.envio_chico_ars), envioMedianoArs: Number(row.envio_mediano_ars), envioGrandeArs: Number(row.envio_grande_ars),
    tipoCambioFuenteFecha: row.tipo_cambio_fuente_fecha == null ? null : row.tipo_cambio_fuente_fecha,
  };
}
async function getOrCreateSupuestos() {
  await query('insert into calc_supuestos (id) values (1) on conflict (id) do nothing');
  const rows = await query('select * from calc_supuestos where id=1');
  return rows[0];
}
// Sólo los 22 campos de cálculo (sin los metadatos de flete) -- lo que consume calcularImportacion.
function supuestosToCalc(row) {
  const s = supuestosToNumbers(row);
  const { fleteConfianza, fleteRazonamiento, fleteStatus, fleteFetchedAt, tipoCambioFuenteFecha, ...calc } = s;
  return calc;
}

// ---------- tipos de producto ----------
function tipoToNumbers(row) {
  return {
    ...row,
    arancel_pct: row.arancel_pct != null ? Number(row.arancel_pct) : null,
    iva_pct: row.iva_pct != null ? Number(row.iva_pct) : null,
    trader_pct: Number(row.trader_pct == null ? 0 : row.trader_pct),
    tamano_envio: esTamano(row.tamano_envio) ? row.tamano_envio : 'mediano',
    peso_kg: row.peso_kg != null ? Number(row.peso_kg) : null,
    envio_meli_api_ars: row.envio_meli_api_ars != null ? Number(row.envio_meli_api_ars) : null,
    cbm_m3: row.cbm_m3 != null ? Number(row.cbm_m3) : null,
    pvp_ars_estimado: row.pvp_ars_estimado != null ? Number(row.pvp_ars_estimado) : null,
  };
}

async function guardarArancel(id, r) {
  await query(`update calc_product_types set arancel_pct=$1, arancel_confianza=$2, arancel_razonamiento=$3, arancel_status='found', arancel_fetched_at=now(), updated_at=now() where id=$4`, [r.pct, r.confianza, r.razonamiento, id]);
}
async function guardarIva(id, r) {
  await query(`update calc_product_types set iva_pct=$1, iva_confianza=$2, iva_razonamiento=$3, iva_status='found', iva_fetched_at=now(), updated_at=now() where id=$4`, [r.pct, r.confianza, r.razonamiento, id]);
}
async function guardarCbm(id, r, tamanoSiNulo) {
  const tamano = r.m3 != null ? tamanoEnvioPorCbm(r.m3) : tamanoSiNulo;
  await query(`update calc_product_types set cbm_m3=$1, cbm_confianza=$2, cbm_razonamiento=$3, cbm_status='found', cbm_fetched_at=now(), tamano_envio=coalesce($4, tamano_envio), updated_at=now() where id=$5`, [r.m3, r.confianza, r.razonamiento, tamano, id]);
  return tamano;
}

async function tiposListar() {
  const rows = await query('select * from calc_product_types order by nombre asc');
  return { productTypes: rows.map(tipoToNumbers) };
}

async function tiposCrear(body) {
  const nombre = String((body && body.nombre) || '').trim();
  if (!nombre) return { status: 400, data: { error: "Falta 'nombre'" } };
  const ncmCode = body.ncmCode ? String(body.ncmCode).trim() : null;
  const inserted = await query(`insert into calc_product_types (nombre, ncm_code) values ($1, $2) on conflict (nombre) do nothing returning *`, [nombre, ncmCode]);
  if (inserted.length === 0) return { status: 409, data: { error: `Ya existe un tipo de producto llamado "${nombre}"` } };
  const id = inserted[0].id;
  // Las 3 estimaciones por IA en paralelo; si alguna falla el tipo se crea igual (columna en 'error') y /run reintenta lo que falte.
  const [arancelR, ivaR, cbmR] = await Promise.allSettled([ai.estimarArancel(nombre, ncmCode), ai.estimarIva(nombre), ai.estimarCbm(nombre)]);
  if (arancelR.status === 'fulfilled') await guardarArancel(id, arancelR.value);
  else await query(`update calc_product_types set arancel_status='error', arancel_razonamiento=$1, updated_at=now() where id=$2`, [msgErr(arancelR.reason), id]);
  if (ivaR.status === 'fulfilled') await guardarIva(id, ivaR.value);
  else await query(`update calc_product_types set iva_status='error', iva_razonamiento=$1, updated_at=now() where id=$2`, [msgErr(ivaR.reason), id]);
  if (cbmR.status === 'fulfilled') await guardarCbm(id, cbmR.value, 'mediano');
  else await query(`update calc_product_types set cbm_status='error', cbm_razonamiento=$1, updated_at=now() where id=$2`, [msgErr(cbmR.reason), id]);
  const final = await query('select * from calc_product_types where id=$1', [id]);
  return { data: { productType: tipoToNumbers(final[0]) } };
}

async function tiposEditar(id, body) {
  const existing = await query('select * from calc_product_types where id=$1', [id]);
  if (existing.length === 0) return { status: 404, data: { error: 'Tipo de producto no encontrado' } };
  const cur = existing[0];
  const b = body || {};
  const nombre = b.nombre !== undefined ? String(b.nombre).trim() : cur.nombre;
  const ncmCode = b.ncmCode !== undefined ? (b.ncmCode ? String(b.ncmCode).trim() : null) : cur.ncm_code;
  const traderPct = b.traderPct !== undefined ? Number(b.traderPct) : Number(cur.trader_pct);
  const tamanoEnvio = esTamano(b.tamanoEnvio) ? b.tamanoEnvio : (cur.tamano_envio || 'mediano');
  const arancelPct = b.arancelPct !== undefined ? Number(b.arancelPct) : Number(cur.arancel_pct == null ? 0 : cur.arancel_pct);
  const arancelStatus = b.arancelPct !== undefined ? 'found' : cur.arancel_status;
  const arancelRaz = b.arancelPct !== undefined ? '(editado a mano)' : cur.arancel_razonamiento;
  const ivaPct = b.ivaPct !== undefined ? Number(b.ivaPct) : Number(cur.iva_pct == null ? 0 : cur.iva_pct);
  const ivaStatus = b.ivaPct !== undefined ? 'found' : cur.iva_status;
  const ivaRaz = b.ivaPct !== undefined ? '(editado a mano)' : cur.iva_razonamiento;
  const cbmM3 = b.cbmM3 !== undefined ? Number(b.cbmM3) : Number(cur.cbm_m3 == null ? 0 : cur.cbm_m3);
  const cbmStatus = b.cbmM3 !== undefined ? 'found' : cur.cbm_status;
  const cbmRaz = b.cbmM3 !== undefined ? '(editado a mano)' : cur.cbm_razonamiento;
  const pvp = b.pvpArsEstimado !== undefined ? Number(b.pvpArsEstimado) : cur.pvp_ars_estimado;
  const pvpStatus = b.pvpArsEstimado !== undefined ? 'found' : cur.pvp_status;
  const pvpRaz = b.pvpArsEstimado !== undefined ? '(editado a mano)' : cur.pvp_razonamiento;
  const pesoKg = b.pesoKg !== undefined ? Number(b.pesoKg) : cur.peso_kg;
  const pesoStatus = b.pesoKg !== undefined ? 'found' : cur.peso_status;
  const pesoRaz = b.pesoKg !== undefined ? '(editado a mano)' : cur.peso_razonamiento;
  const updated = await query(
    `update calc_product_types set nombre=$1, ncm_code=$2, trader_pct=$3, tamano_envio=$4,
       arancel_pct=$5, arancel_status=$6, arancel_razonamiento=$7, iva_pct=$8, iva_status=$9, iva_razonamiento=$10,
       cbm_m3=$11, cbm_status=$12, cbm_razonamiento=$13, pvp_ars_estimado=$14, pvp_status=$15, pvp_razonamiento=$16,
       peso_kg=$17, peso_status=$18, peso_razonamiento=$19, updated_at=now()
     where id=$20 returning *`,
    [nombre, ncmCode, traderPct, tamanoEnvio, arancelPct, arancelStatus, arancelRaz, ivaPct, ivaStatus, ivaRaz, cbmM3, cbmStatus, cbmRaz, pvp, pvpStatus, pvpRaz, pesoKg, pesoStatus, pesoRaz, id]);
  return { data: { productType: tipoToNumbers(updated[0]) } };
}

async function tiposBorrar(id) {
  const del = await query('delete from calc_product_types where id=$1 returning id', [id]);
  if (del.length === 0) return { status: 404, data: { error: 'Tipo de producto no encontrado' } };
  return { data: { eliminado: true } };
}

const CAMPOS = ['arancel', 'iva', 'cbm', 'pvp', 'peso'];
async function tiposRefrescar(id, field) {
  if (!CAMPOS.includes(field)) return { status: 400, data: { error: `field debe ser uno de: ${CAMPOS.join(', ')}` } };
  const rows = await query('select * from calc_product_types where id=$1', [id]);
  if (rows.length === 0) return { status: 404, data: { error: 'Tipo de producto no encontrado' } };
  const p = rows[0];
  try {
    if (field === 'arancel') await guardarArancel(id, await ai.estimarArancel(p.nombre, p.ncm_code));
    else if (field === 'iva') await guardarIva(id, await ai.estimarIva(p.nombre));
    else if (field === 'cbm') await guardarCbm(id, await ai.estimarCbm(p.nombre), null);
    else if (field === 'pvp') {
      const r = await ai.estimarPvpMercado(p.nombre);
      await query(`update calc_product_types set pvp_ars_estimado=$1, pvp_confianza=$2, pvp_razonamiento=$3, pvp_status=$4, pvp_fetched_at=now(), updated_at=now() where id=$5`,
        [r.pvpArsConIva, r.confianza, r.razonamiento, r.pvpArsConIva != null ? 'found' : 'not_found', id]);
    } else {
      const r = await ai.estimarPesoKg(p.nombre);
      await query(`update calc_product_types set peso_kg=$1, peso_confianza=$2, peso_razonamiento=$3, peso_status=$4, peso_fetched_at=now(), updated_at=now() where id=$5`,
        [r.kg, r.confianza, r.razonamiento, r.kg != null ? 'found' : 'not_found', id]);
    }
  } catch (err) {
    const msg = msgErr(err);
    await query(`update calc_product_types set ${field}_status='error', ${field}_razonamiento=$1, updated_at=now() where id=$2`, [msg, id]);
    return { data: { error: msg } };
  }
  const final = await query('select * from calc_product_types where id=$1', [id]);
  return { data: { productType: tipoToNumbers(final[0]) } };
}

// ---------- supuestos: acciones ----------
async function supuestosEditar(body) {
  const cur = supuestosToNumbers(await getOrCreateSupuestos());
  const n = { ...cur, ...(body || {}) };
  await query(
    `update calc_supuestos set tipo_cambio_ars=$1, comision_ml_pct=$2, iibb_pct=$3, pads_pct=$4, tasa_estadistica_pct=$5, tasa_estadistica_tope_usd=$6, ley_25413_pct=$7, seguro_usd_unidad=$8,
       fee_bajo_ticket_ars=$9, umbral_bajo_valor_ars=$10, descuento_distribucion_pct=$11, flete_maritimo_usd=$12, forwarder_usd=$13, despachante_usd=$14, thc_usd=$15,
       flete_local_usd=$16, manipuleo_usd=$17, capacidad_cbm_contenedor=$18, envio_chico_ars=$19, envio_mediano_ars=$20, envio_grande_ars=$21, capacidad_20ft_m3=$22, updated_at=now()
     where id=1`,
    [n.tipoCambioArs, n.comisionMlPct, n.iibbPct, n.padsPct, n.tasaEstadisticaPct, n.tasaEstadisticaTopeUsd, n.ley25413Pct, n.seguroUsdUnidad, n.feeBajoTicketArs, n.umbralBajoValorArs,
      n.descuentoDistribucionPct, n.fleteMaritimoUsd, n.forwarderUsd, n.despachanteUsd, n.thcUsd, n.fleteLocalUsd, n.manipuleoUsd, n.capacidadCbmContenedor,
      n.envioChicoArs, n.envioMedianoArs, n.envioGrandeArs, n.capacidad20ftM3].map(Number));
  return { supuestos: supuestosToNumbers(await getOrCreateSupuestos()) };
}

async function refrescarFlete() {
  await query('insert into calc_supuestos (id) values (1) on conflict (id) do nothing');
  try {
    const r = await ai.estimarFleteMaritimo();
    if (r.usd != null) {
      await query(`update calc_supuestos set flete_maritimo_usd=$1, flete_confianza=$2, flete_razonamiento=$3, flete_status='found', flete_fetched_at=now(), updated_at=now() where id=1`, [r.usd, r.confianza, r.razonamiento]);
    } else {
      await query(`update calc_supuestos set flete_status='not_found', flete_razonamiento=$1, flete_fetched_at=now(), updated_at=now() where id=1`, [r.razonamiento]);
    }
  } catch (err) {
    const msg = msgErr(err);
    await query(`update calc_supuestos set flete_status='error', flete_razonamiento=$1, flete_fetched_at=now(), updated_at=now() where id=1`, [msg]);
    return { error: msg };
  }
  const row = (await query('select * from calc_supuestos where id=1'))[0];
  return { fleteMaritimoUsd: Number(row.flete_maritimo_usd), fleteConfianza: row.flete_confianza, fleteRazonamiento: row.flete_razonamiento, fleteStatus: row.flete_status };
}

async function refrescarTipoCambio() {
  await query('insert into calc_supuestos (id) values (1) on conflict (id) do nothing');
  try {
    const { valor, fecha } = await obtenerTipoCambioOficialBcra();
    await query('update calc_supuestos set tipo_cambio_ars=$1, tipo_cambio_fuente_fecha=$2, updated_at=now() where id=1', [valor, fecha || null]);
    return { tipoCambioArs: valor, tipoCambioFuenteFecha: fecha };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

// ---------- run ----------
async function correr(body) {
  const productTypeId = Number(body && body.productTypeId);
  const fobUsd = Number(body && body.fobUsd);
  const pvpArsManual = body && body.pvpArsManual !== undefined && body.pvpArsManual !== null && body.pvpArsManual !== '' ? Number(body.pvpArsManual) : null;
  if (!Number.isFinite(productTypeId)) return { status: 400, data: { error: "Falta 'productTypeId'" } };
  if (!Number.isFinite(fobUsd) || fobUsd <= 0) return { status: 400, data: { error: "'fobUsd' invalido" } };

  const supuestos = supuestosToCalc(await getOrCreateSupuestos());
  const rows = await query('select * from calc_product_types where id=$1', [productTypeId]);
  if (rows.length === 0) return { status: 404, data: { error: 'Tipo de producto no encontrado' } };
  const producto = tipoToNumbers(rows[0]);

  // Red de seguridad: completa arancel/IVA/CBM si por algún motivo faltan.
  if (producto.arancel_pct == null) {
    try { const r = await ai.estimarArancel(producto.nombre, producto.ncm_code); await guardarArancel(productTypeId, r); producto.arancel_pct = r.pct; }
    catch (err) { return { data: { error: `No se pudo estimar el arancel: ${msgErr(err)}` } }; }
  }
  if (producto.iva_pct == null) {
    try { const r = await ai.estimarIva(producto.nombre); await guardarIva(productTypeId, r); producto.iva_pct = r.pct; }
    catch (err) { return { data: { error: `No se pudo estimar el IVA: ${msgErr(err)}` } }; }
  }
  if (producto.cbm_m3 == null) {
    try { const r = await ai.estimarCbm(producto.nombre); const t = await guardarCbm(productTypeId, r, null); producto.cbm_m3 = r.m3; if (t) producto.tamano_envio = t; }
    catch (err) { return { data: { error: `No se pudo estimar el CBM: ${msgErr(err)}` } }; }
  }

  // PVP de MeLi: manual > cacheado > estimado por IA (y cacheado). El PVP manual pasa a ser el nuevo PVP cacheado del tipo de producto.
  let pvpMeliArsConIva, pvpFuente;
  if (pvpArsManual != null && pvpArsManual > 0) {
    pvpMeliArsConIva = pvpArsManual; pvpFuente = 'manual';
    await query(`update calc_product_types set pvp_ars_estimado=$1, pvp_confianza='alta', pvp_razonamiento='Cargado a mano por el usuario en Calcular.', pvp_status='found', pvp_fetched_at=now(), updated_at=now() where id=$2`, [pvpArsManual, productTypeId]);
    producto.pvp_ars_estimado = pvpArsManual;
  } else if (producto.pvp_ars_estimado != null) {
    pvpMeliArsConIva = producto.pvp_ars_estimado; pvpFuente = 'cache';
  } else {
    try {
      const r = await ai.estimarPvpMercado(producto.nombre);
      if (r.pvpArsConIva == null) return { data: { error: 'No se encontro un PVP de mercado para este tipo de producto. Cargá uno manual para poder calcular.' } };
      await query(`update calc_product_types set pvp_ars_estimado=$1, pvp_confianza=$2, pvp_razonamiento=$3, pvp_status='found', updated_at=now() where id=$4`, [r.pvpArsConIva, r.confianza, r.razonamiento, productTypeId]);
      producto.pvp_ars_estimado = r.pvpArsConIva; pvpMeliArsConIva = r.pvpArsConIva; pvpFuente = 'ia';
    } catch (err) { return { data: { error: `No se pudo estimar el PVP de mercado: ${msgErr(err)}` } }; }
  }

  // Costo de envío real vía API de MeLi (mejor esfuerzo: si algo falla se cae a la tabla fija por tamaño; el cálculo NUNCA se rompe por esto).
  // La API devuelve el costo SIN IVA (la tabla fija se carga CON IVA).
  let envioArsNetoApi = null, envioFuente = 'tabla_fija';
  try {
    let categoryId = producto.ml_category_id || null;
    if (!categoryId) {
      const cat = await predecirCategoriaMeli(producto.nombre);
      categoryId = cat.categoryId;
      if (categoryId) await query('update calc_product_types set ml_category_id=$1, ml_category_nombre=$2, updated_at=now() where id=$3', [categoryId, cat.categoryNombre, productTypeId]);
    }
    let pesoKg = producto.peso_kg == null ? null : producto.peso_kg;
    if (pesoKg == null) {
      const p = await ai.estimarPesoKg(producto.nombre);
      if (p.kg != null) {
        await query(`update calc_product_types set peso_kg=$1, peso_confianza=$2, peso_razonamiento=$3, peso_status='found', peso_fetched_at=now(), updated_at=now() where id=$4`, [p.kg, p.confianza, p.razonamiento, productTypeId]);
        pesoKg = p.kg;
      }
    }
    if (pesoKg != null && producto.cbm_m3 != null) {
      const r = await consultarCostosMeli({ price: pvpMeliArsConIva, cbmM3: producto.cbm_m3, billableWeightKg: pesoKg });
      if (r.envioArs != null) {
        envioArsNetoApi = r.envioArs; envioFuente = 'api';
        await query(`update calc_product_types set envio_meli_api_ars=$1, envio_meli_api_status='found', envio_meli_api_razonamiento=$2, envio_meli_api_fetched_at=now(), updated_at=now() where id=$3`, [r.envioArs, r.rawTexto, productTypeId]);
      } else {
        await query(`update calc_product_types set envio_meli_api_status='error', envio_meli_api_razonamiento=$1, envio_meli_api_fetched_at=now(), updated_at=now() where id=$2`, [r.error || r.rawTexto || 'sin datos', productTypeId]);
      }
    }
  } catch (e) { /* best-effort */ }

  const resultado = calcularImportacion({
    fobUsd, pvpMeliArsConIva, supuestos,
    producto: {
      arancelPct: producto.arancel_pct == null ? 0 : producto.arancel_pct, ivaPct: producto.iva_pct == null ? 0.21 : producto.iva_pct, traderPct: producto.trader_pct,
      cbmM3: producto.cbm_m3 == null ? 0 : producto.cbm_m3, tamanoEnvio: producto.tamano_envio, envioArsNetoApi,
    },
  });
  return { data: { productType: producto, supuestos, pvpFuente, envioFuente, resultado } };
}

// ---------- escenarios ----------
let columnaNombreAsegurada = false;
async function asegurarColumnaNombre() {
  if (columnaNombreAsegurada) return;
  await query('alter table calc_scenarios add column if not exists nombre_escenario text');
  columnaNombreAsegurada = true;
}
function escenarioToRow(row) {
  const num = (v) => (v != null ? Number(v) : null);
  return {
    id: row.id, usuario: row.usuario, nombreEscenario: row.nombre_escenario == null ? null : row.nombre_escenario, nombreProducto: row.nombre_producto,
    fobUsd: Number(row.fob_usd), pvpMeliArsConIva: Number(row.pvp_meli_ars_con_iva), pvpFuente: row.pvp_fuente, tipoCambioArs: Number(row.tipo_cambio_ars),
    arancelPct: num(row.arancel_pct), ivaPct: num(row.iva_pct), cbmM3: num(row.cbm_m3), tamanoEnvio: row.tamano_envio, envioFuente: row.envio_fuente,
    margenMeliPct: num(row.margen_meli_pct), margenDistribucionPct: num(row.margen_distribucion_pct),
    supuestos: row.supuestos_json, productType: row.product_type_json, resultado: row.resultado_json, createdAt: row.created_at,
  };
}
async function escenariosListar(usuario) {
  await asegurarColumnaNombre();
  const rows = usuario ? await query('select * from calc_scenarios where usuario=$1 order by created_at desc limit 300', [usuario]) : await query('select * from calc_scenarios order by created_at desc limit 300');
  const usuarios = await query('select distinct usuario from calc_scenarios order by usuario asc');
  return { escenarios: rows.map(escenarioToRow), usuarios: usuarios.map((r) => r.usuario) };
}
async function escenariosGuardar(body) {
  const b = body || {};
  const usuario = String(b.usuario || '').trim();
  if (!usuario) return { status: 400, data: { error: 'Falta indicar el usuario que guarda el escenario.' } };
  const nombreEscenario = String(b.nombreEscenario || '').trim();
  if (!nombreEscenario) return { status: 400, data: { error: 'Falta el nombre del escenario.' } };
  if (!b.resultado || !b.supuestos || !b.productType) return { status: 400, data: { error: 'Faltan datos del cálculo para guardar el escenario.' } };
  await asegurarColumnaNombre();
  const g = (o, k) => (o && o[k] != null ? o[k] : null);
  const inserted = await query(
    `insert into calc_scenarios (usuario, product_type_id, nombre_producto, fob_usd, pvp_meli_ars_con_iva, pvp_fuente, tipo_cambio_ars, arancel_pct, iva_pct, cbm_m3, tamano_envio, envio_fuente,
       margen_meli_pct, margen_distribucion_pct, supuestos_json, product_type_json, resultado_json, nombre_escenario)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning *`,
    [usuario, b.productTypeId == null ? null : b.productTypeId, b.nombreProducto || g(b.productType, 'nombre') || '', b.fobUsd, g(b.resultado.meli, 'pvpConIva'), b.pvpFuente == null ? null : b.pvpFuente,
      g(b.supuestos, 'tipoCambioArs'), g(b.productType, 'arancel_pct'), g(b.productType, 'iva_pct'), g(b.productType, 'cbm_m3'), g(b.productType, 'tamano_envio'), b.envioFuente == null ? null : b.envioFuente,
      g(b.resultado.meli, 'margenPctSobreConIva'), g(b.resultado.distribucion, 'margenPctSobreConIva'),
      JSON.stringify(b.supuestos), JSON.stringify(b.productType), JSON.stringify(b.resultado), nombreEscenario]);
  return { data: { escenario: escenarioToRow(inserted[0]) } };
}
async function escenariosBorrar(id) {
  await query('delete from calc_scenarios where id=$1', [id]);
  return { data: { ok: true } };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  const conApp = !!solicitante && (solicitante.rol === 'admin' || (Array.isArray(solicitante.appsPermitidas) && solicitante.appsPermitidas.includes('importaciones')));
  if (!conApp) { res.status(403).json({ ok: false, error: 'No autorizado.' }); return; }

  const q = req.query || {};
  const a = String(q.a || '');
  const id = Number(q.id);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const m = req.method;
  try {
    let out; // { status?, data }
    if (a === 'supuestos' && m === 'GET') out = { data: { supuestos: supuestosToNumbers(await getOrCreateSupuestos()) } };
    else if (a === 'supuestos' && m === 'PATCH') out = { data: await supuestosEditar(body) };
    else if (a === 'refresh-flete' && m === 'POST') out = { data: await refrescarFlete() };
    else if (a === 'refresh-tipo-cambio' && m === 'POST') out = { data: await refrescarTipoCambio() };
    else if (a === 'bcra' && m === 'GET') out = { data: await obtenerTipoCambioOficialBcra() };
    else if (a === 'tipos' && m === 'GET') out = { data: await tiposListar() };
    else if (a === 'tipos' && m === 'POST') out = await tiposCrear(body);
    else if (a === 'tipo' && m === 'PATCH' && Number.isFinite(id)) out = await tiposEditar(id, body);
    else if (a === 'tipo' && m === 'DELETE' && Number.isFinite(id)) out = await tiposBorrar(id);
    else if (a === 'tipo-refresh' && m === 'POST' && Number.isFinite(id)) out = await tiposRefrescar(id, String(q.field || ''));
    else if (a === 'run' && m === 'POST') out = await correr(body);
    else if (a === 'escenarios' && m === 'GET') out = { data: await escenariosListar(q.usuario ? String(q.usuario) : null) };
    else if (a === 'escenarios' && m === 'POST') out = await escenariosGuardar(body);
    else if (a === 'escenario' && m === 'DELETE' && Number.isFinite(id)) out = await escenariosBorrar(id);
    else out = { status: 400, data: { error: 'Acción no válida.' } };
    res.status(out.status || 200).json(out.data);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
