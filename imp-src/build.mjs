// Compila las pantallas de Importaciones (páginas de ia40 + shims) a archivos estáticos del panel, uno por pantalla (mismo patrón que correo.html):
//   ia40/app/page.tsx                       -> ../importaciones-tablero.html
//   ia40/app/calculo-importacion/page.tsx   -> ../importaciones.html          (Calculador)
//   ia40/app/admin/page.tsx                 -> ../importaciones-admin.html
// Uso: cd imp-src && npm install && node build.mjs   (las funciones de API se compilan aparte con node build-api.mjs)
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const aca = dirname(fileURLToPath(import.meta.url));
const r = (p) => resolve(aca, p);

const PANTALLAS = [
  { pagina: "ia40/app/page.tsx", salida: "importaciones-tablero.html", titulo: "Importaciones - Tablero" },
  { pagina: "ia40/app/calculo-importacion/page.tsx", salida: "importaciones.html", titulo: "Importaciones - Calculador" },
  { pagina: "ia40/app/admin/page.tsx", salida: "importaciones-admin.html", titulo: "Importaciones - Administración" },
];

// Los colores de ia40 eran el azul viejo del panel; se pasan al verde ICOM (#007067) de hoy.
const css = readFileSync(r("globals.css"), "utf8")
  .replace(/--accent:\s*#1a3d70/g, "--accent: #007067")
  .replace(/--header-bg:\s*#1a3d70/g, "--header-bg: #007067");

mkdirSync(r("gen"), { recursive: true });
for (const p of PANTALLAS) {
  const entrada = r(`gen/pantalla-${p.salida.replace(/\.html$/, "")}.jsx`);
  writeFileSync(entrada, `import { arrancar } from "../shims/arranque.jsx";\nimport Pagina from "../${p.pagina}";\narrancar(Pagina);\n`);
  const out = await build({
    entryPoints: [entrada],
    bundle: true,
    write: false,
    minify: true,
    format: "iife",
    target: ["es2019"],
    jsx: "automatic",
    loader: { ".tsx": "tsx", ".jsx": "jsx" },
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      "next/link": r("shims/next-link.jsx"),
      "@/components/AppHeader": r("shims/AppHeader.jsx"),
      "@": r("ia40"),
    },
    logLevel: "warning",
  });
  const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${p.titulo}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${css}
</style>
</head>
<body>
<div id="root"></div>
<script>
${js}
</script>
</body>
</html>
`;
  writeFileSync(r("../" + p.salida), html);
  console.log(p.salida, (html.length / 1024).toFixed(0), "KB");
}
