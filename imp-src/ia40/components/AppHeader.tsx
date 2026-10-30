"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/**
 * Header compartido entre el Modulo de Importaciones (app/page.tsx) y el
 * Calculador de Importacion (app/calculo-importacion/page.tsx) -- extraido
 * de page.tsx (20/07/2026) para poder reusarlo en la pagina nueva sin
 * duplicar el logo/estilos. `actions` recibe los botones de navegacion
 * propios de cada pagina (ej. "Cálculo de Importación" en el modulo
 * principal, "Volver al módulo de importaciones" en la calculadora).
 *
 * Dolar oficial BCRA (21/07/2026, pedido explicito del usuario): se
 * consulta UNA vez al montar el header via /api/bcra/tipo-cambio (que a
 * su vez llama a la API publica del BCRA, sin IA ni guardado en base) y se
 * muestra como dato informativo -- no tiene relacion con el "Tipo de
 * cambio" editable de Supuestos generales del Calculador (ese sigue
 * sirviendo para el calculo en si, este es solo para tener a mano el dato
 * del dia con un vistazo).
 */
function DolarBcra() {
  const [valor, setValor] = useState<number | null>(null);
  const [fecha, setFecha] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/bcra/tipo-cambio")
      .then((r) => r.json())
      .then((d) => {
        if (typeof d.valor === "number") {
          setValor(d.valor);
          setFecha(d.fecha ?? null);
        }
      })
      .catch(() => {});
  }, []);

  if (valor == null) return null;
  return (
    <div
      style={{ fontSize: 12.5, color: "var(--muted)", whiteSpace: "nowrap" }}
      title={fecha ? `Dólar oficial mayorista (BCRA, Com. A 3500) del ${fecha}` : "Dólar oficial mayorista (BCRA, Com. A 3500)"}
    >
      USD oficial:{" "}
      <strong style={{ color: "var(--accent)" }}>
        ${valor.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </strong>
    </div>
  );
}

// 26/08/2026 ("el boton Salir ya no tiene sentido aca"): con el login
// unificado, entrar via panel-icom-salud ya NO pasa por el login propio
// de este proyecto (ver middleware.ts, panelAuth) -- el usuario nunca
// "inició sesión ACÁ" en un sentido que tenga algo que cerrar. Clickear
// "Salir" llamaba a /api/logout (borra la cookie icom_auth de ESTE
// proyecto, que ni se usó para entrar) y redirigía a /login -- ese
// formulario aparecía flotando adentro del iframe, desconectado del
// "Cerrar sesión" real (el del panel, en su sidebar). Se oculta el
// botón cuando se detecta que la página corre embebida en un iframe
// (window.self !== window.top) -- en el acceso standalone (visitar
// ia40-dashboard-hztm.vercel.app directo, con SU PROPIO login real) el
// botón sigue ahí, ese caso sí tiene una sesión propia que cerrar.
function useEmbebidoEnIframe(): boolean {
  const [embebido, setEmbebido] = useState(false);
  useEffect(() => {
    try {
      setEmbebido(window.self !== window.top);
    } catch {
      // Un cross-origin estricto puede tirar al comparar -- si pasa,
      // es casi seguro que SÍ está embebido (un top-level nunca tira acá).
      setEmbebido(true);
    }
  }, []);
  return embebido;
}

export default function AppHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  const embebido = useEmbebidoEnIframe();
  return (
    <header className="app-header">
      {/* 26/08/2026 ("dejala similar a la de gestion de talentos, quita
          el logo... queda repetido con el general de la app"): este
          modulo vive embebido en un iframe dentro del panel principal
          (icom_panel_unificado.html), que ya tiene su PROPIO header con
          el logo de Icom Salud arriba de todo -- tenerlo acá también
          era literalmente el mismo logo 2 veces en pantalla. Gestión de
          Talento (el otro módulo embebido de la misma forma) nunca tuvo
          logo propio por esta misma razón -- se saca acá para que
          quede igual de consistente, header blanco simple con
          título + acciones, sin fondo navy ni logo. */}
      <div className="app-header-inner">
        <div className="app-header-title">{title}</div>
        {/* 26/08/2026 ("permite moverse hacia los costados"): a este grupo
            le faltaba flexWrap -- en mobile, "USD oficial" + "Cálculo de
            Importación" + "Salir" (3 items) no entraban en una sola
            línea y el que sobraba (Salir, el último) se salía del
            header en vez de bajar a una 2da línea -- eso era lo que
            arrastraba TODA la página hacia el costado. */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <DolarBcra />
          {actions}
          {!embebido && (
            <button
              className="app-header-nav-btn"
              onClick={() => {
                fetch("/api/logout", { method: "POST" }).finally(() => (window.location.href = "/login"));
              }}
              title="Cerrar sesión"
            >
              Salir
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
