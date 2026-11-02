/**
 * Caché en memoria con TTL, para datos de catálogo que cambian poco.
 *
 * Guarda la *promesa*, no el valor: si 60 peticiones piden lo mismo a la vez,
 * se ejecuta una sola consulta y todas esperan el mismo resultado
 * (evita el "thundering herd" contra PostgreSQL).
 */
interface Entrada {
  promesa: Promise<unknown>;
  expira: number;
}

const store = new Map<string, Entrada>();

export function recordar<T>(clave: string, ttlMs: number, calcular: () => Promise<T>): Promise<T> {
  const ahora = Date.now();
  const existente = store.get(clave);
  if (existente && existente.expira > ahora) {
    return existente.promesa as Promise<T>;
  }
  const promesa = calcular().catch((e) => {
    // Si falla, no se cachea el error: el siguiente intento vuelve a consultar.
    store.delete(clave);
    throw e;
  });
  store.set(clave, { promesa, expira: ahora + ttlMs });
  return promesa as Promise<T>;
}

/** Invalida una clave o todas las que empiecen por un prefijo. */
export function invalidar(prefijo?: string): void {
  if (!prefijo) {
    store.clear();
    return;
  }
  for (const clave of store.keys()) {
    if (clave.startsWith(prefijo)) store.delete(clave);
  }
}

export function estadisticas(): { claves: number; detalle: Array<{ clave: string; venceEnMs: number }> } {
  const ahora = Date.now();
  return {
    claves: store.size,
    detalle: [...store.entries()].map(([clave, e]) => ({ clave, venceEnMs: Math.max(0, e.expira - ahora) })),
  };
}
