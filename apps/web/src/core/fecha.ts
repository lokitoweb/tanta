const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

export function fechaCorta(d: Date): string {
  return `${DIAS[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`;
}

export function fechaLarga(d: Date): string {
  return d.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function desdeIso(iso: string): string {
  // Fecha sola (2026-11-29): se lee tal cual. new Date() la toma como medianoche UTC y en Lima mostraba el día anterior.
  const solo = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (solo) return `${Number(solo[3])} ${MESES[Number(solo[2]) - 1]}`;
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'));
  return `${d.getDate()} ${MESES[d.getMonth()]}`;
}

