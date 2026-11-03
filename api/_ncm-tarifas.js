// Impuestos de importación por posición NCM, tomados del Arancel Integrado Aduanero de ARCA (el mismo archivo que publica ARCA y actualiza a diario):
//   https://serviciosweb.afip.gob.ar/aduana/arancelintegrado/archivos/arancel.zip  ->  capitulo_*.txt, nomenclador_DDMMAAAA.txt, sufijos_*.txt
// Formato del nomenclador (registro tipo 2, campos separados por '@'; las alícuotas son EEE.DD):
//   2@8713.10.00.000F @expo@reintegro extrazona@DERECHO IMPORTACIÓN EXTRAZONA@reintegro intrazona@derecho importación intrazona@específico mínimo@unidad@unidad esp.@texto
// El código es posición(8) + SIM(3) + letra de control; una misma NCM puede tener varias líneas SIM. DIE = derecho para mercadería de fuera del Mercosur (ej. China);
// DII = derecho para origen Mercosur. La tasa de estadística (3%) y el IVA NO vienen en este archivo.
const zlib = require('zlib');

const URL_ARANCEL = 'https://serviciosweb.afip.gob.ar/aduana/arancelintegrado/archivos/arancel.zip';
const alicuota = (t) => (String(t).trim() === '' ? null : Number(t));

// texto del nomenclador (latin1) -> Map(ncm8 -> [die, dieMax|null, dii, especificoMin, reintegroExtrazona])
function tarifasDeNomenclador(texto) {
  const porNcm = new Map();
  for (const linea of String(texto).split(/\r?\n/)) {
    if (!linea.startsWith('2@')) continue;
    const p = linea.split('@');
    const m = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d{3})[A-Z]?$/.exec((p[1] || '').trim());
    if (!m) continue;
    const ncm = m[1] + m[2] + m[3];
    if (!porNcm.has(ncm)) porNcm.set(ncm, []);
    porNcm.get(ncm).push({ sim: m[4], reint: alicuota(p[3]), die: alicuota(p[4]), dii: alicuota(p[6]), esp: alicuota(p[7]) });
  }
  const res = new Map();
  for (const [ncm, filas] of porNcm) {
    const con = filas.filter((f) => f.die != null);
    const base = filas.find((f) => f.sim === '000' && f.die != null) || con[0] || filas[0];
    const dies = con.map((f) => f.die);
    const dieMax = dies.length && Math.max(...dies) > base.die ? Math.max(...dies) : null; // algunos SIM de una misma NCM pagan distinto
    res.set(ncm, [base.die, dieMax, base.dii, base.esp, base.reint]);
  }
  return res;
}

// Lector mínimo de zip (central directory + deflate, con soporte ZIP64: el zip de ARCA lo usa), sin dependencias. -> Map(nombre -> Buffer)
function leerZip(buf) {
  let fin = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) if (buf.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  if (fin < 0) throw new Error('El archivo descargado no es un zip válido.');
  let total = buf.readUInt16LE(fin + 10);
  let pos = buf.readUInt32LE(fin + 16);
  if (pos === 0xffffffff || total === 0xffff) { // ZIP64: el directorio central se ubica con el localizador que precede al fin de directorio
    const loc = fin - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== 0x07064b50) throw new Error('Zip64 sin localizador.');
    const z = Number(buf.readBigUInt64LE(loc + 8));
    if (buf.readUInt32LE(z) !== 0x06064b50) throw new Error('Zip64 dañado.');
    total = Number(buf.readBigUInt64LE(z + 32));
    pos = Number(buf.readBigUInt64LE(z + 48));
  }
  const out = new Map();
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('Zip dañado (directorio central).');
    const metodo = buf.readUInt16LE(pos + 10);
    let tamComp = buf.readUInt32LE(pos + 20), tamReal = buf.readUInt32LE(pos + 24), local = buf.readUInt32LE(pos + 42);
    const nLen = buf.readUInt16LE(pos + 28), eLen = buf.readUInt16LE(pos + 30), cLen = buf.readUInt16LE(pos + 32);
    const nombre = buf.slice(pos + 46, pos + 46 + nLen).toString('latin1');
    // campo extra ZIP64 (id 1): trae, en este orden, solo los valores que en la cabecera valen 0xFFFFFFFF
    let e = pos + 46 + nLen;
    const finExtra = e + eLen;
    while (e + 4 <= finExtra) {
      const id = buf.readUInt16LE(e), len = buf.readUInt16LE(e + 2);
      if (id === 1) {
        let o = e + 4;
        if (tamReal === 0xffffffff) { tamReal = Number(buf.readBigUInt64LE(o)); o += 8; }
        if (tamComp === 0xffffffff) { tamComp = Number(buf.readBigUInt64LE(o)); o += 8; }
        if (local === 0xffffffff) { local = Number(buf.readBigUInt64LE(o)); o += 8; }
      }
      e += 4 + len;
    }
    const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const datos = buf.slice(ini, ini + tamComp);
    out.set(nombre, metodo === 8 ? zlib.inflateRawSync(datos) : datos);
    pos += 46 + nLen + eLen + cLen;
  }
  return out;
}

// Baja el zip de ARCA y devuelve { tarifas: Map, fecha: 'DDMMAAAA' }.
async function descargarArancelArca() {
  const r = await fetch(URL_ARANCEL, { headers: { 'User-Agent': 'Mozilla/5.0 (panel ICOM)' } });
  if (!r.ok) throw new Error(`ARCA respondió ${r.status} al bajar el Arancel Integrado.`);
  const archivos = leerZip(Buffer.from(await r.arrayBuffer()));
  for (const [nombre, datos] of archivos) {
    const m = /nomenclador_(\d{8})\.txt$/i.exec(nombre);
    if (m) return { tarifas: tarifasDeNomenclador(datos.toString('latin1')), fecha: m[1] };
  }
  throw new Error('El zip de ARCA no trae el archivo nomenclador.');
}

module.exports = { tarifasDeNomenclador, leerZip, descargarArancelArca, URL_ARANCEL };
