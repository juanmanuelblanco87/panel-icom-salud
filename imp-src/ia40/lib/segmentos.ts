/**
 * Lista de Segmentos validos por categoria (slug), usada en DOS lugares que
 * antes tenian cada uno su propia copia hardcodeada de los 6 segmentos de
 * "Sillas de ruedas" (SEGMENTO_CHOICES en app/page.tsx y VALID_SEGMENTOS en
 * app/api/model-overrides/route.ts) -- eso hacia que el boton "Corregir" NO
 * funcionara para ninguna de las otras 8 categorias (el <select> solo
 * mostraba los 6 segmentos de sillas de ruedas, y aunque se lograra mandar
 * un segmento de otra categoria, el backend lo rechazaba con "Segmento
 * invalido"). Bug encontrado el 17/07/2026 al intentar corregir un andador.
 *
 * Import unico compartido entre frontend y backend para que nunca mas se
 * desincronicen. Si se agrega/cambia un segmento en algun parser
 * (lib/parsers/index.ts), hay que reflejarlo aca tambien.
 */
export const SEGMENTOS_POR_CATEGORIA: Record<string, string[]> = {
  sillas_de_ruedas: [
    "Silla Estándar",
    "Silla Ultra Livianas",
    "Sillas Infantiles",
    "Silla Postural",
    "Silla Activa y Deportivas",
    "Silla de Traslado",
  ],
  sillas_ruedas_electricas: [
    "Silla Eléctrica Estándar",
    "Silla Eléctrica Pediátrica",
    "Silla Eléctrica de Bipedestación",
    "Silla Eléctrica Bariátrica",
    "Scooter de Movilidad",
    "Silla Eléctrica Plegable / Portátil",
  ],
  andadores: ["Andador Fijo", "Andador 2 Ruedas", "Andador 4 Ruedas (Rollator)"],
  bastones: ["Muletas y Bastones"],
  calzado_ortopedico: ["Calzado Ortopédico"],
  almohadones_ortopedicos: [
    "Almohada de Dormir",
    "Almohada Cervical / Viscoelástica",
    "Cojín Ortopédico / Antiescaras",
    "Ropa de Cama / Topper",
    "Cojín Decorativo / Hogar",
    "Almohada de Viaje / Camping",
    "Artículos para Mascotas",
    "Almohadón / Cojín Estándar",
  ],
  sillas_ducha: [
    "Reposeras / Playa y Camping",
    "Sillas de Comedor / Cocina",
    "Sillas de Oficina / Ergonómicas",
    "Banquetas y Taburetes",
    "Sillones y Butacas",
    "Sillas de Diseño / Decorativas",
    "Sillas de Ducha / Sanitarias",
    "Silla / Asiento Estándar",
  ],
  elevadores_inodoro: [
    "Tapa / Asiento de Inodoro Estándar",
    "Tapa Soft-Close / Descenso Lento",
    "Adaptador / Reductor Infantil",
    "Elevador / Asiento Sanitario Ortopédico",
    "Tapa Náutica / Portátil",
    "Repuestos / Accesorios",
  ],
  camas_hospitalarias: [
    "Cama Hospitalaria Eléctrica",
    "Cama Hospitalaria Manual / Mecánica",
    "Cama Hospitalaria (Tipo no especificado)",
    "Camilla / Estirador",
    "Cama Pediátrica / Neonatal",
    "Repuestos / Partes de Cama",
  ],
};

/** Segmentos validos para una categoria (o [] si el slug no esta en la tabla). */
export function segmentosValidos(categorySlug: string): string[] {
  return SEGMENTOS_POR_CATEGORIA[categorySlug] ?? [];
}
