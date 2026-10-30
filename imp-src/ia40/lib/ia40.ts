import { Ia40AuthError, getFreshJwt } from "./ia40Token";

const BASE_URL = "https://api.cobusgroup.com/api/v1/f";
const PAGE_LIMIT = 50;

export interface Filter {
  field: string;
  values: string[];
}

export interface FetchDataParams {
  countryCodi: string;
  informationTypeCodi: string;
  operationTypeCodi: string;
  dateStart: string;
  dateEnd: string;
  filters: Filter[];
  maxRecords?: number;
}

export { Ia40AuthError };

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-tool-request": "IA",
    "Content-Type": "application/json",
    "Origin": "https://ia40.cobusgroup.com",
    "Referer": "https://ia40.cobusgroup.com/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };
}

// 13/10/2026: el acceso (JWT) se pide "a demanda" (ver lib/ia40Token.ts); si Cobus responde 401 a mitad de camino se renueva UNA vez y se reintenta.
export async function fetchIa40Data(params: FetchDataParams): Promise<{ rows: any[]; schema: any }> {
  try {
    return await fetchIa40DataConToken(params, await getFreshJwt());
  } catch (err) {
    if (!(err instanceof Ia40AuthError)) throw err;
    return await fetchIa40DataConToken(params, await getFreshJwt({ forzar: true }));
  }
}

async function fetchIa40DataConToken(params: FetchDataParams, token: string): Promise<{ rows: any[]; schema: any }> {

  const allRows: any[] = [];
  let schema: any = null;
  let start = 0;

  while (true) {
    const body = {
      countryCodi: params.countryCodi,
      informationTypeCodi: params.informationTypeCodi,
      operationTypeCodi: params.operationTypeCodi,
      dateRange: { start: params.dateStart, end: params.dateEnd },
      filters: params.filters,
      filtersOverwrites: { operator: {} },
      pager: { start, limit: PAGE_LIMIT },
      ranking: "",
      stats: [],
    };

    const resp = await fetch(`${BASE_URL}/data`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
      cache: "no-store",
    });

    if (resp.status === 401) {
      throw new Ia40AuthError(
        "El token guardado fue rechazado (401). Puede haber vencido: revisa el script local."
      );
    }
    if (!resp.ok) {
      throw new Error(`IA40 respondio ${resp.status}: ${await resp.text()}`);
    }

    const payload = await resp.json();
    const rows: any[] = payload.data ?? [];
    if (schema === null) schema = payload.schema ?? null;
    allRows.push(...rows);

    if (params.maxRecords && allRows.length >= params.maxRecords) {
      return { rows: allRows.slice(0, params.maxRecords), schema };
    }
    if (rows.length < PAGE_LIMIT) break;
    start += PAGE_LIMIT;
  }

  return { rows: allRows, schema };
}
