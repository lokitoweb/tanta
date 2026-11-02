# Contrato de Arquitectura — Tanta

> **Documento normativo.** Todo documento de este dossier y todo código del proyecto debe respetar
> estas decisiones. Si algo debe cambiar, se cambia **aquí primero** y se registra un ADR.

- **Cliente:** Panadería Tanta (Lima, Perú)
- **Proveedor:** Team eSolutionsNet
- **Origen:** Informe Ejecutivo v1.0 del 21/10/2026 (`DOC-20261021-WA0001`), 19 páginas
- **Fecha de este dossier:** 01/11/2026
- **Zona horaria de negocio:** `America/Lima` (UTC-5, sin horario de verano)
- **Moneda:** PEN (S/), IGV 18 % parametrizable

---

## 1. Nombre de las piezas

| Pieza | Nombre | Descripción |
|---|---|---|
| API | **Tanta Core** | Modular monolith NestJS, REST/JSON, `/api/v1` |
| App móvil | **Tanta App** | Flutter (Android / iOS / tablet), 4 perfiles operativos |
| Web admin | **Tanta Admin** | React + TypeScript + Vite |
| Base de datos | **`tanta`** | PostgreSQL 17, esquemas `core`, `audit`, `report` |

---

## 2. Decisiones cerradas (D-xx)

### D-01 · Forma de la solución
**Monolito modular**, no microservicios. Un solo despliegue de API con módulos de dominio
aislados por frontera de datos. Justificación en `12-ADRS.md` (ADR-001).

### D-02 · Stack
| Capa | Tecnología | Versión objetivo |
|---|---|---|
| API | Node.js 22 LTS + NestJS 11 + TypeScript 5.x | — |
| ORM | Prisma 6 | — |
| BD | PostgreSQL | 17 |
| Colas/jobs | **pg-boss** (sobre PostgreSQL, sin Redis) | 10.x |
| Web | React 19 + Vite 6 + TypeScript | — |
| UI web | Tailwind CSS 4 + shadcn/ui + TanStack Query v5 + TanStack Router | — |
| Gráficos | Recharts (dashboard) / ECharts (reportes densos) | — |
| Móvil | Flutter 3.3x + Dart 3.x | — |
| Estado móvil | Riverpod 2 + Drift (SQLite local) | — |
| Push | Firebase Cloud Messaging (FCM + APNs) | — |
| Archivos | Cloudflare R2 (S3-compatible) | — |
| Despliegue | Docker Compose + Caddy 2 (TLS automático) en VPS | — |
| CI/CD | GitHub Actions → GHCR → deploy por SSH | — |
| Errores | Sentry (SaaS free tier) | — |

### D-03 · Precisión numérica (NO NEGOCIABLE)
- **Dinero en importes:** `NUMERIC(16,4)` — soles con 4 decimales.
- **Costos unitarios y cantidades:** `NUMERIC(18,6)`.
- **Porcentajes:** `NUMERIC(9,6)` (se guardan como fracción 0.550000, no 55.0).
- **Prohibido `float`/`double`/`REAL`** en cualquier columna monetaria o de cantidad.
- En TypeScript: `Prisma.Decimal` / `decimal.js`. En Dart: paquete `decimal`.
- Redondeo: **ROUND_HALF_UP** y solo en los puntos declarados en `06-MOTOR-DE-COSTEO.md §Redondeo`.
  Los cálculos intermedios **no** se redondean.

### D-04 · Convenciones de base de datos
- Esquema `core` para negocio, `audit` para trazabilidad, `report` para vistas materializadas.
- Tablas en **snake_case singular**: `pedido`, `pedido_detalle`, `movimiento_inventario`.
- PK: `id uuid` generado con **UUIDv7** (ordenable por tiempo).
- FKs: `<tabla>_id`.
- Auditoría de fila: `creado_en timestamptz`, `creado_por uuid`, `actualizado_en timestamptz`,
  `actualizado_por uuid`.
- Borrado lógico: `borrado_en timestamptz` (null = vigente). **Nunca** `DELETE` físico en tablas de negocio.
- Estados: `text` + `CHECK` (no enums nativos de PostgreSQL) para permitir evolución sin migración destructiva.
- Toda tabla de negocio lleva `sucursal_id` desde el día 1 (una sola sucursal al inicio).

### D-05 · Identificadores y correlativos
- Correlativos por tipo de documento vía `secuencia_documento(tipo, anio, ultimo)` con `UPDATE ... RETURNING`
  dentro de la misma transacción. Formato: `PED-2026-000123`, `OP-2026-000045`, `VTA-2026-000789`.
- Los correlativos **no** se generan en el cliente móvil.

### D-06 · API
- REST/JSON, prefijo `/api/v1`.
- JSON en **camelCase**; base de datos en **snake_case**. La traducción vive en la capa de mapeo.
- OpenAPI 3.1 **generado desde el código** (`@nestjs/swagger`), publicado en `/api/docs` (solo en staging).
- Errores: **RFC 9457** `application/problem+json` con `type`, `title`, `status`, `detail`, `instance`, `codigo`.
- Paginación por cursor (`?cursor=&limit=`), no por offset.
- Toda mutación acepta **`Idempotency-Key`** (UUIDv7 generado en el cliente).

### D-07 · Seguridad (base; el detalle está en `08`)
- Argon2id para contraseñas (`m=65536 KiB, t=3, p=1`, pepper de entorno).
- **Access token JWT 15 min** + **refresh token opaco 30 días** con rotación y detección de reuso.
- RBAC con **scoping por recurso** (el Cliente solo ve lo suyo; el Vendedor solo su cartera).
- MFA TOTP obligatorio para `ADMIN` y `GERENTE`.
- Toda operación crítica escribe en `audit.evento` con cadena de hash.

### D-08 · Fechas
- Instantes: `timestamptz` (UTC en la BD, se presenta en `America/Lima`).
- Fechas de negocio (fecha de entrega, fecha de pago): `date`.
- El "día operativo" de la panadería se calcula en `America/Lima`, no en UTC.

### D-09 · Offline-first (móvil)
- La app **nunca** calcula costo, margen ni saldo definitivo: solo *previsualizaciones*.
- Drift (SQLite) es la fuente de verdad local; patrón **outbox** + `Idempotency-Key` + cursor `since`.
- Toda entidad sincronizable define política de conflicto explícita (`09-OFFLINE-Y-SINCRONIZACION.md`).

### D-10 · Multi-sucursal y multi-caja
Se modelan `sucursal` y `caja` desde el inicio con un único registro inicial. No se implementa
la funcionalidad completa, pero el esquema no requiere migración destructiva para añadirla.

---

## 3. Vocabulario ubicuo (obligatorio en código, API y documentos)

| Término | Definición |
|---|---|
| **Insumo** | Materia prima o material consumible (harina, levadura, gas, bolsa). |
| **Producto** | Artículo terminado que se vende (pan ciabatta, torta de chocolate). |
| **Receta** | Lista de materiales + rendimiento (unidades que produce la tanda). Versionada. |
| **OP** | Orden de Producción: ejecución concreta de una receta para una cantidad. |
| **CPP** | Costo Promedio Ponderado del insumo. |
| **CIF** | Costos Indirectos de Fabricación (alquiler, gas, energía, depreciación…). |
| **Kárdex** | Libro de movimientos valorizados de un ítem. |
| **Merma** | Pérdida de insumo o producto por proceso, vencimiento o error. |
| **Despacho** | Entrega física de un pedido al cliente. |
| **Venta a terceros** | Venta a un cliente no registrado en la app. |
| **Cartera** | Conjunto de cuentas por cobrar de un vendedor. |
| **Prorrateo** | Reparto de los CIF entre las unidades producidas del período. |

---

## 4. Estructura del repositorio objetivo

```
tanta/
├─ apps/
│  ├─ api/            # NestJS — Tanta Core
│  ├─ web/            # React + Vite — Tanta Admin
│  └─ mobile/         # Flutter — Tanta App
├─ packages/
│  ├─ contracts/      # OpenAPI + tipos generados (TS) + cliente Dart generado
│  ├─ domain/         # Tipos, validaciones y reglas puras compartidas api↔web
│  └─ config/         # eslint, tsconfig, tailwind base
├─ infra/
│  ├─ compose/        # docker-compose.{dev,prod}.yml
│  ├─ caddy/          # Caddyfile
│  └─ backup/         # pg_dump + WAL-G → R2
└─ docs/              # este dossier
```

---

## 5. Decisiones promovidas desde los documentos especializados

Estas decisiones nacieron al profundizar seguridad, datos y sync (`08`, `04`, `09`) y **elevan el
contrato**. Aplican a todo el proyecto a partir de esta revisión.

### D-11 · Séptimo perfil `SOPORTE` (break-glass del proveedor)
El proveedor necesita reiniciar servicios, revisar logs y aplicar configuraciones **sin** entrar como
administrador de negocio (que ve márgenes, recetas y cartera). Se añade un perfil `SOPORTE`:
- Solo web, solo `staging` y `producción` con ventana declarada, **sesión de 2 h máximo**.
- **Sin acceso a datos de negocio**: no ve pedidos, ventas, costos ni clientes; solo métricas, logs y configuración.
- Requiere aprobación del `GERENTE` y queda en `audit.evento` con motivo obligatorio.
- Se activa por un enlace de un solo uso; nunca por contraseña compartida.

**Consecuencia:** la matriz de permisos pasa de 6 a **7 perfiles**. Afecta a `02 §2`, `05 §3` y `08 §5`.

### D-12 · Field-level security sobre costo, precio y margen
La matriz de la propuesta agrupa "Insumos y recetas" en una sola celda y, al marcar consulta para
Producción y Almacén, les concede de facto el **CPP y el costo unitario**. Se corrige:
- **Costo, CPP, margen y markup:** visibles solo para `ADMIN` y `GERENTE`.
- **Receta (cantidades e insumos):** visible para `PRODUCCION` y `ALMACEN` **sin** columnas de costo.
- **Vendedor:** ve precio de venta y descuento máximo; **nunca** el costo ni el margen.
- Se implementa como proyección en el repositorio, no como filtro en el cliente.

### D-13 · Endurecimiento criptográfico
- **TLS 1.3 exclusivo** (no "1.2+").
- **Argon2id** `m=65536 KiB, t=3, p=1` + pepper de entorno (valores ya fijados en D-07).
- **Sin certificate pinning** en la app: Caddy rota la hoja cada 60–90 días y fijarla rompe la app.
  Se compensa con access token de 15 min y almacenamiento en Keychain/Keystore.
- Refresh token **opaco**, con familia, rotación y **ventana de gracia de 60 s** (sin ella, un refresh
  perdido por mala señal expulsa al vendedor en la calle; el reuso real sigue castigado).

### D-14 · Auditoría con anclaje externo
`audit.evento` encadenado por SHA-256 + `audit.cadena_estado` bloqueado + **anclaje diario firmado con
Ed25519** depositado en R2 con Object Lock. La llave la custodia el Gerente, no el proveedor.

### D-15 · Cifrado de PII, no de costos
PII (teléfono, documento, dirección) cifrada con `pgcrypto`. **Los costos, precios y márgenes no se
cifran por columna**: hacerlo rompe `SUM`/`ORDER BY` y con ello G-02, G-06 y G-07. Es un **riesgo
residual aceptado por escrito** (RR-01 en `08`), no un olvido.

### D-16 · Correo transaccional en el stack
Se añade proveedor de correo (Resend o Amazon SES) con SPF/DKIM/DMARC. Sin él no hay recuperación de
contraseña ni canal viable para derechos ARCO.

### D-17 · Comprobante interno, no tributario
El PDF del vendedor es una **"Constancia interna de despacho"** con serie `INT-` y leyenda de no
tributario. `core.venta` reserva `serie_tributaria` y `correlativo_tributario` en `NULL` para no
bloquear una futura integración SUNAT.

### D-18 · Respaldos con RPO real
RPO ≤ **15 min** (WAL archiving continuo), RTO ≤ **4 h**, retención 30 días, restauración **ensayada y
cronometrada** antes del Go-live y **mensualmente** después.

### D-19 · Artefactos legales obligatorios (Ley 29733 y D.S. 016-2024-JUS)
Aviso de privacidad, política de retención, consentimiento explícito en el registro del cliente,
procedimiento ARCO (SLA 5 días hábiles) y notificación de incidentes en **48 h**. Detalle en `08 §8`.

### D-20 · Tablas pendientes de DDL
`04` es la autoridad física del esquema. Antes del sprint 3 deben añadirse, como **Bloque 12 ·
Plataforma**: `refresh_token`, `intento_login`, `consentimiento`, `solicitud_arco`, `incidente`,
`notificacion`, `notificacion_destino`, `sync_lote`, `sync_operacion`, `sync_cursor_dispositivo`,
`compra`, `compra_detalle`. Sin ellas, `05` y `09` describen endpoints sin esquema que los sostenga.

---

## 6. Reglas para redactar los documentos de este dossier

1. Español técnico, directo, sin relleno comercial.
2. Cada afirmación relevante termina en una **decisión** o en un **riesgo con mitigación**.
3. Lo que **no** está en la propuesta original se marca como **`[AMPLIACIÓN]`** y se justifica.
4. Lo que **contradice** la propuesta original se marca como **`[CORRECCIÓN]`** con el motivo.
5. Todo diagrama en **Mermaid** (compatible con GitHub/GitLab/VS Code).
6. Todo ejemplo SQL debe ser PostgreSQL válido y ejecutable.
7. Nada de "se recomienda considerar"; se decide o se deja explícitamente fuera de alcance.
