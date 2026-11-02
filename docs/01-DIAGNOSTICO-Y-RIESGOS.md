# 01 · Diagnóstico, hallazgos y riesgos

> Revisión crítica del Informe Ejecutivo v1.0 (21/10/2026) antes de escribir una sola línea de código.
> Este documento no repite la propuesta: la audita.

---

## 1. Qué propone el documento (síntesis fiel)

| Dimensión | Lo que dice la propuesta |
|---|---|
| **Cliente** | Panadería Tanta (Lima). Gerente General como interlocutor. |
| **Proveedor** | Team eSolutionsNet — Ing. Fidel Alonso Alfredo Alvarez Chavez. |
| **Alcance** | App móvil (Android/iOS/tablet) con 4 perfiles operativos + plataforma web con 4 módulos (Maestros, Almacén e Inventario, Vendedor, Gerencia). |
| **Perfiles** | Cliente, Producción (tablet), Almacén, Vendedor, Gerente, Administrador. |
| **Núcleo del valor** | Trazabilidad pedido → OP → consumo de insumos → producción → despacho → venta → cobranza, con **costo real y margen % por producto, cliente, vendedor y venta**. |
| **Stack** | Flutter · React + TypeScript · Node.js + NestJS · PostgreSQL · FCM · Docker + Nginx + SSL. |
| **Reportes** | 13 gerenciales (G-01…G-13), 2 de vendedor (V-01, V-02), 2 de almacén (A-01, A-02), 1 de maestros (M-01). |
| **Plazo** | 30 días calendario · 22 días hábiles · 26/10/2026 → 24/11/2026 · 7 fases · 5 hitos. |
| **Precio** | S/ 3,000 única vez (adelanto S/ 1,000) + S/ 150/mes + S/ 78/año dominio. Sin IGV. |
| **Exclusiones** | Comprobantes electrónicos SUNAT, pasarela de pagos, hardware, cuentas de tiendas de apps. |

El documento está **bien escrito y bien vendido**: tiene hilo narrativo, cifras consistentes y una matriz de permisos. El problema no es la redacción, es que **el alcance no cabe en el precio ni en el plazo**, y que la arquitectura tiene vacíos que se pagan caro en la fase de construcción.

---

## 2. Lo que está bien y no hay que tocar

1. **El eje es correcto.** Poner el costo y el margen en el centro —y no el "sistema de facturación"— es la decisión más inteligente del documento. Es lo que el gerente de una panadería realmente necesita y lo que casi ningún software del mercado peruano le da bien.
2. **El principio de snapshot de costo** (§4.4: *"cada línea de venta almacena el costo unitario vigente en el momento de la venta"*) es exactamente la decisión correcta y hay que defenderla con uñas y dientes. Es la diferencia entre un reporte de rentabilidad confiable y uno que cambia solo cuando sube la harina.
3. **Las reglas críticas viven en el servidor**, no en el dispositivo. Correcto para un sistema con 4 apps distintas y tablets en planta.
4. **Arquitectura de 3 capas con API única.** Correcto y suficiente. No hace falta más.
5. **La matriz de permisos y el catálogo de reportes** son un buen punto de partida funcional; ya están pensados desde el negocio.
6. **El reconocimiento del riesgo de datos base** (§8: entrega tardía de recetas) como riesgo #1 es honesto y acertado.

---

## 3. Inconsistencias internas del documento (`I-xx`)

Detectadas al cruzar secciones entre sí. Cada una es una discusión que alguien tendrá en la reunión de arranque; mejor tenerla antes.

| ID | Inconsistencia | Por qué importa |
|---|---|---|
| **I-01** | **El hito H5 (Go-live) figura el 20/11/2026** en la tabla §6.3, pero el Gantt programa el despliegue del 20 al 23/11 y el Go-live el **24/11**, y el pago del saldo se ata al **24/11**. | El hito que dispara el cobro tiene dos fechas distintas. Es un conflicto contractual esperando a ocurrir. Debe unificarse en **24/11/2026**. |
| **I-02** | La tabla §6.3 da a H5 el criterio "Sistema en producción… y respaldos operativos", pero el **20/11** el sistema todavía no se despliega (tarea 7.1 empieza ese día). | El criterio de aceptación es inalcanzable en la fecha declarada. |
| **I-03** | §3.1 dice que el **Administrador accede solo por web** y el **Gerente solo por web**; pero §3.3 asigna al Administrador el módulo "Maestros" y al Gerente "Dashboard", y la Tabla 2 le da al Admin "solo consulta" en Pedidos, OP, Inventario y Ventas. | Si el Admin gestiona usuarios, productos y recetas, no puede ser "solo consulta" en el resto: necesita, como mínimo, ver pedidos para dar soporte. La matriz está subespecificada. |
| **I-04** | El flujo §4.3 paso 3 habla de **"requisición"** de insumos, pero el modelo de datos §4.4 **no tiene entidad de requisición** ni de consumo por OP. | Es un documento de negocio sin respaldo en el modelo. Al construir, aparecerá la duda: ¿el consumo se descuenta por receta teórica o por lo que el almacenero entrega realmente? **Son dos comportamientos distintos y afectan el costo.** |
| **I-05** | §3.3 "Ingreso de insumos por compra (actualiza el costo promedio ponderado)" pero el modelo de datos **no incluye Compra, Orden de Compra ni detalle de compra**. | Sin documento de compra no hay trazabilidad de proveedor, precio ni factura; el CPP queda sin sustento auditable. |
| **I-06** | §3.2 promete al Vendedor "descuento autorizado", pero no existe el flujo de autorización ni el rol que autoriza. | Un descuento sin control es una fuga de margen directa. Es el tipo de agujero que el gerente descubre tarde y le cuesta caro al proveedor. |
| **I-07** | §3.2 ofrece "notificaciones push por cambio de estado" y §4.4 **no tiene entidad de notificación**. | Sin persistencia no hay reintento ni historial: un push perdido es una promesa incumplida al cliente y nadie lo sabe. |
| **I-08** | El cronograma asume **5 corrientes de trabajo en paralelo** (backend, app, web, diseño, QA) desde la semana 2, pero §7 admite que *"una persona puede asumir más de un rol"*. | Con 2 o 3 personas reales, el paralelismo del Gantt es ficticio y el plan se cae en la semana 3. |
| **I-09** | El alcance incluye **4 perfiles móviles** y la propuesta no dice nada de **distribución** (Play Store / App Store están excluidas), ni de cómo actualizar tablets en planta. | Sin plan de distribución, "app funcional en Android e iOS" no se puede verificar en el Go-live. |
| **I-10** | **La Tabla 2 concede lectura de costos sin decirlo.** "Insumos y recetas" es una sola celda; al marcar ○ en Producción, Almacén y Gerente les está dando acceso al **CPP, al costo unitario y al margen**. | El costo y la receta son el activo competitivo de Tanta. Es la fuga de información más grave del diseño y no está reconocida como tal. Se corrige con separación de permisos entre *receta* y *costo* (`00 D-12`). |
| **I-11** | No existe un perfil para que **el proveedor dé soporte**. Quien reinicia un servicio hoy debe entrar como Administrador de negocio, con acceso a márgenes, recetas y cartera. | Cada incidencia de soporte implica acceso total al activo más sensible. Se corrige con el perfil `SOPORTE` (`00 D-11`). |

---

## 4. Vacíos de arquitectura (`V-xx`)

No son errores de redacción: son decisiones que **faltan** y que, si se toman mal sobre la marcha, obligan a rehacer tablas y reportes.

### V-01 · La receta no está versionada — **crítico**
La propuesta congela el costo en la venta (bien), pero no versiona la **receta**. Si el 10 de diciembre Tanta cambia la receta del ciabatta (sube la harina o ajusta el rendimiento), todos los reportes de noviembre que recalculen costo con la receta actual **mentirán**. El snapshot de la línea de venta salva el margen histórico solo si el costo ya está congelado; el problema aparece en todo lo que se recalcula (ficha de costo, comparativos, producción vs. receta).

**Decisión:** `receta` versionada con `vigente_desde`/`vigente_hasta` y estado `BORRADOR → APROBADA → ARCHIVADA`. La OP apunta a una **versión concreta**, nunca a "la receta actual".

### V-02 · El precio tampoco está versionado
Cambiar un precio hoy reescribe el pasado de cualquier reporte que se recalcule. Se necesita `producto_precio` con vigencia y, sobre todo, **listas de precio**.

### V-03 · No hay listas de precio — **hueco de negocio**
La propuesta menciona "ventas a terceros" y "clientes frecuentes", pero asume **un solo precio por producto**. Una panadería real vende a mostrador, a bodegas (mayorista), a cafeterías con precio pactado y a clientes con descuento por volumen. Sin `lista_precio` + `cliente.lista_precio_id` + precio por cliente, el vendedor improvisará descuentos… que es justo lo que se quiere evitar.

### V-04 · No hay conversión de unidades de medida
Las recetas usan gramos y kilos de harina, litros de leche, unidades de huevo, bolsas de 50 kg. Si el stock está en kilos y la receta en gramos, sin `factor_conversion` y validación dimensional el kárdex se corrompe en la primera receta.

### V-05 · El kárdex no está diseñado como libro inmutable
La propuesta dice "movimiento de inventario (kárdex)" sin decir si se puede editar. Si los movimientos se editan o borran, **el CPP deja de ser auditable** y cualquier descuadre es irreparable. Debe ser *append-only* con asientos de reverso.

### V-06 · No se define la política de saldo negativo
¿Puede el almacén entregar 5 kg de harina cuando el sistema dice 3? Si la respuesta es "sí, siempre", el kárdex pierde sentido; si es "no, nunca", la producción se detiene por un error de carga. Hay que **decidirlo y parametrizarlo**, no descubrirlo en planta.

### V-07 · El CIF se prorratea mensualmente pero no hay cierre de período
Prorratear CIF exige cerrar el mes: calcular, asignar, congelar. Sin `periodo_costos` con estados (`ABIERTO → CALCULADO → CERRADO`), el margen del mes pasado cambia cada vez que alguien carga una factura de gas atrasada. El gerente perderá la confianza en el dashboard en la segunda semana.

### V-08 · No hay estrategia offline real
La propuesta reconoce el riesgo ("conectividad inestable en planta o almacén") y lo mitiga con *"reintentos automáticos"*. Eso no es una estrategia: si la tablet no tiene red, **no puede registrar la producción**. Y en una panadería se produce de madrugada, cuando la conexión es peor. Hace falta diseño offline-first con base local, cola de salida e idempotencia.

### V-09 · Falta idempotencia
Cada reintento del celular puede duplicar un movimiento de inventario, una venta o una cobranza. Es el bug más caro y más frecuente en apps móviles con red mala. Se resuelve con `Idempotency-Key` desde el primer endpoint, no después.

### V-10 · Falta el concepto de período y de secuencia documental
Los correlativos (`PED-2026-000123`) no aparecen en el modelo. Generados en el cliente, se duplican; generados mal en el servidor, dejan huecos. Necesitan secuencia transaccional.

### V-11 · No hay observabilidad ni criterios de operación
"Monitoreo de disponibilidad" aparece en el servicio mensual, pero no hay SLOs, ni alertas, ni procedimiento de restauración probado. Con S/ 150/mes no hay margen para descubrir en producción que el backup nunca se restauró.

### V-12 · El modelo no contempla compras, caja ni devoluciones
Compras (V/I-05), arqueo de caja para las ventas al contado del vendedor y devoluciones parciales de pedido son operaciones diarias de una panadería. No están en el alcance; si no se modelan ahora, el esquema habrá que migrarlo después con datos en producción.

### V-13 · La merma se aplica como recargo, no como pérdida de rendimiento — **sutil y caro**
La fórmula de la propuesta (§5.2) es `costo con merma = costo × (1 + %merma)`. Eso trata la merma como un *recargo* sobre el costo. Si se pierde el 3 % de las unidades producidas, el costo de las que sobreviven se **divide entre 0.97**, no se multiplica por 1.03: `1/(1−0.03) = 1.030928` frente a `1.03`.

La diferencia relativa es `m²/(1−m)`: **0.09 %** con merma del 3 % (invisible) pero **2.3 %** con merma del 15 % (tortas, hojaldre, productos de temporada). En esos productos el sistema mostraría un margen sistemáticamente mejor que el real — el error exacto que el gerente detecta cuando compara con su caja.

**Decisión:** se adopta `/(1−m)` en `06 §4.3`. La tabla de ejemplo del documento no cambia (ambos métodos dan S/ 0.90), y por eso el error pasó desapercibido.

---

## 5. Riesgos del proyecto (`R-xx`)

Escala de impacto: **Crítico** = pone en riesgo el cobro o el Go-live · **Alto** = obliga a rehacer trabajo · **Medio** = retrasa · **Bajo** = molesta.

| ID | Riesgo | Prob. | Impacto | Mitigación concreta |
|---|---|---|---|---|
| **R-01** | **El plazo de 22 días hábiles no alcanza para el alcance completo.** | Alta | Crítico | Ver §6. Recomendación: entregar por fases con alcance firmado, no prometer el 100 % en 30 días. |
| **R-02** | **Datos base (recetas, insumos, CIF) llegan tarde o incompletos.** Es el riesgo #1 del propio documento y sigue sin control real. | Alta | Crítico | Plantilla de importación validada + **importador CSV con previsualización y errores por fila**, entregado el día 1. Fecha límite dura el día 3 con acta. Sin datos, el motor de costeo no se puede probar. |
| **R-03** | **Rehacer el motor de costeo** porque las reglas se descubren durante el desarrollo. | Media | Crítico | Congelar las fórmulas y los casos de prueba dorados **antes** de programar (`06-MOTOR-DE-COSTEO.md`), validados por el gerente y por producción. |
| **R-04** | **Descuadre de inventario** por concurrencia o por saldo negativo. | Media | Crítico | Kárdex inmutable, CPP con bloqueo, verificación `saldo = Σ movimientos` diaria, alerta al gerente. |
| **R-05** | **La tablet de producción no funciona sin internet** y se registra la producción en papel. | Alta | Alto | Offline-first desde la primera versión de la app de Producción. Es la app que no puede fallar. |
| **R-06** | **Doble registro por reintentos** (venta o baja duplicada). | Alta | Alto | `Idempotency-Key` obligatorio en toda mutación + UUIDv7 generado en el dispositivo. |
| **R-07** | **Revisión de tiendas de apps** retrasa la entrega a clientes. | Media | Medio | APK interno + TestFlight para el Go-live; publicación en tiendas en paralelo, sin bloquear. |
| **R-08** | **UAT de 2 días** (19 y 20/11) insuficiente para 6 perfiles y 16 reportes. | Alta | Alto | UAT continua desde el sprint 2 con datos reales; el UAT formal valida, no descubre. |
| **R-09** | **Cambios de alcance durante la ejecución** (el gerente "ve" el dashboard y pide más). | Alta | Alto | Alcance firmado en H1 + control de cambios con cotización y fecha. Ya está previsto; hay que hacerlo cumplir. |
| **R-10** | **Margen del servicio mensual insostenible** (S/ 150 ≈ USD 40 para hosting + respaldos + soporte + actualizaciones). | Media | Alto | Dimensionar infraestructura en ≤ USD 25/mes y **limitar el soporte por escrito** (horas/mes incluidas). Ver `13-CALIDAD-Y-OPERACION.md §5`. |
| **R-11** | **El precio del desarrollo (S/ 3,000) no cubre el esfuerzo real.** | Alta | Crítico (para el proveedor) | Ver §6. Si se ejecuta igual, el equipo compensará con calidad, y el costo lo pagará Tanta en el año 2. |
| **R-12** | **Fuga de la receta maestra** (es el activo competitivo de Tanta). | Baja | Crítico | El vendedor y el cliente **nunca** ven costo ni receta; solo Admin y Gerente. Auditoría de accesos a recetas. Ver `08`. |
| **R-13** | **Incumplimiento de la Ley 29733** por tratar datos de clientes sin aviso de privacidad ni consentimiento. | Media | Alto | Artefactos legales + consentimiento en el registro. Ver `08 §6`. |
| **R-14** | **Dependencia de una sola persona** (el líder hace análisis, backend y UAT). | Alta | Alto | Documentación de contratos (OpenAPI) y pruebas automatizadas desde el día 1; el conocimiento no puede vivir en una cabeza. |
| **R-15** | **Pérdida de datos por backup no restaurado.** | Baja | Crítico | Ensayo de restauración **obligatorio** antes del Go-live; se documenta el tiempo real medido. |

---

## 6. La prueba del triángulo: alcance, precio y plazo

Aquí está la conversación incómoda que hay que tener antes de empezar.

### 6.1 El precio

S/ 3,000 ≈ **USD 800**. El alcance incluye, como mínimo:

| Componente | Esfuerzo realista (persona-día, equipo senior) |
|---|---|
| Descubrimiento, arquitectura, contratos, diseño UX/UI | 12–15 |
| Backend: auth/RBAC, maestros, recetas versionadas, precios | 15–20 |
| Backend: pedidos + OP + producción | 12–15 |
| Backend: inventario, kárdex CPP, compras | 12–15 |
| Backend: ventas, despacho, cobranza, CxC | 10–12 |
| Backend: motor de costeo + CIF + cierre de período | 12–15 |
| Backend: 16 reportes + dashboard + exportaciones | 15–18 |
| App móvil: 4 perfiles + offline + sync | 30–35 |
| Web admin: 4 módulos | 20–25 |
| QA, seguridad, despliegue, capacitación, documentación | 15–20 |
| **Total** | **≈ 155–190 persona-día** |

A **USD 800**, eso equivale a USD 4–5 por persona-día. **No es un proyecto: es una donación con cronograma.**

Aun con un equipo peruano a tarifas bajas (S/ 250–400 por persona-día), el esfuerzo realista cuesta **S/ 40,000 – 70,000**. La propuesta está cotizada al **5–8 %** de su costo real.

> **Esto no es un juicio sobre la honestidad del proveedor.** Es aritmética. Y tiene una consecuencia directa para Tanta: *lo que se compre a este precio no va a tener la calidad, la seguridad ni el soporte que el documento promete*. La decisión inteligente no es "exigir que se cumpla", es **redefinir el alcance a algo que sí se pueda entregar bien**.

### 6.2 El plazo

22 días hábiles con 3 personas ≈ 66 persona-día disponibles. El alcance mínimo real son ~155. **Faltan más de la mitad.**

El Gantt solo funciona si hay **5 personas dedicadas a tiempo completo** durante 30 días corridos, y aun así entrega un prototipo funcional, no un sistema en producción con auditoría, respaldos probados y seguridad verificada.

### 6.3 Las tres salidas posibles

| Salida | Qué pasa | Consecuencia |
|---|---|---|
| **A. Ajustar el alcance al plazo** | Se mantiene 30 días y S/ 3,000, pero se entrega un **piloto operativo**: 1 sucursal, flujo pedido→OP→baja→venta→cobranza, 4 reportes clave, sin offline completo ni 16 reportes. | Tanta recibe algo que funciona de verdad y el resto se cotiza por fase. **Es la salida más honesta si el precio no se puede mover.** |
| **B. Ajustar el plazo al alcance** | Mismo alcance, 10–12 semanas, mismo precio. | El proveedor pierde dinero y el resultado será mediocre. **No la recomiendo.** |
| **C. Ajustar el precio al alcance** (por fases) | Fase 1: núcleo del dinero, 6–8 semanas, precio justo. Fase 2: reportes completos, offline robusto, CIF cerrado. Fase 3: SUNAT, pasarela, compras, caja, multi-sucursal. | **Recomendada.** Cada fase se paga sola si el dashboard demuestra el margen recuperado. |

**Recomendación: C, ejecutada como A.** Es decir: renegociar el contrato en fases, y que la **Fase 1 sea un piloto que funcione de verdad** en el plazo corto, en lugar de un sistema a medias que no sirve ni para operar ni para demostrar valor.

### 6.4 El argumento comercial para Tanta

El piloto no se vende como "menos sistema", se vende como **"empezamos por donde está el dinero"**: si el sistema le muestra al gerente, en la semana 6, que el producto X tiene margen 8 % y el producto Y tiene 61 %, y que el cliente Z compra volumen con margen 4 %, el proyecto ya se pagó. Los reportes G-03 a G-13 y la integración SUNAT vienen después, cuando el hábito ya está instalado.

---

## 7. Veredicto

| Dimensión | Nota | Comentario |
|---|---|---|
| Visión de negocio | **9/10** | Entiende el problema real de una panadería mejor que la mayoría de propuestas del mercado. |
| Alcance funcional | **7/10** | Completo en lo esencial; le faltan listas de precio, compras, devoluciones y caja. |
| Arquitectura técnica | **6/10** | Correcta en la forma (3 capas, API única, reglas en servidor) pero **sin las decisiones que evitan rehacer trabajo**: versionado, ledger inmutable, offline, idempotencia, cierre de período. |
| Modelo de datos | **5/10** | Nombra las entidades principales, omite las que sostienen la trazabilidad (requisición, compra, versión de receta, precio, notificación). |
| Seguridad | **5/10** | Menciona lo correcto (JWT, hash, RBAC, auditoría, Ley 29733) pero sin diseño: no hay modelo de amenazas, ni scoping, ni field-level security, ni respuesta a incidentes. |
| Viabilidad precio/plazo | **2/10** | El alcance no cabe ni en el precio ni en el plazo. |
| **Global** | **6/10** | **Una buena idea mal dimensionada.** Vale la pena construirla — con otro plan. |

---

## 8. Qué cambia este dossier respecto a la propuesta

1. **Se versiona todo lo que afecta al dinero**: receta, precio, costo, parámetros de IGV, umbral de margen.
2. **El inventario pasa a ser un libro inmutable** con verificación diaria de integridad.
3. **Se añade lo que falta para operar**: listas de precio, compras, devoluciones, autorización de descuentos, notificaciones persistentes.
4. **Offline real** en la app de Producción, Almacén y Vendedor, con cola de salida e idempotencia extremo a extremo.
5. **El CIF se cierra por período**, con CIF provisional visible y definitivo al cierre.
6. **Se define un plan por fases** con criterio de salida por fase, en lugar de un Gantt de 22 días que no se puede cumplir.
7. **Se documenta la seguridad como diseño**, no como lista de intenciones, incluido el cumplimiento de la Ley 29733 y su Reglamento (D.S. 016-2024-JUS).

---

**Siguiente lectura:** `02-ARQUITECTURA.md` (la solución completa) → `03-STACK-Y-DECISIONES.md` (con qué se construye y por qué).
