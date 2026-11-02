# 03 · Stack tecnológico y decisiones

> **La pregunta que responde este documento:** ¿con qué se construye esto, exactamente, y por qué?
> Cada elección tiene su alternativa descartada y su motivo. Nada queda "por definir".

---

## 1. La decisión, en una tabla

| Capa | Elección | Versión mínima | Por qué esta y no otra |
|---|---|---|---|
| **Lenguaje API** | TypeScript | 5.6+ | Tipos de extremo a extremo con la web; el dominio de costeo se prueba sin servidor. |
| **Runtime** | Node.js LTS | 24 LTS (mín. 22) | Ecosistema, familiaridad, rendimiento suficiente de sobra. |
| **Framework API** | **NestJS** | 11 | Módulos, inyección de dependencias y guards: la estructura que un monolito modular necesita para no volverse un archivo de 3,000 líneas. |
| **ORM** | Prisma | 6.x | Migraciones versionadas, tipos generados, `Decimal` nativo. |
| **Base de datos** | **PostgreSQL** | 17 (18 opcional) | Transacciones reales, `numeric` exacto, `FOR UPDATE`, vistas materializadas, JSONB, PITR. |
| **Cola / jobs** | **pg-boss** | 10.x | Cola transaccional en la misma BD. **Cero Redis que operar.** |
| **Validación** | Zod | 3.x | Un esquema, dos usos: validar en la API y tipar en la web. |
| **Web** | **React + Vite + TypeScript** | React 19 · Vite 6 | SPA de administración; sin SSR porque no hay SEO ni contenido público. |
| **UI web** | Tailwind CSS + shadcn/ui | 4 / última | Componentes propios, accesibles, sin lock-in de librería. |
| **Datos web** | TanStack Query + TanStack Router | v5 / v1 | Caché, reintentos, invalidación; rutas tipadas. |
| **Gráficos** | Recharts (dashboard) + ECharts (reportes densos) | últimas | Recharts para 6–8 tarjetas; ECharts cuando hay 5,000 puntos. |
| **Móvil** | **Flutter** | 3.35+ | Un código para Android/iOS/tablet, offline sólido, UI de tablet de calidad. |
| **Estado móvil** | Riverpod | 2.x/3.x | Testeable, sin `BuildContext`, composición clara. |
| **BD local móvil** | **Drift** (SQLite) | última | Esquema tipado, migraciones, consultas reactivas. Base del offline. |
| **Push** | Firebase Cloud Messaging | — | Gratis, cubre Android e iOS (vía APNs). |
| **Archivos** | Cloudflare R2 | — | S3-compatible, sin costo de egreso, 10 GB gratis. |
| **Proxy / TLS** | Caddy 2 | 2.8+ | Certificados automáticos, configuración de 10 líneas. |
| **Contenedores** | Docker + Compose | — | Reproducible, sin Kubernetes. |
| **CI/CD** | GitHub Actions → GHCR | — | Gratis en repo privado (2,000 min/mes), suficiente. |
| **Errores** | Sentry | free tier | 5,000 eventos/mes; sobra para este volumen. |
| **Uptime** | Uptime Kuma (autoalojado en el mismo VPS o externo) | — | Aviso por Telegram/WhatsApp si la API cae. |
| **Monorepo** | pnpm workspaces + Turborepo | pnpm 9+ | Builds incrementales; un solo `pnpm install`. |

---

## 2. Las tres decisiones que de verdad importan

### 2.1 Monolito modular, no microservicios — **cerrado**

Ya justificado en `02 §3.1`. Aquí solo el argumento económico: con 4 microservicios, el costo operativo
(subidas, versiones, contratos, tracing distribuido, 4 pipelines) se come el presupuesto de S/ 150/mes
solo en tiempo de ingeniería. **Un despliegue, una base de datos, un log.**

### 2.2 Flutter para móvil — con la alternativa sobre la mesa

Es la decisión más discutible del stack, así que la expongo completa.

| Criterio (peso) | **Flutter** | **React Native + Expo** |
|---|---|---|
| Velocidad con equipo pequeño (25 %) | 7 — un solo código, pero Dart se aprende | **9** — si el equipo ya es JS/TS, arranca el día 1 |
| Offline / SQLite (20 %) | **9** — Drift es maduro y tipado | 8 — WatermelonDB/op-sqlite, algo más de fontanería |
| UI de tablet en planta (15 %) | **9** — control total del layout, 60 fps estable | 7 — bien, pero más dependencia de librerías |
| Ecosistema y contratación en Perú (15 %) | 6 — hay devs, menos que JS | **9** — el mercado laboral local es JS |
| Actualizaciones sin revisión de tienda (10 %) | 6 — requiere Shorebird (de pago) | **9** — EAS Update en el plan gratuito/barato |
| Riesgo de proyecto (15 %) | **8** — ya está comprometido en la propuesta | 7 — cambiar el stack ahora tiene costo comercial |
| **Total ponderado** | **7.85** | **8.35** |

**Decisión: se mantiene Flutter.** El RN+Expo puntúa algo más alto *en abstracto*, pero cambiar el stack
que ya se presentó al cliente cuesta credibilidad, y la diferencia (0.5 puntos) no paga esa factura.
**La condición:** el equipo debe tener o adquirir competencia real en Dart **antes** de la semana 1. Si
el equipo es 100 % TypeScript y no hay nadie con Flutter en producción, se cambia a Expo **ahora**, no
en la semana 3 (registrar como ADR-002 y comunicarlo al cliente como "optimización técnica").

> **Nota sobre actualizaciones OTA:** con tablets en planta, poder corregir un bug sin pasar por revisión
> de tienda vale mucho. Si se queda Flutter, evaluar **Shorebird** (code push) desde el mes 2; cuesta
> menos que un día de parada por un bug en producción.

### 2.3 PostgreSQL, y nada más — **cerrado**

| Alternativa | Veredicto | Motivo |
|---|---|---|
| MongoDB | **Rechazada** | El kárdex y el CPP son transaccionales por naturaleza. Sin transacciones multi-documento ni `FOR UPDATE` simple, el descuadre es cuestión de tiempo. |
| MySQL / MariaDB | **Rechazada** | Funciona, pero pierde `numeric` con la misma comodidad, JSONB, MV y el ecosistema de extensiones. No hay razón para elegirla. |
| SQL Server | **Rechazada** | Licencia y peso operativo innecesarios; el equipo es Node/TS. |
| SQLite en servidor | **Rechazada** | Sin concurrencia real ni PITR. |
| Firebase / Supabase como backend | **Rechazada** | Las reglas de costo y cierre de período no caben en RLS. |

---

## 3. Alternativas descartadas explícitamente

Estas son las trampas habituales. Quedan por escrito para que nadie las reabra en la semana 4.

| Tecnología | Por qué **NO** |
|---|---|
| **Kubernetes** | Complejidad operativa de nivel enterprise para 1 servidor. Ni el equipo ni el presupuesto lo sostienen. |
| **GraphQL** | El cliente son 4 apps con pantallas conocidas; REST + OpenAPI genera clientes tipados y cachea mejor. GraphQL añade N+1 y complejidad de autorización por campo. |
| **Redis** | `pg-boss` cubre la cola. Una pieza menos que operar, respaldar y asegurar. |
| **Event sourcing completo** | El kárdex ya es un ledger; el resto del sistema no necesita reconstruir estado desde eventos. Se usa event log *de dominio* (`pedido_evento`, `audit.evento`) sin event sourcing. |
| **CQRS con proyecciones separadas** | Se resuelve con vistas materializadas en PostgreSQL. |
| **No-code / low-code** (Bubble, AppSheet) | No soportan CPP con bloqueo transaccional ni auditoría con cadena de hash. Sirven para un prototipo de 2 semanas, no para el sistema contable de una panadería. |
| **Firebase como base de datos** | Sin consultas relacionales ni transacciones multi-entidad. El margen por producto es una consulta relacional. |
| **Electron para la tablet** | La tablet ya corre Android/iOS; Flutter es mejor en táctil y batería. |
| **Módulo de facturación electrónica propio** | La integración SUNAT (PSE/OSE, certificado, series, resumen diario) es un proyecto aparte. Se integra un proveedor en Fase 3. |

---

## 4. Versiones y compatibilidad

```jsonc
// package.json (raíz del monorepo) — extracto
{
  "engines": { "node": ">=22 <27", "pnpm": ">=9" },
  "packageManager": "pnpm@9"
}
```

| Componente | Versión objetivo | Nota |
|---|---|---|
| Node.js | 24 LTS | Fijar con `.nvmrc` y en la imagen Docker (`node:24-alpine`) |
| pnpm | 9.x | `corepack enable` |
| PostgreSQL | 17-alpine | 18 es compatible; migrar solo con prueba en staging |
| Flutter | stable ≥ 3.35 | Fijar en `pubspec.yaml` y en `melos`/`.fvmrc` |
| Dart | ≥ 3.5 | Viene con Flutter |
| Android | minSdk 24 · targetSdk 35 | Cubre tablets antiguas de planta |
| iOS | 15+ | Cubre iPad y iPhone usados en Perú |

**Regla de actualización:** dependencias con `pnpm update --interactive` semanal; mayores solo en una
ventana con pruebas. Dependabot abre PRs automáticos y el CI decide.

---

## 5. Herramientas del equipo

| Necesidad | Herramienta | Configuración |
|---|---|---|
| Lint / formato TS | ESLint 9 (flat config) + Prettier | `packages/config` |
| Lint / formato Dart | `flutter analyze` + `dart format` | `analysis_options.yaml` estricto |
| Tests API | Vitest (unitario) + Testcontainers (integración) | Cobertura mínima por módulo |
| Tests web | Vitest + Testing Library + Playwright (E2E) | — |
| Tests móvil | `flutter test` + `integration_test` | — |
| Contratos | `openapi-typescript` (web) · `swagger_dart_code_generator` (Flutter) | Generado en CI, versionado en el repo |
| Git hooks | Husky + lint-staged + commitlint (Conventional Commits) | Bloquea commit con lint roto |
| Documentación API | `@nestjs/swagger` → `/api/docs` (solo staging) | — |
| Migraciones | `prisma migrate` | Nunca `db push` en staging/producción |
| Semillas | `prisma db seed` + `seed.sql` | Datos sintéticos reproducibles |
| Diagramas | Mermaid en Markdown | Se renderiza en GitHub |

### 5.1 Convención de ramas y commits

```
main            ← producción (protegida, requiere PR + CI verde)
develop         ← integración
feat/<tema>     ← funcionalidad
fix/<tema>      ← corrección
hotfix/<tema>   ← urgencia sobre main (se mergea a main y develop)
```

Commits: `feat(inventario): calcular CPP con bloqueo de fila`.
El changelog se genera solo. **El mensaje del commit es documentación operativa**: en 6 meses,
`git log` es la única fuente de verdad de por qué cambió algo.

---

## 6. Infraestructura: costo real mensual

Aquí se decide si el S/ 150/mes de la propuesta es sostenible.

| Concepto | Proveedor sugerido | Costo/mes (USD) | Costo/mes (S/) |
|---|---|---|---|
| VPS 4 vCPU / 8 GB / 80 GB SSD | Hetzner CX32 (~€7.6) o Vultr Miami (~$24) | 8 – 24 | 30 – 90 |
| Almacenamiento de backups (R2, ~10 GB) | Cloudflare | 0 – 1 | 0 – 4 |
| Imágenes de producto (R2/CDN) | Cloudflare | 0 – 1 | 0 – 4 |
| Sentry | Free tier | 0 | 0 |
| Uptime Kuma | Autoalojado | 0 | 0 |
| Correo transaccional (recuperación de contraseña) | Resend/Brevo free (3,000/mes) | 0 | 0 |
| **Subtotal operación** | | **8 – 26** | **30 – 98** |
| Dominio `.com` (anual, prorrateado) | Cloudflare Registrar | ~1 | ~4 |
| **Total** | | **9 – 27** | **34 – 102** |

### 6.1 ¿Es viable el S/ 150/mes?

**Sí, pero sin margen para soporte.** Con un VPS de USD 12 (S/ 45), quedan **S/ 105/mes** para soporte.
A una tarifa de S/ 30/hora, eso son **3.5 horas al mes**. Alcanza para monitoreo reactivo y un par de
incidencias; **no** para "soporte técnico en horario de oficina" ilimitado.

**Recomendación contractual:** definir por escrito **horas de soporte incluidas** (sugerido: 4 h/mes) y
tarifa por hora adicional. Sin esto, el primer mes con tres usuarios llamando por teléfono consume el
margen del año.

### 6.2 Costos de terceros que la propuesta excluye (hay que decírselo a Tanta)

| Concepto | Costo | Quién lo paga |
|---|---|---|
| Google Play Console | **USD 25 único** (cuenta de desarrollador) | Tanta (a su nombre) |
| Apple Developer Program | **USD 99/año** | Tanta (a su nombre) |
| Firebase (FCM) | Gratis en este volumen | — |
| Tablets y celulares | Variable | Tanta |
| Certificado de firma (opcional, si no se usa Play App Signing) | ~USD 100/año | Tanta |

Los tres primeros suman ≈ **S/ 465 el primer año**: es dinero que la propuesta no contempla y que
alguien tendrá que poner para que "la app esté en Android e iOS" sea cierto.

---

## 7. Cómo se levanta el proyecto (onboarding en 15 minutos)

```bash
# 1. Requisitos: Node 24, pnpm 9, Docker Desktop, Flutter 3.35+, Android Studio
git clone <repo> && cd tanta

# 2. Dependencias
corepack enable && pnpm install

# 3. Infraestructura local (PostgreSQL + servicio S3 local)
cp .env.example .env
docker compose -f infra/compose/docker-compose.dev.yml up -d

# 4. Base de datos
pnpm --filter api prisma migrate dev
pnpm --filter api prisma db seed        # datos sintéticos de panadería

# 5. Arrancar todo
pnpm dev                                 # api :3000 · web :5173
cd apps/mobile && flutter run            # tablet/emulador

# 6. Verificar
open http://localhost:3000/api/docs      # OpenAPI
open http://localhost:5173               # admin (admin@tanta.test / Tanta#2026)
```

**Criterio de aceptación del onboarding:** un desarrollador nuevo debe pasar de `git clone` a una
venta registrada en la app, en menos de 30 minutos y **sin ayuda de nadie**. Si no lo logra, la
documentación de arranque está rota y el proyecto tiene un problema de bus factor (`R-14`).

---

## 8. Estructura del monorepo (definitiva)

```
tanta/
├─ apps/
│  ├─ api/
│  │  ├─ prisma/            schema.prisma · migrations/ · seed.ts
│  │  ├─ src/
│  │  │  ├─ modules/        (16 contextos de 02 §4.1)
│  │  │  ├─ jobs/           push · pdf · cierre-periodo · verificar-kardex
│  │  │  ├─ common/         filtros · guards · paginación · errores RFC 9457
│  │  │  └─ shared/         decimal · fechas-lima · correlativos
│  │  └─ test/              e2e · fixtures
│  ├─ web/
│  │  └─ src/
│  │     ├─ modules/        maestros · almacen · vendedor · gerencia · seguridad
│  │     ├─ components/     ui (shadcn) · layout · charts · data-table
│  │     ├─ lib/            api-client (generado) · query-client · auth
│  │     └─ routes/         TanStack Router (file-based)
│  └─ mobile/
│     └─ lib/
│        ├─ features/       auth · cliente · produccion · almacen · vendedor
│        ├─ core/           http · sync · outbox · auth · theme
│        ├─ data/           drift (db, daos, tablas) · repositorios
│        └─ l10n/           es_PE
├─ packages/
│  ├─ contracts/            openapi.json · types.ts (generado) · dart client (generado)
│  ├─ domain/               costeo puro · dinero · fechas · validaciones compartidas
│  └─ config/               eslint · tsconfig · tailwind · prettier
├─ infra/
│  ├─ compose/              docker-compose.dev.yml · docker-compose.prod.yml
│  ├─ caddy/                Caddyfile
│  ├─ backup/               backup.sh · restore.sh · verificar-restauracion.sh
│  └─ scripts/              deploy.sh · smoke-test.sh
├─ .github/workflows/       ci.yml · deploy.yml · e2e.yml
└─ docs/                    este dossier
```

---

## 9. Qué se necesita contratar o comprar (checklist de arranque)

| # | Ítem | Responsable | Bloquea |
|---|---|---|---|
| 1 | Dominio `tantapanaderia.com` registrado y con DNS apuntando al VPS | Proveedor | Go-live |
| 2 | VPS contratado (4 vCPU / 8 GB) | Proveedor | Staging |
| 3 | Cuenta Cloudflare (R2 + DNS + CDN) | Proveedor | Imágenes, backups |
| 4 | Proyecto Firebase (FCM) | Proveedor | Push |
| 5 | Cuenta Sentry | Proveedor | Operación |
| 6 | Repositorio GitHub privado + organización | Proveedor | Todo |
| 7 | Cuenta Google Play Developer (USD 25) | **Tanta** | App en tienda |
| 8 | Apple Developer Program (USD 99/año) | **Tanta** | App en iOS |
| 9 | Tablets de producción (mín. 2, 10" Android) | **Tanta** | UAT real |
| 10 | Celulares para almacén y vendedor | **Tanta** | UAT real |
| 11 | Datos base: productos, recetas, insumos, CIF | **Tanta** | Todo el motor de costeo |
| 12 | Acceso a internet en planta y almacén | **Tanta** | Sync |
| 13 | Usuario clave designado para validaciones | **Tanta** | UAT |

---

## 10. Resumen para decidir en una reunión

> Construimos con **TypeScript en todo el servidor y la web, Flutter en el móvil y PostgreSQL como única
> fuente de verdad**, desplegado en **un VPS con Docker y Caddy**, con **una sola API** y **una sola base
> de datos**. Sin microservicios, sin Kubernetes, sin Redis, sin GraphQL. El costo de infraestructura es
> de **S/ 34 a S/ 102 al mes**, lo que deja el servicio mensual de S/ 150 en zona viable solo si el
> soporte se limita por contrato a ~4 horas mensuales.

---

**Siguiente lectura:** `04-MODELO-DE-DATOS.md` — las tablas, sus reglas y por qué cada una existe.
