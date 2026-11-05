const PEN = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PEN0 = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const NUM = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const NUM2 = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Sin dato (p. ej. el rol no puede ver soles) se muestra "—", nunca NaN ni un S/ 0.00 engañoso.
export const money = (n: number) => (Number.isFinite(n) ? PEN.format(n) : "—");
export const moneyShort = (n: number) => (!Number.isFinite(n) ? "—" : Math.abs(n) >= 1000 ? PEN0.format(n) : PEN.format(n));
export const num = (n: number) => NUM.format(n ?? 0);
export const num2 = (n: number) => NUM2.format(n ?? 0);

/** Recibe fracción (0.55) y devuelve "55,0 %". */
export function pct(fraccion: number, decimales = 1): string {
  if (fraccion === null || fraccion === undefined || Number.isNaN(fraccion)) return '—';
  return `${(fraccion * 100).toLocaleString('es-PE', { minimumFractionDigits: decimales, maximumFractionDigits: decimales })} %`;
}

export function pesosFirma(n: number): string {
  return n >= 0 ? `+${pct(n)}` : pct(n);
}

export function fecha(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'));
  return d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short' });
}

export function fechaLarga(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'));
  return d.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function fechaHora(iso: string): string {
  // Postgres envía '2026-11-02 17:03:12.5-05': el navegador exige 'T' y la zona como -05:00.
  const d = new Date(iso.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit' })} · ${d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}`;
}

export function relativa(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

/** RN-37 (igual que el API): rojo bajo el objetivo; ámbar hasta 5 puntos sobre el objetivo; verde por encima. */
export type Semaforo = 'ok' | 'warn' | 'danger';
export function semaforo(margen: number, objetivo: number): Semaforo {
  if (margen < objetivo) return 'danger';
  if (margen <= objetivo + 0.05) return 'warn';
  return 'ok';
}

export function iniciales(nombre: string): string {
  return nombre.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

/** Eje de gráficos: sin decimales y compacto, siempre con la misma regla. */
export function eje(n: number): string {
  if (Math.abs(n) >= 1000) return `S/ ${(n / 1000).toLocaleString('es-PE', { maximumFractionDigits: 1 })}k`;
  return `S/ ${Math.round(n).toLocaleString('es-PE')}`;
}

/** Cantidades de receta con unidad legible: 0.102 kg se muestra como 102 g. */
export function cantidad(valor: number, unidad: string): string {
  if (unidad === 'KG' && valor < 1) return `${Math.round(valor * 1000)} g`;
  if (unidad === 'L' && valor < 1) return `${Math.round(valor * 1000)} ml`;
  if (unidad === 'UNIDAD' && valor < 10) {
    return `${valor.toLocaleString('es-PE', { maximumFractionDigits: 2 })} u`;
  }
  return `${valor.toLocaleString('es-PE', { maximumFractionDigits: 3 })} ${unidad.toLowerCase()}`;
}

/**
 * Reparte un total en partes de modo que, al redondear cada parte a 2 decimales,
 * la suma siga siendo exactamente el total (método del mayor residuo).
 * Sin esto, la ficha de costo muestra 0.56 + 0.02 + 0.33 = 0.91 cuando el costo es 0.90.
 */
export function partesQueSuman(partes: number[], total: number): number[] {
  const objetivo = Math.round(total * 100);
  const crudos = partes.map((p) => p * 100);
  const base = crudos.map((c) => Math.floor(c));
  let resto = objetivo - base.reduce((s, b) => s + b, 0);
  const orden = crudos
    .map((c, i) => ({ i, frac: c - Math.floor(c) }))
    .sort((a, b) => b.frac - a.frac);
  const salida = [...base];
  let k = 0;
  while (resto > 0 && orden.length > 0) {
    salida[orden[k % orden.length].i] += 1;
    resto -= 1;
    k += 1;
  }
  while (resto < 0 && orden.length > 0) {
    salida[orden[orden.length - 1 - (k % orden.length)].i] -= 1;
    resto += 1;
    k += 1;
  }
  return salida.map((c) => c / 100);
}
