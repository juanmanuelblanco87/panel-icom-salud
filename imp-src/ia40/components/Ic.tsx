/**
 * Íconos de línea (20/10/2026, "este diseño no se ve bien"): en el tema nuevo del panel de Icom (?tema=nuevo, ver app/layout.tsx) los emojis de la interfaz se
 * reemplazan por trazos finos del color del texto. Se dibujan los DOS (emoji e ícono) y el CSS de globals.css muestra uno u otro según el tema, así el diseño de
 * siempre queda idéntico y React sigue actualizando sus propios textos sin que nadie le cambie el DOM por debajo.
 */
const P: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  dollar: '<path d="M12 3v18M16 7.5C15 6.5 13.7 6 12 6c-2.2 0-4 1-4 2.8 0 4 8 2 8 6.2 0 1.8-1.8 3-4 3-1.8 0-3.2-.6-4.2-1.7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  trend: '<path d="M3 17l6-6 4 4 8-9M15 6h6v6"/>',
  clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M5 4L3 6M19 4l2 2"/>',
  hourglass: '<path d="M6 3h12M6 21h12M7 3c0 5 3 6 5 9-2 3-5 4-5 9M17 3c0 5-3 6-5 9 2 3 5 4 5 9"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-3.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14.5 3.5L20 15M20 20v-5h-5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  save: '<path d="M5 4h11l3 3v13H5V4z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/>',
};

export function Ic({ n, e }: { n: keyof typeof P | "dot"; e: string }) {
  if (n === "dot") {
    return (
      <>
        <span className="ic-old">{e}</span>
        <span className="ic-new ic-dot" aria-hidden="true" />
      </>
    );
  }
  return (
    <>
      <span className="ic-old">{e}</span>
      <svg className="ic-new" viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: P[n] }} />
    </>
  );
}
