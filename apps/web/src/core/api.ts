/**
 * Cliente HTTP del API.
 *
 * - El token de acceso (15 min) vive SOLO en memoria: un XSS no puede leerlo de localStorage.
 *   Al recargar la página se recupera con la cookie de refresco.
 * - El token de refresco viaja en una cookie HttpOnly: JavaScript no puede leerla,
 *   así un XSS no se lleva la sesión. Por eso todas las llamadas usan `credentials: 'include'`.
 */

// Mismo origen siempre: en desarrollo lo reenvía Vite, en producción Caddy.
const BASE = import.meta.env.VITE_API_URL ?? '/api/v1';

const CLAVE = 'tanta.acceso.v3';

export class ApiError extends Error {
  status: number;
  codigo: string;
  constructor(status: number, codigo: string, mensaje: string) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
  }
}

let acceso: string | null = null;

export function leerAcceso(): string | null {
  return acceso;
}

export function guardarAcceso(token: string): void {
  acceso = token;
}

export function borrarAcceso(): void {
  acceso = null;
}

/** URL absoluta de un recurso del API (fotos, logos: "/archivos/…"). */
export const urlApi = (ruta: string) => BASE + ruta;

export interface ConfigPublica {
  marca: { nombreApp: string; colorPrimario: string; colorAcento: string; logoId: string | null; iconoId: string | null; fondosIngreso?: string[]; fondoSegundos?: number };
  movil: { versionActual: string; versionMinima: string };
  legal: { urlPrivacidad: string; urlTerminos: string; correoSoporte: string };
  negocio: { nombre: string; ruc: string; direccion: string; telefono: string; whatsapp: string; email: string; representante: string; claim: string };
}

// Una sola petición por carga de página; el superadmin la renueva tras guardar.
let configPublica: Promise<ConfigPublica> | null = null;
export function leerConfigPublica(renovar = false): Promise<ConfigPublica> {
  if (renovar || !configPublica) {
    // Si falla (API reiniciando, sin red) no se guarda el error: el próximo uso reintenta.
    configPublica = api<ConfigPublica>('/config/publica', { sinAuth: true }).catch((e) => { configPublica = null; throw e; });
    // Avisa a logo, título, etc. que la marca cambió, sin recargar la página.
    if (renovar) void configPublica.then(() => window.dispatchEvent(new Event('tanta:config')));
  }
  return configPublica;
}

export function idempotencyKey(): string {
  return crypto.randomUUID();
}

// Un solo refresco en vuelo: el servidor rota el token y detecta reuso, así que dos
// refrescos paralelos cerrarían la sesión.
let enVuelo: Promise<boolean> | null = null;

export function refrescar(): Promise<boolean> {
  enVuelo ??= hacerRefresco().finally(() => { enVuelo = null; });
  return enVuelo;
}

async function hacerRefresco(): Promise<boolean> {
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).catch(() => null);
  if (!res?.ok) {
    borrarAcceso();
    return false;
  }
  const datos = (await res.json()) as { accessToken: string };
  guardarAcceso(datos.accessToken);
  return true;
}

interface Opciones {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  conIdempotencia?: boolean;
  sinAuth?: boolean;
  reintentar?: boolean;
}

export async function api<T>(ruta: string, op: Opciones = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, conIdempotencia, sinAuth, reintentar = true } = op;

  const cabeceras: Record<string, string> = { ...headers };
  if (body !== undefined) cabeceras['Content-Type'] = 'application/json';
  if (!sinAuth) {
    const acceso = leerAcceso();
    if (acceso) cabeceras.Authorization = `Bearer ${acceso}`;
  }
  if (conIdempotencia) cabeceras['Idempotency-Key'] = idempotencyKey();

  const res = await fetch(`${BASE}${ruta}`, {
    method,
    headers: cabeceras,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    // Sin red, servidor caído o túnel vencido: el navegador solo dice «Failed to fetch».
    throw new ApiError(0, 'SIN_CONEXION', 'No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.');
  });

  if (res.status === 401 && !sinAuth && reintentar) {
    const ok = await refrescar();
    if (ok) return api<T>(ruta, { ...op, reintentar: false });
  }

  if (!res.ok) {
    let codigo = 'ERROR';
    let mensaje = res.status >= 500 ? 'El sistema no está disponible por el momento. Intenta de nuevo en unos minutos.' : `Error ${res.status}`;
    try {
      const problema = await res.json();
      codigo = problema.codigo ?? codigo;
      mensaje = problema.detail ?? problema.title ?? mensaje;
    } catch { /* respuesta sin cuerpo */ }
    throw new ApiError(res.status, codigo, mensaje);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/*  Sesión                                                             */
/* ------------------------------------------------------------------ */

export interface SesionOk {
  accessToken: string;
  expiraEn: number;
  usuario: { id: string; nombre: string; usuario?: string };
  rol: string;
  permisos: string[];
}

export interface PideSegundoFactor {
  mfaRequerido: true;
  ticket: string;
  usuario: { nombre: string };
}

export interface PideEnrolamiento {
  mfaEnrolamiento: true;
  ticket: string;
  usuario: { nombre: string };
}

export type RespuestaLogin = SesionOk | PideSegundoFactor | PideEnrolamiento;

export async function login(usuario: string, clave: string, recordar = true): Promise<RespuestaLogin> {
  const r = await api<RespuestaLogin>('/auth/login', {
    method: 'POST',
    body: { usuario, clave, recordar },
    sinAuth: true,
  });
  if ('accessToken' in r) guardarAcceso(r.accessToken);
  return r;
}

export async function verificarMfa(ticket: string, codigo: string): Promise<SesionOk> {
  const r = await api<SesionOk>('/auth/mfa/verificar', {
    method: 'POST', body: { ticket, codigo }, sinAuth: true,
  });
  guardarAcceso(r.accessToken);
  return r;
}

export async function enrolarMfa(ticket: string): Promise<{ secreto: string; otpauth: string; instrucciones: string }> {
  return api('/auth/mfa/enrolar', { method: 'POST', body: { ticket }, sinAuth: true });
}

export interface SesionConCodigos extends SesionOk {
  codigosRecuperacion?: string[];
}

export async function activarMfa(ticket: string, codigo: string): Promise<SesionConCodigos> {
  const r = await api<SesionConCodigos>('/auth/mfa/activar', {
    method: 'POST', body: { ticket, codigo }, sinAuth: true,
  });
  guardarAcceso(r.accessToken);
  return r;
}

/** Regenera los códigos de respaldo. Invalida los anteriores. */
export async function regenerarRecuperacion(clave: string): Promise<string[]> {
  const r = await api<{ codigos: string[] }>('/auth/mfa/recuperacion', { method: 'POST', body: { clave } });
  return r.codigos;
}

export async function logout(): Promise<void> {
  try {
    await api('/auth/logout', { method: 'POST', body: {} });
  } catch { /* la sesión local se cierra igual */ }
  borrarAcceso();
}
