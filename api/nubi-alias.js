// api/nubi-alias.js
//
// 22/10/2026 -- nombres reales de vendedores de Nubimetrics (ver api/_nubi-alias-store.js y _nubi-identificar.js).
//   GET  ?accion=nombres                       -> { ok, nombres }                  (cualquier sesión; la app lo usa para mostrar los nombres)
//   GET  ?accion=lista[&limite=300]            -> { ok, resumen, items }           (cualquier sesión: lista de vendedores sin nombre con su sugerencia)
//   POST { accion:'guardar', k, nombre, fuente } | { accion:'quitar', k } | { accion:'ignorar', k, quitar? }
//   POST { accion:'identificar' }              -> corre el motor sobre los pendientes (un tramo de ~70 s; la app vuelve a llamar mientras queden)
//   POST { accion:'fichas' }                   -> rearma las fichas desde el archivo crudo
// Escribir o correr el motor: sólo Gerencia y RR.HH. (admin / gerente), igual que el botón Actualizar de la app.
const { requerirSesion } = require('./_talento-auth');
const { leerAlias, guardarNombre, quitarNombre, ignorarVendedor, armarLista, identificarPendientes } = require('./_nubi-alias-store');
const { construirFichas } = require('./_nubi-fichas');

const ROLES_ESCRIBIR = ['admin', 'gerente'];

async function leerCuerpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const s = requerirSesion(req);
  if (!s) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' }); return; }
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET') {
      const accion = url.searchParams.get('accion') || 'nombres';
      if (accion === 'nombres') { const a = await leerAlias(); res.status(200).json({ ok: true, nombres: a.nombres }); return; }
      if (accion === 'lista') {
        const limite = Math.max(10, Math.min(1000, Number(url.searchParams.get('limite')) || 300));
        res.status(200).json(await armarLista({ limite, incluirIgnorados: url.searchParams.get('ignorados') === '1' }));
        return;
      }
      res.status(400).json({ ok: false, error: 'Acción inválida.' });
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Método no soportado.' }); return; }
    if (!ROLES_ESCRIBIR.includes(s.rol)) { res.status(403).json({ ok: false, error: 'Sólo Gerencia y RR.HH. pueden identificar vendedores.' }); return; }
    const b = await leerCuerpo(req);
    const por = s.nombre || s.usuario || '';
    if (b.accion === 'guardar') { res.status(200).json(await guardarNombre({ k: b.k, nombre: b.nombre, fuente: b.fuente, por })); return; }
    if (b.accion === 'quitar') { res.status(200).json(await quitarNombre({ k: b.k })); return; }
    if (b.accion === 'ignorar') { res.status(200).json(await ignorarVendedor({ k: b.k, quitar: !!b.quitar })); return; }
    if (b.accion === 'identificar') { res.status(200).json(await identificarPendientes({ presupuestoMs: 70000, rehacer: !!b.rehacer })); return; }
    if (b.accion === 'fichas') {
      const r = await construirFichas({ presupuestoMs: 100000 });
      res.status(200).json(r || { ok: false, error: 'No alcanzó el tiempo; reintentá.' });
      return;
    }
    res.status(400).json({ ok: false, error: 'Acción inválida.' });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
};
