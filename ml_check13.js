
const SESION_KEY = 'meli_sesion_2026';
let sesion = null; // {rol, unidadNegocio, nombre, token}
let items = [];
let snapshotInfo = { completo: false, generatedAt: null };
let filtroEstado = '';
// 11/09/2026 ("Sin venta U7D" / "TOP 10"): 2do filtro, independiente del
// de Estado -- se combinan (AND). null = ninguno activo.
let filtroEspecial = null;
// 11/09/2026 ("un boton que filtre las publicaciones de Full"): toggle
// independiente (no forma parte del grupo mutuamente excluyente de
// arriba) -- se puede combinar con Estado, el buscador Y con Sin venta
// 7D/Top 10 al mismo tiempo (ej. "Full sin venta esta semana").
let soloFull = false;
// 11/09/2026 ("Cuando se duplica una Publicación para agregarle cuotas
// trae vacio el SKU... no trae el costo correcto"): filtro de
// diagnóstico, mismo criterio independiente que Full -- se combina con
// todo lo demás.
let soloSinSku = false;
// 09/09/2026 ("Ordenar por Más vendido, menos vendido, tocando un
// ordenador en Vendidas") + 11/09/2026 ("dejar ordenar por ventas 7D $
// y U... como la venta histórica"): un solo estado de orden, generalizado
// a cualquiera de las 3 columnas ordenables (antes era sólo Vendidas).
// ordenCampo=null = orden natural (como vino del servidor); al tocar un
// header ordenable arranca en 'desc' (más vendido/vendido primero), 2do
// click 'asc', 3er click vuelve a null -- ver toggleOrden. Cambiar de
// columna reinicia el ciclo en 'desc' para la nueva.
let ordenCampo = null;
let ordenDir = null;
// 11/09/2026 ("traigamos el costo"): {sku: {costo, nombre, ...}}, mismo
// snapshot público que ya usan Seguimiento/Stocks (ver api/stock-
// snapshot.js) -- se pide aparte de /api/meli-publicaciones porque es
// una fuente de datos totalmente distinta (Oppen, no MeLi) y no
// requiere sesión de Talento.
let costoBySku = {};

const ESTADO_LABEL = { active: 'Activa', paused: 'Pausada', closed: 'Cerrada', under_review: 'En revisión', inactive: 'Inactiva', payment_required: 'Pago pendiente' };
const ESTADO_CLASE = { active: 'active', paused: 'paused', closed: 'closed' };
const ROL_LABEL = { admin: 'RR.HH./Admin', supervisor: 'Supervisor', gerente: 'Gerente de Unidad', colaborador: 'Colaborador' };
// listing_type_id de MeLi -- Argentina hoy usa mayormente gold_special
// (Clásica) y gold_pro (Premium); gold/silver/bronze quedan como
// respaldo de nomenclaturas viejas por si algún ítem histórico las
// tiene todavía.
const CSI_LABEL = { gold_pro: 'Premium', gold_special: 'Clásica', gold: 'Premium', silver: 'Clásica', bronze: 'Clásica', free: 'Gratuita' };

/* ── Auth (mismo mecanismo que Gestión de Talento/Alquileres) ── */
async function fetchAutenticado(url, opciones){
  const headers = Object.assign({}, (opciones && opciones.headers) || {}, { Authorization: 'Bearer ' + ((sesion && sesion.token) || '') });
  const res = await fetch(url, Object.assign({}, opciones, { headers }));
  if(res.status === 401){ cerrarSesion(); }
  return res;
}
async function attemptLogin(){
  const usuario = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const btn = document.getElementById('btnLogin');
  const err = document.getElementById('loginError');
  err.style.display = 'none';
  if(!usuario || !password) return;
  btn.disabled = true;
  try{
    const res = await fetch('/api/talento-login', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({usuario, password}),
    });
    const j = await res.json();
    if(!res.ok || !j.ok){
      err.textContent = j.error || 'Usuario o contraseña incorrectos.';
      err.style.display = 'block';
      return;
    }
    sesion = {rol: j.rol, unidadNegocio: j.unidadNegocio || null, nombre: j.nombre, token: j.token};
    sessionStorage.setItem(SESION_KEY, JSON.stringify(sesion));
    mostrarApp();
  }catch(e){
    err.textContent = 'No se pudo conectar. Probá de nuevo.';
    err.style.display = 'block';
  }finally{
    btn.disabled = false;
  }
}
document.getElementById('loginPass').addEventListener('keydown', e=>{ if(e.key==='Enter') attemptLogin(); });
document.getElementById('loginUser').addEventListener('keydown', e=>{ if(e.key==='Enter') attemptLogin(); });

function cerrarSesion(){
  sessionStorage.removeItem(SESION_KEY);
  sessionStorage.removeItem('icom_sesion_2026');
  sessionStorage.setItem('meli_sesion_vencida', '1');
  location.reload();
}

// 09/09/2026 ("click a la imagen que solo abra un pop-up con la
// imagen ampliada"): thumbnail viene achicado (sufijo "-I", el que usa
// el listado) -- MeLi sirve el original con el MISMO nombre de
// archivo, sólo cambiando ese sufijo a "-O" (confirmado contra la
// propia respuesta de la API: /items trae ambas URLs para la misma
// foto, "-I" en thumbnail y "-O" en pictures[].url) -- no hace falta
// pedir nada nuevo, sólo transformar la URL que ya tenemos.
function verImagenAmpliada(thumbUrl){
  const grande = thumbUrl.replace(/-I\.(jpg|jpeg|png|webp)(\?.*)?$/i, '-O.$1$2');
  document.getElementById('imgOverlayImg').src = grande;
  document.getElementById('imgOverlay').style.display = 'flex';
}
function cerrarImagen(){
  document.getElementById('imgOverlay').style.display = 'none';
  document.getElementById('imgOverlayImg').src = '';
}

function fmtMoney(n){ n = Math.round(n||0); return '$'+n.toLocaleString('es-AR'); }
function fmtN(n){ return Math.round(n||0).toLocaleString('es-AR'); }
function escapeHtml(s){
  return String(s==null ? '' : s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function mostrarApp(){
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appBody').style.display = 'flex';
  document.getElementById('sesionInfo').innerHTML = '<b>'+escapeHtml(sesion.nombre||'')+'</b> · '+(ROL_LABEL[sesion.rol]||sesion.rol);
  await cargarDatos();
}

function setFiltroEstado(estado){
  filtroEstado = estado;
  document.querySelectorAll('#filtroEstado button').forEach(b=>b.classList.toggle('active', b.dataset.estado===estado));
  render();
}

// 09/09/2026 (Vendidas) + 11/09/2026 (generalizado a Ventas 7d u/$): 3
// clicks = ciclo completo -- 1° mayor primero, 2° menor primero, 3°
// vuelta al orden natural (por si alguien quiere ver la lista "como
// viene" de nuevo sin recargar la página). Tocar OTRA columna ordenable
// mientras ya había una activa reinicia el ciclo en 'desc' para la
// nueva, no sigue el ciclo de la anterior.
const CAMPOS_ORDENABLES = ['soldQuantity', 'ventas7dUnidades', 'ventas7dMonto', 'stockValor', 'diasInventarioFull'];
function toggleOrden(campo){
  if(ordenCampo !== campo){
    ordenCampo = campo;
    ordenDir = 'desc';
  }else{
    ordenDir = ordenDir==='desc' ? 'asc' : (ordenDir==='asc' ? null : 'desc');
    if(ordenDir===null) ordenCampo = null;
  }
  CAMPOS_ORDENABLES.forEach(c=>{
    const th = document.getElementById('th_'+c);
    if(!th) return;
    const activo = ordenCampo===c;
    th.classList.toggle('activo', activo);
    th.querySelector('.flecha').textContent = (activo && ordenDir==='asc') ? '▴' : '▾';
  });
  render();
}

// 11/09/2026 ("Sin venta U7D" / "TOP 10"): toggle -- tocar el mismo botón
// de nuevo lo apaga (mismo criterio de "click de nuevo = desactivar" que
// ya usa el resto de la app en otros lugares, ej. Talento).
function setFiltroEspecial(tipo){
  filtroEspecial = filtroEspecial===tipo ? null : tipo;
  document.querySelectorAll('#filtroEspecial button').forEach(b=>b.classList.toggle('active', b.dataset.especial===filtroEspecial));
  render();
}
// 11/09/2026 ("el filtro de Full quiza deba estar mas en el Header...
// modifique la visual completa: Stock Full y Dias Full solo deben verse
// en la vista Full, lo mismo que los valores... y mostrar lo pertinente
// a Full"): ya no es un toggle más -- es un cambio de MODO de toda la
// pantalla. Intercambia qué KPI-row se ve y muestra/oculta las 2
// columnas que sólo tienen sentido en Full (el resto de las columnas
// sigue igual en los 2 modos).
function setModoFull(activar){
  soloFull = activar;
  document.getElementById('btnModoCatalogo').classList.toggle('active', !activar);
  document.getElementById('btnModoFull').classList.toggle('active', activar);
  document.getElementById('kpiRowNormal').style.display = activar ? 'none' : 'flex';
  document.getElementById('kpiRowFull').style.display = activar ? 'flex' : 'none';
  document.getElementById('th_stockFull').hidden = !activar;
  document.getElementById('th_diasInventarioFull').hidden = !activar;
  render();
}
function toggleFiltroSinSku(){
  soloSinSku = !soloSinSku;
  document.getElementById('btnFiltroSinSku').classList.toggle('active', soloSinSku);
  render();
}

async function cargarCostos(){
  try{
    const res = await fetch('/api/stock-snapshot?_ts='+Date.now(), {cache:'no-store'});
    const j = await res.json();
    if(j && j.ok) costoBySku = j.bySku || {};
  }catch(e){
    console.warn('No se pudo cargar el costo (stock-snapshot):', e);
  }
}
// 11/09/2026 ("los costos de Oppen estan sin IVA, hay que sumarle el
// impuesto"): excepciones manuales por SKU (ej. "colchon antiescara" a
// 10,5%, ver seed real en api/meli-iva-overrides.js) -- el caso general
// (sin excepción) se resuelve solo en ivaPctParaSku, contra el
// ItemGroup que ya trae costoBySku (no hace falta pedir nada más).
let ivaOverrides = {};
async function cargarIvaOverrides(){
  try{
    const res = await fetch('/api/meli-iva-overrides?_ts='+Date.now(), {cache:'no-store'});
    const j = await res.json();
    if(j && j.ok) ivaOverrides = j.overrides || {};
  }catch(e){
    console.warn('No se pudieron cargar las excepciones de IVA:', e);
  }
}
// 11/09/2026 ("los códigos que no encuentra el costo es porque tienen un
// 0 adelante"): el SKU de Oppen (Item.Code, de donde sale este snapshot)
// nunca tiene ceros a la izquierda ("8527", no "008527") -- confirmado
// contra el snapshot real, 0 de ~16.300 claves empieza con "0". En MeLi
// en cambio el vendedor cargó varios SKU CON ceros a la izquierda
// ("008527", "001820", "010328"...), así que el cruce directo por string
// fallaba para esos. Se prueba primero el SKU tal cual (por si algún día
// Oppen sí trae uno con cero), y si no aparece, se lo busca de nuevo sin
// los ceros a la izquierda -- sólo cuando quedan seguidos de otro dígito,
// para no tocar un SKU no numérico ("0" solo también queda intacto).
function costoParaSku(sku){
  if(!sku) return null;
  if(costoBySku[sku]) return costoBySku[sku];
  const sinCeros = String(sku).replace(/^0+(?=\d)/, '');
  if(sinCeros !== String(sku) && costoBySku[sinCeros]) return costoBySku[sinCeros];
  return null;
}

// 11/09/2026 ("los costos de Oppen estan sin IVA, hay que sumarle el
// impuesto para que sea correcto el margen"): el costo que trae Oppen
// (ItemCost.OperativeCost) es NETO de IVA -- para que GM/NM reflejen la
// plata real que sale del bolsillo hay que sumarle la alícuota. Se
// resuelve en este orden:
//   1. Excepción manual por SKU (ivaOverrides, ver arriba) -- pisa
//      todo lo demás. Hoy cubre colchones/almohadones antiescaras
//      (10,5%, confirmado con Juan Manuel -- Oppen sólo tenía taggeados
//      8 de 99 productos de esa familia como IVA105, el resto quedaba
//      en 21% por defecto sin la excepción).
//   2. ItemGroup de Oppen (viene en el mismo costoBySku, sin pedir nada
//      aparte): 'IVA105' -> 10,5% (aparatos de diagnóstico/medición
//      real -- oxímetros, glucómetros, electrocardiógrafos, chasis de
//      RX, confirmado contra el catálogo real), 'IVAEXE' -> 0%
//      (exento -- bolsas de nutrición parenteral, confirmado también).
//   3. Default 21% (alícuota general) -- "cuando tengas duda coloca
//      21%", incluye sillas de ruedas (confirmado explícitamente que
//      quedan en 21%) y todo lo que no cae en los 2 casos de arriba.
function ivaPctParaSku(sku, skuInfo){
  // Mismo criterio de ceros a la izquierda que costoParaSku -- las
  // excepciones se cargan con el SKU de Oppen (sin ceros), pero acá
  // puede llegar el de MeLi (con ceros, ej. "009126").
  if(sku){
    if(ivaOverrides[sku] != null) return Number(ivaOverrides[sku]);
    const sinCeros = String(sku).replace(/^0+(?=\d)/, '');
    if(sinCeros !== String(sku) && ivaOverrides[sinCeros] != null) return Number(ivaOverrides[sinCeros]);
  }
  const grupo = skuInfo && skuInfo.itemGroup;
  if(grupo === 'IVA105') return 10.5;
  if(grupo === 'IVAEXE') return 0;
  return 21;
}

// 11/09/2026 ("traigamos el costo y calculemos el GM" / "comisión...
// costo de envio... para calcular el NM" / "Stock $" / "sumarle el
// IVA"): precalcula, UNA vez por carga (no en cada render -- se
// re-renderiza en cada tecleo del buscador), todo lo que depende de
// costo/IVA/comisión/envío para cada publicación. GM y NM son 2 cosas
// DISTINTAS a propósito:
//   - GM = (precio venta efectivo − costo CON IVA) / precio venta
//     efectivo.
//   - NM = eso mismo, pero también resta comisión de MeLi (real, por
//     categoría+tipo+precio -- ver comisionPct/comisionFijo, que ya
//     vienen calculados del escaneo diario), el costo de envío
//     promedio REAL acumulado por SKU (envioPromedioUnidad -- "—" hasta
//     que haya al menos 1 despacho confirmado; ver la nota grande en
//     api/meli-actualizar-publicaciones.js sobre por qué no hay un
//     costo de envío fijo por publicación) e IIBB (Ingresos Brutos,
//     3% fijo sobre el precio de venta, a pedido).
// Ambas sobre el precio de OFERTA cuando hay una activa (es al que
// realmente se vende hoy) -- la comisión de MeLi también se cobra sobre
// ese precio, no sobre el de lista.
const IIBB_PCT = 3;
// 11/09/2026 ("cuando encuentres un producto sin costo en Oppen utiliza
// el GM% general para calcular el mismo"): 2 pasadas --
//   1) todo lo que SÍ tiene costo real de Oppen, igual que antes. De
//      paso junta el "GM general" (promedio simple del GM% del
//      catálogo, sólo entre los que tienen costo real).
//   2) lo que no tiene costo real: se le imputa un costo IMPLÍCITO tal
//      que su GM quede exactamente en ese GM general (precioEfectivo ×
//      (1 − GMgeneral/100)) -- así ya no hace falta excluir nada de
//      GM/NM/Stock $ (antes quedaba "—" y se caía del cálculo). Se
//      marca `_costoEstimado:true` para que la UI lo distinga (tooltip
//      "estimado", nunca se muestra como si fuera un dato real de
//      Oppen).
//
// El "GM general" se pondera por VENTA REAL de los últimos 7 días
// (mismo criterio que el KPI "GM ventas 7D"), no por cantidad de
// publicaciones -- un promedio simple por publicación lo arruina un
// puñado de publicaciones con costo real cargado pero el precio de
// MeLi desincronizado por debajo del costo (nunca se venden, así que
// no importan para las ventas reales, pero pesan IGUAL que un
// long-seller real en un promedio simple). Sólo si no hay NINGUNA
// venta en la ventana (catálogo recién arrancando) cae al promedio
// simple como último recurso.
function enriquecerItems(){
  let sumaGmPonderada = 0, montoPonderado = 0;
  let sumaGmConCosto = 0, cantidadConCosto = 0;
  items.forEach(it=>{
    const skuInfo = costoParaSku(it.sku);
    const costoNeto = (skuInfo && Number(skuInfo.costo) > 0) ? Number(skuInfo.costo) : null;
    const ivaPct = ivaPctParaSku(it.sku, skuInfo);
    const costo = costoNeto != null ? costoNeto * (1 + ivaPct / 100) : null;
    const hayOferta = it.precioOferta && Number(it.precioOferta) < Number(it.price);
    const precioEfectivo = hayOferta ? Number(it.precioOferta) : Number(it.price);
    it._costoNeto = costoNeto;
    it._costo = costo;
    it._costoEstimado = false;
    it._ivaPct = costoNeto != null ? ivaPct : null;
    it._precioEfectivo = precioEfectivo;
    it._gmPct = (costo != null && precioEfectivo > 0) ? ((precioEfectivo - costo) / precioEfectivo) * 100 : null;
    if(it._gmPct != null){
      sumaGmConCosto += it._gmPct; cantidadConCosto += 1;
      const unidades7d = Number(it.ventas7dUnidades) || 0;
      const monto7d = Number(it.ventas7dMonto) || 0;
      if(unidades7d > 0 && monto7d > 0){ sumaGmPonderada += monto7d - costo * unidades7d; montoPonderado += monto7d; }
    }
  });
  const gmGeneralPct = montoPonderado > 0 ? (sumaGmPonderada / montoPonderado * 100)
    : (cantidadConCosto > 0 ? (sumaGmConCosto / cantidadConCosto) : null);

  items.forEach(it=>{
    if(it._costo == null && gmGeneralPct != null && it._precioEfectivo > 0){
      it._costo = it._precioEfectivo * (1 - gmGeneralPct / 100);
      it._costoEstimado = true;
      it._gmPct = gmGeneralPct;
    }
    it.stockValor = (it._costo != null && it.availableQuantity != null) ? it._costo * Number(it.availableQuantity) : null;

    const comisionPct = it.comisionPct != null ? Number(it.comisionPct) : null;
    const comisionFijo = Number(it.comisionFijo) || 0;
    const comisionMonto = (comisionPct != null && it._precioEfectivo > 0) ? (it._precioEfectivo * comisionPct / 100 + comisionFijo) : null;
    const envio = it.envioPromedioUnidad != null ? Number(it.envioPromedioUnidad) : null;
    const iibb = it._precioEfectivo > 0 ? it._precioEfectivo * IIBB_PCT / 100 : 0;
    it._comisionPct = comisionPct;
    it._comisionFijo = comisionFijo;
    it._comisionMonto = comisionMonto;
    it._envio = envio;
    it._iibb = iibb;
    it._nmMonto = (it._costo != null && comisionMonto != null && envio != null) ? (it._precioEfectivo - it._costo - comisionMonto - envio - iibb) : null;
    it._nmPct = (it._nmMonto != null && it._precioEfectivo > 0) ? (it._nmMonto / it._precioEfectivo) * 100 : null;
  });
}

// 11/09/2026 ("esta todo oculto... deja al lado del NM% una flecha
// desplegable para ver el detalle"): 1 fila de detalle por publicación,
// se muestra/oculta con un Set de claves (no con un simple booleano en
// el item -- así sobrevive a un re-render sin perder qué filas quedaron
// abiertas). La clave combina id+sku porque un mismo MLA con variantes
// (ver meli_variantes_manual.json) explota en varias filas que
// comparten el mismo id pero no el mismo sku.
let expandidos = new Set();
function claveFila(it){ return (it.id||'')+'::'+(it.sku||''); }
function toggleDetalleNM(clave){
  if(expandidos.has(clave)) expandidos.delete(clave); else expandidos.add(clave);
  render();
}
function filaDetalleNM(it){
  const linea = (label, valor) => '<div class="detalle-linea"><span>'+label+'</span><span class="num">'+valor+'</span></div>';
  if(it._costo == null){
    return '<div class="detalle-nm muted">Sin costo cargado en Oppen para el SKU "'+escapeHtml(it.sku||'—')+'" -- no se puede calcular el detalle.</div>';
  }
  const partes = [];
  partes.push(linea('Precio de venta'+(it.precioOferta && Number(it.precioOferta) < Number(it.price) ? ' (con oferta activa)' : ''), fmtMoney(it._precioEfectivo)));
  if(it._costoEstimado){
    partes.push(linea('Costo estimado (SKU sin costo en Oppen -- se usó el GM general del catálogo, '+it._gmPct.toFixed(1)+'%)', '−'+fmtMoney(it._costo)));
  }else{
    partes.push(linea('Costo Oppen (neto de IVA)', '−'+fmtMoney(it._costoNeto)));
    partes.push(linea('+ IVA ('+it._ivaPct+'%)', '−'+fmtMoney(it._costo - it._costoNeto)));
  }
  if(it._comisionMonto != null){
    const detalleComision = it._comisionFijo > 0
      ? (it._comisionPct+'% + cargo fijo '+fmtMoney(it._comisionFijo)+' -- MeLi cobra un fijo extra en publicaciones de precio bajo')
      : (it._comisionPct+'%');
    partes.push(linea('Comisión Mercado Libre ('+detalleComision+')', '−'+fmtMoney(it._comisionMonto)));
  }else{
    partes.push(linea('Comisión Mercado Libre', '—'));
  }
  if(it.envioFuente==='bajo_ticket_exento'){
    // 11/09/2026 ("Cuando el precio es menor a 33mil el costo de envio
    // lo paga el cliente generalmente"): por debajo del umbral de bajo
    // valor, Mercado Envíos no le cuesta nada al vendedor -- se lo cobra
    // al comprador. No se resta nada acá (a diferencia de las otras
    // fuentes, que sí restan un costo real).
    const umbral = snapshotInfo.stats && snapshotInfo.stats.umbralBajoValorArs;
    partes.push(linea('Envío (no aplica -- precio por debajo de '+(umbral?fmtMoney(umbral):'$33.000')+', lo paga el comprador)', '$0'));
  }else if(it._envio != null){
    const fuenteEnvioTxt = it.envioFuente==='propio' ? 'propio de este SKU, '+fmtN(it.envioMuestras)+' unidades vendidas'
      : it.envioFuente==='tabla_ia40' ? 'tabla por tamaño de ia40 ("'+(it.envioTablaTamano||'?')+'") -- este SKU todavía no acumuló sus propias ventas'
      : it.envioFuente==='global' ? 'promedio general de la cuenta, '+fmtN(it.envioMuestras)+' unidades -- ni promedio propio ni tabla de ia40 disponibles'
      : 'sin dato';
    partes.push(linea('Envío promedio ('+fuenteEnvioTxt+')', '−'+fmtMoney(it._envio)));
  }else{
    partes.push(linea('Envío promedio (todavía sin datos)', '—'));
  }
  partes.push(linea('IIBB ('+IIBB_PCT+'%)', '−'+fmtMoney(it._iibb)));
  const nmHtml = it._nmPct != null
    ? '<span class="'+(it._nmPct>=0?'detalle-positivo':'detalle-resta')+'">'+fmtMoney(it._nmMonto)+' ('+it._nmPct.toFixed(1)+'%)</span>'
    : '<span class="muted">—</span>';
  partes.push('<div class="detalle-linea detalle-total"><span>= Margen neto (NM)</span><span class="num">'+nmHtml+'</span></div>');
  return '<div class="detalle-nm">'+partes.join('')+'</div>';
}

async function cargarDatos(){
  try{
    // 11/09/2026 ("traigamos el costo"): en paralelo -- son 2 fuentes de
    // datos totalmente independientes (MeLi / Oppen), no hace falta
    // esperar una para pedir la otra. Si stock-snapshot falla, cargarCostos
    // ya lo absorbe sola (costoBySku queda {} -- Costo/GM muestran "—",
    // no rompe el resto de la tabla).
    const [res] = await Promise.all([
      fetchAutenticado('/api/meli-publicaciones?_ts='+Date.now(), {cache:'no-store'}),
      cargarCostos(),
      cargarIvaOverrides(),
    ]);
    const j = await res.json();
    if(!res.ok || !j.ok) throw new Error(j.error || 'No se pudieron cargar las publicaciones.');
    items = j.items || [];
    enriquecerItems();
    snapshotInfo = { completo: j.completo, generatedAt: j.generatedAt, stats: j.stats };
    render();
  }catch(e){
    document.getElementById('tbody').innerHTML = '<tr><td colspan="'+(soloFull?19:17)+'" class="pane-error">'+escapeHtml(e.message||e)+'</td></tr>';
  }
}

function render(){
  const q = (document.getElementById('buscador').value||'').trim().toLowerCase();
  let filtrados = items.filter(it=>{
    if(filtroEstado && it.status !== filtroEstado) return false;
    if(soloFull && it.logisticType !== 'fulfillment') return false;
    if(soloSinSku && it.sku) return false;
    if(q && !String(it.title||'').toLowerCase().includes(q) && !String(it.sku||'').toLowerCase().includes(q)) return false;
    return true;
  });
  // 11/09/2026: "Sin venta U7D" y "TOP 10" se aplican DESPUÉS de
  // Estado/buscador (se combinan con esos, no los reemplazan) y ANTES del
  // orden de columna -- así "Top 10" decide cuáles 10 filas quedan, y si
  // además hay una columna ordenable tocada, ese orden decide cómo se ven
  // esas 10 (por defecto ya vienen ordenadas por Ventas 7d $ desc).
  if(filtroEspecial === 'sinVenta7d'){
    filtrados = filtrados.filter(it => (Number(it.ventas7dUnidades)||0) === 0);
  }else if(filtroEspecial === 'top10'){
    filtrados = filtrados.slice().sort((a,b)=>(Number(b.ventas7dMonto)||0)-(Number(a.ventas7dMonto)||0)).slice(0, 10);
  }
  if(ordenCampo){
    filtrados = filtrados.slice().sort((a,b)=>{
      const diff = (Number(a[ordenCampo])||0) - (Number(b[ordenCampo])||0);
      return ordenDir==='asc' ? diff : -diff;
    });
  }

  const activas = items.filter(it=>it.status==='active');
  document.getElementById('kpiTotal').textContent = fmtN(items.length);
  document.getElementById('kpiActive').textContent = fmtN(activas.length);
  document.getElementById('kpiPaused').textContent = fmtN(items.filter(it=>it.status==='paused').length);
  document.getElementById('kpiClosed').textContent = fmtN(items.filter(it=>it.status==='closed').length);
  const valorStock = activas.reduce((s,it)=>s+(Number(it.price)||0)*(Number(it.availableQuantity)||0), 0);
  document.getElementById('kpiValor').textContent = fmtMoney(valorStock);
  // 09/09/2026 ("coloca ventas total ultimos 7 dias"): suma de
  // ventas7dMonto de TODAS las publicaciones (no sólo las activas --
  // una publicación pausada/cerrada esta semana pudo haber vendido
  // antes de pausarse/cerrarse dentro de la misma ventana de 7 días).
  const ventas7dTotal = items.reduce((s,it)=>s+(Number(it.ventas7dMonto)||0), 0);
  document.getElementById('kpiVentas7d').textContent = fmtMoney(ventas7dTotal);

  // 11/09/2026 ("mostrar lo pertinente a Full"): KPI propios de la
  // vista Full -- sobre TODAS las publicaciones Full (igual criterio
  // que el resto de estos KPI, sobre `items`, no sobre `filtrados` --
  // Estado/buscador no deberían mover el panorama general de Full).
  const itemsFull = items.filter(it=>it.logisticType==='fulfillment');
  document.getElementById('kpiFullTotal').textContent = fmtN(itemsFull.length);
  document.getElementById('kpiFullActive').textContent = fmtN(itemsFull.filter(it=>it.status==='active').length);
  document.getElementById('kpiFullSinStock').textContent = fmtN(itemsFull.filter(it=>it.alertaFull==='sin_stock').length);
  document.getElementById('kpiFullCritico').textContent = fmtN(itemsFull.filter(it=>it.alertaFull==='critico').length);
  document.getElementById('kpiFullSinVentas').textContent = fmtN(itemsFull.filter(it=>it.alertaFull==='sin_ventas').length);
  const valorStockFull = itemsFull.reduce((s,it)=>s+(it._costo!=null && it.stockFull!=null ? it._costo*it.stockFull : 0), 0);
  document.getElementById('kpiFullValor').textContent = fmtMoney(valorStockFull);

  // 11/09/2026 ("En los totales agrega %GM %NM de las ventas ultimos 7
  // dias"): PONDERADO por lo que de verdad se vendió esta semana (no el
  // promedio simple entre publicaciones -- una publicación con 1 sola
  // venta no puede pesar lo mismo que otra con 100). Para cada
  // publicación con ventas7dUnidades>0 se estima el costo/comisión/
  // envío/IIBB de ESA semana aplicando la tasa por unidad YA calculada
  // (costo con IVA, comisión %, envío promedio, IIBB) sobre las
  // unidades realmente vendidas -- es una aproximación (no tenemos el
  // precio real de cada venta individual, sólo el total semanal), pero
  // usa exactamente los mismos datos ya validados de la tabla, no un
  // número nuevo. Publicaciones sin costo cargado se excluyen de AMBOS
  // (numerador y denominador) para no inflar ni castigar el % con
  // ventas de las que no se puede confirmar el margen -- ver footNote
  // para cuánto de la venta total quedó afuera por eso.
  let ventasConGm = 0, gmAcum = 0;
  let ventasConNm = 0, nmAcum = 0;
  items.forEach(it=>{
    const unidades = Number(it.ventas7dUnidades) || 0;
    const monto = Number(it.ventas7dMonto) || 0;
    if(unidades <= 0 || monto <= 0) return;
    if(it._costo != null){
      ventasConGm += monto;
      gmAcum += monto - it._costo * unidades;
    }
    if(it._nmMonto != null){
      ventasConNm += monto;
      nmAcum += monto - it._costo * unidades - it._comisionMonto * unidades - it._envio * unidades - monto * IIBB_PCT / 100;
    }
  });
  const claseKpiMargen = (pct) => pct >= 30 ? 'ok' : (pct >= 10 ? 'warn' : 'danger');
  const gm7dPct = ventasConGm > 0 ? (gmAcum / ventasConGm * 100) : null;
  const nm7dPct = ventasConNm > 0 ? (nmAcum / ventasConNm * 100) : null;
  const elGm7d = document.getElementById('kpiGm7d');
  elGm7d.textContent = gm7dPct != null ? gm7dPct.toFixed(1) + '%' : '—';
  elGm7d.className = 'kpi-value' + (gm7dPct != null ? ' ' + claseKpiMargen(gm7dPct) : '');
  const elNm7d = document.getElementById('kpiNm7d');
  elNm7d.textContent = nm7dPct != null ? nm7dPct.toFixed(1) + '%' : '—';
  elNm7d.className = 'kpi-value' + (nm7dPct != null ? ' ' + claseKpiMargen(nm7dPct) : '');

  const nota = [];
  if(snapshotInfo.generatedAt){
    const d = new Date(snapshotInfo.generatedAt);
    nota.push('Actualizado: '+d.toLocaleString('es-AR'));
  }else{
    nota.push('Todavía no hay un escaneo completo -- puede demorar unos minutos la primera vez.');
  }
  if(snapshotInfo.completo===false && snapshotInfo.generatedAt) nota.push('(el último escaneo quedó parcial -- se completa solo en el próximo ciclo)');
  const rango7d = snapshotInfo.stats && snapshotInfo.stats.rango7d;
  if(rango7d) nota.push('· Columnas "7d": del '+rango7d.visitasDesde+' al '+rango7d.visitasHasta+'.');
  document.getElementById('footNote').textContent = nota.join(' ');

  const tbody = document.getElementById('tbody');
  if(!filtrados.length){
    tbody.innerHTML = '<tr><td colspan="'+(soloFull?19:17)+'" class="muted" style="padding:20px;text-align:center">Sin publicaciones que coincidan.</td></tr>';
    return;
  }
  tbody.innerHTML = filtrados.map(it=>{
    const estadoClase = ESTADO_CLASE[it.status] || 'other';
    const estadoLabel = ESTADO_LABEL[it.status] || it.status || '—';
    const thumbUrl = it.thumbnail ? String(it.thumbnail).replace('http://','https://') : '';
    const thumb = thumbUrl ? '<img class="prod-thumb" src="'+thumbUrl+'" alt="" onclick="verImagenAmpliada(\''+escapeHtml(thumbUrl)+'\')">' : '<div class="prod-thumb" style="display:flex;align-items:center;justify-content:center;opacity:.4">📦</div>';
    // 09/09/2026 (2da vuelta -- "tambien falta el precio de oferta"):
    // el precio de oferta REAL de MeLi no vive en original_price (ese
    // queda null para las promociones que arma el vendedor,
    // confirmado en vivo) -- viene de precioOferta/precioListaOferta,
    // que salen de /seller-promotions/items/{id} (ver _meli-api.js).
    const hayOferta = it.precioOferta && Number(it.precioOferta) < Number(it.price);
    const precioHtml = hayOferta
      ? '<span class="precio-tachado">'+fmtMoney(it.precioListaOferta || it.price)+'</span><span class="precio-oferta">'+fmtMoney(it.precioOferta)+'</span>'
      : fmtMoney(it.price);
    const csiLabel = CSI_LABEL[it.listingTypeId] || it.listingTypeId || '—';
    const csiTag = '<span class="tag'+(csiLabel==='Premium' ? ' premium' : '')+'">'+csiLabel+'</span>';
    const tipoTag = it.esCatalogo ? '<span class="tag catalogo">Catálogo</span>' : '<span class="tag">Clásica</span>';
    // 11/09/2026 ("traigamos el costo y calculemos el GM" / "comisión...
    // costo de envio... para calcular el NM" / "Stock $"): costo, GM, NM
    // y valor de stock ya vienen precalculados por enriquecerItems() --
    // ver esa función para el detalle de cada fórmula (y por qué GM y NM
    // son 2 cosas distintas, no lo mismo con otro nombre).
    const clasePill = (pct) => pct == null ? '' : (pct >= 30 ? 'gm-ok' : (pct >= 10 ? 'gm-warn' : 'gm-danger'));
    const pillHtml = (pct) => pct != null ? '<span class="gm-pill '+clasePill(pct)+'">'+pct.toFixed(1)+'%</span>' : '<span class="muted">—</span>';
    // 11/09/2026 ("cuando encuentres un producto sin costo en Oppen
    // utiliza el GM% general"): un costo ESTIMADO (SKU sin costo real
    // en Oppen) se muestra en cursiva con "~" -- nunca igual a un costo
    // real, para no hacerlo pasar por un dato confirmado.
    const costoHtml = it._costo == null ? '<span class="muted">—</span>'
      : it._costoEstimado
        ? '<span class="costo-estimado" title="Estimado -- este SKU no tiene costo cargado en Oppen, se usó el GM general del catálogo ('+it._gmPct.toFixed(1)+'%) para no dejarlo afuera del cálculo.">~'+fmtMoney(it._costo)+'</span>'
        : '<span title="Incluye IVA '+it._ivaPct+'%">'+fmtMoney(it._costo)+'</span>';
    const gmHtml = pillHtml(it._gmPct);
    // 11/09/2026 ("esta todo oculto... deja al lado del NM% una flecha
    // desplegable para ver el detalle"): la flecha sólo aparece si hay
    // algo para desplegar (costo cargado) -- si no, no tiene sentido
    // ofrecer un detalle vacío.
    const clave = claveFila(it);
    const expandido = expandidos.has(clave);
    const claveJs = clave.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const nmHtml = pillHtml(it._nmPct) + (it._costo != null
      ? ' <button type="button" class="btn-detalle" onclick="toggleDetalleNM(\''+claveJs+'\')" title="Ver el detalle del cálculo">'+(expandido ? '▴' : '▾')+'</button>'
      : '');
    const stockValorHtml = it.stockValor != null ? fmtMoney(it.stockValor) : '<span class="muted">—</span>';
    // 11/09/2026 ("boton que filtre... Full... stock que hay en
    // Full... cuantos dias de inventario... cual hay que activar...
    // cual esta al limite"): sólo aplica a logisticType==='fulfillment'
    // -- el resto de las publicaciones muestran "—" en las 2 columnas.
    const stockFullHtml = it.logisticType==='fulfillment'
      ? (it.stockFull!=null ? fmtN(it.stockFull) : '<span class="muted">—</span>')
      : '<span class="muted">—</span>';
    let diasFullHtml = '<span class="muted">—</span>';
    if(it.logisticType==='fulfillment'){
      if(it.alertaFull==='sin_stock') diasFullHtml = '<span class="gm-pill gm-danger" title="0 unidades reales en el depósito de Full -- la publicación puede seguir mostrando disponibilidad igual.">Sin stock</span>';
      else if(it.alertaFull==='critico') diasFullHtml = '<span class="gm-pill gm-warn">'+fmtN(it.diasInventarioFull)+' días</span>';
      // 11/09/2026 ("DIAS FULL no debe decir OK, en ese caso es un
      // infinito... a los 60 dias sin rotar el inventario nos cobran
      // una multa"): 0 ventas en 7 días no es "todo bien" -- es
      // matemáticamente un stock infinito (nunca se agota vendiendo a
      // este ritmo) PERO Full penaliza la falta de rotación aparte del
      // stock -- se marca en naranja como aviso, no en verde.
      // 11/09/2026 (2da vuelta -- "no son 0 dias... es un caso critico
      // dias infinito. reemplazar el 0 por simbolo infinito y pintarlo
      // de rojo para accionar"): con stock pero 0 ventas esta semana no
      // es "0 días" (matemáticamente es AL REVÉS -- infinito, nunca se
      // agota sólo vendiendo) -- y tampoco es un aviso leve: sin
      // rotación es tan urgente como quedarse sin stock (multa de Full
      // a los 60 días), por eso mismo color que 'sin_stock', no el
      // naranja de 'critico'.
      else if(it.alertaFull==='sin_ventas') diasFullHtml = '<span class="gm-pill gm-danger" title="Sin ventas en los últimos 7 días -- el stock por sí solo no se agota (∞), pero Full cobra una multa por falta de rotación a partir de los 60 días sin vender. Revisar a mano cuánto hace que no rota.">∞</span>';
      else if(it.alertaFull==='ok') diasFullHtml = '<span class="gm-pill gm-ok">'+fmtN(it.diasInventarioFull)+' días</span>';
    }
    // 09/09/2026 ("no es consistente la info" -- visitas en 0 que en
    // la propia MeLi mostraban cientos): visitas7d ahora puede venir
    // en 3 estados -- un número real (0 incluido, confirmado), `null`
    // (se intentó pero MeLi no contestó bien ni reintentando -- ver
    // _meli-api.js) o `undefined` (snapshot de un escaneo viejo,
    // anterior a este campo). Sólo el número real cuenta como "hay
    // dato" -- null/undefined muestran "—", nunca un 0 inventado.
    //
    // 11/09/2026 ("Muchos productos estan con las metricas con un --
    // ventas 7D"): tieneMetricas7d SÓLO describe si las VISITAS se
    // pudieron confirmar (esa sí puede fallar, 503 puntuales por
    // ítem) -- Ventas 7d (u)/($) viene de /orders/search, que pagina
    // TODO de una sola vez sin ese límite (ver escanearOrdenes en
    // _meli-scan.js) y siempre trae un 0 real, nunca null. Antes esas 2
    // columnas se tapaban con "—" cada vez que la visita de ESE item en
    // particular fallaba, aunque la venta sí se supiera con certeza --
    // eran 2 datos independientes gateados por el mismo flag.
    const visitas = it.visitas7d;
    const tieneMetricas7d = visitas !== undefined && visitas !== null;
    const ventasU = it.ventas7dUnidades || 0;
    const conversion = (tieneMetricas7d && visitas > 0) ? ((ventasU / visitas) * 100).toFixed(1) + '%' : (tieneMetricas7d ? '—' : '—');
    return '<tr>'
      + '<td>'+thumb+'</td>'
      + '<td class="col-titulo"><a class="titulo-link" href="'+escapeHtml(it.permalink||'#')+'" target="_blank" rel="noopener" title="'+escapeHtml(it.title)+'">'+escapeHtml(it.title)+'</a></td>'
      + '<td class="muted">'+escapeHtml(it.sku||'—')+(it.skuManual ? ' <span title="'+(it.skuNivel==='variante' ? 'Esta publicación agrupa varias variantes (talle/tamaño) con SKU real distinto cada una -- esta fila es sólo una de ellas' : 'Completado a partir de tu tabla -- MeLi no trae SKU propio para esta publicación')+'" style="cursor:help">✎</span>' : '')+'</td>'
      + '<td class="num">'+precioHtml+'</td>'
      + '<td class="num">'+costoHtml+'</td>'
      + '<td class="num">'+gmHtml+'</td>'
      + '<td class="num">'+nmHtml+'</td>'
      + '<td class="num">'+(it.availableQuantity==null ? '—' : fmtN(it.availableQuantity))+'</td>'
      + '<td class="num">'+stockValorHtml+'</td>'
      + (soloFull ? '<td class="num">'+stockFullHtml+'</td><td class="num">'+diasFullHtml+'</td>' : '')
      + '<td class="num">'+fmtN(it.soldQuantity)+'</td>'
      + '<td><span class="pill '+estadoClase+'">'+estadoLabel+'</span></td>'
      + '<td>'+tipoTag+'</td>'
      + '<td>'+csiTag+'</td>'
      + '<td class="num col7d">'+fmtN(ventasU)+'</td>'
      + '<td class="num col7d">'+fmtMoney(it.ventas7dMonto)+'</td>'
      + '<td class="num col7d">'+(tieneMetricas7d ? fmtN(visitas) : '—')+'</td>'
      + '<td class="num col7d">'+conversion+'</td>'
      + '</tr>'
      + (expandido ? '<tr class="fila-detalle"><td></td><td colspan="'+(soloFull?18:16)+'">'+filaDetalleNM(it)+'</td></tr>' : '');
  }).join('');
}

/* ── Init: mismo criterio que Alquileres/Gestión de Talento -- primero
   se chequea la sesión COMPARTIDA que arma el shell en su propio login
   (icom_sesion_2026); si existe, entra directo sin pedir login de
   nuevo. La sesión propia de esta app (SESION_KEY) queda como
   respaldo, por si esta pantalla se abriera sola, fuera del shell. ── */
(function init(){
  try{
    const compartida = sessionStorage.getItem('icom_sesion_2026');
    if(compartida){
      sesion = JSON.parse(compartida);
      mostrarApp();
      return;
    }
    const guardada = sessionStorage.getItem(SESION_KEY);
    if(guardada){
      sesion = JSON.parse(guardada);
      mostrarApp();
      return;
    }
  }catch(e){}
  if(sessionStorage.getItem('meli_sesion_vencida')){
    sessionStorage.removeItem('meli_sesion_vencida');
    const err = document.getElementById('loginError');
    err.textContent = 'Tu sesión venció -- volvé a ingresar tus credenciales.';
    err.style.display = 'block';
  }
  document.getElementById('loginUser').focus();
})();
