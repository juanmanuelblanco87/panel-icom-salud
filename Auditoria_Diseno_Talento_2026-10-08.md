# Auditoría de diseño — Gestión de Talento (sw v97, 8/10/2026)

Hecha con el agente de diseño sobre la app renderizada en escritorio (1280), tablet (768) y celular (375), con datos de prueba y perfil admin.

## Resumen
1. **Celular roto en los formularios**: los campos quedan de 63 a 94 px y las fechas se cortan. Competencias además tiene scroll horizontal de 122 px.
2. **Accesibilidad del selector de personas**: no se puede usar con teclado y hay 23 campos sin etiqueta.
3. **Contraste y consistencia**: el gris `--muted #999` da 2,85:1 (se pide 4,5:1) en ~125 textos; estados vacíos, badges y fechas se resuelven distinto según la pestaña.

## Hallazgos (S = esfuerzo chico, M = medio)

| # | Sev. | Dónde | Problema | Corrección | Esf. |
|---|---|---|---|---|---|
| 1 | Alta | Celular › todos los formularios (`.form-row`) | Campos de 63–94 px; fechas cortadas ("dd/r"); selects con "Milag" | `.form-row` en columna en ≤640px y campos al 100% | S |
| 2 | Alta | Celular › Competencias, tooltip ⓘ | Empuja el ancho a 497 px: scroll horizontal fantasma de 122 px | Tooltip en flujo (bloque bajo la pregunta) en celular | S |
| 3 | Alta | Selector de personas (4 pestañas) | Items son `div` con click: sin teclado ni lector de pantalla | Items como botones con rol de lista; input tipo combobox con ↑↓ y Enter | M |
| 4 | Alta | Vacaciones › orden vertical | El detalle de la persona queda debajo de la vista general: al elegir a alguien "no pasa nada" en celular | Scroll automático al detalle y/o vista general colapsable | S/M |
| 5 | Alta | Celular › Matriz de Talento | 3 columnas fijas: con nombres largos o muchas personas queda inusable | 1 columna o acordeón por cuadrante con contador; tope de alto en escritorio | M |
| 6 | Alta | Celular › Competencias, opciones A/B/C/D | Radios de 13 px y filas de 17 px (68 controles) | Filas de 40 px, radio de 20 px, fila elegida resaltada | S |
| 7 | Alta | Tokens globales | `--muted #999` 2,85:1; `--faint #ccc` 1,48:1; avatares con letra blanca sobre amarillo 2,17:1 | `--muted #6b6b6b`, `--faint #8a8a8a`, avatares más oscuros (vía `design/tokens.css` + `sync_design_tokens.py`) | S |
| 8 | Media | Celular › estados vacíos en tablas | Se ven como tarjeta dentro de tarjeta, con texto a la derecha | Quitar borde/padding de esa fila y centrar | S |
| 9 | Media | Personas y Reportes (`.obj-select-row`) | Sin wrap: a 768 px un filtro se sale de la tarjeta | `flex-wrap` y columna en celular | S |
| 10 | Media | Celular › Personas | Tabla de 12 columnas (880 px en 306): Editar/Borrar al final del scroll | Formato tarjeta con nombre, función, estado y acciones | M |
| 11 | Media | Estados vacíos sueltos (Personas, Organigrama, Celebraciones, Muro, Competencias, Vacaciones, Novedades) | Texto gris suelto o tabla con encabezados vacíos; en Objetivos aparecen 2 barras y 2 leyendas vacías | Usar `.vacio` en todos; ocultar barras sin objetivos | S |
| 12 | Media | Badges de estado | "Pendiente" azul en Vacaciones y naranja en Objetivos; "Rechazada" gris | `.badge.ok/.warn/.danger/.neutral` y un único mapeo de estados | S/M |
| 13 | Media | Vacaciones › tablas de solicitudes | Fechas en formato 2026-11-02 (el resto usa 13/10/2026); falta modo tarjeta en celular | `formatearFechaCorta` + `data-label` | S |
| 14 | Media | Celular › inicio de Objetivos/Competencias | ~560 px de andamiaje antes del primer objetivo; "1/8 con objetivos" aparece 2 veces; stepper de año 336×51 vs 131×38 en Vacaciones | Quitar el texto duplicado; mismo stepper compacto en la barra de las 4 pestañas | M |
| 15 | Media | Celular › navegación | Al volver a una pestaña (p. ej. desde "Ver todo") la pestaña activa queda fuera de pantalla | `scrollIntoView` del botón activo | S |
| 16 | Media | Global | 23 campos sin etiqueta (buscadores, año, comentario de resolución, muro, chat) | `aria-label` en cada uno; globitos con texto accesible | S |
| 17 | Media | Chat flotante | Launcher no enfocable; buscador y textarea con estilo nativo; "No hay nadie que coincida" aparece sin búsqueda | Botón real con `aria-label`, estilos de formulario, diálogo con rol, distinguir "sin contactos" de "sin resultados" | S |
| 18 | Media | Organigrama | Nodos sin teclado; botones +/− de 20 px tapan el avatar; párrafo de ayuda de 5 líneas | Rol y foco en nodos, áreas táctiles de 36 px, ayuda colapsable, filtros en una fila | M |
| 19 | Media | Celular › campos de 13–14 px | iOS hace zoom al enfocar | `font-size:16px` en inputs en celular | S |
| 20 | Media | Celular › Muro, "Tu equipo" | Lo accionable (pendientes de aprobar) queda debajo del feed | Subirlo arriba del feed en celular | S |
| 21 | Media | Reportes › Altas y bajas | Arranca vacío ("Elegí un mes"); el botón Exportar cambia de lugar entre tarjetas | Mes actual por defecto; `.card-head` con Exportar siempre a la derecha | S |
| 22 | Media | Novedades › Historial | El filtro de motivo no incluye "Ausencia injustificada" ni "con permiso" | Completar opciones (idealmente desde una sola lista) | S |
| 23 | Media | Celular › botones aún chicos | Editar/Borrar de objetivos 26 px, ✕ de la persona 24 px, checks de Reportes 16 px, carrusel 32 px | `min-height/min-width:36px` | S |
| 24 | Baja | Escritorio | El botón flotante del chat tapa la esquina de la última tarjeta | Padding inferior en todas las pantallas | S |
| 25 | Baja | Escritorio › menú lateral | El fondo blanco termina a mitad de pantalla | Fondo y borde en el contenedor completo | S |
| 26 | Baja | Subir archivos | Inputs de archivo ocultos: no se alcanzan con teclado | Ocultarlos de forma accesible + foco visible en la etiqueta | S |
| 27 | Baja | Selector de personas › foco | El contorno de foco es casi blanco | `outline` con `--accent` | S |
| 28 | Baja | Pestañas › ARIA | Roles de pestaña sin navegación con flechas | Navegación con ←/→/Home/End o usar `nav` | S |
| 29 | Baja | Competencias | 10 de 17 preguntas muestran la explicación pegada al título, las otras usan ⓘ; sin progreso ni botón fijo | Mismo patrón ⓘ; agrupar con `fieldset`; barra fija "7/17 · Guardar" en celular | M |
| 30 | Baja | Celebraciones | La lista se repite 3 veces; tres cifras que confunden; 12 meses con "Sin cumpleaños"; "Hoy" rojo y "En 2 días" verde | Quitar la lista lateral o el carrusel; mostrar solo meses con eventos; badges neutros | M |
| 31 | Baja | Carga/errores | Si falla la carga, texto rojo sin "Reintentar"; el chat bloquea el render | Botón Reintentar; no esperar al chat | S |
| 32 | Baja | Textos | 16 " -- " en vez de "—"; "Agregar persona" con botón "Sumar Talento"; "modelo CLC + O*NET…" es jerga; subtítulo "Personal y objetivos" desactualizado; "Cargado el —" | Barrido de textos | S |
| 33 | Baja | Estructura | Sin `h1/h2`; Matriz sin título de tarjeta | `h1` en el encabezado, títulos por pestaña | S |

## Qué ya está bien
Barra año+persona estable, calendario con semáforo accesible, modales con foco y Escape, avisos con `aria-live`, targets de 36 px en reacciones/filtros/año/pestañas internas, solicitudes pendientes arriba con "✓ No hay solicitudes pendientes", voseo consistente.

## Orden sugerido
1. Parche CSS de celular (hallazgos 1, 6, 8, 9, 19, 23, 24, 25).
2. Tokens de contraste (7), con revisión visual de las otras 8 pantallas.
3. Tooltip ⓘ y formato de las 17 preguntas (2, 29).
4. Un barrido de JS: estados vacíos, badges, fechas, textos (11, 12, 13, 32).
5. Accesibilidad: selector, etiquetas, chat, pestañas, foco, archivos, organigrama (3, 16, 17, 15, 28, 27, 26, 18).
6. Estructura: orden de Vacaciones, arranque de Objetivos/Competencias, Matriz y Personas en celular, Muro (4, 14, 5, 10, 20).
7. Pulido: 21, 22, 30, 31, 33.

## No se pudo verificar
Vistas de colaborador, supervisor y gerente; volúmenes reales (~100 personas); chat con datos; foco con teclado real y lector de pantalla; dispositivo físico (zoom en iOS, teclado virtual).

## Preguntas de producto
- ¿La contraseña de "Acceso al sistema" se muestra en claro a propósito (el admin la comunica)? Si sí, sumar botón mostrar/ocultar; si no, ocultarla.
- ¿Se puede sacar el bloque lateral "Próximos Cumpleaños" de Celebraciones?
- ¿"Pendiente" es advertencia (naranja) o estado neutro (azul)?
