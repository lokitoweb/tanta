# 05 · API y Contratos — Tanta Core

> **Estado:** normativo. Desarrolla D-05, D-06, D-07 y D-09 de `00-CONTEXTO-Y-DECISIONES.md`.
> Toda ruta, campo y código de error definido aquí es contrato público: app Flutter, web React y
> pruebas de integración se generan desde este documento y desde el OpenAPI 3.1 resultante.
>
> **Base URL:** `https://www.tantapanaderia.com/api/v1` · **Formato:** `application/json` (errores
> `application/problem+json`) · **Zona horaria de negocio:** `America/Lima` · **Moneda:** PEN.

---

## 0. Decisiones de contrato que este documento fija

| # | Decisión | Motivo |
|---|---|---|
| C-01 | Los `NUMERIC` se serializan como **string** en JSON (`"0.9000"`), nunca como número. | Evita pérdida de precisión en JavaScript (`0.1+0.2`) y en `json_parse` de Dart. D-03 es no negociable. |
| C-02 | Envoltorio de lista: `{ "datos": [...], "paginacion": {...} }`. Recurso individual: objeto plano. | Un solo formato de colección predecible para clientes generados. |
| C-03 | Nombres de dominio en **español camelCase** (`fechaEntrega`, `cantidadProducida`). Términos de plataforma en inglés (`cursor`, `limit`, `Idempotency-Key`, `opId`) porque son parte del sobre HTTP, no del negocio. | Coherencia con el vocabulario ubicuo (§3 de `00`) sin inventar traducciones de infraestructura. |
| C-04 | Toda mutación (`POST`, `PATCH`, `PUT`, `DELETE`) **exige** `Idempotency-Key`; su ausencia es `400 IDEMPOTENCY_KEY_REQUERIDA`. | D-06 lo declara obligatorio; hacerlo opcional produce duplicados de producción el día 1. |
| C-05 | Las operaciones que pueden tardar > 5 s devuelven `202 Accepted` + `Location` a un recurso de trabajo (`/trabajos/{id}`). | Reportes densos y prorrateo CIF no caben en el presupuesto de timeout (§9). |
| C-06 | El servidor **nunca** confía en totales enviados por el cliente: recalcula precios, IGV, costos y saldos. Los importes del request son solo *intención*. | D-09: la app no calcula costo, margen ni saldo definitivo. |
| C-07 | Los IDs son UUIDv7 en texto con guiones, minúsculas. Los correlativos legibles (`PED-2026-000123`) son campos aparte (`codigo`), nunca la PK. | D-05: el correlativo no se genera en el cliente. |

---

## 1. Mapa de módulos NestJS y frontera de datos

### 1.1 Regla de frontera (obligatoria, verificada por lint de arquitectura)

1. Un módulo **solo escribe** en las tablas que posee. No hay excepciones.
2. Un módulo **lee** datos ajenos solo por (a) un **caso de uso público** o `QueryService` que exporta
   el dueño, o (b) una vista `report.mv_*`. Nunca con `prisma.<tablaAjena>` directo, y nunca con un
   `JOIN` que cruce tablas de dos módulos. Es el P-07 de `02-ARQUITECTURA.md` aplicado a datos.
3. Un módulo **provoca** efectos en otro solo publicando un **evento de dominio** en pg-boss
   (`core.evento_dominio`); el consumidor es idempotente por `eventoId`. Las transacciones son del
   caso de uso (`prisma.$transaction`), no del repositorio.
4. Las FK entre módulos existen en la base de datos (integridad referencial) pero **sin `ON DELETE CASCADE`**:
   todo borrado es lógico (`borrado_en`), D-04.
5. `packages/domain` contiene las reglas puras compartidas (cálculo de IGV, redondeo, márgenes,
   validadores de estado). Ningún módulo reimplementa esas fórmulas.

```mermaid
flowchart TD
  subgraph Plataforma
    AUTH[identidad]
    AUD[auditoria]
    NOT[notificaciones]
    SYN[sync]
    IDF[idempotencia]
  end
  subgraph Maestros
    MAE[maestros]
    CAT[catalogo]
    PRE[precios]
    REC[recetas]
    CIF[costeo · CIF]
  end
  subgraph Operación
    PED[pedidos]
    PRO[produccion]
    INV[inventario]
    VEN[ventas]
    COB[cobranza]
  end
  subgraph Analítica
    COS[costeo]
    REP[reportes]
  end
  MAE --> CAT
  CAT --> PRE
  CAT --> REC
  PED --> PRO
  PRO --> INV
  PED --> VEN
  VEN --> COB
  INV --> COS
  CIF --> COS
  VEN --> COS
  COS --> REP
  COB --> REP
  PED -. evento .-> NOT
  PRO -. evento .-> NOT
  COB -. evento .-> NOT
  PED -. evento .-> SYN
  INV -. evento .-> SYN
  AUTH --> AUD
```

### 1.2 Dueño de cada tabla

> **Nota de concordancia.** Los nombres de esta tabla son **lógicos** (por contexto y lenguaje ubicuo).
> La **forma física** —DDL, columnas, constraints— la fija `04-MODELO-DE-DATOS.md`, que es la autoridad
> del esquema. La correspondencia nombre lógico → tabla física está en **`04 §Anexo A-1`**. Si hay
> discrepancia, manda el físico.

| Módulo | Carpeta | Tablas que **posee** (esquema) | Emite eventos |
|---|---|---|---|
| `identidad` | `modules/identidad` | `usuario`, `rol`, `permiso`, `rol_permiso`, `usuario_rol`, `sesion`, `refresh_token`, `mfa_secreto`, `intento_login`, `dispositivo`, `recuperacion_password` (`core`) | `usuario.creado`, `usuario.bloqueado`, `sesion.revocada`, `dispositivo.registrado` |
| `maestros` | `modules/maestros` | `cliente`, `cliente_direccion`, `proveedor`, `sucursal`, `caja`, `parametro`, `categoria`, `unidad_medida`, `secuencia_documento` (`core`) | `cliente.creado`, `parametro.actualizado`, `precio.cambiado` (solo parámetro IGV) |
| `catalogo` | `modules/catalogo` | `producto`, `producto_imagen`, `insumo`, `insumo_proveedor` (`core`) | `producto.creado`, `producto.actualizado`, `insumo.actualizado`, `producto.inhabilitado` |
| `precios` | `modules/precios` | `lista_precio`, `producto_precio`, `precio_historial`, `margen_objetivo` (`core`) | `precio.cambiado` |
| `recetas` | `modules/recetas` | `receta`, `receta_version`, `receta_detalle` (`core`) | `receta.publicada`, `receta.retirada` |
| `inventario` | `modules/inventario` | `stock`, `movimiento_inventario`, `costo_promedio_historial`, `compra`, `compra_detalle`, `requisicion`, `requisicion_detalle`, `baja_inventario`, `ajuste_inventario`, `toma_inventario`, `toma_inventario_detalle`, `alerta_stock` (`core`) | `inventario.movimiento_registrado`, `cpp.recalculado`, `stock_bajo_minimo`, `stock_negativo` |
| `produccion` | `modules/produccion` | `orden_produccion`, `op_detalle`, `op_consumo`, `merma_produccion` (`core`) | `op.generada`, `op.iniciada`, `op.terminada`, `op.cancelada` |
| `pedidos` | `modules/pedidos` | `pedido`, `pedido_detalle`, `pedido_estado_historial`, `despacho`, `despacho_detalle` (`core`) | `pedido.registrado`, `pedido.estado_cambiado`, `pedido.anulado`, `despacho.confirmado` |
| `ventas` | `modules/ventas` | `venta`, `venta_detalle`, `comprobante_interno`, `sesion_caja` (`core`) | `venta.emitida`, `venta.anulada`, `descuento.autorizado` |
| `cobranza` | `modules/cobranza` | `cuenta_por_cobrar`, `cxc_cuota`, `pago`, `pago_aplicacion` (`core`) | `pago.registrado`, `cxc.estado_cambiado`, `cxc.vencida` |
| `costeo` | `modules/costeo` | `costo_indirecto`, `periodo_costo`, `cif_prorrateo`, `ficha_costo`, `ficha_costo_detalle`, `costo_linea_venta` (`core`) | `ficha_costo.recalculada`, `periodo.cerrado` |
| `reportes` | `modules/reportes` | vistas materializadas `report.mv_resumen_periodo`, `report.mv_venta_diaria`, `report.mv_rentabilidad_producto`, `report.mv_rentabilidad_cliente`, `report.mv_rentabilidad_vendedor`, `report.mv_cartera_aging`, `report.mv_stock_valorizado`, `report.mv_produccion_diaria`; tabla `report.exportacion` (`report`) | `exportacion.generada` |
| `notificaciones` | `modules/notificaciones` | `notificacion`, `notificacion_destino`, `dispositivo_push`, `plantilla_notificacion` (`core`) | `notificacion.enviada` |
| `sync` | `modules/sync` | `sync_lote`, `sync_operacion`, `sync_cursor_dispositivo`, `sync_conflicto` (`core`) | `sync.lote_recibido`, `sync.conflicto_detectado` |
| `auditoria` | `modules/auditoria` | `audit.evento`, `audit.evento_cadena`, `audit.acceso_dato` (`audit`) | — (sumidero) |
| `plataforma` | `modules/plataforma` | `idempotencia`, `evento_dominio`, `limite_tasa`, `trabajo` (`core`) | — |

**Nota [AMPLIACIÓN] sobre D-05:** además de `PED`, `OP` y `VTA`, `secuencia_documento` emite
`REQ` (requisición), `BAJ` (baja), `DES` (despacho), `PAG` (pago), `AJU` (ajuste), `TOM` (toma de
inventario), `CMP` (compra). Sin ellos la trazabilidad exigida en §3.2 de la propuesta
("cada baja queda asociada a la OP, pedido o venta que la originó") no es citable por documento.

### 1.3 Eventos de dominio y consumidores

| Evento | Payload mínimo | Consumidores |
|---|---|---|
| `pedido.registrado` | `pedidoId`, `clienteId`, `fechaEntrega`, `total` | `notificaciones`, `reportes`, `sync` |
| `pedido.estado_cambiado` | `pedidoId`, `de`, `a`, `actorId` | `notificaciones` (push), `reportes` |
| `op.terminada` | `opId`, `productoId`, `cantidadProducida`, `mermaTotal` | `inventario` (ingreso), `sync` |
| `op.generada` | `opId`, `pedidoIds[]`, `requerimiento[]` | `inventario` (requisición), `notificaciones` |
| `inventario.movimiento_registrado` | `movimientoId`, `itemTipo`, `itemId`, `cantidad`, `saldoResultante` | `costeo`, `reportes`, `sync` |
| `cpp.recalculado` | `insumoId`, `cppAnterior`, `cppNuevo`, `origenMovimientoId` | `costeo` (marca fichas obsoletas), `reportes` (G-08) |
| `venta.emitida` | `ventaId`, `canal`, `total`, `lineas[]` con `costoUnitario` | `cobranza` (CxC), `costeo` (snapshot), `reportes` |
| `pago.registrado` | `pagoId`, `cxcId`, `monto`, `saldo` | `cobranza`, `reportes`, `notificaciones` |
| `cxc.vencida` | `cxcId`, `clienteId`, `diasVencido`, `saldo` | `notificaciones`, `reportes` |
| `precio.cambiado` | `productoId`, `precioAnterior`, `precioNuevo`, `vigenteDesde` | `sync` (invalidación de caché móvil), `auditoria` |

---

## 2. Catálogo de endpoints

Convenciones: rol separado por `|` significa "cualquiera de ellos". `PROPIO` = scoping por recurso
D-07 (el Cliente solo ve lo suyo, el Vendedor solo su cartera). **Idem.** = `Idempotency-Key`
obligatorio (`Sí`) o endpoint de solo lectura (`No`).

### 2.1 Autenticación y sesión

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| POST | `/auth/login` | público | Validar credenciales; devuelve access + refresh. | No (rate-limited) |
| POST | `/auth/mfa/verificar` | público (pre-auth) | Completar segundo factor TOTP. | Sí |
| POST | `/auth/mfa/inscribir` | ADMIN, GERENTE | Generar secreto TOTP y QR. | Sí |
| POST | `/auth/mfa/activar` | ADMIN, GERENTE | Confirmar código y activar MFA. | Sí |
| POST | `/auth/refresh` | público (refresh) | Rotar refresh token; detecta reuso. | Sí |
| POST | `/auth/logout` | todos | Revocar sesión actual. | Sí |
| POST | `/auth/logout-todos` | todos | Revocar todas las sesiones del usuario. | Sí |
| GET | `/auth/me` | todos | Perfil, roles y permisos efectivos. | No |
| PATCH | `/auth/me` | todos | Datos de contacto y dirección de entrega. | Sí |
| POST | `/auth/password/cambio` | todos | Cambiar contraseña (Argon2id). | Sí |
| POST | `/auth/password/recuperacion` | público | Solicitar enlace de recuperación. | Sí |
| POST | `/auth/password/restablecer` | público (token) | Consumir token de recuperación. | Sí |
| POST | `/auth/dispositivos` | todos | Registrar instalación (`deviceId`, FCM, plataforma). | Sí |
| DELETE | `/auth/dispositivos/{id}` | todos | Revocar dispositivo. | Sí |

### 2.2 Usuarios y roles (Maestros)

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| GET | `/usuarios` | ADMIN | Listar usuarios con filtros rol/estado. | No |
| POST | `/usuarios` | ADMIN | Alta de usuario interno. | Sí |
| GET | `/usuarios/{id}` | ADMIN | Detalle. | No |
| PATCH | `/usuarios/{id}` | ADMIN | Editar datos y estado. | Sí |
| PUT | `/usuarios/{id}/roles` | ADMIN | Asignar conjunto de roles. | Sí |
| POST | `/usuarios/{id}/bloqueo` | ADMIN | Bloquear / desbloquear. | Sí |
| DELETE | `/usuarios/{id}` | ADMIN | Baja lógica. | Sí |
| GET | `/roles` | ADMIN | Catálogo de roles. | No |
| GET | `/permisos` | ADMIN | Catálogo de permisos por módulo. | No |
| PUT | `/roles/{id}/permisos` | ADMIN | Permisos del rol. | Sí |

### 2.3 Clientes y parámetros

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| GET | `/clientes` | ADMIN, VENDEDOR | Cartera / padrón. | No |
| POST | `/clientes` | ADMIN, VENDEDOR | Alta de cliente. | Sí |
| GET | `/clientes/{id}` | ADMIN, VENDEDOR, PROPIO (CLIENTE) | Ficha de cliente. | No |
| PATCH | `/clientes/{id}` | ADMIN, VENDEDOR | Editar cliente. | Sí |
| GET | `/clientes/{id}/direcciones` | ADMIN, VENDEDOR, PROPIO | Direcciones de entrega. | No |
| POST | `/clientes/{id}/direcciones` | ADMIN, VENDEDOR, PROPIO | Agregar dirección. | Sí |
| PATCH | `/clientes/{id}/direcciones/{dirId}` | ADMIN, PROPIO | Editar dirección. | Sí |
| GET | `/parametros` | ADMIN, GERENTE | IGV, márgenes objetivo, redondeo. | No |
| PUT | `/parametros/{clave}` | ADMIN | Actualizar parámetro (auditado). | Sí |
| GET | `/sucursales` | todos | Sucursales activas (una al inicio). | No |
| GET | `/unidades-medida` | todos | Unidades (kg, g, l, ml, unidad). | No |

### 2.4 Catálogo de productos e insumos

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| GET | `/categorias` | todos | Categorías (pan, pastelería, tortas). | No |
| POST | `/categorias` | ADMIN | Alta de categoría. | Sí |
| PATCH | `/categorias/{id}` | ADMIN | Editar categoría. | Sí |
| GET | `/productos` | todos | Catálogo con precio vigente y disponibilidad. | No |
| POST | `/productos` | ADMIN | Alta de producto. | Sí |
| GET | `/productos/{id}` | todos | Ficha: categoría, unidad, receta vigente. | No |
| PATCH | `/productos/{id}` | ADMIN | Editar producto. | Sí |
| POST | `/productos/{id}/imagenes/url-carga` | ADMIN | URL prefirmada R2 (nunca multipart en API). | Sí |
| POST | `/productos/{id}/imagenes` | ADMIN | Confirmar imagen subida. | Sí |
| DELETE | `/productos/{id}` | ADMIN | Baja lógica. | Sí |
| GET | `/productos/{id}/disponibilidad` | todos | Stock disponible proyectado y próximo horneado. | No |
| GET | `/insumos` | ADMIN, ALMACEN, PRODUCCION, GERENTE | Listado con CPP, stock y mínimo. | No |
| POST | `/insumos` | ADMIN | Alta de insumo. | Sí |
| GET | `/insumos/{id}` | ADMIN, ALMACEN, GERENTE | Detalle, proveedores, CPP vigente. | No |
| PATCH | `/insumos/{id}` | ADMIN | Editar insumo (no el CPP: lo mueve el kárdex). | Sí |
| GET | `/insumos/{id}/cpp/historial` | ADMIN, GERENTE | Evolución del CPP (alimenta G-08). | No |
| GET | `/proveedores` | ADMIN, ALMACEN | Proveedores. | No |
| POST | `/proveedores` | ADMIN | Alta de proveedor. | Sí |

### 2.5 Precios y márgenes objetivo

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| GET | `/listas-precio` | ADMIN, VENDEDOR, GERENTE | Listas vigentes. | No |
| POST | `/listas-precio` | ADMIN | Crear lista. | Sí |
| GET | `/productos/{id}/precios` | todos | Precio vigente + historial. | No |
| POST | `/productos/{id}/precios` | ADMIN | Nuevo precio con `vigenteDesde`; historiza el anterior. | Sí |
| POST | `/precios/lote` | ADMIN | Carga masiva (hasta 200 productos). | Sí |

La ficha de costo (M-01) **no** tiene endpoint propio en este módulo: se consulta en
`GET /reportes/m-01` (§2.14) y su cálculo vive en `costeo` (§2.13). Un solo endpoint, un solo dueño.

### 2.6 Recetas

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| GET | `/recetas` | ADMIN, PRODUCCION, GERENTE | Recetas con versión vigente. | No |
| POST | `/recetas` | ADMIN | Crear receta (cabecera). | Sí |
| GET | `/recetas/{id}` | ADMIN, PRODUCCION | Cabecera + versión vigente. | No |
| POST | `/recetas/{id}/versiones` | ADMIN | Nueva versión (borrador inmutable al publicar). | Sí |
| GET | `/recetas/{id}/versiones/{version}` | ADMIN, PRODUCCION | Versión concreta (histórica). | No |
| PUT | `/recetas/{id}/versiones/{version}/detalle` | ADMIN | Reemplazar líneas del borrador. | Sí |
| POST | `/recetas/{id}/versiones/{version}/publicar` | ADMIN | Publicar: congela y recalcula fichas de costo. | Sí |
| POST | `/recetas/{id}/retirar` | ADMIN | Retirar receta. | Sí |
| GET | `/productos/{id}/receta-vigente` | PRODUCCION, ALMACEN, ADMIN | Receta + requerimiento por tanda. | No |

### 2.7 Costos indirectos y períodos

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| GET | `/costos-indirectos` | ADMIN, GERENTE | CIF: tipo fijo/variable, monto, base de prorrateo. | No |
| POST | `/costos-indirectos` | ADMIN | Alta de concepto CIF. | Sí |
| PATCH | `/costos-indirectos/{id}` | ADMIN | Editar monto o base (auditado). | Sí |
| GET | `/periodos-costo` | ADMIN, GERENTE | Períodos mensuales y su estado. | No |
| POST | `/periodos-costo` | ADMIN | Abrir período. | Sí |
| POST | `/periodos-costo/{id}/prorrateo` | ADMIN, GERENTE | Ejecutar prorrateo CIF (202 + trabajo). | Sí |
| POST | `/periodos-costo/{id}/cerrar` | ADMIN, GERENTE | Cerrar período; bloquea recálculo retroactivo. | Sí |
| GET | `/periodos-costo/{id}/prorrateo` | ADMIN, GERENTE | Detalle del prorrateo aplicado. | No |

### 2.8 Pedidos (Cliente, Vendedor, Producción)

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| GET | `/pedidos` | todos, PROPIO | Bandeja filtrable por estado, fecha, cliente. | No |
| POST | `/pedidos` | CLIENTE, VENDEDOR, ADMIN | Registrar pedido. | Sí |
| GET | `/pedidos/{id}` | PROPIO, VENDEDOR, PRODUCCION, ADMIN, GERENTE | Detalle con historial de estados. | No |
| PATCH | `/pedidos/{id}` | PROPIO (CLIENTE), VENDEDOR, ADMIN | Editar solo en `REGISTRADO`. | Sí |
| POST | `/pedidos/{id}/confirmar` | VENDEDOR, ADMIN | Confirmar pedido tomado por vendedor. | Sí |
| POST | `/pedidos/{id}/anular` | PROPIO, VENDEDOR, ADMIN, GERENTE | Anular con motivo. | Sí |
| POST | `/pedidos/{id}/repetir` | PROPIO, VENDEDOR | Clonar como pedido nuevo. | Sí |
| GET | `/pedidos/{id}/historial` | PROPIO, VENDEDOR, ADMIN, GERENTE | Trazabilidad de estados. | No |
| GET | `/pedidos/consolidado` | PRODUCCION, ADMIN | Tablero por fecha de entrega y prioridad. | No |
| GET | `/pedidos/pendientes-produccion` | PRODUCCION, ADMIN | Pedidos `REGISTRADO` sin OP. | No |

### 2.9 Producción — Órdenes de Producción

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| GET | `/ordenes-produccion` | PRODUCCION, ADMIN, GERENTE | Bandeja de OP por estado y fecha. | No |
| POST | `/ordenes-produccion` | PRODUCCION, ADMIN | Generar OP desde pedidos y/o stock objetivo. | Sí |
| GET | `/ordenes-produccion/{id}` | PRODUCCION, ALMACEN, ADMIN, GERENTE | OP con requerimiento y consumos. | No |
| GET | `/ordenes-produccion/{id}/requerimiento` | PRODUCCION, ALMACEN | Insumos calculados por receta vs. stock. | No |
| POST | `/ordenes-produccion/{id}/iniciar` | PRODUCCION | `PENDIENTE → EN_PROCESO`. | Sí |
| POST | `/ordenes-produccion/{id}/produccion` | PRODUCCION | Registrar cantidad real + merma + consumo. | Sí |
| POST | `/ordenes-produccion/{id}/cerrar` | PRODUCCION, ADMIN | `TERMINADA → CERRADA` tras costeo y stock. | Sí |
| POST | `/ordenes-produccion/{id}/cancelar` | ADMIN, GERENTE | Cancelar con reversa de consumo. | Sí |
| GET | `/ordenes-produccion/{id}/mermas` | PRODUCCION, GERENTE | Mermas registradas por motivo. | No |
| GET | `/produccion/tablero` | PRODUCCION, ADMIN | Tablero: pedidos, OP, insumos faltantes. | No |
| GET | `/produccion/consumo-insumos` | PRODUCCION, ALMACEN, GERENTE | Consumo agregado por insumo y período. | No |

### 2.10 Almacén e inventario

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| GET | `/inventario/stock` | ALMACEN, ADMIN, GERENTE, PRODUCCION | Stock por ítem con valorizado. | No |
| GET | `/inventario/stock/{itemTipo}/{itemId}` | ALMACEN, ADMIN, PRODUCCION | Stock y CPP de un ítem. | No |
| GET | `/inventario/kardex` | ALMACEN, ADMIN, GERENTE | Kárdex valorizado (A-01). | No |
| GET | `/inventario/stock-critico` | ALMACEN, ADMIN, GERENTE | Ítems bajo mínimo (A-02). | No |
| POST | `/inventario/compras` | ALMACEN, ADMIN | Ingreso por compra; recalcula CPP. | Sí |
| POST | `/inventario/bajas` | ALMACEN, PRODUCCION | Baja con motivo y trazabilidad (OP/pedido/venta). | Sí |
| POST | `/inventario/ajustes` | ALMACEN, ADMIN | Ajuste positivo/negativo con sustento. | Sí |
| GET | `/inventario/movimientos` | ALMACEN, ADMIN, GERENTE | Movimientos con filtros. | No |
| GET | `/inventario/requisiciones` | ALMACEN, PRODUCCION | Requisiciones de producción. | No |
| POST | `/inventario/requisiciones` | PRODUCCION | Solicitar insumos para una OP. | Sí |
| POST | `/inventario/requisiciones/{id}/atender` | ALMACEN | Atender total/parcial; genera consumo. | Sí |
| POST | `/inventario/tomas` | ALMACEN, ADMIN | Abrir toma de inventario físico. | Sí |
| GET | `/inventario/tomas/{id}` | ALMACEN, ADMIN | Detalle y diferencias. | No |
| POST | `/inventario/tomas/{id}/cerrar` | ALMACEN, ADMIN, GERENTE | Aplicar diferencias como ajustes. | Sí |
| GET | `/inventario/alertas` | ALMACEN, ADMIN, GERENTE | Alertas de stock mínimo y negativos. | No |

### 2.11 Despacho y ventas

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| GET | `/despachos` | VENDEDOR, ADMIN | Pedidos `LISTO` por despachar. | No |
| POST | `/despachos` | VENDEDOR, ADMIN | Generar despacho de uno o más pedidos. | Sí |
| GET | `/despachos/{id}` | VENDEDOR, ADMIN, GERENTE | Detalle del despacho. | No |
| POST | `/despachos/{id}/confirmar` | VENDEDOR | Confirmar entrega; baja producto y cierra pedido. | Sí |
| POST | `/despachos/{id}/rechazar` | VENDEDOR | Rechazo en destino con motivo. | Sí |
| GET | `/ventas` | VENDEDOR, ADMIN, GERENTE | Ventas por canal, fecha, vendedor. | No |
| POST | `/ventas` | VENDEDOR, ADMIN | Venta a terceros o venta directa de mostrador. | Sí |
| GET | `/ventas/{id}` | VENDEDOR, ADMIN, GERENTE | Venta con líneas, costos y pagos. | No |
| POST | `/ventas/{id}/anular` | ADMIN, GERENTE | Anular con reversa de stock y CxC. | Sí |
| GET | `/ventas/{id}/comprobante.pdf` | VENDEDOR, ADMIN | Comprobante interno PDF (no SUNAT). | No |
| POST | `/caja/sesiones` | VENDEDOR, ADMIN | Abrir sesión de caja. | Sí |
| POST | `/caja/sesiones/{id}/cerrar` | VENDEDOR, ADMIN | Cerrar caja con arqueo. | Sí |
| GET | `/caja/sesiones/{id}` | VENDEDOR, ADMIN | Resumen de sesión. | No |

### 2.12 Cobranza

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| GET | `/cuentas-por-cobrar` | VENDEDOR, ADMIN, GERENTE | CxC con saldo, vencimiento y aging. | No |
| GET | `/cuentas-por-cobrar/{id}` | VENDEDOR, ADMIN, GERENTE | Detalle con pagos aplicados. | No |
| GET | `/clientes/{id}/estado-cuenta` | VENDEDOR, ADMIN, PROPIO | Estado de cuenta del cliente. | No |
| POST | `/pagos` | VENDEDOR, ADMIN | Registrar pago total o parcial (efectivo, transferencia, Yape/Plin). | Sí |
| GET | `/pagos` | VENDEDOR, ADMIN, GERENTE | Pagos del período. | No |
| GET | `/pagos/{id}` | VENDEDOR, ADMIN | Detalle del pago. | No |
| POST | `/pagos/{id}/anular` | ADMIN, GERENTE | Anular pago; restituye saldo. | Sí |
| POST | `/cuentas-por-cobrar/{id}/incobrable` | GERENTE | Castigar CxC con sustento. | Sí |
| GET | `/cobranza/cartera` | VENDEDOR | Cartera propia (V-01). | No |
| POST | `/cobranza/recordatorios` | VENDEDOR, ADMIN | Enviar recordatorio push/email. | Sí |

### 2.13 Costeo

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| GET | `/productos/{id}/ficha-costo` | ADMIN, GERENTE | Ficha de costo vigente (insumos, merma, CIF). | No |
| POST | `/productos/{id}/ficha-costo/recalcular` | ADMIN | Recalcular ficha con CPP y CIF vigentes. | Sí |
| GET | `/costeo/ventas/{ventaId}` | GERENTE, ADMIN | Costo, utilidad y margen de una venta (G-06). | No |
| GET | `/costeo/periodos/{id}/resumen` | GERENTE | CIF prorrateado, unidades equivalentes, costo unitario. | No |
| POST | `/costeo/recalculo-masivo` | ADMIN | Recalcular fichas afectadas por cambio de CPP. | Sí |

### 2.14 Reportes (G-01…G-13, V-01…V-02, A-01…A-02, M-01)

Todos comparten el sobre `{ datos, paginacion }` y los filtros `desde`, `hasta`, `categoriaId`,
`productoId`, `clienteId`, `vendedorId`, `sucursalId`.

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| GET | `/reportes/g-01` | GERENTE | Resumen ejecutivo del período con variación. | No |
| GET | `/reportes/g-02` | GERENTE | Rentabilidad por producto + ranking top/bottom 10. | No |
| GET | `/reportes/g-03` | GERENTE | Rentabilidad por categoría. | No |
| GET | `/reportes/g-04` | GERENTE | Rentabilidad por cliente. | No |
| GET | `/reportes/g-05` | GERENTE | Rentabilidad por vendedor y canal. | No |
| GET | `/reportes/g-06` | GERENTE | Margen por venta (detalle auditable). | No |
| GET | `/reportes/g-07` | GERENTE | Estructura de costos: insumos, merma, CIF. | No |
| GET | `/reportes/g-08` | GERENTE | Variación de CPP por insumo e impacto en margen. | No |
| GET | `/reportes/g-09` | GERENTE | Punto de equilibrio y margen de contribución. | No |
| GET | `/reportes/g-10` | GERENTE | Mermas valorizadas por producto y motivo. | No |
| GET | `/reportes/g-11` | GERENTE | Cuentas por cobrar con aging y DSO. | No |
| GET | `/reportes/g-12` | GERENTE | Inventario valorizado, rotación y stock crítico. | No |
| GET | `/reportes/g-13` | GERENTE | Producción planificada vs. real y cumplimiento. | No |
| GET | `/reportes/v-01` | VENDEDOR, GERENTE | Deudas por cobrar del vendedor (aging). | No |
| GET | `/reportes/v-02` | VENDEDOR, GERENTE | Pedidos por cliente con cumplimiento. | No |
| GET | `/reportes/a-01` | ALMACEN, GERENTE | Kárdex valorizado por ítem. | No |
| GET | `/reportes/a-02` | ALMACEN, GERENTE | Stock crítico y reposición sugerida. | No |
| GET | `/reportes/m-01` | ADMIN, GERENTE | Ficha de costo desglosada; `?productoId=` obligatorio. | No |
| POST | `/reportes/{codigo}/exportaciones` | según reporte | Exportar a XLSX/PDF (202 + trabajo). | Sí |
| GET | `/exportaciones/{id}` | según reporte | Estado y URL firmada de descarga. | No |
| GET | `/trabajos/{id}` | según origen | Estado de trabajo asíncrono. | No |

### 2.15 Notificaciones, sync, auditoría, sistema

| Método | Ruta | Rol | Propósito | Idem. |
|---|---|---|---|---|
| GET | `/notificaciones` | todos, PROPIO | Bandeja de notificaciones. | No |
| POST | `/notificaciones/{id}/leida` | PROPIO | Marcar leída. | Sí |
| PUT | `/notificaciones/preferencias` | todos | Canales y eventos suscritos. | Sí |
| POST | `/sync/push` | todos móvil | Enviar lote de operaciones offline. | Sí (por op) |
| GET | `/sync/bootstrap` | todos móvil | Hidratación completa paginada de un dispositivo nuevo. | No |
| GET | `/sync/pull` | todos móvil | Descargar cambios desde cursor. | No |
| GET | `/sync/estado` | todos móvil | Cursor actual, pendientes servidor, versión de esquema. | No |
| GET | `/sync/conflictos` | todos móvil | Conflictos y operaciones rechazadas. | No |
| POST | `/sync/conflictos/{id}/resolver` | PROPIO, ADMIN | Resolver conflicto con decisión explícita. | Sí |
| GET | `/auditoria/eventos` | ADMIN, GERENTE | Consulta de eventos críticos. | No |
| GET | `/auditoria/eventos/{id}` | ADMIN, GERENTE | Evento con cadena de hash verificable. | No |
| GET | `/auditoria/verificacion` | ADMIN | Verificar integridad de la cadena en un rango. | No |
| GET | `/salud` | público | Liveness/readiness (sin datos de negocio). | No |

---

## 3. Máquinas de estado

Reglas transversales: (a) toda transición es **atómica con su evento de auditoría**; (b) toda
transición declara un `motivo` cuando va hacia un estado terminal o de anulación; (c) el estado se
guarda como `text` + `CHECK` (D-04), nunca enum nativo; (d) el historial vive en
`*_estado_historial` y es inmutable (append-only).

### 3.1 Pedido

```mermaid
stateDiagram-v2
    [*] --> REGISTRADO : POST /pedidos
    REGISTRADO --> EN_PRODUCCION : op_vinculada
    REGISTRADO --> ANULADO : anulacion_sin_op
    EN_PRODUCCION --> LISTO : op_terminada_y_stock
    EN_PRODUCCION --> ANULADO : op_cancelada_sin_consumo
    LISTO --> DESPACHADO : despacho_confirmado
    LISTO --> ANULADO : anulacion_gerente
    DESPACHADO --> ENTREGADO : entrega_confirmada
    DESPACHADO --> ANULADO : venta_anulada_y_stock_repuesto
    ENTREGADO --> [*]
    ANULADO --> [*]
```

| # | Transición | Guarda | Quién | Auditoría (`audit.evento.accion`) |
|---|---|---|---|---|
| P1 | ∅ → `REGISTRADO` | Detalle no vacío, `fechaEntrega >= hoy` en `America/Lima`, productos vigentes con precio. | CLIENTE, VENDEDOR, ADMIN | `pedido.creado` |
| P2 | `REGISTRADO → EN_PRODUCCION` | Existe al menos una OP en `EN_PROCESO`/`TERMINADA` que cubre **todo** el detalle del pedido. | PRODUCCION, ADMIN | `pedido.estado_cambiado` |
| P3 | `REGISTRADO → ANULADO` | `motivo` obligatorio; ninguna OP en `EN_PROCESO`. | CLIENTE dueño, VENDEDOR de cartera, ADMIN, GERENTE | `pedido.anulado` |
| P4 | `EN_PRODUCCION → LISTO` | OP que cubre el pedido en `TERMINADA` **y** stock de producto `>=` cantidad pendiente de despacho. | PRODUCCION, ADMIN | `pedido.estado_cambiado` |
| P5 | `EN_PRODUCCION → ANULADO` | Todas las OP asociadas en `CANCELADA`; consumo revertido por ALMACEN. | ADMIN, GERENTE | `pedido.anulado` |
| P6 | `LISTO → DESPACHADO` | Despacho `CONFIRMADO`; baja de producto registrada (`BAJ-*`). | VENDEDOR, ADMIN | `pedido.estado_cambiado` |
| P7 | `LISTO → ANULADO` | `motivo` obligatorio; producto devuelto a stock; solo si no hay despacho confirmado. | GERENTE, ADMIN | `pedido.anulado` |
| P8 | `DESPACHADO → ENTREGADO` | Confirmación de recepción (firma, PIN o aceptación en app). | VENDEDOR | `pedido.estado_cambiado` |
| P9 | `DESPACHADO → ANULADO` | Venta asociada `ANULADA`, stock repuesto y CxC anulada sin pagos. | GERENTE | `pedido.anulado` |

`PATCH /pedidos/{id}` solo es legal en `REGISTRADO`; si el pedido avanzó, `409 PEDIDO_ESTADO_INVALIDO`.
El campo `version` (entero) protege la concurrencia optimista: `PATCH` exige `If-Match: "v3"` o
`409 PEDIDO_VERSION_DESACTUALIZADA`. **Toda anulación respeta el estado; no hay `DELETE`.**

### 3.2 Orden de Producción

```mermaid
stateDiagram-v2
    [*] --> PENDIENTE : POST /ordenes-produccion
    PENDIENTE --> EN_PROCESO : iniciar
    PENDIENTE --> CANCELADA : cancelar_sin_consumo
    EN_PROCESO --> TERMINADA : produccion_registrada
    EN_PROCESO --> CANCELADA : reversa_consumo
    TERMINADA --> CERRADA : costeo_y_stock
    CERRADA --> [*]
    CANCELADA --> [*]
```

| # | Transición | Guarda | Quién | Auditoría |
|---|---|---|---|---|
| O1 | ∅ → `PENDIENTE` | Receta **publicada** vigente; `cantidadPlanificada > 0`; requerimiento calculado con CPP vigente. | PRODUCCION, ADMIN | `op.generada` |
| O2 | `PENDIENTE → EN_PROCESO` | Requisición atendida **o** insumos suficientes en stock; ningún insumo con déficit > 0 sin confirmación de Almacén. | PRODUCCION | `op.iniciada` |
| O3 | `EN_PROCESO → TERMINADA` | `SUM(consumos) > 0`; `cantidadProducida + mermaTotal` dentro de tolerancia (±5 %) de `cantidadPlanificada` o `motivoDesvio` obligatorio; cada merma con `tipo` y `motivo`. | PRODUCCION | `op.produccion_registrada` |
| O4 | `TERMINADA → CERRADA` | Ingreso de producto terminado a stock registrado **y** ficha de costo recalculada. Job `op-cerrar` lo intenta; si falla queda en `TERMINADA` con alerta. | PRODUCCION, ADMIN, sistema | `op.cerrada` |
| O5 | `PENDIENTE → CANCELADA` | Sin consumo registrado. | ADMIN, GERENTE | `op.cancelada` |
| O6 | `EN_PROCESO → CANCELADA` | Reversa de consumo (`ajuste_inventario` compensatorio) firmada por ALMACEN. | GERENTE | `op.cancelada` |
| O7 | `TERMINADA → CANCELADA` | **Prohibido.** Corregir con ajuste de inventario y merma. | — | — |

Una OP puede cubrir **varios pedidos** y **varios productos** (`op_detalle`); el vínculo con el
pedido se guarda en `op_detalle.pedido_detalle_id` para trazabilidad fina (§3.2 de la propuesta).

### 3.3 Venta

```mermaid
stateDiagram-v2
    [*] --> EMITIDA : POST /ventas
    EMITIDA --> PAGADA : saldo_cero
    EMITIDA --> EMITIDA : pago_parcial
    EMITIDA --> ANULADA : anular_sin_pagos
    PAGADA --> ANULADA : anular_con_nota_interna
    PAGADA --> [*]
    ANULADA --> [*]
```

| # | Transición | Guarda | Quién | Auditoría |
|---|---|---|---|---|
| V1 | ∅ → `EMITIDA` | Líneas > 0; precios ≥ 0; descuento ≤ `parametro.descuentoMaximoVendedor` o autorización explícita; stock disponible (o `permitirStockNegativo` para insumos, nunca para productos). | VENDEDOR, ADMIN | `venta.emitida` |
| V2 | ∅ → `PAGADA` | Pago total al emitir (efectivo/transferencia/Yape). Se registra `pago` en la misma transacción. | VENDEDOR, ADMIN | `venta.emitida`, `pago.registrado` |
| V3 | `EMITIDA → EMITIDA` | Pago parcial: reduce saldo, abre/actualiza CxC en `PARCIAL`. | VENDEDOR, ADMIN | `pago.registrado` |
| V4 | `EMITIDA → PAGADA` | Última aplicación de pago deja saldo `0.0000`. Disparado por `cobranza`. | VENDEDOR, ADMIN (vía pago) | `cxc.estado_cambiado` |
| V5 | `EMITIDA → ANULADA` | Sin pagos aplicados; stock repuesto vía `baja_inventario` inverso; `motivo` obligatorio. | ADMIN, GERENTE | `venta.anulada` |
| V6 | `PAGADA → ANULADA` | Nota interna + devolución de efectivo registrada; CxC (si existe) anulada. | GERENTE | `venta.anulada` |

Cada línea de venta congela `precioUnitarioConIgv`, `precioUnitarioNeto`, `costoUnitario` y
`costoTotalLinea` **en el momento de la venta** (principio de diseño de §4.4 de la propuesta). El
costo histórico nunca se recalcula hacia atrás; si el CPP cambia después, se emite
`cpp.recalculado` y solo afecta fichas de costo futuras.

### 3.4 Cuenta por Cobrar

```mermaid
stateDiagram-v2
    [*] --> PENDIENTE : venta_a_credito
    PENDIENTE --> PARCIAL : pago_parcial
    PENDIENTE --> PAGADA : pago_total
    PENDIENTE --> VENCIDA : job_vencimiento
    PARCIAL --> PAGADA : saldo_cero
    PARCIAL --> VENCIDA : job_vencimiento
    VENCIDA --> PARCIAL : pago_parcial
    VENCIDA --> PAGADA : pago_total
    VENCIDA --> INCOBRABLE : castigo_gerente
    INCOBRABLE --> PARCIAL : recupero
    PENDIENTE --> ANULADA : venta_anulada
    PARCIAL --> ANULADA : anulacion_autorizada
    VENCIDA --> ANULADA : anulacion_autorizada
    PAGADA --> [*]
    ANULADA --> [*]
    INCOBRABLE --> [*]
```

| # | Transición | Guarda | Quién | Auditoría |
|---|---|---|---|---|
| C1 | ∅ → `PENDIENTE` | Venta a crédito o saldo > 0; `fechaVencimiento = fechaVenta + diasCredito` (`date`, no timestamp). | sistema (por `venta.emitida`) | `cxc.creada` |
| C2 | `PENDIENTE/PARCIAL/VENCIDA → PARCIAL` | `0 < montoPago < saldo`; medio de pago válido; `referencia` obligatoria para Yape/Plin/transferencia. | VENDEDOR, ADMIN | `pago.registrado` |
| C3 | `* → PAGADA` | `saldo = 0.0000` exacto (comparación decimal, no épsilon). | VENDEDOR, ADMIN | `cxc.estado_cambiado` |
| C4 | `PENDIENTE/PARCIAL → VENCIDA` | Job diario 00:15 `America/Lima`: `hoy > fechaVencimiento` y `saldo > 0`. | sistema | `cxc.vencida` |
| C5 | `VENCIDA → INCOBRABLE` | `sustento` obligatorio y `diasVencido >= 90` o decisión de Gerencia. | GERENTE | `cxc.castigada` |
| C6 | `* → ANULADA` | Sin pagos aplicados, o anulación autorizada con reversa de pagos. | ADMIN, GERENTE | `cxc.anulada` |

El aging (0–7, 8–15, 16–30, >30 días) **no** se guarda como estado: se calcula en
`report.cartera_aging` con `fechaVencimiento` y `America/Lima`, evitando un job que reescriba filas.

---

## 4. Contrato de error — RFC 9457

`Content-Type: application/problem+json`. Miembros obligatorios: `type`, `title`, `status`,
`detail`, `instance`, `codigo`. Extensiones: `requestId`, `timestamp`, `errores[]` (solo validación),
`reintentable` (booleano, indica si el cliente puede reintentar tal cual).

```json
{
  "type": "https://api.tantapanaderia.com/errors/pedido-estado-invalido",
  "title": "Transición de estado no permitida",
  "status": 409,
  "detail": "El pedido PED-2026-000123 está en estado ENTREGADO y no admite la transición a EN_PRODUCCION.",
  "instance": "/api/v1/pedidos/0192f0c4-8f3a-7c21-9a51-3b2f9c1d4e60/confirmar",
  "codigo": "PEDIDO_ESTADO_INVALIDO",
  "requestId": "req_01JB7Z9K3M8Q2V",
  "timestamp": "2026-11-01T14:03:22.184-05:00",
  "reintentable": false,
  "errores": [
    { "campo": "estadoActual", "codigo": "VALOR_NO_PERMITIDO", "detalle": "Se esperaba REGISTRADO." }
  ]
}
```

`codigo` es **estable y aditivo**: se agregan códigos nuevos, nunca se renombran ni se reutilizan con
otro significado. La app mapea por `codigo`, jamás por `title` ni por el texto de `detail`.

| Grupo | `codigo` | HTTP | Significado |
|---|---|---|---|
| Genérico | `SOLICITUD_INVALIDA` | 400 | Cuerpo o query malformados. |
| | `VALIDACION_FALLIDA` | 422 | Reglas de campo; trae `errores[]`. |
| | `NO_AUTENTICADO` | 401 | Token ausente o expirado. |
| | `TOKEN_INVALIDO` | 401 | Firma o claims inválidos. |
| | `SIN_PERMISO` | 403 | Rol sin el permiso requerido. |
| | `FUERA_DE_ALCANCE` | 403 | Recurso existe pero no pertenece al usuario (scoping D-07). |
| | `RECURSO_NO_ENCONTRADO` | 404 | ID inexistente o borrado lógico. |
| | `RUTA_NO_ENCONTRADA` | 404 | Endpoint inexistente. |
| | `METODO_NO_PERMITIDO` | 405 | Verbo incorrecto. |
| | `CONFLICTO_CONCURRENTE` | 409 | Choque de bloqueo; reintentar. |
| | `LIMITE_TASA_EXCEDIDO` | 429 | Cuota agotada; incluye `Retry-After`. |
| | `ERROR_INTERNO` | 500 | Fallo no clasificado (Sentry). |
| | `SERVICIO_NO_DISPONIBLE` | 503 | BD o dependencia caída. |
| | `TIEMPO_AGOTADO` | 504 | Presupuesto de la petición excedido. |
| | `CLIENTE_DESACTUALIZADO` | 426 | Versión mínima de app no cumplida. |
| Idempotencia | `IDEMPOTENCY_KEY_REQUERIDA` | 400 | Falta la cabecera en una mutación. |
| | `IDEMPOTENCY_KEY_INVALIDA` | 400 | No es UUIDv7. |
| | `IDEMPOTENCIA_EN_CURSO` | 409 | Misma clave en ejecución; `Retry-After: 1`. |
| | `IDEMPOTENCIA_CLAVE_REUTILIZADA` | 422 | Clave ya usada con otro cuerpo. |
| Auth | `CREDENCIALES_INVALIDAS` | 401 | Usuario o contraseña incorrectos. |
| | `CUENTA_BLOQUEADA` | 403 | Bloqueo por intentos o por Admin. |
| | `MFA_REQUERIDO` | 401 | Falta segundo factor. |
| | `MFA_CODIGO_INVALIDO` | 401 | TOTP incorrecto o reutilizado. |
| | `REFRESH_TOKEN_REUSADO` | 401 | Reuso detectado; sesión revocada. |
| | `REFRESH_TOKEN_EXPIRADO` | 401 | 30 días cumplidos. |
| | `PASSWORD_DEBIL` | 422 | Política de contraseña. |
| | `DISPOSITIVO_REVOCADO` | 401 | `deviceId` dado de baja. |
| Pedidos | `PEDIDO_ESTADO_INVALIDO` | 409 | Transición no permitida. |
| | `PEDIDO_VERSION_DESACTUALIZADA` | 409 | `If-Match` no coincide. |
| | `PEDIDO_FUERA_DE_PLAZO` | 422 | `fechaEntrega` anterior al día operativo. |
| | `PEDIDO_SIN_DETALLE` | 422 | Cero líneas. |
| | `PEDIDO_YA_EN_PRODUCCION` | 409 | Edición bloqueada por OP iniciada. |
| | `PEDIDO_YA_ANULADO` | 409 | Anulación repetida. |
| Producción | `OP_ESTADO_INVALIDO` | 409 | Transición no permitida. |
| | `OP_SIN_RECETA_VIGENTE` | 422 | Producto sin receta publicada. |
| | `OP_INSUMOS_INSUFICIENTES` | 422 | Requerimiento > stock; trae faltantes. |
| | `OP_CANTIDAD_INCONSISTENTE` | 422 | Producido + merma fuera de tolerancia sin motivo. |
| | `OP_CONSUMO_NO_REGISTRADO` | 422 | Cierre sin consumo. |
| | `OP_YA_CERRADA` | 409 | Intento de modificar OP `CERRADA`. |
| Inventario | `STOCK_INSUFICIENTE` | 409 | Saldo insuficiente en una operación **online** verificada; trae `faltante`. Las operaciones offline ya ocurridas se aceptan con alerta (`09` §7). |
| | `ITEM_INEXISTENTE` | 404 | `itemId` no corresponde a insumo ni producto. |
| | `BAJA_SIN_MOTIVO` | 422 | Baja sin `motivo` (obligatorio por auditoría). |
| | `BAJA_SIN_ORIGEN` | 422 | Baja sin OP/pedido/venta asociada. |
| | `CPP_NO_DETERMINABLE` | 422 | Compra con costo 0 y stock 0. |
| | `TOMA_INVENTARIO_ABIERTA` | 409 | Ya existe toma en curso. |
| Ventas | `VENTA_ESTADO_INVALIDO` | 409 | Anulación no permitida. |
| | `VENTA_SIN_LINEAS` | 422 | Cero líneas. |
| | `DESCUENTO_NO_AUTORIZADO` | 403 | Descuento > máximo del rol. |
| | `PRECIO_NO_VIGENTE` | 422 | `productoPrecioId` no vigente a la fecha. |
| | `VENTA_MONTO_CERO` | 422 | Total ≤ 0. |
| Cobranza | `PAGO_EXCEDE_SALDO` | 422 | `monto > saldo` de la CxC. |
| | `PAGO_MONTO_INVALIDO` | 422 | `monto <= 0`. |
| | `PAGO_MEDIO_INVALIDO` | 422 | Medio fuera del catálogo. |
| | `PAGO_REFERENCIA_REQUERIDA` | 422 | Yape/Plin/transferencia sin referencia. |
| | `CXC_ESTADO_INVALIDO` | 409 | Transición no permitida. |
| | `CXC_YA_PAGADA` | 409 | Pago sobre cuenta cerrada. |
| | `CXC_CON_PAGOS` | 409 | Anulación con pagos aplicados. |
| Costeo | `RECETA_VERSION_NO_PUBLICADA` | 422 | Se intentó producir con borrador. |
| | `PERIODO_CERRADO` | 409 | Recálculo sobre período cerrado. |
| | `CIF_SIN_BASE_PRORRATEO` | 422 | Costo indirecto sin base. |
| | `FICHA_COSTO_INCOMPLETA` | 422 | Insumo sin CPP o receta sin rendimiento. |
| Reportes | `REPORTE_DESCONOCIDO` | 404 | Código fuera de G/V/A/M. |
| | `RANGO_FECHAS_EXCEDIDO` | 422 | Rango > 366 días. |
| | `EXPORTACION_EN_CURSO` | 409 | Misma exportación pedida dos veces. |
| Sync | `OP_DUPLICADA` | 200 (por op) | Duplicado por idempotencia devuelto en lote. |
| | `SYNC_LOTE_EXCEDIDO` | 413 | Más de 500 operaciones. |
| | `SYNC_ESQUEMA_DESCONOCIDO` | 422 | `esquemaVersion` no soportado. |
| | `SYNC_CONFLICTO_VERSION` | 409 | `baseVersion` obsoleta (ver `09`). |
| | `CURSOR_INVALIDO` | 400 | Cursor manipulado o de otros filtros. |
| | `CURSOR_EXPIRADO` | 410 | Cursor más viejo que la retención (90 días). |

---

## 5. Idempotencia

### 5.1 Tabla

```sql
CREATE TABLE core.idempotencia (
  id                 uuid PRIMARY KEY,
  idempotency_key    uuid        NOT NULL,
  usuario_id         uuid        NOT NULL REFERENCES core.usuario (id),
  metodo             text        NOT NULL,
  ruta               text        NOT NULL,
  huella_solicitud   text        NOT NULL,
  estado             text        NOT NULL
                     CHECK (estado IN ('EN_CURSO','COMPLETADA','FALLIDA')),
  codigo_respuesta   integer,
  respuesta          jsonb,
  recurso_id         uuid,
  creado_en          timestamptz NOT NULL DEFAULT now(),
  expira_en          timestamptz NOT NULL,
  CONSTRAINT uq_idempotencia_clave UNIQUE (usuario_id, idempotency_key)
);

CREATE INDEX ix_idempotencia_expira ON core.idempotencia (expira_en);
```

`huella_solicitud = sha256(metodo || ruta || cuerpoNormalizado)`, donde el cuerpo se normaliza
(claves ordenadas, decimales canónicos, sin espacios) para que dos reenvíos idénticos produzcan la
misma huella.

### 5.2 Algoritmo

1. **Reserva (transacción corta).** `INSERT ... ON CONFLICT (usuario_id, idempotency_key) DO NOTHING RETURNING id`.
   *Inserta* → seguimos al paso 2. *No inserta* → paso 3.
2. **Ejecución.** El handler corre en su propia transacción, que **incluye**
   `UPDATE core.idempotencia SET estado='COMPLETADA', codigo_respuesta=$1, respuesta=$2, recurso_id=$3`.
   El `COMMIT` de negocio y el ACK de idempotencia son el mismo acto atómico: no existe ventana en
   que el negocio se aplicó pero la clave quedó libre.
3. **Reintento.** Se lee la fila existente:
   - `estado = 'COMPLETADA'` y `huella` igual → se devuelve la respuesta almacenada con
     `200/201` original y cabecera `Idempotency-Replayed: true`.
   - `estado = 'COMPLETADA'` y `huella` distinta → `422 IDEMPOTENCIA_CLAVE_REUTILIZADA`.
   - `estado = 'EN_CURSO'` → `409 IDEMPOTENCIA_EN_CURSO` con `Retry-After: 1`.
   - `estado = 'FALLIDA'` (5xx previo) → se reintenta la ejecución reutilizando la fila
     (`UPDATE ... SET estado='EN_CURSO'`).
4. **Errores 4xx de negocio** se almacenan como `COMPLETADA` con su `codigo_respuesta` (409/422):
   el reintento devuelve el mismo error, nunca un efecto distinto. Los **5xx** se marcan `FALLIDA`
   para permitir reintento limpio.

### 5.3 Concurrencia

La unicidad la garantiza la **restricción**, no un `SELECT` previo: dos peticiones simultáneas con la
misma clave chocan en `uq_idempotencia_clave`; una gana y la otra cae en el paso 3. No se usan
`advisory locks` (bloquean conexiones del pool). El registro de reserva se escribe en autocommit
antes de la transacción de negocio, de modo que el `INSERT` que pierde la carrera ve el estado real
(`EN_CURSO`), no un hueco.

### 5.4 TTL y limpieza

| Tipo de endpoint | TTL |
|---|---|
| Mutaciones de negocio estándar | 24 h |
| `POST /sync/push` (por `opId`) | 90 días (retención en `sync_operacion`) |
| `POST /pagos`, `POST /ventas` | 72 h |
| `POST /auth/*` | 1 h |

Job pg-boss `idempotencia-purga`, cada hora, lotes de 10 000:
`DELETE FROM core.idempotencia WHERE expira_en < now() - interval '1 hour' LIMIT 10000;`

---

## 6. Paginación por cursor (keyset)

### 6.1 Diseño del cursor

Cursor **opaco** = `base64url( payload ) || "." || base64url( hmac_sha256(payload)[0:16] )`.

```json
{ "k": ["2026-11-01T19:03:22.184Z", "0192f0c4-8f3a-7c21-9a51-3b2f9c1d4e60"],
  "o": -1,
  "f": "e3b0c44298fc1c14",
  "s": 1 }
```

- `k`: valores de la clave de ordenamiento del último elemento devuelto. Orden por defecto
  `(creado_en DESC, id DESC)`; en reportes `(fecha DESC, id DESC)`.
- `o`: `1` ascendente, `-1` descendente.
- `f`: huella de los filtros + `limit` (`sha256` truncado). Reusar un cursor con otros filtros →
  `400 CURSOR_INVALIDO`. Evita el bug clásico de "página 2 con otro filtro".
- `s`: versión del esquema del cursor; permite migrar sin romper clientes viejos.

Predicado keyset en PostgreSQL (sin `OFFSET`, índice `(creado_en DESC, id DESC)`):

```sql
SELECT * FROM core.pedido
WHERE sucursal_id = $1
  AND (creado_en, id) < ($2::timestamptz, $3::uuid)
ORDER BY creado_en DESC, id DESC
LIMIT $4 + 1;   -- +1 para saber si hay más sin COUNT(*)
```

`paginacion.totalAproximado` solo se incluye en reportes, y sale de `report.*` (nunca de `COUNT(*)`
sobre tablas grandes). Máximo `limit = 100`; default `25`; `limit` fuera de rango → `400`
`VALIDACION_FALLIDA`.

### 6.2 Ejemplo

```http
GET /api/v1/pedidos?estado=REGISTRADO&desde=2026-11-01&limit=2 HTTP/1.1
Host: www.tantapanaderia.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

```json
{
  "datos": [
    {
      "id": "0192f0c4-8f3a-7c21-9a51-3b2f9c1d4e60",
      "codigo": "PED-2026-000123",
      "clienteId": "0192f0b1-6a10-7d33-8f21-9c4b2a1e0001",
      "clienteNombre": "Bodega San Martín",
      "estado": "REGISTRADO",
      "fechaEntrega": "2026-11-03",
      "total": "354.0000",
      "moneda": "PEN",
      "creadoEn": "2026-11-01T19:03:22.184Z",
      "version": 3
    },
    {
      "id": "0192f0c1-2b77-7a02-9e64-0d1c8f3a5b22",
      "codigo": "PED-2026-000122",
      "clienteId": "0192f0b1-6a10-7d33-8f21-9c4b2a1e0002",
      "clienteNombre": "Cafetería El Molino",
      "estado": "REGISTRADO",
      "fechaEntrega": "2026-11-02",
      "total": "128.5000",
      "moneda": "PEN",
      "creadoEn": "2026-11-01T18:44:07.912Z",
      "version": 1
    }
  ],
  "paginacion": {
    "siguienteCursor": "eyJrIjpbIjIwMjYtMTEtMDFUMTg6NDQ6MDcuOTEyWiIsIjAxOTJmMGMxLTJiNzctN2EwMi05ZTY0LTBkMWM4ZjNhNWIyMiJdLCJvIjotMSwiZiI6IjRjMWQyIn0.7f9c1a02b3d84e51",
    "hayMas": true,
    "limite": 2
  }
}
```

---

## 7. Versionado y evolución

- **Prefijo de versión mayor `v1` en la ruta.** Todo lo que agregue campos opcionales o endpoints
  nuevos se publica **dentro de v1** sin subir versión.
- **Cambio incompatible** = quitar o renombrar un campo, cambiar su tipo, hacerlo obligatorio,
  alterar la semántica de un `codigo` de error, o cambiar el formato de fecha/decimal. Eso exige
  `/api/v2`; v1 sigue congelada y mantenida **12 meses** con correcciones de seguridad.
- **Aditivo** (no rompe): nuevo endpoint, nuevo campo opcional en respuesta, nuevo valor en un
  catálogo que el cliente ya trata como abierto (`estado`, `motivo`), nuevo `codigo` de error.
  Los clientes están obligados a ignorar campos desconocidos (*lenient parsing*).
- **Deprecación:** el endpoint responde con `Deprecation: @1767225600` (RFC 9745) y
  `Sunset: Tue, 01 Dec 2026 00:00:00 GMT` (RFC 8594) y `Link: <.../v2/...>; rel="successor-version"`.
  La web avisa en consola; la app muestra banner solo si la versión está en `sunset` a menos de 60 días.
- **Piso de versión móvil.** `GET /salud` y cada respuesta incluyen `X-Api-Version: 1.14.2`. Si la app
  envía `X-Client-Version` por debajo del mínimo soportado, el servidor responde
  `426 CLIENTE_DESACTUALIZADO` con `actualizacionRequerida: true`. La app **no** puede quedar
  desactualizada contra un esquema de sync cambiado (ver `09` §9).
- **Esquema de sync versionado aparte:** `sync.pull` devuelve `esquemaVersion` (entero). Un
  dispositivo con esquema menor recibe `422 SYNC_ESQUEMA_DESCONOCIDO` y debe actualizarse antes de
  empujar operaciones.

---

## 8. Ejemplos de request/response

### 8.1 Crear pedido (Cliente)

```http
POST /api/v1/pedidos HTTP/1.1
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Idempotency-Key: 0192f0c4-8f3a-7c21-9a51-3b2f9c1d4e60
Content-Type: application/json
```

```json
{
  "clienteId": "0192f0b1-6a10-7d33-8f21-9c4b2a1e0001",
  "sucursalId": "0192f0a0-0000-7000-8000-000000000001",
  "fechaEntrega": "2026-11-03",
  "horaEntrega": "08:30",
  "modalidad": "RECOJO",
  "prioridad": "NORMAL",
  "observaciones": "Sin ajonjolí en la mitad de la bandeja.",
  "detalle": [
    { "productoId": "0192f0c8-1111-7a11-8b11-111111111111", "cantidad": "40" },
    { "productoId": "0192f0c8-2222-7a22-8b22-222222222222", "cantidad": "12",
      "personalizacion": "Cumpleaños, dedicatoria 'Feliz día mamá'" }
  ]
}
```

`201 Created` · `Location: /api/v1/pedidos/0192f0c4-...` · `ETag: "v1"`

```json
{
  "id": "0192f0c4-8f3a-7c21-9a51-3b2f9c1d4e60",
  "codigo": "PED-2026-000123",
  "estado": "REGISTRADO",
  "clienteId": "0192f0b1-6a10-7d33-8f21-9c4b2a1e0001",
  "sucursalId": "0192f0a0-0000-7000-8000-000000000001",
  "fechaEntrega": "2026-11-03",
  "horaEntrega": "08:30",
  "modalidad": "RECOJO",
  "prioridad": "NORMAL",
  "detalle": [
    {
      "id": "0192f0c5-0001-7b01-9c01-000000000001",
      "productoId": "0192f0c8-1111-7a11-8b11-111111111111",
      "productoNombre": "Pan ciabatta",
      "cantidad": "40.000000",
      "precioUnitarioConIgv": "2.3600",
      "descuento": "0.0000",
      "subtotalConIgv": "94.4000",
      "subtotalNeto": "80.0000",
      "igv": "14.4000"
    },
    {
      "id": "0192f0c5-0002-7b02-9c02-000000000002",
      "productoId": "0192f0c8-2222-7a22-8b22-222222222222",
      "productoNombre": "Torta de chocolate",
      "cantidad": "12.000000",
      "precioUnitarioConIgv": "45.0000",
      "descuento": "0.0000",
      "subtotalConIgv": "540.0000",
      "subtotalNeto": "457.6271",
      "igv": "82.3729",
      "personalizacion": "Cumpleaños, dedicatoria 'Feliz día mamá'"
    }
  ],
  "totales": {
    "subtotalNeto": "537.6271",
    "igv": "96.7729",
    "totalConIgv": "634.4000",
    "descuentoTotal": "0.0000"
  },
  "moneda": "PEN",
  "version": 1,
  "creadoEn": "2026-11-01T14:03:22.184-05:00",
  "creadoPor": "0192f0aa-3333-7c33-8d33-333333333333"
}
```

### 8.2 Generar OP (Producción)

```http
POST /api/v1/ordenes-produccion HTTP/1.1
Idempotency-Key: 0192f0d1-4c22-7e10-9b77-4a5d1e2f3c40
```

```json
{
  "sucursalId": "0192f0a0-0000-7000-8000-000000000001",
  "fechaProduccion": "2026-11-02",
  "turno": "MADRUGADA",
  "observaciones": "Hornada 1 de 2.",
  "detalle": [
    {
      "productoId": "0192f0c8-1111-7a11-8b11-111111111111",
      "recetaVersionId": "0192f0c7-4444-7d44-8e44-444444444444",
      "cantidadPlanificada": "60.000000",
      "pedidos": [
        { "pedidoId": "0192f0c4-8f3a-7c21-9a51-3b2f9c1d4e60",
          "pedidoDetalleId": "0192f0c5-0001-7b01-9c01-000000000001" }
      ]
    }
  ]
}
```

`201 Created`

```json
{
  "id": "0192f0d2-77aa-7f01-8a01-000000000045",
  "codigo": "OP-2026-000045",
  "estado": "PENDIENTE",
  "fechaProduccion": "2026-11-02",
  "turno": "MADRUGADA",
  "detalle": [
    {
      "id": "0192f0d3-0001-7a01-8b01-000000000001",
      "productoId": "0192f0c8-1111-7a11-8b11-111111111111",
      "productoNombre": "Pan ciabatta",
      "recetaVersionId": "0192f0c7-4444-7d44-8e44-444444444444",
      "rendimientoReceta": "100.000000",
      "cantidadPlanificada": "60.000000",
      "requerimiento": [
        { "insumoId": "0192f0b5-5555-7a55-8b55-555555555555",
          "insumoNombre": "Harina sin preparar",
          "unidadMedida": "KG",
          "cantidadRequerida": "36.000000",
          "cantidadDisponible": "52.500000",
          "suficiente": true,
          "cppVigente": "3.850000",
          "costoEstimado": "138.600000" },
        { "insumoId": "0192f0b5-6666-7a66-8b66-666666666666",
          "insumoNombre": "Levadura fresca",
          "unidadMedida": "KG",
          "cantidadRequerida": "0.900000",
          "cantidadDisponible": "0.400000",
          "suficiente": false,
          "faltante": "0.500000",
          "cppVigente": "12.400000",
          "costoEstimado": "11.160000" }
      ]
    }
  ],
  "insumosFaltantes": 1,
  "creadoEn": "2026-11-01T14:10:05.001-05:00"
}
```

### 8.3 Registrar producción con merma (tablet)

```http
POST /api/v1/ordenes-produccion/0192f0d2-77aa-7f01-8a01-000000000045/produccion HTTP/1.1
Idempotency-Key: 0192f0d9-8e11-7c22-9d22-000000000777
```

```json
{
  "detalle": [
    {
      "opDetalleId": "0192f0d3-0001-7a01-8b01-000000000001",
      "cantidadProducida": "55.000000",
      "mermas": [
        { "tipo": "PROCESO", "cantidad": "3.000000",
          "motivo": "Horneado desparejo, primera bandeja",
          "insumoId": null },
        { "tipo": "PRODUCTO_TERMINADO", "cantidad": "2.000000",
          "motivo": "Rotura al desmoldar", "insumoId": null }
      ],
      "consumos": [
        { "insumoId": "0192f0b5-5555-7a55-8b55-555555555555", "cantidadConsumida": "36.500000" },
        { "insumoId": "0192f0b5-6666-7a66-8b66-666666666666", "cantidadConsumida": "0.950000" }
      ]
    }
  ],
  "observaciones": "Se completó el faltante de levadura con 0.5 kg de otra marca.",
  "ocurreEn": "2026-11-02T04:52:11.000-05:00"
}
```

`201 Created`

```json
{
  "id": "0192f0d2-77aa-7f01-8a01-000000000045",
  "codigo": "OP-2026-000045",
  "estado": "TERMINADA",
  "detalle": [
    {
      "opDetalleId": "0192f0d3-0001-7a01-8b01-000000000001",
      "cantidadPlanificada": "60.000000",
      "cantidadProducida": "55.000000",
      "mermaTotal": "5.000000",
      "desvioPorcentaje": "0.000000",
      "toleranciaAplicada": "0.050000"
    }
  ],
  "movimientosInventario": [
    { "id": "0192f0da-0001-7a01-8b01-000000000101", "codigo": "BAJ-2026-000201",
      "itemTipo": "INSUMO", "itemId": "0192f0b5-5555-7a55-8b55-555555555555",
      "cantidad": "-36.500000", "saldoResultante": "16.000000", "costoUnitario": "3.850000" },
    { "id": "0192f0da-0002-7a01-8b01-000000000102", "codigo": "BAJ-2026-000202",
      "itemTipo": "INSUMO", "itemId": "0192f0b5-6666-7a66-8b66-666666666666",
      "cantidad": "-0.950000", "saldoResultante": "-0.550000", "costoUnitario": "12.400000",
      "alerta": "STOCK_NEGATIVO" },
    { "id": "0192f0da-0003-7a01-8b01-000000000103", "codigo": "AJU-2026-000044",
      "itemTipo": "PRODUCTO", "itemId": "0192f0c8-1111-7a11-8b11-111111111111",
      "cantidad": "55.000000", "saldoResultante": "55.000000", "costoUnitario": "0.900000" }
  ],
  "mermaValorizada": "6.550000",
  "actualizadoEn": "2026-11-02T04:52:11.882-05:00"
}
```

### 8.4 Registrar venta a terceros (Vendedor, al crédito)

```http
POST /api/v1/ventas HTTP/1.1
Idempotency-Key: 0192f0e2-1a33-7b44-8c55-000000000888
```

```json
{
  "sucursalId": "0192f0a0-0000-7000-8000-000000000001",
  "sesionCajaId": "0192f0e0-9999-7a99-8b99-999999999999",
  "canal": "TERCERO",
  "clienteId": null,
  "tercero": {
    "nombre": "Sra. Rosa Quispe",
    "documento": "09876543",
    "telefono": "987654321"
  },
  "fechaVenta": "2026-11-02",
  "formaPago": "CREDITO",
  "diasCredito": 15,
  "observaciones": "Reparto en puesto 14 del mercado.",
  "detalle": [
    { "productoId": "0192f0c8-1111-7a11-8b11-111111111111", "cantidad": "30",
      "precioUnitarioConIgv": "2.3600", "descuentoPorcentaje": "0.050000" },
    { "productoId": "0192f0c8-3333-7a33-8b33-333333333333", "cantidad": "10",
      "precioUnitarioConIgv": "8.0000", "descuentoPorcentaje": "0.000000" }
  ]
}
```

`201 Created`

```json
{
  "id": "0192f0e3-4b55-7c66-9d77-000000000789",
  "codigo": "VTA-2026-000789",
  "estado": "EMITIDA",
  "canal": "TERCERO",
  "clienteId": null,
  "terceroNombre": "Sra. Rosa Quispe",
  "vendedorId": "0192f0aa-7777-7d77-8e77-777777777777",
  "sesionCajaId": "0192f0e0-9999-7a99-8b99-999999999999",
  "detalle": [
    { "productoId": "0192f0c8-1111-7a11-8b11-111111111111",
      "cantidad": "30.000000",
      "precioUnitarioConIgv": "2.3600",
      "precioUnitarioNeto": "2.0000",
      "descuento": "3.5400",
      "subtotalConIgv": "67.2600",
      "subtotalNeto": "57.0000",
      "costoUnitario": "0.900000",
      "costoTotalLinea": "27.000000",
      "utilidadLinea": "30.0000",
      "margenLinea": "0.526316" },
    { "productoId": "0192f0c8-3333-7a33-8b33-333333333333",
      "cantidad": "10.000000",
      "precioUnitarioConIgv": "8.0000",
      "precioUnitarioNeto": "6.7797",
      "descuento": "0.0000",
      "subtotalConIgv": "80.0000",
      "subtotalNeto": "67.7966",
      "costoUnitario": "4.100000",
      "costoTotalLinea": "41.000000",
      "utilidadLinea": "26.7966",
      "margenLinea": "0.395061" }
  ],
  "totales": {
    "subtotalNeto": "124.7966",
    "igv": "22.4634",
    "totalConIgv": "147.2600",
    "costoVentas": "68.0000",
    "utilidadBruta": "56.7966",
    "margenPorcentaje": "0.455105"
  },
  "cuentaPorCobrar": {
    "id": "0192f0e4-5c66-7d77-8e88-000000000321",
    "codigo": "CXC-2026-000321",
    "estado": "PENDIENTE",
    "saldo": "147.2600",
    "fechaVencimiento": "2026-11-17"
  },
  "comprobanteInterno": {
    "numero": "CI-2026-000789",
    "urlPdf": null,
    "nota": "Documento interno. No es comprobante electrónico SUNAT."
  },
  "emitidaEn": "2026-11-02T09:14:33.207-05:00"
}
```

### 8.5 Registrar cobranza parcial (Yape con referencia)

```http
POST /api/v1/pagos HTTP/1.1
Idempotency-Key: 0192f0ea-6d77-7e88-9f99-000000000444
```

```json
{
  "cuentaPorCobrarId": "0192f0e4-5c66-7d77-8e88-000000000321",
  "monto": "100.0000",
  "fechaPago": "2026-11-05",
  "medio": "YAPE",
  "referencia": "YP-778812-20261105",
  "observaciones": "Pago parcial acordado con la Sra. Rosa."
}
```

`201 Created`

```json
{
  "id": "0192f0eb-7e88-7f99-8a00-000000000555",
  "codigo": "PAG-2026-000045",
  "cuentaPorCobrarId": "0192f0e4-5c66-7d77-8e88-000000000321",
  "monto": "100.0000",
  "medio": "YAPE",
  "referencia": "YP-778812-20261105",
  "fechaPago": "2026-11-05",
  "aplicaciones": [
    { "ventaId": "0192f0e3-4b55-7c66-9d77-000000000789",
      "aplicado": "100.0000",
      "saldoVentaAntes": "147.2600",
      "saldoVentaDespues": "47.2600" }
  ],
  "cuentaPorCobrar": {
    "id": "0192f0e4-5c66-7d77-8e88-000000000321",
    "estado": "PARCIAL",
    "saldoAnterior": "147.2600",
    "saldo": "47.2600",
    "fechaVencimiento": "2026-11-17",
    "diasVencido": 0
  },
  "registradoEn": "2026-11-05T16:22:18.004-05:00"
}
```

### 8.6 Consultar dashboard G-01

```http
GET /api/v1/reportes/g-01?desde=2026-11-01&hasta=2026-11-30&comparar=PERIODO_ANTERIOR&vendedorId=0192f0aa-7777-7d77-8e77-777777777777 HTTP/1.1
```

```json
{
  "datos": [
    {
      "codigo": "G-01",
      "titulo": "Resumen ejecutivo del período",
      "periodo": { "desde": "2026-11-01", "hasta": "2026-11-30", "dias": 30 },
      "moneda": "PEN",
      "actual": {
        "ventasNetas": "48250.4200",
        "costoVentas": "21712.6900",
        "utilidadBruta": "26537.7300",
        "margenBrutoPorcentaje": "0.550000",
        "pedidosAtendidos": 214,
        "ticketPromedio": "225.4683",
        "mermaValorizada": "812.4400",
        "mermaPorcentajeProduccion": "0.031200",
        "cuentasPorCobrarSaldo": "9120.5000",
        "cuentasPorCobrarVencidas": "1480.0000",
        "rotacionInventarioDias": "9.400000"
      },
      "anterior": {
        "ventasNetas": "44120.0000",
        "costoVentas": "20380.3300",
        "utilidadBruta": "23739.6700",
        "margenBrutoPorcentaje": "0.538100"
      },
      "variacion": {
        "ventasNetasPorcentaje": "0.093606",
        "costoVentasPorcentaje": "0.065384",
        "utilidadBrutaPorcentaje": "0.117618",
        "margenBrutoPuntosPorcentaje": "0.011900"
      },
      "semaforo": {
        "margenObjetivo": "0.500000",
        "estado": "VERDE",
        "regla": "margen >= objetivo"
      },
      "generadoEn": "2026-11-01T14:30:00.000-05:00",
      "fuenteDatos": "report.mv_resumen_periodo",
      "cacheSegundos": 300
    }
  ],
  "paginacion": { "siguienteCursor": null, "hayMas": false, "limite": 25 }
}
```

---

## 9. Rate limiting, timeouts y límites

### 9.1 Rate limiting (sin Redis: D-02 impone PostgreSQL)

Tabla `core.limite_tasa (clave text, ventana_inicio timestamptz, contador int, PRIMARY KEY (clave, ventana_inicio))`
con `INSERT ... ON CONFLICT DO UPDATE SET contador = contador + 1 RETURNING contador` (atómico, una
sola ida a la BD). Ventana deslizante por minuto; caché L1 en memoria por instancia para las claves
calientes, invalidada por la BD en caso de desvío > 20 %.

| Ámbito | Límite | Ventana | Clave |
|---|---|---|---|
| `POST /auth/login` | 5 | 1 min por IP + usuario | `ip:usuario` |
| `POST /auth/password/recuperacion` | 3 | 15 min por IP | `ip` |
| CLIENTE (global) | 60 req | 1 min | `usuario_id` |
| PRODUCCION (global) | 300 req | 1 min | `usuario_id` |
| ALMACEN (global) | 300 req | 1 min | `usuario_id` |
| VENDEDOR (global) | 300 req | 1 min | `usuario_id` |
| GERENTE (global) | 120 req | 1 min | `usuario_id` |
| ADMIN (global) | 120 req | 1 min | `usuario_id` |
| `POST /sync/push` | 30 lotes | 1 min | `dispositivo_id` |
| `GET /sync/pull` | 120 req | 1 min | `dispositivo_id` |
| `POST /ventas`, `POST /pagos` | 60 req | 1 min | `usuario_id` |
| `POST /reportes/*/exportaciones` | 10 | 1 h | `usuario_id` |
| `GET /ventas/{id}/comprobante.pdf` | 60 | 1 h | `usuario_id` |
| `POST /inventario/tomas/{id}/cerrar` | 5 | 1 h | `usuario_id` |
| Cualquier endpoint | 600 req | 1 min por IP | `ip` (protección antiabuso) |

Cabeceras en toda respuesta: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`,
`RateLimit-Policy`. Al exceder: `429 LIMITE_TASA_EXCEDIDO` + `Retry-After: <segundos>`.
Cinco fallos de login consecutivos → bloqueo 15 min (`CUENTA_BLOQUEADA`), registrado en
`core.intento_login` y `audit.evento`.

### 9.2 Timeouts y presupuestos

| Elemento | Valor | Acción al vencer |
|---|---|---|
| Petición HTTP total (API) | 15 s mutaciones / 10 s lecturas | `504 TIEMPO_AGOTADO` |
| `statement_timeout` PostgreSQL | 8 s | rollback + `504` |
| `lock_timeout` | 3 s | `409 CONFLICTO_CONCURRENTE` |
| `idle_in_transaction_session_timeout` | 5 s | rollback forzado |
| `POST /sync/push` | 25 s (500 ops máx) | `202` + `trabajoId` para procesar en background |
| Exportación de reporte | 120 s asíncrono | `202` + `/trabajos/{id}`, notificación al terminar |
| Job pg-boss | 60 s, 3 reintentos, backoff 30/120/600 s | dead-letter `core.evento_dominio.fallido` |
| Caddy (proxy) | `read_timeout 30s`, `write_timeout 30s`, `idle 120s` | cierre de conexión |
| Cliente móvil (Dio) | connect 5 s, receive 20 s | outbox reintenta (ver `09`) |
| Cliente web (TanStack Query) | 3 reintentos, backoff 1/2/4 s | error en UI con reintento manual |

Toda operación que exceda el presupuesto de lectura debe convertirse en asíncrona: un `GET` nunca
bloquea más de 10 s. El prorrateo CIF y el recálculo masivo son siempre `202`.

### 9.3 Límites de payload

| Recurso | Límite |
|---|---|
| Cuerpo JSON general | 1 MB |
| `POST /sync/push` | 5 MB y 500 operaciones por lote |
| Líneas de pedido (`detalle`) | 100 |
| Líneas de venta (`detalle`) | 200 |
| Líneas de receta por versión | 80 |
| Ítems de toma de inventario por lote | 500 |
| Productos por `POST /precios/lote` | 200 |
| Cuerpo de filtros de reporte | 256 KB |
| Longitud de `observaciones` / `motivo` | 500 caracteres |
| Longitud de `personalizacion` por línea | 300 caracteres |
| Imágenes | **Nunca por la API.** URL prefirmada R2; JPEG/PNG/WebP ≤ 5 MB, máx. 2000×2000 px |
| Profundidad de anidamiento JSON | 6 niveles |
| Cabeceras totales | 16 KB |

Se rechaza con `413 PAYLOAD_TOO_LARGE` (o `422 VALIDACION_FALLIDA` si es un límite de colección).

---

## 10. Marcas de ampliación y corrección respecto de la propuesta

| Marca | Punto | Origen |
|---|---|---|
| `[CORRECCIÓN]` | La propuesta dice "JWT de corta duración y renovación segura"; aquí son **15 min + refresh opaco rotativo 30 días con detección de reuso**. Un JWT de 15 min sin refresh rotativo obliga a re-login o a tokens largos inseguros. | §4.5 propuesta, D-07 |
| `[CORRECCIÓN]` | La propuesta habla de "reintentos automáticos de envío" como mitigación de conectividad. Eso solo no evita duplicados: se exige `Idempotency-Key` + outbox (`09`). | §8 propuesta |
| `[AMPLIACIÓN]` | Correlativos `REQ`, `BAJ`, `DES`, `PAG`, `AJU`, `TOM`, `CMP` además de `PED`, `OP`, `VTA`. | Trazabilidad de §3.2 |
| `[AMPLIACIÓN]` | `/sync/push` y `/sync/pull` como canal exclusivo del móvil, con esquema versionado. | Riesgo de conectividad |
| `[AMPLIACIÓN]` | `POST /ordenes-produccion/{id}/cerrar` como paso separado de `TERMINADA`: el costeo no puede bloquear el registro físico de la producción. | §5 propuesta |
| `[AMPLIACIÓN]` | `POST /cuentas-por-cobrar/{id}/incobrable` y `POST /cobranza/recordatorios`. | G-11 exige "días promedio de cobro"; sin castigo el indicador se distorsiona |
| `[AMPLIACIÓN]` | `GET /productos/{id}/disponibilidad` (stock + próximo horneado) para el catálogo del Cliente. | §3.2 "disponibilidad" sin endpoint en la propuesta |
| `[AMPLIACIÓN]` | `POST /caja/sesiones` y arqueo. La propuesta menciona "multi-caja" en D-10 pero no el ciclo de sesión. | D-10 |
| `[AMPLIACIÓN]` | `If-Match`/`version` en pedidos y `409 PEDIDO_VERSION_DESACTUALIZADA`. | Concurrencia Cliente/Vendedor |
| `[AMPLIACIÓN]` | `GET /sync/bootstrap` para hidratar un dispositivo nuevo o recuperarse de un `CURSOR_EXPIRADO`. | `09` §5.3 |
| `[CORRECCIÓN]` | El módulo de identidad se llama **`identidad`**, no `auth`, alineado con `02-ARQUITECTURA.md` §4.3. Los endpoints siguen bajo `/auth/*` porque `/auth` es el recurso de sesión, no el módulo. | Coherencia del dossier |
| `[CORRECCIÓN]` | `02-ARQUITECTURA.md` §5.2 y `13-CALIDAD-Y-OPERACION.md` QA-02 proponen `POST /ordenes-produccion/{id}/consumir` como endpoint separado, y `02` usa además `/produccion/{id}/terminar`. Aquí el consumo va **dentro** de `POST /ordenes-produccion/{id}/produccion` y el cierre es `POST /ordenes-produccion/{id}/cerrar`. Un endpoint de consumo separado abre la ventana en que el insumo ya salió del almacén sin producción registrada, y obliga a compensar transacciones. | Atomicidad de consumo + producción + merma |

**Fuera de alcance explícito:** comprobantes electrónicos SUNAT, pasarela de pagos en línea,
integración contable/ERP y endpoint público para terceros. Cualquier `/api/v2`, OAuth de terceros o
webhooks entrantes se cotiza aparte (§9.4 de la propuesta).
