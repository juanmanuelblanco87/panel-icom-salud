// api/exhibiciones-imagen.js
//
// Sube la foto de un espacio de exhibición a Vercel Blob y devuelve la URL
// pública -- después, el cliente guarda esa URL en el campo IMAGEN_URL del
// espacio llamando a api/exhibiciones-guardar.js (action: 'upsertEspacio').
// Separado en 2 pasos (subir imagen / guardar referencia) a propósito, para
// que cada endpoint haga UNA sola cosa, igual criterio que el resto de las
// funciones de este proyecto.
//
// El cliente redimensiona/comprime la imagen (canvas, max ~1600px, JPEG
// ~0.8) ANTES de mandarla acá -- igual se pone un tope server-side (8MB
// decodificados) por las dudas.
const { put } = require('@vercel/blob');

const MAX_BYTES = 8 * 1024 * 1024;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Método no soportado, usar POST.' }); return; }

  try {
    const { idEspacio, dataUrl } = req.body || {};
    if (!idEspacio || !dataUrl || typeof dataUrl !== 'string') {
      res.status(400).json({ ok: false, error: 'body debe traer {idEspacio, dataUrl}' });
      return;
    }
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
    if (!m) {
      res.status(400).json({ ok: false, error: 'dataUrl debe ser una imagen JPEG/PNG/WEBP en base64.' });
      return;
    }
    const contentType = m[1];
    const buffer = Buffer.from(m[2], 'base64');
    if (buffer.length > MAX_BYTES) {
      res.status(413).json({ ok: false, error: 'La imagen supera el máximo de 8MB.' });
      return;
    }
    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    const idSeguro = String(idEspacio).replace(/[^a-zA-Z0-9_-]/g, '');
    const pathname = 'exhibiciones/imagenes/' + idSeguro + '-' + Date.now() + '.' + ext;

    const blob = await put(pathname, buffer, {
      access: 'public', addRandomSuffix: false, contentType,
    });

    res.status(200).json({ ok: true, url: blob.url });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
