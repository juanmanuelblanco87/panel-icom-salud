// api/listas-precios-guardar.js
//
// 24/09/2026 ("busca la mejor manera de subir las listas y re-calcular para que podamos
// re-utilizar esta funcionalidad en el caso de requerirlo"): guarda una lista de precios
// (Payers u Distribuidores, por trimestre) ya parseada como JSON -- {material: precio}.
//
// Por qué JSON ya parseado y no el .xlsx crudo: los 6 archivos reales de Finanzas (Payers
// Enero/Abril-Sedesa/Julio, Distribuidores Enero/Abril/Julio) NO tienen un formato 100%
// uniforme -- la fila de encabezados varía de posición, hay una columna "vfd" que aparece en
// algunos archivos y no en otros, "Sedesa Abril" tiene 2 columnas extra (Unidad venta/EA por
// BOX) que el resto no trae. Parsearlo de forma robusta significa buscar la fila que contiga
// "Material" como encabezado y la columna que empiece con "Precio", no una posición fija --
// exactamente lo que ya se hizo una vez a mano para los 6 archivos reales. Server-side en
// Vercel con una librería de xlsx sería frágil contra la próxima variación de formato que
// vaya a tener el próximo archivo trimestral (ya hubo 3 layouts distintos en 6 archivos) --
// más simple y más robusto es parsear afuera (Excel real, con quien lo esté armando al
// momento) y mandar acá sólo el resultado ya limpio: {material: precio}.
//
// Uso (reusable para el próximo trimestre, o para corregir un trimestre viejo):
//   POST /api/listas-precios-guardar?secret=<MAINTENANCE_SECRET>
//   body: { tipo: 'payers'|'distribuidores', trimestre: '2026-Q1'..'2026-Q4', precios: {material: precio} }
//
// tipo -- ver comentario grande en la lógica de recálculo (api/_cmv-historico-core.js):
//   'payers'        -- lista Sedesa Payer, usada como costo para ventas a OOSS (Grupo de
//                       Clientes "OOSS", ver api/actualizar-customer-grupos.js).
//   'distribuidores' -- lista de precios floor de distribuidores, usada como costo para
//                       ventas a instituciones (Grupo de Clientes "INSTITUCIÓN PRIVADA"/
//                       "INSTITUCIÓN PÚBLICA").
//   Confirmado contra los 6 archivos reales de julio: TODO material de Payers también está
//   en Distribuidores (mismo catálogo J&J, Distribuidores es el catálogo completo ~793
//   materiales, Payers es un subconjunto de ~100 con precio especial negociado por OOSS) --
//   Payers, cuando exista para ese material, es más específico y gana.
const { put, head } = require('@vercel/blob');

function blobPathname(tipo, trimestre) {
  return `lista_precios_${tipo}_${trimestre}.json`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'https://' + req.headers.host);
    const secret = url.searchParams.get('secret');
    if (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET) {
      res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Sólo POST.' });
      return;
    }

    const body = req.body || {};
    const { tipo, trimestre, precios } = body;
    if (tipo !== 'payers' && tipo !== 'distribuidores') {
      res.status(400).json({ ok: false, error: 'tipo debe ser "payers" o "distribuidores".' });
      return;
    }
    if (!/^20\d{2}-Q[1-4]$/.test(trimestre || '')) {
      res.status(400).json({ ok: false, error: 'trimestre debe tener el formato "2026-Q1".' });
      return;
    }
    if (!precios || typeof precios !== 'object' || Array.isArray(precios)) {
      res.status(400).json({ ok: false, error: 'precios debe ser un objeto {material: precio}.' });
      return;
    }
    const entradas = Object.entries(precios);
    if (!entradas.length) {
      res.status(400).json({ ok: false, error: 'precios está vacío.' });
      return;
    }
    for (const [material, precio] of entradas) {
      if (typeof precio !== 'number' || !(precio >= 0)) {
        res.status(400).json({ ok: false, error: `Precio inválido para material "${material}": ${precio}` });
        return;
      }
    }

    const pathname = blobPathname(tipo, trimestre);
    const payload = {
      tipo,
      trimestre,
      cantidadMateriales: entradas.length,
      updatedAt: new Date().toISOString(),
      precios,
    };
    await put(pathname, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      allowOverwrite: true,
    });

    // Mantiene un índice liviano de qué trimestres/tipos hay cargados -- así el cliente
    // (o el propio recálculo) puede listar lo disponible sin tener que adivinar nombres de
    // blob ni pedir uno por uno "a ciegas".
    let indice = { listas: [] };
    try {
      const info = await head('listas_precios_indice.json');
      const r = await fetch(info.url);
      if (r.ok) indice = await r.json();
    } catch (e) { /* todavía no existe -- arranca vacío */ }
    indice.listas = (indice.listas || []).filter((l) => !(l.tipo === tipo && l.trimestre === trimestre));
    indice.listas.push({ tipo, trimestre, cantidadMateriales: entradas.length, updatedAt: payload.updatedAt });
    indice.listas.sort((a, b) => a.trimestre.localeCompare(b.trimestre) || a.tipo.localeCompare(b.tipo));
    await put('listas_precios_indice.json', JSON.stringify(indice), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      allowOverwrite: true,
    });

    res.status(200).json({ ok: true, tipo, trimestre, cantidadMateriales: entradas.length });
  } catch (e) {
    console.error('listas-precios-guardar error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
