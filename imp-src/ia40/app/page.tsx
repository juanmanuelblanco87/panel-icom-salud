"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";
import EvolutionChart, { SeriesPoint, PivotResult, formatPeriod, fmtNumber } from "@/components/EvolutionChart";
import MultiSelectDropdown from "@/components/MultiSelectDropdown";
import AppHeader from "@/components/AppHeader";
import EstadoDatos from "@/components/EstadoDatos";
import { segmentosValidos } from "@/lib/segmentos";
import { Ic } from "@/components/Ic";

// Colores fijos para los 6 segmentos originales de "Sillas de Ruedas" (se
// mantienen para no cambiar los colores ya conocidos de esa categoria).
// Para las demas categorias (cada una con sus propios nombres de segmento,
// ver lib/segmentos.ts) se asigna un color de forma deterministica desde
// SEGMENTO_PALETTE en base al nombre del segmento -- asi ningun segmento
// queda sin color asignado (bug anterior: todo caia a un gris de fallback).
//
// 26/08/2026 ("REALINEA"): igual que en components/EvolutionChart.tsx,
// esta paleta mezclaba violeta (#9b30d9, #7d5ba6), rojo (#d93a3a, choca
// con estados de error) y magenta (#e0507a) -- sin relacion con la
// familia azul/naranja/verde-azulado/ambar del resto del panel de Icom
// Salud. Los 6 colores de SEGMENTO_COLORS se realinean a esos mismos
// tonos ya establecidos (usuario confirmo que se puede tocar el mapa
// fijo, no solo el fallback por hash) -- los cambios de color afectan
// como se ve cada segmento en los graficos, pero no cambian ningun
// dato ni logica de negocio.
const SEGMENTO_COLORS: Record<string, string> = {
  "Silla Estándar": "#2a78d6",
  "Silla Ultra Livianas": "#1baf7a",
  "Sillas Infantiles": "#eb6834",
  "Silla Postural": "#1a3d70",
  "Silla Activa y Deportivas": "#a8760a",
  "Silla de Traslado": "#0e7d5c",
};
const SEGMENTO_PALETTE = [
  "#2a78d6",
  "#1baf7a",
  "#eb6834",
  "#1a3d70",
  "#a8760a",
  "#0e7d5c",
  "#eda100",
  "#4a6fa5",
  "#b8491f",
  "#3ab795",
  "#f2994a",
  "#6fa8dc",
];
function colorForSegmento(key: string): string {
  const fijo = SEGMENTO_COLORS[key];
  if (fijo) return fijo;
  // Hash simple y estable del nombre -> siempre el mismo color para el
  // mismo segmento, sin depender del orden en que aparecen las filas.
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return SEGMENTO_PALETTE[hash % SEGMENTO_PALETTE.length];
}

interface Category {
  id: number;
  slug: string;
  name: string;
  ncm_codes: string[];
}

interface TopEntry {
  key: string;
  value: number;
  other: number;
}

function computeTop(
  series: SeriesPoint[],
  periodSet: Set<string> | null,
  dimension: "proveedor" | "marca" | "modelo"
): { topFob: TopEntry | null; topUnidades: TopEntry | null } {
  const totals = new Map<string, { fob: number; uni: number }>();
  for (const s of series) {
    if (periodSet && !periodSet.has(s.period)) continue;
    const key = ((s as any)[dimension] ?? "sin_dato") as string;
    const cur = totals.get(key) ?? { fob: 0, uni: 0 };
    cur.fob += Number(s.total_fob_dolars) || 0;
    cur.uni += Number(s.total_unidades) || 0;
    totals.set(key, cur);
  }
  let topFob: TopEntry | null = null;
  let topUnidades: TopEntry | null = null;
  for (const [key, v] of totals) {
    if (!topFob || v.fob > topFob.value) topFob = { key, value: v.fob, other: v.uni };
    if (!topUnidades || v.uni > topUnidades.value) topUnidades = { key, value: v.uni, other: v.fob };
  }
  return { topFob, topUnidades };
}

interface ShareRow {
  key: string;
  fob: number;
  fobPct: number;
  unidades: number;
  unidadesPct: number;
}

function computeShareTable(
  series: SeriesPoint[],
  periodSet: Set<string> | null,
  dimension: "proveedor" | "marca" | "segmento"
): ShareRow[] {
  const totals = new Map<string, { fob: number; uni: number }>();
  let totalFob = 0;
  let totalUni = 0;
  for (const s of series) {
    if (periodSet && !periodSet.has(s.period)) continue;
    const key = ((s as any)[dimension] ?? "sin_dato") as string;
    const fob = Number(s.total_fob_dolars) || 0;
    const uni = Number(s.total_unidades) || 0;
    const cur = totals.get(key) ?? { fob: 0, uni: 0 };
    cur.fob += fob;
    cur.uni += uni;
    totals.set(key, cur);
    totalFob += fob;
    totalUni += uni;
  }
  const rows: ShareRow[] = Array.from(totals.entries()).map(([key, v]) => ({
    key,
    fob: v.fob,
    fobPct: totalFob > 0 ? (v.fob / totalFob) * 100 : 0,
    unidades: v.uni,
    unidadesPct: totalUni > 0 ? (v.uni / totalUni) * 100 : 0,
  }));
  rows.sort((a, b) => b.fob - a.fob);
  return rows;
}

function ShareTable({
  title,
  rows,
  last12Label,
  nameLabel = "Nombre",
}: {
  title: string;
  rows: ShareRow[];
  last12Label: string;
  nameLabel?: string;
}) {
  return (
    <div className="panel">
      <h1 style={{ fontSize: 15, marginTop: 0, marginBottom: 4 }}>{title}</h1>
      <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 10 }}>{last12Label}</div>
      <div className="table-scroll" style={{ maxHeight: 360, overflowY: "auto" }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>{nameLabel}</th>
              <th style={{ textAlign: "right" }}>FOB USD</th>
              <th style={{ textAlign: "right" }}>FOB %</th>
              <th style={{ textAlign: "right" }}>Unidades</th>
              <th style={{ textAlign: "right" }}>Unidades %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{r.key}</td>
                <td style={{ textAlign: "right" }}>{fmtNumber(r.fob)}</td>
                <td style={{ textAlign: "right" }}>{r.fobPct.toFixed(1)}%</td>
                <td style={{ textAlign: "right" }}>{fmtNumber(r.unidades)}</td>
                <td style={{ textAlign: "right" }}>{r.unidadesPct.toFixed(1)}%</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} style={{ color: "var(--muted)" }}>Sin datos</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SegmentoPieChart({ rows, last12Label }: { rows: ShareRow[]; last12Label: string }) {
  return (
    <div className="panel">
      <h1 style={{ fontSize: 15, marginTop: 0, marginBottom: 4 }}>Share por Segmento (FOB)</h1>
      <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 10 }}>{last12Label}</div>
      {rows.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>Sin datos.</p>
      ) : (
        <div className="pie-wrap">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows}
              dataKey="fob"
              nameKey="key"
              cx="50%"
              cy="45%"
              // 26/08/2026 ("se rompen los graficos" en mobile): esto era
              // outerRadius={100} (fijo, en px) -- en un .pie-wrap angosto
              // (celular) un circulo de 200px de diametro no entraba junto
              // con la leyenda de abajo, y los % quedaban superpuestos
              // sobre el propio circulo. Con "%" en vez de un numero fijo,
              // recharts lo calcula en base al ancho/alto REAL del
              // contenedor (que .pie-wrap ya achica en mobile via CSS) --
              // se achica solo con la pantalla, sin superponerse.
              outerRadius="70%"
              label={(entry: any) => `${Number(entry.fobPct ?? 0).toFixed(0)}%`}
            >
              {rows.map((r) => (
                <Cell key={r.key} fill={colorForSegmento(r.key)} />
              ))}
            </Pie>
            <Tooltip formatter={(value: any) => fmtNumber(Number(value))} />
            <Legend wrapperStyle={{ fontSize: 11, lineHeight: "16px" }} />
          </PieChart>
        </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

interface ModelShareRow {
  marca: string;
  modelo: string;
  segmento: string;
  importador: string;
  fob: number;
  fobPct: number;
  unidades: number;
  unidadesPct: number;
  /** fob / unidades del periodo (0 si no hay unidades). */
  fobUnitario: number;
}

export interface ModelImageEntry {
  marca: string;
  modelo: string;
  image_url: string | null;
  thumbnail_url: string | null;
  source_url: string | null;
  status: string; // 'pending' | 'found' | 'not_found' | 'error'
}

/**
 * PVP (Precio de Venta al Publico) estimado en USD via OpenAI (busqueda web,
 * ver lib/pvpFinder.ts), cacheado en la tabla model_pvp. Se consulta ON
 * DEMAND igual que la imagen: el usuario hace click en "Consultar precio" en
 * la fila y se guarda para siempre (salvo que haya dado 'error').
 */
export interface ModelPvpEntry {
  marca: string;
  modelo: string;
  pvp_usd: number | null;
  confianza: string | null;
  razonamiento: string | null;
  status: string; // 'pending' | 'found' | 'not_found' | 'error'
}

function modelImageKey(marca: string, modelo: string): string {
  return `${marca}|||${modelo}`;
}

/**
 * Share por combinacion marca+modelo (no por modelo solo: el mismo nombre de
 * modelo puede repetirse entre marcas distintas). Ademas de FOB%/Unidades%
 * sobre el periodo elegido, calcula el importador principal de cada
 * combinacion (el que mas FOB acumulo) para mostrarlo como referencia.
 */
function computeShareByModel(series: SeriesPoint[], periodSet: Set<string> | null): ModelShareRow[] {
  interface Acc {
    marca: string;
    modelo: string;
    segmento: string;
    fob: number;
    uni: number;
    byImporter: Map<string, number>;
  }
  const totals = new Map<string, Acc>();
  let totalFob = 0;
  let totalUni = 0;
  for (const s of series) {
    if (periodSet && !periodSet.has(s.period)) continue;
    const marca = s.marca ?? "sin_dato";
    const modelo = s.modelo ?? "sin_dato";
    const segmento = s.segmento ?? "sin_dato";
    const key = modelImageKey(marca, modelo);
    const fob = Number(s.total_fob_dolars) || 0;
    const uni = Number(s.total_unidades) || 0;
    const cur = totals.get(key) ?? { marca, modelo, segmento, fob: 0, uni: 0, byImporter: new Map<string, number>() };
    cur.fob += fob;
    cur.uni += uni;
    const prov = s.proveedor ?? "sin_dato";
    cur.byImporter.set(prov, (cur.byImporter.get(prov) ?? 0) + fob);
    totals.set(key, cur);
    totalFob += fob;
    totalUni += uni;
  }

  const rows: ModelShareRow[] = Array.from(totals.values()).map((v) => {
    let importador = "-";
    let topVal = -Infinity;
    for (const [imp, val] of v.byImporter) {
      if (val > topVal) {
        topVal = val;
        importador = imp;
      }
    }
    return {
      marca: v.marca,
      modelo: v.modelo,
      segmento: v.segmento,
      importador,
      fob: v.fob,
      fobPct: totalFob > 0 ? (v.fob / totalFob) * 100 : 0,
      unidades: v.uni,
      unidadesPct: totalUni > 0 ? (v.uni / totalUni) * 100 : 0,
      fobUnitario: v.uni > 0 ? v.fob / v.uni : 0,
    };
  });
  rows.sort((a, b) => b.fob - a.fob);
  return rows;
}

// Titulo (tooltip) del boton de imagen -- el boton en si se ve como un
// icono de lupa para no ocupar tanto lugar en la tabla (ver ModelShareTable).
const IMAGE_BUTTON_LABEL: Record<string, string> = {
  found: "Ver imagen",
  not_found: "Sin imagen (click para reintentar)",
  error: "Reintentar busqueda de imagen",
  // "pending" = todavia no se busco: el click dispara la busqueda on-demand
  // (ver ModelImageModal), no hace falta un backfill previo.
  pending: "Buscar imagen",
};

const PVP_BUTTON_LABEL: Record<string, string> = {
  not_found: "No se encontro un precio confiable (click para reintentar)",
  error: "Reintentar consulta de precio",
  pending: "Consultar precio (OpenAI busca en la web)",
};

function ModelShareTable({
  rows,
  last12Label,
  imageStatus,
  onViewImage,
  pvpEntry,
  pvpLoadingKeys,
  onConsultPvp,
}: {
  rows: ModelShareRow[];
  last12Label: string;
  imageStatus: (marca: string, modelo: string) => string;
  onViewImage: (marca: string, modelo: string, segmento: string) => void;
  pvpEntry: (marca: string, modelo: string) => ModelPvpEntry | undefined;
  pvpLoadingKeys: Set<string>;
  onConsultPvp: (marca: string, modelo: string, segmento: string) => void;
}) {
  const cellStyle: React.CSSProperties = { padding: "5px 6px", fontSize: 12.5 };
  const cellRight: React.CSSProperties = { ...cellStyle, textAlign: "right" };
  return (
    <div className="panel">
      <h1 style={{ fontSize: 15, marginTop: 0, marginBottom: 4 }}>Share por Modelo</h1>
      <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 10 }}>{last12Label}</div>
      <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
        <table className="admin-table" style={{ fontSize: 12.5 }}>
          <thead>
            <tr>
              <th style={cellStyle}>Modelo</th>
              <th style={cellStyle}>Marca</th>
              <th style={cellStyle}>Segmento</th>
              <th style={cellStyle}>Importador</th>
              <th style={cellRight}>FOB USD</th>
              <th style={cellRight}>FOB %</th>
              <th style={cellRight}>Unidades</th>
              <th style={cellRight}>Uds %</th>
              <th style={cellRight}>FOB Unit.</th>
              <th style={cellRight}>PVP USD</th>
              <th style={cellStyle}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const status = imageStatus(r.marca, r.modelo);
              const key = modelImageKey(r.marca, r.modelo);
              const pvp = pvpEntry(r.marca, r.modelo);
              const pvpStatus = pvp?.status ?? "pending";
              const pvpLoading = pvpLoadingKeys.has(key);
              return (
                <tr key={key}>
                  <td style={cellStyle}>{r.modelo}</td>
                  <td style={cellStyle}>{r.marca}</td>
                  <td style={cellStyle}>{r.segmento}</td>
                  <td style={cellStyle}>{r.importador}</td>
                  <td style={cellRight}>{fmtNumber(r.fob)}</td>
                  <td style={cellRight}>{r.fobPct.toFixed(1)}%</td>
                  <td style={cellRight}>{fmtNumber(r.unidades)}</td>
                  <td style={cellRight}>{r.unidadesPct.toFixed(1)}%</td>
                  <td style={cellRight}>{r.unidades > 0 ? `$${fmtNumber(r.fobUnitario)}` : "-"}</td>
                  <td style={cellRight}>
                    {pvpLoading ? (
                      <span style={{ color: "var(--muted)" }}>Buscando...</span>
                    ) : pvpStatus === "found" && pvp?.pvp_usd != null ? (
                      // El puntito de color es la "confianza" que devolvio la IA
                      // (verde=alta, amarillo=media, rojo=baja) -- pedido implicito
                      // del usuario tras detectar un PVP incorrecto (20/07/2026,
                      // ver ACTUALIZACION 4 en lib/pvpFinder.ts): antes la
                      // confianza solo se veia en el tooltip, ahora es visible de
                      // un vistazo para saber cuales precios conviene chequear a
                      // mano. El tooltip (razonamiento) ahora tambien incluye el
                      // monto en pesos y el tipo de cambio usado, para auditar.
                      <span
                        title={pvp.razonamiento ?? undefined}
                        style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                      >
                        ${fmtNumber(pvp.pvp_usd)}
                        <span
                          title={`Confianza de la IA: ${pvp.confianza ?? "baja"}`}
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            display: "inline-block",
                            flexShrink: 0,
                            background:
                              pvp.confianza === "alta" ? "#2fa84f" : pvp.confianza === "media" ? "#e0a52f" : "#d93a3a",
                          }}
                        />
                      </span>
                    ) : (
                      <button
                        onClick={() => onConsultPvp(r.marca, r.modelo, r.segmento)}
                        title={PVP_BUTTON_LABEL[pvpStatus] ?? "Consultar precio"}
                        style={{ fontSize: 11, padding: "2px 6px", whiteSpace: "nowrap" }}
                      >
                        {pvpStatus === "not_found" ? "Sin dato ↻" : pvpStatus === "error" ? "Error ↻" : "Consultar"}
                      </button>
                    )}
                  </td>
                  <td style={cellStyle}>
                    <button
                      onClick={() => onViewImage(r.marca, r.modelo, r.segmento)}
                      title={IMAGE_BUTTON_LABEL[status] ?? "Buscar imagen"}
                      aria-label={IMAGE_BUTTON_LABEL[status] ?? "Buscar imagen"}
                      style={{ fontSize: 13, padding: "2px 7px", lineHeight: 1 }}
                    >
                      <Ic n="search" e="🔍" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} style={{ color: "var(--muted)" }}>Sin datos</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// NOTA (17/07/2026): las opciones del <select> de Segmento en el modal de
// correccion ("Corregir") ya NO son una lista fija -- vienen de
// segmentosValidos(categorySlug) (lib/segmentos.ts), que tiene una lista
// distinta por categoria. Antes esto solo mostraba (y el backend solo
// aceptaba) los 6 segmentos de "Sillas de ruedas", asi que corregir el
// segmento de un andador, una cama, etc. era imposible.

function ModelImageModal({
  marca,
  modelo,
  categorySlug,
  segmentoActual,
  entry,
  onClose,
  onResolved,
  onOverrideSaved,
}: {
  marca: string;
  modelo: string;
  categorySlug: string;
  segmentoActual: string;
  entry: ModelImageEntry | undefined;
  onClose: () => void;
  onResolved: (entry: ModelImageEntry) => void;
  onOverrideSaved: () => void;
}) {
  const [local, setLocal] = useState<ModelImageEntry | undefined>(entry);
  const [searching, setSearching] = useState(false);
  const [editing, setEditing] = useState(false);
  const [imageUrlInput, setImageUrlInput] = useState("");
  const [segmentoInput, setSegmentoInput] = useState(segmentoActual);
  const [saving, setSaving] = useState(false);
  const [imgError, setImgError] = useState(false);

  // Si cambia la imagen (ej. se guarda una correccion nueva), se resetea el
  // estado de error para volver a intentar cargarla.
  useEffect(() => {
    setImgError(false);
  }, [local?.image_url]);

  useEffect(() => {
    setLocal(entry);
    const needsSearch = !entry || entry.status === "pending" || entry.status === "error";
    if (!needsSearch) return;

    let cancelled = false;
    setSearching(true);
    fetch("/api/model-images/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: categorySlug, marca, modelo }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.image) {
          setLocal(d.image);
          onResolved(d.image);
        }
      })
      .catch(() => {
        if (cancelled) return;
        const errEntry: ModelImageEntry = { marca, modelo, image_url: null, thumbnail_url: null, source_url: null, status: "error" };
        setLocal(errEntry);
        onResolved(errEntry);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marca, modelo, categorySlug]);

  const startEditing = () => {
    setImageUrlInput(local?.image_url ?? "");
    setSegmentoInput(segmentoActual);
    setEditing(true);
  };

  const saveOverride = async () => {
    setSaving(true);
    try {
      const body: Record<string, string> = { category: categorySlug, marca, modelo };
      const trimmedUrl = imageUrlInput.trim();
      if (trimmedUrl) body.image_url = trimmedUrl;
      if (segmentoInput) body.segmento = segmentoInput;

      const res = await fetch("/api/model-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("save_failed");

      if (trimmedUrl) {
        const updated: ModelImageEntry = {
          marca,
          modelo,
          image_url: trimmedUrl,
          thumbnail_url: trimmedUrl,
          source_url: local?.source_url ?? null,
          status: "found",
        };
        setLocal(updated);
        onResolved(updated);
      }
      setEditing(false);
      onOverrideSaved();
    } catch {
      alert("No se pudo guardar la correccion. Proba de nuevo.");
    } finally {
      setSaving(false);
    }
  };

  const status = searching ? "searching" : local?.status ?? "pending";
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 20,
          maxWidth: 480,
          width: "100%",
          textAlign: "center",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
          <strong style={{ fontSize: 15 }}>{marca} — {modelo}</strong>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {!editing && (
              <button onClick={startEditing} title="Corregir imagen o segmento" style={{ padding: "4px 10px", fontSize: 13 }}>
                ✎ Corregir
              </button>
            )}
            <button onClick={onClose} style={{ padding: "4px 10px", fontSize: 13 }}>Cerrar</button>
          </div>
        </div>
        <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 14 }}>Segmento: {segmentoActual}</div>

        {editing && (
          <div style={{ textAlign: "left", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 14, marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
              URL de imagen (dejar vacio para no cambiarla)
            </label>
            <input
              type="text"
              value={imageUrlInput}
              onChange={(e) => setImageUrlInput(e.target.value)}
              placeholder="https://..."
              style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: 13, marginBottom: 12 }}
            />
            <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
              Segmento
            </label>
            <select
              value={segmentoInput}
              onChange={(e) => setSegmentoInput(e.target.value)}
              style={{ width: "100%", padding: "6px 8px", fontSize: 13, marginBottom: 14 }}
            >
              {segmentosValidos(categorySlug).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setEditing(false)} disabled={saving} style={{ padding: "4px 10px", fontSize: 13 }}>
                Cancelar
              </button>
              <button onClick={saveOverride} disabled={saving} style={{ padding: "4px 10px", fontSize: 13 }}>
                {saving ? "Guardando..." : "Guardar"}
              </button>
            </div>
          </div>
        )}

        {status === "searching" && (
          <p style={{ color: "var(--muted)" }}>Buscando imagen...</p>
        )}
        {status === "not_found" && (
          <p style={{ color: "var(--muted)" }}>No se encontro una imagen representativa para este modelo.</p>
        )}
        {status === "error" && (
          <p style={{ color: "var(--muted)" }}>
            Hubo un error buscando esta imagen (puede ser cuota mensual de SerpApi agotada). Cerra y
            proba "Reintentar" mas tarde.
          </p>
        )}
        {status === "found" && local?.image_url && !imgError && (
          <>
            <img
              src={local.image_url}
              alt={`${marca} ${modelo}`}
              onError={() => setImgError(true)}
              style={{ maxWidth: "100%", maxHeight: 360, borderRadius: 6 }}
            />
            {local.source_url && (
              <p style={{ marginTop: 10 }}>
                <a href={local.source_url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontSize: 13 }}>
                  Ver fuente original →
                </a>
              </p>
            )}
          </>
        )}
        {status === "found" && local?.image_url && imgError && (
          <p style={{ color: "var(--muted)" }}>
            No se pudo cargar la imagen desde ese link. Probablemente pegaste la URL de la <em>pagina</em> del
            producto en vez de la URL directa de la imagen (que tiene que terminar en algo como .jpg, .png o
            .webp). Para conseguirla: abri la pagina del producto, click derecho sobre la imagen y elegi
            "Copiar direccion de la imagen" (o "Copy image address"), y pega eso con "✎ Corregir".
          </p>
        )}
      </div>
    </div>
  );
}

// AppHeader se extrajo a components/AppHeader.tsx (20/07/2026) para poder
// reusarlo tambien en app/calculo-importacion/page.tsx, con el boton de
// navegacion "Cálculo de Importación" pasado como `actions` mas abajo.

function TopCard({ title, lastMonth, last12, last12Label }: {
  title: string;
  lastMonth: { topFob: TopEntry | null; topUnidades: TopEntry | null };
  last12: { topFob: TopEntry | null; topUnidades: TopEntry | null };
  last12Label: string;
}) {
  return (
    <div className="panel">
      <h1 style={{ fontSize: 15, marginTop: 0, marginBottom: 14 }}>{title}</h1>

      {/* 26/08/2026 (auditoría de diseño, "el dato importante se ve
          menos importante que su etiqueta"): antes el nombre y el
          valor real iban en el mismo peso/tamaño que el texto auxiliar
          "Ultimo mes:" de al lado -- misma jerarquía visual para el
          dato que importa y para el relleno. El valor (lo que
          realmente responde "¿cuánto?") ahora es lo más marcado de la
          fila: negrita + color de acento, en vez de gris muted. */}
      <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 10, minHeight: 132, boxSizing: "border-box" }}>
        <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>FOB USD</div>
        <div style={{ fontSize: 14, marginBottom: 4 }}>
          <span style={{ color: "var(--muted)" }}>Ultimo mes: </span>
          <strong>{lastMonth.topFob?.key ?? "-"}</strong>
          {lastMonth.topFob && <strong style={{ color: "var(--accent)" }}> — {fmtNumber(lastMonth.topFob.value)} USD</strong>}
        </div>
        <div style={{ fontSize: 14 }}>
          <span style={{ color: "var(--muted)" }}>{last12Label}: </span>
          <strong>{last12.topFob?.key ?? "-"}</strong>
          {last12.topFob && <strong style={{ color: "var(--accent)" }}> — {fmtNumber(last12.topFob.value)} USD</strong>}
        </div>
      </div>

      <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, minHeight: 132, boxSizing: "border-box" }}>
        <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>Unidades</div>
        <div style={{ fontSize: 14, marginBottom: 4 }}>
          <span style={{ color: "var(--muted)" }}>Ultimo mes: </span>
          <strong>{lastMonth.topUnidades?.key ?? "-"}</strong>
          {lastMonth.topUnidades && <strong style={{ color: "var(--accent)" }}> — {fmtNumber(lastMonth.topUnidades.value)} un.</strong>}
        </div>
        <div style={{ fontSize: 14 }}>
          <span style={{ color: "var(--muted)" }}>{last12Label}: </span>
          <strong>{last12.topUnidades?.key ?? "-"}</strong>
          {last12.topUnidades && <strong style={{ color: "var(--accent)" }}> — {fmtNumber(last12.topUnidades.value)} un.</strong>}
        </div>
      </div>
    </div>
  );
}

// Para categorias cuya NCM trae de fondo mucha data no-medica (ver
// docs/PROYECTO.md, parser de cada categoria), el filtro de Segmento
// arranca preseleccionado en el segmento de uso ortopedico/relevante que
// nos interesa, en vez de mostrar TODO desde el arranque. Los datos de los
// demas segmentos NO se pierden ni se descartan (siguen sincronizados) --
// el usuario puede ampliar o cambiar la seleccion de Segmento en cualquier
// momento para verlos.
interface SieveSummary {
  categoria?: string;
  solicitados?: number;
  procesados?: number;
  sin_cambios?: number;
  segmento_corregido?: number;
  categoria_movida?: number;
  sin_evidencia?: number;
  errores?: number;
  /** Cuantos items trajeron un PVP nuevo en esta corrida (ver sección 10.2). */
  pvp_actualizado?: number;
  movidos?: { marca: string; modelo: string; de: string; a: string; segmento: string | null; razonamiento: string }[];
  corregidos?: { marca: string; modelo: string; segmento: string; razonamiento: string }[];
  detalle_errores?: string[];
  parcial?: boolean;
  error?: string;
}

/** Resumen del boton "Completar PVP" (ver /api/pvp-sieve). */
interface PvpSieveSummary {
  categoria?: string;
  solicitados?: number;
  procesados?: number;
  encontrados?: number;
  sin_evidencia?: number;
  errores?: number;
  detalle_errores?: string[];
  parcial?: boolean;
  error?: string;
}

const DEFAULT_SEGMENTO_FILTER: Record<string, string[]> = {
  sillas_ducha: ["Sillas de Ducha / Sanitarias"],
  almohadones_ortopedicos: ["Cojín Ortopédico / Antiescaras"],
  elevadores_inodoro: ["Elevador / Asiento Sanitario Ortopédico"],
};

export default function Home() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [slug, setSlug] = useState<string>("");
  const [marcas, setMarcas] = useState<string[]>([]);
  const [modelosSel, setModelosSel] = useState<string[]>([]);
  const [importadores, setImportadores] = useState<string[]>([]);
  const [colores, setColores] = useState<string[]>([]);
  const [segmentos, setSegmentos] = useState<string[]>([]);
  const [meses, setMeses] = useState<string[]>([]);
  const [groupBy, setGroupBy] = useState<"marca" | "modelo" | "proveedor">("marca");
  const [metric, setMetric] = useState<"total_fob_dolars" | "total_unidades">("total_fob_dolars");
  // 26/08/2026 ("mejorá la UX mobile de Importaciones -- tantos filtros
  // tirados ahi, el tamizador con tanta relevancia arriba"): en mobile,
  // lo prioritario es Categoria + Meses y despues el volumen/FOB de esa
  // seleccion (KPIs) -- el resto de los filtros (Marca/Importador/
  // Modelo/Color/Segmento/Agrupar por/Metrica) y las herramientas de
  // mantenimiento de datos (Tamizar categoria/Completar PVP, uso
  // esporadico, no de cada visita) quedan colapsados por default SOLO
  // en mobile -- en desktop siguen abiertos como siempre (hay lugar de
  // sobra). Lazy init: sólo se evalúa una vez, al montar.
  // 20/10/2026: arrancan abiertos (igual que el HTML del servidor) y en celular se cierran al montar. Antes el valor inicial dependía de window.innerWidth: servidor y navegador
  // no coincidían en celular, React tiraba un error de hidratación y volvía a pintar toda la página desde cero (se perdía, entre otras cosas, el tema del panel).
  const [filtrosAbiertos, setFiltrosAbiertos] = useState<boolean>(true);
  const [herramientasAbiertas, setHerramientasAbiertas] = useState<boolean>(true);
  useEffect(() => {
    if (window.innerWidth <= 640) {
      setFiltrosAbiertos(false);
      setHerramientasAbiertas(false);
    }
  }, []);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [options, setOptions] = useState<{ marca: string; modelo: string }[]>([]);
  const [importerOptions, setImporterOptions] = useState<string[]>([]);
  const [colorOptions, setColorOptions] = useState<string[]>([]);
  const [segmentoOptions, setSegmentoOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [pivot, setPivot] = useState<PivotResult | null>(null);
  const [modelImages, setModelImages] = useState<Map<string, ModelImageEntry>>(new Map());
  const [modelPvp, setModelPvp] = useState<Map<string, ModelPvpEntry>>(new Map());
  const [pvpLoadingKeys, setPvpLoadingKeys] = useState<Set<string>>(new Set());
  const [viewingModel, setViewingModel] = useState<{ marca: string; modelo: string; segmento: string } | null>(null);
  const [sieving, setSieving] = useState(false);
  const [sieveResult, setSieveResult] = useState<SieveSummary | null>(null);
  const [showSieveErrors, setShowSieveErrors] = useState(false);
  // true/false = ultimo resultado conocido de /api/evolution; null = todavia no se sabe
  const [syncOk, setSyncOk] = useState<boolean | null>(null);
  const [sieveStatus, setSieveStatus] = useState<{ total: number; tamizado: number; pendientes: number; porcentaje: number } | null>(null);
  // Segundos que tardo, en promedio, cada modelo procesado en la ULTIMA
  // corrida (busqueda + IA por modelo) -- se usa para estimar cuanto falta
  // para terminar toda la categoria (sieveStatus.pendientes * este valor).
  const [sieveSecondsPerItem, setSieveSecondsPerItem] = useState<number | null>(null);

  const reloadSieveStatus = () => {
    if (!slug) {
      setSieveStatus(null);
      return;
    }
    fetch(`/api/sieve/status?category=${encodeURIComponent(slug)}`)
      .then((r) => r.json())
      .then((d) => setSieveStatus(d.error ? null : d))
      .catch(() => setSieveStatus(null));
  };

  useEffect(reloadSieveStatus, [slug]);

  const [resetting, setResetting] = useState(false);

  // "Limpiar tamizado": borra model_sieve_log de la categoria para poder
  // re-tamizarla de cero -- necesario para categorias que ya estaban al
  // 100% ANTES de que existiera la columna PVP USD (esas combinaciones
  // nunca vuelven a pasar por procesarItem, asi que sin esto nunca
  // completarian el PVP). Confirma antes de borrar porque el proximo
  // tamizado va a volver a gastar una llamada a OpenAI por modelo.
  const resetSieveLog = () => {
    if (!slug || resetting || sieving) return;
    const ok = window.confirm(
      "Esto borra el registro de tamizado de esta categoria: el proximo click en \"Tamizar categoria\" va a volver a procesar TODOS los modelos (gastando OpenAI de nuevo por cada uno) en vez de solo los pendientes. No borra segmentos, categorias ni PVP ya guardados. ¿Continuar?"
    );
    if (!ok) return;
    setResetting(true);
    fetch(`/api/sieve?category=${encodeURIComponent(slug)}`, { method: "DELETE" })
      .then((r) => r.json())
      .then(() => {
        setSieveResult(null);
        setSieveSecondsPerItem(null);
        reloadSieveStatus();
      })
      .catch(() => alert("No se pudo limpiar el tamizado. Proba de nuevo."))
      .finally(() => setResetting(false));
  };

  const runSieve = () => {
    if (!slug || sieving) return;
    setSieving(true);
    setSieveResult(null);
    setShowSieveErrors(false);
    const startedAt = Date.now();
    fetch(`/api/sieve?category=${encodeURIComponent(slug)}`)
      .then((r) => r.json())
      .then((d) => {
        setSieveResult(d);
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const procesados = d.procesados ?? 0;
        if (procesados > 0) setSieveSecondsPerItem(elapsedSec / procesados);
        // Si se corrigieron segmentos o se movieron filas de categoria, la
        // serie actual puede haber cambiado -- se recarga para reflejarlo.
        if ((d.segmento_corregido ?? 0) > 0 || (d.categoria_movida ?? 0) > 0) {
          reloadSeries();
          // El tamizador puede reclasificar el segmento de un modelo (via
          // model_segmento_override) haciendolo entrar o salir del filtro
          // de Segmento activo -- y "Completar PVP" cuenta su total/% sobre
          // ESE mismo filtro (ver ACTUALIZACION en app/api/pvp-sieve/status
          // /route.ts). Sin este reload, la barra de Completar PVP quedaba
          // "estatica", mostrando siempre el total de ANTES de tamizar --
          // reporte real del usuario (20/07/2026): "se van sumando
          // productos y el completar PVP sigue estatico".
          reloadPvpSieveStatus();
        }
        if ((d.pvp_actualizado ?? 0) > 0) reloadModelPvp();
        reloadSieveStatus();
      })
      .catch(() => setSieveResult({ error: "No se pudo correr el tamizador. Proba de nuevo." } as any))
      .finally(() => setSieving(false));
  };

  /** "125" -> "2 min 5 s"; redondea a lo mas util (segundos si es poco, minutos si es mucho). */
  function fmtDuration(totalSeconds: number): string {
    const s = Math.max(0, Math.round(totalSeconds));
    if (s < 60) return `${s} s`;
    const mins = Math.round(s / 60);
    if (mins < 60) return `~${mins} min`;
    const hs = Math.floor(mins / 60);
    const restMin = mins % 60;
    return `~${hs} h ${restMin} min`;
  }

  // ---- "Completar PVP": batch exhaustivo (lib/pvpFinder.ts) para los
  // modelos que el tamizador de segmentos dejo sin PVP (el PVP del
  // tamizador es solo oportunista, ver ACTUALIZACION 2 en
  // lib/aiClassifier.ts) -- corre /api/pvp-sieve, que reusa la misma
  // getOrSearchModelPvp() del boton manual "Consultar precio" pero en lote.
  const [pvpSieving, setPvpSieving] = useState(false);
  const [pvpSieveResult, setPvpSieveResult] = useState<PvpSieveSummary | null>(null);
  const [showPvpSieveErrors, setShowPvpSieveErrors] = useState(false);
  const [pvpSieveStatus, setPvpSieveStatus] = useState<{ total: number; encontrados: number; pendientes: number; porcentaje: number } | null>(null);
  const [pvpSieveSecondsPerItem, setPvpSieveSecondsPerItem] = useState<number | null>(null);

  // El % de avance y el batch en si ahora respetan el filtro de Segmento
  // activo (mismo `segmentos` que usa reloadSeries) -- si no, "Completar
  // PVP" podia gastar su cupo en modelos de OTRO segmento oculto por el
  // filtro por defecto de la categoria (ver DEFAULT_SEGMENTO_FILTER), sin
  // tocar nunca los que el usuario tiene realmente a la vista (reporte
  // real: "no pega los PVP de mayor a menor peso del SOM%" con "PVP
  // encontrado: 59" pero ninguno de los visibles en pantalla). Ver tambien
  // ACTUALIZACION en app/api/pvp-sieve/route.ts.
  const pvpSieveParams = () => {
    const params = new URLSearchParams({ category: slug });
    for (const s2 of segmentos) params.append("segmento", s2);
    return params;
  };

  const reloadPvpSieveStatus = () => {
    if (!slug) {
      setPvpSieveStatus(null);
      return;
    }
    fetch(`/api/pvp-sieve/status?${pvpSieveParams()}`)
      .then((r) => r.json())
      .then((d) => setPvpSieveStatus(d.error ? null : d))
      .catch(() => setPvpSieveStatus(null));
  };

  useEffect(reloadPvpSieveStatus, [slug, segmentos]);

  // Antes "Completar PVP" hacia UN solo click = UN solo lote (hasta 60
  // modelos, cortado a los ~4-5 min de presupuesto de tiempo) -- para
  // categorias con muchos modelos pendientes, terminar la categoria entera
  // significaba clickear el boton una y otra vez cada pocos minutos.
  // Reporte real del usuario (20/07/2026): "corrida general" de Completar
  // PVP sentida como "casi 10 minutos", justamente por tener que quedarse
  // reclickeando. Ahora el boton encadena lotes automaticamente (sin que el
  // usuario tenga que volver a clickear) hasta que ya no queden modelos
  // pendientes de esa categoria/segmento, mostrando el resumen ACUMULADO de
  // todas las vueltas y actualizando la barra de progreso en cada una. Se
  // puede interrumpir en cualquier momento con el boton "Detener" (lo ya
  // encontrado en vueltas anteriores queda guardado igual, no se pierde).
  const pvpSieveStopRef = useRef(false);

  const stopPvpSieve = () => {
    pvpSieveStopRef.current = true;
  };

  const runPvpSieve = async () => {
    if (!slug || pvpSieving) return;
    setPvpSieving(true);
    setPvpSieveResult(null);
    setShowPvpSieveErrors(false);
    pvpSieveStopRef.current = false;

    let acumulado: PvpSieveSummary = {
      categoria: slug,
      solicitados: 0,
      procesados: 0,
      encontrados: 0,
      sin_evidencia: 0,
      errores: 0,
      detalle_errores: [],
      parcial: false,
    };

    const MAX_VUELTAS = 30;
    let terminoTodo = false;

    try {
      // Tope de seguridad de vueltas (30 lotes de hasta 60 = 1800 modelos)
      // para no quedar en un loop infinito ante algun bug de backend que
      // siempre devuelva `solicitados > 0` sin avanzar nunca.
      for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
        if (pvpSieveStopRef.current) break;
        const startedAt = Date.now();
        const res = await fetch(`/api/pvp-sieve?${pvpSieveParams()}`);
        const d: PvpSieveSummary = await res.json();

        if (d.error) {
          setPvpSieveResult({ ...acumulado, error: d.error });
          return;
        }

        const elapsedSec = (Date.now() - startedAt) / 1000;
        const procesadosVuelta = d.procesados ?? 0;
        if (procesadosVuelta > 0) setPvpSieveSecondsPerItem(elapsedSec / procesadosVuelta);

        acumulado = {
          categoria: slug,
          solicitados: (acumulado.solicitados ?? 0) + (d.solicitados ?? 0),
          procesados: (acumulado.procesados ?? 0) + (d.procesados ?? 0),
          encontrados: (acumulado.encontrados ?? 0) + (d.encontrados ?? 0),
          sin_evidencia: (acumulado.sin_evidencia ?? 0) + (d.sin_evidencia ?? 0),
          errores: (acumulado.errores ?? 0) + (d.errores ?? 0),
          detalle_errores: [...(acumulado.detalle_errores ?? []), ...(d.detalle_errores ?? [])],
          parcial: false,
        };
        setPvpSieveResult(acumulado);
        if ((d.encontrados ?? 0) > 0) reloadModelPvp();
        reloadPvpSieveStatus();

        // Esta vuelta no encontro NADA pendiente -> ya no queda nada por
        // hacer en esta categoria/segmento, se termina el loop.
        if ((d.solicitados ?? 0) === 0) {
          terminoTodo = true;
          break;
        }
      }
      // Si salimos del for sin terminar todo (por Detener o por llegar al
      // tope de vueltas), lo marcamos como parcial para que el usuario sepa
      // que puede clickear "Completar PVP" de nuevo para seguir.
      if (!terminoTodo) {
        acumulado = { ...acumulado, parcial: true };
        setPvpSieveResult(acumulado);
      }
    } catch {
      setPvpSieveResult({ ...acumulado, error: "No se pudo completar el PVP. Proba de nuevo." } as any);
    } finally {
      setPvpSieving(false);
    }
  };

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => r.json())
      .then((d) => {
        setCategories(d.categories ?? []);
        if (d.categories?.[0]) {
          setSlug(d.categories[0].slug);
          setSegmentos(DEFAULT_SEGMENTO_FILTER[d.categories[0].slug] ?? []);
        }
      });
  }, []);

  // Extraida como funcion reusable para poder recargar la serie sin cambiar
  // filtros (ej. despues de guardar una correccion manual de segmento desde
  // el modal de imagen, sin esperar al proximo /api/sync).
  const reloadSeries = () => {
    if (!slug) return;
    setLoading(true);
    const params = new URLSearchParams({ category: slug });
    for (const m of marcas) params.append("marca", m);
    for (const i of importadores) params.append("importador", i);
    for (const m of modelosSel) params.append("modelo", m);
    for (const c of colores) params.append("color", c);
    for (const s2 of segmentos) params.append("segmento", s2);
    fetch(`/api/evolution?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error("bad_status");
        return r.json();
      })
      .then((d) => {
        setSeries(d.series ?? []);
        setOptions(d.options ?? []);
        setImporterOptions(d.importerOptions ?? []);
        setColorOptions(d.colorOptions ?? []);
        setSegmentoOptions(d.segmentoOptions ?? []);
        setSyncOk(true);
      })
      .catch(() => setSyncOk(false))
      .finally(() => setLoading(false));
  };

  useEffect(reloadSeries, [slug, marcas, modelosSel, importadores, colores, segmentos]);

  useEffect(() => {
    if (!slug) return;
    fetch(`/api/model-images?category=${encodeURIComponent(slug)}`)
      .then((r) => r.json())
      .then((d) => {
        const map = new Map<string, ModelImageEntry>();
        for (const row of (d.images ?? []) as ModelImageEntry[]) {
          map.set(modelImageKey(row.marca, row.modelo), row);
        }
        setModelImages(map);
      })
      .catch(() => setModelImages(new Map()));
  }, [slug]);

  // Extraida en su propia funcion para poder recargarla tanto al cambiar de
  // categoria como despues de correr el tamizador (que ahora tambien
  // completa PVP en la misma busqueda, ver guardarPvp() en
  // app/api/sieve/route.ts) -- asi la columna PVP USD se actualiza sola sin
  // esperar a un cambio de categoria/refresco de pagina.
  const reloadModelPvp = () => {
    if (!slug) return;
    fetch(`/api/model-pvp?category=${encodeURIComponent(slug)}`)
      .then((r) => r.json())
      .then((d) => {
        const map = new Map<string, ModelPvpEntry>();
        for (const row of (d.pvps ?? []) as ModelPvpEntry[]) {
          map.set(modelImageKey(row.marca, row.modelo), row);
        }
        setModelPvp(map);
      })
      .catch(() => setModelPvp(new Map()));
  };

  useEffect(reloadModelPvp, [slug]);

  // Consulta on-demand del PVP de un modelo puntual (click en "Consultar" en
  // la columna PVP USD de Share por Modelo) -- llama a OpenAI (web_search) y
  // queda cacheado en model_pvp, igual que la busqueda de imagen.
  const handleConsultPvp = (marca: string, modelo: string, _segmento: string) => {
    const key = modelImageKey(marca, modelo);
    if (pvpLoadingKeys.has(key)) return;
    setPvpLoadingKeys((prev) => new Set(prev).add(key));
    fetch("/api/model-pvp/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: slug, marca, modelo }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.pvp) {
          setModelPvp((prev) => {
            const next = new Map(prev);
            next.set(key, d.pvp);
            return next;
          });
        }
      })
      .catch(() => {
        setModelPvp((prev) => {
          const next = new Map(prev);
          next.set(key, {
            marca,
            modelo,
            pvp_usd: null,
            confianza: null,
            razonamiento: null,
            status: "error",
          });
          return next;
        });
      })
      .finally(() => {
        setPvpLoadingKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      });
  };

  const marcaOptions = Array.from(new Set(options.map((o) => o.marca).filter(Boolean))) as string[];
  const modelos = Array.from(new Set(options.map((o) => o.modelo).filter(Boolean))) as string[];
  const mesOptions = useMemo(
    () => Array.from(new Set(series.map((s) => s.period))).sort().reverse(),
    [series]
  );
  // 13/10/2026 ("porque queda sin el detalle abajo?"): si el mes elegido (ej. Septiembre) deja de existir al cambiar otro filtro (ej. un importador sin ventas ese mes),
  // el mes seguia "seleccionado" pero invisible en el selector (campo en blanco) y el grafico quedaba vacio. Se descartan los meses que ya no estan disponibles.
  useEffect(() => {
    if (series.length === 0) return;
    setMeses((prev) => {
      const validos = prev.filter((m) => mesOptions.includes(m));
      return validos.length === prev.length ? prev : validos;
    });
  }, [series, mesOptions]);
  // Cuenta de filtros "extra" (los que quedan colapsados detrás de "Más
  // filtros") con algo elegido -- se muestra en el propio botón para que,
  // aunque esté cerrado, no se pierda de vista que hay un filtro activo
  // ahí adentro.
  const filtrosExtraActivos =
    (marcas.length > 0 ? 1 : 0) +
    (importadores.length > 0 ? 1 : 0) +
    (modelosSel.length > 0 ? 1 : 0) +
    (colores.length > 0 ? 1 : 0) +
    (segmentos.length > 0 ? 1 : 0);

  // Los meses seleccionados solo filtran lo que se ve en el grafico/tabla;
  // los totales de "ultimo mes"/"ultimos 12 meses" siempre usan la serie
  // completa (sin el filtro de mes), para que no cambien de significado.
  const filteredSeries = useMemo(
    () => (meses.length > 0 ? series.filter((s) => meses.includes(s.period)) : series),
    [series, meses]
  );

  const periodInfo = useMemo(() => {
    const distinctPeriods = Array.from(new Set(series.map((s) => s.period))).sort();
    if (distinctPeriods.length === 0) return { lastPeriod: null as string | null, lastSet: null, last12Set: null, last12Count: 0 };
    const lastPeriod = distinctPeriods[distinctPeriods.length - 1];
    const last12 = distinctPeriods.slice(-12);
    return {
      lastPeriod,
      lastSet: new Set([lastPeriod]),
      last12Set: new Set(last12),
      last12Count: last12.length,
    };
  }, [series]);

  // ---- Totales de encabezado: ultimo mes y ultimos 12 meses moviles (ambas metricas siempre) ----
  const totals = useMemo(() => {
    const lastMonth = { fob: 0, unidades: 0 };
    const last12 = { fob: 0, unidades: 0 };
    for (const s of series) {
      const fob = Number(s.total_fob_dolars) || 0;
      const uni = Number(s.total_unidades) || 0;
      if (periodInfo.lastSet?.has(s.period)) {
        lastMonth.fob += fob;
        lastMonth.unidades += uni;
      }
      if (periodInfo.last12Set?.has(s.period)) {
        last12.fob += fob;
        last12.unidades += uni;
      }
    }
    return { lastPeriod: periodInfo.lastPeriod, lastMonth, last12, last12Count: periodInfo.last12Count };
  }, [series, periodInfo]);

  // ---- Top importador / marca / modelo (ultimo mes y ultimos 12 meses) ----
  const topImporter = useMemo(
    () => ({
      lastMonth: computeTop(series, periodInfo.lastSet, "proveedor"),
      last12: computeTop(series, periodInfo.last12Set, "proveedor"),
    }),
    [series, periodInfo]
  );
  const topBrand = useMemo(
    () => ({
      lastMonth: computeTop(series, periodInfo.lastSet, "marca"),
      last12: computeTop(series, periodInfo.last12Set, "marca"),
    }),
    [series, periodInfo]
  );
  const topModel = useMemo(
    () => ({
      lastMonth: computeTop(series, periodInfo.lastSet, "modelo"),
      last12: computeTop(series, periodInfo.last12Set, "modelo"),
    }),
    [series, periodInfo]
  );

  // ---- Share por Importador/Marca/Modelo/Segmento: por default ultimos 12
  // meses moviles, pero si el usuario eligio mes(es) puntuales en el
  // selector de arriba (`meses`), respetan ESE filtro en vez de ignorarlo
  // -- antes quedaban siempre fijos en "ultimos 12 meses" pasara lo que
  // pasara en el selector (26/08/2026, "si en el selector de meses solo
  // elijo Julio deberia mostrarme los datos de julio"). Los totales de
  // encabezado (Ultimo mes / Ultimos 12 meses, mas arriba) siguen
  // ignorando este filtro a proposito -- esos representan un periodo fijo
  // por definicion, no "lo que este mirando ahora en la tabla". ----
  const sharePeriodSet = useMemo(
    () => (meses.length > 0 ? new Set(meses) : periodInfo.last12Set),
    [meses, periodInfo]
  );
  const shareLabel = useMemo(() => {
    if (meses.length === 0) return `Ultimos ${totals.last12Count || 12} meses moviles`;
    if (meses.length === 1) return formatPeriod(meses[0]);
    return `${meses.length} meses seleccionados`;
  }, [meses, totals.last12Count]);
  const shareByImporter = useMemo(
    () => computeShareTable(series, sharePeriodSet, "proveedor"),
    [series, sharePeriodSet]
  );
  const shareByBrand = useMemo(
    () => computeShareTable(series, sharePeriodSet, "marca"),
    [series, sharePeriodSet]
  );
  const shareByModel = useMemo(
    () => computeShareByModel(series, sharePeriodSet),
    [series, sharePeriodSet]
  );
  const shareBySegmento = useMemo(
    () => computeShareTable(series, sharePeriodSet, "segmento"),
    [series, sharePeriodSet]
  );

  const imageStatusFor = (marca: string, modelo: string) =>
    modelImages.get(modelImageKey(marca, modelo))?.status ?? "pending";

  const pvpEntryFor = (marca: string, modelo: string) => modelPvp.get(modelImageKey(marca, modelo));

  // ---- Descarga CSV de la tabla mes a mes (mismo orden que se ve en pantalla) ----
  const downloadCsv = () => {
    if (!pivot) return;
    const rowsDesc = [...pivot.rows].sort((a, b) => (a.period < b.period ? 1 : -1));
    const header = ["Periodo", ...pivot.keys].join(";");
    const lines = rowsDesc.map((row) => {
      const cells = [formatPeriod(row.period), ...pivot.keys.map((k) => Math.round(Number(row[k] ?? 0)))];
      return cells.join(";");
    });
    const totalsRow = [
      "Total",
      ...pivot.keys.map((k) => Math.round(rowsDesc.reduce((acc, row) => acc + Number(row[k] ?? 0), 0))),
    ];
    const csv = [header, ...lines, totalsRow.join(";")].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}_${groupBy}_${metric}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <AppHeader
        title="Módulo de Importaciones"
        actions={
          <Link href="/calculo-importacion" className="app-header-nav-btn">
            <Ic n="calc" e="🧮" /> Cálculo de Importación
          </Link>
        }
      />
      <div className="container">
      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 14, paddingBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 13, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
            <span>Datos sincronizados desde Cobus Group</span>
            {syncOk === true && <span title="La pantalla pudo leer los datos (el estado de la sincronización está debajo)" style={{ color: "#2fa84f" }}>✓</span>}
            {syncOk === false && <span title="No se pudo cargar la información" style={{ color: "#d93a3a" }}><Ic n="alert" e="⚠️" /></span>}
          </div>
          <button
            type="button"
            onClick={() => setHerramientasAbiertas((v) => !v)}
            style={{ fontSize: 12, padding: "5px 10px", color: "var(--muted)" }}
          >
            {herramientasAbiertas ? "Ocultar herramientas ▴" : "Herramientas de datos ▾"}
          </button>
        </div>

        <EstadoDatos />

        {herramientasAbiertas && (
        <>
        <div className="herr-fila" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div className="herr-grupo">
          <button onClick={runSieve} disabled={sieving || !slug}>
            {sieving ? <><Ic n="search" e="🔎" /> Tamizando...</> : <><Ic n="search" e="🔎" /> Tamizar categoría</>}
          </button>
          {sieveStatus && sieveStatus.tamizado > 0 && (
            <button
              onClick={resetSieveLog}
              disabled={sieving || resetting || !slug}
              title="Limpiar tamizado: borra el registro para poder re-tamizar de cero (ej. para completar PVP en modelos ya tamizados antes de que existiera esa columna)"
              aria-label="Limpiar tamizado"
              style={{
                fontSize: 15,
                padding: "5px 9px",
                lineHeight: 1,
                color: "#d93a3a",
                borderColor: "#d93a3a",
              }}
            >
              {resetting ? "…" : "↺"}
            </button>
          )}
          {sieveStatus && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>
              <div style={{ width: 120, height: 8, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: `${sieveStatus.porcentaje}%`, height: "100%", background: "var(--accent)" }} />
              </div>
              <span>
                {sieveStatus.tamizado}/{sieveStatus.total} tamizado ({sieveStatus.porcentaje}%)
              </span>
              {sieveSecondsPerItem != null && sieveStatus.pendientes > 0 && (
                <span>· ≈{fmtDuration(sieveStatus.pendientes * sieveSecondsPerItem)} restante</span>
              )}
            </div>
          )}

          </div>
          <div className="herr-grupo">
          <button onClick={runPvpSieve} disabled={pvpSieving || !slug} title="Completa el PVP de todos los modelos pendientes de la categoría/segmento actual, encadenando lotes automáticamente hasta terminar (o hasta que apretés Detener)">
            {pvpSieving ? <><Ic n="dollar" e="💲" /> Completando PVP...</> : <><Ic n="dollar" e="💲" /> Completar PVP</>}
          </button>
          {pvpSieving && (
            <button
              onClick={stopPvpSieve}
              title="Detener: lo ya encontrado en este proceso queda guardado, no se pierde"
              style={{ fontSize: 12, padding: "5px 9px" }}
            >
              <Ic n="stop" e="⏹" /> Detener
            </button>
          )}
          {pvpSieveStatus && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>
              <div style={{ width: 120, height: 8, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: `${pvpSieveStatus.porcentaje}%`, height: "100%", background: "var(--accent)" }} />
              </div>
              <span>
                {pvpSieveStatus.encontrados}/{pvpSieveStatus.total} con PVP ({pvpSieveStatus.porcentaje}%)
              </span>
              {pvpSieveSecondsPerItem != null && pvpSieveStatus.pendientes > 0 && (
                <span>· ≈{fmtDuration(pvpSieveStatus.pendientes * pvpSieveSecondsPerItem)} restante</span>
              )}
            </div>
          )}
          </div>
        </div>

        {pvpSieveResult && (
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, fontSize: 13 }}>
            {pvpSieveResult.error ? (
              <div style={{ color: "#d93a3a" }}>{pvpSieveResult.error}</div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <strong>
                    Procesados {pvpSieveResult.procesados ?? 0} de {pvpSieveResult.solicitados ?? 0} pendientes de PVP
                  </strong>
                  <button onClick={() => setPvpSieveResult(null)} style={{ padding: "2px 8px", fontSize: 12 }}>Cerrar</button>
                </div>
                <div style={{ color: "var(--muted)" }}>
                  PVP encontrado: {pvpSieveResult.encontrados ?? 0} · Sin evidencia: {pvpSieveResult.sin_evidencia ?? 0}
                  {(pvpSieveResult.errores ?? 0) > 0 && (
                    <>
                      {" "}· Errores: {pvpSieveResult.errores}{" "}
                      <button
                        onClick={() => setShowPvpSieveErrors((v) => !v)}
                        style={{ padding: "1px 6px", fontSize: 11, marginLeft: 4 }}
                      >
                        {showPvpSieveErrors ? "Ocultar errores" : "Ver errores"}
                      </button>
                    </>
                  )}
                </div>
                {pvpSieveResult.parcial && (
                  <div style={{ color: "var(--muted)", marginTop: 6 }}>
                    <Ic n="clock" e="⏱️" /> Se detuvo antes de terminar todos los pendientes (manualmente, o por el tope de seguridad de
                    30 lotes seguidos) — lo ya procesado quedó guardado. Clickeá "Completar PVP" de nuevo para
                    seguir con el resto.
                  </div>
                )}
                {showPvpSieveErrors && (pvpSieveResult.detalle_errores?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <strong style={{ color: "#d93a3a" }}>Detalle de errores:</strong>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "#d93a3a" }}>
                      {pvpSieveResult.detalle_errores!.slice(0, 10).map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {sieveResult && (
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, fontSize: 13 }}>
            {sieveResult.error ? (
              <div style={{ color: "#d93a3a" }}>{sieveResult.error}</div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <strong>
                    Procesados {sieveResult.procesados ?? 0} de {sieveResult.solicitados ?? 0} pendientes
                  </strong>
                  <button onClick={() => setSieveResult(null)} style={{ padding: "2px 8px", fontSize: 12 }}>Cerrar</button>
                </div>
                <div style={{ color: "var(--muted)" }}>
                  Sin cambios: {sieveResult.sin_cambios ?? 0} · Segmento corregido: {sieveResult.segmento_corregido ?? 0} ·
                  {" "}Categoría movida: {sieveResult.categoria_movida ?? 0} · Sin evidencia: {sieveResult.sin_evidencia ?? 0}
                  {" "}· PVP encontrado: {sieveResult.pvp_actualizado ?? 0}
                  {(sieveResult.errores ?? 0) > 0 && (
                    <>
                      {" "}· Errores: {sieveResult.errores}{" "}
                      <button
                        onClick={() => setShowSieveErrors((v) => !v)}
                        style={{ padding: "1px 6px", fontSize: 11, marginLeft: 4 }}
                      >
                        {showSieveErrors ? "Ocultar errores" : "Ver errores"}
                      </button>
                    </>
                  )}
                </div>
                {sieveResult.parcial && (
                  <div style={{ color: "var(--muted)", marginTop: 6 }}>
                    <Ic n="clock" e="⏱️" /> Se alcanzó el límite de tiempo de este click antes de terminar el lote completo — lo ya
                    procesado quedó guardado. Clickeá "Tamizar categoría" de nuevo para seguir con el resto.
                  </div>
                )}
                {showSieveErrors && (sieveResult.detalle_errores?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <strong style={{ color: "#d93a3a" }}>Detalle de errores:</strong>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "#d93a3a" }}>
                      {sieveResult.detalle_errores!.slice(0, 10).map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {(sieveResult.movidos?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <strong>Movidos de categoría:</strong>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                      {sieveResult.movidos!.map((m, i) => (
                        <li key={i}>
                          {m.marca} — {m.modelo}: {m.de} → <strong>{m.a}</strong> ({m.segmento ?? "sin segmento"})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {(sieveResult.corregidos?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <strong>Segmento corregido:</strong>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                      {sieveResult.corregidos!.map((c, i) => (
                        <li key={i}>
                          {c.marca} — {c.modelo}: {c.segmento}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        </>
        )}
      </div>

      <div className="panel">
        {/* 26/08/2026 ("Lo principal es: Selector de categoria / mes, y
            luego ver rapidamente el volumen y fob de esa categoria /
            periodo de tiempo"): Categoria y Meses quedan SIEMPRE
            visibles, arriba de todo -- son los 2 controles que de verdad
            se usan en cada visita. El resto (Marca/Importador/Modelo/
            Color/Segmento + Agrupar por/Metrica) son refinamientos que
            se tocan rara vez -- quedan colapsados por default en mobile
            (ver filtrosAbiertos) para no enterrar Categoria/Meses/KPIs
            bajo 9 selectores apilados de punta a punta de la pantalla. */}
        {/* 20/10/2026 ("Más y menos filtros está mal colocado ahí... optimiza los espacios"): todos los filtros viven en UNA grilla de columnas iguales y el botón Más/Menos filtros
            va en la cabecera de la tarjeta, siempre en el mismo lugar (antes flotaba suelto en la fila, a un costado de "Meses", y se corría según cuántos filtros hubiera). */}
        <div className="filtros-head">
          <span className="filtros-titulo">Filtros</span>
          <button
            type="button"
            className="filtros-toggle"
            onClick={() => setFiltrosAbiertos((v) => !v)}
          >
            {filtrosAbiertos
              ? "Menos filtros ▴"
              : `Más filtros ▾${filtrosExtraActivos > 0 ? ` (${filtrosExtraActivos})` : ""}`}
          </button>
        </div>
        <div className="filtros-grid">
          <div className="filter-field">
            <label>Categoria</label>
            <select
              style={{ width: "100%" }}
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setMarcas([]);
                setModelosSel([]);
                setMeses([]);
                setImportadores([]);
                setColores([]);
                setSegmentos(DEFAULT_SEGMENTO_FILTER[e.target.value] ?? []);
              }}
            >
              {categories.map((c) => (
                <option key={c.slug} value={c.slug}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className="filter-field">
            <MultiSelectDropdown
              label="Meses"
              options={mesOptions.map((p) => ({ value: p, label: formatPeriod(p) }))}
              selected={meses}
              onChange={setMeses}
              placeholder="Todos"
              searchable={false}
            />
          </div>

        {filtrosAbiertos && (
          <>
            <div className="filter-field">
              <MultiSelectDropdown
                label="Marca"
                options={marcaOptions.map((m) => ({ value: m, label: m }))}
                selected={marcas}
                onChange={setMarcas}
                placeholder="Todas"
              />
            </div>

            <div className="filter-field">
              <MultiSelectDropdown
                label="Importador"
                options={importerOptions.map((p) => ({ value: p, label: p }))}
                selected={importadores}
                onChange={setImportadores}
                placeholder="Todos"
              />
            </div>

            <div className="filter-field">
              <MultiSelectDropdown
                label="Modelo"
                options={modelos.map((m) => ({ value: m, label: m }))}
                selected={modelosSel}
                onChange={setModelosSel}
                placeholder="Todos"
              />
            </div>

            <div className="filter-field">
              <MultiSelectDropdown
                label="Color"
                options={colorOptions.map((c) => ({ value: c, label: c }))}
                selected={colores}
                onChange={setColores}
                placeholder="Todos"
              />
            </div>

            <div className="filter-field">
              <MultiSelectDropdown
                label="Segmento"
                options={segmentoOptions.map((s) => ({ value: s, label: s }))}
                selected={segmentos}
                onChange={setSegmentos}
                placeholder="Todos"
              />
            </div>

            <div className="filter-field">
              <label>Agrupar por</label>
              <select style={{ width: "100%" }} value={groupBy} onChange={(e) => setGroupBy(e.target.value as any)}>
                <option value="marca">Marca</option>
                <option value="modelo">Modelo</option>
                <option value="proveedor">Proveedor</option>
              </select>
            </div>
            <div className="filter-field">
              <label>Metrica</label>
              <select style={{ width: "100%" }} value={metric} onChange={(e) => setMetric(e.target.value as any)}>
                <option value="total_fob_dolars">FOB USD</option>
                <option value="total_unidades">Unidades</option>
              </select>
            </div>
          </>
        )}
        </div>
      </div>

      <div className="kpi-row">
        <div className="panel" style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div className="kpi-icon"><Ic n="calendar" e="📅" /></div>
          <div>
            <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 6 }}>
              Ultimo mes{totals.lastPeriod ? ` (${formatPeriod(totals.lastPeriod)})` : ""}
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "var(--accent)" }}>
              {fmtNumber(totals.lastMonth.fob)} <span style={{ fontSize: 14, color: "var(--muted)", fontWeight: 400 }}>USD FOB</span>
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>
              {fmtNumber(totals.lastMonth.unidades)} <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 400 }}>Unidades</span>
            </div>
          </div>
        </div>
        <div className="panel" style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* 26/08/2026 ("icono repetido"): antes 🗓️ (calendario con
              cuadrícula) -- al lado de 📅 (calendario simple) de la
              tarjeta de arriba, se leían como el mismo ícono repetido.
              📈 distingue de verdad "un mes puntual" de "acumulado en
              el tiempo". */}
          <div className="kpi-icon"><Ic n="trend" e="📈" /></div>
          <div>
            <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 6 }}>
              Ultimos {totals.last12Count || 12} meses
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "var(--accent)" }}>
              {fmtNumber(totals.last12.fob)} <span style={{ fontSize: 14, color: "var(--muted)", fontWeight: 400 }}>USD FOB</span>
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>
              {fmtNumber(totals.last12.unidades)} <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 400 }}>Unidades</span>
            </div>
          </div>
        </div>
      </div>

      <div className="stack-row">
        <TopCard title="Top Importador" lastMonth={topImporter.lastMonth} last12={topImporter.last12} last12Label={`Ultimos ${totals.last12Count || 12} meses`} />
        <TopCard title="Top Marca" lastMonth={topBrand.lastMonth} last12={topBrand.last12} last12Label={`Ultimos ${totals.last12Count || 12} meses`} />
        <TopCard title="Top Modelo" lastMonth={topModel.lastMonth} last12={topModel.last12} last12Label={`Ultimos ${totals.last12Count || 12} meses`} />
      </div>

      <div className="panel">
        {loading ? <p style={{ color: "var(--muted)" }}>Cargando...</p> : (
          <div className="chart-wrap">
            <EvolutionChart
              data={filteredSeries}
              groupBy={groupBy}
              metric={metric}
              topN={9}
              pinnedKeys={groupBy === "marca" ? ["Mugi", "Magesa"] : []}
              onPivotChange={setPivot}
            />
          </div>
        )}
      </div>

      <div className="stack-row">
        <ShareTable
          title="Share por Importador"
          rows={shareByImporter}
          last12Label={shareLabel}
        />
        <ShareTable
          title="Share por Marca"
          rows={shareByBrand}
          last12Label={shareLabel}
        />
      </div>

      <ModelShareTable
        rows={shareByModel}
        last12Label={shareLabel}
        imageStatus={imageStatusFor}
        onViewImage={(marca, modelo, segmento) => setViewingModel({ marca, modelo, segmento })}
        pvpEntry={pvpEntryFor}
        pvpLoadingKeys={pvpLoadingKeys}
        onConsultPvp={handleConsultPvp}
      />

      {viewingModel && (
        <ModelImageModal
          key={modelImageKey(viewingModel.marca, viewingModel.modelo)}
          marca={viewingModel.marca}
          modelo={viewingModel.modelo}
          categorySlug={slug}
          segmentoActual={viewingModel.segmento}
          entry={modelImages.get(modelImageKey(viewingModel.marca, viewingModel.modelo))}
          onClose={() => setViewingModel(null)}
          onResolved={(img) =>
            setModelImages((prev) => {
              const next = new Map(prev);
              next.set(modelImageKey(img.marca, img.modelo), img);
              return next;
            })
          }
          onOverrideSaved={reloadSeries}
        />
      )}

      <div className="stack-row">
        <SegmentoPieChart
          rows={shareBySegmento}
          last12Label={shareLabel}
        />
        <ShareTable
          title="Share por Segmento"
          nameLabel="Segmento"
          rows={shareBySegmento}
          last12Label={shareLabel}
        />
      </div>

      {pivot && pivot.rows.length > 0 && (
        <div className="panel">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h1 style={{ fontSize: 16, margin: 0 }}>Detalle mes a mes</h1>
            <button onClick={downloadCsv}>Descargar CSV</button>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Periodo</th>
                  {pivot.keys.map((k) => <th key={k}>{k}</th>)}
                </tr>
              </thead>
              <tbody>
                {[...pivot.rows]
                  .sort((a, b) => (a.period < b.period ? 1 : -1))
                  .map((row) => (
                    <tr key={row.period}>
                      <td>{formatPeriod(row.period)}</td>
                      {pivot.keys.map((k) => <td key={k}>{fmtNumber(Number(row[k] ?? 0))}</td>)}
                    </tr>
                  ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: "2px solid var(--border)" }}>
                  <td>Total</td>
                  {pivot.keys.map((k) => (
                    <td key={k}>{fmtNumber(pivot.rows.reduce((acc, row) => acc + Number(row[k] ?? 0), 0))}</td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      <p style={{ color: "var(--muted)", fontSize: 13 }}>
        Los datos se sincronizan con Cobus solos cuando hay un mes nuevo disponible (ver el estado arriba, con la opción de sincronizar a mano).
        Si una categoria no tiene marca/modelo mapeados todavia, esas columnas
        aparecen como "sin_dato" hasta cargar el mapeo en field_mappings.
      </p>
      </div>
    </>
  );
}
