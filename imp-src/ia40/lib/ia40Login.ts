import { chromium as playwrightChromium, type Browser } from "playwright-core";
import { rmSync } from "node:fs";
import { dirname } from "node:path";

// 18/09/2026 ("como lo resolvemos para que sea sostenible? Vercel?"):
// mismo login que hacia refresh_token.py (Playwright + Chrome real) en
// la PC del usuario, pero corriendo en una funcion serverless de Vercel
// -- confirmado en vivo (prueba real via /api/test-ia40-login) que
// Cobus NO bloquea las IPs de datacenter de Vercel, asi que esto
// reemplaza la dependencia de que una PC fisica este encendida (ver
// docs/PROYECTO.md secciones 6/7/15/16).
//
// @sparticuz/chromium-min (no @sparticuz/chromium): el output file
// tracing de Next no detecta los binarios de Chromium (los resuelve
// chromium.executablePath() con fs en runtime, no con require()
// estatico) -- fallaba en Vercel con "input directory .../bin does not
// exist". La variante -min no incluye el binario, lo descarga y cachea
// en /tmp la primera vez desde el pack .tar oficial de la misma
// version, publicado como asset de release en GitHub.
const CHROMIUM_PACK_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.x64.tar";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Oculta las señales mas comunes que delatan un navegador automatizado
// (navigator.webdriver, falta de plugins/chrome.runtime, etc.) -- mismo
// script que ya usaba refresh_token.py (STEALTH_JS).
const STEALTH_JS = `
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
window.chrome = window.chrome || { runtime: {} };
Object.defineProperty(navigator, 'languages', {get: () => ['es-AR', 'es']});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
const originalQuery = window.navigator.permissions.query;
window.navigator.permissions.query = (parameters) => (
  parameters.name === 'notifications' ?
    Promise.resolve({ state: Notification.permission }) :
    originalQuery(parameters)
);
`;

// 18/09/2026 (2do intento, "investiga porque falla el login en Vercel"):
// pasos ahora viaja PEGADO al error -- antes se perdia (la funcion sólo
// lo devolvía en el camino feliz), así que cada falla en el cron dejaba
// cero rastro de en qué paso exacto se cortó.
export class Ia40LoginError extends Error {
  pasos: string[];
  constructor(message: string, pasos: string[] = []) {
    super(message);
    this.pasos = pasos;
  }
}

export interface Ia40LoginResult {
  token: string;
  pasos: string[];
  finalUrl: string;
}

// 18/09/2026 (4to intento -- error real obtenido: "spawn ETXTBSY" al
// lanzar /tmp/chromium): @sparticuz/chromium-min cachea el binario
// extraido en /tmp entre invocaciones de un mismo contenedor tibio
// (lambdafs.js: si el directorio de salida ya existe, ni siquiera
// vuelve a extraer -- ver node_modules/@sparticuz/chromium-min/build/
// lambdafs.js). Si una corrida anterior se cortó a mitad de la
// extracción o del lanzamiento (como la que dio ERR_INSUFFICIENT_RESOURCES
// recien), el contenedor puede quedar con ese binario a medio escribir
// o todavia "abierto" para la siguiente invocación tibia -- de ahi el
// ETXTBSY (literalmente "text file busy"). Fix: si el lanzamiento falla
// con ETXTBSY, se borra el directorio ya extraido y se reintenta UNA
// vez (fuerza una extracción limpia desde el .tar, que ya esta
// descargado y cacheado aparte).
async function launchChromiumConReintento(): Promise<Browser> {
  // 30/10/2026 (traslado al panel): @sparticuz/chromium-min es solo ESM y el panel corre en CommonJS -> import() dinámico.
  const chromium: any = ((await import("@sparticuz/chromium-min")) as any).default;
  const args = [...chromium.args, "--disable-dev-shm-usage"];
  const execPath1 = await chromium.executablePath(CHROMIUM_PACK_URL);
  try {
    return await playwrightChromium.launch({ args, executablePath: execPath1, headless: true });
  } catch (err) {
    const msg = String((err as any)?.message ?? err);
    if (!msg.includes("ETXTBSY")) throw err;
    rmSync(dirname(execPath1), { recursive: true, force: true });
    const execPath2 = await chromium.executablePath(CHROMIUM_PACK_URL);
    return await playwrightChromium.launch({ args, executablePath: execPath2, headless: true });
  }
}

// Login real en cobusgroup.com y captura del JWT de IA40 desde la URL
// de redirect (igual que refresh_token.py -- misma secuencia exacta de
// pasos: click INGRESAR, esperar el iframe de login, completar usuario/
// contraseña, y si el token no llego por la respuesta capturada, ir
// directo a /redirect-ia40).
export async function fetchFreshIa40Token(username: string, password: string): Promise<Ia40LoginResult> {
  const pasos: string[] = [];
  const captured: { token: string | null } = { token: null };
  let loginErrorMsg: string | null = null;

  let browser;
  try {
    // 18/09/2026 (3er intento -- error real obtenido: "net::ERR_INSUFFICIENT_RESOURCES"
    // al hacer goto, con chromium ya lanzado): @sparticuz/chromium-min no
    // incluye --disable-dev-shm-usage entre sus flags por defecto -- en
    // un contenedor serverless /dev/shm suele venir muy chico (64MB), y
    // eso es la causa mas comun y mejor documentada de exactamente este
    // error al cargar una pagina con Chromium headless. Se suma como
    // flag extra (no reemplaza los de chromium.args). También se subio
    // la memoria de esta función a 3009MB en vercel.json -- por defecto
    // podria no alcanzarle a Chromium + Next.js corriendo juntos.
    pasos.push("lanzando chromium");
    browser = await launchChromiumConReintento();

    // 18/09/2026: sin viewport explicito, Playwright headless usa
    // 800x600 por defecto -- bastante mas chico que un navegador real,
    // lo que puede disparar un layout/JS distinto (menu movil, scripts
    // que esperan un viewport "de escritorio") en un sitio que decide
    // que mostrar segun el tamaño de pantalla.
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "es-AR",
      viewport: { width: 1366, height: 900 },
    });
    await context.addInitScript(STEALTH_JS);
    // 30/10/2026: el sitio nuevo de Cobus carga video, chat, reCAPTCHA y analytics que el login no usa; con chromium en modo single-process (el de @sparticuz) un solo crash de la
    // pagina cierra el navegador entero ("Target page, context or browser has been closed" en el goto). Se bloquea lo pesado/innecesario para bajar memoria y ruido.
    await context.route("**/*", (route) => {
      const req = route.request();
      const tipo = req.resourceType();
      if (tipo === "image" || tipo === "media" || tipo === "font" || /youtube\.com|ytimg\.com|recaptcha|chatbot\.cobusgroup|googletagmanager|google-analytics|doubleclick|facebook\.|hotjar|clarity\.ms|linkedin\.|whatsapp/i.test(req.url())) {
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();

    page.on("response", (response) => {
      const url = response.url();
      if (url.includes("token=") && url.includes("cobusgroup.com") && !captured.token) {
        const match = url.match(/[?&]token=([^&]+)/);
        if (match) captured.token = match[1];
      }
    });

    // Diagnóstico (30/10/2026): se anotan las respuestas de cobusgroup/ia40 con la query censurada, para saber qué hace el sitio tras el login si no aparece el token.
    const vistas: string[] = [];
    page.on("response", async (response) => {
      const u = response.url();
      if (/user\/login/.test(u) && response.status() >= 400 && vistas.length < 40) {
        const cuerpo = await response.text().catch(() => "");
        vistas.push(`CUERPO ${response.status()}: ${cuerpo.replace(/\s+/g, " ").slice(0, 300)}`);
      }
      if (/cobusgroup\.com|ia40|infoaduana/i.test(u) && !/\.(png|jpe?g|svg|css|woff2?|ico|gif|webp|js)(\?|$)/i.test(u) && vistas.length < 40) {
        vistas.push(`${response.status()} ${u.split("?")[0].slice(0, 110)}${u.includes("?") ? "?…" : ""}`);
      }
    });

    pasos.push("goto cobusgroup.com");
    await page.goto("https://www.cobusgroup.com/", { waitUntil: "load", timeout: 30000 });

    // 30/10/2026 (al traer Importaciones al panel): Cobus rediseñó su sitio -- el link ya no es a.login-link y el formulario de usuario/contraseña (#username, #password, boton
    // "Iniciar sesión") se muestra EN la propia página, ya no dentro del iframe cobus1login. Desde ~16/10 todas las corridas fallaban con "waiting for locator('a.login-link')".
    // Se prueba primero el formulario nuevo y, si el sitio volviera al diseño anterior, el iframe viejo como respaldo.
    // El sitio es una app Angular: si el click llega antes de que cargue, no abre nada -> se reintenta el click hasta 4 veces, esperando ~6 s el formulario tras cada uno.
    pasos.push("click INGRESAR y esperar formulario");
    let loginCtx: any = null;
    for (let intento = 0; intento < 4 && !loginCtx; intento++) {
      await page.locator("a", { hasText: /^\s*INGRESAR\s*$/ }).first().click({ timeout: 15000 }).catch(() => {});
      for (let i = 0; i < 24; i++) {
        if (await page.locator("#username").first().isVisible().catch(() => false)) { loginCtx = page; break; }
        const iframeViejo = page.frames().find((f) => f.url().includes("cobus1login")) ?? null;
        if (iframeViejo) { loginCtx = iframeViejo; break; }
        await page.waitForTimeout(250);
      }
    }
    if (!loginCtx) {
      const framesVistos = page.frames().map((f) => f.url()).join(" | ") || "(ninguno)";
      pasos.push(`frames en la pagina: ${framesVistos}`);
      pasos.push(`url actual: ${page.url()}`);
      throw new Ia40LoginError("No aparecio el formulario de login tras clickear INGRESAR.", pasos);
    }
    const esFormularioNuevo = loginCtx === page;

    pasos.push("completando usuario/contrasena");
    await loginCtx.fill(esFormularioNuevo ? "#username" : "#login1", username);
    await loginCtx.fill(esFormularioNuevo ? "#password" : "#pass", password);
    await loginCtx.click(esFormularioNuevo ? "form:has(#username) button[type=submit]" : "a[onclick='funcion()']");

    pasos.push("esperando resultado del login");
    await page.waitForTimeout(4000);

    // 18/09/2026 (5to intento -- llegó hasta el final sin token: "No se
    // pudo capturar el token despues del login"): nunca habia ninguna
    // verificacion de que el login realmente funcionara -- si Cobus
    // rechaza usuario/contraseña o tira otro error, seguiamos como si
    // nada. Se registra el texto visible del iframe y la URL actual en
    // este punto para poder ver [la proxima vez que falle] que dijo
    // realmente la pagina, en vez de adivinar.
    try {
      const textoIframe = await loginCtx.innerText("body");
      pasos.push(`texto del iframe tras el login: ${textoIframe.slice(0, 300)}`);
    } catch {
      pasos.push("no se pudo leer el iframe tras el login (probablemente ya navego)");
    }
    pasos.push(`url tras esperar el login: ${page.url()}`);

    if (loginErrorMsg) {
      throw new Ia40LoginError(loginErrorMsg, pasos);
    }

    if (!captured.token) {
      pasos.push("goto redirect-ia40");
      try {
        await page.goto("https://www.cobusgroup.com/redirect-ia40", { waitUntil: "load", timeout: 20000 });
      } catch {
        // seguimos aunque falle -- puede que el token ya se haya capturado por la respuesta
      }
      await page.waitForTimeout(4000);
      pasos.push(`url tras redirect-ia40: ${page.url()}`);
    }

    const finalUrl = page.url();
    let textoFinal = "";
    if (!captured.token) {
      try { textoFinal = (await page.innerText("body")).replace(/\s+/g, " ").slice(0, 200); } catch { /* sin texto */ }
    }
    await browser.close();

    if (!captured.token) {
      throw new Ia40LoginError(`No se pudo capturar el token despues del login. Ultima URL: ${finalUrl}. Respuestas: ${vistas.join(" ; ")}. Texto de la pagina: ${textoFinal}`, pasos);
    }

    pasos.push("token capturado");
    return { token: captured.token, pasos, finalUrl };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    if (err instanceof Ia40LoginError) {
      if (!err.pasos?.length) err.pasos = pasos;
      throw err;
    }
    throw new Ia40LoginError(String((err as any)?.message ?? err), pasos);
  }
}
