// Funciones sueltas que la pantalla importaba de otros módulos de ia40 (components/EvolutionChart.tsx y lib/importCalc.ts), copiadas sin cambios.
export function fmtNumber(n) {
  return Math.round(n).toLocaleString("es-AR", { maximumFractionDigits: 0 });
}
// Tamaño de envío (Mercado Envíos) según el CBM: < 0,05 chico; hasta 0,12 mediano; más, grande.
export function tamanoEnvioPorCbm(cbmM3) {
  if (cbmM3 < 0.05) return "chico";
  if (cbmM3 <= 0.12) return "mediano";
  return "grande";
}
