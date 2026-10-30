import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/meli-shipping-proxy
 *
 * Proxy de sólo lectura (11/09/2026, pedido de panel-icom-salud -- "El
 * costo de envio promedio no sirve, chequea en la app ia40 (calculo de
 * importaciones) que la api ahi trae el costo de envio estimado... por
 * categoria, reutilicemos eso cuando no tengamos el dato real en la
 * publicación") -- devuelve la tabla de costo de Mercado Envíos por
 * tamaño (chico/mediano/grande) que ya calcula/mantiene el módulo
 * "Cálculo de Importación" (ver calc_supuestos, lib/importCalc.ts) --
 * los mismos 3 valores que ya se usan en ese módulo como respaldo
 * cuando no hay una cotización EN VIVO por dimensiones reales
 * (`consultarCostosMeli`, que panel-icom-salud tampoco puede usar
 * todavía porque no tiene el ancho/alto/profundidad real de cada SKU
 * de Oppen -- este endpoint es la versión "ya tenemos esto calculado,
 * más fácil de reusar" en vez de duplicar ese cálculo del otro lado).
 *
 * Mismo criterio que /api/meli-price-proxy: secreto compartido simple
 * (MELI_PROXY_SECRET, MISMO valor ya configurado en panel-icom-salud
 * para ese otro proxy) -- confianza servidor-a-servidor entre 2
 * proyectos de la misma empresa, excluido del middleware.ts de login
 * (ver su matcher).
 *
 * 11/09/2026 (2da vuelta -- "Cuando el precio es menor a 33mil el costo
 * de envio lo paga el cliente generalmente"): se agrega
 * umbralBajoValorArs -- por debajo de ese PVP (con IVA), Mercado Envíos
 * NO es gratis-a-cargo-del-vendedor (lo paga el comprador), así que
 * panel-icom-salud no debe restarle ningún costo de envío al vendedor
 * para esos casos (ver envioPorTamanoAplica en lib/importCalc.ts, MISMA
 * regla que ya aplica este módulo). No se manda feeBajoTicketArs -- ese
 * es un fee ESTIMADO a mano acá que se superpondría con el fixed_fee
 * REAL que panel-icom-salud ya trae directo de la API de MeLi
 * (`/sites/MLA/listing_prices`) para publicaciones de precio bajo.
 *
 * Respuesta: { ok:true, envioChicoArs, envioMedianoArs, envioGrandeArs,
 *   umbralBajoValorArs, nota: "CON IVA -- ver lib/importCalc.ts sobre
 *   cómo se usan" }
 */
export async function GET(req: Request) {
  const expected = process.env.MELI_PROXY_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "Falta MELI_PROXY_SECRET en las variables de entorno de Vercel de este proyecto." },
      { status: 500 }
    );
  }
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }

  try {
    await query(`insert into calc_supuestos (id) values (1) on conflict (id) do nothing`);
    const rows = await query<any>(`select envio_chico_ars, envio_mediano_ars, envio_grande_ars, umbral_bajo_valor_ars from calc_supuestos where id=1`);
    const row = rows[0];
    if (!row) {
      return NextResponse.json({ ok: false, error: "No hay fila de calc_supuestos todavía." }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      envioChicoArs: Number(row.envio_chico_ars),
      envioMedianoArs: Number(row.envio_mediano_ars),
      envioGrandeArs: Number(row.envio_grande_ars),
      umbralBajoValorArs: Number(row.umbral_bajo_valor_ars),
      nota: "Valores CON IVA -- cargados/editados a mano en el módulo Cálculo de Importación (Supuestos).",
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}
