"use client";

import { useEffect, useRef, useState } from "react";

interface Option {
  value: string;
  label: string;
}

interface Props {
  label: string;
  options: Option[];
  selected: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  searchable?: boolean;
}

/**
 * Dropdown desplegable con checkboxes (y buscador opcional) para elegir
 * varios valores a la vez. Se cierra solo al hacer click afuera.
 *
 * Nota: los estilos globales de la app (globals.css) definen reglas para
 * `label`, `input` y `button` pensadas para formularios simples (label en
 * bloque, input al 100% de ancho, etc.). Ese estilo se filtra a los
 * checkboxes/labels de este dropdown si no se lo pisa explicitamente, asi
 * que todos los elementos de abajo llevan estilos inline (tienen prioridad
 * sobre el CSS externo) para no heredar ese comportamiento.
 */
export default function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  placeholder = "Todas",
  searchable = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const filtered = search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const summary =
    selected.length === 0
      ? placeholder
      : selected.length <= 2
      ? options.filter((o) => selected.includes(o.value)).map((o) => o.label).join(", ")
      : `${selected.length} seleccionadas`;

  return (
    <div ref={ref} style={{ position: "relative", minWidth: 0, width: "100%" }}>
      <label>{label}</label>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          width: "100%",
          textAlign: "left",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</span>
        <span style={{ opacity: 0.6, flexShrink: 0 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            zIndex: 30,
            marginTop: 4,
            width: "max(100%, 220px)",
            maxWidth: "calc(100vw - 32px)",
            maxHeight: 320,
            overflowY: "auto",
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          }}
        >
          {searchable && (
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar..."
              style={{
                width: "100%",
                marginBottom: 8,
                boxSizing: "border-box",
                display: "block",
              }}
            />
          )}
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              style={{ width: "100%", marginBottom: 8, fontSize: 12, display: "block" }}
            >
              Limpiar seleccion
            </button>
          )}
          {filtered.length === 0 && (
            <div style={{ color: "var(--muted)", fontSize: 13, padding: 4 }}>Sin resultados</div>
          )}
          {filtered.map((o) => (
            <div
              key={o.value}
              onClick={() => toggle(o.value)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 4px",
                cursor: "pointer",
                fontSize: 14,
                color: "var(--text)",
                lineHeight: 1.3,
                borderRadius: 4,
              }}
            >
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={() => toggle(o.value)}
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: 16,
                  height: 16,
                  minWidth: 16,
                  padding: 0,
                  margin: 0,
                  flexShrink: 0,
                  accentColor: "var(--accent)",
                }}
              />
              <span style={{ flex: 1 }}>{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
