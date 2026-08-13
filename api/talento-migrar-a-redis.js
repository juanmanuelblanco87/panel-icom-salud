// api/talento-migrar-a-redis.js
//
// Gestión de Talento (13/08/2026) -- script de UNA sola corrida para
// copiar lo que ya estaba guardado en Vercel Blob (talento/personas.json,
// talento/usuarios.json, talento/objetivos.json) hacia el nuevo
// almacenamiento en Upstash Redis (ver _talento-store.js). Después de
// correrlo una vez no hace falta volver a tocarlo -- se deja en el repo
// como referencia, mismo criterio que exhibiciones-seed-inicial.js.
//
// GET ?accion=migrar&secret=... -> lee los 3 blobs viejos y escribe cada
// registro en Redis con guardarPersona/guardarUsuario/guardarObjetivo.
// Protegido con MAINTENANCE_SECRET (mismo patrón que talento-login.js) y
// a propósito es GET, no POST -- mismo motivo ya documentado ahí (esta
// sesión de Claude sólo puede hacer pedidos de sólo lectura a hosts
// arbitrarios, así que la única forma de dispararlo desde acá es un GET).
// Idempotente: usa guardarX (upsert por id/usuario), correrlo de nuevo
// no duplica nada, sólo vuelve a escribir los mismos valores.
const { get } = require('@vercel/blob');
const { guardarPersona, guardarUsuario, guardarObjetivo } = require('./_talento-store');

async function leerBlobJsonViejo(pathname) {
  try {
    const result = await get(pathname, { access: 'public', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Método no soportado, usar GET.' });
    return;
  }
  try {
    const url = new URL(req.url, 'https://' + req.headers.host);
    if (url.searchParams.get('accion') !== 'migrar') {
      res.status(400).json({ ok: false, error: 'Usar ?accion=migrar&secret=...' });
      return;
    }
    const secret = url.searchParams.get('secret');
    if (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET) {
      res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
      return;
    }

    const [dataPersonas, dataUsuarios, dataObjetivos] = await Promise.all([
      leerBlobJsonViejo('talento/personas.json'),
      leerBlobJsonViejo('talento/usuarios.json'),
      leerBlobJsonViejo('talento/objetivos.json'),
    ]);
    const personas = (dataPersonas && dataPersonas.personas) || [];
    const usuarios = (dataUsuarios && dataUsuarios.usuarios) || [];
    const objetivos = (dataObjetivos && dataObjetivos.objetivos) || [];

    await Promise.all(personas.map(p => guardarPersona(p)));
    await Promise.all(usuarios.map(u => guardarUsuario(u)));
    await Promise.all(objetivos.map(o => guardarObjetivo(o)));

    res.status(200).json({
      ok: true,
      migrado: { personas: personas.length, usuarios: usuarios.length, objetivos: objetivos.length },
      nombres: personas.map(p => p.nombre),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
