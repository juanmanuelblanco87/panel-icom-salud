// api/_nubi-parser.js
//
// 30/10/2026 (Juan Manuel, Nubimetrics: "necesito curar las bases con algún motor de parser similar al que usamos para curar nuestras propias bases, que
// optimice la calidad de la info tal como viene de Nubi, mejorar la calidad del Modelo y la Marca; comencemos la prueba en Sillas de ruedas"):
// curado de MARCA y MODELO de cada publicación de Nubimetrics. Mismo espíritu que el asignador de marcas de Seguimiento: tabla de equivalencias explícita
// + evidencia en el título (la marca/modelo que dice el título gana sobre un campo mal cargado) + descarte de basura, y todo se puede volver a correr
// sobre el crudo archivado (nubi_raw) cuando se mejoran las reglas -- el dato original NUNCA se pisa.
//
// Alcance de esta primera versión:
//   - TODAS las publicaciones: modelo básico (normalizado: mayúsculas, sin tildes ni espacios/guiones de más, sin valores basura tipo "N/A", "GENÉRICO").
//   - SÓLO "Sillas de Ruedas" (categoría Movilidad › Sillas de Ruedas y Repuestos › Sillas de Ruedas): curado completo de marca y modelo (abajo, `curarSilla`).
//     Las demás subcategorías se van sumando de a una a medida que se prueben.
//
// curar(p) recibe { t: título, b: marca, m: modelo, sku, c3, c4 } y devuelve { b, m, b0, m0, razon } (b/m = curados; b0/m0 = originales).

const { DICT: DICT_MARCAS, claveMarca } = require('./_nubi-marcas');

const sinTildes = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const mayus = (s) => sinTildes(s).toUpperCase().replace(/\s+/g, ' ').trim();
// "palabras" de un texto: mayúsculas, sin tildes, sólo letras/números
const palabras = (s) => mayus(s).replace(/[^A-Z0-9]+/g, ' ').trim();

// ───────────────────────── Modelo: normalización básica (todas las categorías) ─────────────────────────
const MODELO_BASURA = /^(N\/?A|S\/?M|S\/?N|SIN MODELO|NO APLICA|NO TIENE|NINGUNO|GENERIC[OA]?|UNICO|UNICA|ESTANDAR|STANDARD|STD|UNIVERSAL|VARIOS|MODELO|\-+|\.+|0+|\?+)$/;
function modeloBasico(m) {
  let v = mayus(m);
  if (!v || MODELO_BASURA.test(v)) return '';
  v = v.replace(/\s*[-–]\s*/g, '-').replace(/[\s"']+$/g, '').trim();
  if (v.length > 30) v = v.slice(0, 30);
  return v;
}

// ───────────────────────── Marca: equivalencias (variante normalizada -> canónica) ─────────────────────────
// Se compara contra la marca normalizada (mayúsculas, sin tildes ni signos). Lo que NO esté acá queda como vino (en mayúsculas).
const SIN_MARCA = '(sin marca)';
const ALIAS_MARCA = {
  'CARE QUIP ARGENTINA': 'CARE-QUIP', 'CARE QUIP': 'CARE-QUIP', 'CAREQUIP': 'CARE-QUIP',
  'SAN UP': 'SAN UP', 'SANUP': 'SAN UP',
  'IMEX ELDORADO': 'IMEX ELDORADO', 'ELDORADO IMEX': 'IMEX ELDORADO',
  'RN LEDESMA': 'RN LEDESMA', 'LEDESMA': 'RN LEDESMA', 'ORTOPEDIA LIBERTAD R N LEDESMA': 'RN LEDESMA', 'RNL LEDESMA': 'RN LEDESMA', 'R N LEDESMA': 'RN LEDESMA', 'LEDESMA 976AJ': 'RN LEDESMA', 'RNL': 'RN LEDESMA',
  'TRINIDAD INSUMOS': 'TRINIDAD', 'TRINIDAD': 'TRINIDAD', 'TRINI': 'TRINIDAD', 'TRINIDAD ORTOPEDIA MODELO': 'TRINIDAD', 'ORTOPEDIA MODELO TRINI': 'TRINIDAD', 'IMPORTADA MODELO TRINIDAD': 'TRINIDAD',
  'IMPORTADA MODELO': 'ORTOPEDIA MODELO', 'ORTOPEDIA MODELO': 'ORTOPEDIA MODELO', 'MODELO IMPORTADA': 'ORTOPEDIA MODELO', 'IMPORTADA MODELO 809': 'ORTOPEDIA MODELO',
  'MEDICAL STORE': 'MEDICAL STORE', 'MEDICAL SORE': 'MEDICAL STORE',
  'ORTPEDIA BELGRANO': 'ORTOPEDIA BELGRANO',
  'DELLAMED': 'DELLAMED', 'MAIS DELLAMED': 'DELLAMED',
  'WINNER MED': 'WINNER MED',
  'FOSHAN BERNAT': 'FOSHAN',
  'ORTOPEDIA LIBERTAD IMPORTADO': 'ORTOPEDIA LIBERTAD', 'ORTOPEDIA LIBERTAD IMPORTADA': 'ORTOPEDIA LIBERTAD',
  'ORTOPEDIA LIBERTAD SILFAB': 'SILFAB', 'IALLO SILFAB': 'SILFAB',
  'MAGESA OTTOBOCK': 'MAGESA',
  'MOBICARE': 'MOVICARE', 'DRIVE': 'DRIVE MEDICAL',
};
// Valores que describen el producto o dicen "sin marca": no son una marca.
const MARCA_NO_ES_MARCA = new Set(['GENERICO', 'GENERICA', 'GENERIC', 'REFORZADA', 'SEMI DESMONTABLE', 'DE TRASLADO', 'PERSONALIZADO', 'SILLA DE EVACUACION', 'SIMIL OTTOBOCK', 'OTTOBOCK SIMIL', 'TIPO OTTO BOCK',
  'ORTOPEDIA MODELO SIMIL OTTO BOCK', 'MODELO SIMIL OTTO DOBLE CRUCETA', 'SUPER CONFORT', 'IND NACIONAL', 'INDUSTRIA NACIONAL', 'IMPORTADO', 'IMPORTADA', 'S M', 'SIN MARCA', 'NO APLICA', 'N A']);

// Marcas que se reconocen EN EL TÍTULO (evidencia): canónica -> variantes que se buscan como palabras completas.
const MARCAS_EN_TITULO = {
  'MAGESA': ['MAGESA'], 'SILFAB': ['SILFAB'], 'MUGI': ['MUGI'], 'ASPEN': ['ASPEN'], 'SAN UP': ['SAN UP', 'SANUP'], 'SUNCARE': ['SUNCARE'],
  'CARE-QUIP': ['CARE QUIP', 'CAREQUIP'], 'OTTOBOCK': ['OTTOBOCK', 'OTTO BOCK'], 'YUWELL': ['YUWELL'], 'WOLKE': ['WOLKE'], 'DELLAMED': ['DELLAMED'],
  'INTCO MEDICAL': ['INTCO'], 'TRINIDAD': ['TRINIDAD'], 'RN LEDESMA': ['LEDESMA'], 'IMEX ELDORADO': ['IMEX'], 'ORANGE MARK': ['ORANGE MARK'], 'EUROWISS': ['EUROWISS'],
  'ANTARES': ['ANTARES'], 'TIM': ['TIM'], 'IALLO': ['IALLO'], 'MEDLINE': ['MEDLINE'], 'MOVICARE': ['MOVICARE'], 'SPEEDY': ['SPEEDY'], 'INFINITY': ['INFINITY'],
  'DRIVE MEDICAL': ['DRIVE'], 'VERMEIREN': ['VERMEIREN'], 'ORTOPEDIA BELGRANO': ['ORTOPEDIA BELGRANO', 'ORT BELGRANO'], 'FIX SALUD': ['FIX SALUD'], 'S360': ['S360'],
  'THERAMART': ['THERAMART'], 'MERITS': ['MERITS'], 'HILPHY MEDICAL': ['HILPHY'], 'QUIROMED': ['QUIROMED'], 'AMERICAN SURGERY': ['AMERICAN SURGERY'], 'D.E.M.A.': ['DEMA'],
};
// "Simil Ottobock", "ex Ottobock", "tipo Ottobock", "compatible con Magesa" NO son la marca Ottobock/Magesa: la palabra anterior descalifica la mención.
const PALABRA_QUE_DESCALIFICA = new Set(['SIMIL', 'SIMILAR', 'TIPO', 'EX', 'ESTILO', 'COMPATIBLE', 'COMO', 'REPLICA', 'IMITACION', 'GENERICO', 'GENERICA', 'PARA', 'CON']);
function marcaEnTitulo(tituloPal) {
  const t = ' ' + tituloPal + ' ';
  const halladas = [];
  for (const [marca, vars] of Object.entries(MARCAS_EN_TITULO)) {
    for (const v of vars) {
      const i = t.indexOf(' ' + v + ' ');
      if (i < 0) continue;
      const previa = t.slice(0, i).trim().split(' ').pop();
      if (PALABRA_QUE_DESCALIFICA.has(previa)) continue;
      halladas.push({ marca, pos: i }); break;
    }
  }
  halladas.sort((a, b) => a.pos - b.pos);
  return halladas.map((h) => h.marca);
}
function normalizarMarca(b) {
  const clave = palabras(b);
  if (!clave) return '';
  if (MARCA_NO_ES_MARCA.has(clave) || /^(SIMIL|TIPO|SIMILAR|ESTILO) /.test(clave)) return '';
  const canon = ALIAS_MARCA[clave];
  if (canon) return canon;
  // lo que no está en la tabla propia de sillas: el diccionario general de variantes/errores de tipeo/basura (api/_nubi-marcas.js)
  const ck = claveMarca(b);
  if (Object.prototype.hasOwnProperty.call(DICT_MARCAS, ck)) return DICT_MARCAS[ck];
  return mayus(b).replace(/\s*[-–]\s*$/, '').trim();
}

// ───────────────────────── Modelo: códigos ─────────────────────────
// Un "código de modelo" tiene letras y números (YK9011, JL808, SRMT2041, I0041, C103, S3009, FS958LBC) o sólo números (130, 9031: numeración propia de algunas marcas).
const CODIGO_LETRAS_NUM = /^[A-Z]{1,6}\d{2,6}[A-Z]{0,4}\d{0,4}$/;
const CODIGO_SOLO_NUM = /^\d{3,5}$/;
const ES_MEDIDA = /^(\d{1,3}(CM|KG|X\d{1,3}|MM|L|LT|LTS|V|W|A|AH|HZ)|\d{1,3}X\d{1,3}(CM)?|[A-Z]\d{1,2}X\d{1,2})$/;   // 46CM, 120KG, 30X20, 24V
const CODIGO_NUM_LETRAS = /^\d{2,4}[A-Z]{1,3}\d{0,3}$/;
const ES_DIAS_ALQUILER = /^X\d{1,2}$/;
// código base (1 a 3 letras + 4 dígitos) con el ancho de la silla pegado detrás (14 a 24 pulgadas, o 35 a 52 cm): YK903145 = YK9031 + 45, S301546 = S3015 + 46
const CODIGO_CON_ANCHO = /^([A-Z]{1,3}\d{4})(1[4-9]|2[0-4]|3[5-9]|4\d|5[0-2])$/;
const CODIGO_NUM_CON_ANCHO = /^(\d{3}[A-Z]{1,2})(3[5-9]|4\d|5[0-2])$/;   // 803LB38 = 803LB + 38 cm
const sacarAncho = (c) => { const m = String(c).match(CODIGO_CON_ANCHO) || String(c).match(CODIGO_NUM_CON_ANCHO); return m ? m[1] : c; };
const ES_CODIGO_LN = (t) => (CODIGO_LETRAS_NUM.test(t) || CODIGO_NUM_LETRAS.test(t)) && !ES_MEDIDA.test(t) && !ES_DIAS_ALQUILER.test(t) && !/^(KG|CM)/.test(t);
// palabras del producto que NO son un modelo si vienen solas
const PALABRAS_PRODUCTO = new Set(['SILLA', 'SILLAS', 'RUEDAS', 'RUEDA', 'DESMONTABLE', 'PLEGABLE', 'FIJA', 'FIJO', 'FIJAS', 'FIJOS', 'ACERO', 'ALUMINIO', 'REFORZADA', 'TRASLADO', 'TRANSPORTE', 'POSTURAL',
  'ORTOPEDICA', 'MANUAL', 'ADULTO', 'PEDIATRICA', 'ELECTRICA', 'MOTORIZADA', 'LIVIANA', 'BARIATRICA', 'RECLINABLE', 'CROMADA', 'CROMADO', 'TIPO', 'SIMIL', 'MODELO', 'IMPORTADA', 'IMPORTADO', 'NACIONAL',
  'ECONOMICA', 'ECO', 'PREMIUM', 'BASICA', 'COMUN', 'CLASICA', 'ESTANDAR']);
// prefijos pegados por Nubi al modelo ("DESMONTABLEJL901", "FIJAJL809"): se sacan si lo que queda es un código
const PREFIJOS_PEGADOS = ['SILLADERUEDAS', 'SILLARUEDAS', 'SEMIDESMONTABLE', 'DESMONTABLE', 'PLEGABLE', 'TRANSPORTE', 'TRASLADO', 'REFORZADA', 'POSTURAL', 'ELECTRICA', 'MODELO', 'SILLA', 'FIJA', 'FIJO', 'TIPO', 'MOD'];

function tokensTitulo(t) { return palabras(t).split(' ').filter(Boolean); }
// códigos que aparecen como palabra en el título (en orden)
function codigosDeTitulo(t) {
  const out = [];
  for (const w of tokensTitulo(t)) if (ES_CODIGO_LN(w) && !out.includes(w)) out.push(w);
  return out;
}

// Modelo curado de una silla de ruedas. `campo` = modelo según Nubi, `titulo`, `sku`. Devuelve { m, razon }.
function modeloSilla(campo, titulo, sku) {
  const bruto = mayus(campo);
  const compacto = bruto.replace(/[^A-Z0-9]/g, '');
  const deTitulo = codigosDeTitulo(titulo);
  // 1) el campo es un código limpio -> se respeta (salvo "YK901218" = YK9012 + ancho 18")
  if (compacto && (ES_CODIGO_LN(compacto) || CODIGO_SOLO_NUM.test(compacto) || /^\d{2}X\d{2}$/.test(compacto))) {
    const base = sacarAncho(compacto);
    if (base !== compacto) return { m: base, razon: 'modelo: se sacó el ancho pegado' };
    return { m: compacto, razon: '' };
  }
  // 2) el campo trae un código del título pegado a palabras ("DESMONTABLEJL901") -> el código del título
  if (compacto) {
    const hit = deTitulo.find((c) => compacto.includes(c));
    if (hit) return { m: sacarAncho(hit), razon: 'modelo: código del título dentro del campo' };
    // 3) prefijos/sufijos pegados ("FIJAJL809" sin ese código en el título): se sacan palabras del producto y de medida
    let rest = compacto, cambio = true;
    while (cambio && rest) { cambio = false; for (const p of PREFIJOS_PEGADOS) if (rest.startsWith(p) && rest.length > p.length) { rest = rest.slice(p.length); cambio = true; } }
    rest = rest.replace(/(ADULTO|PEDIATRICA?|\d{2,3}KG|\d{2}CM)$/g, '');
    rest = sacarAncho(rest);
    // un número solo sacado de una frase ("POSTURAL384146CM" -> 384) no es un modelo: sólo se acepta si trae letras
    if (rest !== compacto && rest && ES_CODIGO_LN(rest)) return { m: rest, razon: 'modelo: se sacaron palabras pegadas' };
  }
  // 4) campo inútil (frase del título, medida, palabra de producto, vacío): el código del título; si no, el SKU si parece un modelo
  const esFrase = compacto.length > 14 && !/\d/.test(compacto);
  const esMed = ES_MEDIDA.test(compacto);
  const esPalabra = PALABRAS_PRODUCTO.has(compacto) || MODELO_BASURA.test(bruto);
  const arrancaConProducto = [...PALABRAS_PRODUCTO, ...PREFIJOS_PEGADOS].some((w) => w.length >= 5 && compacto.startsWith(w));
  if (!compacto || esFrase || esMed || esPalabra || arrancaConProducto || /^(SILLADERUEDAS|SILLARUEDAS)/.test(compacto)) {
    if (deTitulo.length) return { m: sacarAncho(deTitulo[0]), razon: compacto ? 'modelo: el campo no era un modelo, se tomó el del título' : 'modelo: faltaba, se tomó el del título' };
    const s = mayus(sku).replace(/[^A-Z0-9]/g, '');
    if (s && ES_CODIGO_LN(s)) return { m: sacarAncho(s), razon: 'modelo: faltaba, se tomó el SKU' };
    return { m: '', razon: compacto ? 'modelo: el campo no era un modelo' : '' };
  }
  // 5) nombre de modelo (letras): se respeta si es corto ("ELITE", "MOVIXLITE"); si es largo y sin números es una frase -> se descarta (arriba)
  if (!/\d/.test(compacto)) {
    // un nombre de modelo sin números ("ELITE", "MOVIXLITE") sólo vale si figura en el título como palabra (o dos palabras juntas); si no, es basura pegada por Nubi ("FIJATRINI")
    const w = tokensTitulo(titulo);
    const enTitulo = w.some((x, i) => x === compacto || (w[i + 1] && x + w[i + 1] === compacto));
    return enTitulo && compacto.length <= 14 ? { m: compacto, razon: '' } : { m: '', razon: 'modelo: el campo no figura en el título' };
  }
  return { m: compacto.length <= 24 ? compacto : '', razon: compacto.length <= 24 ? '' : 'modelo: demasiado largo para ser un modelo' };
}

// Marca curada de una silla de ruedas.
function marcaSilla(campo, titulo) {
  const pal = palabras(titulo);
  const enTit = marcaEnTitulo(pal);
  const norm = normalizarMarca(campo);
  const dicho = (m) => enTit.includes(m);
  if (!norm) {                                      // vacía / "genérico" / descripción del producto
    return enTit.length ? { b: enTit[0], razon: 'marca: faltaba, se tomó la del título' } : { b: SIN_MARCA, razon: campo ? 'marca: el campo no era una marca' : '' };
  }
  const cambio = norm !== mayus(campo) ? 'marca: unificada con sus variantes' : '';
  // 30/10/2026: el objetivo es UNIFICAR variantes (no reasignar): una marca cargada en el campo se respeta aunque el título nombre otra; sólo se completa cuando el campo está vacío o no es una marca.
  return { b: norm, razon: cambio };
}

// ───────────────────────── Reglas generales (todas las subcategorías menos Sillas de ruedas, que tiene las suyas) ─────────────────────────
// MARCA: se unen las variantes de escritura (puntos, espacios, guiones, "ARGENTINA"/"S.A.") y los errores de tipeo claros según el diccionario generado (api/_nubi-marcas.js);
// "genérico", "sin marca", "importado"... no son una marca ('' = sin marca). Una marca que no está en el diccionario queda como venía (en mayúsculas, con sus tildes).
function marcaGeneral(b0) {
  const b = String(b0 == null ? '' : b0).trim();
  if (!b) return '';
  const ck = claveMarca(b);
  if (Object.prototype.hasOwnProperty.call(DICT_MARCAS, ck)) return DICT_MARCAS[ck];
  return b.toUpperCase();
}
// MODELO: en estas categorías Nubimetrics suele traer el nombre/código del producto con el texto pegado y sin espacios. Reglas:
//  1) sin basura (N/A, GENÉRICO...) y sin espacios/guiones internos, para que "ME 23-C" y "ME23C" sean el mismo;
//  2) se saca la marca pegada al principio ("FREESTYLELIBRE2PLUS" de FREESTYLE -> "LIBRE2PLUS"); un modelo igual a la marca no es un modelo;
//  3) un CÓDIGO (1 a 6 letras + 2 a 5 números + 1 letra opcional) con texto pegado detrás se queda con el código ("ME23C1520MMHG", "ME23CFULL" -> "ME23C"; "AIRSENSE10AUTOSET" -> "AIRSENSE10"):
//     los códigos con un solo número (LIBRE2 / LIBRE2PLUS) no se tocan porque suelen ser productos distintos.
const DESCRIPTORES = new Set(['FULL', 'PLUS', 'PRO', 'MAX', 'MINI', 'KIT', 'KITS', 'SET', 'PACK', 'COMBO', 'BASIC', 'BASICO', 'PREMIUM', 'DELUXE', 'STANDARD', 'ORIGINAL', 'SPORT', 'LITE', 'SMART', 'ULTRA', 'NEO']);
function modeloGeneral(m0, marca) {
  let c = modeloBasico(m0).replace(/[^A-Z0-9]/g, '');
  if (!c) return '';
  const bk = marca ? claveMarca(marca) : '';
  if (bk && c === bk) return '';
  // marca pegada al principio: se saca sólo si lo que queda empieza con una letra y no es una palabra suelta sin sentido ("URBEFULL" -> "FULL" no)
  if (bk.length >= 4 && c.indexOf(bk) === 0) {
    const resto = c.slice(bk.length);
    if (resto.length >= 4 && /^[A-Z]/.test(resto) && !DESCRIPTORES.has(resto)) c = resto;
  }
  // código + texto pegado: el código (letras + números completos, sin partir el número) y, si lo sigue UNA letra y un número ("ME23C1520MMHG"), esa letra; se corta si queda texto de 3 o más caracteres
  const k = c.match(/^[A-Z]{1,6}\d{2,5}(?!\d)/);
  if (k) {
    let core = k[0], resto = c.slice(core.length);
    if (/^[A-Z]\d/.test(resto)) { core += resto[0]; resto = resto.slice(1); }
    if (resto.length >= 3 && !ES_MEDIDA.test(core)) c = core;
  }
  return c.length > 30 ? c.slice(0, 30) : c;
}

const esSilla = (c3, c4) => /SILLAS DE RUEDAS/i.test(mayus(c3)) && mayus(c4) === 'SILLAS DE RUEDAS';

// ───────────────────────── Entrada principal ─────────────────────────
function curar(p) {
  const b0 = String(p.b == null ? '' : p.b).trim(), m0 = String(p.m == null ? '' : p.m).trim();
  if (esSilla(p.c3, p.c4)) {
    const mm = modeloSilla(m0, p.t, p.sku);
    const bb = marcaSilla(b0, p.t);
    return { b: bb.b === SIN_MARCA ? '' : bb.b, m: mm.m, b0, m0, razon: [bb.razon, mm.razon].filter(Boolean).join(' · ') };
  }
  // resto de las subcategorías (30/10/2026, "avanzá con el resto de las categorías"): reglas GENERALES y conservadoras -- ver marcaGeneral / modeloGeneral
  const bg = marcaGeneral(b0);
  return { b: bg, m: modeloGeneral(m0, bg), b0, m0, razon: '' };
}

// Clave de agrupación del modelo: un código con letras y números identifica el modelo aunque lo vendan con distintas marcas (YK9031 de Magesa, Trinidad, Intco);
// un número solo o un nombre corto sólo vale dentro de su marca.
function claveModelo(marca, modelo) {
  if (!modelo) return '';
  return CODIGO_LETRAS_NUM.test(modelo) && /[A-Z]/.test(modelo) ? modelo : (marca || SIN_MARCA) + '|' + modelo;
}

module.exports = { curar, modeloBasico, claveModelo, normalizarMarca, esSilla, SIN_MARCA };
