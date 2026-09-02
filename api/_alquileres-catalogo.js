// api/_alquileres-catalogo.js
//
// Alquileres -- catálogo combinado (estático + custom, menos
// eliminados) y generación de las 4 filas de período de un producto
// nuevo. Extraído a un módulo aparte porque lo necesitan 3 archivos
// (alquileres-data.js, alquileres-snapshot.js para LEER; alquileres-
// guardar.js para GENERAR al agregar un producto) -- ver el comentario
// grande junto a CATALOGO_CUSTOM_KEY en _alquileres-store.js para el
// criterio completo de "capa editable encima de un archivo estático".
const fs = require('fs');
const path = require('path');
const { leerAlquilerCatalogoCustom, leerAlquilerProductosEliminados } = require('./_alquileres-store');

const PERIODOS = ['dia', 'semana', 'quincena', 'mes'];
const PERIODO_DIAS = { dia: 1, semana: 7, quincena: 15, mes: 30 };
const PERIODO_PALABRA = { dia: 'Diario', semana: 'Semanal', quincena: 'Quincenal', mes: 'Mensual' };
const SUFIJO_SKU = { dia: '-01', semana: '-07', quincena: '-15', mes: '' };

function leerCatalogoEstatico() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'alquileres_catalogo.json'), 'utf8');
  return JSON.parse(raw);
}

// 01/09/2026 (mismo criterio que generar_catalogo_alquileres.py, el
// script que armó las 108 filas originales a partir de las 27 de
// antes del selector de Período): "Alquiler Mensual X" -> "Alquiler
// Quincenal X" reemplazando la palabra de período; si el nombre no
// trae ninguna reconocible, se inserta después de "Alquiler ".
const PALABRAS_PERIODO_EN_NOMBRE = { Diario: 'dia', Diaria: 'dia', Semanal: 'semana', Quincenal: 'quincena', Mensual: 'mes' };
function nombreParaPeriodo(nombreOriginal, periodoNuevo) {
  const palabraNueva = PERIODO_PALABRA[periodoNuevo];
  if (!nombreOriginal.startsWith('Alquiler ')) return `Alquiler ${palabraNueva} ${nombreOriginal}`;
  const resto = nombreOriginal.slice('Alquiler '.length);
  const primeraPalabra = resto.split(' ', 1)[0].replace(/[.,-]+$/, '');
  if (PALABRAS_PERIODO_EN_NOMBRE[primeraPalabra]) {
    const restoSinPeriodo = resto.includes(' ') ? resto.slice(resto.indexOf(' ') + 1) : '';
    return `Alquiler ${palabraNueva} ${restoSinPeriodo}`.trim();
  }
  return `Alquiler ${palabraNueva} ${resto}`;
}

function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'producto';
}

// 02/09/2026 ("deja la opción de sumar un nuevo producto de alquiler"):
// un producto nuevo SIEMPRE arranca canónico=Mensual -- "el precio que
// manda es el mensual" (01/09/2026) ya es la regla general del módulo,
// no tiene sentido pedirle a quien carga un producto nuevo que elija
// otra cosa. Genera las 4 filas (misma forma que el catálogo estático,
// ver data/alquileres_catalogo.json) -- Mensual con el sku real si se
// cargó uno, las otras 3 con skuSugerido (nomenclador: sku base = 30D,
// sufijos -01/-07/-15) hasta que Ortopedia dé de alta esos códigos en
// Oppen.
function generarFilasProductoNuevo(nombreBase, categoria, skuOppenMensual, idsExistentes) {
  let productoBaseId = slugify(nombreBase);
  if (idsExistentes.has(productoBaseId)) {
    let n = 2;
    while (idsExistentes.has(`${productoBaseId}_${n}`)) n++;
    productoBaseId = `${productoBaseId}_${n}`;
  }
  const skuBase = skuOppenMensual ? String(skuOppenMensual).trim() : null;
  return PERIODOS.map(periodo => {
    const esCanonica = periodo === 'mes';
    return {
      id: esCanonica ? productoBaseId : `${productoBaseId}_${periodo}`,
      productoBaseId,
      nombre: nombreParaPeriodo(`Alquiler Mensual ${nombreBase}`, periodo),
      categoria: categoria || 'Otros',
      periodo,
      periodoDias: PERIODO_DIAS[periodo],
      skuOppen: esCanonica ? skuBase : null,
      skuVerificado: false,
      precioReferenciaOriginal: null,
      skuSugerido: (!esCanonica && skuBase) ? `${skuBase}${SUFIJO_SKU[periodo]}` : null,
    };
  });
}

// Catálogo final que usan alquileres-data.js/alquileres-snapshot.js --
// estático + custom, sin las filas de productos marcados eliminados
// (por productoBaseId, ver marcarProductoEliminado).
async function leerCatalogoCompleto() {
  const [custom, eliminados] = await Promise.all([
    leerAlquilerCatalogoCustom(), leerAlquilerProductosEliminados(),
  ]);
  const estatico = leerCatalogoEstatico();
  const todas = estatico.concat(custom);
  return todas.filter(p => !eliminados.has(p.productoBaseId || p.id));
}

module.exports = {
  leerCatalogoEstatico, leerCatalogoCompleto,
  generarFilasProductoNuevo, slugify, nombreParaPeriodo,
  PERIODOS, PERIODO_DIAS,
};
