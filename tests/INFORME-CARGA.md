# Informe de carga — API Tanta

**Autor:** Ingeniería de Pruebas de Carga · **Fecha:** 2026-11-01 19:40 (America/Lima)
**Alcance:** API `http://127.0.0.1:3001/api/v1` (Fastify 5 + PostgreSQL 17.11), sin tocar
`apps/api/src`, `apps/web` ni migraciones. Todo el trabajo vive en `tests/`.

---

## 1. Resumen ejecutivo

| Pregunta | Respuesta medida |
|---|---|
| **RPS máximos sostenidos (mezcla completa)** | **45,35 RPS** (40 VU). A 60 VU **baja a 43,61 RPS**: el sistema ya está saturado y encolar más usuarios sólo añade latencia. |
| **RPS sin errores** | **Ninguno** con la mezcla completa: `POST /ventas` falla el 10–12 % desde que hay 2 ventas concurrentes. Descontando ese defecto, el techo libre de errores es **45 RPS**. |
| **p95 del endpoint más lento** | **GET /datos: 1 837 ms** (p50 1 317 ms, p99 1 977 ms) a 60 VU. `POST /ventas` llega a p95 2 447 ms pero es transaccional. |
| **Cuello de botella real** | `GET /datos`: **28–29 RPS** y deja de subir. Es el 60 % del tráfico, así que fija el techo agregado en ~45 RPS. |
| **Errores funcionales** | 100 % de los HTTP 500 son `duplicate key ... venta_codigo_key` en `POST /ventas`. **Se pierden ventas reales.** |
| **Techo por cliente** | **4 RPS por IP** (rate limit global 240/min). Una oficina entera detrás de un NAT queda estrangulada. |

**Veredicto: no apto para producción.** Hay tres defectos bloqueantes (P0) y ninguno es de
"más hardware": dos son bugs de concurrencia y uno es de configuración. La buena noticia es
que el motor es rápido: `GET /kardex` aislado sostiene **354 RPS** con p50 de 12,7 ms.

---

## 2. Metodología

### 2.1 El generador (`tests/carga.mjs`)

Node puro, sin dependencias, sólo `fetch`. Decisiones que afectan la validez de los números:

- **Login una sola vez por usuario** (4 logins por corrida, ~150–430 ms cada uno) y el token
  se reutiliza. Así se mide el sistema, no el rate limit del login.
- **Mezcla 60/15/20/5 respetando permisos reales.** El reparto ingenuo habría llenado la
  prueba de 403 que no son fallos del sistema: el GERENTE **no** tiene `ventas.registrar`, el
  VENDEDOR **no** tiene `inventario.ver`. Cada usuario virtual encarna una persona con su
  propia mezcla, de modo que el agregado sea exactamente 60/15/20/5:

  | Persona | VU con 60 | Mezcla | Permisos que la habilitan |
  |---|---|---|---|
  | `osquilcate` GERENTE | 15 | 21 datos + 5 kárdex | `panel.ver`, `inventario.ver` |
  | `rquispe` PRODUCCION | 11 | 13 datos + 5 kárdex | `panel.ver`, `inventario.ver` |
  | `jramos` ALMACEN | 11 | 13 datos + 5 kárdex | `panel.ver`, `inventario.ver` |
  | `cmedina` VENDEDOR | 23 | 13 datos + 20 ventas + 5 cobranza | `ventas.registrar`, `cobranza.registrar` |

  Mezcla observada: 5 VU → datos 61,4 % · kárdex 17,1 % · ventas 17,4 % · cobranza 4,0 %;
  60 VU → 63,3 / 16,2 / 17,0 / 3,6. La desviación es muestreo aleatorio (semilla fija), no un
  sesgo del generador.
- **Ciclo cerrado sin think time** (cada VU dispara en cuanto termina la anterior): mide el
  techo de saturación, no el comportamiento de un usuario leyendo la pantalla.
- **Se consume el cuerpo completo** de cada respuesta: serializar 29 KB de `/datos` también cuesta.
- **Percentiles por rango más cercano** sobre la muestra completa de la fase de medición.
- **Códigos de error de negocio**, no sólo HTTP: se parsea `codigo` del cuerpo.

Concurrencia y duración: `--concurrencia=5|20|40|60 --duracion=25 --calentamiento=4`.
Cada escalón se ejecutó sobre datos repuestos (`tests/preparar-datos.sql`).

### 2.2 El modo `X-Forwarded-For` (decisión clave)

El API tiene **rate limit global de 240 peticiones/minuto por IP** (`server.ts:36`) y
`trustProxy: true`, así que `req.ip` sale de `X-Forwarded-For`. Comprobado empíricamente:

```
IP fija  -> primer 429 en la petición #241   {200: 240, 429: 20}
IP rotativa -> 60 peticiones, 60× 200
```

Se usaron dos modos y **los dos se reportan**:

- `--xff=req` (escalones oficiales): una IP distinta por petición. **Mide la capacidad del
  sistema**, no la protección antiabuso. Sin esto, 1 VU ya se autolimita a 4 RPS y la curva
  mide el rate limiter (pasó en la primera corrida de prueba: 98 % de 429).
- `--xff=off` (prueba NAT): todos los VU comparten IP. **Mide el techo por cliente**, que es
  el escenario de una panadería con varias cajas detrás de un solo router.

### 2.3 Entorno y limitaciones (importante para leer las cifras absolutas)

| Elemento | Valor |
|---|---|
| Host | Windows, 8 procesadores lógicos, 8 GB RAM |
| VM de Docker | **2 vCPU**, 2,84 GB, compartida con **6 contenedores de otro proyecto** (`saas-backend`, `saas-mysql`, `saas-frontend`…) |
| PostgreSQL | 17.11-alpine · `max_connections=100` · `shared_buffers=128MB` · `work_mem=4MB` |
| Pool del API | **`max: 10`** (`PGPOOL`, `db.ts:11`), `connectionTimeoutMillis: 5000` |
| Cliente y servidor | misma máquina (compiten por CPU) |

Consecuencias honestas:

- **Las latencias absolutas están infladas por el entorno.** Un `SELECT` sobre una tabla de 4
  filas tarda p50 0,6 ms y p99 76 ms en el mismo minuto: es desalojo de CPU en una VM de 2 vCPU,
  no un problema de plan. Lo que **sí** se traslada a producción es la *forma* de la curva, los
  puntos de saturación, el mecanismo de los errores y la aritmética de conexiones.
- **No hay `pg_stat_statements`** (exigiría reiniciar el contenedor). Se usó
  `log_min_duration_statement` en caliente (y se revirtió: `SHOW` final = `-1`), más
  `EXPLAIN (ANALYZE, BUFFERS)` y muestreo de `pg_stat_activity`/`pg_locks`.
- Los datos son pequeños (1 351 ventas, 2 142 líneas). Con más histórico empeoran las
  consultas que escanean `core.venta` (ver §6, H-08 y H-11).

---

## 3. Resultados

### 3.1 Por escalón (mezcla completa, `--xff=req`)

| Escalón | RPS | p50 | p95 | p99 | máx | errores | err % |
|---|---|---|---|---|---|---|---|
| 5 VU | **41,66** | 105,1 ms | 253,7 ms | 458,4 ms | 802,8 ms | 22 | 2,11 % |
| 20 VU | **44,38** | 432,8 ms | 728,1 ms | 894,0 ms | 1 149,3 ms | 17 | 1,52 % |
| 40 VU | **45,35** | 837,7 ms | 1 355,3 ms | 1 704,8 ms | 2 285,8 ms | 20 | 1,73 % |
| 60 VU | **43,61** | 1 318,7 ms | 1 999,4 ms | 2 422,6 ms | 2 719,9 ms | 20 | 1,75 % |

Lectura: de 41,7 a 45,4 RPS el sistema gana **+9 %** de caudal mientras el p95 se multiplica
**×5,3**; a 60 VU el caudal **retrocede**. Eso es saturación, no escalado.

### 3.2 Por endpoint y escalón (RPS · p50 / p95 / p99 en ms · errores)

| Endpoint | 5 VU | 20 VU | 40 VU | 60 VU |
|---|---|---|---|---|
| `GET /datos` | 25,58 · 110,6 / 251,4 / 372,0 · 0 | 29,39 · 435,3 / 679,4 / 804,3 · 0 | 28,73 · 837,7 / 1 236,6 / 1 379,5 · 0 | 27,60 · 1 316,7 / **1 837,0** / 1 976,6 · 0 |
| `GET /kardex/INS-001` | 7,14 · 32,7 / 80,9 / 147,5 · 0 | 6,78 · 252,8 / 432,3 / 495,3 · 0 | 7,92 · 512,4 / 842,1 / 891,4 · 0 | 7,05 · 837,7 / 1 189,0 / 1 280,0 · 0 |
| `POST /ventas` | 7,26 · 141,1 / 344,4 / 584,9 · **22** | 6,70 · 593,7 / 951,6 / 1 030,4 · **17** | 6,70 · 1 130,1 / 1 719,2 / 1 883,4 · **20** | 7,40 · 1 718,5 / **2 446,9** / 2 660,7 · **20** |
| `POST /cobranza` | 1,68 · 122,8 / 283,0 / 378,4 · 0 | 1,51 · 567,4 / 720,8 / 877,6 · 0 | 2,00 · 1 079,4 / 1 511,0 / 1 722,5 · 0 | 1,56 · 1 714,5 / 2 343,6 / 2 442,0 · 0 |

Ningún endpoint devolvió 4xx por permisos ni por datos: la mezcla y los cuerpos son válidos.
**Todos los errores son 500 del mismo tipo.**

### 3.3 Códigos de error observados

| Endpoint | HTTP | `codigo` (cuerpo) | Veces | Mensaje crudo |
|---|---|---|---|---|
| `POST /ventas` | 500 | `duplicate key value violates unique constraint "venta_codigo_key"` | 22 / 17 / 20 / 20 | El mensaje de PostgreSQL se devuelve tal cual como `codigo` y `detail`. |

Comportamiento en el resto: 200 en `GET`, 201 en `POST`, sin timeouts ni errores de red en
ningún escalón (timeout del cliente: 30 s; el máximo observado fue 3,8 s).

### 3.4 Pruebas aisladas (para separar causas)

| Escenario | RPS | p50 | p95 | Nota |
|---|---|---|---|---|
| `GET /kardex` sólo, 1 VU | 122,6 | 7,7 ms | 12,1 ms | — |
| `GET /kardex` sólo, 5 VU | 350,7 | 12,7 ms | 25,7 ms | **354 RPS a 10 VU**: el motor escala |
| `GET /datos` sólo, 1 VU | 23,1 | 39,2 ms | 74,3 ms | coste intrínseco del panel: ~39 ms |
| `GET /datos` sólo, 2 VU | **38,3** | 49,9 ms | 80,7 ms | techo del panel |
| `GET /datos` sólo, 5 VU | 36,1 | 124,1 ms | 239,6 ms | ya no sube, sólo empeora |
| Mezcla **sin** `/ventas`, 60 VU | 35,8 | 1 478,5 ms | 2 894,2 ms | **0 errores**: sin el defecto, todo responde |
| Mezcla completa, IP compartida (NAT), 5 VU | 345,7 (intento) | 4,8 ms | 22,8 ms | **197×200 y 4 989×429**: sólo 197 peticiones pasaron |

El contraste `kardex` 354 RPS vs `datos` 38 RPS (ambos sobre las mismas tablas, mismas
conexiones) es la prueba de que **el problema no es PostgreSQL sino cuántas consultas y
round-trips necesita el panel**.

---

## 4. Punto de quiebre y por qué ocurre

### 4.1 Dónde se rompe

- **Rodilla: 20 VU.** p95 salta de 254 ms a 728 ms mientras el caudal sube sólo 6,5 %.
- **Techo: ~45 RPS.** A 60 VU el caudal cae a 43,6 RPS y el p95 llega a 2,0 s.
- El límite lo pone `GET /datos`, que se estanca en **27,6–29,4 RPS** desde 20 VU.
  Como es el 60 % de la mezcla, 29 / 0,6 ≈ 48 RPS es el techo teórico del conjunto; la
  medición da 45.

### 4.2 Por qué: 15 consultas por panel contra un pool de 10 conexiones

`GET /datos` (`apps/api/src/routes/datos.ts:15-170`) lanza **14 consultas en `Promise.all` + 1
secuencial** (`core.parametro`, línea 172). Evidencia recogida:

1. **Un `POST /datos` consume ~50–100 ms de CPU de PostgreSQL**, no de red. `EXPLAIN (ANALYZE)`
   con el sistema en reposo: Q1 12,0 ms de ejecución **+ 17,4 ms de planificación**; Q2 10,5 ms;
   Q3 5,9 ms; Q4 4,8 ms. La planificación pesa tanto como la ejecución porque cada petición
   **re-parsea y re-planifica** los 15 statements (node-postgres no cachea planes cuando no se
   usan sentencias nombradas).
2. **PostgreSQL trabaja al límite de la VM.** `docker stats` durante el escalón de 60 VU:
   `tanta-pg = 92 %, 101 %, 115 %, 96 %…` de CPU, es decir ~1,1 de los **2 vCPU** de la VM.
3. **El pool está clavado en 10.** Muestreo de `pg_stat_activity` cada ~1,5 s en el escalón de
   60 VU: `application_name='tanta-api'` = **10 en las 15 muestras**, con 6–11 sesiones activas.
4. **Aritmética de la cola (ley de Little, con números medidos).** A 60 VU: 27,6 RPS × 1,317 s
   = **36 peticiones de `/datos` concurrentes**; cada una pide 15 conexiones a la vez =
   **~545 demandas simultáneas sobre 10 conexiones** → 54 turnos de cola. De ahí los 1,3 s de
   p50 sin que ninguna consulta individual sea lenta.
5. **El plan no es el culpable.** Las mismas consultas sobre 1 240 ventas tardan 5–12 ms de
   ejecución cuando el sistema está en reposo; la penalización ×5–10 aparece sólo bajo carga,
   con `wait_event_type` dominante `Client` (esperando al cliente) y sin esperas de bloqueo
   sostenidas (`pg_locks` no otorgados = 0 en casi todas las muestras).

### 4.3 Contribuyentes secundarios, medidos

| Factor | Medición | Efecto |
|---|---|---|
| `autenticar` ejecuta `SELECT permiso_id FROM core.rol_permiso WHERE rol_id=$1` **en cada petición** (`seguridad.ts:123`) | 155–169 ejecuciones por escalón, p99 20,9 ms; 3.ª consulta por tiempo acumulado | +1 round-trip y +6 % del tiempo de BD en **todas** las rutas |
| `POST /ventas` toma `SELECT … FOR UPDATE` de la fila de producto | p99 **428 ms**, máx 428 ms | bloqueo entre ventas del mismo SKU |
| `POST /ventas` calcula el código con `SELECT count(*)+1` | `Seq Scan on venta (rows=1240)`: `seq_scan` de la tabla = **22 789** | O(n) por venta y colisión de código (§6 H-01) |
| Rate limit global | 240/min por IP | **4 RPS por cliente**; 4 989 respuestas 429 en 15 s |

---

## 5. EXPLAIN de las tres consultas más costosas

Ranking obtenido del log real de PostgreSQL durante el escalón de 60 VU
(`tests/evidencia/pg-log-e60-vu.log`, 3 515 sentencias > 20 ms, 164 s de tiempo acumulado):

| # | Consulta | n | p50 | p95 | p99 | Total | % |
|---|---|---|---|---|---|---|---|
| 1 | top 8 productos (`venta_detalle` ⨝ `venta` ⨝ `producto`) | 881 | 61,7 ms | 112,4 ms | 142,3 ms | 57,2 s | 34,8 % |
| 2 | ventas por categoría | 811 | 44,3 ms | 83,5 ms | 107,8 ms | 39,0 s | 23,7 % |
| 3 | serie de 30 días sobre `report.v_venta_dia` | 630 | 32,1 ms | 59,8 ms | 88,5 ms | 22,2 s | 13,5 % |
| 4 | KPIs del panel (4 subconsultas) | 583 | 32,8 ms | 57,9 ms | 91,9 ms | 20,9 s | 12,7 % |
| 5 | recetas + `json_agg` | 337 | 25,9 ms | 50,1 ms | 70,5 ms | 9,7 s | 5,9 % |
| 6 | `producto … FOR UPDATE` (ventas) | 66 | 73,8 ms | 378,5 ms | **428,0 ms** | 7,7 s | 4,7 % |

### 5.1 Q1 · top 8 productos — 34,8 % del tiempo

```
Limit (actual time=11.438..11.456 rows=8)
  -> Result
      -> Sort (quicksort, Memory: 27kB)
          -> HashAggregate (actual time=11.143..11.162 rows=16, Memory: 97kB)
              -> Hash Join (actual time=3.921..7.441 rows=1980)          -- vd.producto_id = p.id
                  -> Hash Join (actual time=3.772..6.442 rows=1980)      -- vd.venta_id = v.id
                      -> Seq Scan on venta_detalle vd (actual time=0.005..0.929 rows=1980)
                      -> Hash -> Seq Scan on venta v (actual time=0.029..2.623 rows=1240)
                                 Filter: estado='CONFIRMADA' AND creado_en >= now()-'30 days'
                  -> Hash -> Seq Scan on producto p (rows=16)
      SubPlan 1 -> Index Scan using categoria_pkey (loops=8)
Planning Time: 17.418 ms      <-- más caro que la ejecución
Execution Time: 11.977 ms
```

- **¿Usa índice?** Sólo el `SubPlan` (`categoria_pkey`). El agregado es **Seq Scan sobre
  `venta_detalle` y sobre `venta`**: no hay índice que sirva porque se recorre el 100 % de las
  filas de los últimos 30 días (con este juego de datos *todo* es de los últimos 30 días).
- **Coste oculto:** `Planning Time` 17,4 ms > `Execution Time` 12,0 ms. En tres corridas
  seguidas: plan 11,8 / 10,7 / 9,3 ms vs ejecución 8,5 / 9,2 / 10,1 ms. **La mitad del coste es
  planificar de nuevo en cada petición.**
- **Veredicto:** el plan es razonable; el problema es que este trabajo se repite en **cada**
  carga del panel, 15 veces por petición.

### 5.2 Q2 · ventas por categoría — 23,7 % · **defecto funcional**

```
Sort (actual time=10.241..10.246 rows=4)
  -> HashAggregate (rows=4)
      -> Hash Right Join (actual time=0.085..6.937 rows=1980)   -- p.categoria_id = c.id
          -> Hash Right Join (actual time=0.053..4.071 rows=1980) -- vd.producto_id = p.id
              -> Seq Scan on venta_detalle vd (actual time=0.006..1.785 rows=1980)
              -> Hash -> Seq Scan on producto p (rows=16)
          -> Hash -> Seq Scan on categoria c (rows=4)
Planning Time: 0.670 ms
Execution Time: 10.535 ms
```

- **¿Usa índice?** No, y no hace falta: el problema es otro.
- **`core.venta` no aparece en el plan.** El `LEFT JOIN core.venta v` no se referencia en el
  `SELECT`, así que el planificador **lo elimina** y con él desaparece el filtro de 30 días.
  La consulta agrega **todo el histórico** de `venta_detalle`.
- **Prueba numérica** (transacción con `ROLLBACK`, insertando una venta de hace 90 días):
  la consulta de `/datos` suma **104 266,90** cuando el total de los últimos 30 días es
  **103 266,90**: los 1 000 de la venta antigua **sí** entran.
- **Veredicto:** bug de corrección, no de rendimiento. Además el coste crece sin techo con el
  histórico.

### 5.3 Q3 · serie de 30 días sobre `report.v_venta_dia` — 13,5 %

```
Merge Left Join (actual time=5.522..5.551 rows=30)
  -> Sort (generate_series) rows=30
  -> Sort -> Subquery Scan on vd
       -> HashAggregate (rows=30)  Group Key: ((creado_en AT TIME ZONE 'America/Lima'))::date
            -> Seq Scan on venta (actual time=1.042..3.345 rows=1240)
                 Filter: estado='CONFIRMADA'
Planning Time: 9.884 ms
Execution Time: 5.870 ms
```

- **¿Usa índice?** No. Existe `ix_venta_fecha (creado_en DESC) WHERE estado='CONFIRMADA'`, pero
  PostgreSQL prefiere Seq Scan porque la vista **agrega todo el histórico y sólo después** se
  une con los 30 días.
- **Veredicto:** la vista `report.v_venta_dia` se define sin filtro de fecha
  (`SELECT … FROM core.venta WHERE estado='CONFIRMADA' GROUP BY fecha`), así que su coste crece
  linealmente con el histórico aunque sólo se usen 30 días. Índice recomendado en §7.

### 5.4 Comprobaciones complementarias

| Consulta | Exec | Plan | ¿Índice? | Veredicto |
|---|---|---|---|---|
| Q4 KPIs (4 subconsultas) | 4,8 ms | 12,6 ms | `ix_venta_fecha` sí (ventana 60–30 d); `ix_mov_tipo` sí; `cuenta_por_cobrar` Seq Scan (92 filas) | correcto |
| Q5 kárdex `INS-001` | **0,7 ms** | 8,2 ms | **sí**: `insumo_codigo_key` + `ix_mov_insumo` | correcto, pero devuelve la historia completa sin paginar |
| Q6 `count(*)+1` del código de venta | 0,7 ms | 0,4 ms | **no puede usarlo**: `Aggregate -> Seq Scan on venta` | O(n) por venta y **colisión** (§6 H-01) |
| Q7 `producto … FOR UPDATE` | — | `LockRows -> Seq Scan on producto` | no usa `producto_pkey` (16 filas: seq scan es más barato) | el problema es el **bloqueo**, no el plan: máx 428 ms |

---

## 6. Hallazgos (por gravedad)

### H-01 · P0 · `POST /ventas` pierde ventas por colisión de código

**Síntoma.** 10–12 % de las ventas devuelven HTTP 500 con
`codigo = duplicate key value violates unique constraint "venta_codigo_key"`.

**Evidencia.** Reproducción mínima con 6 ventas simultáneas de **productos distintos**:

```
500 duplicate key … "venta_codigo_key"   ×5
201 VTA-2026-001351                      ×1
→ 1 creada, 5 con 500
```

En los escalones: 22/17/20/20 fallos, ~1,5–2 % del total de peticiones (pero 10–12 % de las ventas).
`venta_codigo_key` es `UNIQUE (codigo)` y el código se calcula así (`operaciones.ts:260`):

```sql
SELECT 'VTA-' || to_char(now(),'YYYY') || '-' || lpad((count(*)+1)::text,6,'0') FROM core.venta
```

Sin bloqueo ni secuencia: dos transacciones concurrentes leen el mismo `count(*)` y calculan el
mismo código. Detalle revelador: si las 6 ventas usan **el mismo** producto, el `FOR UPDATE` de
la fila las serializa y no falla ninguna; el fallo aparece cuando venden **SKUs distintos**, que
es exactamente el caso normal con dos cajas abiertas.

**Impacto.** Se pierden ventas reales y el cajero ve un error interno. Con 2 cajas la pérdida
teórica es alta (en la prueba, 83 % de las ventas concurrentes).

**Corrección.** Secuencia atómica (SQL exacto en §7, P0-1). Efecto lateral positivo: elimina el
`count(*)` O(n) de cada venta.

---

### H-02 · P0 · 4 RPS por IP: el rate limit global estrangula a cualquier cliente real

**Síntoma.** Pasadas 240 peticiones en un minuto desde una IP, todo son 429.

**Evidencia.** `server.ts:36` registra `rateLimit` con `max: 240, timeWindow: '1 minute'`, y
`trustProxy: true` hace que la clave sea `req.ip`. Medido: primer 429 en la petición **#241**; con
5 VU compartiendo IP, **197×200 y 4 989×429 en 15 s**.

**Impacto.** Una panadería con varias cajas detrás de un router (una sola IP pública) queda
limitada a **4 peticiones/s**, y el panel dispara 15 consultas por carga. Insostenible.

**Agravante (H-09).** El 429 se devuelve con el formato del manejador global de errores y
`codigo: "ERROR_INTERNO"`, indistinguible de una caída del servidor.

**Corrección.** Subir el límite global (p. ej. 3 000/min) y mantener el estricto en `/auth/login`;
o poner clave por usuario autenticado. Añadir `errorResponseBuilder` con
`codigo: 'DEMASIADAS_PETICIONES'` y cabecera `Retry-After` (§7, P0-2).

---

### H-03 · P0 · `GET /datos` hace 15 consultas por petición contra un pool de 10

**Síntoma.** El panel se estanca en 27–29 RPS y su p95 llega a 1,8 s.

**Evidencia.**
- 14 consultas en `Promise.all` + 1 secuencial (`datos.ts:15-172`).
- `PGPOOL` por defecto = **10** (`db.ts:11`) y `pg_stat_activity` muestra
  `application_name='tanta-api'` = 10 en todas las muestras bajo carga.
- A 60 VU: 27,6 RPS × 1,317 s ≈ **36 paneles concurrentes × 15 conexiones = 545 demandas** sobre
  10 conexiones.
- PostgreSQL al 92–115 % de CPU (~1,1 de 2 vCPU de la VM).
- La misma base responde a 354 RPS con el kárdex (1 consulta por petición).

**Impacto.** Es el techo de todo el sistema: 29 / 0,6 ≈ 48 RPS.

**Corrección.** Tres palancas, en este orden de rentabilidad (§7, P0-3): consolidar consultas
(15 → 3), cachear el panel 5–10 s por rol, y subir `PGPOOL` a 40. Sólo subir el pool traslada el
problema a la CPU de PostgreSQL.

---

### H-04 · P1 · Cada consulta se planifica de nuevo (sin *prepared statements*)

**Evidencia.** `Planning Time` ≈ `Execution Time` en todas las consultas del panel
(17,4/12,0 · 12,6/4,8 · 9,9/5,9 · 8,2/0,7). `pg_stat_statements` no está instalado, pero el log
muestra `parse`/`bind` en cada ejecución de las consultas parametrizadas.

**Impacto.** ~50 % del coste de CPU del panel es planificación descartable.

**Corrección.** Usar sentencias nombradas
(`pool.query({ name: 'datos-top-productos', text, values })`) para que cada conexión reutilice su
plan; consolidar consultas reduce además el número de planes. §7, P0-3 (punto 2).

---

### H-05 · P1 · Un `SELECT` de permisos en cada petición autenticada

**Evidencia.** `seguridad.ts:123` ejecuta `permisosDeRol(carga.rol)` en `autenticar`. En el log
del escalón de 60 VU es la **3.ª consulta por tiempo acumulado** (p99 20,9 ms, 155–169
ejecuciones). Se paga incluso en `GET /kardex`, que sólo necesita un permiso.

**Corrección.** Caché en memoria por rol con TTL 60 s (invalidando al cambiar permisos) o incluir
los permisos en el JWT con `pv` (ya existe la versión de permisos). §7, P1-1.

---

### H-06 · P1 · La cadena de auditoría se rompe con escrituras concurrentes

**Evidencia.** `auditar()` hace `SELECT hash_actual FROM audit.evento ORDER BY id DESC LIMIT 1`
y luego `INSERT`, sin bloqueo (`auditoria.ts:18-36`). Tras la prueba:

```
eventos=1632  eslabones_rotos=806  hashes_padre_distintos=1157  (deberían ser 1631)
```

**Impacto.** El encadenado es la garantía anti-manipulación del sistema; hoy **cualquier**
concurrencia lo bifurca y `verificarCadena()` fallaría en producción. Es un fallo de integridad,
no de rendimiento (el volumen es bajo).

**Corrección.** Serializar el avance de la cadena con una fila-cabeza y `FOR UPDATE` (o
`pg_advisory_xact_lock`) dentro de la misma transacción del evento. §7, P1-2.

---

### H-07 · P1 · Vender sin stock devuelve 500 en lugar de un error de negocio

**Evidencia.** Con `stock = 0` en P001:

```
500 new row for relation "producto" violates check constraint "ck_producto_stock_no_negativo"
```

`POST /ventas` descuenta stock sin comprobarlo (`operaciones.ts:242-252`); la única red es el
`CHECK (stock >= 0)` de la migración 002. Contraste: `POST /ordenes-produccion/:codigo/cerrar`
**sí** valida y responde `409 STOCK_INSUFICIENTE` (`operaciones.ts:129`).

**Impacto.** El cajero no puede distinguir "no hay stock" de "el sistema falló", y el mensaje
expone el esquema interno.

**Corrección.** Comprobar existencias con el `FOR UPDATE` que ya se hace y devolver
`409 STOCK_INSUFICIENTE` con el faltante. §7, P1-3.

---

### H-08 · P1 · El panel suma el histórico completo en "ventas por categoría"

Ver §5.2. El `LEFT JOIN core.venta` se elimina por no referenciarse y el filtro de 30 días
desaparece: los importes por categoría son de **toda la vida** del negocio (probado: +1 000 de una
venta de hace 90 días). Además rompe el principio de "el filtrado ocurre en el servidor" (D-12).
**Corrección:** agregar por producto en una subconsulta con el filtro de fecha (§7, P1-4).

---

### H-09 · P2 · El 429 se reporta como `ERROR_INTERNO`

El manejador global (`server.ts:39-49`) usa `err.code ?? 'ERROR_INTERNO'`; el error del plugin no
trae `code`, así que un límite de tráfico se presenta como error interno con `type: about:blank`.
El frontend lo tratará como caída del servidor.

### H-10 · P2 · Los errores de PostgreSQL se devuelven crudos al cliente

`operaciones.ts:304-305` y `:356-357` envían `error(status, err.message, err.message)`: el nombre
del constraint, el mensaje del motor y detalles del esquema viajan al navegador. Debe mapearse a
códigos estables (`VENTA_CODIGO_DUPLICADO`, `STOCK_INSUFICIENTE`…) y registrar el detalle.

### H-11 · P2 · `GET /kardex` devuelve la historia completa sin paginar

`operaciones.ts:366-373` hace `ORDER BY m.id` sin `LIMIT`. Hoy son 12 filas; con un año de
movimientos (1 664 en una hora de prueba) la respuesta crece sin techo. Añadir `LIMIT` + cursor.

### H-12 · P2 · `report.v_venta_dia` agrega todo el histórico para pintar 30 días

Ver §5.3. La vista no acepta rango; se puede filtrar en la consulta que la usa o crear una vista
parametrizada / índice de cobertura.

---

## 7. Correcciones priorizadas (sin aplicar)

### P0 — bloqueantes

**P0-1 · Secuencia para el código de venta** (H-01)

```sql
CREATE SEQUENCE IF NOT EXISTS core.venta_num_seq AS bigint;
SELECT setval('core.venta_num_seq',
              (SELECT max(substring(codigo from 10)::bigint) FROM core.venta
                WHERE codigo ~ '^VTA-\d{4}-\d{6}$'));
ALTER TABLE core.venta
  ALTER COLUMN codigo SET DEFAULT
    ('VTA-' || to_char(now(),'YYYY') || '-' || lpad(nextval('core.venta_num_seq')::text, 6, '0'));
```

Y en `operaciones.ts`: borrar el `SELECT count(*)+1` (línea 260) y el parámetro `$1` del `INSERT`,
dejando que el `DEFAULT` genere el código; `RETURNING codigo, id`. El `UNIQUE` existente queda como
red de seguridad.

**P0-2 · Rate limit** (H-02, H-09) — `server.ts:36`

```ts
await app.register(rateLimit, {
  max: Number(process.env.RATE_MAX ?? 3000),   // antes 240
  timeWindow: '1 minute',
  errorResponseBuilder: (_req, ctx) => ({
    type: 'about:blank', title: 'Demasiadas peticiones', status: 429,
    codigo: 'DEMASIADAS_PETICIONES', detail: `Reintenta en ${ctx.after}.`,
  }),
});
```

Mantener `LOGIN_RATE_MAX` (200/min) en `/auth/login`; valorar clave por usuario autenticado
cuando el plugin corra después de `autenticar`.

**P0-3 · Panel `/datos`** (H-03, H-04)

1. **Consolidar 15 → 3 consultas**: una para KPIs, una para series+agregados por producto/categoría
   (con el filtro de 30 días aplicado por producto) y una para el resto de catálogos. Cada
   round-trip eliminado son ~2–10 ms de CPU.
2. **Sentencias nombradas** (plan cache por conexión):
   `pool.query({ name: 'datos-kpis', text, values })`.
3. **`PGPOOL=40`** (hoy 10; `max_connections=100` da margen) — pero después de (1) y (2), porque
   sin ellos sólo mueve la cola.
4. **Caché del panel 5–10 s por rol** (los datos cambian por minuto; el payload ya trae
   `generadoEn`). Es la palanca de mayor impacto para el p95.

### P1 — importantes

**P1-1 ·** Caché de permisos por rol, TTL 60 s, invalidada al cambiar `rol_permiso` (H-05).
**P1-2 ·** Cadena de auditoría serializada (H-06):

```sql
CREATE TABLE IF NOT EXISTS core.auditoria_cadena (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hash_actual text NOT NULL DEFAULT ''
);
INSERT INTO core.auditoria_cadena (id, hash_actual) VALUES (1, '') ON CONFLICT DO NOTHING;
-- dentro de la misma transacción del evento:
SELECT hash_actual FROM core.auditoria_cadena WHERE id = 1 FOR UPDATE;
-- … INSERT audit.evento …
UPDATE core.auditoria_cadena SET hash_actual = $1 WHERE id = 1;
```

**P1-3 ·** Validar stock en `POST /ventas` → `409 STOCK_INSUFICIENTE` (H-07).
**P1-4 ·** Agregado por categoría con el filtro de fecha dentro de la subconsulta (H-08):

```sql
LEFT JOIN (
  SELECT vd.producto_id, sum(vd.precio_neto) AS ventas,
         sum(vd.costo_unitario * vd.cantidad) AS costo, sum(vd.utilidad) AS utilidad
  FROM core.venta_detalle vd
  JOIN core.venta v ON v.id = vd.venta_id
  WHERE v.estado = 'CONFIRMADA' AND v.creado_en >= now() - interval '30 days'
  GROUP BY vd.producto_id
) x ON x.producto_id = p.id
```

**P1-5 ·** Índices recomendados (crear con `CONCURRENTLY`, medir después):

```sql
-- aging de CxC del panel: hoy Seq Scan con 22 696 seq_scan y 0 idx_scan
CREATE INDEX CONCURRENTLY ix_cxc_abiertas
  ON core.cuenta_por_cobrar (vence_en) INCLUDE (saldo)
  WHERE estado IN ('PENDIENTE','PARCIAL') AND saldo > 0;

-- KPIs/serie del panel a escala: permite index-only scan sobre la ventana
CREATE INDEX CONCURRENTLY ix_venta_30d
  ON core.venta (creado_en) INCLUDE (ventas_netas, costo_ventas, utilidad)
  WHERE estado = 'CONFIRMADA';
```

**P1-6 ·** Para `report.v_venta_dia` (H-12): filtrar por rango en la consulta que la usa en lugar
de agregar todo el histórico (o materializar la vista por día).

### P2 — higiene

- **P2-1 ·** Mapear errores de PostgreSQL a códigos de negocio estables; nunca devolver
  `err.message` en 500 (H-10).
- **P2-2 ·** `GET /kardex` con `LIMIT` + cursor (H-11).
- **P2-3 ·** `toLocaleDateString('es-PE')` por petición en `/datos`: cachear el formateador.
- **P2-4 ·** Verificación de la cadena de auditoría en un job/CI (`verificarCadena()`), ahora que
  se puede confiar en ella tras P1-2.

---

## 8. Cómo reproducir

```powershell
# 0) reponer datos de prueba (stock y saldos)
Get-Content tests/preparar-datos.sql -Raw | docker exec -i tanta-pg psql -U tanta -d tanta -q -f -

# 1) escalón suelto con muestreo de PostgreSQL y log de consultas lentas
powershell -File tests/escalon.ps1 -Concurrencia 40 -Duracion 25 -Etiqueta 40-vu -Xff req -SqlLog 20

# 2) corrida directa
node tests/carga.mjs --concurrencia=20 --duracion=30
node tests/carga.mjs --concurrencia=5 --solo=kardex --xff=req
node tests/carga.mjs --concurrencia=5 --solo=datos --xff=off      # techo por IP (NAT)

# 3) análisis del log de consultas
node tests/analizar-log-sql.mjs tests/evidencia/pg-log-e60-vu.log --top=15

# 4) EXPLAIN de las consultas del panel
Get-Content tests/explain-consultas.sql -Raw | docker exec -i tanta-pg psql -U tanta -d tanta -f -

# 5) reproducción de los defectos de concurrencia
node tests/pruebas-puntuales.mjs
```

**Evidencia archivada** en `tests/evidencia/`: `pg-stat-e*.log` (muestras de `pg_stat_activity`),
`pg-log-e60-vu.log` (SQL lento real), `explain.txt`, `salida-e*.log` y `snapshot-antes-e*.log`.

---

## 9. Estado de los datos tras la prueba

`POST /ventas` y `POST /cobranza` escriben de verdad. Antes → después:

| Tabla | Antes | Después |
|---|---|---|
| `core.venta` | 251 | 1 351 |
| `core.venta_detalle` | 494 | 2 142 |
| `core.movimiento_inventario` | 16 | 1 664 |
| `core.cobranza` | 0 | 352 |
| `audit.evento` | 53 | 1 632 |

`tests/preparar-datos.sql` repone stock (250 000 por producto) y saldos de CxC para que la prueba
mida el sistema y no el agotamiento del catálogo. Para volver a un estado limpio:
`pnpm db:seed`. El log de PostgreSQL quedó restaurado (`log_min_duration_statement = -1`).

---

## 10. Conclusión

El motor está sano: `GET /kardex` sostiene 354 RPS con p50 de 12,7 ms y los planes son correctos
con los índices que ya existen. Lo que no aguanta es el **diseño del panel** (15 consultas por
petición sobre un pool de 10, con planes rehechos cada vez), el **código de venta secuencial por
`count(*)`** y un **rate limit de 4 RPS por IP**. Con las tres correcciones P0 el sistema debería
pasar de ~45 RPS a varias centenas sin cambiar de infraestructura; sin ellas, el primer día de
producción con dos cajas abiertas pierde ventas y la primera oficina tras un NAT se queda sin
servicio.
