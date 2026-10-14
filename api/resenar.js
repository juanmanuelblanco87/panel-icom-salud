// api/resenar.js
//
// 02/10/2026 (Juan Manuel: "armar un Reseñador con QR para las sucursales... que el entorno sea
// 100% ICOM... mobile first"): página pública y liviana a la que lleva el QR de cada sucursal
// (/r/central, /r/prosalud, /r/jcp -- ver rewrites en vercel.json). Muestra la marca de ICOM y UN
// botón que abre directo la ventana de reseña de Google de ese local
// (search.google.com/local/writereview?placeid=...). Google pide el login con la cuenta del
// cliente ahí mismo y la reseña la publica el cliente: no existe ninguna API para crear reseñas
// de terceros, y publicar "en nombre" del cliente va contra la política de Google.
//
// Por política de Google NO se filtra ni se condiciona quién llega al botón (sin "¿cómo te fue?"
// previo que desvíe a los disconformes) ni se ofrece nada a cambio de la reseña.
//
// Contador: guarda, por día y sucursal, cuántas veces se abrió la página (v) y cuántas veces se
// tocó el botón (c) en el blob resenas_qr_stats.json. GET /api/resenar?stats=1 devuelve esos
// números (sólo conteos, sin datos personales) para el panel de Sucursales.
const { get, put } = require('@vercel/blob');

const BLOB_PLACE_IDS = 'google_place_ids_v2.json';
const BLOB_STATS = 'resenas_qr_stats.json';
// Links "Pedir reseñas" de Google Business Profile (g.page/r/.../review), copiados del perfil por el
// administrador. Google los resuelve al mismo writereview?placeid=... pero con parámetros de
// "solicitud de reseña", que en el celular abren la ventana de reseña directo (y en la app de Maps
// si está instalada). Si un local no tiene link cargado acá se usa el writereview con su Place ID.
const LINKS_PEDIR_RESENA = {
  central: 'https://g.page/r/CRKxf8vNdwsMEBM/review', // recibido 05/10/2026
  // prosalud: pendiente
  // jcp: pendiente
};
const SUCURSALES = {
  central:  { value: 'ICOM',      nombre: 'Icom Central',  dir: 'Av. Pte. J. D. Perón 2348, San Miguel', tel: '(011) 4664-2984' },
  prosalud: { value: 'PRO SALUD', nombre: 'Icom Prosalud', dir: 'Av. Pte. J. D. Perón 1801, San Miguel', tel: '' },
  jcp:      { value: 'JCP',       nombre: 'Icom JCP',      dir: 'Roque Sáenz Peña 4999, José C. Paz',    tel: '' },
};

async function leerBlob(pathname) {
  try {
    const r = await get(pathname, { access: 'public', useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return JSON.parse(await new Response(r.stream).text());
  } catch (e) { return null; }
}

// Enlace OFICIAL de Google Maps para "escribir una reseña" (writeAReviewUri de Places API (New)): abre
// la app de Maps (con la sesión del celular) directo en el formulario de reseña. Probado por el usuario
// en iPhone el 05/10/2026 (variante H de /r/prueba). Se pide en vivo y se guarda en memoria 24 h por
// instancia (no se archiva). Si falla, devuelve null y la página usa el enlace de reseña del navegador.
const cacheMapsResena = new Map();
async function urlResenaMaps(placeId) {
  const hit = cacheMapsResena.get(placeId);
  if (hit && Date.now() - hit.t < 24 * 3600 * 1000) return hit.url;
  try {
    const key = process.env.GOOGLE_PLACES_API_KEY;
    if (!key) return null;
    const r = await fetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId) + '?languageCode=es', {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'googleMapsLinks.writeAReviewUri' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const url = j && j.googleMapsLinks && j.googleMapsLinks.writeAReviewUri;
    if (url) { cacheMapsResena.set(placeId, { t: Date.now(), url }); return url; }
  } catch (e) { /* cae al enlace del navegador */ }
  return null;
}

function hoyAR() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }

async function sumar(slug, campo) {
  try {
    const st = (await leerBlob(BLOB_STATS)) || { dias: {} };
    st.dias = st.dias || {};
    const d = hoyAR();
    st.dias[d] = st.dias[d] || {};
    st.dias[d][slug] = st.dias[d][slug] || { v: 0, c: 0, b: 0 };
    st.dias[d][slug][campo] = (st.dias[d][slug][campo] || 0) + 1;
    await put(BLOB_STATS, JSON.stringify(st), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true, cacheControlMaxAge: 60 });
  } catch (e) { console.error('resenar: no se pudo contar:', e.message); }
}

function pagina(slug, s, urlGoogle, opts) {
  opts = opts || {};
  const tel = s.tel ? ` · <a href="tel:${s.tel.replace(/[^0-9+]/g, '')}">${s.tel}</a>` : '';
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#007067">
<title>Tu opinión · ${s.nombre}</title>
<style>
:root{--navy:#007067;--navy-d:#005a52;--soft:#E6F2F1;--ink:#222;--ink2:#555;--line:#e0dfd8;--star:#f5a623}
*{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:#fff;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column}
header{padding:22px 20px 0;display:flex;justify-content:center}
header img{width:min(220px,62vw);height:auto;display:block;mix-blend-mode:multiply}
main{flex:1;display:flex;flex-direction:column;justify-content:center;gap:20px;padding:20px 22px 12px;max-width:480px;width:100%;margin:0 auto;text-align:center}
.sucursal{display:inline-block;align-self:center;background:var(--soft);color:var(--navy);font-weight:700;font-size:13px;letter-spacing:.04em;text-transform:uppercase;padding:6px 14px;border-radius:999px}
h1{font-size:clamp(26px,7.4vw,34px);line-height:1.15;color:var(--navy);text-wrap:balance}
.lead{font-size:17px;line-height:1.5;color:var(--ink2);text-wrap:balance}
.stars{font-size:34px;letter-spacing:6px;color:var(--star);line-height:1}
.cta{display:block;background:var(--navy);color:#fff;text-decoration:none;font-weight:700;font-size:19px;padding:18px 20px;border-radius:14px;box-shadow:0 6px 18px rgba(0,112,103,.28);transition:transform .08s,background .15s}
.cta:active{transform:scale(.98);background:var(--navy-d)}
.cta:focus-visible{outline:3px solid #eb6834;outline-offset:3px}
ol{list-style:none;padding:0;display:grid;gap:10px;text-align:left}
ol li{display:flex;gap:12px;align-items:flex-start;font-size:15px;line-height:1.4;color:var(--ink2)}
ol b{flex:none;width:26px;height:26px;border-radius:50%;background:var(--soft);color:var(--navy);display:grid;place-items:center;font-size:13px}
.nota{font-size:13px;color:#777;line-height:1.45}
#gracias{display:none;text-align:center}
#gracias h1{margin-bottom:12px}
#gracias .again{display:inline-block;margin-top:18px;font-size:14px;color:var(--navy);text-decoration:underline;background:none;border:0;cursor:pointer}
.alt{display:block;font-size:14px;color:var(--navy);text-align:center;text-decoration:underline;margin-top:-6px}
footer{padding:14px 20px calc(18px + env(safe-area-inset-bottom));text-align:center;font-size:13px;color:#777;border-top:1px solid var(--line);margin-top:10px}
footer a{color:inherit}
@media (prefers-reduced-motion:reduce){.cta{transition:none}}
</style></head>
<body>
<header><img src="/email-assets/logo-icomsalud.jpg" alt="ICOM Salud" width="220" height="48"></header>
<main id="gracias" aria-live="polite">
  <div class="stars" aria-hidden="true">★★★★★</div>
  <h1>¡Gracias por tu opinión!</h1>
  <p class="lead">Nos ayuda a seguir mejorando y a que más personas nos encuentren en ${s.nombre}.</p>
  <button class="again" id="again" type="button">Todavía no la publiqué: volver a intentar</button>
</main>
<main id="principal">
  <span class="sucursal">${s.nombre}</span>
  <h1>¿Cómo fue tu experiencia con nosotros?</h1>
  <p class="lead">Tu opinión nos ayuda a seguir mejorando y a que más personas nos encuentren.</p>
  <div class="stars" aria-hidden="true">★★★★★</div>
  <a class="cta" id="cta" href="${urlGoogle}" rel="noopener">Dejar mi reseña en Google</a>
  ${opts.alt ? `<a class="alt" id="alt" href="${opts.alt}" rel="noopener">¿No se abre Maps? Dejar la reseña desde el navegador</a>` : ''}
  <ol>
    ${opts.maps
      ? `<li><b>1</b><span>Tocá el botón: se abre Google Maps con la reseña de ${s.nombre}.</span></li>
    <li><b>2</b><span>Elegí las estrellas y, si querés, contanos con tus palabras.</span></li>
    <li><b>3</b><span>Tocá <strong>Publicar</strong>.</span></li>`
      : `<li><b>1</b><span>Tocá el botón de arriba.</span></li>
    <li><b>2</b><span>Iniciá sesión con tu cuenta de Google, si te lo pide.</span></li>
    <li><b>3</b><span>Elegí las estrellas y, si querés, contanos con tus palabras.</span></li>`}
  </ol>
  <p class="nota">La reseña la publicás vos en Google. Toma menos de un minuto. ¡Gracias por elegirnos!</p>
</main>
<footer>${s.dir}${tel}</footer>
<script>
var salio=0,mostrada=0;
['cta','alt'].forEach(function(id){var el=document.getElementById(id);if(el)el.addEventListener('click',function(){
  salio=Date.now();
  try{navigator.sendBeacon('/api/resenar?s=${slug}&e=click')}catch(e){}
});});
// Google no avisa cuándo se publica la reseña ni permite "volver a esta URL": lo que sí se detecta es que
// el cliente VUELVE a esta pestaña tras salir con el botón -> se le agradece (no se confirma la publicación).
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState==='visible'&&salio&&Date.now()-salio>4000){
    document.getElementById('principal').style.display='none';
    document.getElementById('gracias').style.display='flex';
    if(!mostrada){mostrada=1;try{navigator.sendBeacon('/api/resenar?s=${slug}&e=back')}catch(e){}}
  }
});
document.getElementById('again').addEventListener('click',function(){
  salio=0;document.getElementById('gracias').style.display='none';document.getElementById('principal').style.display='flex';
});
</script>
</body></html>`;
}

module.exports = async function handler(req, res) {
  // Estadísticas para el panel
  if (req.query && req.query.stats) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const st = (await leerBlob(BLOB_STATS)) || { dias: {} };
    const desde = new Date(Date.now() - 3 * 3600 * 1000 - 29 * 86400000).toISOString().slice(0, 10);
    const out = {};
    Object.keys(SUCURSALES).forEach((k) => { out[k] = { vistas30d: 0, toques30d: 0, vueltas30d: 0, vistasTotal: 0, toquesTotal: 0 }; });
    Object.entries(st.dias || {}).forEach(([dia, porSuc]) => {
      Object.entries(porSuc).forEach(([k, v]) => {
        if (!out[k]) return;
        out[k].vistasTotal += v.v || 0; out[k].toquesTotal += v.c || 0;
        if (dia >= desde) { out[k].vistas30d += v.v || 0; out[k].toques30d += v.c || 0; out[k].vueltas30d += v.b || 0; }
      });
    });
    res.status(200).json({ ok: true, sucursales: out });
    return;
  }

  const slug = String((req.query && req.query.s) || '').toLowerCase();
  // Página de PRUEBA de enlaces (05/10/2026): botones con distintas formas de abrir la reseña de Central
  // para ver, en un celular real, cuál cae directo en las estrellas con la sesión ya iniciada. No cuenta visitas.
  if (slug === 'prueba') {
    const ids = (await leerBlob(BLOB_PLACE_IDS)) || {};
    const id = encodeURIComponent(ids['ICOM'] || '');
    const wr = 'https://search.google.com/local/writereview?placeid=' + id;
    // Enlaces oficiales que devuelve Places API (New) para este local: writeAReviewUri / reviewsUri / googleMapsUri
    let oficiales = {};
    try {
      const key = process.env.GOOGLE_PLACES_API_KEY;
      if (key && ids['ICOM']) {
        const r = await fetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(ids['ICOM']) + '?languageCode=es', {
          headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'googleMapsUri,googleMapsLinks' },
        });
        if (r.ok) oficiales = await r.json(); else oficiales = { error: 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200) };
      }
    } catch (e) { oficiales = { error: String(e.message || e) }; }
    const L = oficiales.googleMapsLinks || {};
    oficiales.writeAReviewUri = L.writeAReviewUri || oficiales.writeAReviewUri;
    oficiales.reviewsUri = L.reviewsUri || oficiales.reviewsUri;
    const V = [
      ...(oficiales.writeAReviewUri ? [['H', 'Reseña (enlace oficial de Google Maps)', 'writeAReviewUri de Places API: el enlace oficial para "escribir una reseña".', oficiales.writeAReviewUri]] : []),
      ...(oficiales.reviewsUri ? [['I', 'Opiniones (enlace oficial)', 'reviewsUri de Places API: abre la pestaña de opiniones, donde suele estar "Califica y opina" arriba.', oficiales.reviewsUri]] : []),
      ...(oficiales.googleMapsUri ? [['J', 'Ficha (enlace oficial)', 'googleMapsUri de Places API.', oficiales.googleMapsUri]] : []),
      ['A', 'Reseña en el navegador', 'El enlace de siempre (writereview). Pide login si no hay sesión en el navegador.', wr],
      ['B', 'Enlace "Pedir reseñas" de Google', 'El g.page/.../review que se usa hoy en el QR de Central.', LINKS_PEDIR_RESENA.central],
      ['C', 'Ficha del local en Maps', 'Abre la app de Maps en la ficha (la que ya probaste).', 'https://www.google.com/maps/search/?api=1&query=Ortopedia%20ICOM&query_place_id=' + id],
      ['D', 'Ficha de Maps por place_id', 'Otra forma de abrir la ficha en la app.', 'https://www.google.com/maps/place/?q=place_id:' + id],
      ['E', 'Lista de opiniones (experimental)', 'Abre las opiniones del local; en la app puede mostrar las estrellas arriba.', 'https://search.google.com/local/reviews?placeid=' + id],
      ['F', 'Reseña en la app de Maps (Android)', 'Fuerza la app de Google Maps con el enlace de reseña. Sólo Android; si no hay app, cae en A.',
        'intent://search.google.com/local/writereview?placeid=' + id + '#Intent;scheme=https;package=com.google.android.apps.maps;S.browser_fallback_url=' + encodeURIComponent(wr) + ';end'],
      ['G', 'Reseña en Chrome (iPhone)', 'Abre el enlace de reseña en Chrome, donde puede haber otra sesión iniciada. Sólo iPhone con Chrome.',
        'googlechromes://search.google.com/local/writereview?placeid=' + id],
    ];
    const items = V.map(v => '<a class="v" href="' + v[3].replace(/&/g, '&amp;') + '" rel="noopener"><b>' + v[0] + '</b><span><strong>' + v[1] + '</strong><small>' + v[2] + '</small></span></a>').join('');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send('<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Prueba de enlaces de reseña</title><style>'
      + '*{box-sizing:border-box;margin:0}body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#222;padding:20px 16px 40px;max-width:520px;margin:0 auto;background:#fff}'
      + 'h1{font-size:22px;color:#007067;margin-bottom:6px}p{font-size:15px;color:#555;line-height:1.45;margin-bottom:14px}'
      + '.v{display:flex;gap:12px;align-items:flex-start;text-decoration:none;color:inherit;border:1px solid #e0dfd8;border-radius:12px;padding:14px;margin-bottom:10px}.v:active{background:#E6F2F1}'
      + '.v b{flex:none;width:30px;height:30px;border-radius:50%;background:#007067;color:#fff;display:grid;place-items:center;font-size:15px}.v strong{display:block;font-size:16px;color:#007067}.v small{display:block;font-size:13px;color:#666;margin-top:3px;line-height:1.35}'
      + '</style></head><body><h1>Prueba de enlaces · Icom Central</h1><p>Tocá cada botón y fijate si cae <b>directo en las estrellas</b> para calificar, con tu sesión ya iniciada. Anotá la letra de los que funcionan y en qué teléfono (iPhone o Android). Esta página es solo de prueba.</p>'
      + items + (oficiales.error ? '<p style="font-size:12px;color:#c0422a">Places: ' + String(oficiales.error).replace(/</g,'&lt;') + '</p>' : '') + '<p style="font-size:12px;color:#999;margin-top:14px">Dispositivo: <span id="d"></span></p><script>document.getElementById("d").textContent=navigator.userAgent.replace(/\(.*?\)/,function(m){return m.slice(0,60)});</script></body></html>');
    return;
  }
  const s = SUCURSALES[slug];
  if (!s) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(404).send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ICOM Salud</title><body style="font-family:system-ui;text-align:center;padding:40px 20px"><h1>Este código QR no es válido</h1><p>Pedile a nuestro equipo que te dé el correcto.</p></body>');
    return;
  }

  // Toque del botón (sendBeacon): sólo se cuenta, sin respuesta
  if (req.query && (req.query.e === 'click' || req.query.e === 'back')) {
    await sumar(slug, req.query.e === 'back' ? 'b' : 'c');
    res.setHeader('Cache-Control', 'no-store');
    res.status(204).end();
    return;
  }

  const ids = (await leerBlob(BLOB_PLACE_IDS)) || {};
  const placeId = ids[s.value];
  // Sin Place ID guardado, cae a la búsqueda del local en Google Maps (no se rompe el QR impreso)
  const urlGoogle = placeId
    ? 'https://search.google.com/local/writereview?placeid=' + encodeURIComponent(placeId)
    : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(s.nombre + ' ' + s.dir);
  // PRUEBA (02/10/2026, "probemos cómo es si direccionamos a Maps"): con ?m=maps el botón abre el
  // local en la APP de Google Maps (que casi siempre ya tiene la cuenta iniciada, sin pedir login) en
  // vez de la ventana de reseña en el navegador. Maps no tiene un enlace que caiga directo en "escribir
  // reseña": el cliente toca las estrellas en la ficha del local. Android: intent a la app, con la
  // ventana de reseña web como respaldo si no está instalada. iPhone: enlace universal de Maps.
  // 05/10/2026 (prueba con el usuario en iPhone, ver /r/prueba): ningún enlace cae directo en las
  // estrellas. En iPhone la app de Maps ya tiene la sesión iniciada -> se abre la ficha (variante C) y
  // se indica deslizar hasta "Califica y opina"; en el resto se usa el enlace de reseña de Google. En
  // ambos casos queda a mano el otro camino (por si en iPhone no está la app de Maps).
  const enlaceResena = LINKS_PEDIR_RESENA[slug] || urlGoogle;
  const ua = String(req.headers['user-agent'] || '');
  const esMovil = /iPhone|iPad|iPod|Android/i.test(ua);
  let destino = enlaceResena;
  let alternativo = null;
  if (esMovil && placeId) {
    const enlaceMaps = await urlResenaMaps(placeId);
    if (enlaceMaps) { destino = enlaceMaps; alternativo = enlaceResena; }
  }
  if (placeId && String((req.query && req.query.m) || '') === 'maps') {
    const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(s.nombre) + '&query_place_id=' + encodeURIComponent(placeId);
    const esAndroid = /Android/i.test(String(req.headers['user-agent'] || ''));
    destino = esAndroid
      ? 'intent://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(s.nombre) + '&query_place_id=' + encodeURIComponent(placeId)
        + '#Intent;scheme=https;package=com.google.android.apps.maps;S.browser_fallback_url=' + encodeURIComponent(LINKS_PEDIR_RESENA[slug] || urlGoogle) + ';end'
      : mapsUrl;
  }
  await sumar(slug, 'v');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(pagina(slug, s, destino, { maps: !!alternativo, alt: alternativo }));
};
