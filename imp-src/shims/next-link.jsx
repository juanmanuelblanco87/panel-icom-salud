// Reemplazo de next/link: en el panel la navegación entre pantallas (Tablero / Calculador / Administración) son pestañas del shell -> se le pide al panel que cambie de pestaña.
import React from "react";
export default function Link({ href, children, ...rest }) {
  return (
    <a href={href} {...rest} onClick={(e) => { e.preventDefault(); try { window.parent.postMessage({ impNavegar: href }, "*"); } catch (err) { /* sin panel */ } }}>
      {children}
    </a>
  );
}
