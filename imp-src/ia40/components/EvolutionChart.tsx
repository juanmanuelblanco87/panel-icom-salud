"use client";

import { useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

export interface SeriesPoint {
  period: string;
  marca: string | null;
  modelo: string | null;
  proveedor: string;
  color: string | null;
  segmento: string | null;
  total_fob_dolars: string | number;
  total_unidades: string | number;
  record_count: number;
}

export type Metric = "total_fob_dolars" | "total_unidades";

export interface PivotResult {
  rows: Record<string, any>[];
  keys: string[];
  periods: string[];
}

interface Props {
  data: SeriesPoint[];
  groupBy: "marca" | "modelo" | "proveedor";
  metric: Metric;
  /** Cuantas series individuales mostrar antes de agrupar el resto en "Otros". */
  topN?: number;
  /** Valores que siempre se muestran como serie propia (ej. "Mugi"/"Magesa"),
   * aunque no entren en el top natural por total acumulado. */
  pinnedKeys?: string[];
  /** Se llama cada vez que se recalcula el pivot, para que el padre pueda
   * mostrar la misma data en una tabla debajo del grafico. */
  onPivotChange?: (pivot: PivotResult) => void;
}

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/** "2026-04-01" -> "Abril 2026" */
export function formatPeriod(period: string): string {
  const [y, m] = period.split("-");
  const mes = MESES[Number(m) - 1] ?? m;
  return `${mes} ${y}`;
}

/** Sin decimales, con "." como separador de miles (formato AR). */
export function fmtNumber(n: number): string {
  return Math.round(n).toLocaleString("es-AR", { maximumFractionDigits: 0 });
}

/** Version compacta para el eje Y del grafico (ej. 1.500.000 -> "1,5M"). */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    return (n / 1_000_000).toLocaleString("es-AR", { maximumFractionDigits: 1 }) + "M";
  }
  if (abs >= 1_000) {
    return (n / 1_000).toLocaleString("es-AR", { maximumFractionDigits: 0 }) + "K";
  }
  return fmtNumber(n);
}

const OTROS_KEY = "Otros";
const TOTAL_KEY = "__total__";

/**
 * Pivotea la serie plana (una fila por mes+dimension) a un formato apto para
 * recharts, mostrando solo las `topN` series con mayor total acumulado (por
 * la metrica elegida) y agrupando el resto en una serie "Otros". Las series
 * quedan ordenadas de mayor a menor total, con "Otros" siempre al final.
 *
 * `pinnedKeys`: valores que siempre deben aparecer como serie individual
 * (ej. "Mugi"/"Magesa", nuestra marca y el lider del mercado), aunque su
 * total acumulado no alcance para entrar en el top natural. Ocupan lugar
 * dentro de las `topN` series (no se suman aparte), asi el grafico sigue
 * mostrando como maximo topN + "Otros" lineas.
 */
function pivot(
  data: SeriesPoint[],
  groupBy: Props["groupBy"],
  metric: Metric,
  topN: number,
  pinnedKeys: string[] = []
): PivotResult {
  const periods = Array.from(new Set(data.map((d) => d.period))).sort();

  // Total acumulado por key (para ordenar y elegir el top N).
  const totals = new Map<string, number>();
  for (const d of data) {
    const key = (d[groupBy] ?? "sin_dato") as string;
    totals.set(key, (totals.get(key) ?? 0) + Number(d[metric]));
  }

  const sortedKeys = Array.from(totals.keys()).sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));

  const pinnedPresent = pinnedKeys.filter((k) => totals.has(k));
  const remainingSorted = sortedKeys.filter((k) => !pinnedPresent.includes(k));
  const topRemaining = remainingSorted.slice(0, Math.max(0, topN - pinnedPresent.length));
  const topKeys = [...pinnedPresent, ...topRemaining].sort(
    (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0)
  );

  const topKeysSet = new Set(topKeys);
  const restKeys = new Set(sortedKeys.filter((k) => !topKeysSet.has(k)));
  const keys = restKeys.size > 0 ? [...topKeys, OTROS_KEY] : topKeys;

  const rows = periods.map((period) => {
    const row: Record<string, any> = { period };
    for (const key of keys) row[key] = 0;
    for (const d of data.filter((x) => x.period === period)) {
      const rawKey = (d[groupBy] ?? "sin_dato") as string;
      const key = restKeys.has(rawKey) ? OTROS_KEY : rawKey;
      row[key] = (row[key] ?? 0) + Number(d[metric]);
    }
    // 26/08/2026 ("coloca una linea de 'totales' para ver la evolucion
    // real de la categoria"): suma de TODAS las series del mes, top N +
    // "Otros" incluido -- osea la categoria entera, no solo el recorte
    // que se grafica por separado. Nombre con "__" para no chocar con
    // un key real (marca/modelo/proveedor) que se llame igual por
    // casualidad.
    row[TOTAL_KEY] = keys.reduce((acc, key) => acc + (Number(row[key]) || 0), 0);
    return row;
  });

  return { rows, keys, periods };
}

// 26/08/2026 ("curaduría de colores... azul - verde"): reemplazada por
// la misma paleta categórica ya establecida en el resto del panel de
// Icom Salud (ver DASH_PALETTE en icom_panel_unificado.html) -- azul/
// naranja/verde-azulado/ámbar más una variante más oscura de cada uno
// (incluido el navy de marca #1a3d70). La versión anterior mezclaba
// magenta (#e0397a), violeta (#9b30d9) y rojo (#d93a3a) -- ninguno con
// relación a la identidad de color del resto de la app, y el rojo en
// particular se confunde con estados de error/peligro. 9no color
// (#4a6fa5, azul grisáceo) agregado para no repetir ninguno de los 8
// ya usados en DASH_PALETTE con `topN` en 9.
const COLORS = [
  "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#1a3d70", "#0e7d5c",
  "#a8760a", "#b8491f", "#4a6fa5",
];
const OTROS_COLOR = "#8a95a0";

export default function EvolutionChart({ data, groupBy, metric, topN = 9, pinnedKeys = [], onPivotChange }: Props) {
  const result = pivot(data, groupBy, metric, topN, pinnedKeys);

  useEffect(() => {
    onPivotChange?.(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(result.keys), JSON.stringify(result.periods), groupBy, metric]);

  if (data.length === 0) {
    return <p style={{ color: "var(--muted)" }}>Todavia no hay datos sincronizados para esta seleccion.</p>;
  }

  const { rows, keys } = result;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 40 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e8e7e2" />
        {/* 26/08/2026 ("se rompen los graficos" en mobile): con ~19 meses
            de historial, las etiquetas horizontales del eje se pisaban
            entre si en una pantalla angosta (recharts no se salta
            ninguna por default). Inclinadas ocupan mucho menos ancho por
            etiqueta -- entran comodas tanto en mobile como en desktop,
            sin necesitar detectar el ancho real por JS. */}
        <XAxis
          dataKey="period"
          stroke="#999999"
          tickFormatter={formatPeriod}
          tick={{ fontSize: 10 }}
          angle={-40}
          textAnchor="end"
          height={48}
          interval="preserveStartEnd"
        />
        <YAxis stroke="#999999" tickFormatter={(v) => fmtCompact(Number(v))} tick={{ fontSize: 11 }} width={44} />
        <Tooltip
          contentStyle={{ background: "#ffffff", border: "1px solid #e8e7e2", borderRadius: 8 }}
          labelFormatter={(label) => formatPeriod(String(label))}
          formatter={(value: any) => fmtNumber(Number(value))}
        />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 16 }} />
        {keys.map((key, i) => (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            stroke={key === OTROS_KEY ? OTROS_COLOR : COLORS[i % COLORS.length]}
            strokeWidth={2}
            dot={false}
            strokeDasharray={key === OTROS_KEY ? "4 3" : undefined}
          />
        ))}
        {/* 26/08/2026 ("coloca una linea de 'totales' para ver la
            evolucion real de la categoria"): suma de TODAS las series de
            arriba (top N + "Otros") mes a mes -- la categoria entera, no
            sólo el recorte de marcas/proveedores que se grafica por
            separado. Más gruesa y en el navy de marca (--accent) para
            que se lea como la línea de referencia, no una marca más. */}
        <Line
          type="monotone"
          dataKey={TOTAL_KEY}
          name="Total"
          stroke="#1a3d70"
          strokeWidth={3}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
