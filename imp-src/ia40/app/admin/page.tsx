"use client";

import { useEffect, useState } from "react";

interface Category {
  id: number;
  slug: string;
  name: string;
}

interface ProviderRow {
  importer_name: string;
  total_fob_dolars: string;
  record_count: string;
  marca: string | null;
  modelo: string | null;
  color: string | null;
}

interface RecordRow {
  id: number;
  period: string;
  importer_name: string;
  fecha: string | null;
  despacho: string | null;
  unidades: string | null;
  fob_dolars: string | null;
  marca: string | null;
  modelo: string | null;
  color: string | null;
}

export default function AdminPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [slug, setSlug] = useState("");

  // --- Clasificacion rapida por importador (todas sus lineas comparten marca/modelo) ---
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { marca: string; modelo: string; color: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // --- Clasificacion por linea de detalle (un importador puede tener varias marcas) ---
  const [importerFilter, setImporterFilter] = useState("");
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [recordDrafts, setRecordDrafts] = useState<Record<number, { marca: string; modelo: string; color: string }>>({});
  const [savingRecordId, setSavingRecordId] = useState<number | null>(null);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [bulkMarca, setBulkMarca] = useState("");
  const [bulkModelo, setBulkModelo] = useState("");
  const [bulkColor, setBulkColor] = useState("");
  const [savingAll, setSavingAll] = useState(false);

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => r.json())
      .then((d) => {
        setCategories(d.categories ?? []);
        if (d.categories?.[0]) setSlug(d.categories[0].slug);
      });
  }, []);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    fetch(`/api/providers?category=${slug}`)
      .then((r) => r.json())
      .then((d) => {
        const rows: ProviderRow[] = d.providers ?? [];
        setProviders(rows);
        const nextDrafts: Record<string, { marca: string; modelo: string; color: string }> = {};
        for (const r of rows) {
          nextDrafts[r.importer_name] = { marca: r.marca ?? "", modelo: r.modelo ?? "", color: r.color ?? "" };
        }
        setDrafts(nextDrafts);
      })
      .finally(() => setLoading(false));
    setImporterFilter("");
  }, [slug]);

  const reloadProviders = () => {
    if (!slug) return;
    fetch(`/api/providers?category=${slug}`)
      .then((r) => r.json())
      .then((d) => setProviders(d.providers ?? []));
  };

  const save = async (importerName: string) => {
    const draft = drafts[importerName];
    if (!draft?.marca) {
      alert("La marca es obligatoria para guardar.");
      return;
    }
    setSaving(importerName);
    try {
      await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: slug,
          importer_name: importerName,
          marca: draft.marca,
          modelo: draft.modelo || null,
          color: draft.color || null,
        }),
      });
      reloadProviders();
    } finally {
      setSaving(null);
    }
  };

  const loadRecords = (importer: string) => {
    if (!slug) return;
    setLoadingRecords(true);
    const params = new URLSearchParams({ category: slug });
    if (importer) params.set("importer", importer);
    fetch(`/api/records?${params}`)
      .then((r) => r.json())
      .then((d) => {
        const rows: RecordRow[] = d.records ?? [];
        setRecords(rows);
        const nextDrafts: Record<number, { marca: string; modelo: string; color: string }> = {};
        for (const r of rows) {
          nextDrafts[r.id] = { marca: r.marca ?? "", modelo: r.modelo ?? "", color: r.color ?? "" };
        }
        setRecordDrafts(nextDrafts);
      })
      .finally(() => setLoadingRecords(false));
  };

  useEffect(() => {
    if (!slug) return;
    loadRecords(importerFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, importerFilter]);

  const saveRecord = async (id: number) => {
    const draft = recordDrafts[id];
    if (!draft?.marca) {
      alert("La marca es obligatoria para guardar.");
      return;
    }
    setSavingRecordId(id);
    try {
      await fetch("/api/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trade_record_id: id,
          marca: draft.marca,
          modelo: draft.modelo || null,
          color: draft.color || null,
        }),
      });
      loadRecords(importerFilter);
    } finally {
      setSavingRecordId(null);
    }
  };

  const applyBulkToDrafts = () => {
    if (!bulkMarca) {
      alert("Completa la marca para aplicar a todas las lineas.");
      return;
    }
    setRecordDrafts((d) => {
      const next = { ...d };
      for (const r of records) {
        next[r.id] = { marca: bulkMarca, modelo: bulkModelo, color: bulkColor };
      }
      return next;
    });
  };

  const saveAllVisible = async () => {
    setSavingAll(true);
    try {
      for (const r of records) {
        const draft = recordDrafts[r.id];
        if (!draft?.marca) continue;
        await fetch("/api/records", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            trade_record_id: r.id,
            marca: draft.marca,
            modelo: draft.modelo || null,
            color: draft.color || null,
          }),
        });
      }
      loadRecords(importerFilter);
    } finally {
      setSavingAll(false);
    }
  };

  return (
    <div className="container">
      <h1>Mapeo de marcas por importador</h1>
      <h2>
        IA40 no trae marca/modelo directo en los datos de esta categoria. Se puede
        clasificar rapido por importador entero (abajo) o, cuando un importador trae
        mas de una marca/modelo, linea por linea (mas abajo, seccion "Lineas de detalle").
      </h2>

      <div className="panel row">
        <div>
          <label>Categoria</label>
          <select value={slug} onChange={(e) => setSlug(e.target.value)}>
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="panel">
        <h1 style={{ fontSize: 16, marginTop: 0 }}>Clasificacion rapida por importador</h1>
        {loading ? (
          <p style={{ color: "var(--muted)" }}>Cargando...</p>
        ) : (
          <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Importador</th>
                <th>FOB total (USD)</th>
                <th>Registros</th>
                <th>Marca</th>
                <th>Modelo</th>
                <th>Color</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.importer_name}>
                  <td>{p.importer_name}</td>
                  <td>
                    {Number(p.total_fob_dolars).toLocaleString("es-AR", {
                      maximumFractionDigits: 0,
                    })}
                  </td>
                  <td>{p.record_count}</td>
                  <td>
                    <input
                      value={drafts[p.importer_name]?.marca ?? ""}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [p.importer_name]: { ...d[p.importer_name], marca: e.target.value },
                        }))
                      }
                      placeholder="Marca"
                    />
                  </td>
                  <td>
                    <input
                      value={drafts[p.importer_name]?.modelo ?? ""}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [p.importer_name]: { ...d[p.importer_name], modelo: e.target.value },
                        }))
                      }
                      placeholder="Modelo (opcional)"
                    />
                  </td>
                  <td>
                    <input
                      value={drafts[p.importer_name]?.color ?? ""}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [p.importer_name]: { ...d[p.importer_name], color: e.target.value },
                        }))
                      }
                      placeholder="Color (opcional)"
                    />
                  </td>
                  <td>
                    <button onClick={() => save(p.importer_name)} disabled={saving === p.importer_name}>
                      {saving === p.importer_name ? "Guardando..." : "Guardar"}
                    </button>
                  </td>
                  <td>
                    <button
                      onClick={() => {
                        setImporterFilter(p.importer_name);
                        document
                          .getElementById("detalle-lineas")
                          ?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}
                    >
                      Ver lineas →
                    </button>
                  </td>
                </tr>
              ))}
              {providers.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ color: "var(--muted)" }}>
                    No hay datos todavia para esta categoria. Corre /api/sync primero.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <div className="panel" id="detalle-lineas">
        <h1 style={{ fontSize: 16, marginTop: 0 }}>Lineas de detalle</h1>
        <p style={{ color: "var(--muted)", fontSize: 13, marginTop: -8 }}>
          Usa esto cuando un importador trae mas de una marca (o una marca con varios
          modelos): clasifica cada envio individualmente. Si lo dejas vacio ("Todos"),
          se toma la marca/modelo de la clasificacion rapida de arriba.
        </p>

        <div className="row" style={{ marginBottom: 16, alignItems: "flex-end" }}>
          <div>
            <label>Importador</label>
            <select value={importerFilter} onChange={(e) => setImporterFilter(e.target.value)}>
              <option value="">Todos</option>
              {providers.map((p) => (
                <option key={p.importer_name} value={p.importer_name}>{p.importer_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Aplicar marca a todas las visibles</label>
            <input value={bulkMarca} onChange={(e) => setBulkMarca(e.target.value)} placeholder="Marca" />
          </div>
          <div>
            <label>Modelo (opcional)</label>
            <input value={bulkModelo} onChange={(e) => setBulkModelo(e.target.value)} placeholder="Modelo" />
          </div>
          <div>
            <label>Color (opcional)</label>
            <input value={bulkColor} onChange={(e) => setBulkColor(e.target.value)} placeholder="Color" />
          </div>
          <div>
            <button onClick={applyBulkToDrafts}>Aplicar a todas</button>
          </div>
          <div>
            <button onClick={saveAllVisible} disabled={savingAll}>
              {savingAll ? "Guardando..." : "Guardar todas las visibles"}
            </button>
          </div>
        </div>

        {loadingRecords ? (
          <p style={{ color: "var(--muted)" }}>Cargando...</p>
        ) : (
          <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Importador</th>
                <th>Despacho</th>
                <th>Unidades</th>
                <th>FOB (USD)</th>
                <th>Marca</th>
                <th>Modelo</th>
                <th>Color</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td>{r.fecha ?? "-"}</td>
                  <td>{r.importer_name}</td>
                  <td>{r.despacho ?? "-"}</td>
                  <td>{r.unidades ?? "-"}</td>
                  <td>
                    {r.fob_dolars
                      ? Number(r.fob_dolars).toLocaleString("es-AR", { maximumFractionDigits: 0 })
                      : "-"}
                  </td>
                  <td>
                    <input
                      value={recordDrafts[r.id]?.marca ?? ""}
                      onChange={(e) =>
                        setRecordDrafts((d) => ({
                          ...d,
                          [r.id]: { ...d[r.id], marca: e.target.value },
                        }))
                      }
                      placeholder="Marca"
                    />
                  </td>
                  <td>
                    <input
                      value={recordDrafts[r.id]?.modelo ?? ""}
                      onChange={(e) =>
                        setRecordDrafts((d) => ({
                          ...d,
                          [r.id]: { ...d[r.id], modelo: e.target.value },
                        }))
                      }
                      placeholder="Modelo (opcional)"
                    />
                  </td>
                  <td>
                    <input
                      value={recordDrafts[r.id]?.color ?? ""}
                      onChange={(e) =>
                        setRecordDrafts((d) => ({
                          ...d,
                          [r.id]: { ...d[r.id], color: e.target.value },
                        }))
                      }
                      placeholder="Color (opcional)"
                    />
                  </td>
                  <td>
                    <button onClick={() => saveRecord(r.id)} disabled={savingRecordId === r.id}>
                      {savingRecordId === r.id ? "..." : "Guardar"}
                    </button>
                  </td>
                </tr>
              ))}
              {records.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ color: "var(--muted)" }}>
                    No hay lineas para mostrar.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
