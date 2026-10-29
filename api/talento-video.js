// api/talento-video.js
//
// Subida de VIDEOS para el Muro de Talento (08/10/2026, "en el Muro: poder poner videos").
//
// Por qué por trozos: una función de Vercel no recibe más de ~4,5 MB por pedido y un video pesa mucho más. El navegador corta el archivo en trozos de ~3 MB
// (cada uno viaja en base64 dentro de un JSON, ~4 MB), este endpoint los guarda sueltos en Vercel Blob y, al final, los junta en UN solo archivo
// (servidor -> Blob no tiene ese límite) y devuelve su URL. El post guarda sólo esa URL (ver validarVideoPost en api/talento-guardar.js).
//
// Autenticación: misma sesión firmada que el resto de Talento (requerirSesion) y mismo permiso que publicar en el Muro (puedeEditarMuro).
// Autenticación contra Vercel Blob: sin token explícito (OIDC), igual que el resto de los endpoints que usan @vercel/blob.
//
// Acciones (POST JSON):
//   { accion:'parte',     uploadId, n, data }               -> guarda el trozo n (data = base64)
//   { accion:'finalizar', uploadId, partes, tipo }          -> junta los trozos 0..partes-1 y devuelve { ok, url }
const { put, head, del } = require('@vercel/blob');
const { requerirSesion, puedeEditarMuro } = require('./_talento-auth');

const MAX_PARTES = 26;                     // 26 x 3 MB = 78 MB como tope por video
const MAX_BYTES_PARTE = 3500000;           // tope por trozo (el cliente manda 3.000.000)
const TIPOS = { 'video/mp4': 'mp4', 'video/quicktime': 'mp4', 'video/webm': 'webm' };   // .mov de iPhone (H.264) se sirve como mp4
const ID_RE = /^[a-z0-9]{8,40}$/;

function pathParte(uploadId, n) { return 'talento-videos-tmp/' + uploadId + '/' + n; }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Método no soportado, usar POST.' }); return; }
  try {
    const solicitante = requerirSesion(req);
    if (!solicitante) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' }); return; }
    // 15/10/2026 ("el chat no permite agregar videos"): el chat interno también sube videos por acá (ambito:'chat'); para el Muro sigue valiendo el permiso de publicar.
    const esChat = (req.body || {}).ambito === 'chat';
    if (!esChat && !puedeEditarMuro(solicitante)) { res.status(403).json({ ok: false, error: 'No tenés permiso para publicar en el Muro.' }); return; }
    const { accion, uploadId } = req.body || {};
    if (!ID_RE.test(String(uploadId || ''))) { res.status(400).json({ ok: false, error: 'uploadId inválido.' }); return; }

    if (accion === 'parte') {
      const n = Number(req.body.n);
      if (!Number.isInteger(n) || n < 0 || n >= MAX_PARTES) { res.status(400).json({ ok: false, error: 'El video es demasiado largo/pesado (máximo ~75 MB).' }); return; }
      const buf = Buffer.from(String(req.body.data || ''), 'base64');
      if (!buf.length || buf.length > MAX_BYTES_PARTE) { res.status(400).json({ ok: false, error: 'Trozo inválido.' }); return; }
      await put(pathParte(uploadId, n), buf, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/octet-stream' });
      res.status(200).json({ ok: true, n });
      return;
    }

    if (accion === 'finalizar') {
      const partes = Number(req.body.partes);
      const ext = TIPOS[String(req.body.tipo || '').toLowerCase()];
      if (!ext) { res.status(400).json({ ok: false, error: 'Formato no soportado: usá MP4 (o MOV de iPhone / WebM).' }); return; }
      if (!Number.isInteger(partes) || partes < 1 || partes > MAX_PARTES) { res.status(400).json({ ok: false, error: 'Cantidad de trozos inválida.' }); return; }
      const bufs = [];
      for (let n = 0; n < partes; n++) {
        let info;
        try { info = await head(pathParte(uploadId, n)); } catch (e) { res.status(400).json({ ok: false, error: 'Falta el trozo ' + n + ' -- reintentá la subida.' }); return; }
        const r = await fetch(info.url);
        if (!r.ok) { res.status(502).json({ ok: false, error: 'No se pudo leer el trozo ' + n + '.' }); return; }
        bufs.push(Buffer.from(await r.arrayBuffer()));
      }
      const total = Buffer.concat(bufs);
      const contentType = ext === 'webm' ? 'video/webm' : 'video/mp4';
      const sube = await put('talento-videos/video.' + ext, total, { access: 'public', addRandomSuffix: true, contentType });
      // limpieza de los trozos (si algo falla no importa: son temporales)
      try { await del(Array.from({ length: partes }, (_, n) => pathParte(uploadId, n))); } catch (e) { /* no crítico */ }
      res.status(200).json({ ok: true, url: sube.url, bytes: total.length });
      return;
    }

    res.status(400).json({ ok: false, error: 'accion desconocida.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
