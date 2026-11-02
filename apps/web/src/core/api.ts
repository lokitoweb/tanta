/**
 * Cliente HTTP del API.
 *
 * - El token de acceso (15 min) vive en memoria + localStorage.
 * - El token de refresco viaja en una cookie HttpOnly: JavaScript no puede leerla,
 *   así un XSS no se lleva la sesión. Por eso todas las llamadas usan `credentials: 'include'`.
 */

const BASE = import.meta.env.VITE_API_URL
  ?? (import.meta.env.DEV ? 'http://127.0.0.1:3001/api/v1' : '/api/v1');

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

export function leerAcceso(): string | null {
  try {
    return localStorage.getItem(CLAVE);
  } catch {
    return null;
  }
}

export function guardarAcceso(token: string): void {
  localStorage.setItem(CLAVE, token);
}

export function borrarAcceso(): void {
  localStorage.removeItem(CLAVE);
}

export function idempotencyKey(): string {
  return crypto.randomUUID();
}

async function refrescar(): Promise<boolean> {
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
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
  });

  if (res.status === 401 && !sinAuth && reintentar) {
    const ok = await refrescar();
    if (ok) return api<T>(ruta, { ...op, reintentar: false });
  }

  if (!res.ok) {
    let codigo = 'ERROR';
    let mensaje = `Error ${res.status}`;
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

export async function login(usuario: string, clave: string): Promise<RespuestaLogin> {
  const r = await api<RespuestaLogin>('/auth/login', {
    method: 'POST',
    body: { usuario, clave },
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
export async function regenerarRecuperacion(): Promise<string[]> {
  const r = await api<{ codigos: string[] }>('/auth/mfa/recuperacion', { method: 'POST', body: {} });
  return r.codigos;
}

export async function logout(): Promise<void> {
  try {
    await api('/auth/logout', { method: 'POST', body: {} });
  } catch { /* la sesión local se cierra igual */ }
  borrarAcceso();
}
