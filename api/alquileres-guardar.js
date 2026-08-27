// api/alquileres-guardar.js
// Endpoint POST -- únicas acciones que escriben en Alquileres.
// Requiere sesión válida (mismas cuentas/roles que Gestión de Talento,
// ver api/_talento-auth.js) Y rol admin o gerente de la unidad
// Ortopedia -- el resto de los roles puede leer vía alquileres-data.js
// pero no guardar cambios (confirmado con el usuario).
const { requerirSesion } = require('./_talento-auth');
const { guardarAlquilerConfig, guardarAlquileresGlobals } = require('./_alquileres-store');

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
    actualizadoPor: { rol: solicitante.rol, usuario: solicitante.usuario },
    fecha: new Date().toISOString(),
  };
  await guardarAlquileresGlobals(globals);
  return globals;
}

const ACCIONES = {
  guardarConfig: accionGuardarConfig,
  guardarGlobals: accionGuardarGlobals,
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
