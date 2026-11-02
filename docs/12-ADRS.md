# 12 · Registro de decisiones de arquitectura (ADRs)

> Una decisión sin registro se vuelve a discutir cada tres semanas. Cada ADR sigue el formato
> *contexto → decisión → consecuencias → alternativas descartadas*.
> **Estado:** `Aceptada` · `Sustituida por ADR-nnn` · `En revisión`.

---

## Índice

| ADR | Título | Estado |
|---|---|---|
| 001 | Monolito modular en lugar de microservicios | Aceptada |
| 002 | Flutter para la app móvil | Aceptada (revisable) |
| 003 | PostgreSQL como única fuente de verdad | Aceptada |
| 004 | Inventario como libro append-only | Aceptada |
| 005 | Versionado de recetas y congelamiento de costo | Aceptada |
| 006 | Aritmética decimal exacta, nunca coma flotante | Aceptada |
| 007 | pg-boss en lugar de Redis | Aceptada |
| 008 | Offline-first con Drift + outbox | Aceptada |
| 009 | Idempotencia obligatoria en toda mutación | Aceptada |
| 010 | CIF con período y cierre formal | Aceptada |
| 011 | SPA con Vite en lugar de Next.js | Aceptada |
| 012 | Un VPS con Docker Compose, sin Kubernetes | Aceptada |
| 013 | Contrato OpenAPI primero y clientes generados | Aceptada |
| 014 | Listas de precio desde el día 1 | Aceptada |
| 015 | Auditoría con cadena de hash | Aceptada |
| 016 | Multi-sucursal modelado desde el inicio | Aceptada |
| 017 | Rechazo de event sourcing y CQRS completo | Aceptada |

---

## ADR-001 · Monolito modular en lugar de microservicios

**Estado:** Aceptada · **Fecha:** 01/11/2026

**Contexto.** El sistema tiene 16 contextos de negocio, 6 perfiles, un VPS y un presupuesto mensual de
S/ 150. El equipo es de 3–4 personas. El volumen es de ~250 pedidos/día y ~20 usuarios concurrentes.

**Decisión.** Un solo despliegue NestJS con módulos aislados por frontera de datos. Comunicación entre
módulos por llamadas a casos de uso públicos o por eventos de dominio persistidos en la misma base.

**Consecuencias.**
- ✅ Una transacción de PostgreSQL abarca pedido + inventario + venta: consistencia sin sagas.
- ✅ Un despliegue, un log, un pipeline, un backup. Costo operativo mínimo.
- ✅ Refactorizar un límite entre módulos es mover una carpeta, no un contrato de red.
- ⚠️ El monolito puede degradarse si no se hace cumplir la regla de dependencia → `eslint-plugin-boundaries` en CI, bloqueante.
- ⚠️ Un bug en un módulo puede tumbar todo el proceso → mitigado con manejo de errores por request y health checks.

**Alternativas descartadas.** Microservicios (complejidad operativa desproporcionada); serverless
(conexiones a BD y bloqueo transaccional); módulos sin fronteras ("`src/` plano") — es lo que produce el
archivo de 3,000 líneas a los seis meses.

---

## ADR-002 · Flutter para la app móvil

**Estado:** Aceptada, **revisable antes de la semana 1** · **Fecha:** 01/11/2026

**Contexto.** Se necesitan 4 perfiles en Android, iOS y tablet. El perfil Producción exige offline real.
El stack ya fue presentado al cliente con Flutter. El equipo podría ser 100 % TypeScript.

**Decisión.** Flutter + Riverpod + Drift. Una sola app con navegación por rol.

**Consecuencias.**
- ✅ Un código para Android/iOS/tablet; layout de tablet controlado al píxel.
- ✅ Drift da SQLite tipado y migraciones: la base del offline.
- ✅ Rendimiento estable en tablets de gama media (las que se compran en Perú).
- ⚠️ Dart es un lenguaje adicional para un equipo TypeScript → curva de 1–2 semanas.
- ⚠️ Sin OTA nativo: corregir un bug exige tienda o Shorebird (de pago).

**Alternativas descartadas.** React Native + Expo (puntúa más alto en contratación y OTA, pero cambiar
el stack presentado cuesta credibilidad; si el equipo no tiene Dart en producción, **se cambia aquí y se
registra como ADR nuevo**); apps nativas separadas (duplica el equipo); PWA (no accede a cámara/escáner
con la solidez necesaria ni da la experiencia de tablet requerida).

---

## ADR-003 · PostgreSQL como única fuente de verdad

**Estado:** Aceptada · **Fecha:** 01/11/2026

**Contexto.** El sistema necesita transacciones multi-entidad (venta + inventario + CxC), aritmética
exacta, bloqueo de fila para el CPP, consultas analíticas para 16 reportes y respaldo con punto en el tiempo.

**Decisión.** PostgreSQL 17 como única base de datos. Sin caché externo, sin motor de reportes separado,
sin almacén documental.

**Consecuencias.**
- ✅ `numeric` exacto, `FOR UPDATE`, `REPEATABLE READ`, vistas materializadas, JSONB, PITR con WAL.
- ✅ Una sola cosa que respaldar, restaurar y asegurar.
- ⚠️ Los reportes compiten con la operación → mitigado con vistas materializadas y refresco programado.
- ⚠️ A 5 M de filas en el kárdex habrá que particionar → previsto para el año 2–3.

**Alternativas descartadas.** MongoDB (sin transacciones relacionales cómodas; el CPP es una operación
transaccional por definición); MySQL (pierde JSONB, MV y ecosistema); Firebase (no hay consultas
relacionales para el margen por producto).

---

## ADR-004 · Inventario como libro append-only

**Estado:** Aceptada · **Fecha:** 01/11/2026

**Contexto.** El kárdex es la base del costo y del margen. En la propuesta original aparece como
"movimiento de inventario" sin definir si se puede editar. Si se edita, el CPP deja de ser auditable y
cualquier descuadre es irreparable.

**Decisión.** `movimiento_inventario` es inmutable: solo `INSERT`. Las correcciones se hacen con un
asiento de reverso que referencia al original. El stock y el CPP se derivan y se persisten como saldo
corriente en cada movimiento.

**Consecuencias.**
- ✅ El kárdex es auditable: se puede reconstruir el saldo de cualquier fecha.
- ✅ Un error del operario se corrige con trazabilidad, no borrando la evidencia.
- ✅ La verificación `saldo = Σ movimientos` es trivial y se puede automatizar.
- ⚠️ La tabla crece indefinidamente (~20k filas/mes; manejable durante años).
- ⚠️ Los reportes deben leer el último saldo, no sumar todo → índice por `(item, creado_en DESC)`.

**Alternativas descartadas.** Campo `stock` editable en la tabla de producto (imposible de auditar);
soft-delete de movimientos (rompe la suma y permite ocultar faltantes).

---

## ADR-005 · Versionado de recetas y congelamiento de costo

**Estado:** Aceptada · **Fecha:** 01/11/2026

**Contexto.** La propuesta congela el costo en la línea de venta (correcto), pero **no versiona la
receta**. Si la receta cambia en diciembre, cualquier recálculo de noviembre usa la receta nueva y miente.

**Decisión.** Cada versión de una receta es **una fila nueva** en `core.receta` (`producto_id`, `version`,
`estado BORRADOR → VIGENTE → OBSOLETA`), con un índice único parcial que garantiza **una sola versión
VIGENTE por producto**. La orden de producción referencia `receta_id` (la versión concreta). La venta
congela `costo_unitario` en `venta_detalle` y el desglose en el snapshot de costo del lote.
El DDL exacto está en `04-MODELO-DE-DATOS.md §Bloque 03`.

**Consecuencias.**
- ✅ La historia no cambia: el margen de una venta de octubre es el mismo en octubre y en marzo.
- ✅ Se puede comparar la rentabilidad de dos versiones de la misma receta (¿mejoró la nueva fórmula?).
- ⚠️ Más tablas y una regla que el equipo debe respetar: **nunca** leer "la receta actual" para calcular algo pasado.
- ⚠️ Editar una receta aprobada crea una versión nueva, no modifica la anterior. Hay que enseñarlo en la capacitación.

**Alternativas descartadas.** Recalcular el costo histórico con la receta actual (corrompe la
contabilidad); duplicar el producto al cambiar la receta (explota el catálogo).

---

## ADR-006 · Aritmética decimal exacta, nunca coma flotante

**Estado:** Aceptada · **Fecha:** 01/11/2026

**Contexto.** Un costo unitario de S/ 0.000123 por gramo, multiplicado por 12,500 unidades y sumado en
cientos de líneas, con `float` produce diferencias de céntimos que el gerente detecta y que destruyen la
confianza en el dashboard.

**Decisión.** `NUMERIC(18,6)` para costos y cantidades, `NUMERIC(16,4)` para importes, `NUMERIC(9,6)`
para porcentajes. En TypeScript `Prisma.Decimal`/`decimal.js`; en Dart paquete `decimal`. Redondeo
`ROUND_HALF_UP` solo en los puntos declarados en `06 §Redondeo`.

**Consecuencias.**
- ✅ Los totales cuadran al céntimo con la calculadora del gerente.
- ✅ Los reportes y las ventas usan la misma función: no hay dos verdades.
- ⚠️ Más verboso que `number`; requiere disciplina del equipo y una regla de lint que prohíba `parseFloat` en el dominio.

**Alternativas descartadas.** Enteros de céntimos (no representan costos unitarios con 6 decimales sin
escalado manual, que es una fuente clásica de error); `float`/`double` (inaceptable en dinero).

---

## ADR-007 · pg-boss en lugar de Redis

**Estado:** Aceptada · **Fecha:** 01/11/2026

**Contexto.** Se necesitan jobs: envío de push, generación de PDF/Excel, cierre de período, verificación
de kárdex. La opción habitual es Redis + BullMQ.

**Decisión.** `pg-boss`, cola sobre PostgreSQL, en el mismo VPS.

**Consecuencias.**
- ✅ **Una pieza menos que operar, respaldar, asegurar y monitorear.** En un VPS único, eso importa.
- ✅ Encolar un job dentro de la transacción de negocio: si hay rollback, el job no se envía. Con Redis eso es un outbox manual.
- ✅ Los jobs sobreviven al reinicio sin configuración extra de persistencia.
- ⚠️ Rendimiento inferior a Redis → irrelevante a esta escala (decenas de jobs/hora).
- ⚠️ La cola compite con la carga de la BD → vigilancia del `work_mem` y del vacuum.

**Alternativas descartadas.** BullMQ + Redis (una dependencia más sin beneficio a esta escala); cron
puro (sin reintentos ni visibilidad de fallos); SQS (costo y latencia innecesarios).

---

## ADR-008 · Offline-first con Drift + outbox

**Estado:** Aceptada · **Fecha:** 01/11/2026

**Contexto.** La propuesta identifica "conectividad inestable en planta o almacén" y la mitiga con
"reintentos automáticos". Reintentar no sirve si la tablet nunca recibió la respuesta: en una panadería
se produce de madrugada, cuando la conexión es peor.

**Decisión.** Drift (SQLite) como fuente de verdad local en Producción, Almacén y Vendedor. Toda
mutación se escribe primero localmente en una tabla `outbox` y se sincroniza con `Idempotency-Key`.
Catálogo, precios y recetas se descargan al iniciar sesión y se refrescan por cursor.

**Consecuencias.**
- ✅ La tablet sigue operando sin red; el usuario nunca pierde un registro.
- ✅ La UX es inmediata: no hay spinner esperando al servidor.
- ⚠️ Complejidad real: resolución de conflictos, migraciones locales, pruebas de sync.
- ⚠️ El costo no es en la app, es en el backend: hay que construir `/sync/push` y `/sync/pull` bien desde el inicio.

**Alternativas descartadas.** Solo online (la producción se detiene cuando falla el WiFi); caché de solo
lectura (no resuelve el registro de producción); base de datos replicada (sobredimensionado).

---

## ADR-009 · Idempotencia obligatoria en toda mutación

**Estado:** Aceptada · **Fecha:** 01/11/2026

**Contexto.** El reintento de un celular con red mala es el camino más corto a una venta duplicada o a
una baja de inventario doble. Es el bug más caro del proyecto porque corrompe el kárdex y las cuentas por cobrar.

**Decisión.** `Idempotency-Key` (UUIDv7 generado en el cliente) obligatorio en `POST`/`PUT`/`PATCH` de
negocio. Tabla `core.idempotencia` con `UNIQUE(clave, usuario_id)`, TTL de 72 h, y respuesta cacheada
del primer intento.

**Consecuencias.**
- ✅ Un doble envío devuelve la misma respuesta, no crea un segundo registro.
- ✅ La app puede reintentar agresivamente sin miedo.
- ⚠️ Hay que definir el TTL y el purgado (job diario).
- ⚠️ El cliente debe generar la clave antes de enviar, no en el interceptor (si no, cada reintento tiene clave nueva y no sirve).

**Alternativas descartadas.** Deduplicación por "misma venta en 5 segundos" (heurística frágil);
confiar en que el cliente no reintente (falso siempre).

---

## ADR-010 · CIF con período y cierre formal

**Estado:** Aceptada · **Fecha:** 01/11/2026

**Contexto.** Los costos indirectos (gas, energía, alquiler) se conocen a fin de mes, pero el margen se
consulta a diario. Sin un concepto de período, cada factura cargada tarde reescribe el margen del mes pasado.

**Decisión.** `periodo_costos` mensual con estados `ABIERTO → CALCULADO → CERRADO` (y reapertura solo
por ADMIN, auditada). Durante el mes se usa una **tasa CIF provisional**; al cerrar se calcula la
**definitiva** y se congela. El dashboard indica si el margen es `PROVISIONAL` o `DEFINITIVO`.

**Consecuencias.**
- ✅ El gerente sabe cuándo el número es estimado y cuándo es final. Transparencia > falsa precisión.
- ✅ La historia financiera no se mueve sola.
- ⚠️ Dos números posibles para el mismo producto según el período → hay que rotularlo en la UI sin ambigüedad.
- ⚠️ El cierre requiere un proceso mensual disciplinado (responsable designado).

**Alternativas descartadas.** Recalcular siempre (el margen histórico cambia y nadie confía);
no prorratear (el costo queda subestimado y el margen, inflado).

---

## ADR-011 · SPA con Vite en lugar de Next.js

**Estado:** Aceptada · **Fecha:** 01/11/2026

**Contexto.** La plataforma web es una herramienta interna de administración, tras login. No hay
contenido público, no hay SEO, no hay necesidad de render en servidor.

**Decisión.** React 19 + Vite, servida como estáticos por Caddy. Sin Next.js.

**Consecuencias.**
- ✅ Arranque de desarrollo instantáneo; build simple; un contenedor menos.
- ✅ El frontend es un artefacto estático: se puede cachear en CDN.
- ⚠️ Sin SSR: la primera carga depende del JS → mitigado con code-splitting por módulo.
- ⚠️ Si en el futuro se necesita una página pública (catálogo SEO), se hará aparte.

**Alternativas descartadas.** Next.js (SSR que nadie usa, con más complejidad de despliegue); Angular
(curva y peso innecesarios para el equipo); plantillas de administración cerradas (lock-in y difícil de adaptar al modelo de costos).

---

## ADR-012 · Un VPS con Docker Compose, sin Kubernetes

**Estado:** Aceptada · **Fecha:** 01/11/2026

**Contexto.** Un servidor, ~20 usuarios concurrentes, presupuesto de S/ 150/mes y un equipo de 3 personas
que también hace soporte.

**Decisión.** Un VPS (4 vCPU / 8 GB) con Docker Compose, Caddy para TLS y despliegue por SSH desde
GitHub Actions.

**Consecuencias.**
- ✅ Costo de ~USD 9–24/mes; operación comprensible por una sola persona.
- ✅ Recuperación documentada en un runbook de 10 líneas.
- ⚠️ Punto único de falla → aceptado con RTO de 4 h y backup verificado; se reevalúa si hay dos caídas largas.
- ⚠️ Sin autoescalado → innecesario a este volumen (el dimensionamiento tiene margen ×5).

**Alternativas descartadas.** Kubernetes (complejidad desproporcionada; el costo de operarlo supera el
del proyecto); PaaS gestionado tipo Heroku/Render (más caro por GB y con menos control de Postgres);
plataformas serverless (cold start y conexiones).

---

## ADR-013 · Contrato OpenAPI primero y clientes generados

**Estado:** Aceptada · **Fecha:** 01/11/2026

**Contexto.** Tres corrientes (backend, web, móvil) trabajan en paralelo y, si se usan agentes de IA,
también en paralelo entre sí. Sin un contrato explícito, la integración final es un evento traumático.

**Decisión.** El OpenAPI se escribe y se versiona en `packages/contracts/openapi.json`. De ahí se generan
los tipos de TypeScript (web) y el cliente Dart (móvil). El contrato se modifica por PR con revisión; la
API se valida contra él en CI (test de contrato).

**Consecuencias.**
- ✅ La web y la app trabajan contra un mock desde el día 2, sin esperar al backend.
- ✅ Un cambio de contrato rompe la build, no la producción.
- ⚠️ Requiere disciplina: el contrato no se "genera al final desde el código".
- ⚠️ NestJS genera OpenAPI desde decoradores; hay que fijar el archivo generado y comparar en CI para detectar cambios no intencionados.

**Alternativas descartadas.** Tipos escritos a mano en tres sitios (deriva garantizada); GraphQL
(sobredimensionado para pantallas conocidas).

---

## ADR-014 · Listas de precio desde el día 1

**Estado:** Aceptada · **Fecha:** 01/11/2026 · **Origen:** `[AMPLIACIÓN]` sobre la propuesta

**Contexto.** La propuesta asume un precio único por producto. Una panadería real vende a mostrador, a
bodegas (mayorista), a cafeterías con precio pactado y a clientes con descuento por volumen. Sin listas
de precio, el vendedor improvisa descuentos — exactamente lo que el sistema quiere evitar.

**Decisión.** `lista_precio` (minorista, mayorista, especial) + `producto_precio` con vigencia +
`cliente.lista_precio_id` + precio específico por cliente. `descuento_maximo` por rol.

**Consecuencias.**
- ✅ El descuento deja de ser una decisión personal y pasa a ser una regla auditable.
- ✅ El margen por cliente se vuelve comparable entre clientes.
- ⚠️ Más tablas y más UI; el administrador debe mantener las listas.
- ⚠️ Regla de precedencia clara: precio de cliente > precio de lista > precio base.

**Alternativas descartadas.** Un solo precio con "descuento manual" (fuga de margen y cero trazabilidad).

---

## ADR-015 · Auditoría con cadena de hash

**Estado:** Aceptada · **Fecha:** 01/11/2026

**Contexto.** Los eventos críticos (cambio de precio, costo, receta, baja de inventario, anulación,
descuento) deben ser prueba ante una discrepancia entre el proveedor y el cliente, o ante un despido
conflictivo. Un log que se puede editar no es prueba.

**Decisión.** `audit.evento` append-only con `hash_anterior` y `hash_actual` (SHA-256 sobre el contenido
canónico + hash anterior). Job diario que verifica la cadena y alerta si se rompe.

**Consecuencias.**
- ✅ Manipular un evento obliga a recalcular toda la cadena posterior: detectable.
- ✅ Protege a ambas partes: al proveedor de acusaciones de manipulación y a Tanta de un empleado que altere registros.
- ⚠️ Escritura adicional por operación (coste bajo, ~1 ms).
- ⚠️ La cadena crece; se archiva por año en tablas separadas sin romper el encadenamiento.

**Alternativas descartadas.** Log en archivo (se borra, se rota); solo `created_by` (no prueba nada).

---

## ADR-016 · Multi-sucursal modelado desde el inicio

**Estado:** Aceptada · **Fecha:** 01/11/2026 · **Origen:** `[AMPLIACIÓN]`

**Contexto.** Hoy hay una sola sucursal. Añadir `sucursal_id` después, con datos en producción, implica
migrar todas las tablas, todos los índices y todos los reportes.

**Decisión.** `sucursal` existe desde la primera migración con un único registro; todas las tablas de
negocio llevan `sucursal_id NOT NULL`, aunque la UI no lo muestre.

**Consecuencias.**
- ✅ Abrir un segundo local es activar la UI, no migrar la base.
- ✅ Los reportes ya pueden filtrar por sucursal desde el inicio (aunque devuelvan una).
- ⚠️ Ruido en el modelo para un caso que quizá no ocurra → coste de 1 hora ahora vs. 2 semanas después.

**Alternativas descartadas.** Añadirlo "cuando haga falta" (el momento en que hace falta es el peor momento).

---

## ADR-017 · Rechazo de event sourcing y CQRS completo

**Estado:** Aceptada · **Fecha:** 01/11/2026

**Contexto.** Existe la tentación de aplicar patrones "modernos" porque el dominio tiene eventos
(pedido creado, OP terminada, venta registrada).

**Decisión.** Se usa **event log de dominio** (`pedido_evento`, `audit.evento`) como *registro de lo que
pasó*, pero el estado se guarda en tablas relacionales normales. Sin reconstrucción de estado por replay,
sin proyecciones separadas, sin bus de eventos.

**Consecuencias.**
- ✅ Depuración directa: se mira la tabla y se ve el estado actual.
- ✅ Reportes con SQL normal, sin mantener proyecciones.
- ✅ Menos código y menos conceptos que enseñar al equipo de 3 personas.
- ⚠️ Se pierde el "viaje en el tiempo" completo → innecesario: la auditoría y el kárdex ya cubren la trazabilidad exigida.

**Alternativas descartadas.** Event sourcing completo (complejidad muy superior al valor); CQRS con
proyecciones (dos modelos que mantener para 16 reportes que SQL resuelve).

---

## ADR-018 · Implementación de referencia del backend

**Estado:** Aceptada · **Fecha:** 01/11/2026 · **Sustituye parcialmente:** D-02 (stack) y D-07 (hashing)

**Contexto.** El contrato fija NestJS + Prisma + PostgreSQL y Argon2id. Al construir la primera vertical
completa aparecieron tres decisiones de implementación que conviene registrar antes de que el equipo las
descubra y las "arregle" de forma distinta en cada módulo:

1. **NestJS aporta estructura** (módulos, DI, guards) pero con 11 módulos genera mucho andamiaje. El
   valor del monolito modular está en la **frontera**, no en el framework.
2. **Prisma** añade un motor binario y una capa de traducción; para consultas de dinero con agregaciones
   (`numeric`, `FOR UPDATE`, CTE) el SQL directo es más corto y más auditable.
3. **Argon2id** requiere un módulo nativo compilado. En Windows con OneDrive y en contenedores sin
   toolchain, eso rompe la instalación.

**Decisión.**
- **Fastify 5** con módulos por contexto (`src/routes/*`), mismo principio: un módulo no importa el
  interior de otro y la autorización se evalúa en el caso de uso (`exigir(req, reply, permiso)`).
- **SQL directo con `pg`** y migraciones en SQL versionado (`db/migrations/*.sql`), aplicadas por un
  migrador propio idempotente con checksum y transacción por archivo.
- **`scrypt` de Node** (`N=16384, r=8, p=1`) con sal por usuario y comparación en tiempo constante, en
  formato `scrypt$sal$hash` que permite migrar a Argon2id más adelante sin invalidar contraseñas.

**Consecuencias.**
- ✅ Instalación sin dependencias nativas: `pnpm install` funciona en Windows, Linux y contenedores.
- ✅ El esquema es legible y el `EXPLAIN` se lee sin intermediarios; los índices del dossier se aplican tal cual.
- ✅ Bundle más pequeño (Fastify ≈ 1 MB frente a NestJS ≈ 4 MB) y arranque más rápido.
- ⚠️ Se pierden los decoradores de NestJS para OpenAPI automático → el contrato se documenta en `05` y,
  cuando haga falta, se genera con `@fastify/swagger` anotando los esquemas de ruta.
- ⚠️ Sin ORM, el mapeo fila → objeto es manual → mitigado con los tipos de `db.ts` y las pruebas de contrato.
- ⚠️ `scrypt` es sólido pero no es el estándar recomendado para 2026 (Argon2id sí). El formato de hash
  incluye el algoritmo, así que la migración es un `UPDATE` por usuario en el próximo inicio de sesión.

**Alternativas descartadas.** Mantener NestJS + Prisma + Argon2id (correcto sobre el papel, pero frena la
primera vertical y añade un punto de fallo en la instalación); Drizzle (más cerca del SQL, pero añade una
capa que aquí no aporta).

---

## Plantilla para nuevos ADRs

```markdown
## ADR-0nn · Título

**Estado:** Propuesta | Aceptada | Sustituida por ADR-0xx · **Fecha:** dd/mm/aaaa

**Contexto.** Qué problema hay que resolver y qué restricciones existen.

**Decisión.** Qué se decide, en una frase imperativa.

**Consecuencias.** ✅ beneficios · ⚠️ costos y riesgos asumidos.

**Alternativas descartadas.** Qué se evaluó y por qué no.
```

---

## ADR-019 · Argon2id, cookie HttpOnly y segundo factor

**Estado:** aceptado · **Fecha:** 2026-11-01

### Contexto
La auditoría dejó tres deudas: `scrypt` en lugar del estándar actual, el token de refresco
guardado en `localStorage` (un XSS se lleva la sesión) y la ausencia de segundo factor en
los perfiles que mueven dinero, precios y usuarios.

### Decisión

1. **Argon2id** (`m=65536, t=3, p=1`) mediante `@noble/hashes`, que es JavaScript puro y no
   exige compilar módulos nativos en Windows, Linux ni en la imagen Docker.
   El prefijo del hash identifica el algoritmo, de modo que las cuentas antiguas con `scrypt`
   se verifican igual y **se reescriben a Argon2id en su siguiente inicio de sesión**, sin
   invalidar contraseñas ni obligar a un reseteo masivo.
2. **Refresco en cookie `HttpOnly; SameSite=Strict; Secure`** (en producción), con `path`
   limitado a `/api/v1/auth`. El token de acceso sigue en memoria; el refresco ya no es
   accesible desde JavaScript. La rotación y la detección de reuso no cambian.
3. **TOTP (RFC 6238)** para Gerencia y Administración. En producción es obligatorio; el
   enrolamiento ocurre en el primer inicio de sesión y el secreto nunca se devuelve después.
   Los códigos de recuperación se guardan hasheados.
4. **Bloqueo por cuenta** (`core.intento_login`), porque el límite por IP no detiene a quien
   rota direcciones. Ocho fallos bloquean 15 minutos.
5. **Tiempo de respuesta constante**: si el usuario no existe se verifica contra un hash
   señuelo, para no revelar qué cuentas existen midiendo latencias.

### Consecuencias
- Cada inicio de sesión cuesta ~300–500 ms más por Argon2id. Es el precio correcto: el login
  es infrecuente y la resistencia a GPU/ASIC es mucho mayor.
- El cliente web debe enviar `credentials: 'include'`; se documenta en `core/api.ts`.
- Sin HTTPS, `Secure` impide la cookie: el despliegue exige TLS (ya lo hace Caddy).

---

## ADR-020 · Cola offline en el móvil

**Estado:** aceptado · **Fecha:** 2026-11-01

### Contexto
En el mostrador el WiFi falla. Si la app dependiera de la red para cobrar, el vendedor
anotaría en papel y alguien tendría que reconstruir la caja al final del día. Eso es
exactamente lo que el sistema debe evitar.

### Decisión
1. **Toda mutación se escribe primero en disco** (`shared_preferences`, JSON) y después se
   intenta enviar. La pantalla nunca miente: si no salió, el usuario ve la franja ámbar.
2. **La clave de idempotencia se genera al encolar** y no cambia en los reintentos. El
   servidor reconoce la operación y devuelve la original: reintentar cinco veces cobra una.
3. **Se descarta solo lo que no tiene arreglo.** Un 4xx de negocio (saldo excedido, pedido
   inexistente) se quita de la cola y se avisa; un 5xx, un 429 o la falta de red se reintentan.
4. **Orden estricto.** Si falla una operación, no se adelanta la siguiente: la caja se
   reconstruye en la secuencia en que ocurrió.
5. **Una operación en vuelo se ve.** La franja muestra cuántas hay y permite reintentar a mano.
6. **Sincronización automática mientras la app está abierta:** cada 20 segundos si hay pendientes y
   al volver a primer plano (AppLifecycleState.resumed). No hace falta que el vendedor pulse nada.
7. **La política de descarte se prueba.** Con el transporte inyectado se verifica que sin red se
   conserva, que un 4xx de negocio se descarta y que un 503 se reintenta después.

### Consecuencias
- El usuario puede cobrar sin red; el saldo se descuenta en pantalla para no cobrar dos veces
  al mismo cliente, y se concilia al sincronizar.
- El servidor debe seguir siendo idempotente: está cubierto por prueba
  (`un cobro reenviado con la misma clave no se aplica dos veces`).
- El navegador no recibe el token de refresco en el cuerpo (va en cookie `HttpOnly`); la app
  nativa sí, porque necesita guardarlo en el almacén seguro del sistema. Se distinguen por la
  cabecera `Origin`, que solo envía el navegador.
