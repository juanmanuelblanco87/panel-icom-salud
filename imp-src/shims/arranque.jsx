// Arranque común de las pantallas de Importaciones dentro del panel:
// 1) fetch: las rutas de ia40 (/api/...) se traducen a las funciones del panel (/api/imp-<grupo>?r=<ruta>) y todo pedido lleva la sesión del panel (Bearer).
// 2) monta la pantalla original de ia40 sin cambios de lógica.
import React from "react";
import { createRoot } from "react-dom/client";

const SESION_KEY = "icom_sesion_2026";
function token() {
  try { return (JSON.parse(sessionStorage.getItem(SESION_KEY) || "{}")).token || ""; } catch (e) { return ""; }
}

const GRUPOS = {
  datos: ["categories", "evolution", "records", "providers", "estado-datos", "model-overrides", "model-pvp", "model-pvp/search", "model-images/search", "model-images"],
  sieve: ["sieve", "sieve/status", "pvp-sieve", "pvp-sieve/status", "ejecutar-sync"],
};
const A_GRUPO = {};
Object.keys(GRUPOS).forEach((g) => GRUPOS[g].forEach((r) => { A_GRUPO[r] = g; }));

function traducir(url) {
  const u = new URL(url, location.origin);
  const p = u.pathname;
  const API = "/api/imp-calculador";
  let m;
  // Calculador (ya portado a mano: una sola función con ?a=)
  if (p === "/api/calc/product-types") return `${API}?a=tipos`;
  if ((m = p.match(/^\/api\/calc\/product-types\/(\d+)\/refresh$/))) return `${API}?a=tipo-refresh&id=${m[1]}&field=${encodeURIComponent(u.searchParams.get("field") || "")}`;
  if ((m = p.match(/^\/api\/calc\/product-types\/(\d+)$/))) return `${API}?a=tipo&id=${m[1]}`;
  if (p === "/api/calc/supuestos") return `${API}?a=supuestos`;
  if (p === "/api/calc/supuestos/refresh-flete") return `${API}?a=refresh-flete`;
  if (p === "/api/calc/supuestos/refresh-tipo-cambio") return `${API}?a=refresh-tipo-cambio`;
  if (p === "/api/calc/run") return `${API}?a=run`;
  if (p === "/api/calc/scenarios") return `${API}?a=escenarios${u.searchParams.get("usuario") ? "&usuario=" + encodeURIComponent(u.searchParams.get("usuario")) : ""}`;
  if ((m = p.match(/^\/api\/calc\/scenarios\/(\d+)$/))) return `${API}?a=escenario&id=${m[1]}`;
  if (p === "/api/bcra/tipo-cambio") return `${API}?a=bcra`;
  // Resto: rutas de ia40 compiladas, agrupadas en funciones del panel
  if (p.indexOf("/api/") === 0) {
    const ruta = p.slice(5);
    const grupo = A_GRUPO[ruta];
    if (grupo) {
      const qs = new URLSearchParams(u.search);
      qs.set("r", ruta);
      return `/api/imp-${grupo}?${qs.toString()}`;
    }
  }
  return null;
}

export function arrancar(Pagina) {
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input.url;
    // En el panel se usa la conexión de aplicación de Mercado Libre: no hay "conectar cuenta", siempre está lista.
    if (/\/api\/calc\/meli-oauth\/status/.test(url)) {
      return Promise.resolve(new Response(JSON.stringify({ conectado: true }), { headers: { "Content-Type": "application/json" } }));
    }
    const nueva = typeof url === "string" ? traducir(url) : null;
    if (!nueva) return fetchOriginal(input, init);
    const headers = new Headers((init && init.headers) || {});
    headers.set("Authorization", "Bearer " + token());
    return fetchOriginal(nueva, Object.assign({}, init, { headers, cache: "no-store" }));
  };
  createRoot(document.getElementById("root")).render(<Pagina />);
}
