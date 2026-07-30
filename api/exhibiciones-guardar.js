// api/exhibiciones-guardar.js
//
// Única puerta de ESCRITURA para la app Exhibiciones (ver
// api/exhibiciones-data.js para lectura). Guarda todo en el mismo blob
// (exhibiciones_db.json) con un patrón simple de leer-modificar-escribir.
//
// Corre acá (server-side) los 4 controles de integridad de la
// especificación funcional de Juan Manuel (30/07/2026) que DEBEN bloquear
// el guardado si fallan:
//   6.1 Cuadre por espacio: suma de UNIDADES_ASIGNADAS de un espacio = CANT.
//   6.3 Integridad de claves: ID_ESPACIO existe, MACRO_CATEGORIA es una de
//       las 9 vigentes.
//   6.4 Medidas obligatorias: LARGO, ALTO y CANT > 0.
// El control 6.2 (cuadre por sucursal: suma de SUP_CATEGORIA de la sucursal
// = suma de SUP_VISUAL de sus espacios) NO bloquea acá -- es una consecuencia
// agregada de 6.1 espacio por espacio, y Juan Manuel decidió (30/07/2026,
// tras migrar Exhibiciones_IcomSalud.xlsx que HOY tiene desvíos abiertos:
// Icom Central +2.000 cm2 en E02, Icom Prosalud -12.600 cm2 en E08/E09)
// "migrar tal cual y alertar en la app" en vez de bloquear todo el resto de
// la app hasta que esos 2 desvíos preexistentes se corrijan. Por eso 6.2 se
// devuelve siempre calculado (para que la UI lo muestre como alerta), pero
// nunca impide guardar un cambio en OTRO espacio que sí cuadra bien.
//
// No hay secreto/token en las acciones normales (crear/editar espacio,
// guardar asignación, borrar) -- el panel entero ya está protegido por el
// login (usuario/clave) del shell, igual que el resto de los RPC de
// Stocks/Seguimiento no llevan su propio secreto por llamada. La única
// acción protegida con MAINTENANCE_SECRET es "seed" (carga inicial masiva
// desde el Excel, pensada para correr UNA sola vez).
const { put, head } = require('@vercel/blob');

const BLOB_PATHNAME = 'exhibiciones_db.json';

const MACRO_CATEGORIAS = [
  'Movilidad', 'Ortopedia y Rehabilitación', 'Electromedicina y Diagnóstico',
  'Ostomía y Heridas', 'Descartable Médico y Cirugía', 'Incontinencia e Higiene',
  'Audiología', 'Alquileres y Servicios', 'Farmacia y Diabetes',
];
const SUCURSALES = ['ICOM', 'PRO SALUD', 'JCP'];
const EPS = 1e-6;

async function leerDb() {
  try {
    const info = await head(BLOB_PATHNAME);
    const r = await fetch(info.url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    return { espacios: [], asignaciones: [], historial: [] };
  }
}

async function escribirDb(db) {
  db.generatedAt = new Date().toISOString();
  await put(BLOB_PATHNAME, JSON.stringify(db), {
    access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true,
  });
}

// --- Controles de integridad ---------------------------------------------

// 6.4: medidas obligatorias.
function validarMedidas(espacio) {
  const errores = [];
  if (!(espacio.largo > 0)) errores.push('LARGO debe ser mayor a 0.');
  if (!(espacio.alto > 0)) errores.push('ALTO debe ser mayor a 0.');
  if (!(espacio.cant > 0)) errores.push('CANT debe ser mayor a 0.');
  if (!SUCURSALES.includes(espacio.sucursal)) errores.push('SUCURSAL debe ser una de: ' + SUCURSALES.join(', ') + '.');
  return errores;
}

// 6.1 + 6.3 para un conjunto propuesto de filas de asignación de UN espacio.
function validarAsignacion(espacio, filas) {
  const errores = [];
  if (!espacio) {
    errores.push('El espacio no existe (ID_ESPACIO inválido).');
    return errores;
  }
  let suma = 0;
  filas.forEach((f) => {
    if (!MACRO_CATEGORIAS.includes(f.macroCategoria)) {
      errores.push('MACRO_CATEGORIA inválida: "' + f.macroCategoria + '".');
    }
    if (!(f.unidadesAsignadas >= 0)) {
      errores.push('UNIDADES_ASIGNADAS debe ser >= 0 (categoría "' + f.macroCategoria + '").');
    } else {
      suma += f.unidadesAsignadas;
    }
  });
  if (Math.abs(suma - espacio.cant) > EPS) {
    const signo = suma > espacio.cant ? 'de más (doble conteo)' : 'de menos (superficie ociosa sin declarar)';
    errores.push(
      'La suma de UNIDADES_ASIGNADAS (' + suma + ') no coincide con CANT (' + espacio.cant + ') '
      + 'del espacio ' + espacio.id + ': hay ' + Math.abs(suma - espacio.cant).toFixed(4) + ' unidad(es) ' + signo + '.'
    );
  }
  return errores;
}

// 6.2, informativo -- nunca bloquea. Devuelve el desvío en cm2 por sucursal.
function calcularCuadrePorSucursal(espacios, asignaciones) {
  const porSucursal = {};
  SUCURSALES.forEach((s) => { porSucursal[s] = { supVisualTotal: 0, supCategoriaTotal: 0 }; });
  espacios.forEach((e) => {
    if (!porSucursal[e.sucursal]) return;
    porSucursal[e.sucursal].supVisualTotal += (e.largo || 0) * (e.alto || 0) * (e.cant || 0);
  });
  const espacioById = {};
  espacios.forEach((e) => { espacioById[e.id] = e; });
  asignaciones.forEach((a) => {
    const e = espacioById[a.idEspacio];
    if (!e || !porSucursal[e.sucursal]) return;
    const supUnitaria = (e.largo || 0) * (e.alto || 0);
    porSucursal[e.sucursal].supCategoriaTotal += (a.unidadesAsignadas || 0) * supUnitaria;
  });
  const resultado = {};
  Object.keys(porSucursal).forEach((s) => {
    const { supVisualTotal, supCategoriaTotal } = porSucursal[s];
    resultado[s] = { supVisualTotal, supCategoriaTotal, deltaCm2: supCategoriaTotal - supVisualTotal };
  });
  return resultado;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Método no soportado, usar POST.' }); return; }

  try {
    const body = req.body || {};
    const { action } = body;

    if (action === 'seed') {
      const url = new URL(req.url, 'https://' + req.headers.host);
      const secret = url.searchParams.get('secret');
      if (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET) {
        res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
        return;
      }
      const { espacios, asignaciones, historial } = body.payload || {};
      if (!Array.isArray(espacios) || !Array.isArray(asignaciones)) {
        res.status(400).json({ ok: false, error: 'payload debe traer {espacios:[], asignaciones:[], historial:[]}' });
        return;
      }
      const db = { espacios, asignaciones, historial: historial || [] };
      await escribirDb(db);
      res.status(200).json({ ok: true, seeded: true, nEspacios: espacios.length, nAsignaciones: asignaciones.length });
      return;
    }

    const db = await leerDb();
    db.espacios = db.espacios || [];
    db.asignaciones = db.asignaciones || [];
    db.historial = db.historial || [];

    if (action === 'upsertEspacio') {
      const espacio = body.payload;
      if (!espacio || !espacio.id) { res.status(400).json({ ok: false, error: 'payload.id es obligatorio.' }); return; }
      const erroresMedidas = validarMedidas(espacio);
      if (erroresMedidas.length) {
        res.status(422).json({ ok: false, errores: erroresMedidas });
        return;
      }
      const idx = db.espacios.findIndex((e) => e.id === espacio.id);
      const esAlta = idx === -1;
      if (esAlta) {
        db.espacios.push({
          id: espacio.id, descripcion: espacio.descripcion || '', largo: espacio.largo, alto: espacio.alto,
          cant: espacio.cant, sucursal: espacio.sucursal, imagenUrl: espacio.imagenUrl || null,
          fechaRelevamiento: espacio.fechaRelevamiento || null,
        });
      } else {
        const actual = db.espacios[idx];
        db.espacios[idx] = {
          ...actual,
          descripcion: espacio.descripcion !== undefined ? espacio.descripcion : actual.descripcion,
          largo: espacio.largo !== undefined ? espacio.largo : actual.largo,
          alto: espacio.alto !== undefined ? espacio.alto : actual.alto,
          cant: espacio.cant !== undefined ? espacio.cant : actual.cant,
          sucursal: espacio.sucursal !== undefined ? espacio.sucursal : actual.sucursal,
          imagenUrl: espacio.imagenUrl !== undefined ? espacio.imagenUrl : actual.imagenUrl,
          fechaRelevamiento: espacio.fechaRelevamiento !== undefined ? espacio.fechaRelevamiento : actual.fechaRelevamiento,
        };
      }
      // Si cambió CANT, re-chequeamos 6.1 contra las asignaciones actuales
      // de este espacio -- si el cambio de CANT rompe el cuadre, bloqueamos
      // el guardado del espacio y pedimos ajustar la asignación en el mismo
      // paso (evita quedar con un espacio "fantasma" descuadrado sin que
      // nadie se entere).
      const espacioFinal = db.espacios.find((e) => e.id === espacio.id);
      const asignacionesDeEsteEspacio = db.asignaciones.filter((a) => a.idEspacio === espacio.id);
      if (asignacionesDeEsteEspacio.length > 0) {
        const erroresCuadre = validarAsignacion(espacioFinal, asignacionesDeEsteEspacio);
        if (erroresCuadre.length) {
          res.status(422).json({
            ok: false,
            errores: erroresCuadre.map((e) => e + ' Ajustá la asignación de categorías de ' + espacio.id + ' antes de guardar este cambio de medidas/cantidad.'),
          });
          return;
        }
      }
      await escribirDb(db);
      res.status(200).json({ ok: true, cuadrePorSucursal: calcularCuadrePorSucursal(db.espacios, db.asignaciones) });
      return;
    }

    if (action === 'deleteEspacio') {
      const { id, usuario } = body.payload || {};
      const idx = db.espacios.findIndex((e) => e.id === id);
      if (idx === -1) { res.status(404).json({ ok: false, error: 'El espacio ' + id + ' no existe.' }); return; }
      const ahora = new Date().toISOString();
      // Las asignaciones vigentes de este espacio pasan al historial como
      // "baja" (nunca se borra historial, solo se cierra vigencia).
      db.asignaciones.filter((a) => a.idEspacio === id).forEach((a) => {
        db.historial.push({ ...a, vigenteHasta: ahora, usuario: usuario || 'desconocido', fecha: ahora, accion: 'baja' });
      });
      db.asignaciones = db.asignaciones.filter((a) => a.idEspacio !== id);
      db.espacios.splice(idx, 1);
      await escribirDb(db);
      res.status(200).json({ ok: true, cuadrePorSucursal: calcularCuadrePorSucursal(db.espacios, db.asignaciones) });
      return;
    }

    if (action === 'guardarAsignacion') {
      const { idEspacio, filas, usuario } = body.payload || {};
      if (!idEspacio || !Array.isArray(filas)) {
        res.status(400).json({ ok: false, error: 'payload debe traer {idEspacio, filas:[{macroCategoria,unidadesAsignadas}]}' });
        return;
      }
      const espacio = db.espacios.find((e) => e.id === idEspacio);
      // Filtramos filas en 0 (no aportan superficie, no hace falta
      // persistirlas) y agrupamos por si el cliente mandó la misma
      // categoría repetida.
      const agregadas = {};
      filas.forEach((f) => {
        if (!f || !f.macroCategoria) return;
        agregadas[f.macroCategoria] = (agregadas[f.macroCategoria] || 0) + (Number(f.unidadesAsignadas) || 0);
      });
      const filasLimpias = Object.entries(agregadas)
        .filter(([, v]) => v > 0)
        .map(([macroCategoria, unidadesAsignadas]) => ({ macroCategoria, unidadesAsignadas }));

      const errores = validarAsignacion(espacio, filasLimpias);
      if (errores.length) {
        res.status(422).json({ ok: false, errores });
        return;
      }

      const ahora = new Date().toISOString();
      // Cierra vigencia de las filas actuales de este espacio (pasan a
      // historial con vigenteHasta=ahora) y agrega las nuevas como vigentes.
      db.asignaciones.filter((a) => a.idEspacio === idEspacio).forEach((a) => {
        db.historial.push({ ...a, vigenteHasta: ahora, usuario: usuario || 'desconocido', fecha: ahora, accion: 'edicion' });
      });
      db.asignaciones = db.asignaciones.filter((a) => a.idEspacio !== idEspacio);
      filasLimpias.forEach((f) => {
        db.asignaciones.push({ idEspacio, macroCategoria: f.macroCategoria, unidadesAsignadas: f.unidadesAsignadas });
        db.historial.push({
          idEspacio, macroCategoria: f.macroCategoria, unidadesAsignadas: f.unidadesAsignadas,
          vigenteDesde: ahora, vigenteHasta: null, usuario: usuario || 'desconocido', fecha: ahora, accion: 'edicion',
        });
      });

      await escribirDb(db);
      res.status(200).json({ ok: true, cuadrePorSucursal: calcularCuadrePorSucursal(db.espacios, db.asignaciones) });
      return;
    }

    res.status(400).json({ ok: false, error: 'action desconocida: ' + action });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
