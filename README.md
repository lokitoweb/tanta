# TANTA — Sistema Integral de Gestión

Sistema Integral de Gestión para Panadería Tanta. App móvil (Android/iOS/tablet) + plataforma web
administrable + API + base de datos, con el motor de costeo y rentabilidad en el centro.

**Estado:** vertical completo funcionando — base de datos, API, web y app móvil conectadas.
**Arquitectura:** cerrada y documentada en [`docs/`](docs/).

---

## Arrancar todo (instalación desde cero)

Requisitos: Node 22+, pnpm 9+, Docker Desktop, Flutter 3.35+ (solo para la app móvil).

```bash
pnpm install        # dependencias de todos los paquetes
pnpm setup          # tokens + build del API + Postgres en Docker + migraciones + semilla
```

Luego, en dos terminales:

```bash
pnpm api            # API en http://127.0.0.1:3001/api/v1
pnpm web            # web en http://127.0.0.1:5180
```

Y para la app móvil:

```bash
cd apps/mobile
flutter run --dart-define=API_URL=http://10.0.2.2:3001/api/v1   # emulador Android
flutter run --dart-define=API_URL=http://<tu-ip>:3001/api/v1   # dispositivo físico
```

**Usuarios de la semilla** (contraseña `tanta` para todos):

| Perfil | Usuario | Ve |
|---|---|---|
| Gerente | `osquilcate` | Costos, márgenes, dashboard, reportes |
| Administrador | `lbermudez` | Maestros, recetas, usuarios |
| Producción | `rquispe` | Tablero de órdenes (sin costos) |
| Almacén | `jramos` | Stock y kárdex (sin costos) |
| Vendedor | `cmedina` | Pedidos, cobranza, catálogo |
| Cliente | `mfernandez` | Catálogo y pedido |
| Soporte | `soporte` | Nada de negocio (break-glass) |

### Qué hace ya, de verdad

- **Autenticación real**: JWT de 15 minutos + refresco opaco con rotación y detección de reuso.
  Contraseñas con `scrypt`. Bloqueo por intentos y auditoría de cada acceso.
- **Autorización en el servidor**: el menú y los permisos los calcula el API por rol; un vendedor
  **no recibe** el costo ni el margen — no se ocultan con CSS, no llegan al navegador.
- **Operación real contra PostgreSQL**: cerrar una orden de producción descuenta insumos, registra
  merma e ingresa producto terminado en una sola transacción. Registrar una venta congela el costo
  de cada línea. La cobranza actualiza el saldo de la cuenta por cobrar.
- **El móvil opera, no solo consulta**: el vendedor avanza pedidos por su máquina de estados
  (`REGISTRADO → EN_PRODUCCION → LISTO → DESPACHADO → ENTREGADO`) y registra cobros; Producción
  cierra órdenes; el cliente ve **solo sus** pedidos y su saldo.
- **Las pestañas del móvil nacen de los permisos**: si un rol no puede cobrar, la pestaña no existe.
- **Idempotencia**: `Idempotency-Key` en las mutaciones; un reintento no duplica la operación.
- **Auditoría encadenada e inmutable**: cada evento guarda el hash del anterior, la escritura se
  serializa con un lock de PostgreSQL y un trigger impide `UPDATE`/`DELETE`. Se verifica en
  `GET /api/v1/auditoria/verificar`.
- **Administrable sin tocar código**: parámetros (IGV, margen objetivo), usuarios, bloqueo de cuentas,
  precios y cierre de períodos se gestionan desde la interfaz.

### Postura de seguridad (auditada)

Una auditoría independiente del código encontró 39 hallazgos. Los bloqueadores corregidos:

| Antes | Ahora |
|---|---|
| `JWT_SECRET` con valor por defecto → se podía forjar un token de Gerente | El API **no arranca** sin un secreto de 32+ caracteres; el forjado devuelve 401 |
| `/datos` filtraba costo y margen al Vendedor y la cartera al Cliente | Proyección por permiso: lo que el rol no puede ver **no se serializa** |
| Credenciales de demostración dentro del bundle de producción | Solo existen en desarrollo (`import.meta.env.DEV`) |
| Cadena de auditoría rota y editable | Lock + hash canónico + trigger append-only; `ok:true` verificado |
| Venta a crédito sin cliente perdía la cuenta por cobrar en silencio | Se exige `clienteId`, se valida el límite de crédito y la CxC es atómica |
| Correlativo con `count(*)` → 10-22 % de ventas fallaban en concurrencia | Secuencia de PostgreSQL: 13 ventas simultáneas, 0 colisiones |
| Mensajes de PostgreSQL crudos al cliente (500) | Traducidos a errores de negocio (409/422) sin filtrar SQL |
| Rate limit de 240/min por IP (4 req/s) | 6000/min, con límite estricto conservado en `/auth/login` |

**Ya implementado:** contraseñas con **Argon2id** (migración transparente desde scrypt), refresco en
cookie **`HttpOnly`** y **TOTP** obligatorio en producción para Gerencia y Administración, con
bloqueo por cuenta y tiempos de respuesta constantes.

**Cola offline en el móvil:** cada cobro y cada cambio de pedido se guarda en disco antes de
enviarse; si no hay red, se reintenta en orden con la misma clave de idempotencia. La franja ámbar
muestra cuántas operaciones esperan.

La sincronización se reintenta cada 20 segundos mientras la app está abierta y al volver a primer
plano, sin que el usuario haga nada.

**Pendiente y conocido:** los códigos de recuperación de MFA en la interfaz (el backend ya los
contempla) y la sincronización con la app cerrada, que exige workmanager en Android y
BGTaskScheduler en iOS y solo puede verificarse en un dispositivo real.

| Componente | Dónde | Cómo se levanta |
|---|---|---|
| Base de datos | [`apps/api/db/migrations`](apps/api/db/migrations) | `pnpm db:migrate` (idempotente) |
| Semilla de operación | [`apps/api/db/seed.ts`](apps/api/db/seed.ts) | `pnpm db:seed` |
| API | [`apps/api`](apps/api) | `pnpm api` |
| Web | [`apps/web`](apps/web) | `pnpm web` |
| Móvil | [`apps/mobile`](apps/mobile) | `flutter run` |
| Diseño (fuente única) | [`packages/tokens`](packages/tokens) | `pnpm tokens` → CSS + Dart |
| Despliegue | [`docs/17-DESPLIEGUE.md`](docs/17-DESPLIEGUE.md) | `pnpm prod:up` |

Capturas de cada pantalla y rol en `.shots/`.

---
**Base:** Informe Ejecutivo v1.0 de Team eSolutionsNet (21/10/2026, 19 páginas).
**Revisión:** 01/11/2026.

---

## Cómo leer este dossier

| Si eres… | Lee en este orden |
|---|---|
| **Gerente / dueño del negocio** | [`01-DIAGNOSTICO-Y-RIESGOS.md`](docs/01-DIAGNOSTICO-Y-RIESGOS.md) §6 y §7, luego [`11-PLAN-DE-EJECUCION.md`](docs/11-PLAN-DE-EJECUCION.md) §1–§3 |
| **Líder técnico / arquitecto** | `00` → `02` → `03` → `04` → `06` → `12` |
| **Desarrollador backend** | `00` → `04` → `05` → `06` → `07` → `09` |
| **Desarrollador frontend / móvil** | `00` → `05` → `09` → `10` |
| **Responsable de seguridad** | `00` → `08` → `13` |
| **QA / DevOps** | `11` → `13` → `08 §7` |

---

## Diseño

La identidad sale de la tarjeta de presentación (crema + marrón tinta), pero la **interfaz es moderna y
densa**, no artesanal: barra lateral oscura, tipografía de sistema sin serifas en los datos, tarjetas de
1 px y tablas compactas. El serif queda donde debe: el wordmark y la tarjeta del login.

| Decisión | Motivo |
|---|---|
| Tokens en `packages/tokens/tokens.json` | Un solo origen para web (CSS) y móvil (Dart) |
| Escala neutra + acentos de marca | Contraste AA sin perder el carácter cálido |
| Densidad 14 px / filas de 40 px | Un gerente mira muchas cifras; el aire excesivo obliga a hacer scroll |
| Cifras con `tabular-nums` | Las columnas de dinero se alinean solas |
| Foco visible y `prefers-reduced-motion` | Accesibilidad real, no declarativa |

---

## Documentos

| # | Documento | Qué resuelve |
|---|---|---|
| 00 | [Contexto y decisiones](docs/00-CONTEXTO-Y-DECISIONES.md) | Contrato normativo: stack, convenciones, precisión numérica, vocabulario. |
| 01 | [Diagnóstico y riesgos](docs/01-DIAGNOSTICO-Y-RIESGOS.md) | Auditoría crítica de la propuesta: 11 inconsistencias, 13 vacíos, 15 riesgos, viabilidad precio/plazo. |
| 02 | [Arquitectura](docs/02-ARQUITECTURA.md) | C4, monolito modular, 16 contextos, flujos, transacciones, despliegue, SLOs. |
| 03 | [Stack y decisiones](docs/03-STACK-Y-DECISIONES.md) | Con qué se construye, alternativas descartadas, costo real de infraestructura. |
| 04 | [Modelo de datos](docs/04-MODELO-DE-DATOS.md) | ER, DDL PostgreSQL, reglas por entidad. |
| 05 | [API y contratos](docs/05-API-CONTRATOS.md) | Endpoints, máquinas de estado, errores, idempotencia, ejemplos. |
| 06 | [Motor de costeo](docs/06-MOTOR-DE-COSTEO.md) | Fórmulas, redondeo, snapshots, CIF, casos borde, casos de prueba dorados. |
| 07 | [Inventario y kárdex](docs/07-INVENTARIO-Y-KARDEX.md) | Ledger inmutable, CPP transaccional, concurrencia, integridad. |
| 08 | [Seguridad y cumplimiento](docs/08-SEGURIDAD-Y-CUMPLIMIENTO.md) | Amenazas, RBAC con scoping, criptografía, auditoría, Ley 29733. |
| 09 | [Offline y sincronización](docs/09-OFFLINE-Y-SINCRONIZACION.md) | Drift, outbox, protocolo de sync, conflictos, idempotencia extremo a extremo. |
| 10 | [Frontend móvil y web](docs/10-FRONTEND-MOVIL-Y-WEB.md) | Arquitectura Flutter/React, UX por perfil, dashboard, distribución en tiendas. |
| 11 | [Plan de ejecución](docs/11-PLAN-DE-EJECUCION.md) | Fases, cronograma de 30 días día por día, DoD, orquestación con agentes, recorte por riesgo. |
| 12 | [ADRs](docs/12-ADRS.md) | 18 decisiones registradas con su justificación y alternativas. |
| 13 | [Calidad y operación](docs/13-CALIDAD-Y-OPERACION.md) | Pruebas, CI/CD, infraestructura, observabilidad, backups, runbooks. |
| 14 | [Levantamiento de requisitos](docs/14-LEVANTAMIENTO-DE-REQUISITOS.md) | Las preguntas que hay que hacer antes de construir, y qué decisión cambia cada respuesta. |
| 17 | [Despliegue](docs/17-DESPLIEGUE.md) | Instalación en el VPS, actualizaciones, respaldos, restauración, runbook e incidentes. |

### Pruebas

| Comando | Qué hace |
|---|---|
| `pnpm test` | Suite funcional: autenticación, roles, idempotencia, invariantes, administración |
| `pnpm test:carga` | Prueba de carga (concurrencia y duración configurables) |
| Informe | [`tests/INFORME-CARGA.md`](tests/INFORME-CARGA.md) · [`tests/INFORME-AUDITORIA.md`](tests/INFORME-AUDITORIA.md) |

### Diagramas

| Archivo | Qué muestra |
|---|---|
| [`diagrams/01-mapa-del-sistema.png`](diagrams/01-mapa-del-sistema.png) | Las 4 capas, los 6 roles de negocio (+ soporte), los 12 módulos de la API, la base de datos y el worker. |
| [`diagrams/02-flujo-del-dinero.png`](diagrams/02-flujo-del-dinero.png) | La cadena pedido → OP → consumo → producción → venta → cobranza → costeo → margen, y qué dato deja cada paso. |

---

## Las cinco conclusiones que resumen todo

1. **La idea es buena y vale la pena construirla.** El enfoque en costo y margen —no en facturación— es
   el correcto para una panadería, y casi ningún producto del mercado local lo hace bien.
2. **El alcance no cabe en el precio ni en el plazo.** S/ 3,000 y 22 días hábiles para ~160 persona-día
   de trabajo real. Ver `01 §6`.
3. **Faltan seis decisiones que, si se toman tarde, obligan a rehacer trabajo:** versionar receta y
   precio, kárdex inmutable, offline real, idempotencia, cierre de período de CIF, y listas de precio.
4. **La salida es entregar por fases**, empezando por el núcleo del dinero (pedido → producción →
   inventario → venta → cobranza → margen) y no por los 16 reportes.
5. **El stack propuesto es razonable** (Flutter + NestJS + PostgreSQL). Se mantiene, con ajustes
   concretos: pg-boss en vez de Redis, monolito modular en vez de servicios, y OpenAPI como contrato
   entre las tres corrientes de trabajo.

---

## Verificación rápida de los números del documento original

| Comprobación | Resultado |
|---|---|
| 26/10/2026 es lunes · 24/11/2026 es martes | ✅ correcto |
| Días hábiles del 26/10 al 24/11 | ✅ 22 |
| Ficha de costo ciabatta: 0.62 + 0.02 + 0.26 = 0.90 | ✅ correcto |
| 2.36 ÷ 1.18 = 2.00 · utilidad 1.10 · margen 55.0 % · markup 122.2 % | ✅ correcto |
| Inversión año 1: 3,000 + 1,800 + 78 = 4,878 · IGV 878.04 · total 5,756.04 | ✅ correcto |
| Pagos: 1,180 + 2,360 = 3,540 = 3,000 × 1.18 | ✅ correcto |
| Fecha del hito H5 (Go-live) | ⚠️ 20/11 en la tabla §6.3 vs. 24/11 en el Gantt y en el pago |
| Esfuerzo real del alcance vs. plazo | ❌ ~160 persona-día vs. ~66 disponibles |
