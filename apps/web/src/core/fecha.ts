const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

export function fechaCorta(d: Date): string {
  return `${DIAS[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`;
}

export function fechaLarga(d: Date): string {
  return d.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function desdeIso(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'));
  return `${d.getDate()} ${MESES[d.getMonth()]}`;
}

export function hoyLargo(): string {
  return fechaLarga(new Date());
}
