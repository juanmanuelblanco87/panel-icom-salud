"use client";

import { useCallback, useEffect, useState } from "react";
import { Ic } from "@/components/Ic";

/**
 * Estado de los datos de Importaciones (13/10/2026, "por que es tan fragil nuestro desarrollo de importaciones"): hasta que mes llegan los datos de cada categoria,
 * cuando se sincronizaron bien por ultima vez, si el ultimo intento fallo y por que -- y un boton para sincronizar a mano. Antes una sincronizacion caida
 * no se veia en ningun lado (la pantalla decia "Datos sincronizados" igual).
 */

interface CategoriaEstado {
  slug: string;
  name: string;
  estado: "ok" | "reintentando" | "atrasada";
  datosHasta: string | null;
  mesesFaltantes: string[];
  filas: number;
  ultimaSincronizacionOk: string | null;
  ultimoIntento: { status: string; runAt: string } | null;
  fallosSeguidos: number;
  ultimoError: string | null;
}
interface Estado {
  ahora: string;
  datosEsperadosHasta: string;
  acceso: { edadMin: number; actualizado: string } | null;
  resumen: { total: number; ok: number; reintentando: number; atrasadas: number };
  categorias: CategoriaEstado[];
}

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function mesLegible(ym: string | null): string {
  if (!ym) return "sin datos";
  const [y, m] = ym.split("-");
  return `${MESES[Number(m) - 1] ?? m} ${y}`;
}
function hace(iso: string | null, ahora: string): string {
  if (!iso) return "nunca";
  const min = Math.max(0, Math.round((new Date(ahora).getTime() - new Date(iso).getTime()) / 60000));
  if (min < 2) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "ayer" : `hace ${d} días`;
}
function motivoCorto(e: string | null): string {
  if (!e) return "";
  if (/renovar el acceso a Cobus|auth|token|JWT/i.test(e)) return "No se pudo entrar a Cobus (el acceso venció y no se pudo renovar). Se reintenta solo.";
  if (/tiempo maximo|timeout|se corto/i.test(e)) return "La sincronización se cortó por tiempo; se reintenta con una ventana más corta.";
  if (/0 filas/i.test(e)) return "Cobus no devolvió filas para ese período.";
  return e.length > 160 ? e.slice(0, 160) + "…" : e;
}

export default function EstadoDatos() {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [errorCarga, setErrorCarga] = useState(false);
  const [abierto, setAbierto] = useState(false);
  const [sincronizando, setSincronizando] = useState<string | null>(null); // "todas" | slug
  const [mensaje, setMensaje] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await fetch("/api/estado-datos", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      setEstado(await r.json());
      setErrorCarga(false);
    } catch {
      setErrorCarga(true);
    }
  }, []);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [cargar]);

  async function sincronizar(slug: string | null) {
    setSincronizando(slug ?? "todas");
    setMensaje(null);
    try {
      const r = await fetch("/api/ejecutar-sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(slug ? { category: slug } : {}) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        setMensaje(`No se pudo sincronizar: ${j?.error ?? "error " + r.status}`);
      } else {
        const hechas = (j.procesadas ?? []).length;
        const pend = (j.pendientes_sin_procesar ?? []).length;
        if (j.detenido_por_acceso_a_cobus) setMensaje("No se pudo entrar a Cobus. Probá de nuevo en unos minutos (también se reintenta solo).");
        else if (hechas === 0 && !pend) setMensaje("Todo estaba sincronizado hoy: no había nada pendiente.");
        else setMensaje(`Se sincronizó ${hechas} ${hechas === 1 ? "grupo" : "grupos"} de categorías${pend ? `; quedan ${pend} pendientes: volvé a tocar el botón o se completan solas en la próxima corrida` : ""}.`);
      }
    } catch (e: any) {
      setMensaje("La sincronización se interrumpió (puede haber tardado demasiado). Mirá el estado de cada categoría: lo que no terminó se reintenta solo.");
    } finally {
      setSincronizando(null);
      cargar();
    }
  }

  if (errorCarga && !estado) {
    return <div style={{ fontSize: 12, color: "#b35c00" }}><Ic n="alert" e="⚠️" /> No se pudo leer el estado de los datos.</div>;
  }
  if (!estado) return null;

  const { resumen } = estado;
  const todoOk = resumen.atrasadas === 0 && resumen.reintentando === 0;
  const ultimaOk = estado.categorias.map((c) => c.ultimaSincronizacionOk).filter(Boolean).sort().pop() ?? null;
  const desactualizadas = estado.categorias.filter((c) => c.datosHasta && c.datosHasta < estado.datosEsperadosHasta).length;

  const color = resumen.atrasadas > 0 ? "#b3261e" : resumen.reintentando > 0 ? "#b35c00" : "#2f7d4f";
  const titulo =
    resumen.atrasadas > 0
      ? <><Ic n="alert" e="⚠️" /> {resumen.atrasadas} {resumen.atrasadas === 1 ? "categoría sin actualizar" : "categorías sin actualizar"} al último mes disponible</>
      : resumen.reintentando > 0
      ? <><Ic n="hourglass" e="⏳" /> {resumen.reintentando} {resumen.reintentando === 1 ? "categoría" : "categorías"} reintentando (el último intento falló)</>
      : "✓ Datos al día";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--border, #e5e5e0)", paddingTop: 8 }}>
      <div className="estado-fila" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
        <div className="estado-texto" style={{ display: "contents" }}>
        <span style={{ color, fontWeight: 600 }}>{titulo}</span>
        <span style={{ color: "var(--muted)" }}>
          Última sincronización: {hace(ultimaOk, estado.ahora)}
          {desactualizadas > 0 ? ` · ${desactualizadas} con datos anteriores a ${mesLegible(estado.datosEsperadosHasta)}` : ""}
        </span>
        </div>
        <button type="button" onClick={() => setAbierto((v) => !v)} style={{ fontSize: 12, padding: "3px 9px", color: "var(--muted)" }}>
          {abierto ? "Ocultar detalle ▴" : "Ver detalle ▾"}
        </button>
        <button type="button" onClick={() => sincronizar(null)} disabled={!!sincronizando} style={{ fontSize: 12, padding: "3px 9px" }} title="Sincroniza lo que todavía esté pendiente hoy, la categoría más atrasada primero">
          {sincronizando === "todas" ? <><Ic n="refresh" e="🔄" /> Sincronizando… (puede tardar unos minutos)</> : <><Ic n="refresh" e="🔄" /> Sincronizar ahora</>}
        </button>
      </div>

      {mensaje && <div style={{ fontSize: 12, color: "var(--muted)" }}>{mensaje}</div>}

      {abierto && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--muted)" }}>
                <th style={{ padding: "4px 8px" }}>Categoría</th>
                <th style={{ padding: "4px 8px" }}>Datos hasta</th>
                <th style={{ padding: "4px 8px" }}>Última sync. exitosa</th>
                <th style={{ padding: "4px 8px" }}>Estado</th>
                <th style={{ padding: "4px 8px" }} />
              </tr>
            </thead>
            <tbody>
              {estado.categorias.map((c) => {
                const atras = c.datosHasta !== null && c.datosHasta < estado.datosEsperadosHasta;
                return (
                  <tr key={c.slug} style={{ borderTop: "1px solid var(--border, #eee)" }}>
                    <td style={{ padding: "5px 8px", fontWeight: 600 }}>{c.name}</td>
                    <td style={{ padding: "5px 8px", color: atras || c.datosHasta === null ? "#b35c00" : undefined }} title={atras ? `Se esperaban datos hasta ${mesLegible(estado.datosEsperadosHasta)}` : undefined}>
                      {mesLegible(c.datosHasta)}
                      {c.mesesFaltantes?.length > 0 && (
                        <div style={{ color: "#b3261e", fontSize: 11, marginTop: 2 }} title="Meses sin ningún registro entre el primero y el último con datos">
                          Sin datos en: {c.mesesFaltantes.map(mesLegible).join(", ")}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "5px 8px" }}>{hace(c.ultimaSincronizacionOk, estado.ahora)}</td>
                    <td style={{ padding: "5px 8px" }}>
                      {c.estado === "ok" && <span style={{ color: "#2f7d4f" }}>✓ Al día</span>}
                      {c.estado === "reintentando" && <span style={{ color: "#b35c00" }}><Ic n="hourglass" e="⏳" /> Reintentando</span>}
                      {c.estado === "atrasada" && <span style={{ color: "#b3261e" }}><Ic n="alert" e="⚠️" /> Atrasada</span>}
                      {c.estado !== "ok" && c.ultimoError && <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>{motivoCorto(c.ultimoError)}{c.fallosSeguidos > 1 ? ` (${c.fallosSeguidos} intentos fallidos seguidos)` : ""}</div>}
                    </td>
                    <td style={{ padding: "5px 8px", textAlign: "right" }}>
                      <button type="button" onClick={() => sincronizar(c.slug)} disabled={!!sincronizando} style={{ fontSize: 11, padding: "2px 8px" }}>
                        {sincronizando === c.slug ? "…" : "Reintentar"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
            Cobus carga los datos de aduana con retraso: hoy se esperan datos hasta {mesLegible(estado.datosEsperadosHasta)}. La sincronización corre sola varias veces por día y reintenta lo que falla.
            {estado.acceso ? ` Acceso a Cobus renovado ${hace(estado.acceso.actualizado, estado.ahora)}.` : ""}
          </div>
        </div>
      )}
      {todoOk && !abierto ? null : null}
    </div>
  );
}
