# 13 · Calidad, CI/CD y Operación — Tanta

> **Estado:** normativo para las áreas de prueba, entrega y operación.
> **Subordina a:** `00-CONTEXTO-Y-DECISIONES.md`. Si este documento contradice el contrato, gana el contrato.
> **Base:** Informe Ejecutivo v1.0 (21/10/2026), §6 Cronograma (F1–F7, H1–H5) y §8 Riesgos.
> **Fecha:** 01/11/2026 · **Responsable:** QA Lead / SRE
> **Supuestos económicos:** USD/PEN = **3.78** (fijo para todo el documento). Zona `America/Lima`.
> **Convención:** `[AMPLIACIÓN]` = no está en la propuesta · `[CORRECCIÓN]` = contradice la propuesta.

---

## 0. Decisiones que cierra este documento

| ID | Decisión | Motivo |
|---|---|---|
| D13-01 | El **dominio de costeo** se prueba por unidad hasta ≥ 90 % de ramas; es la única capa con esa exigencia. | Es dinero. Un error de 0.01 en el CPP se propaga a todo el kárdex. |
| D13-02 | **Testcontainers PostgreSQL 17** en local; **service container** en CI. El mismo fixture decide cuál usar. | Contenedor local = fidelidad; servicio en CI = 40 s más rápido y sin Docker-in-Docker. |
| D13-03 | El **kárdex guarda `valor` como fuente de verdad** (importe del movimiento) y `costo_unitario_movimiento` como derivado; el saldo valorizado (`saldo_valor`) nunca se recalcula como `cpp × saldo_cantidad`. | `1220/300 = 4.066667` y `300 × 4.066667 = 1220.0001`. La multiplicación no cierra. Ver QA-01. |
| D13-04 | **Tanta opera con la política estricta** (`inventario.permite_saldo_negativo = false`, `07 §6.1`) y eso se verifica en tres sitios: la función de asiento (no un `if` de aplicación), **QA-02** en CI y el job de integridad de `07 §8`. **No se añade `CHECK (saldo_cantidad >= 0)`**: rompería la política permisiva y el `ck_saldo_coherencia` que documenta `07 §6.2`. `[CORRECCIÓN]` a mi primera lectura. | Un invariante de dinero no puede depender solo del código; pero la constraint lo congelaría mal. La garantía es la política + la prueba + el job de reconciliación. |
| D13-05 | **Staging vive en el mismo VPS que producción**, con Postgres propio, límites de cgroup y `docker compose stop` fuera de ventana de deploy. | Un segundo VPS de USD 6–8 se come el 40 % del margen mensual. Riesgo aceptado y acotado. |
| D13-06 | **Blue/green por puerto con dos servicios** (`api-blue`, `api-green`) y Caddy con health checks. Cero downtime en deploy. | Habilita el runbook (e) de hotfix a las 07:00 sin cortar la producción del día. |
| D13-07 | **La migración Prisma corre ANTES del código nuevo**, siempre aditiva (*expand/contract*). `[CORRECCIÓN]` al orden pedido en el encargo y al implícito en la propuesta. | El código viejo debe seguir funcionando contra el esquema nuevo; al revés no hay vuelta atrás sin restaurar. |
| D13-08 | **WAL-G + PITR** con RPO de 5 min; el `pg_dump` diario se mantiene como segunda línea y para restaurar objetos sueltos. | La propuesta promete "restauración probada"; un dump diario solo da RPO de 24 h. `[AMPLIACIÓN]` |
| D13-09 | **Caddy reemplaza a Nginx.** `[CORRECCIÓN]` al §4.2 de la propuesta. | Ya decidido en D-02. TLS automático sin cron de certbot. |
| D13-10 | **Un solo proceso Node** con pg-boss embebido (pool de 4 conexiones). Se separa a contenedor `worker` cuando la edad p95 de los jobs supere 30 s. | A 200 pedidos/día un worker separado es 200 MB de RAM regalados. |
| D13-11 | **La BD se niega a arrancar** si `shared_buffers` + conexiones exceden el límite del contenedor. | Es la causa #1 de OOM en VPS pequeños con Postgres. |
| D13-12 | **Sentry free tier** con `tracesSampleRate: 0.05`. Sin Prometheus/Grafana/Loki. | Un stack de observabilidad propio cuesta más RAM que la API y no cabe en S/ 150. |
| D13-13 | **SLO de disponibilidad diferenciado**: 99.5 % mensual global y **99.9 % entre 04:00–12:00** (ventana de producción). | El error budget no puede ser uniforme: una caída a las 03:00 no cuesta lo mismo que a las 07:00. |
| D13-14 | **El smoke test de producción es de solo lectura.** Las escrituras se prueban en staging. | Un smoke que crea pedidos en producción contamina el margen del mes. |
| D13-15 | **Cronograma de 22 días hábiles: NO viable al alcance declarado.** Se entrega MVP-1 el 24/11 y MVP-2 el 11/12/2026. | **220 persona-día** de esfuerzo contra **~108** disponibles (factor 2.0×; 2.5× descontando la rampa). §9.1. |
| D13-16 | **Recorte por riesgo, no por gusto.** El orden de recorte lo fija: radio de impacto en dinero → profundidad de dependencia → reversibilidad → visibilidad. | §9.2. |
| D13-17 | **La panadería debe poder operar sin el sistema.** Formulario de contingencia en papel, obligatorio en el go-live. | Es el único control que sobrevive a un RTO de 45 min a las 06:30. |
| D13-18 | **S/ 150/mes no cubre el servicio prometido**: solo el alojamiento. Reprecio propuesto: S/ 220 desde el mes 13 o tope de 3 h/mes. | Margen bruto de S/ 67.4/mes = 2.7 h de trabajo. §5.6. |
| D13-19 | **Toda mutación exige `Idempotency-Key`** y su reuso con cuerpo distinto es 409, no 200. | La sincronización móvil reintenta por diseño (D-09). |
| D13-20 | **Ensayo de restauración obligatorio y cronometrado antes del go-live**, con evidencia firmada. | La propuesta lo promete en §4.5; aquí se convierte en criterio de salida verificable. |

---

## 1. Estrategia de pruebas por capa

### 1.1 Pirámide para ESTE sistema

No es una pirámide genérica: la forma está dictada por dónde vive el riesgo. El riesgo está en **aritmética decimal sobre inventario y costos**, en **concurrencia de consumo de insumos** y en **reintentos de sincronización**. Todo lo demás (pantallas, CRUD, formularios) es riesgo bajo y se cubre con integración y E2E.

```mermaid
graph TD
    UAT["UAT manual con la panadería<br/>2 días · 24 guiones · firma de acta"]:::l6
    E2E["E2E web · Playwright<br/>15 flujos · 1 navegador"]:::l5
    MOB["Móvil · integration_test<br/>6 flujos offline/outbox · 1 emulador"]:::l4
    CTR["Contrato · OpenAPI 3.1<br/>oasdiff + clientes generados"]:::l3
    INT["Integración API · Postgres real<br/>~140 casos · concurrencia real"]:::l2
    UNIT["Unitaria de dominio · 620 casos<br/>costeo, CPP, kárdex, márgenes"]:::l1
    classDef l1 fill:#1b5e20,color:#fff
    classDef l2 fill:#2e7d32,color:#fff
    classDef l3 fill:#558b2f,color:#fff
    classDef l4 fill:#f9a825,color:#000
    classDef l5 fill:#ef6c00,color:#fff
    classDef l6 fill:#b71c1c,color:#fff
```

| Capa | Herramienta | Volumen objetivo | Tiempo en CI | Qué se prueba | Qué **NO** se prueba aquí |
|---|---|---|---|---|---|
| **Unitaria de dominio** | Vitest (TS) | 600–700 casos | ≤ 25 s | CPP, valorización de kárdex, costo unitario, prorrateo CIF, margen/markup, redondeo `ROUND_HALF_UP`, conversión de unidades, antigüedad de saldos, reversión de movimientos. Funciones puras, sin DB ni Nest. | Nada que toque SQL, HTTP, transacciones ni zonas horarias de la BD. |
| **Integración API** | Vitest + Supertest + PostgreSQL 17 real | 120–160 casos | 3–5 min | Cada endpoint contra esquema real: transacciones, locks (`FOR UPDATE`), constraints, `Idempotency-Key`, RBAC por recurso, correlativos, migraciones aplicadas, serialización `camelCase`↔`snake_case`. | Reglas puras ya cubiertas por la unitaria. No se re-testea la aritmética aquí. |
| **Contrato** | `@nestjs/swagger` + `oasdiff` + generadores | 1 snapshot + 3 compilaciones | ≤ 40 s | Que el OpenAPI publicado no rompa compatibilidad; que el cliente TS y el cliente Dart **compilen** desde el spec; que web y móvil consuman el cliente generado, no `fetch` a mano. | Semántica de negocio. Que el endpoint responda bien es de integración. |
| **E2E web** | Playwright (Chromium) + stack Compose | 15 flujos | 6–9 min | Que un humano pueda completar los recorridos críticos: login con MFA, alta de receta, cierre de período, dashboard, anulación, cobranza. Incluye un smoke de Firefox sobre 3 flujos. | Matriz completa de navegadores. Safari/iOS solo en UAT manual. |
| **Móvil** | `flutter test` + `integration_test` | 90 unit + 6 flujos | 8–12 min | Outbox sobre Drift, reintento con la misma `Idempotency-Key`, resolución de conflictos por entidad, arranque sin red, reconexión a mitad de envío, cursor `since`, migración de esquema Drift. | Rendimiento real en tablet de gama baja, lector de código de barras e impresora: **solo dispositivo físico, en UAT**. |
| **UAT manual** | Guion en papel + datos de la panadería | 24 guiones | 2 días | Que el Gerente reconozca sus márgenes, que Producción cierre una OP real, que el Vendedor cobre. Aceptación del negocio. | Cualquier cosa automatizable. Si se puede automatizar, no va a UAT. |
| **Rendimiento** | k6 | 3 escenarios | 15 min (semanal) | p95 de endpoints de lectura, creación de pedidos a 100/min, soak de 15 min sin fuga de memoria. | Carga masiva. 200 pedidos/día está a dos órdenes de magnitud del límite. |

**Decisiones de alcance de pruebas (no negociables):**

1. **No se testean controladores ni DTOs por unidad.** Un DTO sin lógica probado por unidad es cobertura cosmética. Se cubre por integración.
2. **No hay tests de mutación continuos.** Se corren una vez antes del go-live sobre `costeo` y `kardex` y se archiva el reporte (`Stryker`, umbral 60 % de mutantes muertos). Quedan fuera de CI porque el costo de cómputo no se justifica en un equipo de esta escala.
3. **No hay automatización iOS en CI.** Requiere runners macOS a USD 0.08/min → un pipeline de 12 min cuesta más que el VPS. iOS se valida en `integration_test` local + un dispositivo físico en UAT. `[AMPLIACIÓN]`
4. **No hay pruebas de regresión visual de toda la web.** Solo 5 pantallas (dashboard, ficha de costo, kárdex, kárdex por producto, deudas) con Playwright `toHaveScreenshot` y umbral 0.2 %.
5. **No hay chaos engineering.** Un solo test de caos controlado (QA-25, matar la API a mitad de transacción) ejecutado manualmente antes del go-live.

### 1.2 Objetivos de cobertura — verificables, no aspiracionales

Los umbrales se **hacen fallar el build**. Un objetivo que no rompe el pipeline no es un objetivo.

```ts
// apps/api/vitest.config.ts (extracto)
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      exclude: [
        '**/*.module.ts', '**/main.ts', '**/generated/**', '**/prisma/migrations/**',
        '**/*.dto.ts', '**/*.entity.ts', '**/__fixtures__/**', '**/*.config.ts',
      ],
      thresholds: {
        // Piso global — si baja, el pipeline falla.
        lines: 70, statements: 70, functions: 65, branches: 60,
        // El dinero: exigencia alta y por ruta, no diluida en el promedio.
        'packages/domain/src/**':            { lines: 90, statements: 90, functions: 90, branches: 85 },
        'apps/api/src/modules/costeo/**':    { lines: 92, statements: 92, functions: 90, branches: 88 },
        'apps/api/src/modules/inventario/**':{ lines: 90, statements: 90, functions: 88, branches: 85 },
        'apps/api/src/modules/cobranza/**':  { lines: 90, statements: 90, functions: 88, branches: 85 },
      },
    },
  },
});
```

| Ámbito | Objetivo | Cómo se verifica | Realismo |
|---|---|---|---|
| `packages/domain` (aritmética pura) | **≥ 90 % líneas / ≥ 85 % ramas** | Umbral por ruta en Vitest. Rompe el build. | Alcanzable: es código puro sin I/O. Se llega a 94–96 %. |
| `costeo`, `inventario`, `cobranza` (API) | **≥ 90 % líneas** | Umbral por ruta. | Alcanzable con integración real: 90–93 %. |
| **Global API** | **≥ 70 % líneas / ≥ 60 % ramas** | Umbral global. | Realista: con integración contando, se aterriza en 72–76 %. Exigir 85 % global obligaría a tests de DTOs sin valor. |
| Web (React) | ≥ 45 % líneas en `src/features/**` críticos | Umbral por ruta solo en `cobranza`, `costos`, `dashboard`. | Bajo a propósito: la web es UI sobre una API ya probada; su riesgo está en E2E. |
| Flutter | ≥ 60 % en `lib/core/outbox` y `lib/features/sync`; sin umbral global | `flutter test --coverage` + `lcov` | El valor está en la sincronización, no en pintar widgets. |

**Regla de oro:** ningún PR puede **reducir** la cobertura de un directorio con umbral por ruta. El job compara contra `main` con `json-summary` y comenta el diff.

### 1.3 Separación de proyectos de test

```ts
// vitest.workspace.ts
export default [
  { test: { name: 'unit',        include: ['packages/**/*.spec.ts', 'apps/api/src/**/*.spec.ts'],
            exclude: ['**/*.int.spec.ts'] } },
  { test: { name: 'integration', include: ['apps/api/test/**/*.int.spec.ts'],
            testTimeout: 30_000, hookTimeout: 60_000, pool: 'forks', poolOptions: { forks: { singleFork: true } } } },
];
```

`singleFork: true` es deliberado: la integración comparte una base de datos y se trunca entre suites. Paralelizar obligaría a una BD por worker y multiplicaría por 4 el tiempo total en un runner de 2 vCPU.

### 1.4 Fixture de base de datos — local vs CI

```ts
// apps/api/test/fixtures/db.ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';

export async function startDb(): Promise<string> {
  // En CI, el service container ya existe: no se levanta nada.
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  // En local, Testcontainers. Misma imagen que producción: postgres:17.
  const c = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('tanta_test')
    .withUsername('tanta')
    .withPassword('tanta')
    .withCommand(['postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off',
                  '-c', 'full_page_writes=off', '-c', 'max_connections=200'])
    .start();
  return c.getConnectionUri();
}
```

`fsync=off` en tests es correcto y necesario: no hay datos que preservar y reduce el tiempo de la suite de integración de ~6 min a ~3 min. **Nunca** en staging ni producción.

---

## 2. Casos de prueba críticos

25 escenarios. Si uno falla, el proyecto no sale. Capa: **U** unitaria · **I** integración · **C** contrato · **E** E2E web · **M** móvil · **P** procedimiento manual.

| ID | Escenario | Precondición | Pasos | Resultado esperado | Capa |
|---|---|---|---|---|---|
| **QA-01** | CPP tras compras a distinto precio | Harina con stock 100 kg @ CPP S/ 3.800000; sin movimientos posteriores | Compra 50 kg @ 4.10; compra 50 kg @ 3.50; compra 100 kg @ 4.60 | CPP sucesivos: **3.900000** (585/150), **3.800000** (760/200), **4.066667** (1220/300). `saldo_inventario.saldo_valor` = **1220.0000** y `movimiento_inventario.valor` = 460.0000 en la 3.ª compra; `cpp × saldo_cantidad ≠ saldo_valor` (1220.0001) y aun así manda el valor. Ningún redondeo intermedio | U + I |
| **QA-02** | Dos consumos concurrentes del mismo insumo | Harina con stock 10.000000 kg; dos OP que consumen 6 kg cada una, lanzadas a la vez | Dos `POST /api/v1/ordenes-produccion/{id}/produccion` simultáneos (el consumo de insumos va dentro de ese payload, `05 §2.9`), cada uno en su conexión | La 1.ª confirma (saldo 4); la 2.ª bloquea en `SELECT … FOR UPDATE` sobre `core.saldo_inventario`, relee y responde **409 `STOCK_INSUFICIENTE`** con faltante 2 kg. Stock final 4.000000, un solo movimiento, **cero deadlocks**, ninguna fila negativa | I |
| **QA-03** | Margen negativo | Producto con costo total S/ 4.200000; venta a S/ 4.13 **con IGV** (neto S/ 3.500000) con descuento 40 % autorizado por Gerente | Registrar venta a terceros con `motivo_descuento`; consultar G-06 y el dashboard | La venta **se registra** (no se bloquea el negocio), margen = **−20.0000 %** (3.50 − 4.20) / 3.50, aparece en G-06 con semáforo rojo y en el resumen del día; se escribe `audit.evento VENTA_MARGEN_NEGATIVO`; descuento > 15 % sin rol `GERENTE` → **403** | U + I |
| **QA-04** | Venta anulada | VTA-2026-000123 confirmada, con 3 movimientos de kárdex y CxC de S/ 708.00 | `POST /ventas/{id}/anular` con motivo y autorización; repetir la llamada | Se generan **movimientos inversos** (no se borra nada), stock vuelve, CxC saldo 0, kárdex suma cero para ese documento, venta en estado `anulada` con `anulado_por`/`anulado_en`/`motivo`. Segunda anulación → **409 `YA_ANULADA`**. G-06 la excluye; el detalle la muestra marcada | I + E |
| **QA-05** | Devolución parcial | Venta de 100 panes @ S/ 2.36 (costo de línea congelado S/ 0.804095). Devolución de 12 | `POST /ventas/{id}/devoluciones` con cantidad 12 y motivo | Ingreso de 12 unidades **al costo de la línea de venta original** (S/ 0.804095), no al CPP vigente. CxC baja 12 × 2.0000 = S/ 24.00. El margen de la venta se recalcula sobre 88 unidades. Kárdex cuadra al céntimo. Devolución > vendido → **422** | U + I |
| **QA-06** | Receta editada tras vender | Venta del 03/11 con costo congelado S/ 0.804095. El 07/11 se sube la harina +20 % en la receta | Editar receta (nueva versión); consultar la venta del 03/11; generar OP nueva | `receta.version` pasa de 1 a 2; la venta del 03/11 mantiene **exactamente** S/ 0.804095 y su margen; la OP nueva apunta a `receta_id` + `version = 2`; la versión 1 sigue consultable y auditable. `receta_detalle` nunca se actualiza en sitio | U + I |
| **QA-07** | Cierre de período con CIF | Noviembre con CIF total S/ 8,230.00 y 41,150 unidades equivalentes; período `abierto` | Ejecutar cierre de período con prorrateo por unidades; reintentar el cierre | CIF/unidad = **0.200000**; la suma de CIF asignado a las OP = **8230.0000** exacto (residuo por `ROUND_HALF_UP` a la OP de mayor base); período → `cerrado`; OP que intente imputar a ese período → **409 `PERIODO_CERRADO`**; reejecutar el cierre es idempotente y no duplica | U + I |
| **QA-08** | Cobranza parcial acumulada | Venta al crédito S/ 1,000.00, vence 15/11/2026 | Pagos: 300 (10/11), 250 (12/11), 450 (20/11). Consultar antigüedad al 20/11 **antes** del tercer pago y al 21/11 | Saldo 1000 → 700 → 450 → **0.00**; los S/ 450 pendientes al 20/11 caen en el tramo **0–7 días** (5 días de atraso) y no en el 8–15; al 21/11 el estado es `pagada` y sale de la antigüedad; pago de S/ 100 sobre saldo 0 → **422 `SOBREPAGO`**; dos pagos concurrentes con la misma `Idempotency-Key` → un solo registro | U + I |
| **QA-09** | Pedido cancelado con OP en curso | PED-2026-000123 con OP-2026-000045 `en_proceso`; 8 kg de harina ya consumidos; producto no terminado | Cancelar el pedido | OP → `cancelada`; los 8 kg se revierten con movimiento de reversión **al costo del consumo original**; la masa en proceso se registra como **merma** motivo `PEDIDO_CANCELADO`; si la OP estuviera `terminada` y el producto despachado → **409**. Todo auditado | I |
| **QA-10** | IDOR: pedido ajeno | Cliente A autenticado; UUID del pedido del cliente B obtenido por fuera | `GET/PATCH /api/v1/pedidos/{idB}` con token de A; y `GET /pedidos?clienteId=B` | **404** (no 403: no se filtra existencia) en el recurso puntual; el listado devuelve solo los de A aunque el filtro pida B, sin error. Se escribe `audit.evento ACCESO_DENEGADO`. Se repite la matriz para los 6 perfiles × 5 recursos | I |
| **QA-11** | Reintento de sync que duplica movimiento | Tablet con un movimiento en el outbox ya enviado; la respuesta HTTP se perdió | Reenviar el mismo payload con la misma `Idempotency-Key`; luego reenviar la misma key con cantidad distinta | 1.er reenvío: **200** con el mismo `id` y `replayed: true`. 2.º con cuerpo distinto: **409 `IDEMPOTENCY_KEY_REUSED`**. El kárdex tiene **un** movimiento (`ux_mov_idempotency` lo garantiza). La clave vive **7 días** en `core.idempotencia` y su purga corre por pg-boss | M + I |
| **QA-12** | Restauración de backup | Dump cifrado del día anterior en R2 + manifiesto SHA-256; contenedor limpio | Descargar, verificar SHA-256, descifrar con `age`, restaurar con `pg_restore`, arrancar la API contra la BD restaurada | Restauración en **< 45 min**. Conteos por tabla idénticos al manifiesto (`±0`). `core.saldo_inventario` cuadra con la suma de `core.movimiento_inventario` ponderada por `tipo_movimiento.signo`. `GET /health/ready` → 200. Login de un usuario del dump funciona. Sin la clave `age`, el descifrado **falla** | P |
| **QA-13** | Correlativo concurrente | Contador `secuencia_documento('PED', 2026)` en 122 | 20 `POST /pedidos` simultáneos | 20 correlativos **únicos y consecutivos** `PED-2026-000123`…`PED-2026-000142`, sin huecos, sin duplicados, sin deadlocks. Ningún cliente inventa su número | I |
| **QA-14** | Redondeo de IGV, margen y markup | Precio con IGV S/ 2.36; IGV 18 %; costo total unitario S/ 0.804095 | Calcular ficha de costo; generar venta de 1,000 líneas aleatorias | Neto = **2.000000**; utilidad = **1.195905**; margen = **59.7953 %** (fracción `0.597953`); markup = **148.7268 %**; la suma de líneas redondeadas coincide con el total de la venta **sin diferencia de 1 céntimo**. Redondeo solo en la salida, nunca en el intermedio | U |
| **QA-15** | Kárdex cuadra (property-based) | Semilla fija `20261101`; 500 operaciones aleatorias (compras, consumos, mermas, ajustes, devoluciones) | fast-check genera la secuencia y verifica invariantes tras cada paso | Para cada insumo: `saldo_cantidad` = Σ entradas − Σ salidas; `saldo_valor` = Σ valores; `CPP ≈ valor/cantidad ± 1e-6`; **nunca** cantidad o valor negativos; un `ajuste` negativo nunca lleva el saldo bajo 0 | U |
| **QA-16** | Día operativo en `America/Lima` | Venta a las 2026-11-03 23:45 Lima (= 04:45 UTC del 04/11) | Consultar cierre de caja del 03/11 y del 04/11 | La venta pertenece al **03/11** en cierre de caja, reporte diario y dashboard. Cero filas en el 04/11. Se repite con 00:05 Lima (= 05:05 UTC) | U + I |
| **QA-17** | Stock insuficiente al generar OP | Receta requiere 12 kg de harina; stock 8 kg | Generar OP por la cantidad objetivo; intentar consumir | La OP se crea con `puede_ejecutar = false` y el detalle de faltantes (harina: faltan 4 kg). Consumir → **409** con la lista. **No** se permite stock negativo ni consumo parcial silencioso. Requisición parcial explícita sí se permite | I |
| **QA-18** | El dashboard cuadra con las ventas | Seed de 30 días aplicado y período cerrado | Abrir G-01, G-02, G-06 y G-11 con los mismos filtros | Σ G-02 = G-01 = Σ `venta_detalle` neto, al céntimo. Margen % = utilidad / neto con 4 decimales. Al filtrar por categoría y fecha los totales siguen cuadrando. Respuesta < 3 s con 1,350 pedidos | I + E |
| **QA-19** | Reuso de refresh token | Sesión activa con refresh rotado (R1 → R2) | Presentar R1 de nuevo | **401** + revocación de **toda la familia** de tokens del usuario + `audit.evento TOKEN_REUSE`. El usuario debe volver a autenticarse. No se emite access token | I |
| **QA-20** | Matriz RBAC de los 6 perfiles | Un usuario por perfil; la matriz de la Tabla 2 del informe como fuente | Recorrer la matriz completa (6 perfiles × 8 módulos × acciones) | Cada celda `●` = 2xx; `○` = 200 en lectura y **403** en escritura; `—` = **403** siempre. Toda denegación deja evento de auditoría. Test parametrizado: una fila por celda | I |
| **QA-21** | Migración *expand/contract* | BD en la versión N−1 con datos reales del seed | Aplicar `prisma migrate deploy` de N; levantar la **imagen N−1** contra el esquema N | La migración aplica sin pérdida de filas; la imagen N−1 **sigue operando** (solo columnas aditivas/nullable). `prisma migrate diff --exit-code` sin cambios pendientes. Migración destructiva sin label `allow-destructive` → CI falla | I (CI) |
| **QA-22** | Backup cifrado de verdad | Dump del día en R2 | `grep` de un nombre de cliente del seed sobre el objeto; intentar descifrar sin clave | El objeto **no** contiene texto plano (0 coincidencias de "Bodega Doña Rosa"). Sin la identidad `age` el descifrado falla con código ≠ 0. El manifiesto SHA-256 coincide con el archivo | I (CI) |
| **QA-23** | Carga y límites de recursos | Staging con los límites de `compose.prod.yml` | k6: 30 VUs, 5 min, mezcla 70/30 lectura/escritura | p95 < 500 ms, error rate < 1 %, **0 OOM kills**, sin reinicio de Postgres, `pg_stat_activity` < 40. Si falla, el límite de cgroup está mal calibrado y se corrige **antes** del go-live | P |
| **QA-24** | Seed reproducible | BD vacía | Ejecutar el seed dos veces desde cero; comparar `sha256` de las vistas agregadas | Los dos hashes son **idénticos**: mismos UUID, mismos totales, mismos márgenes. Ningún `now()` ni `random()` sin semilla. Falla si `NODE_ENV=production` | I (CI) |
| **QA-25** | Caída de la API a mitad de la venta | Compose de staging; venta en curso | `docker kill api-blue` entre el `INSERT` de la venta y el de `movimiento_inventario`; reiniciar; la tablet reintenta | Tras el reinicio no existe venta sin sus movimientos (atomicidad de la transacción). El outbox reintenta con la misma key y la operación se completa **una sola vez**. Cero estados huérfanos | P + M |

**Trazabilidad obligatoria:** cada uno de estos 25 casos vive en un archivo versionado (`docs/qa/QA-xx.md` o el spec automatizado) y se referencia en el acta de UAT. Un caso sin evidencia de ejecución no cuenta como aprobado.

---

## 3. Datos de prueba y entorno de demo

### 3.1 Principios

1. **El seed es código, no un dump.** Versionado, reproducible, con semilla fija. Un dump se desactualiza y arrastra PII.
2. **Cero datos de producción en staging.** Nunca. Ni "anonimizados". El seed es la única fuente.
3. **Tres modos:** `base` (maestros, segundos), `demo` (30 días de operación, ~40 s), `volume` (90 días × 200 pedidos/día, para el test de carga, ~4 min).
4. **Guarda dura:** el seed aborta si `NODE_ENV === 'production'` o si `core.pedido` tiene filas y no se pasó `--reset`.

### 3.2 `infra/seed/01-maestros.sql` — datos realistas de panadería peruana

```sql
-- ============================================================
-- Tanta · seed de maestros (modo base) · idempotente
-- Ejecutar: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 01-maestros.sql
-- UUID fijos para que dos ejecuciones produzcan el mismo resultado.
-- ============================================================
BEGIN;

SET LOCAL search_path = core, public;

-- ---------- Sucursal, unidades de medida y proveedores ----------
INSERT INTO core.sucursal (id, codigo, nombre, direccion, zona_horaria, creado_en)
VALUES ('0192a000-0000-7000-8000-000000000001', 'LIM-01', 'Tanta · Sede Principal',
        'Av. La Marina 1234, San Miguel, Lima', 'America/Lima', '2026-10-26 07:00:00-05')
ON CONFLICT (id) DO NOTHING;

-- Una sola unidad base por magnitud (ux_um_base_por_tipo): KG, L, UN y H.
INSERT INTO core.unidad_medida (id, codigo, nombre, tipo, factor_base, es_base) VALUES
  ('0192a000-0000-7000-8000-000000000101', 'KG',    'kilogramo',     'MASA',    1,     true),
  ('0192a000-0000-7000-8000-000000000102', 'G',     'gramo',         'MASA',    0.001, false),
  ('0192a000-0000-7000-8000-000000000103', 'L',     'litro',         'VOLUMEN', 1,     true),
  ('0192a000-0000-7000-8000-000000000104', 'ML',    'mililitro',     'VOLUMEN', 0.001, false),
  ('0192a000-0000-7000-8000-000000000105', 'UN',    'unidad',        'UNIDAD',  1,     true),
  ('0192a000-0000-7000-8000-000000000106', 'SACO',  'saco de 50 kg', 'UNIDAD',  1,     false),
  ('0192a000-0000-7000-8000-000000000107', 'BOLSA', 'bolsa',         'UNIDAD',  1,     false),
  ('0192a000-0000-7000-8000-000000000108', 'CAJA',  'caja',          'UNIDAD',  1,     false),
  ('0192a000-0000-7000-8000-000000000109', 'H',     'hora',          'TIEMPO',  1,     true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.proveedor (id, sucursal_id, codigo, razon_social, ruc, dias_credito) VALUES
  ('0192a000-0000-7000-8000-000000000111', '0192a000-0000-7000-8000-000000000001', 'PROV-01', 'Molino Lima S.A.C.',        '20512345671', 30),
  ('0192a000-0000-7000-8000-000000000112', '0192a000-0000-7000-8000-000000000001', 'PROV-02', 'Comercial Andina E.I.R.L.', '20512345672', 15),
  ('0192a000-0000-7000-8000-000000000113', '0192a000-0000-7000-8000-000000000001', 'PROV-03', 'Alicorp Distribuidor',      '20512345673', 30),
  ('0192a000-0000-7000-8000-000000000114', '0192a000-0000-7000-8000-000000000001', 'PROV-04', 'Gloria Distribuidor',       '20512345674', 30),
  ('0192a000-0000-7000-8000-000000000115', '0192a000-0000-7000-8000-000000000001', 'PROV-05', 'Insumos Panaderos EIRL',    '20512345675', 15),
  ('0192a000-0000-7000-8000-000000000116', '0192a000-0000-7000-8000-000000000001', 'PROV-06', 'Empaques Perú S.A.C.',      '20512345676', 15)
ON CONFLICT (id) DO NOTHING;

-- ---------- Categorías ----------
INSERT INTO core.categoria (id, sucursal_id, nombre, margen_objetivo_pct, orden) VALUES
  ('0192a000-0000-7000-8000-000000000201', '0192a000-0000-7000-8000-000000000001', 'Panes',      0.550000, 1),
  ('0192a000-0000-7000-8000-000000000202', '0192a000-0000-7000-8000-000000000001', 'Pastelería', 0.600000, 2),
  ('0192a000-0000-7000-8000-000000000203', '0192a000-0000-7000-8000-000000000001', 'Tortas',     0.620000, 3),
  ('0192a000-0000-7000-8000-000000000204', '0192a000-0000-7000-8000-000000000001', 'Bocaditos',  0.580000, 4)
ON CONFLICT (id) DO NOTHING;

-- ---------- Almacenes ----------
INSERT INTO core.almacen (id, sucursal_id, codigo, nombre, tipo) VALUES
  ('0192a000-0000-7000-8000-000000000021', '0192a000-0000-7000-8000-000000000001', 'ALM-INS', 'Almacén de insumos',        'INSUMOS'),
  ('0192a000-0000-7000-8000-000000000022', '0192a000-0000-7000-8000-000000000001', 'ALM-PT',  'Almacén de producto terminado', 'PRODUCTO_TERMINADO'),
  ('0192a000-0000-7000-8000-000000000023', '0192a000-0000-7000-8000-000000000001', 'ALM-MER', 'Merma y descarte',          'MERMA')
ON CONFLICT (id) DO NOTHING;

-- ---------- Insumos (precios de compra Lima, oct-2026, PEN) ----------
-- El gas y la energía NO son insumos: son CIF (§3.2, costo_indirecto). No duplicar.
INSERT INTO core.insumo
  (id, sucursal_id, codigo, nombre, unidad_medida_id, unidad_compra_id,
   factor_compra, proveedor_habitual_id, stock_minimo, perecedero, vida_util_dias)
VALUES
  ('0192a000-0000-7000-8000-000000000301', '0192a000-0000-7000-8000-000000000001',
   'HAR-ESP', 'Harina de trigo especial', '0192a000-0000-7000-8000-000000000101', '0192a000-0000-7000-8000-000000000106',  50.000000, '0192a000-0000-7000-8000-000000000111', 250, true, 180),
  ('0192a000-0000-7000-8000-000000000302', '0192a000-0000-7000-8000-000000000001',
   'HAR-INT', 'Harina integral',         '0192a000-0000-7000-8000-000000000101', '0192a000-0000-7000-8000-000000000106',  50.000000, '0192a000-0000-7000-8000-000000000111',  50, true, 180),
  ('0192a000-0000-7000-8000-000000000303', '0192a000-0000-7000-8000-000000000001',
   'AZU-RUB', 'Azúcar rubia',            '0192a000-0000-7000-8000-000000000101', NULL,                                     1.000000, '0192a000-0000-7000-8000-000000000112',  40, true, 365),
  ('0192a000-0000-7000-8000-000000000304', '0192a000-0000-7000-8000-000000000001',
   'MAN-VEG', 'Manteca vegetal',         '0192a000-0000-7000-8000-000000000101', NULL,                                     1.000000, '0192a000-0000-7000-8000-000000000113',  20, true, 270),
  ('0192a000-0000-7000-8000-000000000305', '0192a000-0000-7000-8000-000000000001',
   'MAN-LAC', 'Mantequilla',             '0192a000-0000-7000-8000-000000000101', NULL,                                     1.000000, '0192a000-0000-7000-8000-000000000114',  10, true, 90),
  ('0192a000-0000-7000-8000-000000000306', '0192a000-0000-7000-8000-000000000001',
   'LEV-FRE', 'Levadura fresca',         '0192a000-0000-7000-8000-000000000101', NULL,                                     1.000000, '0192a000-0000-7000-8000-000000000115',   8, true, 21),
  ('0192a000-0000-7000-8000-000000000307', '0192a000-0000-7000-8000-000000000001',
   'SAL-IND', 'Sal industrial',          '0192a000-0000-7000-8000-000000000101', NULL,                                     1.000000, '0192a000-0000-7000-8000-000000000112',  20, true, 730),
  ('0192a000-0000-7000-8000-000000000308', '0192a000-0000-7000-8000-000000000001',
   'MEJ-PAN', 'Mejorador de pan',        '0192a000-0000-7000-8000-000000000101', NULL,                                     1.000000, '0192a000-0000-7000-8000-000000000115',   5, true, 365),
  ('0192a000-0000-7000-8000-000000000309', '0192a000-0000-7000-8000-000000000001',
   'HUE-GAL', 'Huevo de gallina',        '0192a000-0000-7000-8000-000000000101', NULL,                                     1.000000, '0192a000-0000-7000-8000-000000000115',  15, true, 21),
  ('0192a000-0000-7000-8000-00000000030a', '0192a000-0000-7000-8000-000000000001',
   'LEC-EVA', 'Leche evaporada',         '0192a000-0000-7000-8000-000000000103', NULL,                                     1.000000, '0192a000-0000-7000-8000-000000000114',  12, true, 365),
  ('0192a000-0000-7000-8000-00000000030b', '0192a000-0000-7000-8000-000000000001',
   'VAN-ESC', 'Esencia de vainilla',     '0192a000-0000-7000-8000-000000000103', NULL,                                     1.000000, '0192a000-0000-7000-8000-000000000115',   2, false, NULL),
  ('0192a000-0000-7000-8000-00000000030c', '0192a000-0000-7000-8000-000000000001',
   'CAC-POL', 'Cacao en polvo',          '0192a000-0000-7000-8000-000000000101', NULL,                                     1.000000, '0192a000-0000-7000-8000-000000000115',   5, true, 365),
  ('0192a000-0000-7000-8000-00000000030d', '0192a000-0000-7000-8000-000000000001',
   'COB-CHO', 'Cobertura de chocolate',  '0192a000-0000-7000-8000-000000000101', NULL,                                     1.000000, '0192a000-0000-7000-8000-000000000115',   8, true, 270),
  ('0192a000-0000-7000-8000-00000000030f', '0192a000-0000-7000-8000-000000000001',
   'BOL-PAP', 'Bolsa de papel kraft',    '0192a000-0000-7000-8000-000000000105', NULL,                                     1.000000, '0192a000-0000-7000-8000-000000000116', 800, false, NULL),
  ('0192a000-0000-7000-8000-000000000310', '0192a000-0000-7000-8000-000000000001',
   'CAJ-TOR', 'Caja para torta',         '0192a000-0000-7000-8000-000000000105', NULL,                                     1.000000, '0192a000-0000-7000-8000-000000000116',  60, false, NULL)
ON CONFLICT (id) DO NOTHING;

-- ---------- Saldo de apertura (el CPP vive en saldo_inventario, NO en insumo) ----------
-- saldo_valor = saldo_cantidad × cpp, exacto a 4 decimales.
INSERT INTO core.saldo_inventario
  (id, sucursal_id, almacen_id, item_tipo, insumo_id, saldo_cantidad, saldo_valor, cpp)
VALUES
  ('0192a000-0000-7000-8000-000000000351', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-000000000301', 300.000000, 1155.0000,  3.850000),
  ('0192a000-0000-7000-8000-000000000352', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-000000000302',  80.000000,  352.0000,  4.400000),
  ('0192a000-0000-7000-8000-000000000353', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-000000000303',  60.000000,  192.0000,  3.200000),
  ('0192a000-0000-7000-8000-000000000354', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-000000000304',  40.000000,  356.0000,  8.900000),
  ('0192a000-0000-7000-8000-000000000355', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-000000000305',  12.000000,  270.0000, 22.500000),
  ('0192a000-0000-7000-8000-000000000356', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-000000000306',  15.000000,  180.0000, 12.000000),
  ('0192a000-0000-7000-8000-000000000357', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-000000000307',  40.000000,   44.0000,  1.100000),
  ('0192a000-0000-7000-8000-000000000358', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-000000000308',  10.000000,  145.0000, 14.500000),
  ('0192a000-0000-7000-8000-000000000359', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-000000000309',  30.000000,  246.0000,  8.200000),
  ('0192a000-0000-7000-8000-00000000035a', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-00000000030a',  24.000000,  182.4000,  7.600000),
  ('0192a000-0000-7000-8000-00000000035b', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-00000000030b',   3.000000,  114.0000, 38.000000),
  ('0192a000-0000-7000-8000-00000000035c', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-00000000030c',  10.000000,  260.0000, 26.000000),
  ('0192a000-0000-7000-8000-00000000035d', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-00000000030d',  10.000000,  240.0000, 24.000000),
  ('0192a000-0000-7000-8000-00000000035e', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-00000000030f', 2000.000000,  80.0000,  0.040000),
  ('0192a000-0000-7000-8000-00000000035f', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000021', 'INSUMO', '0192a000-0000-7000-8000-000000000310', 120.000000,  162.0000,  1.350000)
ON CONFLICT (id) DO NOTHING;

-- ---------- Productos (sin precio: el precio vive en producto_precio, versionado) ----------
INSERT INTO core.producto
  (id, sucursal_id, categoria_id, codigo, nombre, unidad_venta_id, margen_objetivo_pct, orden)
VALUES
  ('0192a000-0000-7000-8000-000000000401', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000201', 'PAN-CIA', 'Pan ciabatta',             '0192a000-0000-7000-8000-000000000105', 0.550000, 1),
  ('0192a000-0000-7000-8000-000000000402', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000201', 'PAN-FRA', 'Pan francés',              '0192a000-0000-7000-8000-000000000105', 0.550000, 2),
  ('0192a000-0000-7000-8000-000000000403', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000201', 'PAN-MOL', 'Pan de molde integral',    '0192a000-0000-7000-8000-000000000105', 0.500000, 3),
  ('0192a000-0000-7000-8000-000000000404', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000201', 'PAN-PET', 'Panetón clásico 900 g',    '0192a000-0000-7000-8000-000000000105', 0.500000, 4),
  ('0192a000-0000-7000-8000-000000000405', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000203', 'TOR-CHO', 'Torta de chocolate 1 kg',  '0192a000-0000-7000-8000-000000000105', 0.620000, 5),
  ('0192a000-0000-7000-8000-000000000406', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000202', 'ALF-PAN', 'Alfajor de manjar',        '0192a000-0000-7000-8000-000000000105', 0.600000, 6),
  ('0192a000-0000-7000-8000-000000000407', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000204', 'EMP-POL', 'Empanada de pollo',        '0192a000-0000-7000-8000-000000000105', 0.580000, 7),
  ('0192a000-0000-7000-8000-000000000408', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000202', 'CRO-MAN', 'Croissant de mantequilla', '0192a000-0000-7000-8000-000000000105', 0.600000, 8),
  ('0192a000-0000-7000-8000-000000000409', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000202', 'BIZ-VAI', 'Bizcocho de vainilla',     '0192a000-0000-7000-8000-000000000105', 0.600000, 9),
  ('0192a000-0000-7000-8000-00000000040a', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000204', 'GAL-AVE', 'Galleta de avena',         '0192a000-0000-7000-8000-000000000105', 0.580000, 10)
ON CONFLICT (id) DO NOTHING;

-- ---------- Lista de precios y precios vigentes (importes CON IGV, PEN) ----------
INSERT INTO core.lista_precio (id, sucursal_id, codigo, nombre, tipo, es_default) VALUES
  ('0192a000-0000-7000-8000-000000000a01', '0192a000-0000-7000-8000-000000000001',
   'MOSTRADOR', 'Lista mostrador (precios con IGV)', 'BASE', true)
ON CONFLICT (id) DO NOTHING;

-- precio_neto es columna generada: NO se inserta.
INSERT INTO core.producto_precio (id, lista_precio_id, producto_id, precio_con_igv, vigente_desde) VALUES
  ('0192a000-0000-7000-8000-000000000b01', '0192a000-0000-7000-8000-000000000a01', '0192a000-0000-7000-8000-000000000401',  2.3600, '2026-10-26'),
  ('0192a000-0000-7000-8000-000000000b02', '0192a000-0000-7000-8000-000000000a01', '0192a000-0000-7000-8000-000000000402',  0.5000, '2026-10-26'),
  ('0192a000-0000-7000-8000-000000000b03', '0192a000-0000-7000-8000-000000000a01', '0192a000-0000-7000-8000-000000000403',  9.9000, '2026-10-26'),
  ('0192a000-0000-7000-8000-000000000b04', '0192a000-0000-7000-8000-000000000a01', '0192a000-0000-7000-8000-000000000404', 24.9000, '2026-10-26'),
  ('0192a000-0000-7000-8000-000000000b05', '0192a000-0000-7000-8000-000000000a01', '0192a000-0000-7000-8000-000000000405', 65.0000, '2026-10-26'),
  ('0192a000-0000-7000-8000-000000000b06', '0192a000-0000-7000-8000-000000000a01', '0192a000-0000-7000-8000-000000000406',  2.5000, '2026-10-26'),
  ('0192a000-0000-7000-8000-000000000b07', '0192a000-0000-7000-8000-000000000a01', '0192a000-0000-7000-8000-000000000407',  3.5000, '2026-10-26'),
  ('0192a000-0000-7000-8000-000000000b08', '0192a000-0000-7000-8000-000000000a01', '0192a000-0000-7000-8000-000000000408',  4.5000, '2026-10-26'),
  ('0192a000-0000-7000-8000-000000000b09', '0192a000-0000-7000-8000-000000000a01', '0192a000-0000-7000-8000-000000000409', 12.0000, '2026-10-26'),
  ('0192a000-0000-7000-8000-000000000b0a', '0192a000-0000-7000-8000-000000000a01', '0192a000-0000-7000-8000-00000000040a',  1.8000, '2026-10-26')
ON CONFLICT (id) DO NOTHING;

-- ---------- Recetas (versionadas: una sola VIGENTE por producto) ----------
-- El modo `base` carga 3 recetas; `seed-operacion.ts` completa las 10.
INSERT INTO core.receta
  (id, sucursal_id, producto_id, version, estado, rendimiento_unidades,
   rendimiento_unidad_medida_id, merma_estandar_pct, aprobada_en)
VALUES
  ('0192a000-0000-7000-8000-000000000501', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000401', 1, 'VIGENTE',  24, '0192a000-0000-7000-8000-000000000105', 0.030000, '2026-10-26 08:00:00-05'),
  ('0192a000-0000-7000-8000-000000000502', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000402', 1, 'VIGENTE', 120, '0192a000-0000-7000-8000-000000000105', 0.020000, '2026-10-26 08:00:00-05'),
  ('0192a000-0000-7000-8000-000000000505', '0192a000-0000-7000-8000-000000000001', '0192a000-0000-7000-8000-000000000405', 1, 'VIGENTE',   2, '0192a000-0000-7000-8000-000000000105', 0.040000, '2026-10-26 08:00:00-05')
ON CONFLICT (id) DO NOTHING;

-- Receta ciabatta v1: 24 unidades por tanda.
INSERT INTO core.receta_detalle (receta_id, insumo_id, cantidad, unidad_medida_id, orden)
VALUES
  ('0192a000-0000-7000-8000-000000000501', '0192a000-0000-7000-8000-000000000301',  2.800000, '0192a000-0000-7000-8000-000000000101', 1), -- harina
  ('0192a000-0000-7000-8000-000000000501', '0192a000-0000-7000-8000-000000000306',  0.050000, '0192a000-0000-7000-8000-000000000101', 2), -- levadura
  ('0192a000-0000-7000-8000-000000000501', '0192a000-0000-7000-8000-000000000307',  0.050000, '0192a000-0000-7000-8000-000000000101', 3), -- sal
  ('0192a000-0000-7000-8000-000000000501', '0192a000-0000-7000-8000-000000000304',  0.140000, '0192a000-0000-7000-8000-000000000101', 4), -- manteca
  ('0192a000-0000-7000-8000-000000000501', '0192a000-0000-7000-8000-000000000308',  0.030000, '0192a000-0000-7000-8000-000000000101', 5), -- mejorador
  ('0192a000-0000-7000-8000-000000000501', '0192a000-0000-7000-8000-00000000030f', 24.000000, '0192a000-0000-7000-8000-000000000105', 6)  -- bolsa
ON CONFLICT DO NOTHING;
-- Insumos/tanda = S/ 14.0760 -> S/ 0.586500 por unidad.
-- Con merma 3 % -> S/ 0.604095. Con CIF S/ 0.200000 -> costo total S/ 0.804095.
-- Precio neto S/ 2.000000 -> margen 59.80 %. Coherente con la Tabla 3 del informe.

-- ---------- Costos indirectos de fabricación (mensuales) ----------
INSERT INTO core.costo_indirecto
  (id, sucursal_id, codigo, nombre, categoria, tipo, base_prorrateo,
   monto_mensual_presupuestado, vigente_desde)
VALUES
  ('0192a000-0000-7000-8000-000000000601', '0192a000-0000-7000-8000-000000000001', 'CI-ALQ', 'Alquiler de local',      'ALQUILER',           'FIJO',     'UNIDADES_PRODUCIDAS', 2800.0000, '2026-10-01'),
  ('0192a000-0000-7000-8000-000000000602', '0192a000-0000-7000-8000-000000000001', 'CI-GAS', 'Gas GLP de hornos',      'GAS',                'VARIABLE', 'HORAS_HORNO',         1200.0000, '2026-10-01'),
  ('0192a000-0000-7000-8000-000000000603', '0192a000-0000-7000-8000-000000000001', 'CI-ENE', 'Energía eléctrica',      'ENERGIA',            'VARIABLE', 'HORAS_HORNO',          950.0000, '2026-10-01'),
  ('0192a000-0000-7000-8000-000000000604', '0192a000-0000-7000-8000-000000000001', 'CI-AGU', 'Agua potable',           'AGUA',               'VARIABLE', 'UNIDADES_PRODUCIDAS',  180.0000, '2026-10-01'),
  ('0192a000-0000-7000-8000-000000000605', '0192a000-0000-7000-8000-000000000001', 'CI-PLA', 'Planilla indirecta',     'PLANILLA_INDIRECTA', 'FIJO',     'UNIDADES_PRODUCIDAS', 2400.0000, '2026-10-01'),
  ('0192a000-0000-7000-8000-000000000606', '0192a000-0000-7000-8000-000000000001', 'CI-DEP', 'Depreciación de hornos', 'DEPRECIACION',       'FIJO',     'HORAS_HORNO',          450.0000, '2026-10-01'),
  ('0192a000-0000-7000-8000-000000000607', '0192a000-0000-7000-8000-000000000001', 'CI-LIM', 'Limpieza y sanidad',     'LIMPIEZA',           'FIJO',     'UNIDADES_PRODUCIDAS',  250.0000, '2026-10-01')
ON CONFLICT (id) DO NOTHING;
-- Total CIF mensual = S/ 8,230.0000

-- ---------- Períodos de costo (CERRADO exige cerrado_en y cif_real_total) ----------
INSERT INTO core.periodo_costos
  (id, sucursal_id, anio, mes, estado, cif_presupuestado_total, cif_real_total,
   unidades_producidas, calculado_en, cerrado_en)
VALUES
  ('0192a000-0000-7000-8000-000000000701', '0192a000-0000-7000-8000-000000000001', 2026, 10, 'CERRADO',
   8230.0000, 8230.0000, 41150.000000, '2026-11-01 09:00:00-05', '2026-11-01 09:30:00-05'),
  ('0192a000-0000-7000-8000-000000000702', '0192a000-0000-7000-8000-000000000001', 2026, 11, 'ABIERTO',
   8230.0000, NULL, NULL, NULL, NULL)
ON CONFLICT (id) DO NOTHING;
-- CIF unitario de octubre = 8230 / 41150 = S/ 0.200000 exacto (base de QA-07).

-- ---------- Roles, usuarios y asignación ----------
INSERT INTO core.rol (id, codigo, nombre, es_sistema) VALUES
  ('0192a000-0000-7000-8000-000000000c01', 'ADMIN',      'Administrador (Maestros)',      true),
  ('0192a000-0000-7000-8000-000000000c02', 'GERENTE',    'Gerente General',               true),
  ('0192a000-0000-7000-8000-000000000c03', 'PRODUCCION', 'Producción (tablet)',           true),
  ('0192a000-0000-7000-8000-000000000c04', 'ALMACEN',    'Almacén',                       true),
  ('0192a000-0000-7000-8000-000000000c05', 'VENDEDOR',   'Vendedor / cobranza',           true),
  ('0192a000-0000-7000-8000-000000000c06', 'CLIENTE',    'Cliente final (app)',           true)
ON CONFLICT (id) DO NOTHING;

-- Los hash son de RELLENO: no son credenciales válidas ni deben llegar a producción.
-- `seed-operacion.ts` genera hash Argon2id reales con el pepper de entorno y los imprime una vez.
INSERT INTO core.usuario
  (id, sucursal_id, email, nombre_completo, telefono, hash_password, mfa_habilitado,
   estado, debe_cambiar_password)
VALUES
  ('0192a000-0000-7000-8000-000000000901', '0192a000-0000-7000-8000-000000000001', 'admin@tanta.test',      'Rosa Quispe Huamán',     '987654321', '$argon2id$v=19$m=65536,t=3,p=1$c2VlZC1kZW1vLXNhbHQ$SEED_REEMPLAZAR_01', false, 'ACTIVO', true),
  ('0192a000-0000-7000-8000-000000000902', '0192a000-0000-7000-8000-000000000001', 'gerente@tanta.test',    'Fidel Alvarez Chávez',   '963847792', '$argon2id$v=19$m=65536,t=3,p=1$c2VlZC1kZW1vLXNhbHQ$SEED_REEMPLAZAR_02', false, 'ACTIVO', true),
  ('0192a000-0000-7000-8000-000000000903', '0192a000-0000-7000-8000-000000000001', 'produccion@tanta.test', 'Julio Mamani Ccori',     '912345678', '$argon2id$v=19$m=65536,t=3,p=1$c2VlZC1kZW1vLXNhbHQ$SEED_REEMPLAZAR_03', false, 'ACTIVO', true),
  ('0192a000-0000-7000-8000-000000000904', '0192a000-0000-7000-8000-000000000001', 'almacen@tanta.test',    'María Flores Rojas',     '998877665', '$argon2id$v=19$m=65536,t=3,p=1$c2VlZC1kZW1vLXNhbHQ$SEED_REEMPLAZAR_04', false, 'ACTIVO', true),
  ('0192a000-0000-7000-8000-000000000905', '0192a000-0000-7000-8000-000000000001', 'vendedor1@tanta.test',  'Carlos Yupanqui Salas',  '955443322', '$argon2id$v=19$m=65536,t=3,p=1$c2VlZC1kZW1vLXNhbHQ$SEED_REEMPLAZAR_05', false, 'ACTIVO', true),
  ('0192a000-0000-7000-8000-000000000906', '0192a000-0000-7000-8000-000000000001', 'cliente@tanta.test',    'Lucía Ramírez Paredes',  '944556677', '$argon2id$v=19$m=65536,t=3,p=1$c2VlZC1kZW1vLXNhbHQ$SEED_REEMPLAZAR_06', false, 'ACTIVO', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.usuario_rol (usuario_id, rol_id) VALUES
  ('0192a000-0000-7000-8000-000000000901', '0192a000-0000-7000-8000-000000000c01'),
  ('0192a000-0000-7000-8000-000000000902', '0192a000-0000-7000-8000-000000000c02'),
  ('0192a000-0000-7000-8000-000000000903', '0192a000-0000-7000-8000-000000000c03'),
  ('0192a000-0000-7000-8000-000000000904', '0192a000-0000-7000-8000-000000000c04'),
  ('0192a000-0000-7000-8000-000000000905', '0192a000-0000-7000-8000-000000000c05'),
  ('0192a000-0000-7000-8000-000000000906', '0192a000-0000-7000-8000-000000000c06')
ON CONFLICT DO NOTHING;

-- ---------- Clientes ----------
INSERT INTO core.cliente
  (id, sucursal_id, codigo, tipo_documento, numero_documento, nombre, telefono,
   vendedor_asignado_id, limite_credito, dias_credito, condicion_pago_default, es_cliente_app)
VALUES
  ('0192a000-0000-7000-8000-000000000801', '0192a000-0000-7000-8000-000000000001', 'C-001', 'RUC', '10456789012', 'Bodega Doña Rosa',           '987654321', '0192a000-0000-7000-8000-000000000905', 1500.00, 15, 'CREDITO',  false),
  ('0192a000-0000-7000-8000-000000000802', '0192a000-0000-7000-8000-000000000001', 'C-002', 'RUC', '20512345678', 'Restaurante El Fogón',       '912345678', '0192a000-0000-7000-8000-000000000905', 3000.00, 30, 'CREDITO',  false),
  ('0192a000-0000-7000-8000-000000000803', '0192a000-0000-7000-8000-000000000001', 'C-003', 'RUC', '20598765432', 'Café Aroma',                 '998877665', '0192a000-0000-7000-8000-000000000905', 1200.00, 15, 'CREDITO',  false),
  ('0192a000-0000-7000-8000-000000000804', '0192a000-0000-7000-8000-000000000001', 'C-004', 'RUC', '20487654321', 'Colegio San Martín',         '955443322', '0192a000-0000-7000-8000-000000000905', 2500.00, 30, 'CREDITO',  false),
  ('0192a000-0000-7000-8000-000000000805', '0192a000-0000-7000-8000-000000000001', 'C-005', 'RUC', '10123456789', 'Mercado Modelo · Puesto 12', '944556677', '0192a000-0000-7000-8000-000000000905',  600.00,  7, 'CREDITO',  false),
  ('0192a000-0000-7000-8000-000000000806', '0192a000-0000-7000-8000-000000000001', 'C-006', 'SIN_DOC', NULL,      'Mostrador',                  NULL,        NULL,                                     0.00,  0, 'CONTADO',  false)
ON CONFLICT (id) DO NOTHING;

-- ---------- Correlativos en cero (se incrementan con siguiente_numero) ----------
INSERT INTO core.secuencia_documento (tipo, anio, sucursal_id, ultimo) VALUES
  ('PED', 2026, '0192a000-0000-7000-8000-000000000001', 0),
  ('OP',  2026, '0192a000-0000-7000-8000-000000000001', 0),
  ('VTA', 2026, '0192a000-0000-7000-8000-000000000001', 0),
  ('DSP', 2026, '0192a000-0000-7000-8000-000000000001', 0),
  ('COB', 2026, '0192a000-0000-7000-8000-000000000001', 0),
  ('TIN', 2026, '0192a000-0000-7000-8000-000000000001', 0)
ON CONFLICT (tipo, anio, sucursal_id) DO NOTHING;
COMMIT;
```

### 3.3 `apps/api/prisma/seed-operacion.ts` — 30 días de operación

Estructura del script (ejecutable, `tsx apps/api/prisma/seed-operacion.ts --mode=demo`):

```ts
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from 'uuidv7';

// Semilla fija: dos ejecuciones producen exactamente los mismos datos (QA-24).
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODE = process.argv.includes('--mode=volume') ? 'volume' : 'demo';
const DIAS = MODE === 'volume' ? 90 : 30;
const PEDIDOS_DIA = MODE === 'volume' ? 200 : 45;
const rnd = mulberry32(20261101);

// Perfil de demanda por día de la semana (0=dom). La panadería no vende igual un martes que un sábado.
const FACTOR_DIA = [0.55, 0.95, 1.00, 1.05, 1.10, 1.35, 1.20];

const INVARIANTES = [
  'toda OP terminada consume insumos y produce producto',
  'toda venta tiene al menos un movimiento de kárdex',
  'saldo_inventario.saldo_cantidad === sum(tipo_movimiento.signo * movimiento_inventario.cantidad)',
  'sum(cuenta_por_cobrar.saldo) === sum(venta.total) - sum(cobranza.monto)',
  'ninguna fecha es futura respecto del día operativo simulado',
];

// Bucle principal (resumen):
//  1. Precarga de insumos: compra inicial = 1.5 x stock_minimo.
//  2. Por cada día d de 0..DIAS-1:
//     a. Compras de reposición los lunes y jueves (precio ± 6 % del CPP, con tendencia al alza en harina).
//     b. N pedidos (N = round(PEDIDOS_DIA * FACTOR_DIA[dow])) con 1 a 6 líneas y cliente ponderado.
//     c. Consolidación del día: una OP por producto (no por pedido), consumo con
//        merma real ~ N(merma_estandar, 0.01) y producción real ~ N(rendimiento, 0.02).
//     d. 8 % de ventas a terceros; 45 % al crédito; 3 % con descuento (incluye 1 caso de margen negativo).
//     e. Cobranzas: 70 % puntuales, 20 % parciales, 10 % vencidas (alimentan la antigüedad de saldos).
//     f. 1 anulación por semana y 2 devoluciones parciales por semana (semilla fija).
//  3. Cierre del período del último mes completo con prorrateo de CIF.
```

**Volumen resultante (modo `demo`):** ~1,350 pedidos, ~5,900 líneas de venta, ~38,000 movimientos de kárdex, ~360 OP (Producción consolida los pedidos del día en OP por producto, no una OP por pedido), 6 clientes con deuda vencida repartida en los 4 tramos de antigüedad. Tamaño de BD ≈ 180 MB. Tiempo de carga ≈ 40 s en el VPS; ≈ 4 min en modo `volume` (18,000 pedidos).

**Qué garantiza el seed (y se verifica en CI):** ver los 5 `INVARIANTES` de arriba, más que el hash de las vistas agregadas sea idéntico entre ejecuciones.

### 3.4 Uso para UAT sin contaminar producción

```mermaid
flowchart LR
    A["infra/seed/01-maestros.sql<br/>+ seed-operacion.ts"] --> B["Compose staging<br/>BD tanta_staging"]
    B --> C["UAT 19-20/11<br/>usuario clave de Tanta"]
    C --> D["Hallazgos → docs/qa/UAT-*.md"]
    D --> E["Corrección"]
    E --> B
    B -.->|"PROHIBIDO"| F["BD producción tanta"]
    G["Producción"] --> H["Backup R2"]
    H -.->|"PROHIBIDO restaurar en staging"| B
```

Reglas duras:

1. **Staging nunca ve un dump de producción.** Si un bug solo se reproduce con datos reales, se exporta **el caso mínimo** (3–5 filas) a un fixture anonimizado y revisado por el Líder.
2. **MFA desactivado en staging** vía `AUTH_MFA_ENFORCED=false` para que la UAT no dependa del teléfono de nadie. En producción es `true` y no es configurable por entorno del cliente.
3. **Reloj inyectable.** `CLOCK_FIXED_AT=2026-11-20T15:00:00-05:00` en staging para que la UAT del 19–20/11 vea "hoy" en el seed.
4. **Un usuario por perfil con credenciales impresas** (`uat.cliente@tanta.test` / `uat.produccion@…`), y la contraseña se cambia al terminar la UAT. Nunca la del seed en producción.
5. Al cerrar la UAT, `docker compose -f compose.staging.yml stop` — el contenedor de staging no corre fuera de ventana.

---

## 4. CI/CD

### 4.1 `.github/workflows/ci-cd.yml` (completo)

```yaml
name: ci-cd

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
    inputs:
      skip_e2e:
        description: 'Omitir E2E (solo hotfix)'
        type: boolean
        default: false

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

env:
  NODE_VERSION: '22'
  PNPM_VERSION: '9.12.0'
  REGISTRY: ghcr.io
  IMAGE_NAME: tanta-api

jobs:
  # ---------------------------------------------------------------- 1. LINT
  lint:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: '${{ env.PNPM_VERSION }}' }
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint --max-warnings=0
      - run: pnpm format:check
      - name: Flutter analyze
        uses: subosito/flutter-action@v2
        with: { channel: stable, cache: true }
      - run: cd apps/mobile && flutter pub get && flutter analyze --fatal-infos

  # ------------------------------------------------------------ 2. TYPECHECK
  typecheck:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: '${{ env.PNPM_VERSION }}' }
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r typecheck

  # -------------------------------------------------------- 3. TEST UNITARIO
  unit:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: '${{ env.PNPM_VERSION }}' }
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:unit --coverage --project=unit
      - name: Gate de cobertura por ruta (dinero)
        run: pnpm exec coverage-check --config .coverage-gate.json
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: coverage, path: '**/coverage/lcov.info', retention-days: 7 }

  # ---------------------------------------------- 4. TEST INTEGRACIÓN (Postgres real)
  integration:
    runs-on: ubuntu-24.04
    needs: [typecheck]
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_USER: tanta
          POSTGRES_PASSWORD: tanta
          POSTGRES_DB: tanta_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U tanta -d tanta_test"
          --health-interval 5s --health-timeout 5s --health-retries 12
    env:
      DATABASE_URL: 'postgresql://tanta:tanta@localhost:5432/tanta_test?schema=public&connection_limit=10'
      NODE_ENV: test
      TZ: America/Lima
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: '${{ env.PNPM_VERSION }}' }
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm prisma generate
      - name: Migraciones desde cero + seed base
        run: |
          pnpm prisma migrate deploy
          psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/seed/01-maestros.sql
      - run: pnpm test:integration --coverage
      - name: Reversibilidad de migraciones (expand/contract)
        run: |
          pnpm prisma migrate diff \
            --from-schema-datasource prisma/schema.prisma \
            --to-schema-datamodel prisma/schema.prisma \
            --exit-code
      - name: Bloques destructivos requieren label
        if: ${{ !contains(github.event.pull_request.labels.*.name, 'allow-destructive') }}
        run: pnpm tsx scripts/check-destructive-migrations.ts

  # ---------------------------------------------------------- 5. CONTRATO
  contract:
    runs-on: ubuntu-24.04
    needs: [typecheck]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: '${{ env.PNPM_VERSION }}' }
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - name: Generar OpenAPI 3.1 desde el código
        run: pnpm --filter @tanta/api openapi:generate
      - name: Build de clientes generados (TS + Dart)
        run: |
          pnpm --filter @tanta/contracts build
          cd packages/contracts && dart run build_runner build --delete-conflicting-outputs
      - name: Cambios rompientes del contrato
        run: |
          oasdiff breaking packages/contracts/openapi.prev.json \
                          packages/contracts/openapi.json --fail-on ERR
      - uses: actions/upload-artifact@v4
        with: { name: openapi, path: packages/contracts/openapi.json }

  # -------------------------------------------------------------- 6. E2E WEB
  e2e:
    if: ${{ github.event_name == 'push' && inputs.skip_e2e != true }}
    runs-on: ubuntu-24.04
    needs: [integration, contract]
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: '${{ env.PNPM_VERSION }}' }
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - name: Levantar el stack con seed
        run: |
          docker compose -f infra/compose/compose.test.yml up -d --wait
          pnpm seed:demo
      - run: pnpm exec playwright install --with-deps chromium firefox
      - run: pnpm e2e --project=chromium --project=firefox-smoke
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: apps/web/test-results/, retention-days: 7 }
      - if: always()
        run: docker compose -f infra/compose/compose.test.yml down -v

  # ------------------------------------------------------- 7. BUILD + ESCANEO
  build:
    if: ${{ github.event_name == 'push' }}
    runs-on: ubuntu-24.04
    needs: [lint, unit, integration, contract]
    permissions:
      contents: read
      packages: write
    outputs:
      image: ${{ steps.meta.outputs.image }}
      tag: ${{ steps.meta.outputs.tag }}
    steps:
      - uses: actions/checkout@v4
      - id: meta
        run: |
          OWNER=$(echo "${{ github.repository_owner }}" | tr '[:upper:]' '[:lower:]')
          echo "image=${{ env.REGISTRY }}/${OWNER}/${{ env.IMAGE_NAME }}" >> "$GITHUB_OUTPUT"
          echo "tag=${GITHUB_SHA::12}" >> "$GITHUB_OUTPUT"
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/api/Dockerfile
          push: false
          load: true
          tags: ${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.tag }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - name: Trivy · vulnerabilidades de la imagen
        uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: ${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.tag }}
          format: table
          severity: CRITICAL,HIGH
          ignore-unfixed: true
          exit-code: '1'
      - name: Trivy · misconfiguración de IaC
        uses: aquasecurity/trivy-action@0.28.0
        with:
          scan-type: config
          scan-ref: infra/
          severity: CRITICAL,HIGH
          exit-code: '1'
      - name: SBOM (CycloneDX)
        uses: anchore/sbom-action@v0
        with:
          image: ${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.tag }}
          format: cyclonedx-json
          output-file: sbom.json
      - uses: actions/upload-artifact@v4
        with: { name: sbom, path: sbom.json }
      - name: Push a GHCR
        run: |
          echo "${{ secrets.GITHUB_TOKEN }}" | docker login ${{ env.REGISTRY }} -u ${{ github.actor }} --password-stdin
          docker push ${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.tag }}
          docker tag ${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.tag }} \
                     ${{ steps.meta.outputs.image }}:sha-${GITHUB_SHA}
          docker push ${{ steps.meta.outputs.image }}:sha-${GITHUB_SHA}

  # ------------------------------------------------------ 8. DEPLOY STAGING
  deploy-staging:
    runs-on: ubuntu-24.04
    needs: [build, e2e]
    environment: staging
    # `always()` + chequeo explícito: permite desplegar un hotfix aunque E2E se haya
    # omitido a propósito (`skip_e2e=true`), pero nunca si el build falló.
    if: >-
      ${{ always() && needs.build.result == 'success'
          && (needs.e2e.result == 'success' || needs.e2e.result == 'skipped') }}
    steps:
      - uses: actions/checkout@v4
      - name: Preparar clave SSH
        run: |
          install -m 700 -d ~/.ssh
          echo "${{ secrets.VPS_SSH_KEY }}" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519
          ssh-keyscan -H "${{ secrets.VPS_HOST }}" >> ~/.ssh/known_hosts
      - name: Deploy a staging
        run: |
          ssh "${{ secrets.VPS_USER }}@${{ secrets.VPS_HOST }}" \
            "ENV_FILE=.env.staging bash /srv/tanta/infra/scripts/deploy.sh \
             --color=auto --image=${{ needs.build.outputs.image }} --tag=${{ needs.build.outputs.tag }}"

  # ---------------------------------------------------- 9. SMOKE STAGING
  smoke-staging:
    runs-on: ubuntu-24.04
    needs: [deploy-staging]
    steps:
      - uses: actions/checkout@v4
      - name: Smoke funcional completo (lectura + escritura)
        env:
          BASE_URL: https://staging.tantapanaderia.com
          SMOKE_USER: ci-smoke@tanta.test
          SMOKE_PASS: ${{ secrets.SMOKE_PASS }}
        run: pnpm tsx scripts/smoke.ts --write

  # ------------------------------------------- 10. APROBACIÓN MANUAL (gate)
  # El gate es el `environment: production` con "Required reviewers".
  # No se simula con un step: GitHub bloquea el job hasta la aprobación.

  # -------------------------------------- 11. MIGRACIÓN PRISMA (producción)
  migrate:
    if: ${{ github.event_name == 'push' }}
    runs-on: ubuntu-24.04
    needs: [smoke-staging]
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Preparar clave SSH
        run: |
          install -m 700 -d ~/.ssh
          echo "${{ secrets.VPS_SSH_KEY }}" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519
          ssh-keyscan -H "${{ secrets.VPS_HOST }}" >> ~/.ssh/known_hosts
      - name: Backup lógico previo (obligatorio)
        run: |
          ssh "${{ secrets.VPS_USER }}@${{ secrets.VPS_HOST }}" \
            "systemctl start tanta-backup.service && \
             test \$(find /srv/tanta/backups -name '*.dump.age' -newermt '-40 minutes' | wc -l) -ge 1"
      - name: Aplicar migraciones (solo aditivas)
        run: |
          ssh "${{ secrets.VPS_USER }}@${{ secrets.VPS_HOST }}" \
            "cd /srv/tanta && docker run --rm --env-file .env.prod \
             ${{ needs.build.outputs.image }}:${{ needs.build.outputs.tag }} \
             pnpm prisma migrate deploy"

  # --------------------------------------------------- 12. DEPLOY PRODUCCIÓN
  deploy-production:
    runs-on: ubuntu-24.04
    needs: [migrate]
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Preparar clave SSH
        run: |
          install -m 700 -d ~/.ssh
          echo "${{ secrets.VPS_SSH_KEY }}" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519
          ssh-keyscan -H "${{ secrets.VPS_HOST }}" >> ~/.ssh/known_hosts
      - name: Blue/green deploy
        run: |
          ssh "${{ secrets.VPS_USER }}@${{ secrets.VPS_HOST }}" \
            "ENV_FILE=.env.prod bash /srv/tanta/infra/scripts/deploy.sh \
             --image=${{ needs.build.outputs.image }} --tag=${{ needs.build.outputs.tag }}"

  # ------------------------------------------------------ 13. SMOKE PROD
  smoke-production:
    runs-on: ubuntu-24.04
    needs: [deploy-production]
    steps:
      - uses: actions/checkout@v4
      - name: Smoke de solo lectura
        env:
          BASE_URL: https://www.tantapanaderia.com
          SMOKE_USER: ci-readonly@tanta.test
          SMOKE_PASS: ${{ secrets.SMOKE_PASS_PROD }}
        run: pnpm tsx scripts/smoke.ts --read-only
      - name: Rollback automático si el smoke falla
        if: failure()
        run: |
          ssh "${{ secrets.VPS_USER }}@${{ secrets.VPS_HOST }}" \
            "ENV_FILE=.env.prod bash /srv/tanta/infra/scripts/rollback.sh --to=previous"
```

### 4.2 `infra/scripts/deploy.sh` — blue/green sin downtime

```bash
#!/usr/bin/env bash
set -euo pipefail

IMAGE=""; TAG=""; COLOR_AUTO=true
for arg in "$@"; do
  case "$arg" in
    --image=*) IMAGE="${arg#*=}" ;;
    --tag=*)   TAG="${arg#*=}" ;;
    --color=*) COLOR="${arg#*=}" ;;
    *) echo "arg desconocido: $arg" >&2; exit 2 ;;
  esac
done

cd /srv/tanta
ENV_FILE="${ENV_FILE:-.env.prod}"
# ENV_FILE se exporta desde el runner: .env.prod o .env.staging
set -a; source "$ENV_FILE"; set +a

# 1. Detectar el color vivo y el libre.
LIVE=$(cat .live-color 2>/dev/null || echo blue)
[[ "$LIVE" == "blue" ]] && NEXT=green || NEXT=blue
echo "==> vivo=$LIVE  nuevo=$NEXT  tag=$TAG"

# 2. Registrar el tag anterior para rollback.
if [[ -f .live-tag ]]; then cp .live-tag .previous-tag; fi

# 3. Levantar el color nuevo con la imagen nueva (sin tocar el vivo).
API_IMAGE="${IMAGE}:${TAG}" docker compose -f infra/compose/compose.prod.yml \
  --env-file "$ENV_FILE" -p tanta up -d --no-deps --scale "api-${NEXT}=1" --scale "api-${LIVE}=1" "api-${NEXT}"

# 4. Esperar readiness del color nuevo (máx. 90 s).
for i in $(seq 1 45); do
  if docker compose -f infra/compose/compose.prod.yml -p tanta \
       exec -T "api-${NEXT}" wget -qO- http://127.0.0.1:3000/health/ready >/dev/null 2>&1; then
    echo "==> api-${NEXT} ready en ${i}x2s"; break
  fi
  [[ $i -eq 45 ]] && { echo "FATAL: api-${NEXT} no llegó a ready" >&2; exit 1; }
  sleep 2
done

# 5. Flip: Caddy deja de enrutar al viejo (health check activo, 2 s).
#    Caddy ya tiene los dos upstreams; el que no responde /health/ready sale del pool.
echo "==> flip a api-${NEXT}"
echo "$NEXT" > .live-color
echo "$TAG"  > .live-tag

# 6. Drenar y bajar el color viejo tras 10 min de convivencia.
sleep 600
docker compose -f infra/compose/compose.prod.yml --env-file "$ENV_FILE" -p tanta \
  up -d --no-deps --scale "api-${LIVE}=0" "api-${LIVE}" || true

# 7. Higiene de disco: imágenes de más de 7 días.
docker image prune -f --filter "until=168h" >/dev/null
echo "==> deploy OK: $IMAGE:$TAG en api-${NEXT}"
```

`infra/caddy/Caddyfile`, upstream con health check:

```caddy
www.tantapanaderia.com, tantapanaderia.com {
	encode zstd gzip

	@api path /api/* /health/*
	handle @api {
		reverse_proxy api-blue:3000 api-green:3000 {
			lb_policy first
			lb_try_duration 10s
			health_uri /health/ready
			health_interval 2s
			health_timeout 2s
			header_up X-Real-IP {remote_host}
		}
	}

	handle {
		root * /srv/web
		try_files {path} /index.html
		file_server
		header {
			Strict-Transport-Security "max-age=31536000; includeSubDomains"
			X-Content-Type-Options "nosniff"
			X-Frame-Options "DENY"
			Referrer-Policy "strict-origin-when-cross-origin"
			-Server
		}
	}

	log {
		output file /var/log/caddy/access.log {
			roll_size 20mb
			roll_keep 5
		}
		format json
	}
}

staging.tantapanaderia.com {
	basic_auth {
		staging $2a$14$REEMPLAZAR_HASH_ARGON2ID
	}
	reverse_proxy api-staging:3000
}
```

### 4.3 Migraciones sin downtime: *expand/contract*

Regla: **ninguna migración puede romper la versión anterior del código**. Se hace en dos releases.

| Release | Migración | Código |
|---|---|---|
| N | `ALTER TABLE core.venta ADD COLUMN canal text NULL` (aditiva, nullable) | Escribe en `canal` si existe; sigue leyendo `origen` |
| N | Backfill por lotes con pg-boss (10k filas por job) | — |
| N+1 | `ALTER TABLE core.venta ALTER COLUMN canal SET NOT NULL` + `CHECK` | Ya no lee `origen` |
| N+2 | `DROP COLUMN origen` (destructiva, con label `allow-destructive`) | — |

Prohibido en el mismo release: renombrar columna, cambiar tipo, `DROP`, `SET NOT NULL` sobre columna nueva, crear índice sin `CONCURRENTLY`.

```sql
-- Índices siempre sin bloqueo
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_movimiento_insumo_fecha
  ON core.movimiento_inventario (insumo_id, creado_en DESC);
```

`CREATE INDEX CONCURRENTLY` **no** puede ir dentro de una transacción: se marca la migración con `-- prisma: no-transaction` y se ejecuta en un job separado. Se documenta en la cabecera del archivo de migración.

**Ventana de riesgo:** migraciones que tocan tablas grandes (> 1 M filas) solo entre 02:00 y 04:00 America/Lima, con Caddy sirviendo una página 503 estática si el `lb_try_duration` se agota.

### 4.4 Rollback

| Escenario | Acción | Tiempo |
|---|---|---|
| Bug funcional, esquema compatible | `rollback.sh --to=previous` → vuelve el tag anterior en GHCR | 90 s |
| Bug + migración aditiva ya aplicada | Igual. El código N−1 opera sobre el esquema N (probado en QA-21) | 90 s |
| Migración destructiva ya aplicada | **No hay rollback de código.** Restaurar desde PITR (runbook R-06) | 45 min |
| Imagen corrupta / no arranca | Caddy mantiene el color vivo; el nuevo nunca recibió tráfico | 0 (el deploy falló antes del flip) |
| Base de datos corrupta | PITR al último WAL válido | 45 min |

```bash
#!/usr/bin/env bash
# infra/scripts/rollback.sh
set -euo pipefail
cd /srv/tanta
ENV_FILE="${ENV_FILE:-.env.prod}"
PREV=$(cat .previous-tag)
echo "==> rollback a $PREV"
API_IMAGE="ghcr.io/esolutionsnet/tanta-api:$PREV" \
  docker compose -f infra/compose/compose.prod.yml --env-file "$ENV_FILE" -p tanta \
  up -d --no-deps --force-recreate api-blue api-green
sleep 15
curl -fsS --retry 10 --retry-delay 3 http://127.0.0.1:3000/health/ready
echo "==> rollback OK a $PREV"
```

Se conservan las **últimas 10 imágenes** en GHCR (política de retención del paquete). Un rollback nunca requiere reconstruir.

### 4.5 Puertas de calidad (resumen ejecutable)

| Puerta | Falla el pipeline si… |
|---|---|
| Lint | `--max-warnings=0` no se cumple, o `flutter analyze --fatal-infos` reporta algo |
| Typecheck | Cualquier error de TS o de tipos generados |
| Unit | Un test falla, o la cobertura por ruta baja del umbral (§1.2) |
| Integración | Un caso de §2 falla, o una migración no aplica desde cero |
| Contrato | `oasdiff` detecta un cambio rompiente sin label `breaking-change` |
| E2E | Un flujo de Playwright falla |
| Trivy | CVE `CRITICAL` o `HIGH` con fix disponible, o misconfig `CRITICAL` |
| Migración | Hay `DROP`/`RENAME` sin label `allow-destructive` |
| Smoke staging | Cualquier check falla |
| Smoke producción | Falla → rollback automático |

---

## 5. Infraestructura y dimensionamiento

### 5.1 Cálculo de carga (por qué el VPS es pequeño)

| Variable | Valor | Cálculo |
|---|---|---|
| Usuarios concurrentes | **20** | 4 tablets de producción + 8 vendedores + 2 almacén + 3 admin/gerencia + 3 de holgura |
| Pedidos/día | **200** | ~45 líneas/hora en el pico (06:00–10:00 concentra el 80 %) |
| Requests/día | ~9,000 | 200 pedidos × 30 lecturas + 600 sincronizaciones + dashboard |
| Requests en el pico | **~1.2 req/s** | 9,000 × 0.55 / (4 h × 3,600 s) = 0.34; ×3.5 de factor de ráfaga |
| Conexiones a Postgres | 26 | API (Prisma `connection_limit=15`) + pg-boss (4) + backups/psql (2) + holgura (5) |
| Escrituras/s en el pico | ~4 | Pedido + 3–6 movimientos en una transacción |

**Conclusión:** el sistema está **dos órdenes de magnitud** por debajo de la capacidad de un núcleo moderno. Un `t3.small` (2 vCPU/2 GB) lo serviría. El VPS se dimensiona por **RAM y por margen operativo**, no por CPU.

### 5.2 VPS elegido

**Hetzner Cloud CPX31 · Ashburn, US-East** — 4 vCPU AMD EPYC (shared), 8 GB RAM, 160 GB NVMe, 20 TB tráfico.

Justificación de cada decisión:

- **Por qué 8 GB y no 2 GB:** Postgres necesita `shared_buffers` + `work_mem`; el ensayo de restauración (obligatorio) levanta un segundo Postgres de 2 GB mientras producción corre; staging arranca en ventana de deploy. Con 2 GB, el ensayo de restauración se hace sobre producción o no se hace. **La RAM compra la capacidad de ensayar la recuperación.**
- **Por qué 4 vCPU:** `pg_dump -Z9` a un solo hilo satura un núcleo 6–8 min; con 4 vCPU el backup no degrada la API.
- **Por qué 160 GB:** uso estimado al año 3 = 25 GB (SO 8 + imágenes 4 + BD 6 + WAL 3 + logs 2 + staging 2). 16 % de ocupación. La alerta salta al 70 %.
- **Por qué Ashburn y no Lima:** no hay proveedor cloud de esta relación precio/rendimiento en Perú. Lima→Ashburn ≈ **65 ms**; con Cloudflare por delante (proxy naranja para la web, DNS-only para `/api`), la web queda cacheada en el edge y la API a 65 ms es imperceptible para un formulario de pedido. `[AMPLIACIÓN]` Cloudflare como capa de caché y anti-DDoS básico.
- **Por qué no managed Postgres:** el plan más barato (DO Managed, 1 GB) es USD 15/mes = **38 % del ingreso mensual** y ocupa el lugar del VPS. Se descarta para esta escala; se reevalúa si se superan 60 usuarios concurrentes.

### 5.3 Composición

```mermaid
flowchart TB
    U["Tablets · celulares · navegador"] --> CF["Cloudflare<br/>proxy + anti-DDoS"]
    CF --> CADDY["Caddy 2<br/>TLS · proxy · headers · logs"]
    CADDY -->|"/api/* /health/*"| BLUE["api-blue :3000<br/>NestJS + pg-boss"]
    CADDY -->|"fallback"| GREEN["api-green :3000<br/>(idle)"]
    CADDY -->|"static"| WEB["/srv/web<br/>build React"]
    BLUE --> PG[("postgres:17<br/>shared_buffers=1GB")]
    GREEN --> PG
    PG --> WALG["wal-g<br/>WAL → R2 cada 60 s"]
    PG --> DUMP["pg_dump diario 02:30<br/>age + aws-cli → R2"]
    BLUE --> R2["Cloudflare R2<br/>dumps · WAL · PDF"]
    BLUE --> SENTRY["Sentry SaaS"]
    UPTIME["UptimeRobot<br/>3 regiones · 1 min"] --> CADDY
```

### 5.4 `infra/compose/compose.prod.yml` — límites y tuning

```yaml
name: tanta

x-logging: &logging
  logging:
    driver: json-file
    options: { max-size: "20m", max-file: "5" }

services:
  caddy:
    image: caddy:2.8-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443", "443:443/udp"]
    volumes:
      - ../caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
      - /srv/web:/srv/web:ro
      - /var/log/caddy:/var/log/caddy
    deploy:
      resources:
        limits: { cpus: "0.50", memory: 192M }
        reservations: { memory: 32M }
    <<: *logging

  api-blue:
    image: ${API_IMAGE:-ghcr.io/esolutionsnet/tanta-api:latest}
    restart: unless-stopped
    env_file: [../../.env.prod]
    depends_on:
      postgres: { condition: service_healthy }
    deploy:
      resources:
        limits: { cpus: "1.50", memory: 1024M }
        reservations: { memory: 512M }
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health/live"]
      interval: 15s
      timeout: 3s
      retries: 3
      start_period: 30s
    <<: *logging

  api-green:
    image: ${API_IMAGE:-ghcr.io/esolutionsnet/tanta-api:latest}
    restart: unless-stopped
    env_file: [../../.env.prod]
    depends_on:
      postgres: { condition: service_healthy }
    deploy:
      resources:
        limits: { cpus: "1.50", memory: 1024M }
        reservations: { memory: 512M }
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health/live"]
      interval: 15s
      timeout: 3s
      retries: 3
      start_period: 30s
    <<: *logging

  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    shm_size: 512mb
    environment:
      POSTGRES_DB: tanta
      POSTGRES_USER: tanta
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_pass
      TZ: America/Lima
      PGTZ: America/Lima
    command: >
      postgres
      -c shared_buffers=1GB
      -c effective_cache_size=3GB
      -c work_mem=16MB
      -c maintenance_work_mem=256MB
      -c max_connections=60
      -c wal_level=replica
      -c archive_mode=on
      -c archive_command='wal-g wal-push %p'
      -c archive_timeout=60
      -c max_wal_size=2GB
      -c min_wal_size=512MB
      -c checkpoint_completion_target=0.9
      -c random_page_cost=1.1
      -c log_min_duration_statement=500
      -c shared_preload_libraries=pg_stat_statements
      -c timezone=America/Lima
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ../backup/walg:/etc/walg:ro
    secrets: [pg_pass]
    deploy:
      resources:
        limits: { cpus: "2.00", memory: 3072M }
        reservations: { memory: 1024M }
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tanta -d tanta -t 3"]
      interval: 10s
      timeout: 3s
      retries: 5
    <<: *logging

  backup:
    image: ghcr.io/esolutionsnet/tanta-backup:1.4
    restart: unless-stopped
    env_file: [../../.env.prod]
    depends_on:
      postgres: { condition: service_healthy }
    deploy:
      resources:
        limits: { cpus: "0.50", memory: 256M }
    <<: *logging

volumes:
  pg_data:
  caddy_data:
  caddy_config:

secrets:
  pg_pass:
    file: /srv/tanta/secrets/pg_pass
```

**Presupuesto de RAM en régimen (GB):** Caddy 0.03 + api-blue 0.45 + api-green 0 (0 réplicas) + postgres 1.9 + backup 0.05 + SO y Docker 0.9 = **3.33 de 8**. Holgura del 58 %. En ventana de deploy con los dos colores vivos: 3.78 GB. En ensayo de restauración (segundo Postgres de 2 GB): **5.8 GB**. Nunca se llega al OOM. Esta es la razón exacta por la que se compran 8 GB y no 4.

**Presupuesto de CPU:** el pico medido es 1.2 req/s ≈ 4 % de un núcleo. `pg_dump` semanal es el único consumidor real (1 núcleo, 8 min). Sobra capacidad.

**Sobre el host:** swapfile de 2 GB con `vm.swappiness=10` (amortigua un pico de `pg_dump`, no es memoria de trabajo), `vm.overcommit_memory=0`, `net.core.somaxconn=1024`, clock sync con `chrony` (crítico: el día operativo y los JWT dependen del reloj), `fail2ban` sobre SSH, `ufw` cerrado salvo 22/80/443, `unattended-upgrades` solo parches de seguridad, acceso SSH únicamente con clave.

**Regla de arranque (D13-11):** `postgres` valida al arrancar que `shared_buffers + (max_connections × work_mem) + maintenance_work_mem ≤ 0.75 × límite de memoria del contenedor`; si no, aborta con un mensaje explícito. Sin esto, un `max_connections` alto tumba la BD por OOM a las 3 a.m.

### 5.5 Cuándo escalar

| Disparador | Umbral sostenido | Acción |
|---|---|---|
| CPU del VPS | p95 > 60 % durante 15 min, 3 días | Subir a CPX41 (8 vCPU / 16 GB): +USD 11.5/mes |
| Latencia p95 de la API | > 800 ms durante 10 min | Revisar `pg_stat_statements` antes de escalar |
| Pedidos/día | > 600 (3× el dimensionamiento) | Separar `worker` de pg-boss y añadir réplica de API |
| Usuarios concurrentes | > 60 | Mover Postgres a managed (Neon / DO Managed) |
| Disco | > 70 % (112 GB) | Revisar retención de logs y WAL; luego block storage |
| `movimiento_inventario` | > 10 M filas | Particionar por mes (`PARTITION BY RANGE (creado_en)`) |

Ninguno de estos disparadores se alcanza en el año 1 con la operación declarada. Por eso el VPS es de USD ~20 y no de USD ~80.

### 5.6 Costo mensual y veredicto de margen

| Concepto | Detalle | USD/mes | Soles/mes (×3.78) |
|---|---|---|---|
| VPS Hetzner CPX31 US-East | 4 vCPU / 8 GB / 160 GB NVMe | 15.59 | 58.93 |
| IPv4 + snapshots (20 %) | backup del volumen del proveedor | 4.24 | 16.03 |
| Cloudflare R2 | ~25 GB (30 dumps + 7 días de WAL); 10 GB gratis, luego USD 0.015/GB | 0.35 | 1.32 |
| Dominio `tantapanaderia.com` | S/ 78/año ÷ 12 | 1.72 | 6.50 |
| Sentry Free | 5k errores/mes, 1 usuario | 0.00 | 0.00 |
| UptimeRobot Free | 50 monitores, 5 min | 0.00 | 0.00 |
| GitHub Actions + GHCR | repo privado, 2,000 min/mes; el pipeline consume ~380 min/mes | 0.00 | 0.00 |
| TLS + monitorización + Cloudflare | plan gratuito | 0.00 | 0.00 |
| **Costo de infraestructura** | | **21.90** | **82.78** |
| **Ingreso (S/ 150 sin IGV)** | | **39.68** | **150.00** |
| **Margen bruto de infraestructura** | | **17.78** | **67.22** |

**Veredicto: NO es viable tal como está redactado el §9.3 de la propuesta.**

El §9.3 promete alojamiento + SSL + monitoreo + **copias con retención de 30 días** + **mantenimiento correctivo** + **actualizaciones de seguridad** + **soporte técnico en horario de oficina**. Los cuatro primeros caben en S/ 82.78. Los tres últimos son **trabajo humano**, y S/ 67.22/mes compra:

- a costo cargado de S/ 25/h (analista S/ 4,400/mes ÷ 176 h) → **2.7 horas al mes**;
- antes de impuesto a la renta. Al 29.5 % sobre el margen, quedan **S/ 47.39 → 1.9 horas**.

Dos horas al mes no sostienen "soporte en horario de oficina" más parches de seguridad más atención a incidentes. En cualquier mes con un incidente real, el contrato es deficitario.

**Configuraciones evaluadas:**

| Config | Composición | Costo infra | Margen | Trabajo cubierto | Veredicto |
|---|---|---|---|---|---|
| **A · S/ 150 "todo incluido"** | VPS 4/8 + staging en el mismo host + Sentry free | S/ 82.78 | S/ 67.22 | 2.7 h | **No viable.** |
| **B · S/ 150 hosting-only** | Igual, con SLA de *best effort* y tope de **3 h/mes**; excedente a S/ 90/h | S/ 82.78 | S/ 67.22 | 3 h | **Viable**, con tope escrito. |
| **C · S/ 150 + segundo VPS para staging** | + CPX11 USD 6.50 | S/ 107.35 | S/ 42.65 | 1.7 h | **No viable.** Es la razón de D13-05. |
| **D · S/ 150 + Sentry Team (USD 26)** | Necesario si se superan 5k errores/mes o se quiere alertas por equipo | S/ 181.06 | **−S/ 31.06** | — | **Deficitario.** |
| **E · Reprecio: infra S/ 150 + soporte S/ 150** | Config B con 6 h/mes de soporte real | S/ 82.78 | S/ 217.22 | 8.7 h | **Recomendado.** |
| **F · Reprecio todo incluido S/ 280** | Config B, SLA de 8 h hábiles, 4 h/mes | S/ 82.78 | S/ 197.22 | 7.9 h | **Recomendado desde el mes 13.** |

**Decisión (D13-18):** mantener **S/ 150/mes durante los primeros 12 meses** como precio de adquisición, con el alcance reescrito a *"alojamiento, TLS, monitoreo de disponibilidad, respaldos con retención de 30 días, parches de seguridad y hasta 3 horas mensuales de mantenimiento correctivo; excedente a S/ 90/hora"*. Comunicarlo al cliente **antes** de la firma, no después del primer incidente. Renovación a **S/ 220/mes** desde el mes 13.

Si el cliente no acepta el tope de 3 h, la única salida honesta es **subir la mensualidad**, no comprimir el soporte: el sistema va a tener incidentes y alguien tiene que atenderlos.

---

## 6. Observabilidad

### 6.1 Logs estructurados con correlación

```ts
// apps/api/src/observability/logger.ts
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { uuidv7 } from 'uuidv7';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'tanta-api', env: process.env.APP_ENV, version: process.env.GIT_SHA },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie',
      'req.body.password', 'req.body.refreshToken', 'req.body.totp',
      '*.password', '*.token', '*.secret', '*.pepper',
    ],
    censor: '[REDACTED]',
  },
  formatters: { level: (label) => ({ level: label }) },
});

// Middleware: requestId propio (UUIDv7, ordenable) o el que traiga el cliente.
export function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && /^[0-9a-f-]{36}$/i.test(incoming) ? incoming : uuidv7();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

// Todo job de pg-boss arrastra el requestId del request que lo originó.
export async function encolar(nombre: string, data: object, requestId: string) {
  return boss.send(nombre, { ...data, requestId }, { retryLimit: 5, retryBackoff: true });
}
```

Campos obligatorios en toda línea de log: `requestId`, `userId`, `sucursalId`, `route`, `method`, `status`, `durationMs`, `version`. Un log sin `requestId` es un bug de observabilidad y falla el test de integración que verifica el header.

**Línea base de log por request (una sola línea, no diez):**

```json
{"level":"info","time":"2026-11-20T12:04:31.882Z","service":"tanta-api","env":"prod","version":"a1b2c3d4e5f6","requestId":"0192b1c3-4d5e-7f60-8123-456789abcdef","userId":"0192a...901","route":"POST /api/v1/ventas","status":201,"durationMs":184,"idempotencyKey":"0192b1...","ventaId":"0192b1..."}
```

**No se loguea** el cuerpo completo de las mutaciones: solo el `id` resultante y los campos que cambian el dinero (`total`, `costoTotal`, `margen`). El cuerpo completo va a `audit.evento` con hash encadenado, no a los logs.

### 6.2 Métricas que importan

Se exponen en `GET /metrics` (puerto interno 9464, no expuesto por Caddy). Sin Prometheus en el VPS: un job de pg-boss cada 60 s calcula los SLI y los persiste en `report.metrica_snapshot`, que alimenta `/api/v1/gerencia/salud` (panel del Administrador) y las alertas de Sentry.

| Métrica | Tipo | Consulta / origen | Alerta |
|---|---|---|---|
| `http_request_duration_seconds{route,status}` | histograma | `prom-client` en middleware | p95 > 800 ms, 10 min |
| `http_requests_total{route,status}` | contador | idem | tasa 5xx > 1 % en 5 min |
| `pgboss_job_age_seconds{queue}` | gauge | `SELECT max(created_on)` de `pgboss.job` con `state='created'` | > 120 s |
| `pgboss_job_failed_total{queue}` | contador | `pgboss.job` con `state='failed'` | > 5 en 15 min |
| `sync_pendientes{dispositivo_id}` | gauge | outbox del servidor por dispositivo | > 200 durante 10 min |
| `sync_ultimo_exito_segundos` | gauge | `max(recibido_en)` por dispositivo | > 900 s en horario 04:00–20:00 |
| `saldo_negativo_total` | contador | `SELECT count(*) FROM core.saldo_inventario WHERE saldo_cantidad < 0` | política estricta: **> 0 → página inmediata**; permisiva: > 0 por 24 h → alerta |
| `backup_ultimo_exito_segundos` | gauge | edad del objeto más reciente en R2 | > 93,600 s (26 h) |
| `wal_archivo_edad_segundos` | gauge | `pg_stat_archiver.last_archived_time` | > 300 s |
| `pg_database_size_bytes` | gauge | `pg_database_size('tanta')` | > 70 % del disco |
| `pg_stat_activity_count{state}` | gauge | `pg_stat_activity` | active > 40 |
| `cif_prorrateo_diferencia` | gauge | `SUM(cif_asignado) - cif_periodo` | ≠ 0 al cerrar período |

Cuatro de estas son específicas de este negocio y son las que de verdad importan: **saldo negativo**, **sync pendientes por dispositivo**, **frescura del backup** y **cuadre del CIF**. Un dashboard de CPU no habría detectado ninguno de los incidentes que este sistema va a tener.

### 6.3 Health checks

| Endpoint | Qué verifica | Timeout | Quién lo usa |
|---|---|---|---|
| `GET /health/live` | El proceso responde. **Ninguna dependencia.** | 1 s | `healthcheck` de Docker, Caddy |
| `GET /health/ready` | `SELECT 1` (2 s) + migraciones al día + pg-boss iniciado | 3 s | Caddy (pool), smoke test, deploy |
| `GET /health/deep` | Todo lo anterior + edad del backup + profundidad de colas + disco + `pg_stat_archiver` | 5 s | Monitor externo cada 5 min (autenticado) |

```ts
// apps/api/src/health/health.controller.ts
@Controller('health')
export class HealthController {
  @Get('live')
  live() { return { status: 'ok', ts: new Date().toISOString() }; }

  @Get('ready')
  @HttpCode(200)
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks = {
      db: await this.db.ping(2000),
      migrations: await this.prisma.checkMigrationsUpToDate(),
      queue: this.boss.isStarted(),
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) res.status(503);
    return { status: ok ? 'ok' : 'degraded', checks };
  }
}
```

`/health/ready` **no** consulta el backup ni las colas: si un backup falla, la API sigue sirviendo. Mezclar salud con alertas es cómo se tumba producción por un cron roto.

### 6.4 Sentry: qué se alerta y qué no

```ts
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.APP_ENV,          // production | staging
  release: process.env.GIT_SHA,
  tracesSampleRate: 0.05,                     // 5 %: suficiente para p95, cabe en el free tier
  profilesSampleRate: 0,
  ignoreErrors: ['NivelError.STOCK_INSUFICIENTE', 'NivelError.PERIODO_CERRADO',
                 'NivelError.IDEMPOTENCY_KEY_REUSED'],
  beforeSend(event) {
    // Los 4xx de negocio no son incidentes: son el negocio funcionando.
    if (event.tags?.status && Number(event.tags.status) < 500) return null;
    return event;
  },
});
```

| Alerta | Condición | Canal | Severidad |
|---|---|---|---|
| Error nuevo | Primer evento de una `fingerprint` no vista | Sentry → email + push | Informativa |
| Pico de errores | > 10 eventos en 5 min en un issue | Sentry → email + push | **Página** |
| Error en escritura | Cualquier 5xx en `POST/PATCH/PUT/DELETE` | Sentry → push | **Página** |
| Regresión de release | `crash_free_sessions` < 99 % tras deploy | Sentry → email | Bloquea el siguiente deploy |
| Job fallido | `pgboss_job_failed_total` > 5 / 15 min | Sentry (captureMessage) | Página |
| Sync caído | `sync_ultimo_exito_segundos` > 900 s en horario operativo | Sentry | **Página** |
| Backup viejo | Último dump > 26 h | UptimeRobot + Sentry | **Página** |
| Sitio caído | `/health/ready` ≠ 200 desde 3 regiones, 2 chequeos seguidos | UptimeRobot → SMS + email | **Página** |
| Certificado TLS | Vence en < 14 días | UptimeRobot | Email |
| Saldo negativo | `saldo_negativo_total > 0` con `inventario.permite_saldo_negativo = false` | Sentry | **Página inmediata** |

**Uptime monitoring:** UptimeRobot free, 5 min de intervalo, 3 regiones (US-East, US-West, EU), keyword `"status":"ok"` sobre `https://www.tantapanaderia.com/health/ready`, y un segundo monitor sobre la web con `"Tanta"` como keyword. Dos monitores, 0 USD, y detecta el 80 % de las caídas reales.

### 6.5 SLOs y qué se hace cuando se rompen

| SLO | Objetivo | Ventana | Medición | Error budget mensual |
|---|---|---|---|---|
| **Disponibilidad global** | 99.5 % | 30 días | `/health/ready` desde 3 regiones, 1 min | **3 h 36 min** |
| **Disponibilidad en horario de producción** | **99.9 %** | 04:00–12:00 Lima, lun–sáb | idem | **26 min/mes** |
| **Latencia p95 API** | < 500 ms | 30 días | `http_request_duration_seconds` | — |
| **Latencia p95 reportes** | < 3 s | 30 días | rutas `/reportes/*` y `/gerencia/*` | — |
| **Tasa de error 5xx** | < 0.5 % | 30 días | `http_requests_total` | — |
| **Frescura de backup lógico** | ≤ 26 h | continuo | edad del objeto en R2 | 0 incumplimientos |
| **RPO PITR** | ≤ 5 min | continuo | `wal_archivo_edad_segundos` | 0 incumplimientos |
| **Sync de tablets** | ≤ 15 min de retraso, 99 % de las veces | 04:00–20:00 | `sync_ultimo_exito_segundos` | — |

**Política de error budget (se aplica, no se interpreta):**

| Consumo del budget | Consecuencia |
|---|---|
| < 50 % | Operación normal. Deploys diarios permitidos. |
| 50–75 % | **Congelamiento de features.** Solo bugs, seguridad y deuda técnica. El Líder lo comunica al cliente en el informe semanal. |
| 75–100 % | Congelamiento total salvo hotfix. Revisión de incidentes obligatoria antes de cualquier cambio. |
| Agotado | Post-mortem sin culpa en 5 días hábiles, plan de acción con responsable y fecha, y **ningún deploy a producción sin aprobación del Líder y del Gerente de Tanta**. |

**La ventana de producción es la que manda:** una caída de 40 min a las 03:00 consume 0 del budget crítico; la misma caída a las 07:10 lo agota entero y dispara congelamiento. Esta asimetría es intencional y debe estar escrita en el contrato de servicio.

---

## 7. Respaldos y continuidad

### 7.1 Esquema

```mermaid
flowchart LR
    subgraph VPS
      PG[("postgres:17")]
      WAL["archiver<br/>archive_timeout=60s"]
      DUMP["tanta-backup.timer<br/>02:30 America/Lima"]
    end
    PG --> WAL -->|"wal-g wal-push"| R2
    PG --> DUMP -->|"pg_dump -Fc -Z9 | age -r"| R2
    PG --> BASE["base backup semanal<br/>wal-g backup-push"]
    BASE --> R2
    R2[("R2 · tanta-backups<br/>sin acceso público · versionado")]
    R2 -.->|"restore drill trimestral"| STG["staging"]
```

Dos líneas de defensa, no una:

1. **PITR (WAL-G):** recuperación al segundo. Cubre el borrado accidental, la migración destructiva y la corrupción lógica. Es la línea que **realmente** salva el negocio.
2. **Dump lógico diario cifrado:** recuperación de objetos sueltos, auditoría, migración a otro proveedor y defensa contra un fallo de WAL-G. Es la línea que la propuesta promete explícitamente.

### 7.2 Backup lógico diario

`infra/backup/backup.sh`, invocado por `tanta-backup.service` (systemd timer, no cron: sobrevive reinicios y queda en journald):

```bash
#!/usr/bin/env bash
# /srv/tanta/infra/backup/backup.sh — ejecutado por tanta-backup.timer
set -euo pipefail

export $(grep -v '^#' /srv/tanta/.env.prod | xargs -0 -n1 echo) 2>/dev/null || true
STAMP=$(TZ=America/Lima date +%Y%m%d-%H%M)
DAY=$(TZ=America/Lima date +%Y/%m/%d)
WORK=/srv/tanta/backups
mkdir -p "$WORK"

# 1. Dump comprimido (custom format, restaurable selectivamente por tabla).
docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta exec -T postgres \
  pg_dump -U tanta -d tanta -Fc -Z9 --no-owner --no-privileges \
  > "$WORK/tanta-$STAMP.dump"

# 2. Cifrado asimétrico: la clave privada NO vive en el VPS.
age -r "$AGE_PUBLIC_KEY" -o "$WORK/tanta-$STAMP.dump.age" "$WORK/tanta-$STAMP.dump"
sha256sum "$WORK/tanta-$STAMP.dump.age" | awk '{print $1}' > "$WORK/tanta-$STAMP.sha256"
rm -f "$WORK/tanta-$STAMP.dump"          # el plano nunca queda en disco más de lo necesario

# 3. Subida a R2 (S3-compatible, egress gratis).
aws --endpoint-url "$R2_ENDPOINT" s3 cp "$WORK/tanta-$STAMP.dump.age" \
  "s3://tanta-backups/$DAY/tanta-$STAMP.dump.age" --only-show-errors
aws --endpoint-url "$R2_ENDPOINT" s3 cp "$WORK/tanta-$STAMP.sha256" \
  "s3://tanta-backups/$DAY/tanta-$STAMP.sha256" --only-show-errors

# 4. Verificación inmediata: el objeto existe y pesa lo que debe.
LOCAL=$(stat -c%s "$WORK/tanta-$STAMP.dump.age")
REMOTE=$(aws --endpoint-url "$R2_ENDPOINT" s3api head-object \
  --bucket tanta-backups --key "$DAY/tanta-$STAMP.dump.age" --query ContentLength --output text)
[[ "$LOCAL" -eq "$REMOTE" ]] || { echo "FATAL: tamaño distinto ($LOCAL vs $REMOTE)" >&2; exit 1; }

# 5. Limpieza local (retención real está en R2).
find "$WORK" -name 'tanta-*.age' -mtime +3 -delete
find "$WORK" -name 'tanta-*.sha256' -mtime +3 -delete

# 6. Métrica para la alerta.
echo "tanta_backup_last_success_unixtime $(date +%s)" > /srv/tanta/metrics/backup.prom
```

`infra/backup/walg.env` (WAL continuo, tiempo real):

```bash
WALG_S3_PREFIX=s3://tanta-backups/wal
AWS_ENDPOINT_URL=https://<accountid>.r2.cloudflarestorage.com
AWS_REGION=auto
AWS_S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=<redacted>
AWS_SECRET_ACCESS_KEY=<redacted>
WALG_COMPRESSION_METHOD=brotli
WALG_UPLOAD_CONCURRENCY=2
```

```bash
# Base backup semanal (domingo 03:00 Lima)
0 3 * * 0 docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta \
  exec -T postgres wal-g backup-push /var/lib/postgresql/data

# Retención WAL: 4 base backups completos; el resto se poda solo.
0 4 * * 0 docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta \
  exec -T postgres wal-g delete retain FULL 4 --confirm
```

### 7.3 Retención

| Objeto | Retención | Justificación |
|---|---|---|
| Dump lógico diario | **30 días** | Es lo que promete la propuesta (§9.3) y sostiene la restauración "a una fecha". |
| Base backup WAL-G | 4 semanales (28 días) | Solape con los dumps; permite PITR de hasta 4 semanas. |
| WAL | 7 días (rolling) | El 95 % de los incidentes se detecta en menos de 48 h. |
| Dumps locales en el VPS | 3 días | Solo caché de subida. **Un backup que solo existe en el servidor no es un backup.** |
| Imágenes Docker en GHCR | 10 últimas | Rollback sin reconstruir. |
| Lifecycle rule en R2 | expira objetos a los 35 días | Controla el costo y evita acumulación infinita. |

**Claves de cifrado:** par `age` generado en el go-live. La clave privada se entrega al Gerente de Tanta en un sobre sellado + gestor de contraseñas del proveedor. **No vive en el VPS.** Si el VPS se compromete, el atacante obtiene cifrados, no datos. Sin la clave, los backups son indescifrables — incluido para el proveedor. Esto se documenta en el acta de entrega.

### 7.4 RPO / RTO

| Escenario | RPO | RTO | Se pierde |
|---|---|---|---|
| Borrado accidental de filas (anulación masiva, `UPDATE` malo) | **≤ 5 min** (PITR) | 45 min | Hasta 5 min de operación |
| Migración destructiva mal aplicada | ≤ 5 min | 45 min | Hasta 5 min |
| Corrupción del `pg_data` / disco del VPS | ≤ 5 min | **90 min** (recrear VPS + restaurar) | Hasta 5 min |
| Pérdida total del VPS y del proveedor | 24 h (último dump) | 4 h | Hasta 24 h de operación |
| Ransomware en el VPS | 24 h | 4 h | Hasta 24 h; los dumps en R2 están cifrados y son inmutables |
| Tablet perdida con outbox sin sincronizar | **No recuperable** | — | Todos los movimientos no sincronizados de ese dispositivo |

El último caso es el que hay que decir en voz alta en la capacitación: **si la tablet se pierde antes de sincronizar, ese trabajo se perdió**. Mitigación: sincronización automática cada 60 s con conexión, y un indicador visible (no un ícono escondido) de "N movimientos sin enviar" que Producción debe ver en cero antes de cerrar el turno.

### 7.5 Procedimiento de restauración — paso a paso

Se ensaya **obligatoriamente antes del go-live** (D13-20) y luego cada trimestre. Tiempo objetivo total: **≤ 45 min**. Evidencia: `docs/evidencias/restore-drill-YYYYMMDD.md` firmado.

```bash
# ─────────────────────────────────────────────────────────────
# R-01 · DECLARAR EL INCIDENTE (t = 0)
# ─────────────────────────────────────────────────────────────
# 1. Avisar al Gerente: "el sistema no está disponible, la panadería opera
#    con el formulario de contingencia". Activar el modo papel.
# 2. Congelar: bajar la API para que nadie escriba durante la restauración.
docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta stop api-blue api-green
# 3. Anotar la hora exacta del incidente. Es la referencia para el PITR.

# ─────────────────────────────────────────────────────────────
# R-02 · ELEGIR EL PUNTO DE RESTAURACIÓN (t + 5 min)
# ─────────────────────────────────────────────────────────────
# Opción A: PITR al instante previo al daño (preferida, RPO ≤ 5 min).
docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta exec -T postgres \
  wal-g backup-list
# Elegir el base backup más reciente ANTERIOR al incidente.
# Opción B: dump lógico del día (si WAL-G falló, RPO 24 h).
aws --endpoint-url "$R2_ENDPOINT" s3 ls s3://tanta-backups/ --recursive | tail -20

# ─────────────────────────────────────────────────────────────
# R-03 · PREPARAR UN DIRECTORIO LIMPIO (t + 10 min)
# ─────────────────────────────────────────────────────────────
docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta stop postgres
mv /var/lib/docker/volumes/tanta_pg_data /var/lib/docker/volumes/tanta_pg_data.BROKEN-$(date +%s)
docker volume create tanta_pg_data
chown 999:999 /var/lib/docker/volumes/tanta_pg_data/_data   # uid de postgres en la imagen

# ─────────────────────────────────────────────────────────────
# R-04A · RESTAURAR CON PITR (t + 15 min → t + 40 min)
# ─────────────────────────────────────────────────────────────
docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta run --rm --entrypoint sh postgres -c "
  wal-g backup-fetch /var/lib/postgresql/data LATEST && \
  echo \"restore_command = 'wal-g wal-fetch %f %p'\"        >> /var/lib/postgresql/data/postgresql.auto.conf && \
  echo \"recovery_target_time = '2026-11-20 07:12:00-05'\"  >> /var/lib/postgresql/data/postgresql.auto.conf && \
  echo \"recovery_target_action = 'promote'\"               >> /var/lib/postgresql/data/postgresql.auto.conf && \
  touch /var/lib/postgresql/data/recovery.signal
"
docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta up -d postgres
docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta logs -f postgres
# Esperar: "database system is ready to accept connections" y "recovery stopping before ..."

# ─────────────────────────────────────────────────────────────
# R-04B · RESTAURAR CON DUMP LÓGICO (alternativa, t + 15 min → t + 35 min)
# ─────────────────────────────────────────────────────────────
STAMP=20261120-0230
aws --endpoint-url "$R2_ENDPOINT" s3 cp \
  "s3://tanta-backups/2026/11/20/tanta-$STAMP.dump.age" /tmp/
aws --endpoint-url "$R2_ENDPOINT" s3 cp \
  "s3://tanta-backups/2026/11/20/tanta-$STAMP.sha256" /tmp/
cd /tmp && sha256sum -c <(echo "$(cat tanta-$STAMP.sha256)  tanta-$STAMP.dump.age")
age -d -i /root/.config/age/keys.txt -o tanta-$STAMP.dump tanta-$STAMP.dump.age
docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta up -d postgres
# Esperar healthy, luego:
docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta exec -T postgres \
  psql -U tanta -d tanta -c "CREATE DATABASE tanta_restore TEMPLATE template0;"
cat tanta-$STAMP.dump | docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta \
  exec -T postgres pg_restore -U tanta -d tanta_restore --no-owner --exit-on-error
# Verificar y luego promover:
docker compose ... exec -T postgres psql -U tanta -d tanta -c \
  "SELECT count(*) FROM core.pedido;"   # comparar con el manifiesto

# ─────────────────────────────────────────────────────────────
# R-05 · VERIFICAR INTEGRIDAD (t + 40 min)
# ─────────────────────────────────────────────────────────────
docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta exec -T postgres \
  psql -U tanta -d tanta <<'SQL'
-- 1. Saldo negativo: con la política estricta vigente, cualquier fila delata un fallo del asiento.
SELECT count(*) AS negativos FROM core.saldo_inventario WHERE saldo_cantidad < 0;   -- debe ser 0
-- 2. El saldo materializado cuadra con la suma de movimientos ponderada por signo.
SELECT count(*) AS descuadres FROM (
  SELECT s.almacen_id, s.insumo_id, s.saldo_cantidad,
         COALESCE(SUM(tm.signo * m.cantidad), 0) AS calc
  FROM core.saldo_inventario s
  LEFT JOIN core.movimiento_inventario m
         ON m.almacen_id = s.almacen_id AND m.insumo_id = s.insumo_id AND m.item_tipo = 'INSUMO'
  LEFT JOIN core.tipo_movimiento tm ON tm.codigo = m.tipo
  WHERE s.item_tipo = 'INSUMO'
  GROUP BY s.almacen_id, s.insumo_id, s.saldo_cantidad
) t
WHERE abs(t.saldo_cantidad - t.calc) > 0.000001;                             -- debe ser 0
-- 3. Correlativos consecutivos y sin duplicados dentro del mismo tipo y período.
SELECT 'pedido' AS documento, count(*) - count(DISTINCT numero) AS duplicados
FROM core.pedido WHERE borrado_en IS NULL
UNION ALL
SELECT 'venta', count(*) - count(DISTINCT numero)
FROM core.venta WHERE borrado_en IS NULL;                               -- debe ser 0
-- 4. No hay ventas sin detalle.
SELECT count(*) FROM core.venta v
WHERE NOT EXISTS (SELECT 1 FROM core.venta_detalle d WHERE d.venta_id = v.id);  -- debe ser 0
SQL

# ─────────────────────────────────────────────────────────────
# R-06 · VOLVER A SERVIR (t + 45 min)
# ─────────────────────────────────────────────────────────────
docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta up -d api-blue
curl -fsS --retry 20 --retry-delay 3 https://www.tantapanaderia.com/health/ready
curl -fsS -u "ci-readonly:$SMOKE_PASS" https://www.tantapanaderia.com/api/v1/productos?limit=1
# Login manual con un usuario real, abrir el dashboard del mes en curso, verificar totales.
# Revisar Sentry: cero issues nuevos en 10 min.

# ─────────────────────────────────────────────────────────────
# R-07 · CERRAR EL INCIDENTE
# ─────────────────────────────────────────────────────────────
# 1. Comunicar al Gerente: sistema en línea, hora de restauración, ventana perdida.
# 2. Reingresar del formulario de contingencia las operaciones del hueco (pedidos, ventas, cobros).
#    El sistema debe permitir registrar con fecha retroactiva SOLO a ADMIN y con motivo.
# 3. Post-mortem sin culpa en 5 días hábiles → docs/incidentes/YYYY-MM-DD-<slug>.md
# 4. Re-ejecutar el ensayo de restauración si el procedimiento cambió.
```

**Lo que se pierde, dicho sin adornos:** hasta 5 minutos de operación con PITR (hasta 24 h si se cae a la línea de dumps), los movimientos que estuvieran en el outbox de una tablet no sincronizada, y los archivos que no estén en R2 (los PDF se generan y se guardan en R2, con versionado activo → no se pierden).

---

## 8. Runbooks operativos

Formato: **síntoma → diagnóstico → mitigación → verificación → cierre**. Cada uno cabe en una pantalla y no requiere pensar.

### R-01 · La API no responde

```bash
# SÍNTOMA: el monitor marca caído, o las tablets muestran "sin conexión" en cadena.
# 1. ¿Es la API o es la red del cliente?
curl -fsS -o /dev/null -w '%{http_code} %{time_total}s\n' https://www.tantapanaderia.com/health/live
curl -fsS https://www.tantapanaderia.com/health/ready | jq .
# 2. ¿Los contenedores están arriba?
docker compose -f /srv/tanta/infra/compose/compose.prod.yml -p tanta ps
docker stats --no-stream
# 3. ¿Postgres responde?
docker compose ... exec -T postgres pg_isready -U tanta -d tanta
docker compose ... exec -T postgres psql -U tanta -d tanta -c "SELECT 1;"
# 4. ¿Disco lleno? (causa #1 de caída silenciosa)
df -h /; du -sh /var/lib/docker/volumes/* /var/log/caddy 2>/dev/null | sort -h | tail -5
# 5. ¿OOM?
dmesg -T | grep -i -E 'oom|killed process' | tail -20
```

**Mitigaciones por causa:**

| Causa | Acción | Tiempo |
|---|---|---|
| Contenedor caído, BD sana | `docker compose ... up -d --force-recreate api-blue` | 40 s |
| OOM de la API | Subir `memory: 1024M` a `1536M` y recrear; abrir ticket de fuga de memoria | 3 min |
| Disco lleno | `docker image prune -af --filter until=24h; journalctl --vacuum-time=3d` | 2 min |
| Postgres caído | `docker compose ... up -d postgres`; si no arranca → **Runbook R-06 (PITR)** | 45 min |
| Certificado vencido | `docker compose ... exec caddy caddy reload --config /etc/caddy/Caddyfile` | 1 min |
| Cloudflare en error 52x | Pausar el proxy (DNS-only) y reintentar | 2 min |
| Todo caído y sin causa en 10 min | **Modo contingencia en papel** y restaurar en staging para reproducir | — |

**Verificación:** `/health/ready` 200 desde 3 regiones, login manual, un pedido de prueba en staging (no en producción). **Cierre:** post-mortem si superó 15 min o si tocó el horario 04:00–12:00.

### R-02 · La base de datos creció o va lenta

```bash
# SÍNTOMA: p95 > 800 ms, o el disco > 70 %.
# Requiere una vez: CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  (ya carga vía shared_preload_libraries)
docker compose ... exec -T postgres psql -U tanta -d tanta <<'SQL'
SELECT pg_size_pretty(pg_database_size('tanta')) AS total;
SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       pg_size_pretty(pg_relation_size(c.oid)) AS tabla,
       pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) AS indices
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('core','audit','report') AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15;
SELECT pid, now()-query_start AS dur, state, left(query, 120)
FROM pg_stat_activity WHERE state <> 'idle' ORDER BY dur DESC LIMIT 10;
SELECT calls, round(mean_exec_time::numeric,1) AS ms,
       round(total_exec_time::numeric,0) AS total_ms, left(query, 100)
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;
SELECT relname, n_dead_tup, last_autovacuum FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 10;
SQL
```

**Árbol de decisión:**

1. **Consulta lenta identificada** → `EXPLAIN (ANALYZE, BUFFERS)`; falta un índice o hay N+1 de Prisma. Añadir índice con `CREATE INDEX CONCURRENTLY` (nunca en horario 04:00–12:00).
2. **`movimiento_inventario` > 10 M filas** → particionar por mes. No antes: a 34k movimientos/mes se llega a 10 M en 24 años.
3. **`n_dead_tup` alto** → `VACUUM (VERBOSE, ANALYZE) core.movimiento_inventario;` y revisar por qué el autovacuum no llega (`autovacuum_vacuum_scale_factor` a 0.05 en tablas grandes).
4. **Crecimiento por logs de auditoría** → la tabla `audit.evento` se particiona y las particiones de más de 12 meses se archivan a R2 y se sueltan.
5. **Crecimiento anómalo** (10× en un día) → **sospechar bug de bucle**: revisar `sync` duplicando o pg-boss reintentando sin fin. Ver R-03.
6. **Disco > 85 %** → borrar WAL local ya archivado (`pg_archivecleanup`), purgar imágenes, y si persiste, ampliar el volumen (Hetzner permite resize online).

**Verificación:** p95 < 500 ms durante 15 min, `pg_database_size` estable. **Cierre:** registrar el índice o el cambio en `docs/operacion/`.

### R-03 · Sync fallando masivamente en tablets

```bash
# SÍNTOMA: 4+ dispositivos con sync pendiente > 15 min, o el dashboard de sync en rojo.
# 1. ¿Es masivo o de un dispositivo?
docker compose ... exec -T postgres psql -U tanta -d tanta -c "
SELECT dispositivo_id, count(*) AS pendientes,
       min(creado_en) AS mas_viejo,
       max(intentos)  AS intentos_max,
       max(ultimo_error) AS error
FROM core.outbox_movimiento WHERE estado = 'pendiente'
GROUP BY dispositivo_id ORDER BY pendientes DESC;"
# 2. ¿La cola de pg-boss está atascada?
docker compose ... exec -T postgres psql -U tanta -d tanta -c "
SELECT name, state, count(*), max(age(now(), created_on)) AS edad
FROM pgboss.job GROUP BY name, state ORDER BY 4 DESC;"
# 3. ¿Errores de un endpoint concreto?
docker compose ... logs --since 30m api-blue | jq -r 'select(.status>=400) | "\(.status) \(.route) \(.codigo)"' | sort | uniq -c | sort -rn
```

**Causas y acciones:**

| Señal | Causa probable | Acción |
|---|---|---|
| Todos los dispositivos, mismo error 409 `IDEMPOTENCY_KEY_REUSED` | Bug de generación de clave en el cliente | Hotfix de la app (R-05). Mientras tanto, purgar la clave del outbox afectado con script autorizado |
| Todos, 5xx en `/sync/push` | Deploy roto o migración | Rollback (90 s) |
| Todos, timeout | API saturada o BD bloqueada | R-02 |
| **Un solo dispositivo**, `intentos` alto | Drift corrupto o reloj desfasado (JWT vencido) | Remoto: pedir al usuario "Cerrar sesión y volver a entrar"; si persiste, reinstalar la app conservando el outbox exportado |
| Un dispositivo, error de validación puntual | Dato inválido (producto borrado, insumo inexistente) | Marcar el movimiento como `conflicto` y resolverlo a mano con el usuario; nunca descartarlo en silencio |
| Cola de pg-boss atascada | Job en bucle | `UPDATE pgboss.job SET state='failed' WHERE ...` y reiniciar el worker |

**Regla:** un movimiento del outbox **nunca** se descarta automáticamente. Va a `conflicto` con el error visible y requiere resolución humana. Descartar datos de producción sin que un humano lo decida es cómo se pierde la confianza del cliente.

### R-04 · Se detectó un saldo de inventario negativo

Este runbook depende de la política vigente (`07 §6`). Con la política **estricta** —la de Tanta en producción— un saldo negativo **no debería existir**: si aparece, es un incidente (función de asiento desactualizada, política cambiada sin aviso o corrupción). Con la política **permisiva**, el negativo es un hecho de negocio legítimo y esto es una alerta a resolver en 24 h, no un incidente.

```bash
# 1. Confirmar, localizar y saber bajo qué política se escribió.
docker compose ... exec -T postgres psql -U tanta -d tanta -c "
SELECT s.almacen_id, s.insumo_id, i.codigo, i.nombre, s.saldo_cantidad, s.saldo_valor, s.cpp, s.actualizado_en
FROM core.saldo_inventario s JOIN core.insumo i ON i.id = s.insumo_id
WHERE s.saldo_cantidad < 0 ORDER BY s.saldo_cantidad;"
docker compose ... exec -T postgres psql -U tanta -d tanta -c "
SELECT valor FROM core.parametro WHERE clave = 'inventario.permite_saldo_negativo';"
# 2. Reconstruir el kárdex del insumo y encontrar el asiento que cruzó el cero.
docker compose ... exec -T postgres psql -U tanta -d tanta -c "
SELECT m.ocurrido_en, m.tipo, tm.signo, m.cantidad, m.valor, m.costo_unitario_movimiento,
       m.saldo_cantidad, m.saldo_valor, m.documento_tipo, m.documento_id,
       m.reverso_de_id, m.idempotency_key
FROM core.movimiento_inventario m JOIN core.tipo_movimiento tm ON tm.codigo = m.tipo
WHERE m.insumo_id = '<uuid>' ORDER BY m.ocurrido_en, m.id;"
# 3. ¿Hay asientos duplicados del sync? ux_mov_idempotency debería impedirlo.
docker compose ... exec -T postgres psql -U tanta -d tanta -c "
SELECT idempotency_key, count(*) FROM core.movimiento_inventario
GROUP BY 1 HAVING count(*) > 1;"
# 4. Cuadre contra el ledger (Q1/Q2 de 07 §8): si no cuadra, es proyección desfasada.
docker compose ... exec -T postgres psql -U tanta -d tanta -c "
SELECT count(*) AS descuadres FROM (
  SELECT s.almacen_id, s.insumo_id, s.saldo_cantidad, COALESCE(SUM(tm.signo * m.cantidad), 0) AS calc
  FROM core.saldo_inventario s
  LEFT JOIN core.movimiento_inventario m
         ON m.almacen_id = s.almacen_id AND m.insumo_id = s.insumo_id AND m.item_tipo = 'INSUMO'
  LEFT JOIN core.tipo_movimiento tm ON tm.codigo = m.tipo
  WHERE s.item_tipo = 'INSUMO' GROUP BY 1,2,3
) t WHERE abs(t.saldo_cantidad - t.calc) > 0.00001;"
```

**Acciones:**

1. **Congelar el ítem** (`UPDATE core.insumo SET activo = false`) hasta resolver: no se consume ni se vende.
2. **No se borra ni se edita ningún movimiento.** `core.movimiento_inventario` tiene trigger de inmutabilidad: se corrige **siempre** con un asiento de reverso (`REVERSO_SALIDA`/`REVERSO_ENTRADA` con `reverso_de_id`) o un `AJUSTE_TOMA_*` valorizado al CPP vigente, con motivo y autorización del `GERENTE`, más un evento en `audit.evento`.
3. **Si la causa es un duplicado de sync** → reverso del segundo asiento apuntando al original. Nunca `DELETE`: el trigger lo bloquea y, aunque no lo hiciera, borrar movimientos destruye la trazabilidad valorizada.
4. **Si la causa es concurrencia sin lock** → es un bug de código: todo consumo debe tomar `SELECT ... FOR UPDATE` sobre `core.saldo_inventario` (`07 §3`), en orden `insumo_id ASC`. Hotfix.
5. **Si la política está en `false` y el negativo apareció igual** → la función de asiento está desactualizada o alguien cambió el parámetro. Es un incidente: revisar el hash del contenedor contra el tag desplegado y abrir post-mortem.
6. **Si la política está en `true`** → acción de negocio: registrar la toma de inventario que regulariza, y decidir con el Gerente si se vuelve a `false` (una sola vía, con acta).
7. Descongelar el ítem solo cuando `saldo_inventario` cuadre con la suma de movimientos (paso 4 en cero).

**Cierre obligatorio:** post-mortem. Un saldo negativo significa que el margen que vio el Gerente pudo ser falso; hay que decírselo.

### R-05 · Hotfix a las 07:00 antes de la producción del día

Contexto: la producción arranca 04:00–05:00; a las 07:00 ya hay pedidos en curso y las tablets están sincronizando. El objetivo no es "desplegar bonito", es **no romper la operación**.

```bash
# T-20 min · 06:40 DETECTAR Y DECIDIR
# ¿Se puede esperar a la ventana de las 20:00? Si el bug no impide operar → esperar. Punto.
# Solo se hace hotfix si el sistema no permite facturar, producir o cobrar.
# Decisión binaria, tomada por el Líder (no por consenso):
#   A) ROLLBACK  → el bug lo introdujo el último deploy. SIEMPRE es la primera opción.
#   B) FIX FORWARD → el bug es de datos o de una lógica que el rollback no arregla.

# T-15 min · 06:45 ROLLBACK (opción A, preferida)
ENV_FILE=.env.prod bash /srv/tanta/infra/scripts/rollback.sh --to=previous
curl -fsS https://www.tantapanaderia.com/health/ready
# Si el rollback resuelve, FIN. No se toca nada más hasta la ventana nocturna.

# T-15 min · 06:45 FIX FORWARD (opción B)
git checkout -b hotfix/2026-11-20-cobranza main
# Un solo commit, mínimo, revisado por una segunda persona en 5 minutos.
git push -u origin hotfix/2026-11-20-cobranza

# T-5 min · 06:55 DESPLEGAR SIN ESPERAR E2E
gh workflow run ci-cd.yml --ref hotfix/2026-11-20-cobranza -f skip_e2e=true
# El pipeline corre lint+typecheck+unit+integración (≈6 min). E2E se salta y se corre DESPUÉS.
# El gate de aprobación de producción se aprueba con el Líder y el Gerente en la llamada.

# T+0 · 07:05 VERIFICAR (con la operación ya en marcha)
curl -fsS https://www.tantapanaderia.com/health/ready
# Prueba funcional mínima, en producción, con un usuario real y un caso real:
#   1. Login con MFA del Gerente.
#   2. Abrir el pedido que estaba fallando y completarlo.
#   3. Verificar que la tablet de Producción sincroniza (indicador en 0).
#   4. Revisar Sentry: cero issues nuevos, release = sha del hotfix.
#   5. Revisar los logs de 5 min: cero 5xx en escritura.

# T+10 · 07:15 COMUNICAR
# Mensaje al grupo de operación: qué se cambió, qué se verificó, qué vigilar.
# Y a las 20:00: correr el E2E completo contra el build del hotfix y mergear a main.
```

**Reglas duras del hotfix:**

1. **Ninguna migración después de las 06:30.** Si el fix la requiere, se aplica un rollback + parche en memoria o se espera a la ventana nocturna.
2. **Un solo commit.** Nada de "aprovecho para limpiar".
3. **Si a las 07:15 no está verificado, se revierte.** No se deja un hotfix sin verificar en producción.
4. **Después de las 07:15 no se despliega nada** salvo un rollback. La ventana se cerró.
5. **Modo contingencia primero.** A las 06:45, mientras se decide, Producción ya debe estar usando el formulario en papel. El sistema no es el negocio; el negocio es el pan.
6. **El E2E se corre a las 20:00**, no se omite. Un hotfix sin E2E es deuda que se paga con intereses.

---

## 9. Gestión de la deuda y el riesgo del cronograma

### 9.1 Evaluación honesta del plan de 22 días hábiles

**El cronograma es internamente consistente en fechas** (26/10/2026 es lunes; 26/10–24/11/2026 son exactamente 22 días hábiles; no hay feriados nacionales en la ventana). El problema no es el calendario: es la **relación entre alcance y esfuerzo**.

**Esfuerzo estimado del alcance declarado** (persona-día, sin holgura):

| Bloque | Detalle | pd |
|---|---|---|
| Backend · auth y RBAC | 6 perfiles, scoping por recurso, MFA TOTP, refresh con rotación, auditoría con hash | 8 |
| Backend · maestros | productos, insumos, recetas versionadas, CIF, clientes, usuarios, parámetros | 9 |
| Backend · pedidos y OP | correlativos, estados, requerimiento por receta, consumo, merma real | 11 |
| Backend · inventario y kárdex | CPP, valorización, compras, ajustes, toma de inventario, bloqueos | 13 |
| Backend · ventas, despacho, cobranza | anulación, devolución, CxC con antigüedad, pagos parciales | 11 |
| Backend · motor de costeo | ficha de costo, CIF, prorrateo, margen/markup, cierre de período | 13 |
| Backend · reportes y dashboard | 13 indicadores G/V/A/M + exportaciones | 10 |
| Backend · sync/offline API | outbox, cursores, idempotencia, resolución de conflictos | 7 |
| Móvil · 4 perfiles | Flutter + Riverpod + Drift + outbox, offline real | 42 |
| Web · 4 módulos | React, TanStack, tablas, filtros, exportación | 34 |
| QA | plan, 25 casos críticos, automatización, ejecución, UAT | 26 |
| Infra y DevOps | CI/CD, VPS, backups, PITR, observabilidad, ensayo de restauración | 13 |
| UX/UI | prototipos de 4 perfiles móviles + 4 módulos web | 9 |
| Gestión y análisis | levantamiento, actas, demos, capacitación, manuales | 14 |
| **Total** | | **220** |

**Capacidad real del equipo** (Tabla 5 del informe, 6 roles, 22 días hábiles, factor de utilización 0.82 por reuniones, demos, soporte y contexto): ≈ **6 × 22 × 0.82 = 108 pd**. Si una persona cubre más de un rol —y el informe lo permite—, la capacidad **baja**, no sube: dos roles en una persona no suman 44 pd, suman ~30.

**Brecha: 220 pd de esfuerzo contra ~108 pd de capacidad → factor 2.0×, y 2.5× si se descuenta la rampa de arranque.** El plan de 22 días hábiles entrega, con trabajo heroico y deuda, **entre el 40 % y el 50 % del alcance declarado**.

**Inconsistencias verificables en el propio documento** (no son opinión, son fechas que no cierran):

| # | Hallazgo | Evidencia | Consecuencia | Marca |
|---|---|---|---|---|
| 1 | **H5 dice go-live 20/11, el Gantt dice 24/11** | §6.3 vs §6.2 | Dos compromisos distintos con el cliente en el mismo documento | `[CORRECCIÓN]` |
| 2 | **El acta de UAT (H4) se firma el 19/11, antes de las correcciones (20–23/11)** | §6.3 y tarea 6.4 | Se firma conformidad sobre un sistema que aún va a cambiar. El acta no vale | `[CORRECCIÓN]` |
| 3 | **H3 "Apps funcionales" (16/11) ocurre antes de terminar el desarrollo móvil (18/11)** | §6.3 y tarea 4.4 | El hito se cumple sobre código inacabado | `[CORRECCIÓN]` |
| 4 | **La UAT valida un dashboard que se termina el día anterior (19/11)** | tarea 5.4 fin 19/11, UAT 19–20/11 | Cero tiempo para corregir hallazgos del dashboard | `[CORRECCIÓN]` |
| 5 | **6 días de QA (F6) para 220 pd de construcción, solapados con F5 y F7** | §6.2 | No hay ventana de regresión. La "regresión" es la UAT | `[CORRECCIÓN]` |
| 6 | **El motor de costeo (13/11) tiene 3 días de QA antes de la UAT** | tarea 3.6 fin 13/11, F6 inicio 16/11 | El módulo que más pruebas necesita es el que menos tiene | `[CORRECCIÓN]` |

### 9.2 Criterio de recorte (explícito, no por gusto)

El orden de recorte lo fija **el riesgo**, evaluado en cuatro dimensiones, en este orden:

1. **Radio de impacto en dinero:** ¿si falla, el Gerente ve un margen equivocado? → **no se recorta nunca**.
2. **Profundidad de dependencia:** ¿cuántas cosas se caen si esto no existe? → a mayor profundidad, menos recortable.
3. **Reversibilidad:** ¿se puede añadir después sin migración destructiva? → si es reversible, es candidato a recorte.
4. **Visibilidad:** ¿lo ve el cliente en la demo? → **el criterio de menor peso**, aunque sea el que más presión recibe.

| No se recorta **nunca** (riesgo inaceptable) | Se recorta **primero** (riesgo bajo, reversible) |
|---|---|
| Motor de costeo: CPP, ficha de costo, margen | 9 de los 13 reportes del dashboard (G-03, G-04, G-05, G-07, G-08, G-09, G-10, G-12, G-13) |
| Kárdex valorizado y sus invariantes | Exportación a PDF (queda Excel; el PDF es cosmético) |
| Idempotencia y outbox (sin esto el sync duplica dinero) | Notificaciones push (queda refresco cada 30 s en la app) |
| RBAC con scoping (IDOR = fuga de datos de clientes) | App del Cliente (el vendedor toma el pedido; el pedido se captura igual) |
| Backups + PITR + ensayo de restauración | App de Almacén (usa la web, que es su canal primario según el informe) |
| Auditoría de operaciones críticas | iOS (Android cubre el 100 % de los dispositivos de Tanta) |
| Correlativos transaccionales (D-05) | Multi-caja y multi-sucursal en UI |
| Anulación, devolución y su reversión en kárdex | Toma de inventario físico (se hace con `ajuste` documentado) |
| Cobranza parcial y antigüedad de saldos | Punto de equilibrio (G-09) — es análisis, no operación |
| Migraciones *expand/contract* y CI | Regresión visual de las 5 pantallas |

**Regla de decisión:** ante la duda entre añadir un reporte y añadir un test del motor de costeo, **se añade el test**. El reporte se puede hacer en Excel con un export; un margen mal calculado no tiene parche.

### 9.3 Replanificación propuesta

**Veredicto (D13-15): el plan de 22 días hábiles no es viable al alcance declarado. Se propone partir la entrega en dos, sin mover la fecha de inicio del 26/10/2026.**

| Entrega | Fecha | Alcance | Criterio de aceptación |
|---|---|---|---|
| **MVP-1 · Operativo** | **24/11/2026** (22 días hábiles) | Auth + RBAC + MFA · Maestros completos · Pedidos + OP + consumo + merma · Kárdex CPP · Ventas, despacho, anulación, devolución · Cobranza parcial + CxC con antigüedad · Motor de costeo + ficha de costo + margen por venta · **Móvil: Producción (tablet) y Vendedor** con offline · **Web: Maestros, Inventario, Ventas/CxC, Dashboard con G-01, G-02, G-06, G-11** · CI/CD · Backups + PITR + ensayo de restauración · Android | La panadería puede operar un día completo: pedido → OP → consumo → despacho → venta → cobro → margen |
| **MVP-2 · Completo** | **11/12/2026** (+13 días hábiles) | App Cliente · App Almacén · iOS · Los 9 reportes restantes · Exportación PDF · Push FCM · Toma de inventario físico · Punto de equilibrio | Acta de conformidad final; cierre de la propuesta |
| **Fuera de alcance** | — | Multi-sucursal en UI, multi-caja, SUNAT, pasarela de pagos, integración contable | Ya excluido en §9.4 del informe |

**Por qué esto es mejor negocio para ambas partes:** el Gerente recibe el 24/11 lo único que justifica el proyecto —**saber cuánto gana por producto**— funcionando con datos reales. Lo demás llega 13 días hábiles después, sin quitarle nada a lo entregado. Alternativa (peor): entregar todo a medias el 24/11 y que el motor de costeo tenga un error.

**Si el cliente exige los 4 perfiles móviles el 24/11**, la única palanca honesta es reducir el alcance de otra cosa: se entrega la App Cliente y se difieren los 9 reportes del dashboard. Es una decisión del cliente, no del equipo, y debe quedar escrita en el acta de H1.

### 9.4 Definition of Done por historia

Una historia está terminada cuando **las 10 condiciones** se cumplen. No hay "done parcial".

```
[ ] 1. Criterios de aceptación en Gherkin, aprobados por el Analista y por el usuario clave.
[ ] 2. Si toca dinero o cantidad: tests unitarios con ≥ 90 % de ramas en el código nuevo.
[ ] 3. Si toca BD o endpoints: test de integración contra Postgres real (no mock).
[ ] 4. OpenAPI regenerado y `oasdiff` sin cambios rompientes.
[ ] 5. Toda mutación acepta `Idempotency-Key` y está probada con reenvío (QA-11).
[ ] 6. Test positivo Y negativo de RBAC con scoping por recurso (QA-10/QA-20).
[ ] 7. Operación crítica → escribe en `audit.evento` con cadena de hash.
[ ] 8. Log estructurado con `requestId`; sin `console.log`; sin PII ni tokens.
[ ] 9. 24 h en staging sin un issue nuevo en Sentry.
[ ] 10. Demostrado al Analista en la demo del viernes, y documentado (ADR si cambió una decisión).
```

**Definition of Done de la fase (aplica a F1–F7):** además de lo anterior, el acta de la fase está firmada, los riesgos abiertos están actualizados en el registro y la deuda técnica introducida está anotada en `docs/12-ADRS.md` con su disparador de pago.

### 9.5 Criterio de salida de cada fase

| Fase | Fechas | Criterio de salida (verificable, no narrativo) | Riesgo si no se cumple |
|---|---|---|---|
| **F1 · Inicio, análisis y planificación** | 26–28/10 | **Datos base cargados y validados en el sistema**: ≥ 10 productos, ≥ 15 insumos, ≥ 10 recetas con rendimiento, ≥ 7 CIF. Acta de alcance firmada con la lista de lo que **queda fuera**. Usuario clave designado por escrito. | Si los datos no están el día 3, el motor de costeo no se puede validar y el go-live se cae. **Es el riesgo #1 del informe y sigue siéndolo.** |
| **F2 · Diseño y arquitectura** | 28/10–02/11 | ADRs 001–010 escritos. Esquema Prisma completo con las 3 esquinas (`core`, `audit`, `report`) y las precisiones de D-03. VPS provisionado, dominio resolviendo, TLS activo, CI verde en un repo vacío. Prototipos de 4 perfiles aprobados. | Sin ADRs, cada decisión se re-discute en F3 y se pierde la semana. |
| **F3 · Backend** | 30/10–13/11 | Los 6 módulos expuestos en `/api/docs`, con integración verde. Costeo y kárdex con ≥ 90 % de cobertura. **QA-01, QA-02, QA-07, QA-13, QA-15 en verde.** Sin esto, la UAT no tiene qué validar. | Es la fase que más se comprime y la que no se debe comprimir. |
| **F4 · App móvil** | 03/11–18/11 | Producción y Vendedor completan su ciclo offline→online en un dispositivo físico (no emulador). QA-11 en verde. Outbox sobrevive a matar la app. | Un offline que pierde movimientos destruye la confianza en el inventario. |
| **F5 · Web** | 04/11–19/11 | Maestros, Inventario y CxC operativos. Dashboard con G-01, G-02, G-06, G-11 cuadrando con las ventas (**QA-18**). | Un dashboard que no cuadra es peor que no tener dashboard. |
| **F6 · Pruebas y calidad** | 16–23/11 | Los **25 casos de §2** ejecutados con evidencia. Cobertura en umbral. E2E verde. UAT con el usuario clave y **acta firmada después de las correcciones**, no antes. | Firmar la UAT antes de corregir invalida el acta (hallazgo #2). |
| **F7 · Despliegue, capacitación y go-live** | 20–24/11 | **Ensayo de restauración cronometrado y firmado (< 45 min).** Backups automáticos verificados 3 días seguidos. Runbooks impresos. 6 usuarios capacitados con lista de asistencia. **Formulario de contingencia en papel entregado.** Monitoreo externo activo. | Sin el ensayo de restauración, el go-live es una apuesta, no una entrega. |

**Hitos H1–H5 corregidos** (`[CORRECCIÓN]` a §6.3 del informe):

| Hito | Fecha corregida | Criterio corregido | Cambio |
|---|---|---|---|
| H1 · Alcance aprobado | 28/10/2026 | + lista explícita de exclusiones firmada | Se añade la firma de exclusiones: es lo que evita el "esto no era lo que pedí" |
| H2 · Diseños aprobados | 02/11/2026 | + ADRs 001–010 y CI verde | Se añade la deuda de diseño como condición |
| H3 · Funcional | **18/11/2026** (antes 16/11) | Demo del flujo completo en dispositivo real | Se mueve al terminar F4, no antes |
| H4 · Conformidad UAT | **24/11/2026** (antes 19/11) | Acta firmada **después** de las correcciones | Se firma sobre lo corregido, no sobre lo observado |
| H5 · Go-live | **24/11/2026** (antes 20/11) | + ensayo de restauración firmado + 3 días de backups verificados | Un go-live sin restauración probada no es un go-live |

### 9.6 Deuda técnica asumida conscientemente

| Deuda | Disparador de pago | Costo de no pagarla |
|---|---|---|
| Un solo VPS para producción y staging | Segundo cliente, o > 60 usuarios concurrentes | Un deploy de staging puede degradar producción |
| pg-boss embebido en el proceso de la API | Edad p95 de jobs > 30 s | Un job lento bloquea el event loop de la API |
| Sin Prometheus/Grafana | Primer SLO incumplido sin explicación clara | Diagnóstico por logs, 2–3× más lento |
| Vistas materializadas para el dashboard sin refresco incremental | Refresco > 10 s | El dashboard se siente lento a los 2 años |
| Cifrado de backup con clave offline | Si el cliente pierde la clave, no hay recuperación posible | Pérdida total e irreversible de los respaldos |
| Sin particionado de `movimiento_inventario` | 10 M filas | `VACUUM` y consultas de kárdex degradadas |
| Sync sin compresión (payloads JSON) | Plan de datos del cliente o > 5,000 movimientos/día | Consumo de datos móviles y latencia |

Cada línea de esta tabla entra en el registro de riesgos del proyecto con fecha de revisión en el contrato de mantenimiento. **La deuda que no está escrita no se paga nunca.**

---

## Anexo · Checklist de go-live (se firma, no se "revisa")

```
INFRAESTRUCTURA
[ ] VPS con 8 GB, swap 2 GB, ufw activo, SSH solo con clave, fail2ban
[ ] Caddy con TLS válido en www y apex; HSTS activo; renovación automática verificada
[ ] PostgreSQL 17 con las 12 opciones de tuning de §5.4 aplicadas y verificadas con SHOW
[ ] Límites de cgroup de los 5 servicios aplicados (docker stats coherente con §5.4)
[ ] `docker compose up` desde cero reconstruye el sistema en < 15 min (probado)

DATOS Y RESPALDOS
[ ] Ensayo de restauración PITR cronometrado: _____ min (objetivo < 45). Evidencia archivada
[ ] Ensayo de restauración desde dump lógico: _____ min. Evidencia archivada
[ ] 3 días consecutivos de backup automático exitoso y verificado por tamaño en R2
[ ] Clave privada `age` entregada en sobre sellado al Gerente + gestor del proveedor
[ ] `wal_archivo_edad_segundos` < 300 medido 3 veces en 24 h

CALIDAD
[ ] 25 casos de §2 ejecutados con evidencia en docs/qa/
[ ] Cobertura: dominio ≥ 90 %, global ≥ 70 % (reporte adjunto)
[ ] E2E de Playwright verde sobre el build de producción
[ ] Trivy sin CRITICAL/HIGH con fix disponible; SBOM archivado
[ ] k6 sin OOM ni reinicios; p95 < 500 ms

OPERACIÓN
[ ] Sentry con release = sha de producción y alertas configuradas (§6.4)
[ ] UptimeRobot con 2 monitores desde 3 regiones, alerta probada de verdad (forzando un fallo)
[ ] `/health/live`, `/health/ready`, `/health/deep` responden lo esperado
[ ] Runbooks R-01 a R-05 impresos y en el sobre de operación
[ ] Formulario de contingencia en papel entregado a Producción, Almacén y Ventas
[ ] 6 usuarios capacitados, con lista de asistencia firmada
[ ] Manual de usuario por perfil entregado (6 PDF)
[ ] Contraseña de `ci-readonly` y de todos los usuarios del seed cambiada o cuenta desactivada
[ ] `NODE_ENV=production`, `AUTH_MFA_ENFORCED=true`, `LOG_LEVEL=info`, `prisma migrate status` limpio
[ ] Rollback probado en staging: `rollback.sh --to=previous` en < 120 s
```

**No se hace go-live con un ítem sin marcar.** Un go-live con casillas abiertas es un incidente con fecha programada.
