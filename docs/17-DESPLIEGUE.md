# 17 · Despliegue en producción

> Guía operativa: cómo se instala, se actualiza, se respalda y se recupera el sistema en un VPS.
> Todo lo que está aquí se puede ejecutar sin interpretación.

---

## 1. Requisitos del servidor

| Recurso | Mínimo | Recomendado |
|---|---|---|
| vCPU | 2 | 4 |
| RAM | 4 GB | 8 GB |
| Disco | 40 GB SSD | 80 GB SSD |
| Sistema | Ubuntu 24.04 LTS | — |
| Software | Docker Engine 27+ y Compose v2 | — |

Con 4 vCPU / 8 GB el sistema sostiene el año 1 con margen ×5 (ver `02 §8.1`).

**DNS antes de empezar:** dos registros `A` apuntando a la IP del servidor — `tantapanaderia.com` y
`www.tantapanaderia.com`. Caddy emite el certificado en el primer arranque; si el DNS no resuelve
todavía, el TLS falla y hay que reiniciar el contenedor después de propagarlo.

---

## 2. Primer despliegue

```bash
# 1. Servidor base
apt update && apt install -y docker.io docker-compose-v2 git

# 2. Usuario sin privilegios para operar (nunca se despliega como root)
adduser --disabled-password --gecos "" tanta
usermod -aG docker tanta
su - tanta

# 3. Código
git clone <repositorio> ~/tanta && cd ~/tanta

# 4. Configuración
cp .env.production.example .env.production
nano .env.production     # dominio, correo, claves
chmod 600 .env.production

# 5. Construir y arrancar (la web se compila dentro de Docker; el API migra solo al iniciar)
docker compose --env-file .env.production -f infra/compose/docker-compose.prod.yml up -d --build

# 6. Primer Superadministrador (ver la sección al final de esta guía)
docker compose --env-file .env.production -f infra/compose/docker-compose.prod.yml exec \
  -e SUPERADMIN_USUARIO=admin -e SUPERADMIN_CLAVE='una-clave-larga-y-unica' api node dist/db/superadmin.js
```

**No se ejecuta la semilla en producción.** El catálogo real (categorías, productos, insumos, recetas,
clientes y costos indirectos) se carga desde la web, en Maestros. La semilla es solo para desarrollo.

### Verificación de que quedó bien

```bash
curl -fsS https://tantapanaderia.com/api/v1/health   # {"estado":"ok","baseDatos":"ok"}
curl -fsSI https://tantapanaderia.com | grep -i strict-transport
docker compose --env-file .env.production -f infra/compose/docker-compose.prod.yml ps
```

---

## 3. Actualización (sin downtime perceptible)

```bash
cd ~/tanta
git pull
# Reconstruye API y web; el API aplica solo las migraciones nuevas al arrancar (idempotente).
docker compose --env-file .env.production -f infra/compose/docker-compose.prod.yml up -d --build api caddy
```

El reinicio del API dura menos de 5 segundos. Caddy reintenta mientras tanto, así que el usuario ve
un error solo si la recarga coincide exactamente con la ventana.

**Migraciones seguras:** las que agregan columnas van en dos pasos (agregar nullable → desplegar →
rellenar → hacer `NOT NULL`). Nunca se renombra ni se borra una columna en el mismo despliegue que
deja de usarla.

---

## 4. Respaldos

El contenedor `backup` ejecuta `pg_dump` **cada 24 h** con retención de 30 días y checksum SHA-256.

```bash
# Ver los respaldos disponibles
docker compose -f infra/compose/docker-compose.prod.yml exec backup ls -lh /backups

# Copiarlos fuera del servidor (obligatorio: un backup en el mismo disco no es un backup)
rsync -avz tanta@servidor:/var/lib/docker/volumes/tanta_tanta_backups/_data/ ~/respaldos/
```

### Ensayo de restauración — obligatorio antes del go-live y mensual después

El contenedor `backup` tiene los scripts y los respaldos montados. El ensayo se hace en una
base **aparte** (`tanta_ensayo`) del mismo servidor: producción no se toca.

```bash
# 1. Base vacía para el ensayo
docker compose -f infra/compose/docker-compose.prod.yml exec backup createdb tanta_ensayo

# 2. Restaurar y cronometrar
time docker compose -f infra/compose/docker-compose.prod.yml exec -T -e PGDATABASE=tanta_ensayo backup   sh /scripts/restore.sh /backups/tanta-<fecha>.sql.gz

# 3. Revisar los invariantes que imprime restore.sh (stock = último asiento del kárdex) y borrar
docker compose -f infra/compose/docker-compose.prod.yml exec backup dropdb tanta_ensayo
```

Restaurar sobre producción (desastre real): detener el API (`docker compose … stop api caddy`),
`dropdb` + `createdb` de la base y ejecutar el paso 2 sin `-e PGDATABASE`; al arrancar, el API
reaplica migraciones y el rol de aplicación.

**RPO real:** 24 h (dump diario). El archivado WAL está desactivado; para RPO de minutos hay que
configurar PITR con un destino externo.
**RTO medido:** registrar aquí el tiempo real de la última prueba → `______ minutos` (objetivo ≤ 4 h).

---

## 5. Monitoreo mínimo

| Qué | Cómo | Umbral de alerta |
|---|---|---|
| Disponibilidad | `curl` a `/api/v1/health` cada minuto (Uptime Kuma) | 2 fallos seguidos |
| Error 5xx | logs JSON de Caddy y del API | > 1 % de las peticiones |
| Latencia | `latenciaMs` de `/health` | p95 > 800 ms |
| Disco | `df -h` | > 80 % |
| Respaldos | que exista un archivo de las últimas 24 h | ausente |
| Stock negativo | `SELECT count(*) FROM core.insumo WHERE stock < 0` | > 0 (no debería ocurrir: hay constraint) |

```bash
# Logs en vivo
docker compose -f infra/compose/docker-compose.prod.yml logs -f api
```

---

## 6. Runbook de incidentes

| Síntoma | Diagnóstico | Acción |
|---|---|---|
| **La web no carga** | `docker compose ps` | Si `caddy` está caído: `restart caddy`. Si `api` está caído, la web sigue sirviéndose pero sin datos. |
| **502 en /api** | `docker compose logs api` | Verificar `postgres` sano; revisar `JWT_SECRET` y conexión. |
| **"Credenciales inválidas" en masa** | `SELECT count(*) FROM core.usuario WHERE estado='BLOQUEADO'` | Probable ataque de fuerza bruta: revisar `LOGIN_RATE_MAX` y los logs de `/auth/login`. |
| **Números que no cuadran** | `SELECT * FROM core.insumo WHERE stock < 0` | Nunca debería pasar (constraint). Si pasa, hay corrupción: restaurar el último backup y abrir incidente. |
| **Disco lleno** | `du -sh /var/lib/docker/volumes/*` | Purgar backups viejos; revisar `pg_wal`. |
| **Se perdió el certificado** | `docker compose logs caddy` | Verificar DNS; `restart caddy` regenera. |

---

## 7. Checklist de go-live

- [ ] DNS propagado y TLS emitido (`https://` con candado válido)
- [ ] `JWT_SECRET` distinto del de ejemplo y guardado en el gestor de contraseñas
- [ ] Contraseña de PostgreSQL robusta y `chmod 600 .env.production`
- [ ] Semilla **no** ejecutada; catálogo real cargado por el importador
- [ ] Primer usuario administrador creado y contraseña de demostración cambiada
- [ ] Ensayo de restauración ejecutado y tiempo de RTO anotado
- [ ] Respaldo copiado fuera del servidor
- [ ] Monitoreo de `/health` activo con alerta a Telegram/WhatsApp
- [ ] `docker compose ps` muestra todos los servicios `healthy`
- [ ] Prueba funcional: login, venta, cierre de OP, cobranza y dashboard desde un celular real
- [ ] Manual de usuario entregado y capacitación firmada

---

## 8. Costo mensual estimado

| Componente | USD/mes |
|---|---|
| VPS 4 vCPU / 8 GB | 12 – 24 |
| Almacenamiento de respaldos (fuera del servidor) | 1 – 3 |
| Dominio (anual prorrateado) | ~1 |
| **Total** | **14 – 28** |

Deja margen dentro de los S/ 150/mes del contrato, siempre que el soporte se limite por escrito
(~4 h mensuales).


## Primer Superadministrador (instalación nueva)

Las migraciones crean roles, permisos, menú y parámetros; **no** crean usuarios ni datos de demostración.
No cargues la semilla (`db:seed`) en producción: crea usuarios con contraseña de prueba y borra datos.

```bash
docker compose -f infra/compose/docker-compose.prod.yml exec \
  -e SUPERADMIN_USUARIO=admin -e SUPERADMIN_CLAVE='una-clave-larga-y-unica' \
  api node dist/db/superadmin.js
```

Al primer ingreso el sistema exige activar la verificación en dos pasos. Desde ahí, el resto de usuarios
se crean en **Usuarios y roles**, y la marca, la app móvil y las integraciones en **Configuración**.
El mismo comando sirve para recuperar el acceso si se pierde la clave del Superadministrador.
