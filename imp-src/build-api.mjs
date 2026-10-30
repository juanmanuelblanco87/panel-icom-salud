// Compila las rutas de ia40 (imp-src/ia40/app/api/**/route.ts) a paquetes CommonJS api/_imp-b-<grupo>.js, que sirven los handlers api/imp-<grupo>.js vía api/_imp-servir.js.
// Uso: cd imp-src && node build-api.mjs
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const aca = dirname(fileURLToPath(import.meta.url));
const r = (p) => resolve(aca, p);

// grupo -> rutas (carpeta dentro de ia40/app/api)
const GRUPOS = {
  datos: ["categories", "evolution", "records", "providers", "estado-datos", "model-overrides", "model-pvp", "model-pvp/search", "model-images/search", "token"],
  sieve: ["sieve", "sieve/status", "pvp-sieve", "pvp-sieve/status", "ejecutar-sync"],
  sync: ["sync", "sync-images", "refresh-ia40-token", "test-ia40-login"],
  meli: ["meli-price-proxy", "meli-shipping-proxy", "meli-sellout-snapshot", "rental-price-ai"],
};

mkdirSync(r("gen"), { recursive: true });
for (const [grupo, rutas] of Object.entries(GRUPOS)) {
  const lineas = rutas.map((ruta, i) => `import * as r${i} from "../ia40/app/api/${ruta}/route";`);
  lineas.push(`export const rutas = { ${rutas.map((ruta, i) => `${JSON.stringify(ruta)}: r${i}`).join(", ")} };`);
  const entrada = r(`gen/${grupo}.ts`);
  writeFileSync(entrada, lineas.join("\n") + "\n");
  await build({
    entryPoints: [entrada],
    outfile: r(`../api/_imp-b-${grupo}.js`),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    minify: false,
    sourcemap: false,
    external: ["pg", "playwright-core", "@sparticuz/chromium-min", "got-scraping"],
    alias: { "next/server": r("shims/next-server.js"), "@": r("ia40") },
    banner: { js: "// GENERADO por imp-src/build-api.mjs a partir de imp-src/ia40 -- no editar a mano." },
    logLevel: "warning",
  });
  console.log("api/_imp-b-" + grupo + ".js");
}
