import { useId } from 'react';

const SERIE = ['var(--tanta-ink-800)', 'var(--tanta-sand-500)', 'var(--tanta-olive-600)', 'var(--tanta-honey-500)', 'var(--tanta-clay-600)'];

/* ---------- Área / línea ---------- */

interface Punto { label: string; a: number; b?: number }

export function AreaSerie({ datos, alto = 240, etiquetaA = 'Ventas netas', etiquetaB, formato }: {
  datos: Punto[]; alto?: number; etiquetaA?: string; etiquetaB?: string; formato?: (n: number) => string;
}) {
  const id = useId().replace(/:/g, '');
  const W = 720, H = alto, PL = 54, PR = 12, PT = 14, PB = 26;
  const iw = W - PL - PR, ih = H - PT - PB;
  const max = Math.max(...datos.map((d) => Math.max(d.a, d.b ?? 0))) * 1.08 || 1;
  const x = (i: number) => PL + (datos.length <= 1 ? iw / 2 : (i * iw) / (datos.length - 1));
  const y = (v: number) => PT + ih - (v / max) * ih;
  const linea = (k: 'a' | 'b') => datos.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y((d[k] ?? 0)).toFixed(1)}`).join(' ');
  const area = (k: 'a' | 'b') => `${linea(k)} L${x(datos.length - 1).toFixed(1)},${PT + ih} L${PL},${PT + ih} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => max * t);
  const fmt = formato ?? ((n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n))));
  const paso = Math.ceil(datos.length / 6);

  return (
    <div className="chart">
      <div className="chart__legend">
        <span className="legend"><i style={{ background: SERIE[0] }} />{etiquetaA}</span>
        {etiquetaB && <span className="legend"><i style={{ background: SERIE[1] }} />{etiquetaB}</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart__svg" role="img" aria-label={`${etiquetaA} por día`}>
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--tanta-ink-800)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--tanta-ink-800)" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="var(--tanta-border-subtle)" strokeWidth="1" strokeDasharray={i === 0 ? '0' : '3 5'} />
            <text x={PL - 10} y={y(t) + 4} textAnchor="end" className="chart__axis">{fmt(t)}</text>
          </g>
        ))}
        <path d={area('a')} fill={`url(#g${id})`} />
        <path d={linea('a')} fill="none" stroke={SERIE[0]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {etiquetaB && <path d={linea('b')} fill="none" stroke={SERIE[1]} strokeWidth="1.8" strokeDasharray="5 4" strokeLinejoin="round" />}
        {datos.map((d, i) => (
          (i % paso === 0 || i === datos.length - 1) && (
            <text key={i} x={x(i)} y={H - 6} textAnchor="middle" className="chart__axis">{d.label}</text>
          )
        ))}
      </svg>
    </div>
  );
}

/* ---------- Barras horizontales ---------- */

export function BarrasH({ filas, formato, altoFila = 34 }: {
  filas: Array<{ label: string; valor: number; nota?: string; tono?: 'ok' | 'warn' | 'danger' }>;
  formato?: (n: number) => string; altoFila?: number;
}) {
  const max = Math.max(...filas.map((f) => f.valor), 1);
  const fmt = formato ?? ((n: number) => String(Math.round(n)));
  return (
    <div className="barsh">
      {filas.map((f) => (
        <div className="barsh__row" key={f.label} style={{ minHeight: altoFila }}>
          <span className="barsh__label" title={f.label}>{f.label}</span>
          <div className="barsh__track">
            <div className={`barsh__bar barsh__bar--${f.tono ?? 'ink'}`} style={{ width: `${(f.valor / max) * 100}%` }} />
          </div>
          <span className="barsh__value">{fmt(f.valor)}</span>
          {f.nota && <span className="barsh__nota">{f.nota}</span>}
        </div>
      ))}
    </div>
  );
}

/* ---------- Dona ---------- */

export function Dona({ partes, centro, sub }: { partes: Array<{ label: string; valor: number }>; centro: string; sub?: string }) {
  const total = partes.reduce((s, p) => s + p.valor, 0) || 1;
  const R = 64, STROKE = 26, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="dona">
      <svg viewBox="0 0 170 170" className="dona__svg">
        <circle cx="85" cy="85" r={R} fill="none" stroke="var(--tanta-cream-200)" strokeWidth={STROKE} />
        {partes.map((p, i) => {
          const frac = p.valor / total;
          const dash = frac * C;
          const el = (
            <circle key={p.label} cx="85" cy="85" r={R} fill="none"
              stroke={SERIE[i % SERIE.length]} strokeWidth={STROKE}
              strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-offset}
              transform="rotate(-90 85 85)" strokeLinecap="butt" />
          );
          offset += dash;
          return el;
        })}
        <text x="85" y="82" textAnchor="middle" className="dona__centro">{centro}</text>
        {sub && <text x="85" y="101" textAnchor="middle" className="dona__sub">{sub}</text>}
      </svg>
      <ul className="dona__leyenda">
        {partes.map((p, i) => (
          <li key={p.label}>
            <i style={{ background: SERIE[i % SERIE.length] }} />
            <span>{p.label}</span>
            <b>{Math.round((p.valor / total) * 100)} %</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- Sparkline ---------- */

export function Sparkline({ valores, tono = 'ink' }: { valores: number[]; tono?: 'ink' | 'ok' | 'danger' }) {
  const W = 96, H = 26;
  const max = Math.max(...valores), min = Math.min(...valores);
  const rango = max - min || 1;
  const pts = valores.map((v, i) => `${(i * W) / (valores.length - 1)},${H - ((v - min) / rango) * (H - 4) - 2}`).join(' ');
  const color = tono === 'ok' ? 'var(--tanta-state-ok)' : tono === 'danger' ? 'var(--tanta-state-danger)' : 'var(--tanta-sand-500)';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="spark" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
