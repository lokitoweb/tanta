import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import { pool } from './db.js';
import { invalidar } from './cache.js';
import { rutasAuth } from './routes/auth.js';
import { rutasDatos } from './routes/datos.js';
import { rutasOperaciones } from './routes/operaciones.js';
import { rutasAdmin } from './routes/admin.js';
import { rutasSistema } from './routes/sistema.js';
import { rutasMaestros } from './routes/maestros.js';
import { rutasReportes } from './routes/reportes.js';
import { rutasCobranza } from './routes/cobranza.js';
import { rutasFlujo } from './routes/flujo.js';

const PUERTO = Number(process.env.PORT ?? 3001);
const ORIGENES = (process.env.CORS_ORIGINS ??
  'http://127.0.0.1:5180,http://localhost:5180,http://127.0.0.1:4173,https://www.tantapanaderia.com')
  .split(',').map((s) => s.trim());

export async function construir() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  await app.register(cookie, { secret: process.env.COOKIE_SECRET ?? process.env.JWT_SECRET! });

  // El API solo sirve JSON: una CSP que no permite nada.
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'same-site' } });

  await app.register(cors, {
    // Devolver false (no lanzar) hace que el navegador reciba la respuesta sin las
    // cabeceras CORS, que es el comportamiento correcto. Lanzar un Error producía un 500.
    origin: (origen, cb) => {
      if (!origen || ORIGENES.includes(origen)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    maxAge: 600,
  });

  // Límite global por IP. 240/min (4 req/s) ahogaba a una oficina entera detrás de una
  // sola IP: el dashboard solo ya hace varias peticiones por pantalla. El login conserva
  // su propio límite estricto (LOGIN_RATE_MAX) porque ahí sí importa la fuerza bruta.
  await app.register(rateLimit, {
    max: Number(process.env.RATE_MAX ?? 6000),
    timeWindow: '1 minute',
  });

  // Toda escritura exitosa invalida los agregados cacheados ANTES de responder: quien
  // recarga justo después de su venta, cobro o ajuste ya ve el dato nuevo.
  app.addHook('onSend', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && reply.statusCode < 400) { invalidar('agg:'); invalidar('cat:'); }
  });

  // Respuesta de error uniforme (RFC 9457). Nunca se filtra el mensaje crudo de PostgreSQL.
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    let status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    let codigo = err.code ?? 'ERROR_INTERNO';
    let detalle = err.message;

    // Errores de la base traducidos a lenguaje de negocio.
    if (err.code === '23514') { status = 409; codigo = 'INVARIANTE_VIOLADO'; detalle = 'La operación dejaría el inventario en un estado inválido.'; }
    if (err.code === '23505') { status = 409; codigo = 'DUPLICADO'; detalle = 'El registro ya existe.'; }
    if (err.code === '23503') { status = 409; codigo = 'REFERENCIA_INVALIDA'; detalle = 'Falta un dato relacionado.'; }
    if (err.code === '22003') { status = 422; codigo = 'FUERA_DE_RANGO'; detalle = 'El valor numérico está fuera de rango.'; }
    if (err.code === '22P02') { status = 422; codigo = 'FORMATO_INVALIDO'; detalle = 'Un dato tiene formato inválido.'; }
    if (err.code === '429' || (err as { statusCode?: number }).statusCode === 429) { codigo = 'RATE_LIMITED'; detalle = 'Demasiadas peticiones. Espera un momento.'; }

    if (status >= 500) {
      req.log.error({ err }, 'error no controlado');
      detalle = 'Ocurrió un error inesperado. Intenta nuevamente.';
      codigo = 'ERROR_INTERNO';
    }

    reply.code(status).send({
      type: 'about:blank',
      title: status >= 500 ? 'Error interno' : detalle,
      status,
      codigo,
      detail: detalle,
      instance: req.url,
    });
  });

  // 404 con el mismo formato de error que el resto del API.
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      type: 'about:blank', title: 'Recurso no encontrado', status: 404,
      codigo: 'NO_ENCONTRADO', detail: `No existe ${req.method} ${req.url}`, instance: req.url,
    });
  });

  await app.register(async (api) => {
    // Liveness: el proceso responde. No toca la base a propósito.
    api.get('/health/live', async () => ({ estado: 'vivo', uptimeSeg: Math.round(process.uptime()) }));

    // Readiness: ¿puede atender tráfico? Si la base no responde, 503.
    api.get('/health/ready', async (_req, reply) => {
      try {
        await pool.query('SELECT 1');
        return { estado: 'listo' };
      } catch {
        return reply.code(503).send({ estado: 'no-listo', motivo: 'base de datos no disponible' });
      }
    });

    api.get('/health', async () => {
      const t0 = Date.now();
      const r = await pool.query('SELECT 1 AS ok');
      return {
        estado: 'ok',
        version: '0.1.0',
        baseDatos: r.rows[0]?.ok === 1 ? 'ok' : 'error',
        latenciaMs: Date.now() - t0,
        uptimeSeg: Math.round(process.uptime()),
      };
    });

    await api.register(rutasAuth);
    await api.register(rutasDatos);
    await api.register(rutasOperaciones);
    await api.register(rutasAdmin);
    await api.register(rutasSistema);
    await api.register(rutasMaestros);
    await api.register(rutasReportes);
    await api.register(rutasCobranza);
    await api.register(rutasFlujo);
  }, { prefix: '/api/v1' });

  return app;
}

const app = await construir();

try {
  await app.listen({ port: PUERTO, host: process.env.HOST ?? '127.0.0.1' });
  app.log.info(`Tanta Core en http://127.0.0.1:${PUERTO}/api/v1`);
} catch (e) {
  app.log.error(e);
  process.exit(1);
}

for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(senal, async () => {
    app.log.info(`${senal} recibido: cerrando ordenadamente`);
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
