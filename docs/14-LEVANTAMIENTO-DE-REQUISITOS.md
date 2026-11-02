# 14 · Levantamiento de requisitos: las preguntas que faltan

> La propuesta define el sistema en 19 páginas, pero hay decisiones de negocio que **solo Tanta puede
> tomar** y que cambian el modelo de datos, el cálculo del margen y la pantalla del vendedor.
> Si se descubren en la semana 4, cuestan una semana. Si se preguntan el día 1, cuestan una reunión.

**Cómo usar este documento:** imprimirlo, sentarse con el gerente y el usuario clave, y cerrar cada
pregunta con una respuesta escrita. Una respuesta vacía es un riesgo aceptado, no una decisión pendiente.

---

## Bloque A · Precios y clientes (afecta `lista_precio`, `venta`)

| # | Pregunta | Por qué importa | Qué decisión cambia |
|---|---|---|---|
| A1 | ¿Venden al mismo precio en mostrador que a una bodega que compra 200 panes? | Si hay dos precios, hace falta **lista de precio** desde el día 1. | `ADR-014` · tabla `producto_precio` |
| A2 | ¿Algún cliente tiene un precio pactado propio, distinto de cualquier lista? | Define si el precio vive en el cliente además de en la lista. | Precedencia: cliente > lista > base |
| A3 | ¿Quién puede autorizar un descuento y hasta qué porcentaje? | Un descuento sin control es fuga directa de margen. | `descuento_maximo` por rol + auditoría |
| A4 | ¿Hay clientes a crédito? ¿Con cuántos días? ¿Con qué límite? | Sin `dias_credito` y `limite_credito` no se puede bloquear una venta riesgosa. | `cliente.dias_credito`, `limite_credito` |
| A5 | ¿Se vende a personas sin RUC/DNI registrado? ¿Se les pide algo? | Define si "venta a terceros" exige datos mínimos o es anónima. | `venta.cliente_ocasional` (nullable) |
| A6 | ¿Los precios se cambian por lista completa o producto por producto? | Cambia la UI de precios (edición masiva vs. individual). | Pantalla de precios en web |
| A7 | ¿El precio publicado incluye IGV siempre? ¿Hay algún caso sin IGV? | El cálculo de margen parte del precio neto. | `producto.precio_con_igv` + parámetro IGV |

## Bloque B · Producción y recetas (afecta `receta`, `op`, `costo`)

| # | Pregunta | Por qué importa | Qué decisión cambia |
|---|---|---|---|
| B1 | ¿Una receta produce siempre la misma cantidad? ¿O depende de la tanda? | El "rendimiento" es el divisor del costo unitario. | `receta_version.rendimiento` |
| B2 | ¿La merma es un % fijo por receta o varía por día/horno? | Si varía, hace falta merma real por OP y análisis de desvío. | `op_merma` + reporte de desvío |
| B3 | ¿Se produce contra pedidos o se produce "para stock" de mostrador? | Cambia el modelo: OP contra pedido vs. OP de reposición. | Tipo de OP (`PEDIDO` / `STOCK`) |
| B4 | ¿Se produce de madrugada? ¿Hay más de un turno? | Determina ventanas de sync y qué debe funcionar sin red. | Offline obligatorio en Producción |
| B5 | ¿Un mismo producto se hace con recetas distintas según el día? | Fuerza versionado múltiple simultáneo. | Varias versiones vigentes |
| B6 | ¿Quién puede cambiar una receta? ¿El gerente lo aprueba? | Una receta es el activo más valioso del negocio. | `receta_version.estado` + permisos |

## Bloque C · Almacén e insumos (afecta `inventario`, `compra`)

| # | Pregunta | Por qué importa | Qué decisión cambia |
|---|---|---|---|
| C1 | ¿Se permite entregar insumos aunque el sistema diga que no hay stock? | Es la política de saldo negativo; hay que **decidirla**, no descubrirla. | `permitir_saldo_negativo` (parámetro) |
| C2 | ¿Quién compra los insumos? ¿Se registra la factura del proveedor? | Sin documento de compra no hay trazabilidad del CPP. | `compra` + `compra_detalle` |
| C3 | ¿Se compra a crédito a proveedores? | Añade cuentas por pagar (no está en el alcance). | `cuenta_por_pagar` (Fase 2) |
| C4 | ¿Se controla lote o vencimiento de algún insumo? | Huevos, levadura, lácteos pueden requerirlo. | `lote` + `fecha_vencimiento` |
| C5 | ¿Se pesa lo que se entrega o se entrega "por bolsa"? | Determina si la requisición es por cantidad exacta o estimada. | Granularidad de `op_consumo` |
| C6 | ¿Hay más de un almacén físico (seco, frío, mostrador)? | Multi-almacén cambia el kárdex. | `almacen` como entidad (hoy `sucursal`) |
| C7 | ¿Se hace toma de inventario físico? ¿Cada cuánto? | Define la frecuencia del ajuste y su autorización. | `toma_inventario` + reporte de diferencia |

## Bloque D · Ventas y cobranza (afecta `venta`, `cxc`)

| # | Pregunta | Por qué importa | Qué decisión cambia |
|---|---|---|---|
| D1 | ¿El vendedor cobra en efectivo? ¿Dónde guarda el dinero? | Sin caja/arqueo no hay control del efectivo. | `caja` + `arqueo` (Fase 2) |
| D2 | ¿Se acepta Yape/Plin? ¿Se registra el número de operación? | Es el medio dominante en Perú; debe quedar como referencia. | `cobranza.referencia` |
| D3 | ¿Se aceptan devoluciones? ¿Totales o parciales? ¿Con nota de crédito? | Una devolución mal modelada descuadra el kárdex y la CxC. | `devolucion` + `devolucion_detalle` |
| D4 | ¿Un pedido se puede modificar después de confirmado? ¿Hasta cuándo? | Define las guardas de la máquina de estados. | Transiciones permitidas |
| D5 | ¿Se cobra anticipo? ¿Se devuelve si se cancela? | Añade un estado de pago previo a la entrega. | `pedido.anticipo` |
| D6 | ¿El despacho lo hace el vendedor o un repartidor? | Cambia el flujo de confirmación de entrega. | Rol `REPARTIDOR` (¿hace falta?) |
| D7 | ¿Hay ventas a crédito sin interés y con interés? | Si hay interés, hay cálculo financiero adicional. | `cxc.tasa_interes` (¿fuera de alcance?) |

## Bloque E · Costos indirectos (afecta `cif`, `periodo_costos`)

| # | Pregunta | Por qué importa | Qué decisión cambia |
|---|---|---|---|
| E1 | ¿Qué gastos mensuales son "indirectos" de fabricación? (lista cerrada) | Es la base del CIF; sin lista, el costo queda subestimado. | Catálogo de `costo_indirecto` |
| E2 | ¿Cómo se reparte el CIF entre productos? ¿Por unidades, por horas de horno, por valor? | Es la decisión de costeo más discutible del proyecto. | `base_prorrateo` |
| E3 | ¿El alquiler se reparte también entre los productos que se venden en mostrador? | Define el universo de unidades del denominador. | Universo de prorrateo |
| E4 | ¿Se quiere ver el margen con CIF **antes** o **después** del cierre del mes? | Define si el dashboard muestra provisional o definitivo. | `ADR-010` |
| E5 | ¿Hay algún costo que sea fijo por local y no por producto? | Puede quedar fuera del costo unitario y entrar solo en el punto de equilibrio. | Clasificación fijo/variable |

## Bloque F · Operación y tecnología (afecta `sync`, `seguridad`)

| # | Pregunta | Por qué importa | Qué decisión cambia |
|---|---|---|---|
| F1 | ¿Hay internet estable en la planta? ¿De qué velocidad? | Si no lo hay, el offline es obligatorio, no opcional. | Alcance de `09` |
| F2 | ¿Cuántas tablets y celulares hay? ¿De qué modelo y año? | Un tablet de 2018 con 2 GB cambia el diseño y el minSdk. | `minSdk`, presupuesto de rendimiento |
| F3 | ¿Los operarios tienen correo electrónico? | Si no, el login debe ser por usuario corto o teléfono, no por email. | `usuario.login` |
| F4 | ¿Cuántos empleados usan el sistema y con qué rotación? | Alta rotación exige creación de usuarios rápida y bloqueo fácil. | UI de usuarios |
| F5 | ¿Se comparte el dispositivo entre turnos? | Cambia el modelo de sesión (login rápido por PIN). | `sesion` + PIN opcional |
| F6 | ¿Quién es el usuario clave que valida? ¿Cuántas horas por semana tiene? | Es el riesgo #1 del cronograma en la propia propuesta. | Plan de UAT |
| F7 | ¿Tienen RUC y quieren facturar electrónicamente más adelante? | Determina si el modelo debe prever series y comprobantes. | Campos reservados (Fase 3) |
| F8 | ¿Están de acuerdo con que los datos vivan en un servidor en el extranjero? | Es una decisión legal (Ley 29733, transferencia internacional). | Ubicación del VPS |

---

## Plantilla de carga de datos base (para entregar el día 1)

El riesgo R-02 (datos tardíos) se neutraliza con una plantilla que Tanta pueda llenar en Excel y un
importador que valide fila por fila.

### `insumos.csv`
```csv
codigo,nombre,unidad_base,unidad_compra,factor_conversion,stock_inicial,costo_inicial,stock_minimo,proveedor
INS-001,Harina de trigo sin preparar,KG,BOLSA 50KG,50,120,3.85,40,Molino del Sur
INS-002,Azúcar rubia,KG,BOLSA 50KG,50,60,3.20,20,Distribuidora Lima
INS-003,Levadura fresca,KG,CAJA 1KG,1,8,12.50,3,Fermentos SAC
INS-004,Mantequilla,KG,CAJA 10KG,10,15,28.90,5,Lácteos Andinos
```
> `factor_conversion` = cuántas unidades base hay en una unidad de compra. Es lo que evita el
> descuadre clásico: comprar en bolsas de 50 kg y consumir en gramos.

### `productos.csv`
```csv
codigo,nombre,categoria,unidad_venta,precio_con_igv,lista,estado
PRD-001,Pan ciabatta,Pan,UNIDAD,2.36,MINORISTA,ACTIVO
PRD-002,Pan francés,Pan,UNIDAD,0.50,MINORISTA,ACTIVO
PRD-003,Torta de chocolate, Pastelería,UNIDAD,45.00,MINORISTA,ACTIVO
```

### `recetas.csv` + `receta_lineas.csv`
```csv
codigo_producto,version,rendimiento,unidad_rendimiento,merma_estandar_pct,vigente_desde
PRD-001,1,24,UNIDAD,3.0,2026-10-26

codigo_producto,version,insumo,cantidad,unidad
PRD-001,1,INS-001,0.420,KG
PRD-001,1,INS-003,0.006,KG
PRD-001,1,INS-004,0.030,KG
```
> `rendimiento = 24` significa que la receta (con esas cantidades) produce 24 unidades. El costo unitario
> es el costo total de la receta dividido entre 24. **Si este número está mal, todo el margen está mal.**

### `costos_indirectos.csv`
```csv
concepto,tipo,monto_mensual,base_prorrateo
Alquiler del local,FIJO,2500.00,UNIDADES_PRODUCIDAS
Gas (GLP),VARIABLE,1800.00,HORAS_HORNO
Energía eléctrica,VARIABLE,900.00,UNIDADES_PRODUCIDAS
Agua,VARIABLE,180.00,UNIDADES_PRODUCIDAS
Mano de obra indirecta,FIJO,2200.00,UNIDADES_PRODUCIDAS
Depreciación de horno,FIJO,350.00,HORAS_HORNO
```

**Regla del importador:** ninguna fila entra sin validación. Los errores se muestran en una tabla
("fila 14: el insumo INS-999 no existe") y se corrige antes de confirmar. Nunca se carga "a medias".

---

## Checklist de la reunión del día 1

- [ ] ¿Quién firma el acta de alcance? (nombre y cargo)
- [ ] ¿Quién es el usuario clave y en qué horario está disponible?
- [ ] ¿Cuándo se entrega la plantilla de datos llenada? (fecha, no "pronto")
- [ ] ¿Qué dispositivos existen hoy y cuáles se van a comprar?
- [ ] ¿Hay WiFi en planta, almacén y mostrador? ¿Se mide la señal en el punto exacto?
- [ ] ¿Quién autoriza descuentos y con qué límite?
- [ ] ¿Cuántos clientes a crédito hay y con qué condiciones?
- [ ] ¿Se factura electrónicamente hoy? ¿Con qué sistema?
- [ ] ¿Quién más va a ver el dashboard además del gerente?
- [ ] ¿Qué decisión del sistema, si sale mal, les haría perder la confianza el primer día?

La última pregunta es la más importante. La respuesta suele ser **"que los números no cuadren"**, y es
exactamente la razón por la que este dossier pone el costeo, el kárdex y la precisión decimal por encima
de cualquier otra consideración estética.
