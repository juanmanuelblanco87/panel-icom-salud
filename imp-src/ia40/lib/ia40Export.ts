/**
 * Cliente para el flujo de EXPORTACION de IA40 (Cobus Group), que es la
 * unica forma de obtener la columna "SUB ITEMS - SUFIJOS" (necesaria para
 * detectar marca/modelo automaticamente) y "SUB ITEMS - P.U. U$S". El
 * endpoint /data normal no trae esas columnas.
 *
 * Flujo real (capturado con DevTools mientras se exportaba a mano):
 *   1. POST /export/data  -> dispara la generacion del archivo. Responde
 *      enseguida con { link, processId, notificationId }. El archivo
 *      todavia puede no estar listo en ese momento.
 *   2. GET /notification/{notificationId} -> hay que consultarlo (con
 *      espera entre intentos) hasta que devuelva state:"FINISH". El campo
 *      "value" de esa respuesta es el link final de descarga (S3).
 *   3. Descargar ese link (CSV plano, sin auth adicional).
 */

import JSZip from "jszip";
import { Ia40AuthError, getFreshJwt } from "./ia40Token";

const BASE_URL = "https://api.cobusgroup.com/api/v1/f";

export { Ia40AuthError };

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-tool-request": "IA",
    "Content-Type": "application/json",
    Origin: "https://ia40.cobusgroup.com",
    Referer: "https://ia40.cobusgroup.com/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };
}

export interface Filter {
  field: string;
  values: string[];
}

interface TriggerExportParams {
  countryCodi: string;
  informationTypeCodi: string;
  operationTypeCodi: string;
  dateStart: string;
  dateEnd: string;
  filters: Filter[];
  exportName: string;
}

interface TriggerExportResult {
  link: string;
  processId: number;
  notificationId: number;
}

// Campos reales pedidos por la UI de IA40 al exportar (capturado del payload
// real via DevTools). "subitems.sufijo" es el que trae marca/modelo.
const EXPORT_FIELDS = [
  "nombre",
  "cuit",
  "subitems.precio_uni_dol_subitem",
  "subitems.precio_uni_divisa_subitem",
  "subitems.cant_decla_subitem",
  "subitems.fob_dolars_subitem",
  "subitems.fob_divisa_subitem",
  "moneda",
  "pais_ori_desc",
  "pais_pro_desc",
  "aduana_desc",
  "medio_desc",
  "fecha",
  "despacho",
  "item",
  "subitems.subitem",
  "posicion_arancelaria",
  "posicion_descripcion",
  "subitems_count",
  "subitems.codigo_articulo",
  "subitems.sufijo",
  "tipo_doc",
  "tipo_doc_desc",
  "tipo_desti",
  "puerto_descrip",
  "fob_dolars_item",
  "fob_divisa_item",
  "precio_uni_dol_item",
  "precio_uni_divisa_item",
  "fle_dolars_item",
  "fle_divisa_item",
  "seg_dolars_item",
  "seg_divisa_item",
  "cif_dolars_item",
  "tasa_cambio",
  "cant_decla_item",
  "uni_decla_desc",
  "cant_kilos_item",
  "base_imp",
  "fecha_momento",
  "div_fob",
  "kgs_neto",
  "ramo_desc",
  "estado_decl",
  "estadoarg",
  "condventa_desc",
  "tipoitem_desc",
  "derechos",
];

async function triggerExport(token: string, p: TriggerExportParams): Promise<TriggerExportResult> {
  const body = {
    countryCodi: p.countryCodi,
    informationTypeCodi: p.informationTypeCodi,
    operationTypeCodi: p.operationTypeCodi,
    dateRange: { start: p.dateStart, end: p.dateEnd },
    filters: p.filters,
    filtersOverwrites: { operator: {} },
    order: "fecha",
    orderType: "desc",
    pager: { start: 0, limit: 20 },
    ranking: "",
    searchSessionId: `sync${Date.now()}`,
    lastUpdated: Date.now(),
    stats: [],
    export: {
      name: p.exportName,
      ranking: "",
      fieldsConfig: { type: "all", fields: EXPORT_FIELDS },
      format: "csv",
      isRecurrent: false,
      formatConfig: {
        fieldSeparator: ";",
        customSeparatorColumnsBy: "",
        quoteStrings: '"',
        decimalSeparator: ",",
        separatorThousands: ".",
      },
      recurrentLookbackMonths: null,
      sendToMail: false,
      level: "subitems",
      page: 0,
      onlyOnePage: false,
    },
  };

  const resp = await fetch(`${BASE_URL}/export/data`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (resp.status === 401) {
    throw new Ia40AuthError("JWT invalido/expirado al pedir la exportacion.");
  }
  if (!resp.ok) {
    throw new Error(`export/data respondio ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

async function checkNotification(
  token: string,
  notificationId: number
): Promise<{ state: string; value: string | null; raw: any }> {
  const resp = await fetch(`${BASE_URL}/notification/${notificationId}`, {
    headers: headers(token),
    cache: "no-store",
  });
  if (resp.status === 401) {
    throw new Ia40AuthError("JWT invalido/expirado al consultar la notificacion.");
  }
  if (!resp.ok) {
    throw new Error(`notification respondio ${resp.status}: ${await resp.text()}`);
  }
  const json = await resp.json();
  return { state: json.state, value: json.value ?? null, raw: json };
}

async function waitForExportFile(
  token: string,
  notificationId: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 4_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await checkNotification(token, notificationId);
    if (status.state === "FINISH" && status.value) {
      return status.value;
    }
    if (status.state === "ERROR" || status.state === "FAILED") {
      // Diagnostico: incluimos la respuesta cruda de la notificacion por si
      // IA40 mando algun detalle del motivo (campo message/error/etc.), asi
      // la proxima vez que pase no hay que adivinar.
      throw new Error(
        `La exportacion en IA40 termino con estado ${status.state}. Respuesta completa: ${JSON.stringify(status.raw)}`
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timeout esperando que la exportacion de IA40 termine.");
}

/**
 * BUG ENCONTRADO 15/07/2026 (hipotesis del usuario, confirmada por como
 * encajaba con el sintoma): para exports GRANDES (miles de filas: andadores,
 * almohadones_ortopedicos, sillas_ducha), IA40 no siempre entrega el archivo
 * como CSV plano -- a veces lo entrega comprimido en un ZIP (probablemente
 * quien decide esto es el propio backend de IA40 segun el tamano del
 * archivo). El codigo anterior asumia siempre texto plano (`resp.text()`) y
 * trataba de parsearlo directo como CSV: como un ZIP es binario, al
 * "parsearlo" como CSV daba un header de basura que no calzaba con ninguna
 * columna esperada ("RAZON SOCIAL", "CUIT", etc.), asi que TODAS las filas
 * terminaban con los mismos campos vacios/null -- de ahi que
 * unique_hashes_in_batch diera 1 (todas las filas hasheaban igual, por tener
 * el mismo contenido vacio) aun con miles de "filas" fantasma detectadas.
 *
 * Fix: se descarga como binario, se detecta la firma ZIP ("PK", bytes 50 4B
 * 03 04) en vez de confiar en el content-type (que puede decir text/csv
 * igual aunque el contenido real sea un zip), y si es zip se descomprime
 * con JSZip antes de parsear como CSV.
 */
async function downloadExportFile(url: string): Promise<string> {
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`No se pudo descargar el archivo de exportacion (${resp.status})`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());

  const isZip =
    buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;

  if (!isZip) {
    return buffer.toString("utf-8");
  }

  const zip = await JSZip.loadAsync(buffer);
  const fileNames = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  if (fileNames.length === 0) {
    throw new Error("El archivo descargado es un ZIP pero no contiene ningun archivo adentro.");
  }
  // Se espera un unico CSV adentro del zip; si hay varios, se prioriza el
  // que termine en .csv y si no se toma el primero.
  const csvEntry = fileNames.find((name) => name.toLowerCase().endsWith(".csv")) ?? fileNames[0];
  return zip.files[csvEntry].async("string");
}

/**
 * Parser de CSV simple para el separador ";" con calificador de texto '"'
 * (la config que usa IA40). No es un parser CSV general de proposito
 * completo, pero cubre bien el caso real de estos exports.
 */
function parseExportCsv(csvText: string): Record<string, string>[] {
  const lines = csvText.split(/\r\n|\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  function splitLine(line: string): string[] {
    const fields: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ";") {
        fields.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
    fields.push(cur);
    return fields;
  }

  const headerCols = splitLine(lines[0]).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitLine(lines[i]);
    const row: Record<string, string> = {};
    headerCols.forEach((h, idx) => {
      row[h] = (values[idx] ?? "").trim();
    });
    rows.push(row);
  }
  return rows;
}

/** "12.480,50" o "32,00" (formato arg, coma decimal) -> 12480.5 / 32 */
function parseArgNumber(v: string | undefined): number | null {
  if (!v) return null;
  const cleaned = v.replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

/**
 * Convierte los campos numericos de montos de la exportacion de IA40
 * ("SUB ITEMS - FOB U$S", "SUB ITEMS - CANTIDAD", "SUB ITEMS - P.U. U$S")
 * soportando los dos formatos que en la practica manda IA40:
 *   - Formato argentino: "." = miles, "," = decimal (ej. "11.748,24").
 *   - Formato plano: "." = decimal, SIN separador de miles (ej. "2623.68",
 *     o "10870.2" cuando el centavo termina en 0 y IA40 recorta el cero).
 * Si el string trae coma, se asume formato argentino. Si no trae coma pero
 * si trae punto, se asume que el punto es el separador decimal (no de
 * miles) y se parsea directo.
 *
 * BUG HISTORICO (encontrado 15/07/2026): "SUB ITEMS - FOB U$S" viene
 * siempre en formato plano (sin coma), pero se parseaba con
 * parseArgNumber, que le borraba el punto pensando que era separador de
 * miles: "2623.68" -> "262368" (x100 de mas) o "10870.2" -> "108702" (x10
 * de mas, cuando quedaba un solo decimal por el cero recortado). Esto
 * inflaba el FOB guardado en trade_records entre 10x y 100x segun la
 * cantidad de decimales del valor real. Confirmado comparando trade_records
 * contra datos crudos de aduana para KI Mobility / FOCUS CR. Ver migracion
 * de recalculo (fix_fob_inflado.sql) para los datos ya sincronizados antes
 * de este fix.
 */
function parseMoneyOrPlain(v: string | undefined): number | null {
  if (!v) return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  if (trimmed.includes(",")) {
    return parseArgNumber(trimmed);
  }
  const cleaned = trimmed.replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

/**
 * Pide la exportacion completa (con Sufijos) para un rango de fechas +
 * filtro de posicion arancelaria, espera a que termine, la descarga, y
 * devuelve filas normalizadas con las MISMAS claves que ya usa el resto
 * del pipeline (nombre, fecha, fob_dolars_item, cant_decla_item, etc.),
 * mas dos claves nuevas: "sufijos" y "precio_unitario", para el parser de
 * marca/modelo.
 */
type ExportParams = {
  countryCodi: string;
  informationTypeCodi: string;
  operationTypeCodi: string;
  dateStart: string;
  dateEnd: string;
  ncmCode: string;
};

// 13/10/2026: el acceso (JWT) se pide "a demanda" (ver lib/ia40Token.ts); si Cobus responde 401 a mitad de camino (el token dura ~15 min y una exportacion grande
// puede tardar) se renueva UNA vez y se repite el pedido completo.
export async function fetchIa40ExportRows(params: ExportParams): Promise<any[]> {
  try {
    return await fetchIa40ExportRowsConToken(params, await getFreshJwt());
  } catch (err) {
    if (!(err instanceof Ia40AuthError)) throw err;
    return await fetchIa40ExportRowsConToken(params, await getFreshJwt({ forzar: true }));
  }
}

async function fetchIa40ExportRowsConToken(params: ExportParams, token: string): Promise<any[]> {

  const { notificationId } = await triggerExport(token, {
    countryCodi: params.countryCodi,
    informationTypeCodi: params.informationTypeCodi,
    operationTypeCodi: params.operationTypeCodi,
    dateStart: params.dateStart,
    dateEnd: params.dateEnd,
    filters: [{ field: "posicion_arancelaria", values: [params.ncmCode] }],
    exportName: `SYNC_${params.ncmCode}_${Date.now()}`,
  });

  const downloadUrl = await waitForExportFile(token, notificationId);
  const csvText = await downloadExportFile(downloadUrl);
  const csvRows = parseExportCsv(csvText);

  // Diagnostico temporal: si no se parseo ninguna fila, tiramos un error
  // con un adelanto del contenido descargado para poder ver en la
  // respuesta de /api/sync que fue lo que realmente devolvio IA40 (en vez
  // de fallar en silencio con fetched:0 sin explicacion).
  if (csvRows.length === 0) {
    throw new Error(
      `Export devolvio 0 filas parseadas. downloadUrl=${downloadUrl} | largo del texto descargado=${csvText.length} | contenido completo (o primeros 6000 caracteres): ${csvText.slice(0, 6000)}`
    );
  }

  return csvRows.map((row) => ({
    nombre: row["RAZÓN SOCIAL"] ?? "",
    cuit: row["CUIT"] ?? null,
    fecha: row["FECHA"] ?? null,
    despacho: row["DESPACHO"] ?? null,
    item: row["ITEM"] ?? null,
    aduana_desc: row["ADUANA"] ?? null,
    posicion_arancelaria: row["POSICIÓN ARANCELARIA"] ?? null,
    posicion_descripcion: row["DESCRIPCIÓN DE LA POSICIÓN"] ?? null,
    fob_dolars_item: parseMoneyOrPlain(row["SUB ITEMS - FOB U$S"]),
    cant_decla_item: parseMoneyOrPlain(row["SUB ITEMS - CANTIDAD"]),
    precio_unitario: parseMoneyOrPlain(row["SUB ITEMS - P.U. U$S"]),
    sufijos: row["SUB ITEMS - SUFIJOS"] ?? "",
  }));
}
