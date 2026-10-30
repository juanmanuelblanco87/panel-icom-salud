// Juan Manuel, 05/08/2026 (análisis de performance -- "tarda demasiado en
// abrir las apps incluso en información que debería estar pre-cargada"):
// antes este service worker era un passthrough puro (sin cachear NADA),
// a propósito -- "cachear el HTML principal podría mostrar una versión
// vieja de la app". Eso confundía 2 cosas distintas:
//   - el CÓDIGO del shell (icom_panel_unificado.html, ~5MB, cambia sólo
//     cuando se pushea un cambio) -- esto es lo que ahora se cachea.
//   - los DATOS en vivo (ventas/stock, pedidos a /api/*) -- esto sigue
//     yendo 100% a la red, sin tocar, exactamente igual que antes.
// Con esa separación, cachear el shell no puede mostrar una venta vieja
// como si fuera actual: los números siempre vienen de /api/* fresco.
//
// Estrategia para el shell (stale-while-revalidate): la respuesta cacheada
// se sirve DE INMEDIATO si existe (carga instantánea en visitas repetidas,
// en vez de re-bajar ~1.2MB comprimidos cada vez), y en paralelo se pide
// la versión fresca a la red para dejarla lista en caché para la
// PRÓXIMA visita -- self-corrige solo en 1 visita de atraso como máximo,
// sin necesidad de acordarse de pisar a mano ningún número de versión acá.
// Si algún día hace falta un purgado duro (cambiar qué se cachea), alcanza
// con cambiar CACHE_NAME para que activate() tire la caché vieja entera.

// 26/08/2026 ("me sigue pidiendo el login viejo en mobile, hay forma de
// forzar los caches para todos los que tienen 'descargada' la app?"):
// bump manual del nombre de caché -- activate() de abajo borra cualquier
// caché con un nombre distinto al actual, así que este cambio solo
// alcanza para que TODAS las instalaciones existentes (PWA en el
// celular) purguen el shell viejo apenas el navegador detecte este
// archivo actualizado y lo active. Repetir este bump cada vez que haga
// falta un refresco forzado (además del auto-refresco normal, que ya
// pasa solo con 1 visita de atraso como mucho).
// 26/08/2026 (2do bump, "toco Movilidad y me abre inmediatamente Ventas
// en Vivo" -- el fix de sidebar YA estaba en icom_panel_unificado.html
// en ese momento): los 2 commits siguientes al primer bump (torta con
// espacio gris, sidebar que expande en vez de saltar directo) quedaron
// atrás de la caché v2 ya instalada -- stale-while-revalidate sirve lo
// viejo de inmediato y sólo actualiza en 2do plano para la PRÓXIMA
// visita, así que cualquiera que ya tuviera v2 instalada seguía viendo
// código de ANTES de esos 2 commits. Mismo bump de siempre.
// 22/09/2026 ("si vuelvo a apretar F5 tarda otra vez lo mismo"): bump manual --
// 2do bump, mismo día ("no lo veo deployado" -- año anterior/IPC en el gráfico de
// línea no aparecía pese a estar confirmado en el servidor con curl): entre el
// bump anterior (v5) y este hubo varios deploys más seguidos (arreglo del pane sin
// scroll, venta 30d real vía buffer diario, año anterior + IPC) -- con
// stale-while-revalidate el navegador vuelve a quedar "1 visita atrás" de un
// blanco en movimiento. Mismo mecanismo de siempre: bump manual para forzar la
// purga en cualquier instalación (incluida la PWA de escritorio).
// 3er bump, mismo día ("La página no responde" -- bug crítico de loop infinito en el
// gráfico de línea/año anterior, arreglado y confirmado en un navegador real antes de
// este deploy). Purga forzada de nuevo, mismo mecanismo de siempre.
// 4to bump, mismo día: números con fondo + tooltip enriquecido (vs año anterior/IPC) en
// el gráfico de línea, y un 2do bug real encontrado y arreglado en pruebas de navegador
// (la línea de año anterior quedaba CALCULADA pero nunca se pintaba sola la primera vez).
// 5to bump, mismo día: reordenados "Venta estimada"/"DOH y AR$ en Stock" arriba de todo
// en los Dashboards de unidad, + % vs año pasado (nominal y con IPC) en la proyección de
// cierre. Probado en navegador antes de subir (sin loop, cálculo correcto).
// 6to bump, mismo día: tooltip del gráfico de línea corregido (comparaba el acumulado
// PARCIAL del mes en curso contra un año anterior completo -- ahora usa la proyección) +
// gráfico simplificado (se saca la línea de año anterior nominal, sólo queda año anterior
// + IPC, recoloreada a violeta para no competir visualmente con la tendencia).
// 7mo bump, mismo día: "Venta estimada de cierre de mes" pasa de una frase suelta a 4
// bloques uniformes (Acumulado/Proyección/vs Año Pasado/vs Año Pasado + IPC), cada % en
// grande con su valor de referencia chico abajo.
// 8vo bump, mismo día: 2 arreglos -- (1) "no veo los cambios en cirugía/cirugía
// estética/movilidad" -- año anterior pasa de 48 pedidos completos (uno por unidad) a 12
// livianos COMPARTIDOS entre las 4 unidades + ICOM (mismo campo byUnidadNegocio que ya
// usaba sólo ICOM); (2) la comparación vs año anterior se movió del punto del acumulado
// PARCIAL al punto de la PROYECCIÓN (dónde corresponde -- mes completo contra mes completo).
// 9no bump, mismo día: se agrega el IPC acumulado del período como dato visible (chico,
// debajo del % real) -- la fórmula ya estaba bien (verificado con números reales), la
// confusión era que "vs Año Pasado + IPC" muestra crecimiento REAL, no el IPC en sí.
// 10mo bump, mismo día: nuevo cuadro "Acumulado del año — evolución" (suma corrida desde
// enero, este año vs año anterior + IPC) debajo del gráfico de línea mensual, en todos los
// Dashboards de unidad y en ICOM. Probado en navegador antes de subir (sin loops, cálculo
// verificado a mano).
// 11vo bump, mismo día: se retira el gráfico de área "Acumulado del año" (pedido explícito)
// y se reemplaza por una tarjeta con el mismo look que "Venta estimada de cierre de mes" --
// clickeando un mes en el gráfico de línea de arriba (se sombrea, aparece un recuadro) esa
// tarjeta pasa a mostrar el detalle de ESE mes en vez del acumulado del año; click de nuevo
// vuelve al acumulado. Probado en navegador con clicks reales (no sólo llamadas a función)
// antes de subir -- sin loops, toggle ida/vuelta confirmado, matemática verificada.
// 12vo bump, mismo día: "funciona pero no me deja clickear los meses" -- el rect clickeable
// no llegaba hasta la fila del nombre del mes (donde la gente clickea primero); ahora cubre
// toda la columna Y el propio texto del mes también dispara el toggle. Probado con clicks
// reales sobre el <text>, no sólo sobre el rect.
// 13vo bump, mismo día: "el acumulado es hasta el mes en curso y proyectado DEL MES EN
// CURSO, no año cerrado proyectado" -- la tarjeta comparaba una extrapolación a 12 meses
// completos contra el año pasado completo; ahora compara "lo que llevamos, con el mes en
// curso ya estimado" contra el año pasado A LA MISMA ALTURA (mismos meses de los 2 lados).
// 14vo bump, mismo día: Stocks -- "achica las descripciones: DOH Units / DOH Ar$ / % STOCK
// Inmo." -- los 3 labels del KPI se acortan (dejan de repetir "(meses)"/"($$)"), y el
// sub-texto del cuadro "% Stock Inmo." pasa de "$X de $Y · N SKUs · tocá para filtrar" a
// sólo "$X" -- el resto (base de comparación, cantidad de SKUs, estado del filtro) se movía
// al title="" del cuadro (tooltip), no se pierde info.
// 15vo bump, mismo día ("vamos a traernos los datos de Oppen para reconstruir este P&L...
// arma el endpoint de producción y colocalo en el dashboard por unidad de negocios"): nueva
// tarjeta "Gastos del Período" en los Dashboards de unidad (Minorista/Movilidad/Cirugía
// Estética/Cirugía General) -- P&L de gastos (directos + indirectos asignados por % de
// venta) reconstruido en vivo desde Oppen (ver dashRenderGastos/api/_pnl-gastos-core.js),
// validado centavo a centavo contra el Excel real de julio 2026 en las 4 unidades.
// 16vo bump, mismo día ("Necesito el P&L abajo de este gráfico" -- el de Evolución mensual
// línea y tendencia): la tarjeta "Gastos del Período" se mueve de su posición original
// (justo después de DOH y Stock) a después del gráfico de línea y tendencia, según pedido.
// 17vo bump, mismo día ("ese no es el formato... el formato aperturado mes a mes" + "con
// desplegables en gastos/impuestos/indirectos"): la tarjeta pasa de 4 bloques resumidos +
// detalle ordenado por monto, a una tabla con el MISMO orden de renglones que el Excel real
// ('EERR resumido'), agrupada en 3 secciones desplegables (Impuestos/Gastos Directos/Gastos
// Indirectos).
// 18vo bump, mismo día ("Construir también el CMV desde Oppen" -- Ventas facturadas/CMV/
// Utilidad bruta arriba, Utilidad Neta % al final): CMV = costo real por línea de venta
// (Invoice.OperativeCost, ya usado como costoUnit en Stocks/Seguimiento) -- NO es el CMV
// contable del cierre (ese no tiene etiqueta de unidad en el libro mayor, validado: 445,97M
// de 446M caen en "Sin Etiqueta"). 2 bugs de datos reales encontrados y corregidos en el
// camino (api/oppen-invoices.js, byUnidadNegocio.totalCosto): algunas líneas de Cirugía
// Estética (implantes Mentor) traían OperativeCost disparatado -- hasta 524x el precio de
// venta, y separado, líneas con venta $0 (regalos/muestras) con el mismo tipo de costo
// corrupto ($18M+) -- ambos casos, dato malo del lado de Oppen, ahora se excluyen del CMV
// agregado con una guardia de sanidad (relativa + tope absoluto).
// 19vo bump, mismo día ("quiero ver desde enero, febrero, etc a dic. como tabla... todos
// los meses juntos" + "achica los montos a 245.6M y agrega el dato % en cada bucket"): la
// tarjeta pasa de mostrar 1 mes a una tabla horizontal, 1 columna por mes (Ene-Dic del año
// en curso), montos compactos ("245.6M") con el % sobre Ventas facturadas debajo de cada
// uno. Blob de Gastos ahora es 1 por mes (api/actualizar-pnl-gastos.js) -- se hizo el
// backfill de los 9 meses cerrados/en curso de 2026 (enero a septiembre).
// 20vo bump, mismo día ("no coinciden los formatos de los meses... debe parecer una gran
// tabla" + "Total Gasto (impuestos+directos+indirectos) -> Total Gasto" + "Gastos de
// Comercialización -> sólo Viáticos/Alquileres/Comisiones/etc"): las 5 tablas separadas
// (una por sección) se unen en UNA sola <table> -- por eso antes las columnas de mes
// quedaban desfasadas entre secciones (cada <table> autoajustaba su propio ancho). Las
// secciones colapsables pasan de <details> a filas con onclick (no se puede envolver <tr>
// sueltas en <details>).
// 21vo bump, mismo día ("algunas líneas están desalineadas ordenalo" + "cuando colapso la
// vista, debería ver los totales con sus %" + "agrega Utilidad antes GI"): 1) toLocaleString
// sin minimumFractionDigits dejaba caer el ",0" en valores redondos (15% en vez de 15,0%),
// mezclado con vecinos "15,9%" se veía como si la columna no alineara -- ahora siempre 1
// decimal. 2) el total/subtotal de cada sección ya no se oculta al colapsar (sólo el
// detalle línea por línea). 3) nueva fila "Utilidad antes GI" = Utilidad bruta - Subtotal
// Impuestos - Total Gastos Directos (antes de repartir los indirectos).
// 22vo bump, mismo día ("ordená las columnas de meses similar al cuadro de evolución de
// arriba" + "por default trae impuestos, gastos directos e indirectos colapsados"): las 3
// secciones arrancan cerradas (antes Impuestos/Directos abrían solas); el mes EN CURSO se
// destaca en negrita/azul en el encabezado, mismo criterio visual que el eje de "Evolución
// mensual — línea y tendencia" arriba.
// 23vo bump, mismo día ("distribuye mejor las columnas de meses, aprovecha todo el ancho"):
// la tabla tenía sólo min-width (se achicaba a lo que necesitaban sus celdas angostas,
// quedaba pegada a la izquierda con espacio vacío a la derecha de la tarjeta) -- ahora
// width:100% también, así estira las columnas para usar todo el ancho disponible.
// 24vo bump, mismo día ("los últimos 3 meses están apretados al final, no se respeta el
// ancho correcto" + "simétrico"): width:100% con table-layout:auto (por defecto) seguía
// ajustando cada columna a SU PROPIO contenido -- las columnas vacías (Oct/Nov/Dic, sólo
// "—") pedían menos ancho que las que tienen "245.6M/100,0%". Se agrega <colgroup> +
// table-layout:fixed para forzar las 12 columnas de mes a ser TODAS del mismo ancho
// (confirmado en navegador: 101px cada una, sin importar el contenido).
// 25vo bump, mismo día ("probá lo mismo en las otras 3 unidades y suma el P&L general en
// Icom"): nueva tarjeta "Gastos del Período — Total ICOM" en la vista agregada (ver
// erpRenderIcomGastos/pnlSumarUnidades) -- suma las 4 unidades del shell mes a mes ($ suma
// línea a línea, los % se RECALCULAN sobre los $ ya sumados). Validado en navegador: la
// suma de las 4 unidades por separado da EXACTO el mismo total que la vista agregada.
// 26vo bump, mismo día ("agrega un selector de canales arriba en el dash de Ortopedia
// (mercado libre, ecommerce, JCP, Icom Central y Pro-Salud)... que filtre todo el
// dashboard"): selector de canal exclusivo de Minorista -- filtra Venta estimada, gráficos
// (barras/línea/tortas/Acumulado del Año) y Gastos del Período (nuevo campo porSubcanal en
// api/_pnl-gastos-core.js, backfill de los 9 meses de 2026 ya hecho). DOH y AR$ en Stock NO
// se puede desglosar por canal (stock físico compartido entre canales) -- avisa en vez de
// inventar un número. Validado con tests aislados: filtro de dashMonthlyData, pills,
// cascada de renders y el switch porUnidad<->porSubcanal en Gastos, todo con datos reales.
// 27vo bump, mismo día ("este titulo esta mal coloca P&L"): "Gastos del Período" -> "P&L"
// en las 2 tarjetas (por unidad e ICOM) -- ya no es sólo Gastos, tiene Ventas/CMV/Utilidad.
// 28vo bump, mismo día ("agosto y septiembre faltan cargar datos... pintarlos de otro color
// y estimar... el mes en curso hay que colocarle la venta proyectada y cmv proyectado
// también"): mes en curso -- Ventas/CMV/Utilidad bruta se proyectan con el mismo criterio
// que "Venta estimada de cierre de mes" (dashProyeccionMes); cualquier mes -- los 3 totales
// de sección (Subtotal Impuestos/Gastos Directos/Gastos Indirectos) se comparan contra la
// MEDIANA histórica de su % sobre Ventas y se completan si Oppen todavía no cargó el dato
// real (ver pnlAplicarEstimaciones). Todo lo estimado se pinta ámbar con "~" adelante y un
// tooltip -- validado en navegador con datos reales: septiembre queda totalmente proyectado,
// agosto sólo corrige su total de indirectos (el resto ya estaba completo).
// 29vo bump, mismo día ("re-chequea el estimado no están ok la utilidad neta se dispara en
// agosto Los gastos directos son demasiado bajos"): bug real -- el umbral (<40% de la
// mediana) no alcanzaba a agosto en Gastos Directos (12,23% real vs mediana 21,8%, 56% de
// la mediana), así que quedaba sin corregir mientras Indirectos sí se corregía -- Utilidad
// neta quedaba inflada a medias ($506M/33,7%, fuera de rango vs meses vecinos). Umbral
// subido a 60% de la mediana -- validado contra los 9 meses reales de 2026: agosto ahora se
// corrige ($328M/21,8%, Utilidad neta baja a $362M/24,1%) y ningún mes con una baja normal
// (ej. enero, 80% de la mediana) queda mal marcado.
// 30vo bump, mismo día ("chequealo con los otros 3 [unidades] también, veo la utilidad neta
// muy elevada en tu estimado"): el 60% (calibrado con el AGREGADO de ICOM) dejaba pasar un
// caso -- Minorista en agosto, revisado unidad por unidad (cada una calcula su propia
// mediana), quedaba justo arriba del corte (25,71% real vs mediana 40,49% => 63,5%) y su
// Utilidad neta salía +12,4% mientras el resto de sus meses son negativos o cerca de cero.
// Subido a 65% -- validado contra las 4 unidades × 9 meses × 3 rubros: Minorista agosto
// ahora se corrige (Utilidad neta -2,4%, coherente con la serie) sin generar ningún falso
// positivo nuevo (ej. Movilidad, con Gastos Directos naturalmente volátiles entre 18% y
// 56% según el mes, sigue sin marcarse en ningún mes real).
// 31vo bump, 23/09/2026 ("Agrega GM% en todos los cuadros de ventas en vivo" + "cuando
// expando los elementos colapsados... los buckets que tuviste que estimar se pinten de
// naranja con un !"): columna GM% (margen bruto, costoUnit×u vs Total Neto) en las 7 tablas
// de Ventas en Vivo (SKU/Macro/Marca/Proveedor/Subgrupo/Cliente/Tipo de Operación) + marcador
// "!" ámbar (con tooltip) en las líneas individuales del P&L cuyo TOTAL de sección se tuvo
// que estimar ese mes.
// 32vo bump, mismo día ("cuando le doy click para expandir los colapsados no me lo expande...
// recién quizás después de varios intentos"): pnlToggleSeccion (click en el encabezado de
// Impuestos/Directos/Indirectos) llamaba SIEMPRE a dashRenderGastos() -- en la vista ICOM esa
// función repinta el contenedor equivocado (#dashGastos, no #erpIcomGastos), así que el click
// togglaba el estado pero la tabla visible no se actualizaba. Ahora elige el render correcto
// según currentChannel.
// 33vo bump, mismo día ("hay muchos que no tienen un delta sospechoso... sólo marca los que
// realmente tengan un delta sospechoso" + "una regla que quede para adelante, hasta que
// transcurran 60 días, luego se da por cerrado... siempre se auditan los últimos 2 meses"):
// el marcador "!" ya NO se pinta en TODA la sección apenas su total se estima -- cada línea se
// compara contra su PROPIA mediana histórica (mismo umbral 65%) y sólo se marca si ELLA
// también se desvía. Además, la corrección/marca de sección (~ y !) sólo aplica al mes en
// curso y al anterior (ventana de 2 meses / ~60 días) -- un mes más viejo se considera cerrado
// y se deja tal cual está en Oppen, aunque su ratio real quede bajo el umbral.
// 34vo bump, mismo día ("trata de alinear las columnas de datos en todos los 'ventas en
// vivo'"): min-width compartido en la 1ra columna y en toda celda .num de las 7 tablas de
// Ventas en Vivo (Macro/Marca/Proveedor/Subgrupo/Cliente/Tipo de Operación/SKU) -- antes cada
// tabla auto-ajustaba su columna de etiqueta según su propio contenido más largo, así que las
// columnas numéricas (Precio Pr/Unidades/Total Neto/Peso/GM%) quedaban en una posición
// horizontal distinta card a card.
// 35vo bump, mismo día (bug real, "no funciona el filtro de canales"): dashRenderCanalPills
// armaba el onclick de cada pill con JSON.stringify(valor) -- que envuelve el string en
// COMILLAS DOBLES -- insertado dentro de un atributo onclick="..." que TAMBIÉN usa comillas
// dobles, esa comilla cerraba el atributo antes de tiempo y dejaba el HTML corrupto (el
// onclick real quedaba truncado en "dashSetCanalMinorista(", confirmado reproduciendo el bug
// en un DOM real). Sólo el botón "Todos" (valor=null, no pasa por JSON.stringify) se salvaba
// -- por eso el filtro "no hacía nada" al tocar cualquier canal real. Corregido con el mismo
// patrón de comillas simples + erpJsStrEscape que ya usa el resto del tablero.
// 36vo bump, mismo día ("por qué el proyectado de Evolución mensual no coincide con el
// proyectado del P&L?"): NO era un bug -- "Evolución mensual"/"Acumulado del Año" piden Oppen
// EN VIVO en cada carga; el P&L del mes en curso es una FOTO que se recalcula 1 sola vez por
// día (Cron 6:30 AM). Se agrega un aviso en el P&L con la hora exacta de esa foto (dato
// updatedAt, ya venía en el payload pero no se mostraba) para que la diferencia con los
// gráficos en vivo deje de parecer un dato inconsistente.
// 37vo bump, 24/09/2026 ("en Ventas en Vivo de Cirugía agregar un detalle de Grupo de
// Clientes -- OS/PU/PR, etc -- para ver cómo se compone la facturación por sectores"): Oppen
// no tenía esto expuesto por API -- después de confirmar que NO existe ninguna entidad
// Customer/BusinessPartner en el genericapi (revisado el swagger real, openapi.json, con la
// lista completa de 9 entidades), Juan Manuel dio de alta "Customer"/"CustomerGroup" del lado
// de Oppen. Se sincronizan a un buffer propio (api/actualizar-customer-grupos.js, Customer
// tiene 167K registros -- bootstrap resumible entre corridas, después incremental por
// updateTime__gt) y se adjunta grupoCliente a cada fila de oppen-invoices.js. Nueva tabla "Por
// Grupo de Clientes" debajo de "Por Tipo de Operación" en Cirugía, mismo formato/comportamiento
// (click para filtrar todo lo de abajo, GM% incluido) -- "Sin grupo" agrupa clientes todavía
// no sincronizados o sin GroupCode cargado en Oppen, en vez de perderse en silencio.
// 38vo bump, mismo dia (cruce de julio con Finanzas, 3 correcciones al P&L de Gastos):
// (1) Comision ML -- la cuenta 4.2.03.24.00.00 mezclaba la Factura de Compra real que emite
// Mercado Libre (RecordSource "PurchaseInvoice!...") con un asiento espejo por cada Factura
// de VENTA del periodo (RecordSource "Invoice!..."), ya neteado dentro de esa misma venta --
// ahora solo se suman los "PurchaseInvoice" (julio: 71.4M -> 47.1M, contra 47.4M real de
// Finanzas). (2) Conservacion de edificios (4.2.05.04.00.00) pasa siempre a una linea
// "(extraordinario)", fuera de Total Gastos Directos. (3) Taller se suma como unidad propia
// (porUnidad.taller, ver UNIDADES_SIN_VENTA en api/_pnl-gastos-core.js) -- por ahora sin
// tarjeta propia, solo entra en el agregado de "Total ICOM". Backfill aplicado Ene-Ago.
// 24/09/2026: v42 -- Mercado Libre, aprobador masivo de propuestas SMART (filtro "NM
// propuesta >15%" -> popup con cantidad + NM promedio -> aprobacion en lote, secuencial).
// 24/09/2026: v43 -- el filtro pasa a ser filtro+seleccion (ya no abre el popup solo, un
// boton "Aceptar (N)" aparece al lado del toggle) y ahora cubre tanto propuestas SMART de
// MeLi como descuentos propios tipeados a mano en PVP Nuevo (enviarDescuentoIndividualCore).
// 24/09/2026: v44 -- fix reportado ("seleccione varias pero no aparece el boton"): la
// seleccion para el aprobador masivo ya NO depende del filtro "NM oferta >15%" (eso vuelve
// a ser solo un filtro de vista) -- ahora son los tildes de "Promo Sugerida"/PVP Nuevo que
// el usuario ya viene marcando fila por fila (tipoOfertaSeleccionada).
// 24/09/2026: v45 -- el resultado final de la aprobacion masiva ya no usa alert() nativo
// del navegador -- modal propio (mostrarResultadoAprobacionMasiva) con icono grande (🎉/⚠️)
// y mensaje "Tus N ofertas fueron aceptadas con exito".
// 24/09/2026: v46 -- nuevo permiso granular 'meli_aprobar' (checkbox "Aprobar Mercado
// Libre" en Personas > Apps, ver puedeAprobarMeli en api/_talento-auth.js) para sumar
// colaboradores sin hacerlos admin. El error de permiso denegado en Mercado Libre ya no
// muestra el alert() nativo -- modal propio con icono prohibido (🚫).
// 25/09/2026: v47 -- Mercado Libre, barra de scroll horizontal flotante fija al pie de la
// pantalla (#scrollHFloat) -- antes había que bajar mas alla de la ultima publicacion para
// llegar al scroll de la tabla con mouse (sin touchpad); ahora esta siempre a mano.
// 25/09/2026: v48 -- Mercado Libre, imagen + titulo de la publicacion quedan "congelados"
// (position:sticky) a la izquierda de la tabla al scrollear horizontalmente -- antes se
// perdian de vista apenas se scrolleaba para ver las columnas de la derecha.
// 25/09/2026: v49 -- P&L (shell principal, no un sub-app): fix de mobile roto -- la tabla
// usaba table-layout:fixed con columnas de mes en % (~44px al minimo de 640px), muy angosto
// para numeros grandes ("Total ICOM" agregado) sin overflow:hidden -- el texto se pisaba
// entre columnas vecinas. Ahora min-width por columna + layout auto (crece si hace falta).
// Ademas, las celdas "~ estimado"/"! a revisar" dependian de title= (hover, no funciona en
// touch) -- ahora tienen un icono ⓘ tocable que abre la explicacion en un popover.
// 25/09/2026: v50 -- Mercado Libre, fix del parpadeo/tironeo reportado al arrastrar la
// barra de scroll flotante (#scrollHFloat) -- el sync bidireccional con .table-wrap usaba
// una bandera que se reseteaba antes de que el evento 'scroll' resultante llegara (es
// async), permitiendo un rebote con valores no idénticos entre los 2 scrolls. Ahora
// compara valores en vez de usar bandera -- inmune al timing, no hay vuelta que rebote.
// 25/09/2026: v51 -- dos cambios grandes.
// (1) Mercado Libre: el v50 no alcanzo -- un video del arrastre real mostro la tabla
// saltando de punta a punta varias veces por segundo (2 scrolls NATIVOS sincronizandose a
// mano se pelean de verdad, no solo un jitter de 1px). #scrollHFloat pasa a ser un thumb
// arrastrado a mano (mousedown/mousemove propios) que escribe .table-wrap.scrollLeft
// directo -- un solo scroll nativo real en toda la cadena, cero forma de rebotar.
// (2) P&L (shell principal): fix de 3 problemas reportados -- las secciones colapsables
// (Impuestos/Directos/Indirectos) se perdian al scrollear a la derecha (la celda sticky
// tenia colspan, position:sticky no se comporta igual ahi -- ahora es una celda normal,
// sin colspan, mismo patron que ya funcionaba en las demas filas); la fila de meses ahora
// es sticky top ademas de sticky left (con todas las secciones abiertas se perdia de
// vista que mes se estaba mirando) y la tabla tiene su propio scroll vertical acotado
// (55vh) para que ese sticky ancle ahi, no contra toda la pagina; las 3 notas explicativas
// (como se calcula, aclaracion de datos estimados, gastos en vivo desde Oppen/CMV) ahora
// arrancan colapsadas detras de un boton "i ... ver mas" en vez de ocupar espacio siempre.
// 25/09/2026: v52 -- misma barra de scroll horizontal flotante (thumb arrastrado a mano,
// sin fallas) llevada a los otros 3 sub-apps con el mismo problema de tabla ancha +
// muchas filas: Quiebres, Alquileres y Seguimiento (Stocks/Exhibiciones ya tenian su
// tabla con scroll acotado -- overflow:auto + max-height -- y Forecast tambien; no
// necesitaban el fix). Seguimiento tiene VARIOS .table-wrap visibles a la vez en una
// sola pagina larga (no pestañas) -- pnlHFloatWrapActivo() elige el que mas se
// superpone con el viewport actual, asi la barra sigue a la tabla que se esta mirando.
// 28/09/2026: v53 -- serie de fixes en Mercado Libre (aceptar-propuesta no confirmaba
// contra MeLi en vivo, snapshot con cache-control de 60s, publicaciones multi-variante
// nunca actualizaban su fila, marca "Sin marca" por una carrera de arranque en el mapa
// SKU->marca, y la barra de scroll horizontal flotante tapando el checkbox/botón de
// aprobar cuando una fila caía justo en esos 14px del borde inferior) -- CACHE_NAME
// TENÍA que bumpearse para que estos lleguen: quedó pisado en v52 desde el trabajo de
// P&L de esta misma sesión, así que NINGÚN cambio del lado del cliente hecho después
// (incluidos los de esta tanda) llegaba a nadie que ya hubiera visitado el panel antes
// -- el Service Worker seguía sirviendo el HTML viejo cacheado sin darse cuenta de que
// había algo nuevo (compara bytes de ESTE archivo, no lo que cachea adentro).
// 28/09/2026: v54 -- el mismo fix de scrollbar flotante de v53 (Mercado Libre) se
// extendió a Quiebres, Alquileres y Seguimiento, que comparten idéntico patrón
// #scrollHFloat -- mismo motivo de bump que arriba, sin esto no llega a nadie que
// ya haya visitado el panel.
// 29/09/2026: v55 -- fórmula de proyección de cierre de mes mejorada (hábil vs. fin de semana
// en vez de lineal plano), gráfico "Evolución mensual" + tarjeta "Proyección de cierre" + tabla
// de P&L, todos usando ahora la misma cuenta del servidor -- CACHE_NAME bumpeado para que el
// cliente nuevo llegue (mismo motivo que v53/v54, ver esos comentarios).
// 29/09/2026: v56 -- "año pasado + IPC" y "proyectado" en el Dashboard (gráfico, tarjeta de
// Proyección y Acumulado del Año) seguían mostrando el total de la UNIDAD completa cuando había
// un canal de Minorista filtrado (Mercado Libre, Tienda Online, etc.) en vez del dato de ese
// canal puntual -- CACHE_NAME bumpeado para que el fix llegue (mismo motivo que v53/v54/v55).
// 30/09/2026 ("hay muchos productos de movilidad... mal segmentados en Incontinencia"):
// 66 SKUs de la Base de Productos precargada (PRODUCT_MASTER_SEED) tenían macro="Incontinencia
// e Higiene" siendo en realidad equipamiento de Movilidad (sillas/bancos de ducha, elevadores
// de inodoro, tablas de transferencia -- MUGI/MASSUAR/SILFAB, mismos proveedores que el resto
// de Movilidad) -- corregidos a macro="Movilidad". CACHE_NAME bumpeado para que llegue.
// 30/09/2026 ("como hacemos para construir un motor parser automatico mas
// solido en clasificacion de Marcas y Categorias... ahora tenemos mucho mas
// info como proveedor"): nueva cascada proveedor -> macro/categoría en
// Seguimiento (pmGuessMacro/pmGuessCategoria, PROVEEDOR_MACRO_DOMINANTE/
// PROVEEDOR_CATEGORIA_DOMINANTE, CATEGORIA_KEYWORD_MAP) + getSkuCategoryMap
// con fallback por proveedor además de ItemGroup -- CACHE_NAME bumpeado para
// que llegue.
// 30/09/2026: CATEGORIA_KEYWORD_MAP ampliado de 12 a 56 entradas -- ahora
// cubre Ortopedia, Descartable Médico y Cirugía, Electromedicina,
// Incontinencia, Ostomía y Farmacia (antes sólo Movilidad), cada keyword
// validado programáticamente contra ~4500 SKUs curados (90%+ de pureza) --
// CACHE_NAME bumpeado para que llegue.
// 30/09/2026 (revisión de colisiones en el resto del diccionario): saqué
// 'MASAJEADOR'/'MASAJEADORA'/'INSULINA' sueltas de MANUAL_KEYWORD_MAP (nivel
// macro) -- validadas contra la base real, acertaban MENOS de la mitad de
// las veces (25%/33% de pureza, mayoría real Ortopedia/Descartable, no
// Electromedicina/Farmacia). CACHE_NAME bumpeado para que llegue.
// 30/09/2026: embudo de "Alquileres y Servicios" -- si la palabra clave de
// macro detecta 'ALQUILER', ya no sigue buscando categoría en el resto del
// diccionario (antes esos ítems podían "robarse" el match de otra categoría
// por mencionar el nombre del equipo, ej. "Alquiler Mensual Silla de Ruedas"
// no debe caer en la categoría de Sillas de ruedas). Evalué extender el
// mismo criterio a MACRO_SIGNAL_WORDS (la capa estadística) y lo descarté --
// empeora la precisión general (94.3%->93.5%) porque 88% de los ítems de
// Alquileres no dicen "alquiler" en el nombre y dependen pura y
// exclusivamente de esa señal estadística para ser clasificados. CACHE_NAME
// bumpeado para que llegue el embudo (sin el cambio descartado).
// 30/09/2026 ("segui con el resto del catalogo"): CATEGORIA_KEYWORD_MAP
// ampliado de 56 a 67 entradas -- Coderas, Gemelera, Instrumental quirúrgico
// (PINZA/CLAVIJA/ALAMBRE DQ), Cánulas y oxigenoterapia (TRAQUEAL/
// RESUCITADOR), Telas adhesivas, CPAP y accesorios (TUBULADURA/BUCONASAL),
// Geles ecografía (GEL SONIC) -- cada keyword minado y validado
// programáticamente contra ~4500 SKUs curados (90%+ de pureza, además
// simulación end-to-end de toda la cascada para descartar colisiones de
// orden). Candidatos descartados por chocar (TIJERA, CPAP sola, ROPA PVC,
// ESPALDERA, CAMA ORTOPEDICA, AUDIFONO, CAMPO, SONIC sola): quedan afuera
// porque esas palabras genuinamente se usan en más de una categoría real del
// catálogo. CACHE_NAME bumpeado para que lleguen.
// 30/09/2026 ("segui con lo que quede del catalogo", 2da ronda): CATEGORIA_KEYWORD_MAP
// ampliado de 67 a 83 entradas -- Plantillas, Pesarios, Banda Metatarsal, Intermitentes
// (SONDA COLOPLAST), Desinfectantes (STERRAD), Jeringas, Consumibles ECG/ECO (PAPEL CARD/
// PAPEL SONY), Termoterapia (FRAZADA), Oxímetros, Termómetros, Baño fácil y aseo corporal,
// Insumos incontinencia (TOALLAS INDASEC/APOSITO PARA INCONTINENCIA), Discos (DISCO
// COLOPLAST), Almohadones -- mismo criterio de validación (90%+ de pureza contra ~4500
// SKUs curados + simulación end-to-end). Candidatos descartados por chocar: BIPEDESTADOR,
// ALGODON, BUTACA, TESTIGO, VENDA, ELECTRODO, AGUA CALIENTE, RESPALDO, OLIVA, PECHERA,
// MALLA-J&J ETHICON (usada indistintamente en 2 categorías reales del catálogo) -- quedan
// afuera porque son inconsistencias del propio catálogo curado, no del diccionario. Con
// esta ronda la cobertura léxica del catálogo queda prácticamente agotada (lo que resta
// sin categoría depende del fallback estadístico/proveedor o de carga manual).
// CACHE_NAME bumpeado para que lleguen.
// 30/09/2026 ("Por que sigues colocando a Massuar como Incontinencia?"): encontrado un
// SEGUNDO catálogo estático con el mismo bug ya arreglado antes hoy (66 SKUs de
// PRODUCT_MASTER_SEED) -- BASE_SKUS, un array separado embebido SOLO dentro de
// Seguimiento (catálogo más viejo, usado como 1er paso "curado" de getSkuCategoryMap),
// nunca se tocó en aquel fix. 47 filas ahí (elevadores de inodoro, agarraderas, bancos
// de ducha, tablas de transferencia -- MASSUAR/SILFAB/MUGI/DEMA/ASPEN/POLISOL, mismo
// patrón) seguían con macro="Incontinencia e Higiene" en vez de "Movilidad", por eso el
// fix de esta mañana no alcanzó a corregir "Por Macro Categoría" en Ventas en Vivo para
// estos SKUs puntuales. Los 47 se cruzaron 1 a 1 contra PRODUCT_MASTER_SEED (ya
// corregido) -- 38 con match exacto confirmando "Movilidad", los 9 restantes (no están
// en ese catálogo) inferidos por el mismo patrón de nombre. CACHE_NAME bumpeado para que
// llegue.
// 01/10/2026 ("lo que me preocupa no es Massuar, me preocupa lo que no estamos viendo"):
// auditoría completa de BASE_SKUS en vez de confiar en que el bug de Massuar era un caso
// aislado -- 2 chequeos: (1) cruce 1 a 1 contra PRODUCT_MASTER_SEED ya corregido (1560
// SKUs en común), (2) para cada SKU, ¿el PREFIJO de su propia categoría ("Farmacia / X",
// "Ortopedia / X", etc) coincide con su propio macro? Encontrados 2 bloques rotos de
// forma sistemática, ningún caso aislado: TODOS los 60 SKUs con categoría "Farmacia / ..."
// tenían macro="Descartable Médico y Cirugía" en vez de "Farmacia y Diabetes" (vaselina,
// alcohol, iodopovidona, sueros Jayor, accesorios Lisfar/CQ); 6 SKUs con categoría
// "Ortopedia / ..." (5 prótesis mamarias Gelform + 1 pedigrafía) tenían macro equivocado.
// Más 8 casos puntuales sin ese patrón de prefijo pero igual mal (glutaraldehído
// catalogado como "Monitoreo glucosa", apósitos Platsul/Syra como "Soluciones" o "Gasas",
// 2 fundas/almohadones como Movilidad/Descartable en vez de Ortopedia) -- resueltos
// siguiendo a PRODUCT_MASTER_SEED como fuente de verdad. Total: 121 SKUs corregidos hoy
// (47 esta mañana + 74 en esta auditoría). Verificado: 0 discrepancias restantes contra
// PRODUCT_MASTER_SEED en los 1560 SKUs en común, 0 prefijos de categoría inconsistentes
// con su propio macro en las 1982 filas de BASE_SKUS. CACHE_NAME bumpeado para que llegue.
// 02/10/2026 ("Re-nombremos Exhibiciones a Sucursales, y ahi coloquemos reseñas al lado de
// Información"): la app Exhibiciones pasa a llamarse Sucursales (menú lateral, título, textos de
// carga -- los ids internos, rutas /api/exhibiciones-* y blobs NO cambian, para no romper
// nada guardado). Pestaña nueva "Reseñas" junto a Información: reseñas en vivo desde Google
// Places (api/google-resenas.js) y la "Puntuación Google" -- que antes vivía en Información --
// ahora con foto diaria automática (api/actualizar-google-resenas.js, 23:00 ARG) además de la
// carga a mano, con gráfico del histórico. Hasta que se cargue GOOGLE_PLACES_API_KEY en Vercel
// la pestaña muestra cómo conectarla. CACHE_NAME bumpeado para que llegue.
// 02/10/2026 ("seguí con lo que quede del catálogo" + ajustes de Reseñas):
// (1) CATÁLOGO -- auditoría cruzada (palabras clave, proveedor y consistencia de categoría)
// encontró errores que ninguna regla detectaba: 9 productos Massuar volcados en "Fajas y
// corsés" (asientos de ducha, repuestos de sillas, regatones, careta facial), 17 prendas
// "ROPA PVC" (bombachas, sábanas, cubrecamilla) contadas como Ortopedia en vez de Incontinencia,
// repuestos de nebulizadores/tensiómetros (ASPEN, SAN UP, OMRON, LISFAR) mal ubicados -- 4 de
// ellos los había movido yo a Movilidad esta mañana por error --, zaleas descartables en
// "Varios", catéteres epicutáneos como Farmacia, y otros sueltos. 52 filas en la Base de
// Productos precargada y 11 en el catálogo de Seguimiento (BASE_SKUS).
// (2) Las correcciones de la Base de Productos precargada nunca llegaban a navegadores que ya
// la tenían sembrada (pmSeedIfEmpty: "no se pisa"): ahora se refresca sola cuando cambia el
// contenido (huella pmSeedHuella), sin tocar nunca una base subida por el usuario.
// (3) Sucursales > Reseñas: indicadores de la sucursal elegida (puntuación, cantidad de
// reseñas, fecha de la última) justo debajo del selector, sin carga manual de puntuación.
// CACHE_NAME bumpeado para que llegue.
// 02/10/2026 (decisiones del usuario sobre el catálogo): (1) 8 orinales/chatas/bacinilla/
// frascos recolectores pasan a Incontinencia; (2) "Fajas y corsés" (cajón de sastre de 639
// productos) se ordena con reglas por nombre usando SÓLO macros y categorías que ya existían:
// bajó a 427, y de paso aparecieron productos con macro equivocado ahí adentro (repuestos de
// sillas CQ/Silfab, elevadores de inodoro, repuestos de equipos W.Allyn/San Up/Silfab,
// repuestos Widex como Audiología, etc.); (3) Camas ortopédicas completa, muebles de
// consultorio VRH (biombo, escalera, lupa, pantallas) y tobilleras Mugi pasan a Movilidad
// ("Camas ortopédicas" se reutiliza para el mobiliario hospitalario: no se creó ninguna
// categoría nueva); (4) Alquileres queda como está (los repuestos Mugi mantienen activos los
// productos en alquiler). En Seguimiento, 400 categorías con prefijo ("Ortopedia / Plantillas")
// se unificaron a la forma simple de la Base de Productos: antes aparecían duplicadas en los
// desplegables de edición. 'TOBILLERAS MUGI' en el diccionario de categorías. 211 filas en la
// Base de Productos precargada, ~1.800 normalizadas en Seguimiento. CACHE_NAME bumpeado.
// 02/10/2026 ("Sí, endurecelo y corregí lo ya guardado"): clasificador automático de Seguimiento más estricto
// (voto de palabras 8+ muestras/90%, categoría por proveedor >=60%/3 muestras, filas auto-registradas ya no
// entrenan) + migración única de las filas auto guardadas -- CACHE_NAME bumpeado a v68.
// 02/10/2026: Sucursales -- fachada y plano a todo el ancho de su tarjeta, sin franjas grises (responsive).
// 02/10/2026: Sucursales -- pestañas Información/Reseñas/Exhibición/SOE, fachada y plano dentro de Información, reseñas por fecha desc.
// 02/10/2026: Sucursales -- KPIs en 2 filas, quita "Última reseña", suma % quiebres con stock en Bella Vista y % stock inmovilizado (popup + Excel).
// 02/10/2026: Sucursales -- nombres cortos de KPIs (% Quiebres, % Inmovilizado, M³ Exhibidos, Productividad) y Venta por cm³ ocupa las 2 filas.
// 02/10/2026: Sucursales -- inmovilizado = sin venta 12 meses; se quitan dirección y leyenda de orden de Reseñas.
// 02/10/2026: Sucursales -- el bloque grande de KPIs pasa a ser siempre Puntuación Google.
// 02/10/2026: Sucursales -- nota de Reseñas acortada a "Integrado con Google · se actualiza a diario".
// 02/10/2026: Sucursales -- QR de reseñas (pestaña Reseñas) + página pública /r/<sucursal>.
// 04/10/2026: P&L -- los meses con menos de 60 días desde que terminaron (ej. Agosto) quedan "abiertos" y estimados.
// 05/10/2026: P&L -- la estimación de líneas de Gastos Directos cuenta como 0 los meses de referencia sin movimiento.
// 05/10/2026: P&L -- proyección del mes en curso combinada con el ritmo de los 3 meses anteriores durante los primeros 10 días hábiles.
// 05/10/2026: pop-up de cumpleaños -- incluye los de fin de semana/días sin ingreso (desde el último chequeo, tope 4 días) y usa fecha local.
// 05/10/2026: pop-up de cumpleaños vuelve a mostrar sólo los del día (se mantiene la fecha local en vez de UTC).
// 05/10/2026: Mercado Libre -- marca ⚠ en el precio de publicaciones con descuento publicado pero sin promoción activa.
// 05/10/2026: Mercado Libre -- filtro de Vista rápida "⚠ Desc. sin promo".
// 05/10/2026: Mercado Libre -- botón "Reactivar" promoción (campaña propia) en publicaciones con descuento sin promo.
// 05/10/2026: Reactivar promoción -- muestra y valida el rango de precio que acepta MeLi para la campaña.
// 06/10/2026: Ventas en Vivo -- selección múltiple en Macro Categoría / Marca / Proveedor / Subgrupo.
// 06/10/2026: Ventas en Vivo -- selección múltiple también en Cliente, Tipo de Operación y Grupo de Clientes; Todos/Ninguno en Vendedor.
// 06/10/2026: las tablas por SKU de Ventas en Vivo siguen mostrando todas sus opciones al filtrar (multi-select); Monitor de Órdenes de Venta también con selección múltiple + Todos/Ninguno.
// 07/10/2026: Mercado Libre -- columna y filtro rápido de propuestas de Oferta Relámpago.
// 07/10/2026: Mercado Libre -- tilde por fila y select-all en encabezados (Relámpago y Promo Sugerida), aclaraciones de Relámpago; P&L con IVA de las FCN.
// 08/10/2026: Gestión de Talento -- los colaboradores (y gerentes) ven la pestaña Objetivos, en modo 'Mis Objetivos' de sólo lectura.
// 08/10/2026: pop-up de cumpleaños en lista compacta cuando cumplen varios; Talento > Reportes: Personas con datos incompletos (Excel).
// 08/10/2026: Talento > Vacaciones: vista general del equipo en fichas chicas con semáforo (verde/amarillo/naranja) y detalle al tocar el mes.
// 08/10/2026: Talento: lista de personas colapsable (buscador + flecha) arriba en Vacaciones/Objetivos/Competencias.
// 08/10/2026: Talento > Novedades: lista de personas colapsable (buscador + flecha), igual que Vacaciones/Objetivos/Competencias.
// 08/10/2026: Talento: barra de selección homogénea (año+persona), solicitudes pendientes arriba y estados vacíos unificados.
// 08/10/2026: Talento en celular: controles táctiles de ~36px (reacciones, Comentar/Borrar, flechas de año, filtros del organigrama) y aire abajo por el chat flotante.
// 08/10/2026: auditoría de diseño pasos 1-2: formularios en columna en celular, objetivos táctiles, y contraste (--muted #6b6b6b en las 9 pantallas, avatares más oscuros).
// 08/10/2026: auditoría de diseño pasos 3-4: Competencias (fieldset, ⓘ en las 17, progreso + guardar fijo en celular), estados vacíos y badges unificados, fechas legibles, textos.
// 08/10/2026: auditoría de diseño paso 5 (accesibilidad): selector de personas con teclado, nombres accesibles, pestañas con flechas, chat y organigrama accesibles.
// 08/10/2026: auditoría de diseño paso 6 (estructura): Vacaciones con detalle bajo la barra, año en la barra de Objetivos/Competencias/Matriz, Matriz y Personas en celular, Muro con pendientes arriba.
// 08/10/2026: auditoría de diseño paso 7 (pulido): Reportes con mes actual y Exportar a la derecha, filtro de motivos completo, Celebraciones sin meses vacíos y badges neutros, Reintentar al fallar la carga, encabezados h1/h2.
// 08/10/2026: animación de entrada (GIF vertical/horizontal) a pantalla completa después del login.
// 08/10/2026: la animación de entrada pasa de GIF a video MP4 con sonido (se desbloquea el audio al tocar Ingresar).
// 08/10/2026: pantallas anchas -- Dashboard / Ventas en Vivo / Monitor OV / Base de Productos / Stocks / Sucursales aprovechan el ancho (escalonado desde 1500px; por debajo no cambia).
// 08/10/2026: los bloques de cifras (Venta estimada / Acumulado del Año / DOH) se reparten todo el ancho en columnas iguales.
// 08/10/2026: los gráficos del Dashboard / Ventas en Vivo se amplían a pantalla completa al tocarlos (con cruz).
// 08/10/2026: el gráfico de línea se amplía junto con sus indicadores numéricos (Acumulado del Año).
// 08/10/2026: Dashboard de Cirugía Estética con filtros Grupo / Subgrupo (selección múltiple) que recalculan los gráficos.
// 08/10/2026: pop-up del gráfico de línea: reacomodo al ancho (sin zoom), 4 indicadores en una fila, sin bordes redondeados raros.
// 08/10/2026: bloques de cifras del Dashboard alineados arriba, columnas iguales (2x2 en media tarjeta), números en una línea.
// 08/10/2026: bloques de cifras con cantidad de columnas explícita (4 / 2x2 / 1), sin bloque huérfano.
// 08/10/2026: HOTFIX -- el desglose Grupo/Subgrupo ya no se re-pide solo para todos los meses cerrados (saturaba Oppen y rompía Stocks); Cirugía General lo arma desde el blob de ventas por SKU; Estética lo carga a pedido.
// 08/10/2026: barra de filtros del Dashboard rediseñada (estilo Mercado Libre): Estética = Visitador médico; General = Grupo + Subgrupo.
// 08/10/2026: filtros del Dashboard también en Ortopedia (Canal de venta, múltiple) y Movilidad (Vendedor institución + Vendedor).
// 08/10/2026: Cirugía General filtra por Proveedor (izquierda) y Subgrupo (derecha), de Oppen.
// 08/10/2026: evita un bucle de repintado al filtrar canales sin año pasado cargado.
// 08/10/2026: en el pop-up del gráfico de línea el selector de meses funciona (y refresca el acumulado).
// 08/10/2026: Cirugías promedio diaria: meses cerrados en caché + reintento automático ante el límite de pedidos de Oppen.
// 08/10/2026: tablas de Ventas en Vivo / Monitor OV / Base de Productos con el estilo de Mercado Libre (encabezado, contenedor, orden por columna, barra en Peso).
// 08/10/2026: selectores de incluir/excluir (Unidad de Negocio / Canales / Órdenes de Venta / Vendedores) con el estilo de fichas de Mercado Libre; filas seleccionadas resaltadas.
// 08/10/2026: tablas de Stocks, Seguimiento, Sucursales y Forecast con la misma lógica de Mercado Libre (encabezado, orden por columna, barra en Peso, fila seleccionada resaltada).
// 08/10/2026: tablas v2 -- primeras columnas fijas, estados cargando/sin datos unificados y orden recordado entre sesiones.
// 08/10/2026 (v125 corrige v124): Seguimiento -- Margen %, Avance y vs Forecast como píldoras de color (umbrales 45/30 de margen, 95/80 de avance).
// 08/10/2026: se quita 'Recuperar un mes cerrado'; botón Excel junto a cada tabla; año pasado también con filtros (Proveedor/Subgrupo/Vendedor/Visitador); Comparar ya no tapa los atajos y su OK va junto a 💲/📦.
// 08/10/2026: año pasado con filtros usa un pedido liviano por mes (antes: mes completo con todas las filas, minutos o colgado) + el servidor devuelve byVendedores.
// 08/10/2026: el año pasado con filtros se lee de una foto del servidor (api/anio-pasado-liviano, cron diario) -- instantáneo; respaldo: pedido liviano mes a mes.
// 08/10/2026: Muro de Talento -- videos (subida por trozos a Blob) y edición de publicaciones.
// 08/10/2026: Mercado Libre -- botón para aprobar las Ofertas Relámpago tildadas (antes sólo existían la columna y los tildes).
// 08/10/2026: Dashboard Cirugía General -- el total de cirugías del año pasa a la fila de los indicadores 'Cirugías/día'.
// 09/10/2026: Muro de Talento -- negrita (**texto**) con botón B y Ctrl+B al publicar y al editar.
// 09/10/2026: Mercado Libre -- Promo Sugerida y Relámpago alineadas, círculos sin acción apagados, NM + detalle de la oferta Relámpago.
// 09/10/2026: Talento siempre abre en el Muro (al iniciar sesión y al volver a entrar al panel).
// 09/10/2026: Muro de Talento -- compositor estilo Facebook (barra de formato, emojis, listas, cita, links automáticos).
// 09/10/2026: Muro de Talento -- @menciones a colaboradores (lista al escribir @, resaltado, aviso a la persona mencionada).
// 09/10/2026: menú lateral colapsado -- íconos de unidades y apps alineados en la misma columna.
// 09/10/2026: Muro de Talento -- compositor más parecido a Facebook + links (YouTube/Vimeo/Facebook/Instagram/TikTok embebidos, tarjeta con vista previa para otras páginas).
// 09/10/2026: Muro -- una sola barra (formato + adjuntos), sin 'Todo el equipo'; aviso por mail a las personas mencionadas.
// 09/10/2026: Muro -- comentarios con formato/emojis/@menciones (con aviso por mail) y compositor colapsado con botón.
// 09/10/2026: Muro -- videos por link con reproducción automática (sin sonido) al entrar en pantalla y formato vertical para Shorts/reels.
// 09/10/2026: Muro -- los videos de YouTube/Vimeo se repiten solos al terminar.
// 09/10/2026: Muro -- el video subido por archivo también se repite y arranca solo (sin sonido) al entrar en pantalla.
// 09/10/2026: Talento > Personas -- 'Cargar fotos en lote' (zip o imágenes, emparejadas por nombre con revisión).
// 09/10/2026: fotos en lote -- el botón 'Listo' final cierra la ventana.
// 09/10/2026: Muro -- las publicaciones largas se recortan a 3 renglones con 'Ver más'.
// 09/10/2026: fotos en lote -- reabrir muestra primero y sólo las pendientes (sin persona o persona sin foto); al terminar lista los archivos que no se cargaron.
// 09/10/2026: fotos en lote -- buscador con lupa para asignar la persona de cada foto.
// 09/10/2026: fotos en lote -- la lista de resultados del buscador queda por encima de la ventana (estaba detrás).
// 09/10/2026: auditoría de Roberto aplicada -- el Muro no se redibuja entero, un solo video a la vez, menciones con apellido, fotos en lote (2a tanda/detener/reintentar), borrador visible, responsive, accesibilidad.
// 09/10/2026: Muro -- al editar se puede reemplazar o agregar foto, video y link (no sólo quitarlos).
// 09/10/2026: editar publicación -- textos del estado de foto/video nuevo.
// 09/10/2026: comentarios del Muro desactivados (ocultos; los datos se conservan).
// 13/10/2026: Talento > Celebraciones -- RR.HH. ve un aviso si alguien cumple hoy pero no entra en la lista (estado o fecha).
// 13/10/2026: cumpleaños en feriado o fin de semana salen el primer día hábil con su fecha (nuevo /api/feriados) -- aviso de bienvenida, Celebraciones y Muro.
// 13/10/2026: nueva app Nubimetrics (Ortopedia) -- el mercado de Mercado Libre por categoría vía la API de Nubimetrics.
// 13/10/2026: Nubimetrics -- filtro por subcategoría, solapa Subcategorías en tabla (sin barras) y sin marcas propias (Magesa es competencia).
// 13/10/2026: Nubimetrics -- icono 🌐 (total mercado).
// 13/10/2026: Nubimetrics -- sin aviso de "mes en curso" (Nubimetrics expone el día anterior todos los días) y actualización diaria.
// 13/10/2026: Nubimetrics -- agosto rescatado + aviso de categorías sin datos en un mes.
// 14/10/2026: Ventas en Vivo se tapa con "Cargando datos de <unidad>" al cambiar de unidad (no muestra datos de la unidad anterior); Nubimetrics: selector de mes y "Comparar con".
// 14/10/2026: rebranding -- el azul de menús/acentos pasa al verde ICOM #007067 y nuevo logo para fondos claros (login, menú, mails).
// 14/10/2026: logo del menú más chico (26 px de alto) y sin desborde.
// 14/10/2026: logo completo IcomSalud (con "El bienestar nos une") en login, menú y mails.
// 14/10/2026: intro en verde (videos nuevos) + recarga/aviso automático cuando hay versión nueva.
// 14/10/2026: menos espacio arriba en todas las pantallas (franja de estado dentro de la fila del título).
// 14/10/2026: rueda de carga al cambiar de período/unidad (Ventas en Vivo, Monitor OV, Nubimetrics): no se muestran datos del período anterior.
// 14/10/2026: la capa de carga ahora es translúcida (se ve lo de abajo) con la rueda al centro.
const CACHE_NAME = 'icom-shell-v327';
const SHELL_URLS = [
  '/',
  '/icom_panel_unificado.html',
  '/manifest.json',
  '/icons/icon-192-v2.png',
  '/icons/icon-512-v2.png',
  '/icons/apple-touch-icon-v2.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Precarga best-effort: si un solo recurso falla (ej. un ícono
  // renombrado) no debe tirar abajo la instalación entera -- este service
  // worker también cumple el requisito técnico de "Agregar a pantalla de
  // inicio" en Android, y eso no puede quedar roto por un 404 aislado.
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(SHELL_URLS.map(url => cache.add(url)))
    )
  );
});

// 20/10/2026 ("podemos forzar para que todas se actualicen?" -- colaboradores con la app «instalada» se quedaban con una versión vieja o trabada): cuando este service worker
// reemplaza a uno anterior, además de tomar el control recarga todas las ventanas abiertas del panel (también las de la app instalada), así nadie sigue con código viejo.
// La sesión se conserva (vive en sessionStorage de la misma pestaña/ventana). Sólo ocurre al actualizar de una versión a otra, no en la primera instalación.
const RECARGA_FORZADA_EN = 'icom-shell-v276';
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const nombres = await caches.keys();
    const habiaVersionVieja = nombres.some(n => n !== CACHE_NAME);
    await Promise.all(nombres.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
    await self.clients.claim();
    // recarga forzada SÓLO en esta versión (la que reemplaza a las que ya estaban abiertas/instaladas); en las siguientes versiones el aviso «Hay una versión nueva» lo resuelve el panel (ver icomAvisarVersionNueva)
    if (!habiaVersionVieja || CACHE_NAME !== RECARGA_FORZADA_EN) return;
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(ventanas.map(v => { try { return v.navigate(v.url).catch(() => null); } catch (e) { return null; } }));
  })());
});

function esRecursoDelShell(url){
  if(url.origin !== self.location.origin) return false;
  return url.pathname === '/'
    || url.pathname.endsWith('/icom_panel_unificado.html')
    || url.pathname === '/manifest.json'
    || url.pathname.startsWith('/icons/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Todo lo que NO es un recurso del shell (en particular /api/* -- las
  // ventas/stock en vivo -- y cualquier script/recurso de terceros) sigue
  // yendo directo a la red, sin interceptar ni cachear nada, igual que
  // siempre.
  if(req.method !== 'GET' || !esRecursoDelShell(url)){
    event.respondWith(fetch(req));
    return;
  }

  // 20/10/2026: RED PRIMERO. Antes se respondía con lo guardado (y se actualizaba atrás), así que quien tenía la app instalada veía SIEMPRE una versión vieja una vez más (y, si esa versión tenía un
  // problema, seguía con él). Ahora se pide el panel a la red y sólo si no hay conexión (o tarda más de 6 s) se usa la copia guardada.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const red = fetch(req).then(res => {
      if(res && res.ok) cache.put(req, res.clone());
      return res;
    });
    event.waitUntil(red.catch(() => null));
    const limite = new Promise(r => setTimeout(() => r(null), 6000));
    const res = await Promise.race([red.catch(() => null), limite]);
    if(res) return res;
    const cached = await cache.match(req);
    if(cached) return cached;
    return red.catch(() => fetch(req));
  })());
});
