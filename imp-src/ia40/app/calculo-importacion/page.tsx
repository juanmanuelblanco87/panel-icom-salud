"use client";

/**
 * Calculador de Importacion (20/07/2026) -- pagina nueva, separada del
 * Modulo de Importaciones (app/page.tsx). Reconstruye la logica de la
 * planilla STOKE_FOB_Objetivo_Fase1.xlsx del cliente: dado un tipo de
 * producto (catalogo abierto, no atado a las 9 categorias de IA40) y un
 * FOB, calcula toda la cascada de costos hasta el Costo Nacionalizado, y el
 * margen resultante vendiendo por Mercado Libre y vendiendo a Distribucion.
 * Ver el racional completo (formulas, supuestos, decisiones tomadas con el
 * usuario) en docs/PROYECTO.md, seccion "Calculador de Importacion".
 *
 * Arancel, IVA y CBM se estiman por IA (OpenAI + web_search, ver
 * lib/calcAi.ts) la primera vez que se usa un tipo de producto, y quedan
 * cacheados -- editables a mano y con boton de recalcular. El PVP de MeLi
 * es MANUAL si se carga en el formulario de calculo; si se deja vacio, se
 * estima por IA (y tambien se cachea).
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import { fmtNumber } from "@/components/EvolutionChart";
import { tamanoEnvioPorCbm } from "@/lib/importCalc";
import { Ic } from "@/components/Ic";

function fmtUsd(n: number): string {
  return n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
function fmtPctInput(n: number | null): string {
  return n == null ? "" : (n * 100).toFixed(2);
}

type TamanoEnvio = "chico" | "mediano" | "grande";

interface ProductType {
  id: number;
  nombre: string;
  ncm_code: string | null;
  arancel_pct: number | null;
  arancel_confianza: string | null;
  arancel_razonamiento: string | null;
  arancel_status: string;
  iva_pct: number | null;
  iva_confianza: string | null;
  iva_razonamiento: string | null;
  iva_status: string;
  trader_pct: number;
  tamano_envio: TamanoEnvio;
  cbm_m3: number | null;
  cbm_confianza: string | null;
  cbm_razonamiento: string | null;
  cbm_status: string;
  pvp_ars_estimado: number | null;
  pvp_confianza: string | null;
  pvp_razonamiento: string | null;
  pvp_status: string;
  ml_category_id: string | null;
  ml_category_nombre: string | null;
  peso_kg: number | null;
  peso_confianza: string | null;
  peso_razonamiento: string | null;
  peso_status: string;
  envio_meli_api_ars: number | null;
  envio_meli_api_status: string;
  envio_meli_api_razonamiento: string | null;
}

interface Supuestos {
  tipoCambioArs: number;
  comisionMlPct: number;
  iibbPct: number;
  padsPct: number;
  tasaEstadisticaPct: number;
  tasaEstadisticaTopeUsd: number;
  ley25413Pct: number;
  seguroUsdUnidad: number;
  feeBajoTicketArs: number;
  umbralBajoValorArs: number;
  descuentoDistribucionPct: number;
  fleteMaritimoUsd: number;
  fleteConfianza: string | null;
  fleteRazonamiento: string | null;
  fleteStatus: string;
  forwarderUsd: number;
  despachanteUsd: number;
  thcUsd: number;
  fleteLocalUsd: number;
  manipuleoUsd: number;
  capacidadCbmContenedor: number;
  capacidad20ftM3: number;
  envioChicoArs: number;
  envioMedianoArs: number;
  envioGrandeArs: number;
  tipoCambioFuenteFecha: string | null;
}

interface CalcCostoNacionalizado {
  traderUsd: number;
  seguroUsd: number;
  cifUsd: number;
  arancelUsd: number;
  tasaEstadisticaUsd: number;
  ley25413Usd: number;
  costoFijoPorCbmUsd: number;
  logisticaUsd: number;
  costoNacionalizadoUsd: number;
  costoNacionalizadoArs: number;
}

interface CalcCanal {
  pvpConIva: number;
  pvpNeto: number;
  comisionMlArs: number;
  envioNetoArs: number;
  iibbArs: number;
  padsArs: number;
  feeBajoTicketArs: number;
  envioPorTamanoAplica: boolean;
  margenArs: number;
  margenPctSobreNeto: number;
  margenPctSobreConIva: number;
}

interface RunResult {
  productType: ProductType;
  supuestos: Supuestos;
  pvpFuente: "manual" | "cache" | "ia";
  envioFuente: "api" | "tabla_fija";
  resultado: {
    costoNacionalizado: CalcCostoNacionalizado;
    meli: CalcCanal;
    distribucion: CalcCanal;
  };
  error?: string;
}

/** Repositorio de escenarios guardados (21/07/2026) -- ver app/api/calc/scenarios/route.ts */
interface Escenario {
  id: number;
  usuario: string;
  nombreEscenario: string | null;
  nombreProducto: string;
  fobUsd: number;
  pvpMeliArsConIva: number | null;
  pvpFuente: string | null;
  tipoCambioArs: number | null;
  arancelPct: number | null;
  ivaPct: number | null;
  cbmM3: number | null;
  tamanoEnvio: string | null;
  envioFuente: string | null;
  margenMeliPct: number | null;
  margenDistribucionPct: number | null;
  supuestos: any;
  productType: any;
  resultado: any;
  createdAt: string;
}

const CONFIANZA_COLOR: Record<string, string> = {
  alta: "#2fa84f",
  media: "#e0a52f",
  baja: "#d93a3a",
};

/** Spinner de carga (20/07/2026): se muestra mientras se espera una
 * respuesta de IA (arancel/IVA/CBM/PVP/flete) o el calculo del FOB, para
 * que quede claro que la app esta "pensando" -- pedido explicito del
 * usuario. `light` = variante para fondos oscuros (ej. dentro de un boton
 * ya resaltado). */
function Spinner({ light }: { light?: boolean }) {
  return <span className={`spinner${light ? " spinner-light" : ""}`} />;
}

function ConfianzaDot({ confianza, razonamiento }: { confianza: string | null; razonamiento: string | null }) {
  if (!confianza) return null;
  return (
    <span
      title={razonamiento ? `Confianza IA: ${confianza}. ${razonamiento}` : `Confianza IA: ${confianza}`}
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        display: "inline-block",
        marginLeft: 5,
        background: CONFIANZA_COLOR[confianza] ?? "#999999",
      }}
    />
  );
}

export default function CalculoImportacionPage() {
  const [productTypes, setProductTypes] = useState<ProductType[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loadingTypes, setLoadingTypes] = useState(false);

  const [showNuevo, setShowNuevo] = useState(false);
  const [nuevoNombre, setNuevoNombre] = useState("");
  const [nuevoNcm, setNuevoNcm] = useState("");
  const [creando, setCreando] = useState(false);
  const [creandoError, setCreandoError] = useState<string | null>(null);

  const [showEditar, setShowEditar] = useState(false);
  const [refrescando, setRefrescando] = useState<string | null>(null); // 'arancel' | 'iva' | 'cbm' | 'pvp' | 'peso' | null
  const [guardandoEdit, setGuardandoEdit] = useState(false);
  const [editForm, setEditForm] = useState<{
    arancelPct: string;
    ivaPct: string;
    traderPct: string;
    tamanoEnvio: TamanoEnvio;
    cbmM3: string;
    pesoKg: string;
  } | null>(null);

  const [fobUsd, setFobUsd] = useState("");
  const [pvpManual, setPvpManual] = useState("");
  const [calculando, setCalculando] = useState(false);
  const [resultado, setResultado] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [showSupuestos, setShowSupuestos] = useState(false);
  const [supuestos, setSupuestos] = useState<Supuestos | null>(null);
  const [supuestosForm, setSupuestosForm] = useState<Record<string, string> | null>(null);
  const [guardandoSupuestos, setGuardandoSupuestos] = useState(false);
  const [refrescandoFlete, setRefrescandoFlete] = useState(false);
  const [refrescandoTipoCambio, setRefrescandoTipoCambio] = useState(false);

  const [meliConectado, setMeliConectado] = useState<boolean | null>(null);
  const [meliOauthMsg, setMeliOauthMsg] = useState<string | null>(null);
  const [escenarios, setEscenarios] = useState<Escenario[]>([]);
  const [usuariosEscenarios, setUsuariosEscenarios] = useState<string[]>([]);
  const [filtroUsuarioEscenarios, setFiltroUsuarioEscenarios] = useState("");
  const [guardandoEscenario, setGuardandoEscenario] = useState(false);

  // Unidades por 40HC (18/09/2026, "deja un lugar para colocar las unidades
  // por 40HC, si las modifico me recalcula automaticamente el CBM"): campo
  // editable; el CBM del tipo de producto se deriva como capacidad del 40HC
  // / unidades y se guarda (con debounce) por el mismo PATCH que ya usa el
  // modal de Editar.
  const [unidades40hc, setUnidades40hc] = useState("");
  const [guardandoCbm, setGuardandoCbm] = useState(false);
  const cbmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const calcularRef = useRef<() => void>(() => {});

  const selected = productTypes.find((p) => p.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected || selected.cbm_m3 == null || selected.cbm_m3 <= 0 || !supuestos) {
      setUnidades40hc("");
      return;
    }
    const deCbm = Math.round(supuestos.capacidadCbmContenedor / selected.cbm_m3);
    setUnidades40hc((prev) => (Number(prev) === deCbm ? prev : String(deCbm)));
  }, [selected?.id, selected?.cbm_m3, supuestos?.capacidadCbmContenedor]);

  const cambiarUnidades40hc = (valor: string) => {
    setUnidades40hc(valor);
    if (cbmTimer.current) clearTimeout(cbmTimer.current);
    const unidades = Math.round(Number(valor));
    if (!selected || !supuestos || !Number.isFinite(unidades) || unidades <= 0) return;
    const productId = selected.id;
    const nuevoCbm = Math.round((supuestos.capacidadCbmContenedor / unidades) * 1e6) / 1e6;
    cbmTimer.current = setTimeout(() => {
      setGuardandoCbm(true);
      fetch(`/api/calc/product-types/${productId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cbmM3: nuevoCbm, tamanoEnvio: tamanoEnvioPorCbm(nuevoCbm) }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (!d.productType) return;
          setProductTypes((prev) => prev.map((p) => (p.id === d.productType.id ? d.productType : p)));
          // Hay un resultado en pantalla calculado con el CBM viejo: se
          // recalcula solo para que nunca queden numeros desactualizados.
          if (resultado && !resultado.error && fobUsd) calcularRef.current();
        })
        .catch(() => alert("No se pudo guardar el CBM. Proba de nuevo."))
        .finally(() => setGuardandoCbm(false));
    }, 700);
  };

  // Medidas de la caja (30/10/2026, "en unidades por 40HC que permita tocar y se abra un pop-up para colocar los cm de ancho, largo y prof. de
  // cada caja y con esos datos recalcule la cantidad que entra"): al tocar el campo se abre un pop-up; con las medidas de UNA caja (y cuántas
  // unidades trae) se calcula cuántas entran en el 40HC y se aplica por el mismo camino que el campo manual (cambiarUnidades40hc: recalcula el CBM
  // del tipo de producto, lo guarda y vuelve a calcular el resultado en pantalla). Las medidas quedan recordadas por tipo de producto en este navegador.
  const [showCaja, setShowCaja] = useState(false);
  const [cajaForm, setCajaForm] = useState({ ancho: "", largo: "", prof: "", porCaja: "1", manual: "" });
  const claveCaja = (id: string | number) => `calc_caja_${id}`;
  const abrirCaja = () => {
    if (!selected) return;
    let guardado: { ancho?: string; largo?: string; prof?: string; porCaja?: string } = {};
    try { guardado = JSON.parse(localStorage.getItem(claveCaja(selected.id)) || "{}") || {}; } catch { /* sin recuerdo */ }
    setCajaForm({ ancho: guardado.ancho || "", largo: guardado.largo || "", prof: guardado.prof || "", porCaja: guardado.porCaja || "1", manual: unidades40hc });
    setShowCaja(true);
  };
  // Cantidad que entra: por la capacidad del 40HC de los supuestos (la misma con la que se reparte el costo del contenedor) y, de referencia, por acomodo
  // geométrico en un 40HC estándar (12,03 x 2,35 x 2,69 m internos, la mejor de las 6 orientaciones).
  const cajaCalculo = (() => {
    const a = Number(cajaForm.ancho), l = Number(cajaForm.largo), p = Number(cajaForm.prof);
    const n = Math.max(1, Math.floor(Number(cajaForm.porCaja) || 1));
    if (!supuestos || !(a > 0 && l > 0 && p > 0)) return null;
    const volM3 = (a * l * p) / 1e6;
    const cajas = Math.floor(supuestos.capacidadCbmContenedor / volM3);
    const [C, A, H] = [1203, 235, 269];
    const orient = [[a, l, p], [a, p, l], [l, a, p], [l, p, a], [p, a, l], [p, l, a]];
    const acomodo = Math.max(...orient.map(([x, y, z]) => Math.floor(C / x) * Math.floor(A / y) * Math.floor(H / z)));
    return { volM3, cajas, unidades: cajas * n, n, acomodo, acomodoUnidades: acomodo * n };
  })();
  const aplicarCaja = () => {
    if (!selected) return;
    let unidades = 0;
    if (cajaCalculo) {
      unidades = cajaCalculo.unidades;
      try { localStorage.setItem(claveCaja(selected.id), JSON.stringify({ ancho: cajaForm.ancho, largo: cajaForm.largo, prof: cajaForm.prof, porCaja: cajaForm.porCaja })); } catch { /* sin recuerdo */ }
    } else {
      unidades = Math.round(Number(cajaForm.manual));
    }
    if (!Number.isFinite(unidades) || unidades <= 0) { alert("Cargá las tres medidas de la caja (o las unidades a mano)."); return; }
    cambiarUnidades40hc(String(unidades));
    setShowCaja(false);
  };

  const reloadProductTypes = () => {
    setLoadingTypes(true);
    fetch("/api/calc/product-types")
      .then((r) => r.json())
      .then((d) => {
        const list: ProductType[] = d.productTypes ?? [];
        setProductTypes(list);
        if (!selectedId && list.length > 0) setSelectedId(list[0].id);
      })
      .catch(() => setProductTypes([]))
      .finally(() => setLoadingTypes(false));
  };

  useEffect(reloadProductTypes, []);

  const reloadSupuestos = () => {
    fetch("/api/calc/supuestos")
      .then((r) => r.json())
      .then((d) => setSupuestos(d.supuestos ?? null))
      .catch(() => setSupuestos(null));
  };

  useEffect(reloadSupuestos, []);

  const reloadMeliOauthStatus = () => {
    fetch("/api/calc/meli-oauth/status")
      .then((r) => r.json())
      .then((d) => setMeliConectado(!!d.conectado))
      .catch(() => setMeliConectado(false));
  };

  useEffect(reloadMeliOauthStatus, []);

  const reloadEscenarios = (usuario?: string) => {
    const qs = usuario ? `?usuario=${encodeURIComponent(usuario)}` : "";
    fetch(`/api/calc/scenarios${qs}`)
      .then((r) => r.json())
      .then((d) => {
        setEscenarios(d.escenarios ?? []);
        setUsuariosEscenarios(d.usuarios ?? []);
      })
      .catch(() => {});
  };

  useEffect(() => reloadEscenarios(), []);

  const guardarEscenario = () => {
    if (!resultado || guardandoEscenario) return;
    const usuario = window.prompt("¿Quién guarda este escenario? (para poder filtrarlo después)");
    if (!usuario || !usuario.trim()) return;
    const nombreEscenario = window.prompt(
      `Nombre del escenario para "${resultado.productType.nombre}"\n(ej. Con 10k de Shipping - escenario competitivo)`
    );
    if (!nombreEscenario || !nombreEscenario.trim()) return;
    setGuardandoEscenario(true);
    fetch("/api/calc/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usuario: usuario.trim(),
        nombreEscenario: nombreEscenario.trim(),
        productTypeId: resultado.productType.id,
        nombreProducto: resultado.productType.nombre,
        fobUsd: Number(fobUsd),
        pvpFuente: resultado.pvpFuente,
        envioFuente: resultado.envioFuente,
        supuestos: resultado.supuestos,
        productType: resultado.productType,
        resultado: resultado.resultado,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          alert(`No se pudo guardar el escenario: ${d.error}`);
          return;
        }
        reloadEscenarios(filtroUsuarioEscenarios || undefined);
      })
      .catch(() => alert("No se pudo guardar el escenario. Proba de nuevo."))
      .finally(() => setGuardandoEscenario(false));
  };

  const borrarEscenario = (id: number) => {
    const ok = window.confirm("¿Borrar este escenario guardado? Esta acción no se puede deshacer.");
    if (!ok) return;
    fetch(`/api/calc/scenarios/${id}`, { method: "DELETE" })
      .then(() => reloadEscenarios(filtroUsuarioEscenarios || undefined))
      .catch(() => alert("No se pudo borrar. Proba de nuevo."));
  };

  const filtrarEscenariosPorUsuario = (usuario: string) => {
    setFiltroUsuarioEscenarios(usuario);
    reloadEscenarios(usuario || undefined);
  };

  // Mensaje de resultado del flujo OAuth (20/07/2026): Mercado Libre vuelve
  // aca con ?meli_oauth=ok|error&msg=... despues de /api/calc/meli-oauth/callback.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const resultado = params.get("meli_oauth");
    if (!resultado) return;
    if (resultado === "ok") {
      setMeliOauthMsg("✓ Cuenta de Mercado Libre conectada correctamente.");
      reloadMeliOauthStatus();
    } else {
      setMeliOauthMsg(`No se pudo conectar la cuenta de Mercado Libre: ${params.get("msg") ?? "error desconocido"}`);
    }
    window.history.replaceState({}, "", "/calculo-importacion");
  }, []);

  const crearTipoProducto = () => {
    const nombre = nuevoNombre.trim();
    if (!nombre || creando) return;
    setCreando(true);
    setCreandoError(null);
    fetch("/api/calc/product-types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre, ncmCode: nuevoNcm.trim() || undefined }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setCreandoError(d.error);
          return;
        }
        setNuevoNombre("");
        setNuevoNcm("");
        setShowNuevo(false);
        reloadProductTypes();
        if (d.productType) setSelectedId(d.productType.id);
      })
      .catch(() => setCreandoError("No se pudo crear el tipo de producto. Proba de nuevo."))
      .finally(() => setCreando(false));
  };

  const abrirEditar = () => {
    if (!selected) return;
    setEditForm({
      arancelPct: fmtPctInput(selected.arancel_pct),
      ivaPct: fmtPctInput(selected.iva_pct),
      traderPct: fmtPctInput(selected.trader_pct),
      tamanoEnvio: selected.tamano_envio ?? "mediano",
      cbmM3: selected.cbm_m3 != null ? String(selected.cbm_m3) : "",
      pesoKg: selected.peso_kg != null ? String(selected.peso_kg) : "",
    });
    setShowEditar(true);
  };

  const recalcularCampo = (field: "arancel" | "iva" | "cbm" | "pvp" | "peso") => {
    if (!selected || refrescando) return;
    setRefrescando(field);
    fetch(`/api/calc/product-types/${selected.id}/refresh?field=${field}`, { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        if (d.productType) {
          setProductTypes((prev) => prev.map((p) => (p.id === d.productType.id ? d.productType : p)));
          if (editForm) {
            const updated: ProductType = d.productType;
            setEditForm({
              arancelPct: fmtPctInput(updated.arancel_pct),
              ivaPct: fmtPctInput(updated.iva_pct),
              traderPct: fmtPctInput(updated.trader_pct),
              tamanoEnvio: updated.tamano_envio ?? "mediano",
              cbmM3: updated.cbm_m3 != null ? String(updated.cbm_m3) : "",
              pesoKg: updated.peso_kg != null ? String(updated.peso_kg) : "",
            });
          }
        } else if (d.error) {
          alert(`No se pudo recalcular: ${d.error}`);
        }
      })
      .catch(() => alert("No se pudo recalcular. Proba de nuevo."))
      .finally(() => setRefrescando(null));
  };

  const guardarEdit = () => {
    if (!selected || !editForm || guardandoEdit) return;
    setGuardandoEdit(true);
    fetch(`/api/calc/product-types/${selected.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        arancelPct: Number(editForm.arancelPct) / 100,
        ivaPct: Number(editForm.ivaPct) / 100,
        traderPct: Number(editForm.traderPct) / 100,
        tamanoEnvio: editForm.tamanoEnvio,
        cbmM3: Number(editForm.cbmM3),
        pesoKg: editForm.pesoKg ? Number(editForm.pesoKg) : undefined,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.productType) {
          setProductTypes((prev) => prev.map((p) => (p.id === d.productType.id ? d.productType : p)));
          setShowEditar(false);
        }
      })
      .catch(() => alert("No se pudo guardar. Proba de nuevo."))
      .finally(() => setGuardandoEdit(false));
  };

  const borrarTipoProducto = () => {
    if (!selected) return;
    const ok = window.confirm(`¿Borrar el tipo de producto "${selected.nombre}"? Esta acción no se puede deshacer.`);
    if (!ok) return;
    fetch(`/api/calc/product-types/${selected.id}`, { method: "DELETE" })
      .then(() => {
        setSelectedId(null);
        setResultado(null);
        reloadProductTypes();
      })
      .catch(() => alert("No se pudo borrar. Proba de nuevo."));
  };

  const calcular = () => {
    if (!selected || calculando) return;
    const fob = Number(fobUsd);
    if (!Number.isFinite(fob) || fob <= 0) {
      setRunError("Cargá un FOB válido (mayor a 0).");
      return;
    }
    setCalculando(true);
    setRunError(null);
    setResultado(null);
    fetch("/api/calc/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productTypeId: selected.id,
        fobUsd: fob,
        pvpArsManual: pvpManual.trim() ? Number(pvpManual) : undefined,
      }),
    })
      .then((r) => r.json())
      .then((d: RunResult) => {
        if (d.error) {
          setRunError(d.error);
          return;
        }
        setResultado(d);
        if (d.productType) {
          setProductTypes((prev) => prev.map((p) => (p.id === d.productType.id ? d.productType : p)));
        }
      })
      .catch(() => setRunError("No se pudo calcular. Proba de nuevo."))
      .finally(() => setCalculando(false));
  };
  calcularRef.current = calcular;

  const abrirSupuestos = () => {
    if (!supuestos) return;
    setSupuestosForm({
      tipoCambioArs: String(supuestos.tipoCambioArs),
      comisionMlPct: fmtPctInput(supuestos.comisionMlPct),
      iibbPct: fmtPctInput(supuestos.iibbPct),
      padsPct: fmtPctInput(supuestos.padsPct),
      tasaEstadisticaPct: fmtPctInput(supuestos.tasaEstadisticaPct),
      tasaEstadisticaTopeUsd: String(supuestos.tasaEstadisticaTopeUsd),
      ley25413Pct: fmtPctInput(supuestos.ley25413Pct),
      seguroUsdUnidad: String(supuestos.seguroUsdUnidad),
      feeBajoTicketArs: String(supuestos.feeBajoTicketArs),
      umbralBajoValorArs: String(supuestos.umbralBajoValorArs),
      descuentoDistribucionPct: fmtPctInput(supuestos.descuentoDistribucionPct),
      fleteMaritimoUsd: String(supuestos.fleteMaritimoUsd),
      forwarderUsd: String(supuestos.forwarderUsd),
      despachanteUsd: String(supuestos.despachanteUsd),
      thcUsd: String(supuestos.thcUsd),
      fleteLocalUsd: String(supuestos.fleteLocalUsd),
      manipuleoUsd: String(supuestos.manipuleoUsd),
      capacidadCbmContenedor: String(supuestos.capacidadCbmContenedor),
      capacidad20ftM3: String(supuestos.capacidad20ftM3),
      envioChicoArs: String(supuestos.envioChicoArs),
      envioMedianoArs: String(supuestos.envioMedianoArs),
      envioGrandeArs: String(supuestos.envioGrandeArs),
    });
    setShowSupuestos(true);
  };

  const guardarSupuestos = () => {
    if (!supuestosForm || guardandoSupuestos) return;
    setGuardandoSupuestos(true);
    fetch("/api/calc/supuestos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tipoCambioArs: Number(supuestosForm.tipoCambioArs),
        comisionMlPct: Number(supuestosForm.comisionMlPct) / 100,
        iibbPct: Number(supuestosForm.iibbPct) / 100,
        padsPct: Number(supuestosForm.padsPct) / 100,
        tasaEstadisticaPct: Number(supuestosForm.tasaEstadisticaPct) / 100,
        tasaEstadisticaTopeUsd: Number(supuestosForm.tasaEstadisticaTopeUsd),
        ley25413Pct: Number(supuestosForm.ley25413Pct) / 100,
        seguroUsdUnidad: Number(supuestosForm.seguroUsdUnidad),
        feeBajoTicketArs: Number(supuestosForm.feeBajoTicketArs),
        umbralBajoValorArs: Number(supuestosForm.umbralBajoValorArs),
        descuentoDistribucionPct: Number(supuestosForm.descuentoDistribucionPct) / 100,
        fleteMaritimoUsd: Number(supuestosForm.fleteMaritimoUsd),
        forwarderUsd: Number(supuestosForm.forwarderUsd),
        despachanteUsd: Number(supuestosForm.despachanteUsd),
        thcUsd: Number(supuestosForm.thcUsd),
        fleteLocalUsd: Number(supuestosForm.fleteLocalUsd),
        manipuleoUsd: Number(supuestosForm.manipuleoUsd),
        capacidadCbmContenedor: Number(supuestosForm.capacidadCbmContenedor),
        capacidad20ftM3: Number(supuestosForm.capacidad20ftM3),
        envioChicoArs: Number(supuestosForm.envioChicoArs),
        envioMedianoArs: Number(supuestosForm.envioMedianoArs),
        envioGrandeArs: Number(supuestosForm.envioGrandeArs),
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.supuestos) {
          setSupuestos(d.supuestos);
          setShowSupuestos(false);
        }
      })
      .catch(() => alert("No se pudo guardar. Proba de nuevo."))
      .finally(() => setGuardandoSupuestos(false));
  };

  const recalcularFlete = () => {
    if (refrescandoFlete) return;
    setRefrescandoFlete(true);
    fetch("/api/calc/supuestos/refresh-flete", { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          alert(`No se pudo recalcular el flete: ${d.error}`);
          return;
        }
        reloadSupuestos();
        if (supuestosForm) {
          setSupuestosForm({ ...supuestosForm, fleteMaritimoUsd: String(d.fleteMaritimoUsd) });
        }
      })
      .catch(() => alert("No se pudo recalcular el flete. Proba de nuevo."))
      .finally(() => setRefrescandoFlete(false));
  };
  const recalcularTipoCambio = () => {
    if (refrescandoTipoCambio) return;
    setRefrescandoTipoCambio(true);
    fetch("/api/calc/supuestos/refresh-tipo-cambio", { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          alert(`No se pudo actualizar el tipo de cambio: ${d.error}`);
          return;
        }
        reloadSupuestos();
        if (supuestosForm) {
          setSupuestosForm({ ...supuestosForm, tipoCambioArs: String(d.tipoCambioArs) });
        }
      })
      .catch(() => alert("No se pudo actualizar el tipo de cambio. Proba de nuevo."))
      .finally(() => setRefrescandoTipoCambio(false));
  };

  const inputStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box" };

  return (
    <>
      <AppHeader
        title="Calculador de Importación"
        actions={
          <Link href="/" className="app-header-nav-btn">
            ← Volver al módulo de importaciones
          </Link>
        }
      />
      <div className="container">
        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
            <h1 style={{ fontSize: 15, margin: 0 }}>Tipo de producto</h1>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {meliConectado === false && (
                <button onClick={() => (window.location.href = "/api/calc/meli-oauth/authorize")} style={{ fontSize: 12 }}>
                  <Ic n="link" e="🔗" /> Conectar cuenta de Mercado Libre
                </button>
              )}
              {meliConectado === true && (
                <span style={{ fontSize: 11.5, color: "var(--muted)" }}><Ic n="dot" e="🟢" /> Mercado Libre conectado</span>
              )}
              <button onClick={abrirSupuestos} disabled={!supuestos} style={{ fontSize: 12 }}>
                <Ic n="sliders" e="⚙️" /> Supuestos generales
              </button>
            </div>
          </div>
          {meliOauthMsg && (
            <div style={{ fontSize: 12, color: meliOauthMsg.startsWith("✓") ? "#2fa84f" : "#d93a3a", marginBottom: 8 }}>
              {meliOauthMsg}
            </div>
          )}
          <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 12 }}>
            Catálogo abierto: creá cualquier tipo de producto que necesites (no está atado a las categorías del
            dashboard). Arancel, IVA y CBM se estiman con IA la primera vez y quedan guardados.
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={selectedId ?? ""}
              onChange={(e) => {
                setSelectedId(e.target.value ? Number(e.target.value) : null);
                setResultado(null);
                setRunError(null);
              }}
              style={{ minWidth: 240 }}
              disabled={loadingTypes}
            >
              <option value="">{loadingTypes ? "Cargando..." : "Elegí un tipo de producto"}</option>
              {productTypes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
            </select>
            <button onClick={() => setShowNuevo((v) => !v)} style={{ fontSize: 13 }}>
              + Nuevo tipo de producto
            </button>
            {selected && (
              <>
                <button onClick={abrirEditar} style={{ fontSize: 13 }}>
                  ✎ Editar
                </button>
                <button onClick={borrarTipoProducto} style={{ fontSize: 13, color: "#d93a3a", borderColor: "#d93a3a" }}>
                  <Ic n="trash" e="🗑" /> Borrar
                </button>
              </>
            )}
          </div>

          {showNuevo && (
            <div
              style={{
                marginTop: 14,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 14,
              }}
            >
              <div className="row">
                <div style={{ flex: 2, minWidth: 220 }}>
                  <label>Nombre del tipo de producto</label>
                  <input
                    type="text"
                    value={nuevoNombre}
                    onChange={(e) => setNuevoNombre(e.target.value)}
                    placeholder='ej. "Silla de Ruedas", "TV 32 pulgadas"'
                  />
                </div>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <label>NCM (opcional)</label>
                  <input type="text" value={nuevoNcm} onChange={(e) => setNuevoNcm(e.target.value)} placeholder="8713.10.00" />
                </div>
              </div>
              {creandoError && <div style={{ color: "#d93a3a", fontSize: 12, marginTop: 6 }}>{creandoError}</div>}
              <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                <button
                  onClick={crearTipoProducto}
                  disabled={creando || !nuevoNombre.trim()}
                  style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
                >
                  {creando && <Spinner />}
                  {creando ? "Estimando arancel/IVA/CBM con IA..." : "Crear"}
                </button>
                <button onClick={() => setShowNuevo(false)} disabled={creando}>
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {selected && (
            <div style={{ marginTop: 14, display: "flex", gap: "10px 22px", flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
              <div>
                <span style={{ color: "var(--muted)" }}>Arancel: </span>
                <strong>{selected.arancel_pct != null ? fmtPct(selected.arancel_pct) : "—"}</strong>
                <ConfianzaDot confianza={selected.arancel_confianza} razonamiento={selected.arancel_razonamiento} />
              </div>
              <div>
                <span style={{ color: "var(--muted)" }}>IVA: </span>
                <strong>{selected.iva_pct != null ? fmtPct(selected.iva_pct) : "—"}</strong>
                <ConfianzaDot confianza={selected.iva_confianza} razonamiento={selected.iva_razonamiento} />
              </div>
              <div>
                <span style={{ color: "var(--muted)" }}>CBM: </span>
                <strong>{selected.cbm_m3 != null ? `${selected.cbm_m3} m³` : "—"}</strong>
                <ConfianzaDot confianza={selected.cbm_confianza} razonamiento={selected.cbm_razonamiento} />
              </div>
              <div>
                <span style={{ color: "var(--muted)" }}>Trader: </span>
                <strong>{fmtPct(selected.trader_pct)}</strong>
              </div>
              <div>
                <span style={{ color: "var(--muted)" }}>Tamaño envío: </span>
                <strong>
                  {selected.tamano_envio === "chico" ? "Chico" : selected.tamano_envio === "grande" ? "Grande" : "Mediano"}
                </strong>
                {" "}
                <span style={{ color: "var(--muted)", fontSize: 11.5 }}>
                  (según CBM{selected.envio_meli_api_status === "found" ? " — última consulta API: OK" : ""})
                </span>
              </div>
              {supuestos && (
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ color: "var(--muted)" }}>Unidades por 40HC: </span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={unidades40hc}
                    readOnly
                    onClick={abrirCaja}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrirCaja(); } }}
                    title="Tocá para cargar las medidas de la caja (ancho, largo y profundidad) y recalcular cuántas entran en el 40HC"
                    style={{ width: 90, padding: "3px 6px", fontWeight: 700, cursor: "pointer" }}
                  />
                  <button type="button" onClick={abrirCaja} title="Medidas de la caja" aria-label="Medidas de la caja" style={{ padding: "3px 8px" }}>
                    <Ic n="sliders" e="📐" />
                  </button>
                  {guardandoCbm && <Spinner />}
                  {selected.cbm_m3 != null && selected.cbm_m3 > 0 && (
                    <span style={{ whiteSpace: "nowrap" }}>
                      <span style={{ color: "var(--muted)" }}>· 20FT: </span>
                      <strong>{Math.floor(supuestos.capacidad20ftM3 / selected.cbm_m3)} un</strong>
                    </span>
                  )}
                </div>
              )}
              <div>
                <span style={{ color: "var(--muted)" }}>Peso facturable: </span>
                <strong>{selected.peso_kg != null ? `${selected.peso_kg} kg` : "—"}</strong>
                <ConfianzaDot confianza={selected.peso_confianza} razonamiento={selected.peso_razonamiento} />
              </div>
              <div>
                <span style={{ color: "var(--muted)" }}>PVP mercado (IA): </span>
                <strong>{selected.pvp_ars_estimado != null ? `$${fmtNumber(selected.pvp_ars_estimado)}` : "—"}</strong>
                <ConfianzaDot confianza={selected.pvp_confianza} razonamiento={selected.pvp_razonamiento} />
              </div>
            </div>
          )}
        </div>

        {selected && (
          <div className="panel">
            <h1 style={{ fontSize: 15, marginTop: 0, marginBottom: 12 }}>Calcular</h1>
            <div className="row">
              <div style={{ flex: 1, minWidth: 160 }}>
                <label>FOB (USD)</label>
                <input
                  type="number"
                  value={fobUsd}
                  onChange={(e) => setFobUsd(e.target.value)}
                  placeholder="ej. 24.00"
                />
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label>PVP MeLi (ARS con IVA) — opcional</label>
                <input
                  type="number"
                  value={pvpManual}
                  onChange={(e) => setPvpManual(e.target.value)}
                  placeholder="dejar vacío para estimar con IA"
                />
              </div>
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button
                  onClick={calcular}
                  disabled={calculando || !fobUsd}
                  style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
                >
                  {calculando && <Spinner />}
                  {calculando ? "Calculando..." : "Calcular"}
                </button>
              </div>
            </div>
            {runError && <div style={{ color: "#d93a3a", fontSize: 13, marginTop: 10 }}>{runError}</div>}
          </div>
        )}

        {resultado && !resultado.error && (
          <>
            <div className="panel">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
                <h1 style={{ fontSize: 15, margin: 0 }}>Costo Nacionalizado</h1>
                <button
                  onClick={guardarEscenario}
                  disabled={guardandoEscenario}
                  style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }}
                >
                  {guardandoEscenario && <Spinner />}
                  <Ic n="save" e="💾" /> Guardar escenario
                </button>
              </div>
              <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 10 }}>
                PVP de MeLi usado en este cálculo: ${fmtNumber(resultado.resultado.meli.pvpConIva)}{" "}
                {resultado.pvpFuente === "manual" && "(cargado a mano)"}
                {resultado.pvpFuente === "cache" && "(estimado por IA, ya cacheado)"}
                {resultado.pvpFuente === "ia" && "(recién estimado por IA)"}
              </div>
              <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 10 }}>
                Costo de envío usado: {resultado.envioFuente === "api" ? "dato real de la API de Mercado Libre ✓" : "tabla fija (editable en Supuestos generales)"}
              </div>
              <div className="table-scroll">
              <table className="admin-table" style={{ fontSize: 13 }}>
                <tbody>
                  <tr>
                    <td>FOB</td>
                    <td style={{ textAlign: "right" }}>US$ {fmtUsd(Number(fobUsd))}</td>
                  </tr>
                  <tr>
                    <td>+ Trader ({fmtPct(resultado.productType.trader_pct)})</td>
                    <td style={{ textAlign: "right" }}>US$ {fmtUsd(resultado.resultado.costoNacionalizado.traderUsd)}</td>
                  </tr>
                  <tr>
                    <td>+ Seguro</td>
                    <td style={{ textAlign: "right" }}>US$ {fmtUsd(resultado.resultado.costoNacionalizado.seguroUsd)}</td>
                  </tr>
                  <tr>
                    <td>
                      <strong>CIF</strong>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <strong>US$ {fmtUsd(resultado.resultado.costoNacionalizado.cifUsd)}</strong>
                    </td>
                  </tr>
                  <tr>
                    <td>+ Arancel ({fmtPct(resultado.productType.arancel_pct ?? 0)} sobre CIF)</td>
                    <td style={{ textAlign: "right" }}>US$ {fmtUsd(resultado.resultado.costoNacionalizado.arancelUsd)}</td>
                  </tr>
                  <tr>
                    <td>+ Tasa estadística</td>
                    <td style={{ textAlign: "right" }}>
                      US$ {fmtUsd(resultado.resultado.costoNacionalizado.tasaEstadisticaUsd)}
                    </td>
                  </tr>
                  <tr>
                    <td>+ Ley 25413</td>
                    <td style={{ textAlign: "right" }}>US$ {fmtUsd(resultado.resultado.costoNacionalizado.ley25413Usd)}</td>
                  </tr>
                  <tr>
                    <td>+ Logística ({resultado.productType.cbm_m3} m³ × US$ {fmtUsd(resultado.resultado.costoNacionalizado.costoFijoPorCbmUsd)}/m³)</td>
                    <td style={{ textAlign: "right" }}>US$ {fmtUsd(resultado.resultado.costoNacionalizado.logisticaUsd)}</td>
                  </tr>
                  <tr>
                    <td>
                      <strong>COSTO NACIONALIZADO</strong>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <strong>US$ {fmtUsd(resultado.resultado.costoNacionalizado.costoNacionalizadoUsd)}</strong>
                      <span style={{ margin: "0 8px" }}>—</span>
                      <strong style={{ fontSize: 24, color: "#1f9d47" }}>
                        ${fmtNumber(resultado.resultado.costoNacionalizado.costoNacionalizadoArs)}
                      </strong>
                    </td>
                  </tr>
                </tbody>
              </table>
              </div>
            </div>

            <div className="stack-row">
              <div className="panel">
                <h1 style={{ fontSize: 15, marginTop: 0, marginBottom: 12 }}>Vendiendo por MeLi</h1>
                {/* mismo alto que la nota de la tarjeta de al lado, así las dos tablas arrancan a la misma altura (se oculta cuando se apilan en celular) */}
                <div className="nota-espejo" aria-hidden="true" style={{ fontSize: 12, marginBottom: 10, visibility: "hidden" }}>.</div>
                <CanalTable
                  canal={resultado.resultado.meli}
                  showMeliDetalle
                  costoNacionalizadoArs={resultado.resultado.costoNacionalizado.costoNacionalizadoArs}
                />
              </div>
              <div className="panel">
                <h1 style={{ fontSize: 15, marginTop: 0, marginBottom: 12 }}>Vendiendo a Distribución</h1>
                <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 10 }}>
                  PVP = PVP MeLi × (1 − {fmtPct(resultado.supuestos.descuentoDistribucionPct)})
                </div>
                <CanalTable
                  canal={resultado.resultado.distribucion}
                  showMeliDetalle={false}
                  costoNacionalizadoArs={resultado.resultado.costoNacionalizado.costoNacionalizadoArs}
                />
              </div>
            </div>
          </>
        )}

        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            <h1 style={{ fontSize: 15, margin: 0 }}>Historial de escenarios</h1>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <label style={{ fontSize: 12, color: "var(--muted)" }}>Usuario:</label>
              <select
                value={filtroUsuarioEscenarios}
                onChange={(e) => filtrarEscenariosPorUsuario(e.target.value)}
                style={{ fontSize: 12.5 }}
              >
                <option value="">Todos</option>
                {usuariosEscenarios.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {escenarios.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>Todavía no hay escenarios guardados.</div>
          ) : (
            <div className="table-scroll">
            <table className="admin-table" style={{ fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Usuario</th>
                  <th>Producto</th>
                  <th>Escenario</th>
                  <th style={{ textAlign: "right" }}>FOB</th>
                  <th style={{ textAlign: "right" }}>PVP MeLi</th>
                  <th style={{ textAlign: "right" }}>T. cambio</th>
                  <th style={{ textAlign: "right" }}>CBM</th>
                  <th>Envío</th>
                  <th style={{ textAlign: "right" }}>Margen MeLi</th>
                  <th style={{ textAlign: "right" }}>Margen Distr.</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {escenarios.map((esc) => (
                  <tr key={esc.id}>
                    <td>{new Date(esc.createdAt).toLocaleDateString("es-AR")}</td>
                    <td>{esc.usuario}</td>
                    <td>{esc.nombreProducto}</td>
                    <td>{esc.nombreEscenario ?? "—"}</td>
                    <td style={{ textAlign: "right" }}>US$ {fmtUsd(esc.fobUsd)}</td>
                    <td style={{ textAlign: "right" }}>{esc.pvpMeliArsConIva != null ? `$${fmtNumber(esc.pvpMeliArsConIva)}` : "—"}</td>
                    <td style={{ textAlign: "right" }}>{esc.tipoCambioArs != null ? fmtNumber(esc.tipoCambioArs) : "—"}</td>
                    <td style={{ textAlign: "right" }}>{esc.cbmM3 != null ? esc.cbmM3 : "—"}</td>
                    <td>{esc.envioFuente === "api" ? "API" : "tabla fija"}</td>
                    <td style={{ textAlign: "right" }}>{esc.margenMeliPct != null ? fmtPct(esc.margenMeliPct) : "—"}</td>
                    <td style={{ textAlign: "right" }}>{esc.margenDistribucionPct != null ? fmtPct(esc.margenDistribucionPct) : "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      <button onClick={() => borrarEscenario(esc.id)} style={{ fontSize: 11.5 }}>
                        Borrar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>

      {showEditar && selected && editForm && (
        <div
          onClick={() => setShowEditar(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
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
              background: "#fff",
              borderRadius: 10,
              padding: 20,
              maxWidth: 480,
              width: "100%",
            }}
          >
            <h1 style={{ fontSize: 16, marginTop: 0 }}>Editar "{selected.nombre}"</h1>
            <div className="row">
              <div style={{ flex: 1, minWidth: 140 }}>
                <label>Arancel %</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="number"
                    value={editForm.arancelPct}
                    onChange={(e) => setEditForm({ ...editForm, arancelPct: e.target.value })}
                    style={inputStyle}
                  />
                  <button onClick={() => recalcularCampo("arancel")} disabled={refrescando === "arancel"} title="Recalcular con IA">
                    {refrescando === "arancel" ? <Spinner /> : <Ic n="refresh" e="🔄" />}
                  </button>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label>IVA %</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="number"
                    value={editForm.ivaPct}
                    onChange={(e) => setEditForm({ ...editForm, ivaPct: e.target.value })}
                    style={inputStyle}
                  />
                  <button onClick={() => recalcularCampo("iva")} disabled={refrescando === "iva"} title="Recalcular con IA">
                    {refrescando === "iva" ? <Spinner /> : <Ic n="refresh" e="🔄" />}
                  </button>
                </div>
              </div>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label>CBM (m³)</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="number"
                    value={editForm.cbmM3}
                    onChange={(e) => setEditForm({ ...editForm, cbmM3: e.target.value })}
                    style={inputStyle}
                  />
                  <button onClick={() => recalcularCampo("cbm")} disabled={refrescando === "cbm"} title="Recalcular con IA">
                    {refrescando === "cbm" ? <Spinner /> : <Ic n="refresh" e="🔄" />}
                  </button>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label>Trader % (manual)</label>
                <input
                  type="number"
                  value={editForm.traderPct}
                  onChange={(e) => setEditForm({ ...editForm, traderPct: e.target.value })}
                  style={inputStyle}
                />
              </div>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label>Tamaño de envío (Mercado Envíos)</label>
                <select
                  value={editForm.tamanoEnvio}
                  onChange={(e) => setEditForm({ ...editForm, tamanoEnvio: e.target.value as TamanoEnvio })}
                  style={inputStyle}
                >
                  <option value="chico">Chico</option>
                  <option value="mediano">Mediano</option>
                  <option value="grande">Grande (ej. silla de ruedas)</option>
                </select>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                  Se usa como respaldo si la consulta a la API de Mercado Libre falla.
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label>PVP mercado (IA)</label>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 13 }}>
                    {selected.pvp_ars_estimado != null ? `$${fmtNumber(selected.pvp_ars_estimado)}` : "sin dato"}
                  </span>
                  <button onClick={() => recalcularCampo("pvp")} disabled={refrescando === "pvp"} title="Recalcular con IA">
                    {refrescando === "pvp" ? <Spinner /> : <Ic n="refresh" e="🔄" />}
                  </button>
                </div>
              </div>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label>Peso facturable (kg, para API Mercado Libre)</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="number"
                    value={editForm.pesoKg}
                    onChange={(e) => setEditForm({ ...editForm, pesoKg: e.target.value })}
                    style={inputStyle}
                  />
                  <button onClick={() => recalcularCampo("peso")} disabled={refrescando === "peso"} title="Recalcular con IA">
                    {refrescando === "peso" ? <Spinner /> : <Ic n="refresh" e="🔄" />}
                  </button>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label>Categoría Mercado Libre (auto)</label>
                <div style={{ fontSize: 13, minHeight: 40, display: "flex", alignItems: "center" }}>
                  {selected.ml_category_nombre ? `${selected.ml_category_nombre} (${selected.ml_category_id})` : "se detecta al calcular"}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--muted)", background: "var(--bg)", borderRadius: 6, padding: 8 }}>
              <strong>API Mercado Libre (envío):</strong> estado = {selected.envio_meli_api_status}
              {selected.envio_meli_api_ars != null && ` — último costo encontrado: $${fmtNumber(selected.envio_meli_api_ars)}`}
              {selected.envio_meli_api_razonamiento && (
                <div style={{ marginTop: 4, wordBreak: "break-all" }}>{selected.envio_meli_api_razonamiento.slice(0, 3000)}</div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={() => setShowEditar(false)} disabled={guardandoEdit}>
                Cancelar
              </button>
              <button onClick={guardarEdit} disabled={guardandoEdit}>
                {guardandoEdit ? "Guardando..." : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSupuestos && supuestosForm && (
        <div
          onClick={() => setShowSupuestos(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            overflowY: "auto",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "#fff", borderRadius: 10, padding: 20, maxWidth: 620, width: "100%" }}
          >
            <h1 style={{ fontSize: 16, marginTop: 0 }}>Supuestos generales</h1>
            <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 14 }}>
              Aplican a TODOS los tipos de producto. Solo Arancel, IVA, CBM y Trader se definen por tipo de producto.
            </div>
            <div className="row">
              <div style={{ flex: 1, minWidth: 140 }}>
                <label>Tipo de cambio (ARS/USD)</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="number"
                    value={supuestosForm.tipoCambioArs}
                    onChange={(e) => setSupuestosForm({ ...supuestosForm, tipoCambioArs: e.target.value })}
                    style={inputStyle}
                  />
                  <button onClick={recalcularTipoCambio} disabled={refrescandoTipoCambio} title="Actualizar con el dólar oficial (BCRA)">
                    {refrescandoTipoCambio ? <Spinner /> : <Ic n="refresh" e="🔄" />}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                  {supuestos?.tipoCambioFuenteFecha
                    ? `Oficial BCRA al ${supuestos.tipoCambioFuenteFecha}. Es un valor oscilante: podés pisarlo a mano cuando quieras.`
                    : "Editable a mano, o actualizalo con el dólar oficial del BCRA (🔄)."}
                </div>
              </div>
              <Campo label="Comisión Mercado Libre %" value={supuestosForm.comisionMlPct} onChange={(v) => setSupuestosForm({ ...supuestosForm, comisionMlPct: v })} />
              <Campo label="IIBB %" value={supuestosForm.iibbPct} onChange={(v) => setSupuestosForm({ ...supuestosForm, iibbPct: v })} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Campo label="PADS %" value={supuestosForm.padsPct} onChange={(v) => setSupuestosForm({ ...supuestosForm, padsPct: v })} />
              <Campo label="Tasa estadística %" value={supuestosForm.tasaEstadisticaPct} onChange={(v) => setSupuestosForm({ ...supuestosForm, tasaEstadisticaPct: v })} />
              <Campo label="Tope Tasa Estadística (USD)" value={supuestosForm.tasaEstadisticaTopeUsd} onChange={(v) => setSupuestosForm({ ...supuestosForm, tasaEstadisticaTopeUsd: v })} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Campo label="Ley 25413 %" value={supuestosForm.ley25413Pct} onChange={(v) => setSupuestosForm({ ...supuestosForm, ley25413Pct: v })} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Campo label="Seguro por unidad (USD)" value={supuestosForm.seguroUsdUnidad} onChange={(v) => setSupuestosForm({ ...supuestosForm, seguroUsdUnidad: v })} />
              <Campo label="Fee producto de bajo valor (ARS)" value={supuestosForm.feeBajoTicketArs} onChange={(v) => setSupuestosForm({ ...supuestosForm, feeBajoTicketArs: v })} />
              <Campo label="Umbral de bajo valor (ARS)" value={supuestosForm.umbralBajoValorArs} onChange={(v) => setSupuestosForm({ ...supuestosForm, umbralBajoValorArs: v })} />
            </div>
            <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 6 }}>
              Si el PVP con IVA de MeLi es menor al umbral de arriba, se cobra solo el Fee de bajo valor. Si es mayor o
              igual, se cobra el costo de envío de Mercado Envíos según el tamaño del producto (abajo).
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Campo label="Envío chico (ARS)" value={supuestosForm.envioChicoArs} onChange={(v) => setSupuestosForm({ ...supuestosForm, envioChicoArs: v })} />
              <Campo label="Envío mediano (ARS)" value={supuestosForm.envioMedianoArs} onChange={(v) => setSupuestosForm({ ...supuestosForm, envioMedianoArs: v })} />
              <Campo label="Envío grande (ARS, ej. silla de ruedas)" value={supuestosForm.envioGrandeArs} onChange={(v) => setSupuestosForm({ ...supuestosForm, envioGrandeArs: v })} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Campo label="Descuento Distribución %" value={supuestosForm.descuentoDistribucionPct} onChange={(v) => setSupuestosForm({ ...supuestosForm, descuentoDistribucionPct: v })} />
              <div style={{ flex: 1, minWidth: 140 }}>
                <label>Flete marítimo (USD/contenedor)</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="number"
                    value={supuestosForm.fleteMaritimoUsd}
                    onChange={(e) => setSupuestosForm({ ...supuestosForm, fleteMaritimoUsd: e.target.value })}
                    style={inputStyle}
                  />
                  <button onClick={recalcularFlete} disabled={refrescandoFlete} title="Recalcular con IA">
                    {refrescandoFlete ? <Spinner /> : <Ic n="refresh" e="🔄" />}
                  </button>
                </div>
                {supuestos?.fleteRazonamiento && (
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{supuestos.fleteRazonamiento}</div>
                )}
              </div>
              <Campo label="Capacidad contenedor 40HC (CBM)" value={supuestosForm.capacidadCbmContenedor} onChange={(v) => setSupuestosForm({ ...supuestosForm, capacidadCbmContenedor: v })} />
              <Campo label="Capacidad contenedor 20FT (CBM)" value={supuestosForm.capacidad20ftM3} onChange={(v) => setSupuestosForm({ ...supuestosForm, capacidad20ftM3: v })} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Campo label="Forwarder (USD)" value={supuestosForm.forwarderUsd} onChange={(v) => setSupuestosForm({ ...supuestosForm, forwarderUsd: v })} />
              <Campo label="Despachante (USD)" value={supuestosForm.despachanteUsd} onChange={(v) => setSupuestosForm({ ...supuestosForm, despachanteUsd: v })} />
              <Campo label="THC / terminal (USD)" value={supuestosForm.thcUsd} onChange={(v) => setSupuestosForm({ ...supuestosForm, thcUsd: v })} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Campo label="Flete local puerto→depósito (USD)" value={supuestosForm.fleteLocalUsd} onChange={(v) => setSupuestosForm({ ...supuestosForm, fleteLocalUsd: v })} />
              <Campo label="Manipuleo (USD)" value={supuestosForm.manipuleoUsd} onChange={(v) => setSupuestosForm({ ...supuestosForm, manipuleoUsd: v })} />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={() => setShowSupuestos(false)} disabled={guardandoSupuestos}>
                Cancelar
              </button>
              <button onClick={guardarSupuestos} disabled={guardandoSupuestos}>
                {guardandoSupuestos ? "Guardando..." : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCaja && selected && supuestos && (
        <div
          onClick={() => setShowCaja(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="caja-titulo"
            style={{ background: "#fff", borderRadius: 10, padding: 20, maxWidth: 460, width: "100%", maxHeight: "90vh", overflowY: "auto" }}
          >
            <h1 id="caja-titulo" style={{ fontSize: 16, marginTop: 0 }}>Unidades por 40HC · "{selected.nombre}"</h1>
            <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 0 }}>
              Cargá las medidas de UNA caja y calculo cuántas entran en el contenedor (capacidad del 40HC: {supuestos.capacidadCbmContenedor} m³, se cambia en Supuestos generales).
            </p>
            <div className="row">
              {([["ancho", "Ancho (cm)"], ["largo", "Largo (cm)"], ["prof", "Profundidad (cm)"]] as const).map(([k, rotulo]) => (
                <div key={k} style={{ flex: 1, minWidth: 120 }}>
                  <label>{rotulo}</label>
                  <input
                    type="number"
                    min={0}
                    step="0.1"
                    inputMode="decimal"
                    value={cajaForm[k]}
                    onChange={(e) => setCajaForm({ ...cajaForm, [k]: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") aplicarCaja(); }}
                    autoFocus={k === "ancho"}
                    style={inputStyle}
                  />
                </div>
              ))}
              <div style={{ flex: 1, minWidth: 120 }}>
                <label>Unidades por caja</label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={cajaForm.porCaja}
                  onChange={(e) => setCajaForm({ ...cajaForm, porCaja: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") aplicarCaja(); }}
                  style={inputStyle}
                />
              </div>
            </div>

            {cajaCalculo ? (
              <div style={{ marginTop: 14, padding: 12, background: "#f4f8f7", borderRadius: 8, fontSize: 14, lineHeight: 1.6 }}>
                <div>Volumen por caja: <strong>{cajaCalculo.volM3.toFixed(4)} m³</strong></div>
                <div>
                  Entran <strong>{cajaCalculo.cajas.toLocaleString("es-AR")} cajas</strong> = <strong style={{ fontSize: 18 }}>{cajaCalculo.unidades.toLocaleString("es-AR")} unidades</strong> en el 40HC
                </div>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>
                  Referencia por acomodo en un 40HC estándar (12,03 × 2,35 × 2,69 m, mejor orientación): {cajaCalculo.acomodo.toLocaleString("es-AR")} cajas ({cajaCalculo.acomodoUnidades.toLocaleString("es-AR")} un). Para el costo se usa el cálculo por capacidad del 40HC, la misma con la que se reparte el costo del contenedor.
                </div>
                {cajaCalculo.cajas <= 0 && <div style={{ color: "var(--danger, #b3261e)" }}>La caja es más grande que el contenedor: revisá las medidas.</div>}
              </div>
            ) : (
              <div style={{ marginTop: 14 }}>
                <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 6 }}>…o cargá las unidades por 40HC a mano:</div>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={cajaForm.manual}
                  onChange={(e) => setCajaForm({ ...cajaForm, manual: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") aplicarCaja(); }}
                  style={{ ...inputStyle, maxWidth: 180 }}
                />
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={() => setShowCaja(false)}>Cancelar</button>
              <button onClick={aplicarCaja} disabled={cajaCalculo ? cajaCalculo.unidades <= 0 : !(Number(cajaForm.manual) > 0)}>
                Aplicar y recalcular
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Campo({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ flex: 1, minWidth: 140 }}>
      <label>{label}</label>
      <input type="number" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} />
    </div>
  );
}

function CanalTable({
  canal,
  showMeliDetalle,
  costoNacionalizadoArs,
}: {
  canal: CalcCanal;
  showMeliDetalle: boolean;
  costoNacionalizadoArs: number;
}) {
  return (
    <div className="table-scroll">
    <table className="admin-table" style={{ fontSize: 13 }}>
      <tbody>
        <tr>
          <td>PVP (con IVA)</td>
          <td style={{ textAlign: "right" }}>${fmtNumber(canal.pvpConIva)}</td>
        </tr>
        <tr>
          <td>PVP neto de IVA</td>
          <td style={{ textAlign: "right" }}>${fmtNumber(canal.pvpNeto)}</td>
        </tr>
        {showMeliDetalle && (
          <>
            <tr>
              <td>(−) Comisión Mercado Libre</td>
              <td style={{ textAlign: "right" }}>${fmtNumber(canal.comisionMlArs)}</td>
            </tr>
            <tr>
              <td>(−) Envío (Mercado Envíos, {canal.envioPorTamanoAplica ? "según tamaño" : "no aplica, bajo umbral"})</td>
              <td style={{ textAlign: "right" }}>${fmtNumber(canal.envioNetoArs)}</td>
            </tr>
            <tr>
              <td>(−) PADS</td>
              <td style={{ textAlign: "right" }}>${fmtNumber(canal.padsArs)}</td>
            </tr>
            {canal.feeBajoTicketArs > 0 && (
              <tr>
                <td>(−) Fee producto de bajo valor</td>
                <td style={{ textAlign: "right" }}>${fmtNumber(canal.feeBajoTicketArs)}</td>
              </tr>
            )}
          </>
        )}
        <tr>
          <td>(−) IIBB</td>
          <td style={{ textAlign: "right" }}>${fmtNumber(canal.iibbArs)}</td>
        </tr>
        <tr>
          <td>(−) Costo nacionalizado</td>
          <td style={{ textAlign: "right" }}>${fmtNumber(costoNacionalizadoArs)}</td>
        </tr>
        <tr>
          <td>
            <strong>MARGEN ABSOLUTO</strong>
          </td>
          <td style={{ textAlign: "right" }}>
            <strong style={{ color: canal.margenArs >= 0 ? "#2fa84f" : "#d93a3a" }}>${fmtNumber(canal.margenArs)}</strong>
          </td>
        </tr>
        <tr>
          <td>Margen % (sobre neto)</td>
          <td style={{ textAlign: "right" }}>{fmtPct(canal.margenPctSobreNeto)}</td>
        </tr>
        <tr>
          <td>Margen % (sobre PVP con IVA)</td>
          <td style={{ textAlign: "right" }}>{fmtPct(canal.margenPctSobreConIva)}</td>
        </tr>
      </tbody>
    </table>
    </div>
  );
}
