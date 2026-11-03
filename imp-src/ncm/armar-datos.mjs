// Arma api/_ncm-datos.json combinando tres fuentes oficiales de la NCM (Mercosur):
//   1) Siscomex (Brasil, JSON, vigente, en portugués): da los códigos de 8 dígitos y la jerarquía actuales.
//   2) Arancel Externo Común Argentina (PDF de argentina.gob.ar, NCM 2017, en español): da el texto en español de cada posición.
//   3) Arancel Integrado Aduanero de ARCA (nomenclador_DDMMAAAA.txt del zip de serviciosweb.afip.gob.ar/aduana/arancelintegrado/archivos/arancel.zip,
//      actualizado a diario): da los derechos de importación VIGENTES de cada posición de 8 dígitos. Es la fuente de impuestos; define qué códigos existen en Argentina.
// Uso:  pdftotext -raw -enc UTF-8 nomenclatura_comun_del_mercosur_ncm.pdf ncm_ar_raw.txt
//       node imp-src/ncm/armar-datos.mjs <ncm_br.json> <ncm_ar_raw.txt> <nomenclador_DDMMAAAA.txt>
// Cada código de 8 dígitos queda con su camino completo (capítulo > partida > subpartidas > ítem), porque los ítems hoja
// suelen decir solo "Los demás" y el significado está en los padres. Los textos se guardan una sola vez (tabla "textos").
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const aca = dirname(fileURLToPath(import.meta.url));
const { tarifasDeNomenclador } = createRequire(import.meta.url)("../../api/_ncm-tarifas.js");
const [rutaBr, rutaAr, rutaArca] = process.argv.slice(2);
if (!rutaBr || !rutaAr || !rutaArca) throw new Error("Uso: node armar-datos.mjs <ncm_br.json> <ncm_ar_raw.txt> <nomenclador_DDMMAAAA.txt>");

const limpiar = (t) => t.replace(/<[^>]+>/g, "").replace(/^[\s\-–]+/, "").replace(/\s+/g, " ").trim();

// --- 1) Lista vigente (portugués) ---
const br = JSON.parse(readFileSync(rutaBr, "utf8"));
const nodos = br.Nomenclaturas.map((n) => ({ dig: n.Codigo.replace(/\D/g, ""), pt: limpiar(n.Descricao) })).filter((n) => n.dig);

// --- 2) Texto en español del PDF argentino ---
// Se lee la extracción en modo "raw" (pdftotext -raw -enc UTF-8): conserva el orden real código -> descripción; el modo de diseño separa los códigos de sus textos.
const lineas = readFileSync(rutaAr, "utf8").split(/\r?\n/);
const RE_CODIGO = /^(\d{2}\.\d{2}|\d{4}(?:\.\d{1,2}){1,2})\s+(.*)$/;
// Al final de cada renglón vienen las columnas: AEC (entero), marca BK/BIT y alícuotas con coma (7,50). Se quitan hasta 4 tokens así.
const sinColumnas = (t) => {
  const tok = t.trim().split(/\s+/);
  let n = 0;
  while (tok.length > 1 && n < 4 && /^(BK|BIT|RE|NT|\d{1,2}(,\d{1,2})?)$/.test(tok[tok.length - 1])) { tok.pop(); n++; }
  return tok.join(" ");
};
const es = new Map(); // dígitos -> descripción
let ultimo = null; // última posición con código (a la que se pega un renglón de continuación)
for (const linea of lineas) {
  if (/^IF-\d{4}|^página \d+ de \d+|^Arancel Externo|^NCM DESCRIPCI|^ANEXO I|^RE$/.test(linea.trim())) continue;
  const m = RE_CODIGO.exec(linea);
  if (m) {
    const dig = m[1].replace(/\./g, "");
    const desc = limpiar(sinColumnas(m[2]));
    ultimo = dig;
    if (!es.has(dig) && desc) es.set(dig, desc);
    continue;
  }
  // Renglón sin código: o es continuación de la descripción anterior (no empieza con guion) o un nivel intermedio sin código ("- Los demás:"), que se ignora.
  if (/^-/.test(linea.trim())) { ultimo = null; continue; }
  if (ultimo && /^[A-Za-zÁÉÍÓÚÑáéíóúñ(«]/.test(linea.trim())) {
    const extra = limpiar(sinColumnas(linea));
    if (extra.length > 1) es.set(ultimo, `${es.get(ultimo) || ""} ${extra}`.trim());
  }
}

// --- 3) Impuestos de ARCA (por NCM de 8 dígitos) ---
const tarifas = tarifasDeNomenclador(readFileSync(rutaArca, "latin1"));

// --- Jerarquía por prefijo de dígitos y tabla de textos ---
const textos = []; // [portugués, español|""]
const idx = new Map();
const idDe = (pt, esp) => {
  const k = pt + "\u0001" + esp;
  if (!idx.has(k)) { idx.set(k, textos.length); textos.push([pt, esp]); }
  return idx.get(k);
};
const pila = [];
const codigos = [];
let conEs = 0;
for (const n of nodos) {
  while (pila.length && !n.dig.startsWith(pila[pila.length - 1].dig)) pila.pop();
  const e = es.get(n.dig) || "";
  const nodo = { dig: n.dig, id: idDe(n.pt, e), tieneEs: !!e };
  if (n.dig.length === 8 && tarifas.has(n.dig)) { // solo existen los códigos que figuran en el arancel argentino
    codigos.push([n.dig, [...pila.map((p) => p.id), nodo.id], tarifas.get(n.dig)]);
    if (e) conEs++;
  }
  pila.push(nodo);
}

writeFileSync(
  resolve(aca, "../../api/_ncm-datos.json"),
  JSON.stringify({ vigencia: br.Data_Ultima_Atualizacao_NCM, ato: br.Ato, fuenteEs: "AEC Argentina, NCM 2017 (argentina.gob.ar)", fuenteImpuestos: "Arancel Integrado ARCA " + (/nomenclador_(\d{8})/.exec(rutaArca)?.[1] || ""), formatoTarifa: "[die, dieMax|null, dii, especificoMin, reintegroExtrazona]", textos, codigos })
);
console.log(codigos.length, "códigos;", es.size, "descripciones en español leídas;", conEs, "hojas con español propio");
const ver = (d) => codigos.find(([c]) => c === d)?.[1].map((i) => textos[i][1] || "(pt) " + textos[i][0]).join("\n    > ");
console.log("87131000:\n    " + ver("87131000"));
console.log("90211099:\n    " + ver("90211099"));
