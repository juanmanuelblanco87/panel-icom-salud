// Reemplazo mínimo de next/server para las rutas de ia40: solo se usa NextResponse.json (respuesta web estándar).
export const NextResponse = {
  json(cuerpo, init) { return Response.json(cuerpo, init); },
};
