// api/alquileres-guardar.js
// Endpoint POST -- únicas acciones que escriben en Alquileres.
// Requiere sesión válida (mismas cuentas/roles que Gestión de Talento,
// ver api/_talento-auth.js) Y rol admin o gerente de la unidad
// Ortopedia -- el resto de los roles puede leer vía alquileres-data.js
// pero no guardar cambios (confirmado con el usuario).
const { requerirSesion } = require('./_talento-auth');
const {
  guardarAlquilerConfig, guardarAlquileresGlobals,
  leerAlquilerCatalogoCustom, guardarAlquilerCatalogoCustom, marcarProductoEliminado,
} = require('./_alquileres-store');
const {
  FACTOR_DIARIO_DEFAULT, FACTOR_SEMANAL_DEFAULT, FACTOR_QUINCENAL_DEFAULT,
} = require('./_alquileres-formula');
const { leerCatalogoCompleto, leerCatalogoEstatico, generarFilasProductoNuevo } = require('./_alquileres-catalogo');

function httpError(status, mensaje) {
  const e = new Error(mensaje);
  e.status = status;
  return e;
}

function puedeEditarAlquileres(solicitante) {
  if (!solicitante) return false;
  if (solicitante.rol === 'admin') return true;
  return solicitante.rol === 'gerente' && solicitante.unidadNegocio === 'Ortopedia';
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function accionGuardarConfig(payload, solicitante) {
  const { id } = payload;
  if (!id) throw httpError(400, 'Falta el id del producto.');

  const config = {
    id,
    skuOppen: payload.skuOppen ? String(payload.skuOppen).trim() : null,
    usosMaximos: numOrNull(payload.usosMaximos),
    multiplicadorDeposito: numOrNull(payload.multiplicadorDeposito) ?? 1.5,
    // 25/08/2026 ("no veo el lugar para pegar el link... no sé si
    // referencia del mercado se refiere al de alquiler o producto
    // nuevo"): son 2 referencias DISTINTAS, cada una con su propio
    // link -- precioProductoNuevo/linkProductoNuevo alimenta el piso
    // de amortización; precioMercado/linkMercado es el alquiler de la
    // competencia, sólo de referencia visual (nunca se mezcla en la
    // fórmula, ver _alquileres-formula.js).
    precioProductoNuevo: numOrNull(payload.precioProductoNuevo),
    linkProductoNuevo: payload.linkProductoNuevo ? String(payload.linkProductoNuevo).trim() : null,
    // 27/08/2026 ("trae una imagen del producto miniatura extraida del
    // MeLi producto nuevo"): URL de la foto, la trae el proxy de MeLi
    // (ver alquileres-scrape.js) -- el cliente la guarda junto con el
    // resto de la config cuando confirma "Guardar cambios", mismo
    // patrón que precioProductoNuevo.
    imagenProductoNuevo: payload.imagenProductoNuevo ? String(payload.imagenProductoNuevo).trim() : null,
    precioMercado: numOrNull(payload.precioMercado),
    linkMercado: payload.linkMercado ? String(payload.linkMercado).trim() : null,
    overrideManual: numOrNull(payload.overrideManual),
    actualizadoPor: { rol: solicitante.rol, usuario: solicitante.usuario },
    fecha: new Date().toISOString(),
  };
  await guardarAlquilerConfig(config);
  return config;
}

// 25/08/2026 ("la inflación acumulada se debe medir desde la última
// actualización de precios"): ya no hace falta un "% acumulado" a
// mano ni un modo simple/compuesto -- los meses a componer se derivan
// del historial de snapshots (ver mesesDesdeUltimoCambioDePrecio en
// _alquileres-formula.js). El único parámetro global que queda es la
// tasa mensual estimada.
async function accionGuardarGlobals(payload, solicitante) {
  const globals = {
    monthlyPct: numOrNull(payload.monthlyPct) ?? 0,
    redondeo: numOrNull(payload.redondeo) || 1000,
    // 25/08/2026 ("agrega el GM de la operación"): margen bruto
    // objetivo -- ver _alquileres-formula.js (piso = costo / (1-GM%)).
    gmObjetivoPct: numOrNull(payload.gmObjetivoPct) ?? 50,
    // 25/08/2026 ("Agrega un costo Administrativo que se suma al costo
    // de producto"): monto fijo por alquiler, global (no por
    // producto), se suma al costo derivado del precio del nuevo antes
    // de aplicar el margen -- ver _alquileres-formula.js.
    costoAdministrativo: numOrNull(payload.costoAdministrativo) ?? 1000,
    // 27/08/2026 ("no me gusta esta formula... el valor actual no
    // debería pesar, mismo criterio para todos inicialmente, recién
    // mes 2/3/4 corregir por inflación"): antes de este mínimo de
    // meses, precioVigenteOppen NO compite como piso -- ver
    // _alquileres-formula.js.
    mesesMinInflacion: numOrNull(payload.mesesMinInflacion) ?? 3,
    // 01/09/2026 ("el precio que manda es el mensual, desde ahi se
    // re-calculan automaticamente el resto" + "cuantos menos dias
    // alquilen mas rentable... mas honeroso -precio unitario- para el
    // cliente"): factores de derivación Diario/Semanal/Quincenal desde
    // el precio mensual (multiplican la tarifa diaria implícita del
    // mensual) -- ver derivarSugeridoDesdeMensual en _alquileres-formula.js.
    factorDiario: numOrNull(payload.factorDiario) ?? FACTOR_DIARIO_DEFAULT,
    factorSemanal: numOrNull(payload.factorSemanal) ?? FACTOR_SEMANAL_DEFAULT,
    factorQuincenal: numOrNull(payload.factorQuincenal) ?? FACTOR_QUINCENAL_DEFAULT,
    actualizadoPor: { rol: solicitante.rol, usuario: solicitante.usuario },
    fecha: new Date().toISOString(),
  };
  await guardarAlquileresGlobals(globals);
  return globals;
}

// 02/09/2026 ("deja la opción de sumar un nuevo producto de alquiler o
// eliminar un existente"): genera las 4 filas de período (Mensual
// canónico + Diario/Semanal/Quincenal derivados, ver
// generarFilasProductoNuevo en _alquileres-catalogo.js) y las agrega a
// la colección custom en Redis -- el catálogo estático (los 27
// productos originales) nunca se toca. `nombre` es sólo el nombre del
// PRODUCTO (sin "Alquiler Mensual" -- se antepone acá, mismo patrón
// que ya usan las 27 filas originales).
async function accionAgregarProducto(payload, solicitante) {
  const nombre = String(payload.nombre || '').trim();
  if (!nombre) throw httpError(400, 'Falta el nombre del producto.');
  const categoria = payload.categoria ? String(payload.categoria).trim() : 'Otros';
  const skuOppen = payload.skuOppen ? String(payload.skuOppen).trim() : null;

  const estatico = leerCatalogoEstatico();
  const custom = await leerAlquilerCatalogoCustom();
  const idsExistentes = new Set(estatico.concat(custom).map(p => p.id));
  const filas = generarFilasProductoNuevo(nombre, categoria, skuOppen, idsExistentes);

  const nuevoCustom = custom.concat(filas);
  await guardarAlquilerCatalogoCustom(nuevoCustom);

  // Config inicial opcional (usosMaximos/precioProductoNuevo/
  // multiplicadorDeposito) -- si se cargó algo, se guarda de una vez en
  // la fila canónica (Mensual), mismo patrón que accionGuardarConfig,
  // para no obligar a un 2do paso ("agregar" y después "editar") si el
  // usuario ya tiene esos datos a mano.
  const filaCanonica = filas.find(f => f.periodo === 'mes');
  if (numOrNull(payload.usosMaximos) != null || numOrNull(payload.precioProductoNuevo) != null) {
    await guardarAlquilerConfig({
      id: filaCanonica.id,
      skuOppen: skuOppen,
      usosMaximos: numOrNull(payload.usosMaximos),
      multiplicadorDeposito: numOrNull(payload.multiplicadorDeposito) ?? 1.5,
      precioProductoNuevo: numOrNull(payload.precioProductoNuevo),
      linkProductoNuevo: null, imagenProductoNuevo: null,
      precioMercado: null, linkMercado: null, overrideManual: null,
      actualizadoPor: { rol: solicitante.rol, usuario: solicitante.usuario },
      fecha: new Date().toISOString(),
    });
  }

  return { productoBaseId: filaCanonica.productoBaseId, filas };
}

// Baja BLANDA -- ver marcarProductoEliminado/comentario grande en
// _alquileres-store.js. `productoBaseId`, no `id` de una fila puntual
// -- se da de baja el producto entero (sus 4 períodos juntos), nunca
// uno solo (no tendría sentido tener 3 de 4 períodos de un producto).
async function accionEliminarProducto(payload) {
  const productoBaseId = String(payload.productoBaseId || '').trim();
  if (!productoBaseId) throw httpError(400, 'Falta el productoBaseId.');
  const catalogo = await leerCatalogoCompleto();
  if (!catalogo.some(p => (p.productoBaseId || p.id) === productoBaseId)) {
    throw httpError(404, 'Producto no encontrado (¿ya estaba eliminado?).');
  }
  await marcarProductoEliminado(productoBaseId);
  return { productoBaseId };
}

const ACCIONES = {
  guardarConfig: accionGuardarConfig,
  guardarGlobals: accionGuardarGlobals,
  agregarProducto: accionAgregarProducto,
  eliminarProducto: accionEliminarProducto,
};

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Método no soportado, usar POST.' });
    return;
  }

  const solicitante = requerirSesion(req);
  if (!solicitante) {
    res.status(401).json({ ok: false, error: 'Sesión inválida o vencida.' });
    return;
  }
  if (!puedeEditarAlquileres(solicitante)) {
    res.status(403).json({ ok: false, error: 'No tenés permiso para modificar Alquileres (sólo Admin o Gerente de Ortopedia).' });
    return;
  }

  try {
    const { accion, ...payload } = req.body || {};
    const fn = ACCIONES[accion];
    if (!fn) throw httpError(400, `Acción desconocida: ${accion}`);
    const resultado = await fn(payload, solicitante);
    res.status(200).json({ ok: true, resultado });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('alquileres-guardar error:', err);
    res.status(status).json({ ok: false, error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.puedeEditarAlquileres = puedeEditarAlquileres;
