// api/anio-pasado-liviano.js
//
// Foto del AÑO PASADO (ya cerrado, no cambia) en formato liviano, para que el Dashboard compare contra el año pasado
// CON filtros (Proveedor/Subgrupo en Cirugía General, Vendedor en Movilidad, Visitador en Cirugía Estética) sin esperar.
//
// 08/10/2026 ("hace 20 minutos que está calculando el año pasado cuando aplico filtros"): el cliente tenía que pedirle a Oppen,
// uno por uno y en cada dispositivo, los 12 meses del año pasado (unos 20 s cada uno, y se cortaba si Oppen limitaba). Acá se
// arma UNA vez en el servidor y se guarda en Vercel Blob; el panel lo lee en un solo pedido (instantáneo).
//
// Contenido por mes ("MM"):
//   gen  = { sku: neto }  Cirugía General (el Proveedor/Subgrupo se sacan del SKU en el cliente, igual que el año en curso)
//   vend = { movilidad|cirugia_estetica: { "vendedorInstitucion\u0001vendedorCliente": neto } }
// (sale de /api/oppen-invoices?soloUnidadNegocio=1: bySkuUnidadNegocio.cirugia_general y byVendedores).
//
// Modos:
//   GET                                  -> devuelve la foto tal cual (público, sólo lectura, caché de borde 1 h)
//   GET con Authorization: Bearer CRON_SECRET  (cron diario) o ?secret=MAINTENANCE_SECRET  -> completa los meses que falten del año
//        pasado (de a uno, dentro del tiempo disponible) y guarda; cuando cambia el año arma el nuevo solo. Si ya está completa no hace nada.
const { put, head } = require('@vercel/blob');

const BLOB_PATHNAME = 'anio_pasado_liviano.json';
const PRESUPUESTO_MS = 120000;   // maxDuration 150 (ver vercel.json)

async function leerBlob() {
  try {
    const info = await head(BLOB_PATHNAME);
    const r = await fetch(info.url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    return null;
  }
}

function aLiviano(data) {
  const gen = {};
  Object.entries(data.bySkuUnidadNegocio || {}).forEach(([sku, pu]) => {
    const v = pu && pu.cirugia_general && pu.cirugia_general.totalNeto;
    if (v) gen[sku] = v;
  });
  return { gen, vend: data.byVendedores || {} };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const url = new URL(req.url, 'https://' + req.headers.host);
    const authHeader = req.headers['authorization'] || '';
    const esCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
    const esMantenimiento = !!process.env.MAINTENANCE_SECRET && url.searchParams.get('secret') === process.env.MAINTENANCE_SECRET;

    const esBuild = url.searchParams.get('build') === '1';   // autosanado público: sólo completa meses que faltan, con candado (ver abajo)
    if (!esCron && !esMantenimiento && !esBuild) {   // lectura pública
      const actual = await leerBlob();
      res.setHeader('Cache-Control', actual ? 'public, s-maxage=3600, stale-while-revalidate=86400' : 'no-store');
      res.status(200).json(actual || { year: null, months: {} });
      return;
    }

    const inicio = Date.now();
    const year = new Date().getFullYear() - 1;
    let actual = await leerBlob();
    if (!actual || actual.year !== year) actual = { year, generatedAt: null, months: {} };

    // candado: un build público a la vez (sin él, repetir la URL dispararía pedidos a Oppen en paralelo); cron y mantenimiento lo ignoran
    if (esBuild && !esCron && !esMantenimiento && actual.lockUntil && actual.lockUntil > Date.now()) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, ocupado: true, meses: Object.keys(actual.months).length });
      return;
    }
    if (Object.keys(actual.months).length < 12) { actual.lockUntil = Date.now() + 140000; await put(BLOB_PATHNAME, JSON.stringify(actual), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true }); }
    const base = 'https://' + req.headers.host;
    const hechos = [], fallidos = [];
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      if (actual.months[mm]) continue;
      if (Date.now() - inicio > PRESUPUESTO_MS - 35000) break;   // un mes tarda ~20 s: no arrancar otro si no entra
      const from = year + '-' + mm + '-01';
      const to = year + '-' + mm + '-' + String(new Date(year, m, 0).getDate()).padStart(2, '0');
      try {
        const r = await fetch(`${base}/api/oppen-invoices?from=${from}&to=${to}&soloUnidadNegocio=1&vend=1`, { signal: AbortSignal.timeout(60000) });
        const data = await r.json();
        if (!r.ok || !data || !data.ok || !data.byVendedores) throw new Error((data && data.error) || ('HTTP ' + r.status));
        actual.months[mm] = aLiviano(data);
        hechos.push(mm);
        actual.generatedAt = new Date().toISOString();
        await put(BLOB_PATHNAME, JSON.stringify(actual), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true });
      } catch (e) {
        fallidos.push(mm + ': ' + String(e.message || e).slice(0, 120));
        if (/limitando|429/i.test(String(e.message || e))) break;   // Oppen está saturado: no insistir con los demás meses (se completan en la próxima pasada / cron)
      }
    }
    if (actual.lockUntil) { delete actual.lockUntil; try { await put(BLOB_PATHNAME, JSON.stringify(actual), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true }); } catch (e) {} }
    res.setHeader('Cache-Control', 'no-store');
    const faltan = [];
    for (let m = 1; m <= 12; m++) { const mm = String(m).padStart(2, '0'); if (!actual.months[mm]) faltan.push(mm); }
    res.status(200).json({ ok: true, year, agregados: hechos, fallidos, faltan, completo: faltan.length === 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
