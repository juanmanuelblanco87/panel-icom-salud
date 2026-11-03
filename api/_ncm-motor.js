// Motor de búsqueda de NCM sin IA: busca en la lista oficial (api/_ncm-datos.json, armada con imp-src/ncm/armar-datos.mjs)
// el código que mejor aplica a un nombre de producto. La lista oficial viene en portugués; se compara por raíces de palabra
// (silla/cadeira no se parecen, por eso PUENTE traduce los términos del rubro) y se pondera por rareza (tipo BM25).
const DATOS = require('./_ncm-datos.json');

// Impuestos por NCM (Arancel Integrado de ARCA). Vienen incluidos en _ncm-datos.json al momento del armado; si el cron diario bajó una versión más nueva
// (tabla ncm_tarifas_vivas), se usa esa: usarTarifas() la carga en memoria. Formato: [die, dieMax|null, dii, específicoMín, reintegroExtrazona] (alícuotas en %).
let TARIFAS_INCLUIDAS = null;
let TARIFAS_VIVAS = null; // { mapa: Map, fecha: 'DDMMAAAA' }
function usarTarifas(mapa, fecha) { TARIFAS_VIVAS = mapa ? { mapa, fecha } : null; }
const aDigitos = (n) => String(n || '').replace(/\D/g, '');
// -> { die, dieMax, dii, especifico, fuente } o null. die = derecho de importación extrazona (origen fuera del Mercosur); dii = origen Mercosur con certificado.
function tarifaDe(ncm) {
  const dig = aDigitos(ncm);
  let t = TARIFAS_VIVAS && TARIFAS_VIVAS.mapa.get(dig);
  let fuente = t ? 'ARCA ' + TARIFAS_VIVAS.fecha : null;
  if (!t) {
    if (!TARIFAS_INCLUIDAS) TARIFAS_INCLUIDAS = new Map(DATOS.codigos.map((c) => [c[0], c[2]]));
    t = TARIFAS_INCLUIDAS.get(dig);
    fuente = DATOS.fuenteImpuestos;
  }
  return t && t[0] != null ? { die: t[0], dieMax: t[1], dii: t[2], especifico: t[3], fuente } : null;
}

// español -> portugués, solo lo que no se resuelve por raíz común. Clave y valores en minúscula y sin tildes.
const PUENTE = {
  // Términos del arancel argentino: «sillones de ruedas», «inválidos», «tablillas», «fajas y vendajes medicoquirúrgicos», «audífonos».
  silla: ['sillon', 'sillones', 'cadeira', 'cadeiras'], sillas: ['sillones', 'cadeiras'], sillon: ['sillones', 'poltrona', 'cadeira'],
  discapacidad: ['invalidos', 'incapacidad'], discapacitado: ['invalidos', 'incapacidad'], movilidad: ['invalidos', 'incapacidad'],
  baston: ['bastones', 'bengala'], medicoquirurgico: ['medicoquirurgicos'], medico: ['medicoquirurgicos', 'medicina'], ferulas: ['ferulas', 'tablillas'],
  tablilla: ['tablillas'], vendajes: ['vendajes'], fajas: ['fajas'], ruedas: ['rodas'], rueda: ['rodas'],
  bastones: ['bastones'], muleta: ['muleta', 'muletas'], muletas: ['muletas'],
  andador: ['andadores', 'andador'], andadores: ['andadores'], colchon: ['colchao', 'colchoes'], colchones: ['colchoes'],
  antiescaras: ['antiescaras', 'escaras', 'ulceras'], escaras: ['escaras'], cama: ['camas', 'mecanismo', 'clinico', 'mobiliario'], camas: ['camas', 'mecanismo', 'clinico'],
  camilla: ['camillas', 'reconocimiento', 'mesas', 'mobiliario', 'clinico'], camillas: ['reconocimiento', 'mesas', 'mobiliario'], cuna: ['berco'], cojin: ['almofada', 'almofadas'], almohada: ['travesseiro'],
  almohadon: ['almofada'], tensiometro: ['esfigmomanometro', 'tensao', 'arterial'], presion: ['tensao', 'pressao'],
  arterial: ['arterial', 'arteriais'], termometro: ['termometro', 'termometros'], nebulizador: ['aerossol', 'aerossolterapia', 'nebulizadores'],
  nebulizadores: ['aerossol', 'aerossolterapia'], aerosol: ['aerossol', 'aerossolterapia'], oxigeno: ['oxigenio', 'oxigenoterapia'],
  concentrador: ['concentrador', 'oxigenoterapia'], respirador: ['respiradores', 'respiratorios'], ventilador: ['ventiladores', 'respiratorios'],
  jeringa: ['seringa', 'seringas'], jeringas: ['seringas'], aguja: ['agulha', 'agulhas'], agujas: ['agulhas'],
  guante: ['luvas'], guantes: ['luvas'], mascarilla: ['mascara', 'mascaras'], barbijo: ['mascara', 'mascaras'], tapabocas: ['mascaras'],
  panal: ['fralda', 'fraldas'], panales: ['fraldas'], apósito: ['curativo', 'penso'], aposito: ['curativos', 'pensos'], gasa: ['gaze', 'gazes'],
  venda: ['atadura', 'ataduras', 'faixa'], vendas: ['ataduras'], vendaje: ['atadura', 'ataduras'], ferula: ['tala', 'talas', 'goteira'],
  faja: ['cinta', 'cintas'], rodillera: ['joelheira', 'joelheiras', 'fajas', 'ortopedia'], tobillera: ['tornozeleira', 'tornozeleiras', 'fajas', 'ortopedia'], munequera: ['punho', 'munhequeira', 'fajas', 'ortopedia'],
  codera: ['cotoveleira', 'fajas', 'ortopedia'], corse: ['colete', 'corpete'], collar: ['ortopedia', 'fracturas'], cervical: ['ortopedia', 'fracturas', 'cervical'], audifono: ['audicao', 'surdos'],
  audifonos: ['audicao', 'surdos'], protesis: ['protese', 'proteses'], implante: ['implante', 'implantes'], mamario: ['mamario', 'mamarios'],
  cateter: ['cateter', 'cateteres'], sonda: ['sonda', 'sondas'], ostomia: ['ostomia'], bolsa: ['bolsa', 'bolsas'], bolsas: ['bolsas'],
  plantilla: ['palmilha', 'palmilhas'], plantillas: ['palmilhas'], calzado: ['calcado', 'calcados'], medias: ['meias'], compresion: ['compressao'],
  oximetro: ['oximetro', 'oximetros'], glucometro: ['glucemia', 'glucosa', 'instrumentos', 'aparatos', 'medicina'], glucosa: ['glicose'], tiras: ['tiras'], reactivas: ['reagentes'],
  estetoscopio: ['estetoscopios', 'instrumentos', 'aparatos', 'medicina'], oximetro: ['oximetro', 'oximetros', 'instrumentos', 'aparatos', 'medicina'], electrocardiografo: ['eletrocardiografos'], ecografo: ['ultrassonografia', 'ultrassom'], ultrasonido: ['ultrassom', 'ultrassonico'],
  rayos: ['raios'], desfibrilador: ['desfibriladores'], bisturi: ['bisturi'], pinza: ['pinca', 'pincas'], tijera: ['tesoura', 'tesouras'],
  sutura: ['sutura', 'suturas'], esterilizador: ['esterilizadores', 'esterilizacao'], esterilizacion: ['esterilizacao'], aspirador: ['aspiradores', 'aspiracao'],
  inodoro: ['sanitario', 'sanitarios', 'vaso'], banio: ['banho'], bano: ['banho'], ducha: ['chuveiro', 'ducha'], bano_: ['banho'],
  orinal: ['urinol', 'urinois', 'comadre'], baranda: ['grade', 'grades'], barra: ['barra', 'barras'], agarradera: ['barra', 'barras'],
  grua: ['elevacao', 'elevador'], elevador: ['elevacao', 'elevadores'], rampa: ['rampa'], lampara: ['lampada', 'luminaria'], lupa: ['lupa'],
  alquiler: [], repuesto: ['partes', 'acessorios'], repuestos: ['partes', 'acessorios'], accesorio: ['acessorios'], accesorios: ['acessorios'],
  cirugia: ['cirurgia', 'cirurgicos'], cirugico: ['cirurgico', 'cirurgicos'], descartable: ['descartavel', 'descartaveis'], quirurgico: ['cirurgico', 'cirurgicos'],
  hospitalaria: ['hospitalar', 'hospitalares'], hospitalario: ['hospitalar', 'hospitalares'], electrica: ['eletrica', 'eletricas'], electrico: ['eletrico', 'eletricos'],
  electronico: ['eletronico', 'eletronicos'], ortopedico: ['ortopedico', 'ortopedicos'], ortopedia: ['ortopedicos', 'ortopedicas'],
  articulada: ['articulada', 'articulados'], plegable: ['dobravel'], aluminio: ['aluminio'], acero: ['aco'], plastico: ['plastico', 'plasticos'],
  goma: ['borracha'], caucho: ['borracha'], algodon: ['algodao'], tela: ['tecido', 'tecidos'], tejido: ['tecido', 'tecidos'], vidrio: ['vidro'],
  madera: ['madeira'], hierro: ['ferro'], papel: ['papel'], silicona: ['silicone'], latex: ['latex'], nitrilo: ['nitrilo'], vinilo: ['vinil'],
  dental: ['dentario', 'dentarios', 'dentaria'], dientes: ['dentes'], diente: ['dentes'], ojo: ['olho', 'oculares'], lente: ['lentes'], lentes: ['lentes'],
  anteojos: ['oculos'], gafas: ['oculos'], hueso: ['osso', 'ossos'], tornillo: ['parafuso', 'parafusos'], placa: ['placa', 'placas'], clavo: ['prego', 'pregos'],
  insulina: ['insulina'], bomba: ['bomba', 'bombas'], infusion: ['infusao'], perfusion: ['infusao'], sangre: ['sangue'], suero: ['soro', 'soros'],
  masajeador: ['massagem', 'massageadores'], masaje: ['massagem'], calor: ['calor'], fisioterapia: ['fisioterapia', 'mecanoterapia'], gimnasia: ['ginastica'],
  pelota: ['bola', 'bolas'], banda: ['banda', 'faixa'], elastica: ['elastica', 'elasticas'], cinta: ['cinta', 'faixa'], bicicleta: ['bicicleta', 'bicicletas'],
  scooter: ['scooter', 'motorizados'], motor: ['motor'], bateria: ['bateria', 'baterias', 'acumuladores'], cargador: ['carregador'],
  incontinencia: ['incontinencia'], urinario: ['urinario', 'urinarios'], urinaria: ['urinaria'], sanitaria: ['sanitaria', 'higienicos'],
  toalla: ['toalha'], toallita: ['toalhas'], algodón: ['algodao'], jabon: ['sabao', 'sabonete'], crema: ['creme'], pomada: ['pomada'],
};
const VACIAS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'o', 'u', 'con', 'sin', 'para', 'por', 'en', 'un', 'una', 'al', 'a',
  'da', 'das', 'do', 'dos', 'em', 'ou', 'os', 'as', 'um', 'uma', 'com', 'sem', 'mesmo', 'outros', 'outras', 'outro', 'outra', 'tipo', 'se', 'nao', 'que', 'ex',
  'demas', 'incluso', 'incluso', 'incluida', 'incluidas', 'incluidos', 'excepto', 'partida', 'partidas']);

const sinTildes = (t) => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const palabras = (t) => sinTildes(t).split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !VACIAS.has(w));
// Palabras que describen el producto pero no deciden la posición arancelaria.
const MODIFICADORES = new Set(['digital', 'portatil', 'profesional', 'adulto', 'adultos', 'manual', 'nuevo', 'nueva', 'usado', 'usada', 'grande', 'chico', 'chica', 'mediano',
  'standard', 'estandar', 'universal', 'premium', 'basico', 'basica', 'tipo', 'marca', 'modelo']);
// Prioridad por capítulo (2 primeros dígitos): ICOM compra rubro médico/ortopédico. Lo que no está acá (alimentos, minerales, químicos...) pesa mucho menos.
const CAPITULOS = { 90: 1.5, 94: 1.3, 30: 1.3, 87: 1.25, 40: 1.15, 39: 1.1, 63: 1.1, 56: 1.1, 96: 1.15, 61: 1.05, 62: 1.05, 64: 1.0, 48: 1.0, 70: 1.0, 73: 1.0, 76: 1.0, 85: 1.0, 84: 1.0, 42: 0.6, 65: 0.9, 66: 1.1, 95: 0.85 };
const CAPITULO_OTRO = 0.7, CAPITULO_ALIMENTO = 0.4; // resto de capítulos / capítulos 01-24 (alimentos)
const PRIORIDAD = (cap) => CAPITULOS[cap] || (+cap <= 24 ? CAPITULO_ALIMENTO : CAPITULO_OTRO);

// Raíz: lleva la palabra a una forma común español/portugués (colchón/colchões, oxígeno/oxigênio, -ción/-ção), quita el plural y recorta a 6 letras.
const raiz = (w) => {
  if (/^\d+$/.test(w)) return w;
  let r = w.replace(/(ciones|coes)$/, 'cion').replace(/cao$/, 'cion').replace(/oes$/, 'on').replace(/ao$/, 'on').replace(/io$/, 'o');
  r = r.replace(/(es|s)$/, '');
  if (r.length < 3) r = w;
  return r.length > 6 ? r.slice(0, 6) : r;
};

// --- Índice (se arma una vez por instancia de la función) ---
let INDICE = null;
function indice() {
  if (INDICE) return INDICE;
  const N = DATOS.codigos.length;
  const docs = DATOS.codigos.map(([codigo, ids]) => {
    const partes = ids.map((i) => DATOS.textos[i]); // cada parte: [portugués, español ('' si no hay)]
    // La hoja y la subpartida pesan más; el título del capítulo (largo y genérico) pesa poco. Se indexan ambos idiomas.
    const pesos = new Map();
    partes.forEach(([pt, es], i) => {
      const peso = i === 0 ? 0.25 : i === partes.length - 1 ? 1.4 : i >= partes.length - 3 ? 1.1 : 0.7;
      for (const w of new Set([...palabras(pt), ...palabras(es)].map(raiz))) pesos.set(w, Math.max(pesos.get(w) || 0, peso));
    });
    // Para mostrar: español cuando existe, sin el título del capítulo.
    const camino = partes.slice(1).map(([pt, es]) => es || pt);
    // Posiciones de "partes y accesorios": solo deben ganar si el producto es un repuesto.
    const esParte = partes.slice(1).some(([pt, es]) => /^partes|partes y accesorios|partes e acessorios/.test(sinTildes(es || pt)));
    return { codigo, camino, pesos, largo: pesos.size, esParte };
  });
  const df = new Map();
  for (const d of docs) for (const w of d.pesos.keys()) df.set(w, (df.get(w) || 0) + 1);
  const idf = (w) => Math.log(1 + (N - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5));
  const lm = docs.reduce((a, d) => a + d.largo, 0) / N;
  INDICE = { docs, idf, lm, df };
  return INDICE;
}

// Palabras de la consulta -> [{ clave: raíz, w }]; las traducidas por el puente cuentan como la palabra original.
function terminosConsulta(texto) {
  const orig = palabras(texto).filter((w) => !MODIFICADORES.has(w));
  const grupos = orig.map((w) => {
    const alt = new Set([raiz(w)]);
    for (const p of PUENTE[w] || []) alt.add(raiz(p));
    return [...alt];
  });
  return grupos;
}

// Devuelve hasta `n` candidatos { ncm: '0000.00.00', puntaje, camino, confianza }, el mejor primero.
function buscarNcm(texto, n = 5) {
  const { docs, idf, lm } = indice();
  const grupos = terminosConsulta(texto);
  if (!grupos.length) return [];
  const pideParte = palabras(texto).some((w) => /^(parte|partes|repuesto|repuestos|accesorio|accesorios|pieza|piezas)$/.test(w));
  const k1 = 1.2, b = 0.5;
  const res = [];
  for (const d of docs) {
    let s = 0, cubiertos = 0;
    for (const g of grupos) {
      // De cada palabra se toma la mejor coincidencia entre su raíz y sus traducciones.
      let mejor = 0, suma = 0;
      for (const w of g) {
        const p = d.pesos.get(w);
        if (!p) continue;
        const tf = p * (k1 + 1) / (p + k1 * (1 - b + b * d.largo / lm));
        const v = tf * idf(w);
        suma += v;
        mejor = Math.max(mejor, v);
      }
      if (mejor > 0) cubiertos++;
      s += mejor + 0.35 * (suma - mejor);
    }
    if (s > 0) res.push({ d, s: s * (0.6 + 0.4 * cubiertos / grupos.length) * PRIORIDAD(d.codigo.slice(0, 2)) * (d.esParte && !pideParte ? 0.6 : 1) });
  }
  res.sort((a, c) => c.s - a.s);
  const top = res.slice(0, n);
  const max = top.length ? top[0].s : 0;
  return top.map((r, i) => ({
    ncm: `${r.d.codigo.slice(0, 4)}.${r.d.codigo.slice(4, 6)}.${r.d.codigo.slice(6)}`,
    tarifa: tarifaDe(r.d.codigo),
    puntaje: Math.round(r.s * 100) / 100,
    partida: r.d.camino[0] || '',
    detalle: r.d.camino.length > 1 ? r.d.camino[r.d.camino.length - 1] : '',
    // confianza: cuánto se despega el primero del segundo (si hay empate no se debe elegir solo).
    confianza: i === 0 ? (top[1] ? Math.round((1 - top[1].s / max) * 100) / 100 : 1) : undefined,
  }));
}

// Productos ya clasificados (lista [{ nombre, ncm }]) cuyo nombre se parece al texto buscado: lo que el usuario eligió antes vale más que cualquier búsqueda.
function similares(texto, lista, n = 3) {
  const q = new Set(palabras(texto).filter((w) => !MODIFICADORES.has(w)).map(raiz));
  if (!q.size) return [];
  const res = [];
  for (const it of lista || []) {
    const t = new Set(palabras(it.nombre).filter((w) => !MODIFICADORES.has(w)).map(raiz));
    if (!t.size || !it.ncm) continue;
    let comun = 0;
    for (const w of q) if (t.has(w)) comun++;
    const jaccard = comun / (q.size + t.size - comun);
    if (jaccard >= 0.5) res.push({ nombre: it.nombre, ncm: it.ncm, parecido: Math.round(jaccard * 100) / 100 });
  }
  return res.sort((a, b) => b.parecido - a.parecido).slice(0, n);
}

module.exports = { buscarNcm, similares, tarifaDe, usarTarifas, vigencia: DATOS.vigencia, ato: DATOS.ato };
