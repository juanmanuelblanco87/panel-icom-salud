// api/talento-link-preview.js
//
// Vista previa de un link para el Muro de Talento (09/10/2026, "agrega para poder sumar un link directamente, incluso embebe YouTube, Meta, etc").
// GET ?url=https://... -> { ok, url, titulo, descripcion, imagen, sitio } sacado de las etiquetas Open Graph / <title> de la página.
//
// Seguridad (el servidor hace un pedido a una dirección que elige el usuario, así que se cuida):
//   - requiere sesión de Talento y permiso para publicar en el Muro (mismo criterio que subir videos)
//   - sólo http/https, sin usuario:clave, y el nombre se resuelve ANTES: si apunta a una IP privada / loopback / link-local se rechaza (también en cada redirección, máx. 3)
//   - tiempo máximo 6 s, se leen como mucho 400 KB y sólo si es HTML
const dns = require('dns').promises;
const net = require('net');
const { requerirSesion, puedeEditarMuro } = require('./_talento-auth');

function ipPrivada(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const t = ip.toLowerCase();
    return t === '::1' || t === '::' || t.startsWith('fc') || t.startsWith('fd') || t.startsWith('fe8') || t.startsWith('fe9') || t.startsWith('fea') || t.startsWith('feb') || t.startsWith('::ffff:');
  }
  return true;
}
async function urlSegura(u) {
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (net.isIP(host)) return !ipPrivada(host);
  try {
    const dirs = await dns.lookup(host, { all: true });
    return dirs.length > 0 && dirs.every(d => !ipPrivada(d.address));
  } catch (e) { return false; }
}
function decodificar(t) {
  return String(t || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch (e) { return ''; } }).replace(/\s+/g, ' ').trim();
}
function meta(html, nombres) {
  for (const n of nombres) {
    const re1 = new RegExp('<meta[^>]+(?:property|name)=["\']' + n + '["\'][^>]*content=["\']([^"\']*)["\']', 'i');
    const re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + n + '["\']', 'i');
    const m = html.match(re1) || html.match(re2);
    if (m && m[1]) return decodificar(m[1]);
  }
  return '';
}

// 09/10/2026 ("no se adapta el formato"): YouTube sirve los Shorts (verticales) también como videos comunes; la forma confiable de distinguirlos es pedir youtube.com/shorts/ID:
// si responde 200 es un Short; si redirige a /watch es un video horizontal. Host fijo (youtube.com), no depende de la dirección que mande el usuario.
async function esShortYT(id) {
  if (!/^[\w-]{6,20}$/.test(String(id || ''))) return false;
  try {
    const r = await fetch('https://www.youtube.com/shorts/' + id, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ICOMLinkPreview/1.0)' } });
    return r.status === 200;
  } catch (e) { return false; }
}
function idYouTube(u) {
  const h = u.hostname.replace(/^(www|m|music)\./, '');
  if (h === 'youtu.be') return u.pathname.slice(1).split('/')[0];
  if (h === 'youtube.com') { if (u.pathname === '/watch') return u.searchParams.get('v'); const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,20})/); return m ? m[2] : null; }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  if (!solicitante) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida.' }); return; }
  // ?yt=ID: cualquier persona con sesión puede preguntar si un video de YouTube del Muro es vertical (para mostrarlo bien); la vista previa de links sólo la usa quien publica
  if (req.query && req.query.yt) {
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.status(200).json({ ok: true, vertical: await esShortYT(req.query.yt) });
    return;
  }
  if (!puedeEditarMuro(solicitante)) { res.status(403).json({ ok: false, error: 'No tenés permiso para publicar en el Muro.' }); return; }
  try {
    let u;
    try { u = new URL(String(req.query.url || new URL(req.url, 'http://x').searchParams.get('url') || '')); } catch (e) { res.status(400).json({ ok: false, error: 'El link no es válido.' }); return; }
    let html = '', finalUrl = u;
    for (let salto = 0; salto < 4; salto++) {
      if (!(await urlSegura(finalUrl))) { res.status(400).json({ ok: false, error: 'No se puede abrir ese link.' }); return; }
      const r = await fetch(finalUrl.href, {
        redirect: 'manual', signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ICOMLinkPreview/1.0)', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'es-AR,es;q=0.9,en;q=0.5' },
      });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { finalUrl = new URL(r.headers.get('location'), finalUrl); continue; }
      if (!r.ok) { res.status(200).json({ ok: true, url: finalUrl.href, titulo: '', descripcion: '', imagen: '', sitio: finalUrl.hostname.replace(/^www\./, '') }); return; }
      const tipo = String(r.headers.get('content-type') || '');
      if (!/text\/html|application\/xhtml/i.test(tipo)) { res.status(200).json({ ok: true, url: finalUrl.href, titulo: '', descripcion: '', imagen: '', sitio: finalUrl.hostname.replace(/^www\./, '') }); return; }
      const reader = r.body.getReader(); const partes = []; let bytes = 0;
      while (bytes < 400000) { const { done, value } = await reader.read(); if (done) break; partes.push(Buffer.from(value)); bytes += value.length; if (/<\/head>/i.test(Buffer.concat(partes).toString('utf8').slice(-2000))) break; }
      try { reader.cancel(); } catch (e) { /* ya terminó */ }
      html = Buffer.concat(partes).toString('utf8');
      break;
    }
    const titulo = meta(html, ['og:title', 'twitter:title']) || decodificar((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    const descripcion = meta(html, ['og:description', 'twitter:description', 'description']);
    let imagen = meta(html, ['og:image', 'og:image:url', 'twitter:image']);
    if (imagen) { try { const iu = new URL(imagen, finalUrl); imagen = iu.protocol === 'https:' ? iu.href : ''; } catch (e) { imagen = ''; } }
    const sitio = meta(html, ['og:site_name']) || finalUrl.hostname.replace(/^www\./, '');
    const ytId = idYouTube(finalUrl);
    res.status(200).json({ ok: true, url: finalUrl.href, titulo: titulo.slice(0, 200), descripcion: descripcion.slice(0, 300), imagen: imagen.slice(0, 500), sitio: sitio.slice(0, 80), vertical: ytId ? await esShortYT(ytId) : false });
  } catch (e) {
    res.status(200).json({ ok: true, url: String(req.query.url || ''), titulo: '', descripcion: '', imagen: '', sitio: '', aviso: 'No se pudo leer la página.' });
  }
};
