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
  alto_cm: number | null; // medidas de la caja unitaria (paso Tamaño)
  ancho_cm: number | null;
  prof_cm: number | null;
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
  pvpFuente: "manual" | "cache" | "ia" | "objetivo";
  /** Presente cuando el precio se calculó al revés a partir de un margen objetivo (sobre la venta neta de IVA). */
  gmObjetivo?: { pct: number; base: string; precio: number };
  /** Presente en el modo «¿A cuánto puedo comprarlo?»: FOB máximo por unidad para el precio y el margen pedidos. */
  fobMaximo?: { fobUsd: number; pvp: number; margenPct: number };
  envioFuente: "api" | "tabla_fija";
  resultado: {
    costoNacionalizado: CalcCostoNacionalizado;
    meli: CalcCanal;
    distribucion: CalcCanal;
  };
  /** FOB con el que se calculó este resultado (el casillero puede haber cambiado después sin recalcular). */
  fobUsdCalculado?: number;
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
      title={razonamiento ? `Estimado por IA, confianza ${confianza}. ${razonamiento}` : `Estimado por IA, confianza ${confianza}`}
      aria-label={`Estimado por IA, confianza ${confianza}`}
      role="img"
      style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        display: "inline-block",
        marginLeft: 6,
        background: CONFIANZA_COLOR[confianza] ?? "#999999",
      }}
    />
  );
}

// Impuestos de la posición (Arancel Integrado de ARCA). die = derecho de importación para origen fuera del Mercosur; dii = origen Mercosur con certificado.
interface NcmTarifa {
  die: number;
  dieMax: number | null; // algunos SIM de la misma NCM pagan más
  dii: number | null;
  especifico: number | null;
  fuente: string;
}
interface NcmCandidato {
  ncm: string;
  partida: string; // texto de la partida (4 dígitos)
  detalle: string; // texto de la posición concreta (8 dígitos)
  puntaje: number;
  confianza?: number;
  tarifa?: NcmTarifa | null;
}
interface NcmSimilar {
  nombre: string;
  ncm: string;
  parecido: number;
  tarifa?: NcmTarifa | null;
}
const fmtDerecho = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 2 })}%`;
// "Arancel Integrado ARCA 03112026" -> "03/11/2026" ('' si la fuente no trae fecha)
const fechaFuente = (f?: string) => (f ? f.replace(/^.*?(\d{2})(\d{2})(\d{4})$/, "$1/$2/$3") : "").replace(/^[^\d].*$/, "");
// Agrupa las candidatas por partida (4 dígitos), conservando el orden de relevancia: el texto largo de la partida se muestra una sola vez.
function agruparPorPartida(cands: NcmCandidato[]) {
  const grupos: { partida4: string; codigo: string; titulo: string; items: NcmCandidato[] }[] = [];
  for (const c of cands) {
    const p4 = c.ncm.slice(0, 4);
    let g = grupos.find((x) => x.partida4 === p4);
    if (!g) {
      g = { partida4: p4, codigo: `${p4.slice(0, 2)}.${p4.slice(2)}`, titulo: c.partida, items: [] };
      grupos.push(g);
    }
    g.items.push(c);
  }
  return grupos;
}
function ChipArancel({ t }: { t: NcmTarifa }) {
  const mercosur = t.dii != null && t.dii !== t.die ? `; con origen Mercosur: ${fmtDerecho(t.dii)}` : "";
  return (
    <span className="ncm-imp" title={`Derecho de importación para mercadería de origen fuera del Mercosur${mercosur}`}>
      <b>{fmtDerecho(t.die)}</b>
      <small>{t.dieMax != null ? `hasta ${fmtDerecho(t.dieMax)}` : "arancel"}</small>
    </span>
  );
}

// Para comparar nombres sin importar mayúsculas, tildes ni espacios repetidos.
const normTexto = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const MAX_NCM_VISIBLES = 3;

// Buscador de NCM sobre la lista oficial (sin IA), con el arancel de cada posición. Con `controlado` busca por el texto que le pasan (formulario "Nuevo": el nombre del producto);
// si no, tiene su propia caja de texto (modal Editar). onElegir recibe la posición y su tarifa para que quien lo usa complete el NCM (y el arancel).
// Elegir NCM es opcional: con onSinNcm aparece «Seguir sin NCM» (la IA lo completa al crear). Los resultados sólo se muestran si corresponden al texto actual.
// `disparar` (contador) pide una búsqueda desde afuera, p. ej. al salir del campo nombre. «Ya cargado antes» sólo aparece con el mismo nombre (mostrarPrevios).
function NcmBuscador({ texto, controlado, ncmActual, buscarAlAbrir, disparar, mostrarPrevios = true, onElegir, onSinNcm, mensaje, nota }: {
  texto: string;
  controlado?: boolean;
  ncmActual: string;
  buscarAlAbrir?: boolean;
  disparar?: number;
  mostrarPrevios?: boolean;
  onElegir: (ncm: string, tarifa?: NcmTarifa | null) => void;
  onSinNcm?: () => void;
  mensaje: string;
  nota: string;
}) {
  const [q, setQ] = useState(texto);
  const [buscando, setBuscando] = useState(false);
  const [res, setRes] = useState<{ q: string; candidatos: NcmCandidato[]; similares: NcmSimilar[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verMas, setVerMas] = useState(false);
  const [sinNcm, setSinNcm] = useState(false);
  const [aplicado, setAplicado] = useState<{ ncm: string; tarifa: NcmTarifa } | null>(null); // última posición elegida, para avisar qué arancel quedó
  const consulta = (controlado ? texto : q).trim();
  // Resultados de una búsqueda anterior no se muestran si el texto cambió.
  const vigente = res && normTexto(res.q) === normTexto(consulta) ? res : null;

  const buscar = () => {
    if (buscando) return;
    if (!consulta) {
      setError("Escribí primero el nombre del producto.");
      return;
    }
    const pedida = consulta;
    setBuscando(true);
    setError(null);
    setVerMas(false);
    setSinNcm(false);
    fetch(`/api/calc/ncm?q=${encodeURIComponent(pedida)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.candidatos) setRes({ q: pedida, candidatos: d.candidatos, similares: d.similares ?? [] });
        else setError(d.error || "No se pudo buscar el NCM. Probá de nuevo.");
      })
      .catch(() => setError("No se pudo buscar el NCM. Probá de nuevo."))
      .finally(() => setBuscando(false));
  };
  useEffect(() => { if (buscarAlAbrir) buscar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (disparar && consulta && !vigente) buscar(); }, [disparar]); // eslint-disable-line react-hooks/exhaustive-deps
  // Al cambiar el texto, los avisos de la elección anterior ya no corresponden.
  useEffect(() => { setError(null); setAplicado(null); setSinNcm(false); }, [consulta]);

  const elegir = (ncm: string, tarifa?: NcmTarifa | null) => {
    onElegir(ncm, tarifa);
    setAplicado(tarifa ? { ncm, tarifa } : null);
    setSinNcm(false);
  };
  const seguirSinNcm = () => {
    setRes(null);
    setAplicado(null);
    setSinNcm(true);
    onSinNcm?.();
  };

  const previos = mostrarPrevios && vigente ? vigente.similares.filter((s) => normTexto(s.nombre) === normTexto(consulta)) : [];
  const candidatos = vigente ? (verMas ? vigente.candidatos : vigente.candidatos.slice(0, MAX_NCM_VISIBLES)) : [];
  const ocultos = vigente ? vigente.candidatos.length - candidatos.length : 0;
  const fecha = vigente ? fechaFuente(vigente.candidatos.find((c) => c.tarifa)?.tarifa?.fuente) : "";

  return (
    <div className="ncm-panel">
      {aplicado && ncmActual === aplicado.ncm && (
        <div className="ncm-aviso" role="status">
          {mensaje} <b>{fmtDerecho(aplicado.tarifa.die)}</b>
          {aplicado.tarifa.dieMax != null && <> (según el SIM puede llegar a {fmtDerecho(aplicado.tarifa.dieMax)})</>}
          .{nota}
        </div>
      )}
      {sinNcm && !ncmActual && (
        <div className="ncm-aviso" role="status">Sin NCM: lo completa la IA al crear el producto. Después lo podés corregir con Editar.</div>
      )}
      {controlado ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button type="button" onClick={buscar} disabled={buscando}>
            {buscando ? <Spinner /> : "Sugerir NCM"}
          </button>
          {onSinNcm && <button type="button" className="enlace-btn" onClick={seguirSinNcm}>Seguir sin NCM</button>}
          {!(sinNcm && !ncmActual) && <span style={{ fontSize: 12, color: "#666" }}>Opcional: sin NCM, lo completa la IA.</span>}
        </div>
      ) : (
        <>
          <label htmlFor="ncm-buscar-texto">Buscar en la lista oficial de la NCM</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              id="ncm-buscar-texto"
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") buscar(); }}
              placeholder="ej. silla de ruedas, jeringa, nebulizador"
              style={{ width: "100%", boxSizing: "border-box" }}
            />
            <button type="button" onClick={buscar} disabled={buscando || !consulta}>
              {buscando ? <Spinner /> : "Buscar"}
            </button>
          </div>
        </>
      )}
      {error && <div className="ncm-vacio" role="alert" style={{ color: "var(--danger, #c0422a)" }}>{error}</div>}
      {vigente && (
        <div className="ncm-lista">
          {previos.map((s) => (
            <button type="button" key={`s${s.ncm}${s.nombre}`} className={`ncm-fila ncm-previo${ncmActual === s.ncm ? " ncm-elegida" : ""}`} onClick={() => elegir(s.ncm, s.tarifa)}>
              <span className="ncm-cod">{s.ncm}</span>
              <span className="ncm-txt"><b>Ya cargado antes: «{s.nombre}»</b><small>Verificá que sea el mismo producto.</small></span>
              {s.tarifa && <ChipArancel t={s.tarifa} />}
            </button>
          ))}
          {vigente.candidatos.length === 0 && (
            <div className="ncm-vacio">No encontramos ese producto en la lista oficial. Probá con otro nombre{onSinNcm ? " o seguí sin NCM." : "."}</div>
          )}
          {agruparPorPartida(candidatos).map((g) => (
            <div key={g.partida4} className="ncm-grupo" role="group" aria-label={`Partida ${g.codigo}`}>
              {g.items.some((c) => c.detalle) && (
                <div className="ncm-grupo-tit"><b>{g.codigo}</b> {g.titulo}</div>
              )}
              {g.items.map((c) => (
                <button type="button" key={c.ncm} className={`ncm-fila${ncmActual === c.ncm ? " ncm-elegida" : ""}`} onClick={() => elegir(c.ncm, c.tarifa)}>
                  <span className="ncm-cod">{c.ncm}</span>
                  <span className="ncm-txt"><b>{c.detalle || c.partida}</b></span>
                  {c.tarifa && <ChipArancel t={c.tarifa} />}
                </button>
              ))}
            </div>
          ))}
          {ocultos > 0 && (
            <div>
              <button type="button" className="enlace-btn" onClick={() => setVerMas(true)}>Ver {ocultos} {ocultos === 1 ? "opción más" : "opciones más"}</button>
            </div>
          )}
          {vigente.candidatos.length > 0 && (
            <div className="ncm-pie">
              Arancel Integrado de ARCA{fecha ? ` (al ${fecha})` : ""}: derecho de importación de origen fuera del Mercosur. La tasa de estadística y el IVA van aparte. Confirmá con tu despachante.
            </div>
          )}
        </div>
      )}
    </div>
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
  const [nuevoNcmElegido, setNuevoNcmElegido] = useState(false); // true si el NCM vino de una fila del buscador (se descarta si cambia el nombre); false si lo escribió a mano
  const [nuevoBuscar, setNuevoBuscar] = useState(0); // contador: pide al buscador de NCM que busque por el nombre (al salir del campo o con Enter)
  const botonCrearRef = useRef<HTMLButtonElement | null>(null);

  const [showEditar, setShowEditar] = useState(false);
  const [refrescando, setRefrescando] = useState<string | null>(null); // 'ncm' | 'arancel' | 'iva' | 'cbm' | 'pvp' | 'peso' | null
  const [guardandoEdit, setGuardandoEdit] = useState(false);
  const [editForm, setEditForm] = useState<{
    ncmCode: string;
    arancelPct: string;
    ivaPct: string;
    traderPct: string;
    tamanoEnvio: TamanoEnvio;
    cbmM3: string;
    pesoKg: string;
  } | null>(null);

  const [fobUsd, setFobUsd] = useState("");
  const [pvpManual, setPvpManual] = useState("");
  // Modo "margen objetivo": en vez de cargar el precio de venta, se carga el margen que se quiere y el servidor calcula el precio que lo logra.
  const [modoGm, setModoGm] = useState(false);
  const [gmObjetivo, setGmObjetivo] = useState("");
  // Paso 3 · Precios, una pregunta a la vez. Modo «ganancia»: FOB -> precio de venta (o margen objetivo) -> resultado. Modo «compra»: precio de venta -> margen -> FOB máximo.
  const [modoPrecios, setModoPrecios] = useState<"ganancia" | "compra" | null>(null);
  const [fobOk, setFobOk] = useState(false); // ganancia: ya respondió «¿a cuánto lo comprás?»
  const [pvpCompra, setPvpCompra] = useState(""); // compra: precio de venta con IVA
  const [pvpCompraOk, setPvpCompraOk] = useState(false);
  const [gmCompra, setGmCompra] = useState(""); // compra: margen buscado (%)
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

  const calcularRef = useRef<(silencioso?: boolean) => void>(() => {});
  const irAlResultado = useRef(false); // tras «Ver el cálculo completo con este FOB», se baja al panel Resultado cuando llega

  const selected = productTypes.find((p) => p.id === selectedId) ?? null;

  // Paso 2 · Tamaño: medidas de la caja de UNA unidad (alto, ancho y profundidad en cm) y peso aproximado. El volumen, el tamaño de envío de Mercado Libre
  // y las unidades por contenedor salen de estas medidas; el servidor las guarda en el tipo de producto (reemplazan al volumen estimado por la IA).
  const [tamForm, setTamForm] = useState({ alto: "", ancho: "", prof: "", peso: "" });
  const [guardandoTam, setGuardandoTam] = useState(false);
  const [tamError, setTamError] = useState<string | null>(null);
  const [tamGuardado, setTamGuardado] = useState(false);
  const [tamRecalculado, setTamRecalculado] = useState(false); // al guardar había un resultado en pantalla y se recalculó
  const numTam = (v: string) => Number(String(v).replace(",", "."));
  useEffect(() => {
    setTamForm({
      alto: selected?.alto_cm != null ? String(selected.alto_cm) : "",
      ancho: selected?.ancho_cm != null ? String(selected.ancho_cm) : "",
      prof: selected?.prof_cm != null ? String(selected.prof_cm) : "",
      peso: selected?.peso_kg != null ? String(selected.peso_kg) : "",
    });
  }, [selected?.id, selected?.alto_cm, selected?.ancho_cm, selected?.prof_cm, selected?.peso_kg]); // eslint-disable-line react-hooks/exhaustive-deps
  // Los avisos ("Medidas guardadas", errores) valen para el producto que se estaba editando.
  useEffect(() => { setTamError(null); setTamGuardado(false); }, [selected?.id]);
  const medidaOk = (v: string) => numTam(v) > 0 && numTam(v) <= 1000;
  const tamMedidasOk = medidaOk(tamForm.alto) && medidaOk(tamForm.ancho) && medidaOk(tamForm.prof);
  const tamTocado = [tamForm.alto, tamForm.ancho, tamForm.prof].some((v) => v.trim() !== ""); // escribió algo en las medidas
  const tamPesoOk = tamForm.peso.trim() === "" || numTam(tamForm.peso) > 0;
  // Volumen en vivo con lo que se está escribiendo (el servidor recalcula lo mismo al guardar).
  const tamVolumen = tamMedidasOk ? (numTam(tamForm.alto) * numTam(tamForm.ancho) * numTam(tamForm.prof)) / 1e6 : null;
  const pesoCambio = !!selected && tamForm.peso.trim() !== "" && numTam(tamForm.peso) !== (selected.peso_kg ?? NaN);
  const tamCambios = !!selected && (
    (tamTocado && (numTam(tamForm.alto) !== (selected.alto_cm ?? NaN) || numTam(tamForm.ancho) !== (selected.ancho_cm ?? NaN) || numTam(tamForm.prof) !== (selected.prof_cm ?? NaN))) || pesoCambio
  );
  const tamAvisoMedidas = tamTocado && !tamMedidasOk ? "Cada medida (alto, ancho y profundidad) tiene que ser mayor a 0 y hasta 1000 cm." : null;
  const guardarTamano = () => {
    if (!selected || !tamMedidasOk || !tamPesoOk || guardandoTam) return;
    setGuardandoTam(true);
    setTamError(null);
    setTamGuardado(false);
    fetch(`/api/calc/product-types/${selected.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ altoCm: numTam(tamForm.alto), anchoCm: numTam(tamForm.ancho), profCm: numTam(tamForm.prof), ...(pesoCambio ? { pesoKg: numTam(tamForm.peso) } : {}) }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.productType) { setTamError(d.error || "No se pudieron guardar las medidas. Probá de nuevo."); return; }
        setProductTypes((prev) => prev.map((p) => (p.id === d.productType.id ? d.productType : p)));
        setTamGuardado(true);
        // Si hay un resultado en pantalla, estaba calculado con el volumen anterior: se recalcula para que no queden números desactualizados.
        if (resultado && !resultado.error && (fobUsd || resultado.fobMaximo)) { setTamRecalculado(true); calcularRef.current(true); } else setTamRecalculado(false);
      })
      .catch(() => setTamError("No se pudieron guardar las medidas. Probá de nuevo."))
      .finally(() => setGuardandoTam(false));
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

  // Los avisos son los del panel (icomPedir / icomConfirmar, design/avisos.html), no los carteles nativos del navegador.
  const guardarEscenario = async () => {
    if (!resultado || guardandoEscenario) return;
    // El usuario sale de la sesión del panel; sólo se pregunta si por algún motivo no está.
    let usuario = "";
    try { usuario = String(JSON.parse(sessionStorage.getItem("icom_sesion_2026") || "{}").nombre || ""); } catch { /* sin sesión legible */ }
    if (!usuario.trim()) usuario = await (window as any).icomPedir("¿Quién guarda este escenario? (para poder filtrarlo después)", { titulo: "Guardar escenario", aceptar: "Continuar" });
    if (!usuario || !usuario.trim()) return;
    const nombreEscenario = await (window as any).icomPedir(
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
        fobUsd: resultado.fobUsdCalculado ?? Number(fobUsd),
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
      .catch(() => alert("No se pudo guardar el escenario. Probá de nuevo."))
      .finally(() => setGuardandoEscenario(false));
  };

  // Vuelve a cargar los datos de un escenario guardado (producto, FOB y precio de venta) para recalcularlo con los supuestos de hoy.
  const abrirEscenario = (esc: Escenario) => {
    const id = esc.productType?.id;
    if (id) setSelectedId(Number(id));
    setFobUsd(String(esc.fobUsd));
    setPvpManual((esc.pvpFuente === "manual" || esc.pvpFuente === "objetivo") && esc.pvpMeliArsConIva != null ? String(esc.pvpMeliArsConIva) : "");
    setModoGm(false); // el escenario trae su precio: se usa tal cual
    setModoPrecios("ganancia");
    setFobOk(true);
    setResultado(null);
    setRunError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const borrarEscenario = async (id: number) => {
    const ok = await (window as any).icomConfirmar("¿Borrar este escenario guardado? Esta acción no se puede deshacer.");
    if (!ok) return;
    fetch(`/api/calc/scenarios/${id}`, { method: "DELETE" })
      .then(() => reloadEscenarios(filtroUsuarioEscenarios || undefined))
      .catch(() => alert("No se pudo borrar. Probá de nuevo."));
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

  // Nombre ya cargado (sin importar mayúsculas ni tildes): se avisa junto al campo, antes de buscar NCM, y se ofrece usar el existente.
  const nombreRepetido = nuevoNombre.trim() ? productTypes.find((p) => normTexto(p.nombre) === normTexto(nuevoNombre)) : undefined;

  const crearTipoProducto = () => {
    const nombre = nuevoNombre.trim();
    if (!nombre || creando || nombreRepetido) return;
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
      .catch(() => setCreandoError("No se pudo crear el tipo de producto. Probá de nuevo."))
      .finally(() => setCreando(false));
  };

  const abrirEditar = () => {
    if (!selected) return;
    setEditForm({
      ncmCode: selected.ncm_code ?? "",
      arancelPct: fmtPctInput(selected.arancel_pct),
      ivaPct: fmtPctInput(selected.iva_pct),
      traderPct: fmtPctInput(selected.trader_pct),
      tamanoEnvio: selected.tamano_envio ?? "mediano",
      cbmM3: selected.cbm_m3 != null ? String(selected.cbm_m3) : "",
      pesoKg: selected.peso_kg != null ? String(selected.peso_kg) : "",
    });
    setShowEditar(true);
  };

  const recalcularCampo = (field: "ncm" | "arancel" | "iva" | "cbm" | "pvp" | "peso") => {
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
              ncmCode: updated.ncm_code ?? "",
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
      .catch(() => alert("No se pudo recalcular. Probá de nuevo."))
      .finally(() => setRefrescando(null));
  };

  const guardarEdit = () => {
    if (!selected || !editForm || guardandoEdit) return;
    setGuardandoEdit(true);
    fetch(`/api/calc/product-types/${selected.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ncmCode: editForm.ncmCode.trim() || null,
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
      .catch(() => alert("No se pudo guardar. Probá de nuevo."))
      .finally(() => setGuardandoEdit(false));
  };

  const borrarTipoProducto = async () => {
    if (!selected) return;
    const ok = await (window as any).icomConfirmar(`¿Borrar el tipo de producto "${selected.nombre}"? Esta acción no se puede deshacer.`);
    if (!ok) return;
    fetch(`/api/calc/product-types/${selected.id}`, { method: "DELETE" })
      .then(() => {
        setSelectedId(null);
        setResultado(null);
        reloadProductTypes();
      })
      .catch(() => alert("No se pudo borrar. Probá de nuevo."));
  };

  // Manda el cálculo al servidor. fobCalculado = FOB con el que se pidió (null cuando lo despeja el servidor: modo «¿A cuánto puedo comprarlo?»).
  // silencioso = recálculo por un cambio de datos: el resultado anterior queda en pantalla hasta que llegue el nuevo.
  const enviarRun = (cuerpo: Record<string, unknown>, fobCalculado: number | null, silencioso = false) => {
    if (!selected) return;
    setCalculando(true);
    setRunError(null);
    if (!silencioso) setResultado(null);
    fetch("/api/calc/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productTypeId: selected.id, ...cuerpo }),
    })
      .then((r) => r.json())
      .then((d: RunResult) => {
        if (d.error) {
          setRunError(d.error);
          return;
        }
        setResultado({ ...d, fobUsdCalculado: d.fobMaximo ? d.fobMaximo.fobUsd : fobCalculado ?? undefined });
        if (irAlResultado.current) {
          irAlResultado.current = false;
          setTimeout(() => document.getElementById("calc-resultado")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
        }
        if (d.productType) {
          setProductTypes((prev) => prev.map((p) => (p.id === d.productType.id ? d.productType : p)));
        }
      })
      .catch(() => setRunError("No se pudo calcular. Probá de nuevo."))
      .finally(() => setCalculando(false));
  };

  const calcular = (silencioso = false) => {
    if (!selected || calculando) return;
    const fob = Number(fobUsd);
    if (!Number.isFinite(fob) || fob <= 0) {
      setRunError("Cargá un FOB válido (mayor a 0).");
      return;
    }
    const gm = Number(gmObjetivo);
    if (modoGm && (gmObjetivo.trim() === "" || !Number.isFinite(gm) || gm < 0 || gm >= 100)) {
      setRunError("Cargá un margen objetivo entre 0 y 100.");
      return;
    }
    enviarRun({ fobUsd: fob, pvpArsManual: !modoGm && pvpManual.trim() ? Number(pvpManual) : undefined, gmObjetivoPct: modoGm ? gm : undefined }, fob, silencioso);
  };

  const calcularCompra = (silencioso = false) => {
    if (!selected || calculando) return;
    const pvp = Number(pvpCompra), gm = Number(gmCompra);
    if (!(pvp > 0)) {
      setRunError("Cargá el precio de venta (con IVA) mayor a 0.");
      return;
    }
    if (gmCompra.trim() === "" || !Number.isFinite(gm) || gm < 0 || gm >= 100) {
      setRunError("Cargá un margen entre 0 y 100.");
      return;
    }
    enviarRun({ modo: "fob-maximo", pvpArsConIva: pvp, margenPct: gm }, null, silencioso);
  };

  // Pasa del FOB máximo al cálculo completo (costo, desglose y canales) con ese FOB y ese precio.
  const verConEsteFob = () => {
    const fm = resultado?.fobMaximo;
    if (!fm) return;
    setFobUsd(String(fm.fobUsd));
    setPvpManual(String(fm.pvp));
    setModoGm(false);
    setFobOk(true);
    setModoPrecios("ganancia");
    irAlResultado.current = true;
    enviarRun({ fobUsd: fm.fobUsd, pvpArsManual: fm.pvp }, fm.fobUsd);
  };
  const seguirFob = () => {
    if (!(Number(fobUsd) > 0)) {
      setRunError("Cargá a cuánto lo comprás (FOB en USD, mayor a 0).");
      return;
    }
    setRunError(null);
    setFobOk(true);
  };
  const seguirPvpCompra = () => {
    if (!(Number(pvpCompra) > 0)) {
      setRunError("Cargá a qué precio querés venderlo (con IVA, mayor a 0).");
      return;
    }
    setRunError(null);
    setPvpCompraOk(true);
  };
  const elegirModoPrecios = (m: "ganancia" | "compra" | null) => {
    setModoPrecios(m);
    setFobOk(false);
    setPvpCompraOk(false);
    setResultado(null);
    setRunError(null);
  };
  calcularRef.current = (silencioso) => (modoPrecios === "compra" ? calcularCompra(!!silencioso) : calcular(!!silencioso));

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
      .catch(() => alert("No se pudo guardar. Probá de nuevo."))
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
      .catch(() => alert("No se pudo recalcular el flete. Probá de nuevo."))
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
      .catch(() => alert("No se pudo actualizar el tipo de cambio. Probá de nuevo."))
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
        <div className="barra-herramientas">
          <div className="barra-tit">Calculá cuánto cuesta traer un producto y cuánto ganás al venderlo.</div>
          <div className="barra-acciones">
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
          <div style={{ fontSize: 12, color: meliOauthMsg.startsWith("✓") ? "#0F7A5A" : "#B3261E", marginBottom: 8 }}>
            {meliOauthMsg}
          </div>
        )}

        <div className="panel">
          <h1 className="paso-tit"><span className="paso-n">1</span> Producto</h1>
          <div className="paso-desc">
            Elegí qué vas a importar o creá un tipo de producto nuevo. NCM, arancel e IVA se pueden corregir después con Editar. El volumen se carga en el paso 2.
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={selectedId ?? ""}
              onChange={(e) => {
                setSelectedId(e.target.value ? Number(e.target.value) : null);
                setResultado(null);
                setRunError(null);
                // El paso 3 arranca de nuevo para el producto elegido: modo, respuestas y valores del anterior no corresponden.
                setModoPrecios(null);
                setFobOk(false);
                setPvpCompraOk(false);
                setFobUsd("");
                setPvpManual("");
                setModoGm(false);
                setGmObjetivo("");
                setPvpCompra("");
                setGmCompra("");
              }}
              style={{ minWidth: 240 }}
              disabled={loadingTypes}
              aria-label="Tipo de producto"
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

          {!selected && !loadingTypes && !showNuevo && (
            <div className="paso-desc" style={{ marginTop: 12, marginBottom: 0 }}>
              {productTypes.length ? "Elegí un producto para empezar." : "Todavía no hay productos cargados (o no se pudieron cargar). Creá uno con «+ Nuevo tipo de producto» o recargá la pantalla."}
            </div>
          )}

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
                  <label htmlFor="nuevo-nombre">Nombre del tipo de producto</label>
                  <input
                    id="nuevo-nombre"
                    type="text"
                    value={nuevoNombre}
                    autoFocus
                    onChange={(e) => {
                      setNuevoNombre(e.target.value);
                      setCreandoError(null);
                      if (nuevoNcmElegido) { setNuevoNcm(""); setNuevoNcmElegido(false); } // el NCM se había elegido para el nombre anterior
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (!nombreRepetido) setNuevoBuscar((n) => n + 1); } }}
                    onBlur={(e) => { if (!(e.relatedTarget instanceof HTMLButtonElement) && !nombreRepetido) setNuevoBuscar((n) => n + 1); }}
                    aria-invalid={nombreRepetido ? true : undefined}
                    placeholder='ej. "Silla de Ruedas", "TV 32 pulgadas"'
                  />
                  {nombreRepetido && (
                    <div role="alert" aria-live="polite" style={{ color: "var(--danger, #c0422a)", fontSize: 12, marginTop: 6 }}>
                      Ya existe un tipo de producto llamado «{nombreRepetido.nombre}».{" "}
                      <button
                        type="button"
                        className="enlace-btn"
                        onClick={() => {
                          setSelectedId(nombreRepetido.id);
                          setResultado(null);
                          setRunError(null);
                          setNuevoNombre("");
                          setNuevoNcm("");
                          setShowNuevo(false);
                        }}
                      >
                        Usar el existente
                      </button>
                    </div>
                  )}
                  {creandoError && !nombreRepetido && <div role="alert" style={{ color: "var(--danger, #c0422a)", fontSize: 12, marginTop: 6 }}>{creandoError}</div>}
                </div>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <label htmlFor="nuevo-ncm">NCM (opcional)</label>
                  <input id="nuevo-ncm" type="text" value={nuevoNcm} onChange={(e) => { setNuevoNcm(e.target.value); setNuevoNcmElegido(false); }} placeholder="0000.00.00" />
                </div>
              </div>
              {!nombreRepetido && (
                <NcmBuscador
                  controlado
                  texto={nuevoNombre}
                  ncmActual={nuevoNcm}
                  disparar={nuevoBuscar}
                  onElegir={(ncm) => { setNuevoNcm(ncm); setNuevoNcmElegido(true); }}
                  onSinNcm={() => { setNuevoNcm(""); setNuevoNcmElegido(false); botonCrearRef.current?.focus(); }}
                  mensaje="Al crear el producto, el arancel se completa con el derecho de importación oficial de esta posición:"
                  nota=" Después lo podés corregir con Editar."
                />
              )}
              <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                <button
                  ref={botonCrearRef}
                  onClick={crearTipoProducto}
                  disabled={creando || !nuevoNombre.trim() || !!nombreRepetido}
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
            <>
              <div className="datos-grid">
                <div className="dato-grupo">
                  <div className="dato-grupo-tit">Impuestos</div>
                  <div className="dato" title="Posición arancelaria (Nomenclatura Común del Mercosur). Se puede corregir en Editar.">
                    <span className="dato-nom">NCM</span>
                    {selected.ncm_code ? (
                      <span className="dato-val" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{selected.ncm_code}</span>
                    ) : (
                      <span className="dato-val"><button type="button" className="enlace-btn" onClick={abrirEditar}>Sin cargar · Cargar</button></span>
                    )}
                  </div>
                  <div className="dato" title="Derecho de importación que se paga sobre el valor CIF.">
                    <span className="dato-nom">Arancel de importación</span>
                    <span className="dato-val">
                      {selected.arancel_pct != null ? fmtPct(selected.arancel_pct) : "—"}
                      <ConfianzaDot confianza={selected.arancel_confianza} razonamiento={selected.arancel_razonamiento} />
                    </span>
                  </div>
                  <div className="dato" title="Alícuota de IVA con la que se vende el producto.">
                    <span className="dato-nom">IVA</span>
                    <span className="dato-val">
                      {selected.iva_pct != null ? fmtPct(selected.iva_pct) : "—"}
                      <ConfianzaDot confianza={selected.iva_confianza} razonamiento={selected.iva_razonamiento} />
                    </span>
                  </div>
                </div>

                <div className="dato-grupo">
                  <div className="dato-grupo-tit">Comercial</div>
                  <div className="dato" title="Porcentaje que se paga al trader (intermediario de la compra) sobre el FOB.">
                    <span className="dato-nom">Comisión del trader</span>
                    <span className="dato-val">{fmtPct(selected.trader_pct)}</span>
                  </div>
                  <div className="dato" title="Precio de venta en Mercado Libre estimado por la IA. Se usa si no cargás uno propio en el paso 3.">
                    <span className="dato-nom">Precio de venta estimado (IA)</span>
                    <span className="dato-val">
                      {selected.pvp_ars_estimado != null ? `$${fmtNumber(selected.pvp_ars_estimado)}` : "—"}
                      <ConfianzaDot confianza={selected.pvp_confianza} razonamiento={selected.pvp_razonamiento} />
                    </span>
                  </div>
                </div>
              </div>
              <div className="leyenda-ia">
                <span>Puntos = confianza de la estimación por IA:</span>
                <span><span className="dot-ia" style={{ background: CONFIANZA_COLOR.alta }} />alta</span>
                <span><span className="dot-ia" style={{ background: CONFIANZA_COLOR.media }} />media</span>
                <span><span className="dot-ia" style={{ background: CONFIANZA_COLOR.baja }} />baja</span>
                <span>(tocá o pasá el mouse por el punto para ver en qué se basó)</span>
              </div>
            </>
          )}
        </div>

        {selected && (
          <div className="panel">
            <h1 className="paso-tit"><span className="paso-n">2</span> Tamaño</h1>
            <div className="paso-desc">Medidas de la caja de UNA unidad y su peso aproximado. Con eso se calculan el volumen, el tamaño del paquete en Mercado Libre y cuántas unidades entran en un contenedor.</div>
            <div className="row">
              {([["alto", "Alto (cm)"], ["ancho", "Ancho (cm)"], ["prof", "Prof. (cm)"]] as const).map(([k, rotulo], i) => (
                <div key={k} style={{ flex: 1, minWidth: 110 }}>
                  <label htmlFor={`tam-${k}`}>{rotulo}</label>
                  <input
                    id={`tam-${k}`}
                    type="number"
                    min={0}
                    step="0.1"
                    inputMode="decimal"
                    value={tamForm[k]}
                    onChange={(e) => { setTamForm({ ...tamForm, [k]: e.target.value }); setTamGuardado(false); setTamError(null); }}
                    aria-invalid={tamTocado && !medidaOk(tamForm[k]) ? true : undefined}
                    max={1000}
                    onKeyDown={(e) => { if (e.key === "Enter") guardarTamano(); }}
                    autoFocus={i === 0 && selected.alto_cm == null}
                  />
                </div>
              ))}
              <div style={{ flex: 1, minWidth: 110 }}>
                <label htmlFor="tam-peso">Peso aprox. (kg)</label>
                <input
                  id="tam-peso"
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={tamForm.peso}
                  placeholder="opcional"
                  onChange={(e) => { setTamForm({ ...tamForm, peso: e.target.value }); setTamGuardado(false); setTamError(null); }}
                  aria-invalid={!tamPesoOk ? true : undefined}
                  onKeyDown={(e) => { if (e.key === "Enter") guardarTamano(); }}
                />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
              <button className="btn-tam" onClick={guardarTamano} disabled={guardandoTam || !tamMedidasOk || !tamPesoOk || !tamCambios} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                {guardandoTam && <Spinner />}
                {guardandoTam ? "Guardando..." : "Guardar medidas"}
              </button>
              <span role="status" style={{ fontSize: 12, color: "var(--ok, #0F7A5A)" }}>{tamGuardado ? (tamRecalculado ? "Medidas guardadas. Resultado recalculado." : "Medidas guardadas.") : ""}</span>
              {(tamError || tamAvisoMedidas) && <span role="alert" style={{ fontSize: 12, color: "var(--danger, #c0422a)" }}>{tamError || tamAvisoMedidas}</span>}
              {!tamError && !tamGuardado && !tamCambios && selected.alto_cm == null && selected.cbm_m3 != null && (
                <span style={{ fontSize: 12, color: "#666" }}>Todavía sin medidas: se usa el volumen estimado por la IA ({selected.cbm_m3.toLocaleString("es-AR")} m³).</span>
              )}
            </div>
            {(tamVolumen != null || selected.cbm_m3 != null) && (() => {
              const vol = tamVolumen != null ? tamVolumen : (selected.cbm_m3 as number);
              const porVolumen = vol < 0.05 ? "chico" : vol <= 0.12 ? "mediano" : "grande";
              // Con cambios sin guardar se muestra el que saldría; si no, el que realmente usa el cálculo (puede haberse fijado en Editar).
              const envioMostrado = tamVolumen != null && tamCambios ? porVolumen : selected.tamano_envio;
              const envio = envioMostrado === "chico" ? "Chico" : envioMostrado === "grande" ? "Grande" : "Mediano";
              return (
                <div className="datos-grid" style={{ marginTop: 12 }}>
                  <div className="dato-grupo">
                    <div className="dato-grupo-tit">{tamVolumen != null && tamCambios ? "Así quedaría" : selected.alto_cm != null ? "Con las medidas guardadas" : "Volumen estimado por la IA"}</div>
                    <div className="dato" title="Volumen de la caja de UNA unidad (CBM, metros cúbicos): alto × ancho × profundidad.">
                      <span className="dato-nom">Volumen por unidad</span>
                      <span className="dato-val">{vol.toLocaleString("es-AR", { maximumFractionDigits: 6 })} m³</span>
                    </div>
                    <div className="dato" title="Se define según el volumen de la caja: menos de 0,05 m³ chico, hasta 0,12 m³ mediano, más grande.">
                      <span className="dato-nom">Tamaño de envío (MeLi)</span>
                      <span className="dato-val">
                        {envio}
                        {selected.envio_meli_api_status === "found" && <small> · API OK</small>}
                      </span>
                    </div>
                    <div className="dato" title="Cuántas unidades entran en un contenedor 40' high cube (capacidad de Supuestos generales).">
                      <span className="dato-nom">Unidades por contenedor 40HC</span>
                      <span className="dato-val">{supuestos && vol > 0 ? Math.round(supuestos.capacidadCbmContenedor / vol).toLocaleString("es-AR") : "—"}</span>
                    </div>
                    <div className="dato" title="Unidades que entran en un contenedor de 20 pies.">
                      <span className="dato-nom">Unidades por contenedor 20FT</span>
                      <span className="dato-val">{supuestos && vol > 0 ? Math.floor(supuestos.capacidad20ftM3 / vol).toLocaleString("es-AR") : "—"}</span>
                    </div>
                    <div className="dato" title="Peso de UNA unidad ya embalada; lo usa Mercado Libre para calcular el envío.">
                      <span className="dato-nom">Peso por unidad</span>
                      <span className="dato-val">
                        {selected.peso_kg != null ? `${selected.peso_kg} kg` : "—"}
                        <ConfianzaDot confianza={selected.peso_confianza} razonamiento={selected.peso_razonamiento} />
                      </span>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {selected && (
          <div className="panel">
            <h1 className="paso-tit"><span className="paso-n">3</span> Precios</h1>
            {modoPrecios == null ? (
              <>
                <div className="paso-desc">¿Qué querés saber? Después respondés de a una pregunta.</div>
                <div className="modo-opciones">
                  <button type="button" className="modo-op" onClick={() => elegirModoPrecios("ganancia")}>
                    <b>¿Cuánto gano si lo compro a…?</b>
                    <small>Cargás a cuánto lo comprás y a cuánto lo vendés, y ves el margen.</small>
                  </button>
                  <button type="button" className="modo-op" onClick={() => elegirModoPrecios("compra")}>
                    <b>¿A cuánto puedo comprarlo?</b>
                    <small>Cargás a cuánto querés venderlo y qué margen buscás, y te digo el precio máximo de compra.</small>
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="resp-linea">
                  <span>{modoPrecios === "ganancia" ? "¿Cuánto gano si lo compro a…?" : "¿A cuánto puedo comprarlo?"}</span>
                  <button type="button" className="enlace-btn" onClick={() => elegirModoPrecios(null)}>Cambiar</button>
                </div>

                {modoPrecios === "ganancia" && (
                  <>
                    {fobOk ? (
                      <div className="resp-linea">
                        <span>Compra (FOB por unidad): <b>US$ {fmtUsd(Number(fobUsd))}</b></span>
                        <button type="button" className="enlace-btn" onClick={() => { setFobOk(false); setResultado(null); setRunError(null); }}>Cambiar</button>
                      </div>
                    ) : (
                      <div className="pregunta">
                        <label htmlFor="calc-fob">¿A cuánto lo comprás? FOB por unidad (USD)</label>
                        <div className="pregunta-fila">
                          <input
                            id="calc-fob"
                            onFocus={(e) => e.target.select()}
                            type="number"
                            min={0}
                            step="0.01"
                            inputMode="decimal"
                            value={fobUsd}
                            autoFocus
                            onChange={(e) => { setFobUsd(e.target.value); setRunError(null); }}
                            onKeyDown={(e) => { if (e.key === "Enter") seguirFob(); }}
                            aria-invalid={runError ? true : undefined}
                            aria-describedby={runError ? "calc-error" : undefined}
                            placeholder="ej. 24.00"
                          />
                          <button type="button" className="btn-primario" onClick={seguirFob}>Seguir</button>
                        </div>
                        {runError && <div id="calc-error" role="alert" className="pregunta-error">{runError}</div>}
                      </div>
                    )}

                    {fobOk && (
                      <div className="pregunta">
                        {modoGm ? (
                          <>
                            <label htmlFor="calc-gm">¿Qué margen querés? Margen objetivo (%) — calcula el precio de venta</label>
                            <div className="pregunta-fila">
                              <input
                                id="calc-gm"
                                type="number"
                                value={gmObjetivo}
                                onChange={(e) => { setGmObjetivo(e.target.value); setRunError(null); }}
                                aria-invalid={runError ? true : undefined}
                                aria-describedby={runError ? "calc-error" : undefined}
                                onKeyDown={(e) => { if (e.key === "Enter") calcular(); }}
                                placeholder="ej. 25"
                                autoFocus
                                onFocus={(e) => e.target.select()}
                                onClick={(e) => e.currentTarget.select()}
                              />
                              <button type="button" onClick={() => setModoGm(false)} title="Volver a cargar el precio de venta a mano" aria-label="Volver a cargar el precio de venta a mano">✕</button>
                            </div>
                            <div className="pregunta-ayuda">
                              Sobre la venta neta de IVA (el mismo «Margen» del resultado). El precio sale con IVA, redondeado hacia arriba a 499 o 999.
                            </div>
                          </>
                        ) : (
                          <>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                              <label htmlFor="calc-pvp" style={{ margin: 0 }}>¿A cuánto lo vendés? Precio en MeLi (con IVA) — opcional</label>
                              <button type="button" className="enlace-btn" onClick={() => setModoGm(true)} title="Poner el margen que querés y calcular el precio que lo logra" aria-label="Calcular el precio a partir de un margen objetivo">
                                ✎ Margen objetivo
                              </button>
                            </div>
                            <input
                              id="calc-pvp"
                              type="number"
                              value={pvpManual}
                              autoFocus={!resultado}
                              onChange={(e) => setPvpManual(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") calcular(); }}
                              placeholder={selected.pvp_ars_estimado != null ? `vacío = $${fmtNumber(selected.pvp_ars_estimado)} (estimado por IA)` : "vacío = lo estima la IA"}
                            />
                          </>
                        )}
                        <div style={{ marginTop: 10 }}>
                          <button className="btn-primario" onClick={() => calcular()} disabled={calculando} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                            {calculando && <Spinner light />}
                            {calculando ? "Calculando..." : "Calcular"}
                          </button>
                        </div>
                        {runError && <div id="calc-error" role="alert" className="pregunta-error">{runError}</div>}
                        {modoGm && resultado && !resultado.error && resultado.gmObjetivo && (
                          <div className="ncm-aviso" role="status">
                            Precio de venta calculado: <b>${fmtNumber(resultado.gmObjetivo.precio)}</b> (con IVA, redondeado a 499/999) para un margen mínimo de <b>{resultado.gmObjetivo.pct}%</b> sobre la venta neta; el margen real del canal MeLi figura en el resultado.{" "}
                            <button
                              type="button"
                              className="enlace-btn"
                              style={{ fontSize: 12 }}
                              onClick={() => {
                                setPvpManual(String(resultado.gmObjetivo?.precio ?? ""));
                                setModoGm(false);
                              }}
                            >
                              Usar como precio de venta
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}

                {modoPrecios === "compra" && (
                  <>
                    {pvpCompraOk ? (
                      <div className="resp-linea">
                        <span>Venta en MeLi (con IVA): <b>${fmtNumber(Number(pvpCompra))}</b></span>
                        <button type="button" className="enlace-btn" onClick={() => { setPvpCompraOk(false); setResultado(null); setRunError(null); }}>Cambiar</button>
                      </div>
                    ) : (
                      <div className="pregunta">
                        <label htmlFor="compra-pvp">¿A qué precio querés venderlo? Precio en MeLi (con IVA, en $)</label>
                        <div className="pregunta-fila">
                          <input
                            id="compra-pvp"
                            onFocus={(e) => e.target.select()}
                            type="number"
                            min={0}
                            inputMode="decimal"
                            value={pvpCompra}
                            autoFocus
                            onChange={(e) => { setPvpCompra(e.target.value); setRunError(null); }}
                            aria-invalid={runError ? true : undefined}
                            aria-describedby={runError ? "calc-error" : undefined}
                            onKeyDown={(e) => { if (e.key === "Enter") seguirPvpCompra(); }}
                            placeholder={selected.pvp_ars_estimado != null ? `ej. ${fmtNumber(selected.pvp_ars_estimado)}` : "ej. 250000"}
                          />
                          <button type="button" className="btn-primario" onClick={seguirPvpCompra}>Seguir</button>
                        </div>
                        {runError && !pvpCompraOk && <div id="calc-error" role="alert" className="pregunta-error">{runError}</div>}
                      </div>
                    )}

                    {pvpCompraOk && (
                      <div className="pregunta">
                        <label htmlFor="compra-gm">¿Qué margen querés? (%, sobre la venta neta de IVA)</label>
                        <div className="pregunta-fila">
                          <input
                            id="compra-gm"
                            onFocus={(e) => e.target.select()}
                            type="number"
                            min={0}
                            inputMode="decimal"
                            value={gmCompra}
                            autoFocus
                            onChange={(e) => { setGmCompra(e.target.value); setRunError(null); }}
                            aria-invalid={runError ? true : undefined}
                            aria-describedby={runError ? "calc-error" : undefined}
                            onKeyDown={(e) => { if (e.key === "Enter") calcularCompra(); }}
                            placeholder="ej. 25"
                          />
                          <button className="btn-primario" onClick={() => calcularCompra()} disabled={calculando || gmCompra.trim() === ""} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                            {calculando && <Spinner light />}
                            {calculando ? "Calculando..." : "Calcular precio de compra"}
                          </button>
                        </div>
                        {runError && <div id="calc-error" role="alert" className="pregunta-error">{runError}</div>}
                        {resultado && !resultado.error && resultado.fobMaximo && (
                          <div className="ncm-aviso" role="status">
                            Para vender a <b>${fmtNumber(resultado.fobMaximo.pvp)}</b> con <b>{resultado.fobMaximo.margenPct}%</b> de margen, podés pagar hasta{" "}
                            <b style={{ fontSize: 18 }}>US$ {fmtUsd(resultado.fobMaximo.fobUsd)}</b> por unidad (FOB).{" "}
                            <button type="button" className="enlace-btn" style={{ fontSize: 12 }} onClick={verConEsteFob}>
                              Ver el cálculo completo con este FOB
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {resultado && !resultado.error && (
          <>
            <div className="panel" id="calc-resultado">
              <h1 className="paso-tit">Resultado</h1>
              <div className="res-franja">
                <div>
                  <div className="res-etq">Costo nacionalizado por unidad</div>
                  <div className="res-grande">${fmtNumber(resultado.resultado.costoNacionalizado.costoNacionalizadoArs)}</div>
                  <div className="res-sub">
                    US$ {fmtUsd(resultado.resultado.costoNacionalizado.costoNacionalizadoUsd)} · tipo de cambio ${fmtNumber(resultado.supuestos.tipoCambioArs)} · FOB US$ {fmtUsd(resultado.fobUsdCalculado ?? Number(fobUsd))}
                  </div>
                </div>
                <button
                  onClick={guardarEscenario}
                  disabled={guardandoEscenario}
                  style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }}
                >
                  {guardandoEscenario && <Spinner />}
                  <Ic n="save" e="💾" /> Guardar escenario
                </button>
              </div>
              <details className="desglose">
                <summary>Ver desglose del costo</summary>
              <div className="table-scroll">
              <table className="admin-table" style={{ fontSize: 13 }}>
                <tbody>
                  <tr>
                    <td>FOB</td>
                    <td style={{ textAlign: "right" }}>US$ {fmtUsd(resultado.fobUsdCalculado ?? Number(fobUsd))}</td>
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
                    <td title="Valor de la mercadería puesta en puerto argentino; sobre esto se calcula el arancel.">
                      <strong>CIF (FOB + trader + seguro)</strong>
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
                    <td>+ Tasa de estadística</td>
                    <td style={{ textAlign: "right" }}>
                      US$ {fmtUsd(resultado.resultado.costoNacionalizado.tasaEstadisticaUsd)}
                    </td>
                  </tr>
                  <tr>
                    <td>+ Impuesto al cheque (Ley 25413)</td>
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
                      <strong>${fmtNumber(resultado.resultado.costoNacionalizado.costoNacionalizadoArs)}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
              </div>
              </details>
            </div>

            <div className="stack-row">
              <div className="panel">
                <h1 className="paso-tit" style={{ fontSize: 15 }}>Vendiendo por MeLi</h1>
                <div className="canal-notas">
                  <div>
                    Precio de venta usado: ${fmtNumber(resultado.resultado.meli.pvpConIva)}{" "}
                    {resultado.pvpFuente === "manual" && (resultado.fobMaximo ? "(el que pediste)" : "(cargado a mano)")}
                    {resultado.pvpFuente === "cache" && "(estimado por IA, ya guardado)"}
                    {resultado.pvpFuente === "ia" && "(recién estimado por IA)"}
                    {resultado.pvpFuente === "objetivo" && "(calculado para el margen objetivo)"}
                  </div>
                  <div>
                    Costo de envío usado: {resultado.envioFuente === "api" ? "dato real de la API de Mercado Libre ✓" : "tabla fija (editable en Supuestos generales)"}
                  </div>
                </div>
                <CanalTable
                  canal={resultado.resultado.meli}
                  showMeliDetalle
                  costoNacionalizadoArs={resultado.resultado.costoNacionalizado.costoNacionalizadoArs}
                />
              </div>
              <div className="panel">
                <h1 className="paso-tit" style={{ fontSize: 15 }}>Vendiendo a Distribución</h1>
                <div className="canal-notas">
                  <div>Precio de venta = precio en MeLi × (1 − {fmtPct(resultado.supuestos.descuentoDistribucionPct)})</div>
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

        <details className="panel panel-plegable">
          <summary className="paso-tit">Historial de escenarios guardados ({escenarios.length})</summary>
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap", gap: 8, margin: "10px 0" }}>
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
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button onClick={() => abrirEscenario(esc)} style={{ fontSize: 11.5, marginRight: 6 }} title="Carga el producto, el FOB y el precio de este escenario para volver a calcularlo">
                        Abrir
                      </button>
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
        </details>
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
            role="dialog"
            aria-modal="true"
            aria-label={`Editar ${selected.nombre}`}
            style={{
              background: "#fff",
              borderRadius: 10,
              padding: 20,
              maxWidth: 480,
              width: "100%",
              maxHeight: "90vh",
              overflowY: "auto",
            }}
          >
            <h1 style={{ fontSize: 16, marginTop: 0 }}>Editar "{selected.nombre}"</h1>
            <div className="row">
              <div style={{ flex: 1, minWidth: 140 }}>
                <label>NCM (posición arancelaria)</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="text"
                    value={editForm.ncmCode}
                    onChange={(e) => setEditForm({ ...editForm, ncmCode: e.target.value })}
                    placeholder="0000.00.00"
                    style={inputStyle}
                  />
                </div>
                <NcmBuscador
                  texto={selected.nombre}
                  mostrarPrevios={false}
                  ncmActual={editForm.ncmCode}
                  buscarAlAbrir={!selected.ncm_code}
                  onElegir={(ncm, tarifa) => setEditForm({ ...editForm, ncmCode: ncm, ...(tarifa ? { arancelPct: String(tarifa.die) } : {}) })}
                  mensaje="Arancel completado con el derecho de importación oficial de esta posición:"
                  nota=" Podés cambiarlo más abajo."
                />
              </div>
            </div>
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
                {selected.alto_cm != null && (
                  <div style={{ fontSize: 11, color: "#666", marginTop: 4, lineHeight: 1.35 }}>
                    Sale de las medidas del paso 2 ({selected.alto_cm} × {selected.ancho_cm} × {selected.prof_cm} cm). Si lo cambiás acá, esas medidas se descartan.
                  </div>
                )}
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
              <Campo label="Publicidad en MeLi (PADS) %" value={supuestosForm.padsPct} onChange={(v) => setSupuestosForm({ ...supuestosForm, padsPct: v })} />
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
  const gana = canal.margenArs >= 0;
  return (
    <>
    <div className="canal-res">
      <div>
        <div className="res-etq">{gana ? "Ganás por unidad" : "Perdés por unidad"}</div>
        <div className={`res-valor ${gana ? "pos" : "neg"}`}>{gana ? "" : "−"}${fmtNumber(Math.abs(canal.margenArs))}</div>
      </div>
      <div title={`Sobre el precio de venta con IVA: ${fmtPct(canal.margenPctSobreConIva)}`}>
        <div className="res-etq">Margen</div>
        <div className={`res-valor ${gana ? "pos" : "neg"}`}>{fmtPct(canal.margenPctSobreNeto)}</div>
        <div className="res-sub" style={{ marginTop: 0 }}>sobre el precio neto de IVA</div>
      </div>
    </div>
    <details className="desglose">
    <summary>Ver detalle</summary>
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
              <td title="PADS = Paid Search de Mercado Libre: inversión en publicidad dentro de la plataforma.">(−) Publicidad en MeLi (PADS)</td>
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
          <td>(−) Ingresos Brutos (IIBB)</td>
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
    </details>
    </>
  );
}
