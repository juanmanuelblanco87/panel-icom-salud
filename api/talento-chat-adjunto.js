// api/talento-chat-adjunto.js
//
// Imágenes del CHAT interno de Gestión de Talento (15/10/2026, "pegar una captura de pantalla de manera simple"). El navegador comprime la imagen (lado largo 1280 px, JPEG) y la manda acá como data URL;
// se guarda en Vercel Blob (carpeta talento-chat/) y se devuelve la URL pública (no listada). El mensaje guarda sólo esa URL -- así el chat no arrastra imágenes en base64 en cada actualización.
// Autenticación: cualquier sesión válida de Talento (el chat es para todos los roles).
const { put } = require('@vercel/blob');
const { requerirSesion } = require('./_talento-auth');

const MAX_CHARS = 2400000;   // ~1,8 MB reales en base64 (el pedido entero no puede pasar de ~4,5 MB en Vercel)
const RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Método no soportado, usar POST.' }); return; }
  try {
    const solicitante = requerirSesion(req);
    if (!solicitante) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' }); return; }
    const data = String((req.body || {}).data || '');
    if (data.length > MAX_CHARS) { res.status(400).json({ ok: false, error: 'La imagen es demasiado pesada -- probá con una captura más chica.' }); return; }
    const m = data.match(RE);
    if (!m) { res.status(400).json({ ok: false, error: 'El archivo no es una imagen válida (JPG, PNG o WebP).' }); return; }
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) { res.status(400).json({ ok: false, error: 'La imagen está vacía.' }); return; }
    const sube = await put('talento-chat/img.' + ext, buf, { access: 'public', addRandomSuffix: true, contentType: 'image/' + m[1] });
    res.status(200).json({ ok: true, url: sube.url });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
