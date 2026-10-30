/**
 * Registro de parsers de marca/modelo/color/segmento por categoria. Cada
 * categoria puede tener su propio parser adaptado (los datos de aduana no
 * son uniformes entre categorias). Si una categoria no tiene parser
 * registrado aca, el sync sigue usando el flujo normal (/data) y la
 * clasificacion manual (provider_brand_map / record_brand_map) como hasta
 * ahora.
 *
 * ARQUITECTURA (actualizada 15/07/2026): el parser de "Sillas de ruedas" se
 * separo en un motor generico reutilizable (createCategoryParser) + una
 * configuracion especifica por categoria. Las 7 categorias nuevas
 * (electricas, andadores, bastones, almohadones, sillas de ducha,
 * elevadores de inodoro, camas hospitalarias) usan el MISMO motor y, salvo
 * que se indique lo contrario, los MISMOS diccionarios de marca y color que
 * ya tenia "Sillas de ruedas" (BRAND_MULTI_WORD_DICT,
 * BRAND_SINGLE_WORD_OVERRIDE, COLOR_DICT): son fabricantes de equipamiento
 * ortopedico/medico (Invacare, Ottobock, Drive Medical, Sunrise Medical,
 * Vermeiren, etc.) y un mismo importador que trae sillas de ruedas
 * tipicamente tambien trae andadores, bastones, camas, etc. de esas mismas
 * marcas, asi que es un punto de partida razonable.
 *
 * MARCA/MODELO/COLOR "DINAMICOS" (sin redeploy): el diccionario estatico de
 * este archivo es solo la primera pasada automatica -- no necesita estar
 * perfecto ni actualizarse cada vez que aparece una marca nueva. Cuando el
 * parser no reconoce algo (por ejemplo al sincronizar un mes nuevo con una
 * marca que nunca se vio), cae en un fallback razonable (Paso 7/8 abajo) y
 * el sync NUNCA falla por esto. La correccion real, "para siempre", se hace
 * desde la pantalla /admin (tablas provider_brand_map / record_brand_map,
 * que ya incluyen marca+modelo+color) sin tocar codigo ni redesplegar: el
 * fix queda guardado en la base y se re-aplica automaticamente en cada
 * /api/sync futuro para ese importador (ver lib/aggregate.ts). Estan
 * generalizadas a las 8 categorias, asi que ya funcionan para las 7
 * categorias nuevas sin cambios adicionales.
 *
 * Lo que NO se reutiliza tal cual es la clasificacion de Segmento: los 6
 * segmentos de sillas de ruedas ("Silla Ultra Livianas", "Silla Activa y
 * Deportivas", etc.) son un criterio propio armado mirando datos reales de
 * ESA categoria especifica, y no tiene sentido aplicarselo a, por ejemplo,
 * "andadores". Para las 6 categorias nuevas no-electricas, y para "Sillas
 * de Ruedas Electricas" (que tampoco reutiliza el esquema de sillas
 * manuales: son ejes de clasificacion distintos), se armo una taxonomia de
 * Segmento propia por categoria (validada con el usuario 15/07/2026, ver
 * docs/ncm_nuevas_categorias.md), implementada como `segmentoKeywords`:
 * palabra clave detectada en el texto de Modelo -> segmento. CONFIANZA BAJA:
 * son keywords tipicas en ingles/espanol de fichas de producto, todavia no
 * verificadas contra datos reales de IA40 de estas categorias -- hay que
 * revisarlas/completarlas con el primer sync real de cada una (mirar que
 * texto de Modelo esta quedando sin clasificar en el fallback y agregar la
 * keyword que corresponda), igual que se hizo en su momento para sillas de
 * ruedas.
 *
 * NOTA: todo vive en este mismo archivo (no en archivos separados por
 * categoria) a proposito, para evitar un import relativo entre archivos que
 * en este proyecto no se pudo resolver de forma consistente en Vercel (el
 * archivo lib/parsers/sillasDeRuedas.ts existia y tenia el contenido
 * correcto, pero el build fallaba igual con "Module not found").
 */

export interface ParsedBrandModel {
  marca: string;
  modelo: string;
  color?: string;
  segmento?: string;
}

export type CategoryParser = (raw: Record<string, any>) => ParsedBrandModel | null;

// ============================================================
// Diccionarios COMPARTIDOS de marca y color (armados originalmente
// analizando datos reales de "Sillas de ruedas" -- para las categorias
// nuevas son un punto de partida razonable, pero conviene revisarlos con
// los datos reales de cada categoria una vez sincronizada).
// ============================================================

// ---- diccionario multi-palabra (match mas largo primero) ----
const BRAND_MULTI_WORD_DICT: [string, string][] = [
  ["FOSHAN DONGFANG MEDICAL EQUIPMENT MANUFACTORY LTD", "Foshan Dongfang Medical Equipment Manufactory Ltd"],
  ["INTCO MEDICAL INDUSTRIES INC", "Intco Medical Industries Inc"],
  ["INTCO MEDICAL INDUST", "Intco Medical Industries Inc"],
  ["CONVAID PRODUCTS LLC", "Convaid Products LLC"],
  ["JAMES LECKEY DESIGN", "James Leckey Design"],
  ["LIW CARE TECHNOLOGY", "LIW Care Technology"],
  ["PDG PRODUCT DESIGN", "PDG Product Design"],
  ["FOSHAN DONGFANG MEDI", "Foshan Dongfang Medical"],
  ["FOSHAN DONGFANG AND", "Foshan Dongfang"],
  ["FOSHAN RAFU MEDICAL", "Foshan Rafu Medical"],
  ["FOSHAN ENCARRE MEDICL", "Foshan Ecarre Medica"],
  ["FOSHAN ECARRE MEDICA", "Foshan Ecarre Medica"],
  ["FOSHAN ECARRE MEDIC", "Foshan Ecarre Medica"],
  ["JIANGSU INTCO MEDICA", "Jiangsu Intco Medica"],
  ["JIANGSU RIXIN MEDICA", "Jiangsu Rixin Medica"],
  ["GUANGDONG KAIYANG", "Guangdong Kaiyang"],
  ["KAIYANG MEDICAL", "Kaiyang Medical"],
  ["CIRCLE SPECIALTY", "Circle Specialty"],
  ["SUNRISE MEDICAL", "Sunrise Medical"],
  ["MOTION COMPOSITES", "Motion Composites"],
  ["MDH SP Z O O", "MDH SP Z.O.O."],
  ["SARL VIPAMAT", "Sarl Vipamat"],
  ["FUTURE MOBILITY HEAL", "Future Mobility Healthcare"],
  ["FUTURE MOBILITY", "Future Mobility Healthcare"],
  ["ALU REHAB", "Alu Rehab"],
  ["DOUBLE CARE MEDICAL", "Double Care Medical"],
  ["DOUBLE CARE", "Double Care Medical"],
  ["DRIVE MEDICAL", "Drive Medical"],
  ["STEALTH PRODUCTS", "Stealth Products"],
  ["KI MOBILITY", "KI Mobility"],
  ["FOSHAN GEGE", "Foshan Gege"],
  ["FOSHAN KAIYANG", "Foshan Kaiyang"],
  ["FOSHAN FEIYANG", "Foshan Feiyang"],
  ["FOSHAN ECARRE", "Foshan Ecarre Medica"],
  ["AKCES MED", "Akces Med"],
  ["TOP MEDI", "Top Medi"],
  ["U NURSE", "U Nurse"],
  ["CARE QUIP", "Care Quip"],
  ["BOX WHEELCHAIRS", "Box Wheelchairs"],
];

// ---- marca de una sola palabra (tabla OVERRIDE) ----
const BRAND_SINGLE_WORD_OVERRIDE: Record<string, string> = {
  TILITE: "TiLite",
  KI: "KI",
  HOGGI: "Hoggi",
  VERMEIREN: "Vermeiren",
  INVACARE: "Invacare",
  OTTOBOCK: "Ottobock",
  STRYKER: "Stryker",
  MEYRA: "Meyra",
  ASPEN: "Aspen",
  MAGESA: "Magesa",
  MUGI: "Mugi",
  INTCO: "Intco",
  MOVICARE: "Movicare",
  MYWAM: "MyWam",
  JIANLIAN: "Jianlian",
  YUWELL: "Yuwell",
  LIFECARE: "LifeCare",
  SUNCARE: "SunCare",
  ANTARES: "Antares",
  NEATECH: "NeaTech",
  ANATOMIC: "Anatomic",
  KARMA: "Karma",
  EUROMIX: "EuroMix",
  MAVERICK: "Maverick",
  COMFORT: "Comfort",
  LERADO: "Lerado",
  SITMED: "SitMed",
  POLIOR: "Polior",
  KDB: "KDB",
  WATER: "Water",
  NOVA: "Nova",
  ACHIEVE: "Achieve",
  REBOTEC: "Rebotec",
  ARIA: "Aria",
  MERITS: "Merits",
  RIFTON: "Rifton",
  VESCO: "Vesco",
  RGK: "RGK",
  LIGHTNING: "Lightning",
  PATRON: "Patron",
  GIGANTEX: "Gigantex",
  R82: "R82",
  SUNRISE: "Sunrise Medical",
  LIW: "LIW",
  OFFCARR: "Offcarr",
  LEGGERO: "Leggero",
  TIMO: "Timo",
  ORMESA: "Ormesa",
  ORTOBRAS: "Ortobras",
  "A&J": "A&J",
  FOSHAN: "Foshan",
  JIANGSU: "Jiangsu",
  GREEN: "Green",
  THOMASHILFEN: "Thomashilfen",
  ONE: "One",
  JEPOINT: "Jepoint",
  MEDCORE: "Medcore",
};

// ---- typos conocidos (primera palabra) ----
const BRAND_TYPO_FIXES: Record<string, string> = {
  OTTOBOK: "OTTOBOCK",
  INVACORE: "INVACARE",
  LEGEGRO: "LEGGERO",
  SURISE: "SUNRISE",
  GUNAGDONG: "GUANGDONG",
  ANTOMIC: "ANATOMIC",
  LIGTHNING: "LIGHTNING",
  R52: "R82",
  TLITE: "TILITE",
};

// ---- palabras vacias societarias ----
const SOCIETARY_STOPWORDS = new Set([
  "S.A.", "SRL", "S.R.L.", "SOCIEDAD", "ANONIMA", "LTDA", "SOC", "RESP",
  "COMERCIAL", "E", "INDUSTRI", "Y", "CIA", "DE", "DEL", "LA", "EL",
  "SUCURSAL", "ARGENTINA", "INDUSTRIAL",
]);

// ---- diccionario de colores (frases de 2 palabras antes que 1) ----
// No se usan palabras en frances (rouge, bleu, etc.) para no confundir con
// modelos reales como "ROGUE"/"ROUGE" de KI Mobility.
const COLOR_DICT: [string, string][] = [
  ["CHARCOAL GREY", "Gris Carbón"],
  ["CHARCOAL GRAY", "Gris Carbón"],
  ["LIGHT GRAY", "Gris Claro"],
  ["LIGHT GREY", "Gris Claro"],
  ["LIGHT GREEN", "Verde Claro"],
  ["LIGHT BLUE", "Celeste"],
  ["DARK BLUE", "Azul Oscuro"],
  ["DARK GREEN", "Verde Oscuro"],
  ["NAVY BLUE", "Azul Marino"],
  ["MATTE BLACK", "Negro"],
  ["MATTE BL", "Negro"],
  ["BLACK", "Negro"],
  ["WHITE", "Blanco"],
  ["BLUE", "Azul"],
  ["RED", "Rojo"],
  ["GREEN", "Verde"],
  ["GREY", "Gris"],
  ["GRAY", "Gris"],
  ["SILVER", "Plata"],
  ["YELLOW", "Amarillo"],
  ["ORANGE", "Naranja"],
  ["PURPLE", "Morado"],
  ["PINK", "Rosa"],
  ["BROWN", "Marrón"],
  ["BEIGE", "Beige"],
  ["GOLD", "Dorado"],
  ["TITANIUM", "Titanio"],
  ["CAMO", "Camuflado"],
  ["NAVY", "Azul Marino"],
  ["NEGRO", "Negro"],
  ["BLANCO", "Blanco"],
  ["AZUL", "Azul"],
  ["ROJO", "Rojo"],
  ["VERDE", "Verde"],
  ["GRIS", "Gris"],
  ["PLATA", "Plata"],
  ["AMARILLO", "Amarillo"],
];

// ---- codigos de color "YC" (marca Magesa, series YK90xx) ----
// Especifico de sillas de ruedas: tabla aprendida del dataset de esa
// categoria, no se reutiliza por defecto en las categorias nuevas (se pasa
// explicitamente en la config de "sillas_de_ruedas" mas abajo).
const SILLAS_YC_CODE_MAP: Record<string, string> = {
  YCB007: "Azul",
  YC104: "Gris Carbón",
  YCR003: "Rojo",
  YC90969: "Plata",
};

const DEFAULT_COLOR = "Negro";

function titleCase(word: string): string {
  if (word.length <= 3) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Version standalone (reutilizable fuera de createCategoryParser) de la
 * extraccion de color del Paso 10: busca una palabra de color conocida al
 * FINAL del texto de Modelo y la separa. Usada por los parsers de Patron B
 * (NCM 9404.90.00, 9401.79.00, 9402.90.20, 3922.20.00), que no pasan por el
 * motor generico de Patron A (createCategoryParser).
 */
function extractColorGeneric(
  modelo: string,
  defaultColor: string,
  colorDict: [string, string][] = COLOR_DICT
): { modelo: string; color: string } {
  if (!modelo) return { modelo, color: defaultColor };
  const colorSorted = [...colorDict].sort((a, b) => b[0].length - a[0].length);
  for (const [word, canonical] of colorSorted) {
    const re = new RegExp(`^(.*?)\\s+${word}$`, "i");
    const m = re.exec(modelo);
    if (m && m[1].trim().length >= 2) {
      return { modelo: m[1].trim(), color: canonical };
    }
  }
  return { modelo, color: defaultColor };
}

// ============================================================
// Motor generico de parseo (fabrica de parsers por categoria)
// ============================================================

interface CategoryParserConfig {
  /** Diccionario multi-palabra de marca. Por defecto: BRAND_MULTI_WORD_DICT (compartido). */
  multiWordDict?: [string, string][];
  /** Marca de una sola palabra. Por defecto: BRAND_SINGLE_WORD_OVERRIDE (compartido). */
  singleWordOverride?: Record<string, string>;
  /** Typos conocidos en la primera palabra. Por defecto: BRAND_TYPO_FIXES (compartido). */
  typoFixes?: Record<string, string>;
  /** Palabras vacias societarias para el fallback por Razon Social. Por defecto: SOCIETARY_STOPWORDS (compartido). */
  societaryStopwords?: Set<string>;
  /** Diccionario de colores. Por defecto: COLOR_DICT (compartido). */
  colorDict?: [string, string][];
  /** Codigos "YC<n>" -> color canonico (especifico de sillas de ruedas / Magesa). Por defecto: ninguno. */
  ycCodeMap?: Record<string, string>;
  /** Color por defecto cuando no se detecta ninguno. Por defecto: "Negro". */
  defaultColor?: string;
  /** Paso 11.1: palabra clave en Modelo -> segmento (maxima prioridad). Por defecto: ninguno. */
  segmentoKeywords?: [string, string][];
  /** Paso 11.2: marca exacta + prefijo de Modelo -> segmento. Por defecto: ninguno. */
  segmentoBrandPrefix?: [string, string, string][];
  /** Paso 11.3: marca -> segmento por defecto. Por defecto: ninguno. */
  segmentoBrandDefault?: Record<string, string>;
  /** Paso 11.4: segmento si nada de lo anterior matcheo. Obligatorio: cada categoria define el suyo. */
  segmentoFallback: string;
  /**
   * Algunas marcas vienen repetidas al inicio del texto de Modelo (ej.
   * "ERIVO ERIVO R10" -> el fallback generico del Paso 8 deja Marca="Erivo"
   * pero Modelo="ERIVO R10", con el token de marca duplicado). Si se activa,
   * se quita ese token repetido del inicio del Modelo despues de extraerlo
   * (antes de separar el color). Por defecto: false (no se activa para
   * categorias donde no se observo este patron).
   */
  stripRepeatedMarcaFromModelo?: boolean;
}

/**
 * Crea un parser de marca/modelo/color/segmento para una categoria,
 * reutilizando el mismo algoritmo que se armo originalmente para
 * "Sillas de ruedas" (ver pasos 1-11 en los comentarios de cada funcion
 * interna), parametrizado por los diccionarios que pasa `config`.
 */
function createCategoryParser(config: CategoryParserConfig): CategoryParser {
  const multiWordSorted = [...(config.multiWordDict ?? BRAND_MULTI_WORD_DICT)].sort(
    (a, b) => b[0].length - a[0].length
  );
  const singleWordOverride = config.singleWordOverride ?? BRAND_SINGLE_WORD_OVERRIDE;
  const typoFixes = config.typoFixes ?? BRAND_TYPO_FIXES;
  const stopwords = config.societaryStopwords ?? SOCIETARY_STOPWORDS;
  const colorSorted = [...(config.colorDict ?? COLOR_DICT)].sort((a, b) => b[0].length - a[0].length);
  const ycCodeMap = config.ycCodeMap ?? {};
  const defaultColor = config.defaultColor ?? DEFAULT_COLOR;

  // Paso 9: contador "Modelo N" correlativo por Razon Social + Precio
  // Unitario, con estado propio por instancia de parser (o sea, por
  // categoria) para no mezclar numeraciones entre categorias distintas.
  // NOTA: este contador vive en memoria del proceso. Dentro de una misma
  // corrida de sync es correcto (se reutiliza el mismo numero para la misma
  // combinacion razonSocial+precio); entre corridas distintas (cada una un
  // proceso nuevo en Vercel) se reinicia. Segun los datos reales analizados
  // de sillas de ruedas, este camino casi no se usa (casi todo trae un
  // codigo de referencia utilizable como Modelo), asi que por ahora no se
  // persiste en la base.
  const modeloAssigned = new Map<string, number>();
  const modeloCounterPerRazon = new Map<string, number>();

  function assignModeloN(razonSocial: string, precioUnitario?: number | null): string {
    const razonUpper = razonSocial.toUpperCase();
    const key = `${razonUpper}__${precioUnitario ?? "sin_precio"}`;
    let assigned = modeloAssigned.get(key);
    if (assigned === undefined) {
      const next = (modeloCounterPerRazon.get(razonUpper) ?? 0) + 1;
      modeloCounterPerRazon.set(razonUpper, next);
      modeloAssigned.set(key, next);
      assigned = next;
    }
    return `Modelo ${assigned}`;
  }

  function finalize(
    marca: string,
    modelo: string,
    razonSocial: string,
    precioUnitario?: number | null
  ): { marca: string; modelo: string } {
    if (modelo) return { marca, modelo };
    return { marca, modelo: assignModeloN(razonSocial, precioUnitario) };
  }

  /**
   * @param sufijoTextRaw  Texto crudo de "SUB ITEMS - SUFIJOS" (puede venir vacio/null).
   * @param razonSocial    Razon social del importador (columna A), tal cual.
   * @param precioUnitario Precio unitario FOB del sub-item, para el paso 9.
   */
  function parseCore(
    sufijoTextRaw: string | null | undefined,
    razonSocial: string,
    precioUnitario?: number | null
  ): { marca: string; modelo: string } {
    let text = (sufijoTextRaw ?? "").trim();

    // Paso 1: quitar sufijo de aduana "SIN CODIGO (CODIGO)" al final.
    text = text.replace(/\s*SIN\s+CODIGO(\s*\([^)]*\))?\s*$/i, "").trim();

    // Paso 2: comillas, comas y puntos sueltos -> espacio; colapsar espacios.
    text = text
      .replace(/["'.,]/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!text) {
      return finalize(razonSocial, "", razonSocial, precioUnitario);
    }

    // Paso 3: "sin marca" explicito -> Marca = Razon Social completa.
    const sinMarcaMatch = /^(SIN\s+MARCA|S\/MARCA|S\/M)\b\s*(.*)$/i.exec(text);
    if (sinMarcaMatch) {
      const modelo = sinMarcaMatch[2].trim();
      return finalize(razonSocial, modelo, razonSocial, precioUnitario);
    }

    // Paso 4: corregir typo conocido en la primera palabra.
    let words = text.split(" ").filter(Boolean);
    if (words.length > 0) {
      const firstUpper = words[0].toUpperCase();
      if (typoFixes[firstUpper]) {
        words[0] = typoFixes[firstUpper];
        text = words.join(" ");
      }
    }
    const textUpper = text.toUpperCase();

    // Paso 5: diccionario multi-palabra (match mas largo primero).
    for (const [key, canonical] of multiWordSorted) {
      if (textUpper === key || textUpper.startsWith(key + " ")) {
        const modelo = text.slice(key.length).trim();
        return finalize(canonical, modelo, razonSocial, precioUnitario);
      }
    }

    // Paso 6: marca de una sola palabra ya conocida (tabla OVERRIDE).
    words = text.split(" ").filter(Boolean);
    if (words.length > 0) {
      const firstUpper = words[0].toUpperCase();
      if (singleWordOverride[firstUpper]) {
        const marca = singleWordOverride[firstUpper];
        const modelo = words.slice(1).join(" ").trim();
        return finalize(marca, modelo, razonSocial, precioUnitario);
      }
    }

    // Paso 7: fallback por Razon Social (probar prefijo de 3, 2 o 1 palabras
    // de la razon social sin las palabras vacias societarias).
    const razonWords = razonSocial
      .toUpperCase()
      .split(/\s+/)
      .filter((w) => w && !stopwords.has(w));

    for (let take = Math.min(3, razonWords.length); take >= 1; take--) {
      const prefix = razonWords.slice(0, take).join(" ");
      if (prefix.length < 4) continue;
      if (textUpper === prefix || textUpper.startsWith(prefix + " ")) {
        const modelo = text.slice(prefix.length).trim();
        return finalize(razonSocial, modelo, razonSocial, precioUnitario);
      }
    }

    // Paso 8: fallback generico -> primera palabra como marca (Title Case,
    // o mayusculas si es sigla de <=3 letras), resto como modelo.
    if (words.length === 0) {
      return finalize(razonSocial, "", razonSocial, precioUnitario);
    }
    const marca = titleCase(words[0]);
    const modelo = words.slice(1).join(" ").trim();
    return finalize(marca, modelo, razonSocial, precioUnitario);
  }

  /**
   * Paso 10: separa el color del texto de Modelo (ya limpio, pasos 1-9),
   * para que variantes de color del mismo modelo (ej. "MEWA BLACK" / "MEWA
   * LIGHT GRAY") no queden como modelos distintos. Devuelve el modelo sin
   * el color (si se detecto) y el color canonico (o el color por defecto
   * de la categoria si no hay informacion de color en el texto).
   */
  function extractColor(modelo: string): { modelo: string; color: string } {
    if (!modelo) return { modelo, color: defaultColor };

    // Paso 10.1: palabra de color conocida al final, con sufijo " YC<codigo>" opcional
    // (algunos registros traen un espacio entre "YC" y el codigo, ej. "YC B007").
    for (const [word, canonical] of colorSorted) {
      const re = new RegExp(`^(.*?)\\s+${word}(?:\\s+YC\\s*[\\w]+)?$`, "i");
      const m = re.exec(modelo);
      if (m && m[1].trim().length >= 2) {
        return { modelo: m[1].trim(), color: canonical };
      }
    }

    // Paso 10.2: sin palabra de color, pero con codigo "YC<codigo>" al final
    // (tambien tolera espacio entre "YC" y el codigo).
    const ycMatch = /^(.*?)\s+YC\s*([\w]+)$/i.exec(modelo);
    if (ycMatch && ycMatch[1].trim().length >= 2) {
      const code = `YC${ycMatch[2]}`.toUpperCase();
      const known = ycCodeMap[code];
      if (known) {
        return { modelo: ycMatch[1].trim(), color: known };
      }
      // Codigo no aprendido: igual se quita del modelo (para unificar), pero
      // el color queda por defecto porque no sabemos cual es realmente.
      return { modelo: ycMatch[1].trim(), color: defaultColor };
    }

    // Paso 10.3: sin color detectado.
    return { modelo, color: defaultColor };
  }

  /**
   * Paso 11: clasifica cada fila en un segmento a partir de Marca y Modelo
   * YA limpios (sin color). Orden de evaluacion (el primero que matchea
   * gana):
   *   11.1 palabra clave en Modelo (max prioridad, no mira la marca)
   *   11.2 Marca exacta + Modelo contiene un prefijo de linea de producto
   *   11.3 Marca por defecto
   *   11.4 fallback de la categoria si nada matcheo
   */
  function assignSegmento(marca: string, modelo: string): string {
    const modeloUpper = (modelo || "").toUpperCase();

    for (const [keyword, segmento] of config.segmentoKeywords ?? []) {
      if (modeloUpper.includes(keyword)) return segmento;
    }

    for (const [m, prefix, segmento] of config.segmentoBrandPrefix ?? []) {
      if (marca === m && modeloUpper.includes(prefix)) return segmento;
    }

    if (config.segmentoBrandDefault?.[marca]) return config.segmentoBrandDefault[marca];

    return config.segmentoFallback;
  }

  return (raw) => {
    const core = parseCore(raw.sufijos ?? "", raw.nombre ?? "", raw.precio_unitario ?? null);
    let modeloPreColor = core.modelo;
    if (config.stripRepeatedMarcaFromModelo) {
      const marcaUpper = core.marca.toUpperCase();
      const moUpper = modeloPreColor.toUpperCase();
      if (moUpper === marcaUpper) {
        modeloPreColor = "";
      } else if (moUpper.startsWith(marcaUpper + " ")) {
        modeloPreColor = modeloPreColor.slice(core.marca.length).trim();
      }
    }
    const { modelo, color } = extractColor(modeloPreColor);
    const segmento = assignSegmento(core.marca, modelo);
    return { marca: core.marca, modelo, color, segmento };
  };
}

// ============================================================
// Config: Sillas de ruedas -- Segmento propio (6 valores, armados
// analizando datos reales de esta categoria especificamente).
// ============================================================

// ---- Paso 11.1: palabra clave en Modelo (maxima prioridad) ----
const SEGMENTO_KEYWORDS: [string, string][] = [
  ["KID", "Sillas Infantiles"],
  ["JUNIOR", "Sillas Infantiles"],
  ["NINOS", "Sillas Infantiles"],
  ["NIÑOS", "Sillas Infantiles"],
  ["PEDIATRI", "Sillas Infantiles"],
  ["INFANT", "Sillas Infantiles"],
  ["BUGGY", "Sillas Infantiles"],
  ["STROLLER", "Sillas Infantiles"],
  ["TEEN", "Sillas Infantiles"],
  ["RUGBY", "Silla Activa y Deportivas"],
  ["BASKETBALL", "Silla Activa y Deportivas"],
  ["BASQUET", "Silla Activa y Deportivas"],
  ["TENNIS", "Silla Activa y Deportivas"],
  ["BADMINTON", "Silla Activa y Deportivas"],
  ["HANDBALL", "Silla Activa y Deportivas"],
  ["SPORT", "Silla Activa y Deportivas"],
  ["STANDER", "Silla Postural"],
  ["TILT", "Silla Postural"],
  ["RECLIN", "Silla Postural"],
  ["INODORO", "Silla de Traslado"],
];

// ---- Paso 11.2: marca + prefijo de Modelo (marcas con lineas mixtas) ----
const SEGMENTO_BRAND_PREFIX: [string, string, string][] = [
  ["Sunrise Medical", "ZIPPIE", "Sillas Infantiles"],
  ["Sunrise Medical", "QUICKIE IRIS", "Sillas Infantiles"],
  ["Sunrise Medical", "QUICKIE NITRUM", "Silla Ultra Livianas"],
  ["Sunrise Medical", "QUICKIE XENON", "Silla Ultra Livianas"],
  ["Sunrise Medical", "XENON", "Silla Ultra Livianas"],
  ["Sunrise Medical", "QUICKIE QRI", "Silla Ultra Livianas"],
  ["Sunrise Medical", "QUICKIE 5R", "Silla Ultra Livianas"],
  ["Sunrise Medical", "QUICKIE M6", "Silla Ultra Livianas"],
  ["Sunrise Medical", "QUICKIE GP", "Silla Ultra Livianas"],
  ["Sunrise Medical", "NITRUM", "Silla Ultra Livianas"],
  ["Sunrise Medical", "KRYPTON", "Silla Ultra Livianas"],
  ["Sunrise Medical", "OCTANE", "Silla Activa y Deportivas"],
  ["Sunrise Medical", "GRAND SLAM", "Silla Activa y Deportivas"],
  ["Sunrise Medical", "RGK", "Silla Activa y Deportivas"],
  ["KI Mobility", "LITTLE WAVE", "Sillas Infantiles"],
  ["KI Mobility", "FOCUS CR", "Sillas Infantiles"],
  ["KI Mobility", "SPARK", "Sillas Infantiles"],
  ["KI Mobility", "ROGUE", "Silla Ultra Livianas"],
  ["KI Mobility", "ROUGE", "Silla Ultra Livianas"],
  ["KI Mobility", "CATALYST", "Silla Ultra Livianas"],
  ["KI Mobility", "LIBERTY", "Silla Ultra Livianas"],
  ["KI Mobility", "ETHOS", "Silla Ultra Livianas"],
  ["Ottobock", "KIMBA", "Sillas Infantiles"],
  ["Ottobock", "ECO BUGGY", "Sillas Infantiles"],
  ["Ottobock", "LISA REHAB", "Sillas Infantiles"],
  ["Ottobock", "VENTUS", "Silla Postural"],
  ["Ottobock", "MOTUS", "Silla Postural"],
  ["Ottobock", "ZENIT", "Silla Postural"],
  ["Ottobock", "AVANTGARDE", "Silla Postural"],
  ["Invacare", "CLEMATISPRO", "Silla Postural"],
  ["Invacare", "LEMATISPRO", "Silla Postural"],
  ["Invacare", "PRO CG", "Silla Postural"],
  ["Invacare", "REA AZALEA", "Sillas Infantiles"],
  ["Invacare", "KSL", "Silla Ultra Livianas"],
  ["Vermeiren", "SAGITTA KIDS", "Sillas Infantiles"],
  ["Vermeiren", "SAGITTA", "Silla Postural"],
  ["Vermeiren", "INOVYS", "Silla Postural"],
  ["Meyra", "FEMTO", "Silla Ultra Livianas"],
  ["Meyra", "NANO", "Sillas Infantiles"],
  ["Jiangsu Intco Medica", "COYOTE", "Sillas Infantiles"],
  ["Alu Rehab", "COYOTE", "Silla Postural"],
];

// ---- Paso 11.3: marca por defecto (si no matcheo 11.1 ni 11.2) ----
// Nota: algunas claves son la Razon Social completa (ej. "JEPOINT S. A.",
// "TENACTA SOCIEDAD ANONIMA", "TRINIDAD INSUMOS S.R.L.") porque para esas
// filas el resto del parser uso el fallback de Razon Social (paso 7) o el
// fallback generico (paso 8) como Marca, no una marca del diccionario.
const SEGMENTO_BRAND_DEFAULT: Record<string, string> = {
  "A&J": "Silla Estándar",
  "Achieve": "Silla Activa y Deportivas",
  "Akces Med": "Silla Postural",
  "Alu Rehab": "Silla Postural",
  "Amelife": "Silla Estándar",
  "Anatomic": "Silla Postural",
  "Antares": "Silla Estándar",
  "Aria": "Silla Ultra Livianas",
  "Aspen": "Silla Estándar",
  "Berollka": "Silla Activa y Deportivas",
  "Box Wheelchairs": "Silla Activa y Deportivas",
  "Care Quip": "Silla Estándar",
  "Circle Specialty": "Sillas Infantiles",
  "Comfort": "Sillas Infantiles",
  "Convaid Products LLC": "Sillas Infantiles",
  "Double Care Medical": "Silla Estándar",
  "Drive Medical": "Silla Estándar",
  "EuroMix": "Silla Estándar",
  "Extra": "Silla Activa y Deportivas",
  "FARMACIA DE MEDRANO 533 SOCIED": "Silla Estándar",
  "Foshan": "Silla Estándar",
  "Foshan Dongfang": "Silla Estándar",
  "Foshan Dongfang Medical": "Silla Estándar",
  "Foshan Dongfang Medical Equipment Manufactory Ltd": "Silla Estándar",
  "Foshan Ecarre Medica": "Silla Estándar",
  "Foshan Feiyang": "Silla Estándar",
  "Foshan Gege": "Silla Estándar",
  "Foshan Kaiyang": "Silla Estándar",
  "Foshan Rafu Medical": "Silla Estándar",
  "Future Mobility Healthcare": "Silla Postural",
  "Gigantex": "Silla Estándar",
  "Guangdong Kaiyang": "Silla Estándar",
  "Hoggi": "Sillas Infantiles",
  "Intco": "Silla Estándar",
  "Intco Medical Industries Inc": "Silla Estándar",
  "Invacare": "Silla Estándar",
  "JEPOINT S. A.": "Silla Estándar",
  "James Leckey Design": "Sillas Infantiles",
  "Jiangsu": "Silla Estándar",
  "Jiangsu Intco Medica": "Silla Estándar",
  "Jiangsu Rixin Medica": "Silla Estándar",
  "Jianlian": "Silla Estándar",
  "KDB": "Silla Estándar",
  "KI Mobility": "Silla Ultra Livianas",
  "Kaiyang Medical": "Silla Estándar",
  "Karma": "Silla Estándar",
  "LIW": "Sillas Infantiles",
  "LIW Care Technology": "Sillas Infantiles",
  "Leggero": "Sillas Infantiles",
  "Lerado": "Silla Estándar",
  "LifeCare": "Silla Estándar",
  "Lightning": "Silla Postural",
  "MDH SP Z.O.O.": "Sillas Infantiles",
  "Magesa": "Silla Estándar",
  "Maverick": "Silla Estándar",
  "Merits": "Silla Estándar",
  "Meyra": "Silla Estándar",
  "Motion Composites": "Silla Ultra Livianas",
  "Movicare": "Silla Estándar",
  "Mugi": "Silla Estándar",
  "MyWam": "Sillas Infantiles",
  "NeaTech": "Sillas Infantiles",
  "Nova": "Silla de Traslado",
  "Offcarr": "Silla Postural",
  "One": "Sillas Infantiles",
  "Ormesa": "Sillas Infantiles",
  "Ortobras": "Silla Estándar",
  "Ottobock": "Silla Estándar",
  "PDG Product Design": "Silla Postural",
  "Patron": "Silla Postural",
  "Polior": "Silla Estándar",
  "R82": "Sillas Infantiles",
  "RGK": "Silla Activa y Deportivas",
  "Rebotec": "Silla Ultra Livianas",
  "Rifton": "Sillas Infantiles",
  "Sarl Vipamat": "Silla Activa y Deportivas",
  "SitMed": "Silla Postural",
  "Stealth Products": "Silla Postural",
  "Stryker": "Silla de Traslado",
  "SunCare": "Silla Estándar",
  "Sunrise Medical": "Silla Estándar",
  "TENACTA SOCIEDAD ANONIMA": "Silla Estándar",
  "TRINIDAD INSUMOS S.R.L.": "Silla Estándar",
  "Thomashilfen": "Sillas Infantiles",
  "TiLite": "Silla Ultra Livianas",
  "Timo": "Silla Postural",
  "Top Medi": "Silla Estándar",
  "U Nurse": "Silla Estándar",
  "Vermeiren": "Silla Estándar",
  "Vesco": "Silla Activa y Deportivas",
  "Water": "Silla de Traslado",
  "Yuwell": "Silla Estándar",
};

const SILLAS_SEGMENTO_FALLBACK = "Silla Estándar";

const sillasDeRuedasParser = createCategoryParser({
  ycCodeMap: SILLAS_YC_CODE_MAP,
  segmentoKeywords: SEGMENTO_KEYWORDS,
  segmentoBrandPrefix: SEGMENTO_BRAND_PREFIX,
  segmentoBrandDefault: SEGMENTO_BRAND_DEFAULT,
  segmentoFallback: SILLAS_SEGMENTO_FALLBACK,
});

// ============================================================
// Config: Sillas de Ruedas Electricas -- Segmento propio. NO reutiliza el
// esquema de sillas manuales (Sillas Infantiles / Ultra Livianas / etc.):
// son ejes de clasificacion distintos, pensados especificamente para
// sillas con motor (interior vs. exterior, plegable, reclinable,
// bariatrica). Taxonomia validada con el usuario 15/07/2026. Confianza
// BAJA en las keywords (ver nota de cabecera del archivo).
// ============================================================
// Taxonomia actualizada 16/07/2026 (reemplaza la anterior "Reclinable /
// Todo Terreno / Interior-Compacta", que no coincidia con el criterio real
// del usuario). 6 segmentos: Estandar, Plegable/Portatil, Scooter de
// Movilidad, Pediatrica, Bipedestacion, Bariatrica.
const ELECTRICAS_SEGMENTO_KEYWORDS: [string, string][] = [
  // Tabla 1, fila 1 -> Pediatrica (maxima prioridad)
  ["EXPLORER MINI", "Silla Eléctrica Pediátrica"],
  ["LORI", "Silla Eléctrica Pediátrica"],
  ["BABY", "Silla Eléctrica Pediátrica"],
  ["JUNIOR", "Silla Eléctrica Pediátrica"],
  ["TEEN", "Silla Eléctrica Pediátrica"],
  ["KID", "Silla Eléctrica Pediátrica"],
  ["PEDIAT", "Silla Eléctrica Pediátrica"],
  ["INFANT", "Silla Eléctrica Pediátrica"],
  ["ZIPPIE", "Silla Eléctrica Pediátrica"],
  ["SKIPPI", "Silla Eléctrica Pediátrica"],
  ["X340", "Silla Eléctrica Pediátrica"],
  // Tabla 1, fila 2 -> Bipedestacion
  ["BAFFIN", "Silla Eléctrica de Bipedestación"],
  ["ERGO STAND", "Silla Eléctrica de Bipedestación"],
  ["STAND", "Silla Eléctrica de Bipedestación"],
  ["Q700 UP", "Silla Eléctrica de Bipedestación"],
  ["BIPED", "Silla Eléctrica de Bipedestación"],
  ["VERTIC", "Silla Eléctrica de Bipedestación"],
  // Tabla 1, fila 3 -> Bariatrica
  ["EUROCHAIR XXL", "Silla Eléctrica Bariátrica"],
  ["XXL", "Silla Eléctrica Bariátrica"],
  ["BARIATRIC", "Silla Eléctrica Bariátrica"],
  // Tabla 1, fila 4 -> Scooter de Movilidad
  ["SCOOTER", "Scooter de Movilidad"],
  ["GO GO", "Scooter de Movilidad"],
  // Tabla 1, fila 5 -> Plegable / Portatil
  ["PLEGO", "Silla Eléctrica Plegable / Portátil"],
  ["FUSION", "Silla Eléctrica Plegable / Portátil"],
  ["EVO ALTUS", "Silla Eléctrica Plegable / Portátil"],
  ["ERGO NIMBLE", "Silla Eléctrica Plegable / Portátil"],
  ["I TRAVEL", "Silla Eléctrica Plegable / Portátil"],
  ["TRAVEL", "Silla Eléctrica Plegable / Portátil"],
  ["CARBON FIB", "Silla Eléctrica Plegable / Portátil"],
  ["Q50R", "Silla Eléctrica Plegable / Portátil"],
];

// Marcas nuevas (no compartidas con sillas de ruedas manuales) que necesitan
// tratamiento multi-palabra para que Marca no se corte a mitad de camino.
const ELECTRICAS_MULTI_WORD_EXTRA: [string, string][] = [
  ["QUANTUM REHAB", "Quantum Rehab"],
  ["TA SERVICE", "TA Service"],
  ["PRIDE MOBILITY", "Pride Mobility"],
  ["SKS REHAB", "SKS Rehab"],
  ["RN LEDESMA", "RN Ledesma"],
  ["JIANGSU INTCO MEDICAL", "Jiangsu Intco Medical"],
  ["FOSHAN ECARRE MEDICAL", "Foshan Ecarre Medical"],
];

// Tabla 2: marca -> segmento por defecto (si no matcheo la Tabla 1). Las
// marcas no listadas explicitamente (Estandar) llegan aca via fallback
// generico (Paso 8, Title Case) y coinciden exactamente con estas keys.
const ELECTRICAS_SEGMENTO_BRAND_DEFAULT: Record<string, string> = {
  "Permobil": "Silla Eléctrica Estándar",
  "Quantum Rehab": "Silla Eléctrica Estándar",
  "Karma": "Silla Eléctrica Estándar",
  "Foshan Ecarre Medical": "Silla Eléctrica Estándar",
  "LIW Care Technology": "Silla Eléctrica Pediátrica",
  "Sunrise Medical": "Silla Eléctrica Estándar",
  "Yuwell": "Silla Eléctrica Estándar",
  "Merits": "Silla Eléctrica Estándar",
  "Meyra": "Silla Eléctrica Estándar",
  "Vermeiren": "Silla Eléctrica Estándar",
  "Jiangsu Intco Medical": "Silla Eléctrica Estándar",
  "TA Service": "Silla Eléctrica Plegable / Portátil",
  "Double Care Medical": "Silla Eléctrica Estándar",
  "Pride Mobility": "Scooter de Movilidad",
  "Theramart": "Silla Eléctrica Estándar",
  "Intco": "Silla Eléctrica Estándar",
  "Robooter": "Silla Eléctrica Plegable / Portátil",
  "Ottobock": "Silla Eléctrica Estándar",
  "Aspen": "Silla Eléctrica Estándar",
  "Erivo": "Silla Eléctrica Estándar",
  "Top Medi": "Silla Eléctrica Estándar",
  "Ortobras": "Silla Eléctrica Estándar",
  "Amylior": "Silla Eléctrica Estándar",
  "A&J": "Silla Eléctrica Estándar",
  "Magesa": "Silla Eléctrica Estándar",
  "Xsto": "Silla Eléctrica Plegable / Portátil",
  "Mugi": "Silla Eléctrica Estándar",
  "Movicare": "Silla Eléctrica Estándar",
  "Libercar": "Scooter de Movilidad",
  "Kaiyang": "Silla Eléctrica Estándar",
  "Phoenix": "Silla Eléctrica Plegable / Portátil",
  "Amelife": "Silla Eléctrica Estándar",
  "SKS Rehab": "Silla Eléctrica Estándar",
  "Rifton": "Silla Eléctrica Pediátrica",
  "Houde": "Silla Eléctrica Estándar",
  "Heartway": "Scooter de Movilidad",
  "RN Ledesma": "Silla Eléctrica Estándar",
  "Jianlian": "Silla Eléctrica Estándar",
};

const sillasRuedasElectricasParser = createCategoryParser({
  multiWordDict: [...BRAND_MULTI_WORD_DICT, ...ELECTRICAS_MULTI_WORD_EXTRA],
  segmentoKeywords: ELECTRICAS_SEGMENTO_KEYWORDS,
  segmentoBrandDefault: ELECTRICAS_SEGMENTO_BRAND_DEFAULT,
  segmentoFallback: "Silla Eléctrica Estándar",
  // "ERIVO ERIVO R10" -> el fallback generico deja Marca "Erivo" pero
  // Modelo "ERIVO R10" (token de marca repetido); se observo este patron
  // en esta categoria especificamente.
  stripRepeatedMarcaFromModelo: true,
});

// ============================================================
// Configs: 6 categorias nuevas restantes -- taxonomia de Segmento propia
// por categoria, validada con el usuario 15/07/2026 (ver
// docs/ncm_nuevas_categorias.md para el contexto de cada categoria).
// Confianza BAJA en las keywords (ver nota de cabecera del archivo): se
// ajustan/completan con el primer sync real de cada categoria.
// ============================================================

// ---- Andadores y Bastones ----
// NOTA (16/07/2026): estas dos categorias YA NO usan createCategoryParser
// ni un NCM propio. Se descubrio que el NCM que se les habia asignado
// (9021.10.10) en realidad agrupa 5 sub-posiciones de aduana muy distintas
// (cuello, columna, calzado, muletas/bastones, residual) y que ademas el
// sufijo "LOS DEMAS" sigue mezclando productos no relacionados. El usuario
// armo un criterio de clasificacion por marca + descripcion de posicion
// (ver seccion "PARSER NCM 9021.10.10 -- ORTOPEDIA / ODONTOLOGIA" mas abajo
// en este archivo) que reemplaza el parser/segmento propio que tenian
// antes. Ver `parseOrtopedia9021Row` y `ORTOPEDIA_9021_CATEGORY_SLUGS`.

// ============================================================
// PARSER NCM 9404.90.00 -- ALMOHADAS Y COJINES (16/07/2026, reemplaza el
// parser anterior de "Almohadones Ortopedicos"). Renombrada porque bajo
// esta NCM entra data MUY heterogenea: almohadas comunes, cojines
// decorativos, ropa de cama/topper, articulos de mascotas, ademas de los
// ortopedicos/antiescaras -- NO es un NCM exclusivamente ortopedico.
// Patron B ("SIN MODELO" como separador, no Patron A como el parser viejo
// asumia -- ese era el bug: createCategoryParser solo sabe leer Patron A).
// ~27% de filas sin marca -> Marca = Razon Social. El texto tras "SIN
// MODELO" suele ser SOLO un codigo de SKU sin descripcion, por eso el
// segmento se resuelve principalmente por MARCA (Tabla 2) y, cuando hay
// palabra descriptiva, por keyword (Tabla 1, maxima prioridad).
// ============================================================
const ALMOHADAS_SEGMENTO_KEYWORDS: [string, string][] = [
  ["PET", "Artículos para Mascotas"],
  ["MASCOTA", "Artículos para Mascotas"],
  ["PERRO", "Artículos para Mascotas"],
  ["GATO", "Artículos para Mascotas"],
  ["DOG", "Artículos para Mascotas"],
  ["CAT", "Artículos para Mascotas"],
  ["CUCHA", "Artículos para Mascotas"],
  ["ANTIESCARA", "Cojín Ortopédico / Antiescaras"],
  ["ANTIDECUBITO", "Cojín Ortopédico / Antiescaras"],
  ["ORTOP", "Cojín Ortopédico / Antiescaras"],
  ["LUMBAR", "Cojín Ortopédico / Antiescaras"],
  ["ASIENTO", "Cojín Ortopédico / Antiescaras"],
  ["COCCIX", "Cojín Ortopédico / Antiescaras"],
  ["DONUT", "Cojín Ortopédico / Antiescaras"],
  ["POSTURAL", "Cojín Ortopédico / Antiescaras"],
  ["SILLA DE RUEDA", "Cojín Ortopédico / Antiescaras"],
  ["CERVICAL", "Almohada Cervical / Viscoelástica"],
  ["VISCO", "Almohada Cervical / Viscoelástica"],
  ["MEMORY", "Almohada Cervical / Viscoelástica"],
  ["CONTOUR", "Almohada Cervical / Viscoelástica"],
  ["NASA", "Almohada Cervical / Viscoelástica"],
  ["VIAJE", "Almohada de Viaje / Camping"],
  ["TRAVEL", "Almohada de Viaje / Camping"],
  ["CAMPING", "Almohada de Viaje / Camping"],
  ["INFLABLE", "Almohada de Viaje / Camping"],
  ["CUELLO", "Almohada de Viaje / Camping"],
  ["NECK", "Almohada de Viaje / Camping"],
  ["TOPPER", "Ropa de Cama / Topper"],
  ["EDREDON", "Ropa de Cama / Topper"],
  ["DUVET", "Ropa de Cama / Topper"],
  ["SOBRECOLCHON", "Ropa de Cama / Topper"],
  ["ACOLCHADO", "Ropa de Cama / Topper"],
  ["QUILT", "Ropa de Cama / Topper"],
  ["PROTECTOR", "Ropa de Cama / Topper"],
  ["COVER", "Ropa de Cama / Topper"],
  ["FUNDA", "Ropa de Cama / Topper"],
  ["DECORATIVO", "Cojín Decorativo / Hogar"],
  ["SOFA", "Cojín Decorativo / Hogar"],
  ["SILLON", "Cojín Decorativo / Hogar"],
  ["HOGAR", "Cojín Decorativo / Hogar"],
  ["THROW", "Cojín Decorativo / Hogar"],
  ["DECO", "Cojín Decorativo / Hogar"],
  ["ALMOHADA", "Almohada de Dormir"],
  ["PILLOW", "Almohada de Dormir"],
  ["PLUMON", "Almohada de Dormir"],
  ["PLUMA", "Almohada de Dormir"],
  ["DORMIR", "Almohada de Dormir"],
  ["KING", "Almohada de Dormir"],
  ["QUEEN", "Almohada de Dormir"],
  ["TWIN", "Almohada de Dormir"],
];

const ALMOHADAS_SEGMENTO_BRAND_DEFAULT: Record<string, string> = {
  THERAMART: "Cojín Ortopédico / Antiescaras",
  TRULIFE: "Cojín Ortopédico / Antiescaras",
  OTTOBOCK: "Cojín Ortopédico / Antiescaras",
  ALTENBURG: "Almohada de Dormir",
  CACHAREL: "Almohada de Dormir",
  ROSEN: "Almohada de Dormir",
  SUPERSPUMA: "Almohada de Dormir",
  ARREDO: "Almohada de Dormir",
  PRAVIA: "Almohada de Dormir",
  CITYBLANCO: "Almohada de Dormir",
  POTIERS: "Almohada de Dormir",
  "PIERRE CARDIN": "Almohada de Dormir",
  OUTZEN: "Almohada de Dormir",
  RENNER: "Almohada de Dormir",
  ESPALMA: "Almohada de Dormir",
  SPRINGWALL: "Almohada de Dormir",
  SELENIO: "Almohada de Dormir",
  CALMA: "Almohada de Dormir",
  DUOFLEX: "Almohada de Dormir",
  TAMPA: "Almohada de Dormir",
  DREAM: "Almohada de Dormir",
  CAMESA: "Almohada de Dormir",
  KARSTEN: "Almohada de Dormir",
  POSTO: "Almohada de Dormir",
  LANDMARK: "Almohada de Dormir",
  CLAUDIA: "Almohada de Dormir",
  MORPH: "Almohada de Dormir",
  DUVET: "Ropa de Cama / Topper",
  NASA: "Almohada Cervical / Viscoelástica",
  KREA: "Cojín Decorativo / Hogar",
  MINISO: "Cojín Decorativo / Hogar",
  "M+DESIGN": "Cojín Decorativo / Hogar",
  DECOTOTALE: "Cojín Decorativo / Hogar",
  BOCONCEPT: "Cojín Decorativo / Hogar",
  ASHLEY: "Cojín Decorativo / Hogar",
  BADECO: "Cojín Decorativo / Hogar",
  LUXOPHIE: "Cojín Decorativo / Hogar",
  "H&G": "Cojín Decorativo / Hogar",
  ROUGE: "Cojín Decorativo / Hogar",
  CHAMING: "Cojín Decorativo / Hogar",
  ALPHAKOKO: "Cojín Decorativo / Hogar",
  NATUREHIKE: "Almohada de Viaje / Camping",
  QUECHUA: "Almohada de Viaje / Camping",
  KIMJALY: "Almohada de Viaje / Camping",
  PUPPIS: "Artículos para Mascotas",
  BEEPAW: "Artículos para Mascotas (tentativo)",
};

const ALMOHADAS_SEGMENTO_FALLBACK = "Almohadón / Cojín Estándar";

/** Limpia la cola de sufijos aduaneros tipicos de esta NCM del texto de Modelo. */
function cleanAlmohadasModeloTail(modelo: string): string {
  return modelo
    .replace(/\(N[ABCD]\d*\)/gi, " ")
    .replace(/\(CA0*\)/gi, " ")
    .replace(/SIN\s+SUFIJOS/gi, " ")
    .replace(/DE\s+CAUCHO\s+O\s+PLASTICO\s+CELULARES/gi, " ")
    .replace(/DE\s+\d+\s*CM\s+DE\s+LARGO/gi, " ")
    .replace(/["'.,]/g, " ")
    .replace(/-+$/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function assignAlmohadasSegmento(marcaNorm: string, modeloUpper: string): string {
  for (const [kw, seg] of ALMOHADAS_SEGMENTO_KEYWORDS) {
    if (modeloUpper.includes(kw)) return seg;
  }
  if (ALMOHADAS_SEGMENTO_BRAND_DEFAULT[marcaNorm]) return ALMOHADAS_SEGMENTO_BRAND_DEFAULT[marcaNorm];
  return ALMOHADAS_SEGMENTO_FALLBACK;
}

/** Separa marca/modelo por el patron "<MARCA> SIN MODELO <codigo> (...)" compartido por varias NCM nuevas. */
function splitPatternB(sufijoRaw: string): { marcaRaw: string; modeloRaw: string; textoCompleto: string } {
  const textoSinParentesis = (sufijoRaw ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const sinModeloMatch = /\sSIN\s+MODELO\b/i.exec(textoSinParentesis);
  if (sinModeloMatch) {
    return {
      marcaRaw: textoSinParentesis.slice(0, sinModeloMatch.index).trim(),
      modeloRaw: textoSinParentesis.slice(sinModeloMatch.index + sinModeloMatch[0].length).trim(),
      textoCompleto: textoSinParentesis,
    };
  }
  return { marcaRaw: textoSinParentesis, modeloRaw: "", textoCompleto: textoSinParentesis };
}

const almohadasCojinesParser: CategoryParser = (raw) => {
  const razonSocial: string = raw.nombre ?? "";
  const { marcaRaw, modeloRaw, textoCompleto } = splitPatternB(raw.sufijos ?? "");

  const marcaVacia = marcaRaw.trim() === "" || /^(SIN\s+MARCA|S\/MARCA|S\/M|SM|S)\b/i.test(marcaRaw.trim());
  const marcaFinal = marcaVacia ? razonSocial || "Sin Identificar" : marcaRaw;
  const marcaNorm = marcaFinal.toUpperCase().replace(/[.,]/g, "").trim();

  const modeloLimpio = cleanAlmohadasModeloTail(modeloRaw || textoCompleto);
  const { modelo, color } = extractColorGeneric(modeloLimpio, "S/D");
  const segmento = assignAlmohadasSegmento(marcaNorm, modelo.toUpperCase());

  return { marca: marcaFinal, modelo: modelo || modeloLimpio, color, segmento };
};

// ============================================================
// PARSER NCM 9401.79.00 -- SILLAS Y ASIENTOS (16/07/2026, reemplaza el
// parser anterior de "Sillas de Ducha"). Renombrada: 9401.79.00 =
// "asientos con armazon de metal, los demas" -> en la practica son SILLAS
// Y ASIENTOS en general (living, exterior, playa, oficina, comedor, baño),
// no solo de ducha. Patron B. ~26% sin marca -> Marca = Razon Social.
// Señal fuerte de segmento: DESCRIPCION DE POSICION (col R) = "REPOSERAS".
// ============================================================
const SILLAS_ASIENTOS_SEGMENTO_FALLBACK = "Silla / Asiento Estándar";
const SILLAS_ASIENTOS_DUCHA_KEYWORDS = ["DUCHA", "BAÑO", "BANO", "SANITARIA", "INODORO", "COMMODE"];
const SILLAS_ASIENTOS_DUCHA_MARCAS = ["DRIVE", "FOSHAN"];
const SILLAS_ASIENTOS_OFICINA_KEYWORDS = ["OFICINA", "OFFICE", "ERGON", "GIRATORIA", "GERENCIAL"];
const SILLAS_ASIENTOS_OFICINA_MARCAS = ["SUNON", "CAVALETTI", "PROLINE"];
const SILLAS_ASIENTOS_BANQUETA_KEYWORDS = ["BANQUETA", "TABURETE", "STOOL", "TOLIX"];
const SILLAS_ASIENTOS_SILLON_KEYWORDS = ["SILLON", "BUTACA", "POLTRONA", "PUFF"];
const SILLAS_ASIENTOS_REPOSERA_KEYWORDS = ["REPOSERA", "PLAYA", "BEACH", "CAMPING", "PLEGABLE", "GRAVITY", "PESCA", "DIRECTOR"];
const SILLAS_ASIENTOS_REPOSERA_MARCAS = ["MOR", "QUECHUA", "NATUREHIKE", "BOTAFOGO", "BROKSOL", "LUSQTOFF", "GADNIC", "ALPINA", "KOA"];
const SILLAS_ASIENTOS_COMEDOR_KEYWORDS = ["COMEDOR", "COCINA", "DINING"];
const SILLAS_ASIENTOS_COMEDOR_MARCAS = ["TRAMONTINA"];
const SILLAS_ASIENTOS_DISENO_MARCAS = ["FERMOB", "FLEXFORM", "TIDELLI", "BOCONCEPT", "INCANTO", "M+DESIGN", "DECOTOTALE", "TRIBECA", "SITCOM", "EMUEBLES", "BRANX"];

function assignSillasAsientosSegmento(marcaNorm: string, textoUpper: string, descripcionUpper: string): string {
  const hasAny = (kws: string[]) => kws.some((k) => textoUpper.includes(k));
  const marcaIn = (marcas: string[]) => marcas.includes(marcaNorm);

  if (hasAny(SILLAS_ASIENTOS_DUCHA_KEYWORDS) || marcaIn(SILLAS_ASIENTOS_DUCHA_MARCAS)) return "Sillas de Ducha / Sanitarias";
  if (descripcionUpper.includes("REPOSERAS")) return "Reposeras / Playa y Camping";
  if (hasAny(SILLAS_ASIENTOS_OFICINA_KEYWORDS) || marcaIn(SILLAS_ASIENTOS_OFICINA_MARCAS)) return "Sillas de Oficina / Ergonómicas";
  if (hasAny(SILLAS_ASIENTOS_BANQUETA_KEYWORDS)) return "Banquetas y Taburetes";
  if (hasAny(SILLAS_ASIENTOS_SILLON_KEYWORDS)) return "Sillones y Butacas";
  if (hasAny(SILLAS_ASIENTOS_REPOSERA_KEYWORDS) || marcaIn(SILLAS_ASIENTOS_REPOSERA_MARCAS)) return "Reposeras / Playa y Camping";
  if (hasAny(SILLAS_ASIENTOS_COMEDOR_KEYWORDS) || marcaIn(SILLAS_ASIENTOS_COMEDOR_MARCAS)) return "Sillas de Comedor / Cocina";
  if (marcaIn(SILLAS_ASIENTOS_DISENO_MARCAS)) return "Sillas de Diseño / Decorativas";
  return SILLAS_ASIENTOS_SEGMENTO_FALLBACK;
}

/** Limpia descriptores aduaneros tipicos de esta NCM de la cola del Modelo. */
function cleanSillasAsientosModeloTail(modelo: string): string {
  return modelo
    .replace(/\(N[ABCD]\d*\)/gi, " ")
    .replace(/\(CA0*\)/gi, " ")
    .replace(/SIN\s+SUFIJOS/gi, " ")
    .replace(/CON\s+ASIENTO\s+DE\s+(PLASTICO|METAL)/gi, " ")
    .replace(/CON\s+RESPALDO\s+RECLINABLE/gi, " ")
    .replace(/CON\s+ARMAZON\s+DE\s+ALUMINIO/gi, " ")
    .replace(/["'.,]/g, " ")
    .replace(/-+$/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const sillasAsientosParser: CategoryParser = (raw) => {
  const razonSocial: string = raw.nombre ?? "";
  const descripcionPosicion: string = raw.posicion_descripcion ?? "";
  const { marcaRaw, modeloRaw, textoCompleto } = splitPatternB(raw.sufijos ?? "");

  const marcaVacia = marcaRaw.trim() === "" || /^(SIN\s+MARCA|S\/MARCA|S\/M|SM|S)\b/i.test(marcaRaw.trim());
  const marcaFinal = marcaVacia ? razonSocial || "Sin Identificar" : marcaRaw;
  const marcaNorm = marcaFinal.toUpperCase().replace(/[.,]/g, "").trim();

  const modeloLimpio = cleanSillasAsientosModeloTail(modeloRaw || textoCompleto);
  const { modelo, color } = extractColorGeneric(modeloLimpio, "S/D");
  const textoUpperCompleto = (raw.sufijos ?? "").toUpperCase();
  const segmento = assignSillasAsientosSegmento(marcaNorm, textoUpperCompleto, descripcionPosicion.toUpperCase());

  return { marca: marcaFinal, modelo: modelo || modeloLimpio, color, segmento };
};

// ============================================================
// PARSER NCM 3922.20.00 -- ELEVADORES DE INODORO (16/07/2026). La etiqueta
// NCM dice "Elevadores de Inodoro" pero 3922.20.00 = articulos sanitarios
// de plastico en general: en la practica dominan TAPAS/ASIENTOS de inodoro
// de marcas sanitarias comunes (Piazza, Roca, Deca Hydra, Duravit, Ferrum,
// Tigre, etc.); el elevador ortopedico real es minoria. Patron B.
// DESCRIPCION DE POSICION uniforme = "LOS DEMAS" (sin señal de tipo) -- el
// segmento se resuelve por MARCA + palabras clave del codigo.
// ============================================================
const ELEVADORES_SOFTCLOSE_KEYWORDS = ["SOFT CLOSE", "DESCENSO LENTO"];
const ELEVADORES_ORTOPEDICO_MARCAS = ["ASPEN", "JIANLIAN"];
const ELEVADORES_ORTOPEDICO_CODES = ["JL668B", "JL669B", "JL670B"];
const ELEVADORES_NAUTICA_MARCAS = ["SEAFLO", "EVAC"];
const ELEVADORES_INFANTIL_MARCAS = ["LOVE", "DUCK", "MEGABABY", "MEGA BABY", "OK BABY", "P&F BABY", "BELLUNO BABY", "FARMACITY BEBE", "CALMA DRAGON"];
const ELEVADORES_INFANTIL_KEYWORDS = ["BABY", "BEBE", "INFANTIL", "REDUCTOR"];
const ELEVADORES_REPUESTO_MARCAS = ["IMPERO", "OLYMPIA"];
const ELEVADORES_REPUESTO_CODES = ["C8IMP01"];
const ELEVADORES_SEGMENTO_FALLBACK = "Tapa / Asiento de Inodoro Estándar";

function assignElevadoresSegmento(marcaNorm: string, modeloUpper: string): string {
  if (ELEVADORES_SOFTCLOSE_KEYWORDS.some((k) => modeloUpper.includes(k))) return "Tapa Soft-Close / Descenso Lento";
  if (ELEVADORES_ORTOPEDICO_MARCAS.includes(marcaNorm) || ELEVADORES_ORTOPEDICO_CODES.some((c) => modeloUpper.includes(c))) {
    return "Elevador / Asiento Sanitario Ortopédico";
  }
  if (ELEVADORES_NAUTICA_MARCAS.includes(marcaNorm)) return "Tapa Náutica / Portátil";
  if (ELEVADORES_INFANTIL_MARCAS.includes(marcaNorm) || ELEVADORES_INFANTIL_KEYWORDS.some((k) => modeloUpper.includes(k))) {
    return "Adaptador / Reductor Infantil";
  }
  if (ELEVADORES_REPUESTO_MARCAS.includes(marcaNorm) || ELEVADORES_REPUESTO_CODES.some((c) => modeloUpper.includes(c))) {
    return "Repuestos / Accesorios";
  }
  return ELEVADORES_SEGMENTO_FALLBACK;
}

/** Modelo = codigo entre "SIN MODELO" y "SIN SUFIJOS" (si aparece esta segunda etiqueta). */
function cleanElevadoresModeloTail(modelo: string): string {
  const sinSufijosMatch = /\sSIN\s+SUFIJOS\b/i.exec(modelo);
  const cortado = sinSufijosMatch ? modelo.slice(0, sinSufijosMatch.index) : modelo;
  return cortado
    .replace(/\(N[ABCD]\d*\)/gi, " ")
    .replace(/\(CA0*\)/gi, " ")
    .replace(/["'.,]/g, " ")
    .replace(/-+$/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const elevadoresInodoroParser: CategoryParser = (raw) => {
  const razonSocial: string = raw.nombre ?? "";
  const { marcaRaw, modeloRaw, textoCompleto } = splitPatternB(raw.sufijos ?? "");

  const marcaVacia = marcaRaw.trim() === "" || /^(SIN\s+MARCA|S\/MARCA|S\/M|SM|S)\b/i.test(marcaRaw.trim());
  const marcaFinal = marcaVacia ? razonSocial || "Sin Identificar" : marcaRaw;
  const marcaNorm = marcaFinal.toUpperCase().replace(/[.,]/g, "").trim();

  const modeloLimpio = cleanElevadoresModeloTail(modeloRaw || textoCompleto);
  const { modelo, color } = extractColorGeneric(modeloLimpio, "S/D");
  const segmento = assignElevadoresSegmento(marcaNorm, modelo.toUpperCase());

  return { marca: marcaFinal, modelo: modelo || modeloLimpio, color, segmento };
};

// ============================================================
// PARSER NCM 9402.90.20 -- CAMAS HOSPITALARIAS (16/07/2026). Patron B
// (split "SIN MODELO", sin-marca->razon social, Modelo N por P.U. -- igual
// que el resto). El texto aduanero NO trae indicador de tipo; el tipo
// electrica/manual se deduce de marca+codigo segun catalogo del
// fabricante (fuentes: leexmedical.com, medik-medical.com,
// magesastore.com.ar, chinasaikang.com, medicalexpo.com, vermeiren.com).
// ~21% de las filas quedan en "Tipo no especificado" por falta de
// catalogo publico -- reclasificar al conseguirlo.
// ============================================================
const CAMAS_REPUESTO_KEYWORDS = ["SIDE RAIL", "DRAINAGE HOOK", "CRANK", "LEGREST", "BACKREST", "HEIGHT ADJUSTMENT", "BRACKET", "HOOK", "IV POLE"];
const CAMAS_REPUESTO_MARCAS = ["DEWERT"];
const CAMAS_CAMILLA_KEYWORDS = ["STRETCHER", "CAMILLA", "ESTIRADOR"];
const CAMAS_PEDIATRICA_KEYWORDS = ["BABYCARE", "BABY", "PEDIATR", "CUNA", "NEONATAL", "CRIB"];
const CAMAS_ELECTRICA_MARCAS = ["LEEX", "HILL ROM", "LINET", "PARAMOUNT", "MERITS", "VERMEIREN", "COMPELLA", "MALVESTIO", "ARJO", "CENTURIS PRO", "ACCELLA"];

function assignCamasSegmento(marcaNorm: string, modeloUpper: string): string {
  if (CAMAS_REPUESTO_KEYWORDS.some((k) => modeloUpper.includes(k)) || CAMAS_REPUESTO_MARCAS.includes(marcaNorm)) {
    return "Repuestos / Partes de Cama";
  }
  if (CAMAS_CAMILLA_KEYWORDS.some((k) => modeloUpper.includes(k)) || (marcaNorm === "STRYKER" && /(7500|8500|SECURE)/.test(modeloUpper))) {
    return "Camilla / Estirador";
  }
  if (CAMAS_PEDIATRICA_KEYWORDS.some((k) => modeloUpper.includes(k)) || marcaNorm.includes("BABYCARE") || marcaNorm === "PARDO") {
    return "Cama Pediátrica / Neonatal";
  }
  if (CAMAS_ELECTRICA_MARCAS.includes(marcaNorm)) return "Cama Hospitalaria Eléctrica";
  // Medik: codigo "YA-D..." = electrica; "YA-M..." = manual/manivela.
  if (marcaNorm === "MEDIK") {
    if (/YA-?D/.test(modeloUpper)) return "Cama Hospitalaria Eléctrica";
    if (/YA-?M/.test(modeloUpper)) return "Cama Hospitalaria Manual / Mecánica";
  }
  // Magesa: codigo que empieza con "D" (D6W, D8D) = electrica; con "V" (V2K, V3K) = manual.
  if (marcaNorm === "MAGESA") {
    if (/^D\w/.test(modeloUpper)) return "Cama Hospitalaria Eléctrica";
    if (/^V\w/.test(modeloUpper)) return "Cama Hospitalaria Manual / Mecánica";
  }
  // Saikang: V6/V8/K/Y8 = electrica; V3 = manual.
  if (marcaNorm === "SAIKANG") {
    if (/\bV3\b/.test(modeloUpper)) return "Cama Hospitalaria Manual / Mecánica";
    if (/(V6|V8|\bK\b|Y8)/.test(modeloUpper)) return "Cama Hospitalaria Eléctrica";
  }
  // Mux / Better / Brother, serie "BT": sufijo E/EP/EPZ = electrica; M = manual.
  if (["MUX", "BETTER", "BROTHER"].includes(marcaNorm) && /\bBT/.test(modeloUpper)) {
    if (/BT\S*(EPZ|EP|E)\b/.test(modeloUpper)) return "Cama Hospitalaria Eléctrica";
    if (/BT\S*M\b/.test(modeloUpper)) return "Cama Hospitalaria Manual / Mecánica";
  }
  // Suncare: EB = electrica; MB = manual.
  if (marcaNorm === "SUNCARE") {
    if (modeloUpper.includes("EB")) return "Cama Hospitalaria Eléctrica";
    if (modeloUpper.includes("MB")) return "Cama Hospitalaria Manual / Mecánica";
  }
  // Coinfycare: codigo "ES...EX" = electrica.
  if (marcaNorm === "COINFYCARE" && /ES\w*EX/.test(modeloUpper)) return "Cama Hospitalaria Eléctrica";
  return "Cama Hospitalaria (Tipo no especificado)";
}

/** Limpia descriptores aduaneros tipicos de esta NCM de la cola del Modelo. */
function cleanCamasModeloTail(modelo: string): string {
  return modelo
    .replace(/\(N[ABCD]\d*\)/gi, " ")
    .replace(/\(CA0*\)/gi, " ")
    .replace(/SIN\s+SUFIJOS/gi, " ")
    .replace(/["'.,]/g, " ")
    .replace(/-+$/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const camasHospitalariasParser: CategoryParser = (raw) => {
  const razonSocial: string = raw.nombre ?? "";
  const { marcaRaw, modeloRaw, textoCompleto } = splitPatternB(raw.sufijos ?? "");

  const marcaVacia = marcaRaw.trim() === "" || /^(SIN\s+MARCA|S\/MARCA|S\/M|SM|S)\b/i.test(marcaRaw.trim());
  const marcaFinal = marcaVacia ? razonSocial || "Sin Identificar" : marcaRaw;
  const marcaNorm = marcaFinal.toUpperCase().replace(/[.,]/g, "").trim();

  const modeloLimpio = cleanCamasModeloTail(modeloRaw || textoCompleto);
  const { modelo, color } = extractColorGeneric(modeloLimpio, "S/D");
  const segmento = assignCamasSegmento(marcaNorm, modelo.toUpperCase());

  return { marca: marcaFinal, modelo: modelo || modeloLimpio, color, segmento };
};

// ============================================================
// Registro de parsers por categoria
// ============================================================

export const CATEGORY_PARSERS: Record<string, CategoryParser> = {
  // Importante: SIEMPRE se llama al parser, incluso si "sufijos" viene vacio.
  // El parser mismo sabe que hacer en ese caso (usa la Razon Social del
  // importador como Marca).
  // NOTA: "andadores", "bastones" y "calzado_ortopedico" NO estan aca --
  // usan el parser especial de NCM 9021.10.10 (parseOrtopedia9021Row, mas
  // abajo), que se invoca directo desde app/api/sync/route.ts en vez de a
  // traves de este registro (porque un solo NCM se reparte en 3 categorias
  // segun marca/descripcion, no es 1 categoria = 1 parser).
  sillas_de_ruedas: sillasDeRuedasParser,
  sillas_ruedas_electricas: sillasRuedasElectricasParser,
  // NOTA: "almohadones_ortopedicos" y "sillas_ducha" son los SLUGS internos
  // (no cambian, category_ncm_codes/field_mappings siguen apuntando a
  // estos ids) -- solo el nombre visible en el dashboard (columna `name`
  // de `categories`) se actualiza a "Almohadas y Cojines" / "Sillas y
  // Asientos" via SQL (ver docs/PROYECTO.md).
  almohadones_ortopedicos: almohadasCojinesParser,
  sillas_ducha: sillasAsientosParser,
  elevadores_inodoro: elevadoresInodoroParser,
  camas_hospitalarias: camasHospitalariasParser,
};

/** Categorias que necesitan el flujo de EXPORTACION (con Sufijos) en vez de /data normal. */
export function categoryUsesExportFlow(categorySlug: string): boolean {
  return categorySlug in CATEGORY_PARSERS || ORTOPEDIA_9021_CATEGORY_SLUGS.includes(categorySlug as any);
}

// ============================================================
// PARSER NCM 9021.10.10 — ORTOPEDIA / ODONTOLOGIA (16/07/2026)
// ============================================================
// Este NCM agrupa 5 sub-posiciones de aduana (cuello, columna vertebral,
// calzado ortopedico, muletas/bastones, residual "los demas") bajo un
// mismo codigo base -- y el sufijo residual sigue mezclando productos no
// relacionados entre si (implantes, ortodoncia, andadores, etc.). En vez
// de separar por sufijo NCM (no alcanza), se clasifica CADA FILA por
// marca declarada + fallback de Descripcion de Posicion, siguiendo el
// criterio armado a mano por el usuario sobre datos reales (Excel).
//
// De las 9 categorias que distingue el criterio original, el dashboard
// solo trackea 3 (decision del usuario 16/07/2026): "andadores",
// "bastones" y "calzado_ortopedico". El resto (Ortodoncia, Ortopedia y
// Protesis, Implantes de Columna, Implantes de Trauma y Cirugia,
// Inmovilizadores y Ferulas, Bipedestacion y Rehab. Pediatrica, Otros) se
// descarta -- no forman parte de este dashboard de equipamiento/ayudas
// tecnicas. "Bastones" se mantiene como categoria separada de "andadores"
// (no se fusionan), aunque el criterio original las agrupa a ambas bajo
// "Ayudas para la Marcha" con el Segmento como diferenciador.
//
// Como UN solo NCM se reparte en 3 categorias, esto NO se procesa como los
// demas (1 categoria -> upsertRawRecords con CATEGORY_PARSERS[slug]). Se
// pide el export UNA sola vez desde app/api/sync/route.ts, se categoriza
// cada fila con `parseOrtopedia9021Row`, y se reparte a upsertPreParsedRecords
// (lib/aggregate.ts) por categoria.

export const ORTOPEDIA_9021_NCM = "9021.10.10";
export const ORTOPEDIA_9021_CATEGORY_SLUGS = ["andadores", "bastones", "calzado_ortopedico"] as const;

export interface OrtopediaParsed {
  marca: string;
  modelo: string;
  color: string;
  segmento: string;
  categoriaSlug: "andadores" | "bastones" | "calzado_ortopedico" | null;
}

type OrtopediaCategoria =
  | "Ortodoncia"
  | "Ortopedia y Protesis"
  | "Implantes de Columna"
  | "Implantes de Trauma y Cirugia"
  | "Inmovilizadores y Ferulas"
  | "Ayudas para la Marcha"
  | "Bipedestacion y Rehab. Pediatrica"
  | "Calzado Ortopedico"
  | "Otros";

// Marca (normalizada: mayusculas, sin puntuacion) -> categoria + segmento
// por defecto. "(segun descripcion)" significa que esa marca mezcla
// muletas/bastones Y andadores segun el producto puntual -- se resuelve
// con la Descripcion de Posicion (ver ortopediaSegmentoMarchaPorDescripcion).
const ORTOPEDIA_MARCA_TABLE: [string, OrtopediaCategoria, string][] = [
  // Ortodoncia
  ["ADITEK", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["MORELLI", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["ASTAR", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["AMERICAN ORTHODONTICS", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["GC", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["TECNIDENT", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["ORTHO ORGANIZERS", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["ORTHOMETRIC", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["MODERN ORTHODONTICS", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["LM-DENTAL", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["LM DENTAL", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["HUBIT", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["WORLD CLASS TECHNOLOGY", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["EKSEN", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["DTC", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["G&H ORTHODONTICS", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["DENTAURUM", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["FORESTADENT", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["LEONE", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["ORTHO TECHNOLOGY", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["DYNAFLEX", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["TDM", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["DENSELL", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["SHINYE", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["AOSUO", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["RAISE", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["VOYAR", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["FROGGY MOUTH", "Ortodoncia", "Insumos y Aparatologia de Ortodoncia"],
  ["CLEARCORRECT", "Ortodoncia", "Alineadores Transparentes"],
  ["ALIGN TECHNOLOGY", "Ortodoncia", "Alineadores Transparentes"],
  ["SPARK (ORMCO)", "Ortodoncia", "Alineadores Transparentes"],

  // Ortopedia y Protesis
  ["OSSUR", "Ortopedia y Protesis", "Protesis de Miembro"],
  ["ÖSSUR", "Ortopedia y Protesis", "Protesis de Miembro"],
  ["OTTOBOCK", "Ortopedia y Protesis", "Protesis de Miembro"],
  ["FILLAUER", "Ortopedia y Protesis", "Protesis de Miembro"],
  ["ALPS", "Ortopedia y Protesis", "Protesis de Miembro"],
  ["STREIFENEDER", "Ortopedia y Protesis", "Protesis de Miembro"],
  ["PROTEOR", "Ortopedia y Protesis", "Protesis de Miembro"],
  ["STEEPER", "Ortopedia y Protesis", "Protesis de Miembro"],
  ["TOUCH BIONICS", "Ortopedia y Protesis", "Protesis de Miembro"],
  ["PECLAB", "Ortopedia y Protesis", "Protesis de Miembro"],
  ["IMD", "Ortopedia y Protesis", "Protesis de Miembro"],
  ["PER ROS", "Ortopedia y Protesis", "Protesis de Miembro"],
  ["AMBROISE", "Ortopedia y Protesis", "Protesis de Miembro"],
  ["BECKER ORTHOPEDIC", "Ortopedia y Protesis", "Ortesis de Miembro"],
  ["FIOR & GENTZ", "Ortopedia y Protesis", "Ortesis de Miembro"],
  ["FIOR GENTZ", "Ortopedia y Protesis", "Ortesis de Miembro"],
  ["ALLARD", "Ortopedia y Protesis", "Ortesis de Miembro"],
  ["TURBOMED", "Ortopedia y Protesis", "Ortesis de Miembro"],
  ["CAMP SCANDINAVIA", "Ortopedia y Protesis", "Ortesis de Miembro"],
  ["SYMMETRIC DESIGNS", "Ortopedia y Protesis", "Ortesis de Miembro"],
  ["SPIO", "Ortopedia y Protesis", "Ortesis de Miembro"],
  ["DESIGN VERONIQUE", "Ortopedia y Protesis", "Ortesis de Miembro"],
  ["REHANORM", "Ortopedia y Protesis", "Ortesis de Miembro"],
  ["VELA", "Ortopedia y Protesis", "Ortesis de Miembro"],
  ["VOE", "Ortopedia y Protesis", "Ortesis de Miembro"],
  ["ANJON", "Ortopedia y Protesis", "Ortesis de Miembro"],

  // Implantes de Columna
  ["ULRICH MEDICAL", "Implantes de Columna", "Sistemas de Fijacion Vertebral"],
  ["CANWELL", "Implantes de Columna", "Sistemas de Fijacion Vertebral"],
  ["PETER LAZIC", "Implantes de Columna", "Sistemas de Fijacion Vertebral"],
  ["ARTUS", "Implantes de Columna", "Sistemas de Fijacion Vertebral"],
  ["MEDTRONIC", "Implantes de Columna", "Sistemas de Fijacion Vertebral"],
  ["JAZZ LOCK", "Implantes de Columna", "Sistemas de Fijacion Vertebral"],
  ["CDH", "Implantes de Columna", "Sistemas de Fijacion Vertebral"],
  ["CENTINEL SPINE", "Implantes de Columna", "Dispositivos Intersomaticos"],
  ["SILONY SPINE", "Implantes de Columna", "Dispositivos Intersomaticos"],
  ["TRIADYME", "Implantes de Columna", "Dispositivos Intersomaticos"],

  // Implantes de Trauma y Cirugia
  ["ARTHREX", "Implantes de Trauma y Cirugia", "Artroscopia y Medicina Deportiva"],
  ["JIANGSU SHUANGYANG", "Implantes de Trauma y Cirugia", "Trauma y Osteosintesis"],
  ["JIANGSU", "Implantes de Trauma y Cirugia", "Trauma y Osteosintesis"],
  ["WONDERFU", "Implantes de Trauma y Cirugia", "Trauma y Osteosintesis"],
  ["CALDERA MEDICAL", "Implantes de Trauma y Cirugia", "Trauma y Osteosintesis"],
  ["CIZETA SURGICAL", "Implantes de Trauma y Cirugia", "Trauma y Osteosintesis"],
  ["TECRES", "Implantes de Trauma y Cirugia", "Trauma y Osteosintesis"],
  ["KLS MARTIN", "Implantes de Trauma y Cirugia", "Cirugia Maxilofacial"],

  // Inmovilizadores y Ferulas
  ["ASPEN", "Inmovilizadores y Ferulas", "Ortesis de Columna y Lumbar"],
  ["BAXMAX", "Inmovilizadores y Ferulas", "Ortesis de Columna y Lumbar"],
  ["BODY CARE", "Inmovilizadores y Ferulas", "Ortesis de Columna y Lumbar"],
  ["DONJOY", "Inmovilizadores y Ferulas", "Inmovilizadores y Ferulas de Miembro"],
  ["AIRCAST", "Inmovilizadores y Ferulas", "Inmovilizadores y Ferulas de Miembro"],
  ["DJO", "Inmovilizadores y Ferulas", "Inmovilizadores y Ferulas de Miembro"],
  ["PROCARE", "Inmovilizadores y Ferulas", "Inmovilizadores y Ferulas de Miembro"],
  ["REH4MAT", "Inmovilizadores y Ferulas", "Inmovilizadores y Ferulas de Miembro"],
  ["STABILO", "Inmovilizadores y Ferulas", "Inmovilizadores y Ferulas de Miembro"],
  ["ANTARES", "Inmovilizadores y Ferulas", "Inmovilizadores y Ferulas de Miembro"],
  ["THERAMART", "Inmovilizadores y Ferulas", "Inmovilizadores y Ferulas de Miembro"],
  ["EMERALD SUPPLY", "Inmovilizadores y Ferulas", "Inmovilizadores y Ferulas de Miembro"],
  ["BLISS MEDICAL", "Inmovilizadores y Ferulas", "Inmovilizadores y Ferulas de Miembro"],
  ["MEDLINE", "Inmovilizadores y Ferulas", "Inmovilizadores y Ferulas de Miembro"],
  ["AMELIFE", "Inmovilizadores y Ferulas", "Collares Cervicales"],
  ["MEDRESQ", "Inmovilizadores y Ferulas", "Collares Cervicales"],
  ["XIEHE MEDICAL", "Inmovilizadores y Ferulas", "Collares Cervicales"],
  ["TINGEER", "Inmovilizadores y Ferulas", "Collares Cervicales"],
  ["IRON DUCK", "Inmovilizadores y Ferulas", "Collares Cervicales"],

  // Ayudas para la Marcha (segmento FIJO: muletas/bastones)
  ["MAVERICK", "Ayudas para la Marcha", "Muletas y Bastones"],
  ["SUNCARE", "Ayudas para la Marcha", "Muletas y Bastones"],
  ["MAGESA", "Ayudas para la Marcha", "Muletas y Bastones"],
  ["ACHIEVE", "Ayudas para la Marcha", "Muletas y Bastones"],
  ["SAN UP", "Ayudas para la Marcha", "Muletas y Bastones"],
  ["SILFAB", "Ayudas para la Marcha", "Muletas y Bastones"],
  // Ayudas para la Marcha (segmento FIJO: andadores)
  ["VOLARIS", "Ayudas para la Marcha", "Andadores y Ayudas de Marcha"],
  // Ayudas para la Marcha (segmento VARIABLE -> se resuelve por descripcion)
  ["JIANLIAN", "Ayudas para la Marcha", "(segun descripcion)"],
  ["DRIVE MEDICAL", "Ayudas para la Marcha", "(segun descripcion)"],
  ["REBOTEC", "Ayudas para la Marcha", "(segun descripcion)"],
  ["LIFECARE", "Ayudas para la Marcha", "(segun descripcion)"],
  ["KAIYANG MEDICAL", "Ayudas para la Marcha", "(segun descripcion)"],
  ["INTCO", "Ayudas para la Marcha", "(segun descripcion)"],
  ["JIANGSU INTCO MEDICAL", "Ayudas para la Marcha", "(segun descripcion)"],
  ["MPSHOP", "Ayudas para la Marcha", "(segun descripcion)"],
  ["YUWELL", "Ayudas para la Marcha", "(segun descripcion)"],
  ["MUGI", "Ayudas para la Marcha", "(segun descripcion)"],
  ["MOVICARE", "Ayudas para la Marcha", "(segun descripcion)"],
  ["VERMEIREN", "Ayudas para la Marcha", "(segun descripcion)"],
  ["SUNRISE MEDICAL", "Ayudas para la Marcha", "(segun descripcion)"],
  ["WATER", "Ayudas para la Marcha", "(segun descripcion)"],
  ["U NURSE", "Ayudas para la Marcha", "(segun descripcion)"],
  ["A&J", "Ayudas para la Marcha", "(segun descripcion)"],
  ["DONGGUAN LEYUAN", "Ayudas para la Marcha", "(segun descripcion)"],
  ["DOUBLE CARE MEDICAL", "Ayudas para la Marcha", "(segun descripcion)"],
  ["JIANWEI", "Ayudas para la Marcha", "(segun descripcion)"],
  ["FOSHAN", "Ayudas para la Marcha", "(segun descripcion)"],
  ["FOSHAN GEGE", "Ayudas para la Marcha", "(segun descripcion)"],
  ["FOSHAN KAIYANG", "Ayudas para la Marcha", "(segun descripcion)"],
  ["FOSHAN RAFU MEDICAL", "Ayudas para la Marcha", "(segun descripcion)"],
  ["FOSHAN ECARRE MEDICAL", "Ayudas para la Marcha", "(segun descripcion)"],
  ["FOSHAN DONGFANG MEDICAL", "Ayudas para la Marcha", "(segun descripcion)"],

  // Bipedestacion y Rehab. Pediatrica
  ["EASYSTAND", "Bipedestacion y Rehab. Pediatrica", "Bipedestadores"],
  ["R82", "Bipedestacion y Rehab. Pediatrica", "Equipamiento de Rehabilitacion Pediatrica"],
  ["RIFTON", "Bipedestacion y Rehab. Pediatrica", "Equipamiento de Rehabilitacion Pediatrica"],
  ["AKCES MED", "Bipedestacion y Rehab. Pediatrica", "Equipamiento de Rehabilitacion Pediatrica"],
  ["ORMESA", "Bipedestacion y Rehab. Pediatrica", "Equipamiento de Rehabilitacion Pediatrica"],
  ["JENX", "Bipedestacion y Rehab. Pediatrica", "Equipamiento de Rehabilitacion Pediatrica"],
  ["LIW CARE TECHNOLOGY", "Bipedestacion y Rehab. Pediatrica", "Equipamiento de Rehabilitacion Pediatrica"],
  ["HOGGI", "Bipedestacion y Rehab. Pediatrica", "Equipamiento de Rehabilitacion Pediatrica"],
  ["CIRCLE SPECIALTY", "Bipedestacion y Rehab. Pediatrica", "Equipamiento de Rehabilitacion Pediatrica"],
  ["BEROLLKA", "Bipedestacion y Rehab. Pediatrica", "Equipamiento de Rehabilitacion Pediatrica"],
  ["MYWAM", "Bipedestacion y Rehab. Pediatrica", "Equipamiento de Rehabilitacion Pediatrica"],
  ["NEXTSTEP ROBOTICS", "Bipedestacion y Rehab. Pediatrica", "Equipamiento de Rehabilitacion Pediatrica"],
  ["USL ROBOTICS", "Bipedestacion y Rehab. Pediatrica", "Equipamiento de Rehabilitacion Pediatrica"],
  ["AUXIVO", "Bipedestacion y Rehab. Pediatrica", "Equipamiento de Rehabilitacion Pediatrica"],

  // Calzado Ortopedico
  ["MEMO", "Calzado Ortopedico", "Calzado Ortopedico"],
  ["MD ORTHOPAEDICS", "Calzado Ortopedico", "Calzado Ortopedico"],
  ["BILLY FOOTWEAR", "Calzado Ortopedico", "Calzado Ortopedico"],
  ["STEP ON", "Calzado Ortopedico", "Calzado Ortopedico"],

  // Otros
  ["TRINIDAD INSUMOS S.R.L.", "Otros", "Otros"],
  ["TRINIDAD INSUMOS", "Otros", "Otros"],
  ["IOWA", "Otros", "Otros"],
  ["OTOSTICK", "Otros", "Otros"],
  ["DQM VETERINARIA", "Otros", "Otros"],
  ["GE RUI HONG KANG", "Otros", "Otros"],
];

const ORTOPEDIA_MARCA_DICT: Record<string, { categoria: OrtopediaCategoria; segmento: string }> = Object.fromEntries(
  ORTOPEDIA_MARCA_TABLE.map(([marca, categoria, segmento]) => [marca, { categoria, segmento }])
);

// Typos conocidos de marca (Paso B). Se evaluan como regex sobre la marca
// ya normalizada (mayusculas, puntuacion -> espacio, espacios colapsados).
const ORTOPEDIA_MARCA_TYPOS: [RegExp, string][] = [
  [/^OTTO ?BOCKK?$/, "OTTOBOCK"],
  [/^OTTTOBOCK$/, "OTTOBOCK"],
  [/^FORESTA ?DENT$/, "FORESTADENT"],
  [/^FIOR (GENTZ|& GENTZ)$/, "FIOR & GENTZ"],
  [/^CANWELLL?$/, "CANWELL"],
  [/^KLS( MARTIN)?( GROUP)?$/, "KLS MARTIN"],
  [/^KLS MATIN$/, "KLS MARTIN"],
  [/^(ULRICH|URLICH) ME[DI]?ICAL$/, "ULRICH MEDICAL"],
  [/^R ?82 A\/?S$/, "R82"],
  [/^TENCIDENT$/, "TECNIDENT"],
  [/^AICARST$/, "AIRCAST"],
];

function normalizeOrtopediaMarcaTypo(marca: string): string {
  for (const [re, canon] of ORTOPEDIA_MARCA_TYPOS) {
    if (re.test(marca)) return canon;
  }
  return marca;
}

// Fallback A (Paso E): filas SIN marca reconocible (vacia, "SIN MARCA",
// "S/M", etc.) o con una marca que no esta en el diccionario -- se
// aproxima la categoria/segmento por el texto de Descripcion de Posicion.
function ortopediaCategoriaSinMarca(descripcion: string): { categoria: OrtopediaCategoria; segmento: string } {
  const d = (descripcion || "").toUpperCase();
  if (d.includes("CALZADO")) return { categoria: "Calzado Ortopedico", segmento: "Calzado Ortopedico" };
  if (d.includes("COLUMNA")) return { categoria: "Implantes de Columna", segmento: "Sistemas de Fijacion Vertebral" };
  if (d.includes("CUELLO")) return { categoria: "Inmovilizadores y Ferulas", segmento: "Collares Cervicales" };
  if (d.includes("MULETA") || d.includes("BASTON")) return { categoria: "Ayudas para la Marcha", segmento: "Muletas y Bastones" };
  return { categoria: "Otros", segmento: "Otros" };
}

// Fallback B (Paso E): marca YA identificada como "Ayudas para la Marcha"
// con segmento variable ("(segun descripcion)") -- ya se sabe que es
// Ayudas para la Marcha, solo falta si es muleta/baston o andador.
function ortopediaSegmentoMarchaPorDescripcion(descripcion: string): string {
  const d = (descripcion || "").toUpperCase();
  if (d.includes("MULETA") || d.includes("BASTON")) return "Muletas y Bastones";
  return "Andadores y Ayudas de Marcha";
}

// Traduce (categoria, segmento) del criterio de 9 categorias al slug
// interno de las UNICAS 3 categorias que trackea este dashboard (decision
// del usuario 16/07/2026). Todo lo demas devuelve null (se descarta, no se
// inserta en trade_records).
function ortopediaCategoriaSlug(
  categoria: OrtopediaCategoria,
  segmento: string
): "andadores" | "bastones" | "calzado_ortopedico" | null {
  if (categoria === "Calzado Ortopedico") return "calzado_ortopedico";
  if (categoria === "Ayudas para la Marcha") {
    if (segmento === "Andadores y Ayudas de Marcha") return "andadores";
    if (segmento === "Muletas y Bastones") return "bastones";
  }
  return null;
}

/**
 * Clasifica una fila cruda de la exportacion IA40 (NCM 9021.10.10) en
 * marca/modelo/color/segmento + la categoria interna a la que pertenece
 * (o null si no es ninguna de las 3 que trackea este dashboard).
 *
 * Formato del texto de aduana en esta NCM (columna "sufijos", distinto al
 * de sillas de ruedas): "<MARCA> SIN MODELO <codigo> (CA00)".
 */
export function parseOrtopedia9021Row(row: any): OrtopediaParsed {
  const sufijoRaw: string = row.sufijos ?? "";
  const razonSocial: string = row.nombre ?? "";
  const descripcionPosicion: string = row.posicion_descripcion ?? "";

  // Paso A: quitar parentesis final, cortar por "SIN MODELO".
  const textoSinParentesis = sufijoRaw.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const sinModeloMatch = /\sSIN\s+MODELO\b/i.exec(textoSinParentesis);

  let marcaRaw: string;
  let modelo: string;
  if (sinModeloMatch) {
    marcaRaw = textoSinParentesis.slice(0, sinModeloMatch.index).trim();
    modelo = textoSinParentesis.slice(sinModeloMatch.index + sinModeloMatch[0].length).trim();
  } else {
    marcaRaw = textoSinParentesis;
    modelo = "";
  }

  const marcaVacia = marcaRaw.trim() === "" || /^(SIN\s+MARCA|S\/M|NO\s+POSEE|0)\b/i.test(marcaRaw.trim());

  if (marcaVacia) {
    const { categoria, segmento } = ortopediaCategoriaSinMarca(descripcionPosicion);
    return {
      marca: razonSocial || "Sin Identificar",
      modelo: modelo || textoSinParentesis,
      color: "S/D",
      segmento,
      categoriaSlug: ortopediaCategoriaSlug(categoria, segmento),
    };
  }

  // Paso B: normalizar (mayusculas, puntuacion -> espacio, typos).
  let marcaNorm = marcaRaw.toUpperCase().replace(/[.,/]/g, " ").replace(/\s+/g, " ").trim();
  marcaNorm = normalizeOrtopediaMarcaTypo(marcaNorm);

  const dictEntry = ORTOPEDIA_MARCA_DICT[marcaNorm];
  if (!dictEntry) {
    // Marca no reconocida (no esta en el diccionario armado sobre el
    // dataset original): se aproxima por descripcion, igual que "sin
    // marca". Si no matchea nada especifico cae en "Otros" (se descarta).
    const { categoria, segmento } = ortopediaCategoriaSinMarca(descripcionPosicion);
    return {
      marca: marcaRaw,
      modelo: modelo || textoSinParentesis,
      color: "S/D",
      segmento,
      categoriaSlug: ortopediaCategoriaSlug(categoria, segmento),
    };
  }

  let { categoria, segmento } = dictEntry;
  if (segmento === "(segun descripcion)") {
    segmento = ortopediaSegmentoMarchaPorDescripcion(descripcionPosicion);
  }

  const modeloFinal = modelo || textoSinParentesis;
  const categoriaSlug = ortopediaCategoriaSlug(categoria, segmento);

  // Sub-segmentacion de andadores (16/07/2026): refina el segmento generico
  // "Andadores y Ayudas de Marcha" en 3 subtipos (Fijo / 2 Ruedas / 4 Ruedas
  // Rollator) usando marca+codigo de modelo -- ver subSegmentoAndador.
  if (categoriaSlug === "andadores") {
    segmento = subSegmentoAndador(marcaNorm, modeloFinal);
  }

  return {
    marca: marcaRaw,
    modelo: modeloFinal,
    color: "S/D",
    segmento,
    categoriaSlug,
  };
}

// ============================================================
// SUB-SEGMENTACION DE ANDADORES (16/07/2026) -- refina el segmento
// generico "Andadores y Ayudas de Marcha" en 3 subtipos, usando marca +
// codigo de modelo (el texto de aduana en este NCM no trae descriptor de
// tipo, DESCRIPCION DE POSICION uniforme = "LOS DEMAS"). Fuente de las
// reglas: catalogos oficiales de fabricante (gdjianlian.com,
// intcowheelchair.com, medicalexpo.com, drivemedical.com, viomedica.com,
// dayangmedtech.com). La numeracion OEM china NO es uniforme entre
// fabricas (un mismo numero base aparece fijo o con ruedas segun sufijo);
// la senal mas confiable es el sufijo "LH" = rollator (4 ruedas + asiento).
//
// FLAGS (casos especiales, ver comentarios abajo):
//  - "GAIT TRAINER" (Dongguan Leyuan): entrenador de marcha
//    (pediatrico/rehab), clasificado tentativamente como Rollator.
//  - "HIP BRACE" (Jianwei): NO es un andador (es una ortesis de cadera) --
//    se excluye de la categoria "andadores" (categoriaSlug null) en vez de
//    dejarlo mal clasificado como "Andador Fijo".
// ============================================================

const ANDADOR_ROLLATOR_FAMILIAS = ["963", "965", "966", "969", "9142", "9188", "9181"];

// marca (ya normalizada: mayusculas, sin puntuacion) + patron sobre el
// modelo -> Rollator, para lineas/marcas especificas que son 100% rollator.
const ANDADOR_ROLLATOR_MARCA_MODELO: [string, RegExp][] = [
  ["VERMEIREN", /GOLIAT/],
  ["REBOTEC", /(PLUTO|FOX|FIXI)/],
  ["VOLARIS", /.*/], // Volaris = linea rollator completa
  ["INTCO", /SPIRIT\s*X[34]/],
  ["SUNRISE MEDICAL", /K6[24]0/],
  ["DRIVE MEDICAL", /(R800|GT1000|GT2000|GT3000|13023)/],
];

const ANDADOR_2RUEDAS_CODES = /(912L|914L|915L|917L|YK7210|\b5["”]?\s*$)/;
const ANDADOR_FIJO_CODES = /(913L|10200|10201|10224|10226|10244|9(18|19|22|26|33|36|39)\d*|\b894\b|\b799\b|\b738\b|\b736\b)/;

/**
 * @param marcaNorm Marca ya normalizada (mayusculas, sin puntuacion, con
 *   typos corregidos) -- NO el "marcaRaw" declarado, para que las
 *   comparaciones de marca sean consistentes.
 * @param modelo Modelo ya extraido (codigo de articulo, sin color/parentesis).
 */
function subSegmentoAndador(marcaNorm: string, modelo: string): string {
  const modeloUpper = (modelo || "").toUpperCase();

  // Exclusion: "HIP BRACE" no es un andador (ortesis de cadera, Jianwei) --
  // se marca para revisar en vez de contarlo como Andador Fijo.
  if (modeloUpper.includes("HIP BRACE")) {
    return "Andador Fijo (revisar - posible ortesis de cadera, no andador)";
  }

  // Prioridad 1: sufijo "LH" en el codigo (casters + asiento).
  if (/\bLH\b/.test(modeloUpper) || modeloUpper.endsWith("LH")) {
    return "Andador 4 Ruedas (Rollator)";
  }

  // Prioridad 2: familia de numero de modelo (rollator).
  if (ANDADOR_ROLLATOR_FAMILIAS.some((fam) => modeloUpper.includes(fam))) {
    return "Andador 4 Ruedas (Rollator)";
  }

  // Prioridad 3: marcas/lineas rollator conocidas.
  for (const [m, re] of ANDADOR_ROLLATOR_MARCA_MODELO) {
    if (marcaNorm === m && re.test(modeloUpper)) return "Andador 4 Ruedas (Rollator)";
  }

  // Prioridad 4: Intco YK7010/7030/7050 (4 ruedas) y YK7060 (3 ruedas, rollator).
  if (marcaNorm === "INTCO" && /YK70(10|30|50|60)/.test(modeloUpper)) {
    return "Andador 4 Ruedas (Rollator)";
  }

  // Prioridad 5: 2 ruedas (delanteras).
  if (ANDADOR_2RUEDAS_CODES.test(modeloUpper)) {
    return "Andador 2 Ruedas";
  }

  // Prioridad 6: fijo (reciprocante/plegable, sin ruedas).
  if (ANDADOR_FIJO_CODES.test(modeloUpper)) {
    return "Andador Fijo";
  }

  // Flag especial: "GAIT TRAINER" de Dongguan Leyuan -> tentativo Rollator.
  if (marcaNorm === "DONGGUAN LEYUAN" && modeloUpper.includes("GAIT TRAINER")) {
    return "Andador 4 Ruedas (Rollator)";
  }

  // Sin fuente confiable de tipo (default, marcado para revisar con catalogo).
  return "Andador Fijo (revisar)";
}
