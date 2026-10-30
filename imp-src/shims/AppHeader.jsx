// Encabezado simple de la pantalla (el panel ya tiene su propio logo y menú). Muestra el dólar oficial del BCRA como dato informativo, igual que en ia40.
import React, { useEffect, useState } from "react";

function DolarBcra() {
  const [dato, setDato] = useState(null);
  useEffect(() => {
    fetch("/api/bcra/tipo-cambio").then((r) => r.json()).then((d) => { if (typeof d.valor === "number") setDato(d); }).catch(() => {});
  }, []);
  if (!dato) return null;
  return (
    <div style={{ fontSize: 12.5, color: "var(--muted)", whiteSpace: "nowrap" }} title={dato.fecha ? `Dólar oficial mayorista (BCRA, Com. A 3500) del ${dato.fecha}` : "Dólar oficial mayorista (BCRA, Com. A 3500)"}>
      USD oficial: <strong style={{ color: "var(--accent)" }}>${dato.valor.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
    </div>
  );
}

export default function AppHeader({ title, actions }) {
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <div className="app-header-title">{title}</div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <DolarBcra />
          {actions}
        </div>
      </div>
    </header>
  );
}
