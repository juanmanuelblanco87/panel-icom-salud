// api/talento-bulk-import-tmp.js
//
// TEMPORAL -- de una sola corrida, para cargar el listado de personal
// real que pasó el usuario (14/08/2026). Se borra apenas se confirme
// que quedó bien cargado (mismo criterio que talento-migrar-a-redis.js,
// que se borró por el mismo motivo: un script así, dejado en el repo,
// es un riesgo -- ya pasó que se disparó por error).
//
// GET ?accion=cargar&secret=... -- protegido con MAINTENANCE_SECRET
// (mismo patrón que talento-login.js seed-admin). Busca a "Mercedes
// Viqueria" por nombre (ya existe en el sistema) y la ACTUALIZA en vez
// de duplicarla; crea las otras 10 personas nuevas, todas con
// supervisorId apuntando a Mercedes y unidadNegocio "Ortopedia".
const { leerPersonas, guardarPersona } = require('./_talento-store');

function nuevoId(prefijo) {
  return prefijo + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Fecha de nacimiento: el usuario sólo dio día/mes, sin año -- confirmó
// usar 1980 como placeholder para las 11, a corregir después a mano.
const NUEVAS = [
  { nombre: 'Marisa Giammarino', fechaNacimiento: '1980-07-26', cuil: '27-20366214-4', fechaIngreso: '2007-06-01', funcion: 'Vendedora', lugarDeTrabajo: 'Icom Pro-Salud', email: 'vimamema567@outlook.es' },
  { nombre: 'Liliana Frias', fechaNacimiento: '1980-11-16', cuil: '27-23641615-7', fechaIngreso: '2009-02-28', funcion: 'Vendedora', lugarDeTrabajo: 'Icom Central', email: 'lilianafrias7@hotmail.com' },
  { nombre: 'Florencia Palizas', fechaNacimiento: '1980-10-08', cuil: '27-37018515-3', fechaIngreso: '2015-01-01', funcion: 'Vendedora', lugarDeTrabajo: 'Icom Central', email: 'fpalizas@gmail.com' },
  { nombre: 'Agustina Hirata', fechaNacimiento: '1980-12-18', cuil: '27-29248234-0', fechaIngreso: '2016-03-07', funcion: 'Encargada', lugarDeTrabajo: 'Icom Central', email: 'agustinacp18@gmail.com' },
  { nombre: 'Librada Salinas', fechaNacimiento: '1980-07-20', cuil: '27-25388814-3', fechaIngreso: '2017-07-03', funcion: 'Vendedora', lugarDeTrabajo: 'Josece', email: 'lilifsa20@gmail.com' },
  { nombre: 'Elizabet Vargas', fechaNacimiento: '1980-12-28', cuil: '27-29518285-2', fechaIngreso: '2021-07-01', funcion: 'Vendedora', lugarDeTrabajo: 'Icom Pro-Salud', email: 'elizv2882@gmail.com' },
  { nombre: 'Luz Segovia', fechaNacimiento: '1980-04-02', cuil: '27-43308149-3', fechaIngreso: '2022-01-01', funcion: 'Encargada', lugarDeTrabajo: 'Icom Pro-Salud', email: 'luzantonella14@gmail.com' },
  { nombre: 'Sofia Puente', fechaNacimiento: '1980-06-02', cuil: '27-40463678-8', fechaIngreso: '2022-04-04', funcion: 'Vendedora', lugarDeTrabajo: 'Icom Central', email: 'sofiapuente917@gmail.com' },
  { nombre: 'Fernando Guaraz', fechaNacimiento: '1980-04-21', cuil: '20-33031552-1', fechaIngreso: '2023-03-07', funcion: 'Vendedor', lugarDeTrabajo: 'Josece', email: 'ferguaraz@gmail.com' },
  { nombre: 'Patricia Picardi', fechaNacimiento: '1980-08-28', cuil: '27-27627082-1', fechaIngreso: '2024-05-17', funcion: 'Encargada', lugarDeTrabajo: 'Josece', email: 'patriciapicardi@hotmaill.com' },
];
const MERCEDES = { fechaNacimiento: '1980-03-25', cuil: '27-29368716-7', fechaIngreso: '2004-01-03', funcion: 'Supervisor', email: 'mercedes@icomsalud.com.ar' };

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'Usar GET.' }); return; }
  try {
    const url = new URL(req.url, 'https://' + req.headers.host);
    if (url.searchParams.get('accion') !== 'cargar') { res.status(400).json({ ok: false, error: 'Usar ?accion=cargar&secret=...' }); return; }
    const secret = url.searchParams.get('secret');
    if (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET) { res.status(403).json({ ok: false, error: 'secret inválido' }); return; }

    const personas = await leerPersonas();
    const mercedes = personas.find(p => p.nombre.trim().toLowerCase() === 'mercedes viqueria');
    if (!mercedes) { res.status(404).json({ ok: false, error: 'No se encontró a Mercedes Viqueria para actualizar.' }); return; }

    const mercedesActualizada = Object.assign({}, mercedes, MERCEDES);
    await guardarPersona(mercedesActualizada);

    const creadas = [];
    for (const n of NUEVAS) {
      const persona = {
        id: nuevoId('per'), nombre: n.nombre, unidadNegocio: 'Ortopedia', funcion: n.funcion,
        lugarDeTrabajo: n.lugarDeTrabajo, telefono: '', email: n.email, cuil: n.cuil,
        fechaNacimiento: n.fechaNacimiento, supervisorId: mercedes.id, fechaIngreso: n.fechaIngreso,
        estado: 'activo', potencialActual: null, boxActual: null,
      };
      await guardarPersona(persona);
      creadas.push({ id: persona.id, nombre: persona.nombre });
    }

    res.status(200).json({ ok: true, mercedesActualizada: { id: mercedesActualizada.id, nombre: mercedesActualizada.nombre }, creadas });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
