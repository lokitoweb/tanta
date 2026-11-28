import { useId, useState } from 'react';

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

/* ---------- Líneas múltiples (una serie por categoría o producto, Ene–Dic) ---------- */

// Colores categóricos que se distinguen entre sí en claro y oscuro (hasta 10 series; luego se repiten).
const PALETA = ['#8C4A2F', '#C8902E', '#4F7A5A', '#3F6A9C', '#B5533C', '#7D5BA6', '#2E8C8C', '#9C7A3C', '#6B6B6B', '#C2668A'];
export const colorSerie = (i: number) => PALETA[i % PALETA.length];

const ejeFmt = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(Math.abs(n) >= 10000 ? 0 : 1)}k` : String(Math.round(n * 100) / 100));
/** Escala «redonda» para el eje Y (incluye negativos si los hay). */
function escala(valores: number[]) {
  const max = Math.max(0, ...valores), min = Math.min(0, ...valores);
  const bruto = (max - min) / 4 || 1;
  const pot = 10 ** Math.floor(Math.log10(bruto));
  const paso = [1, 2, 2.5, 5, 10].map((k) => k * pot).find((p) => p >= bruto) ?? bruto;
  const lo = Math.floor(min / paso) * paso, hi = Math.ceil(max / paso) * paso || paso;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + paso / 2; v += paso) ticks.push(Number(v.toFixed(6)));
  return { lo, hi, ticks };
}

export function LineasMultiples({ series, etiquetas, formato, formatoEje = ejeFmt, titulo }: {
  series: Array<{ nombre: string; valores: number[] }>; etiquetas: string[]; formato: (n: number) => string; formatoEje?: (n: number) => string; titulo: string;
}) {
  const [ocultas, setOcultas] = useState<Set<string>>(new Set());
  const [punto, setPunto] = useState<number | null>(null);
  const W = 760, H = 300, PL = 58, PR = 16, PT = 14, PB = 28, iw = W - PL - PR, ih = H - PT - PB;
  const visibles = series.map((s, i) => ({ ...s, color: colorSerie(i) })).filter((s) => !ocultas.has(s.nombre));
  const { lo, hi, ticks } = escala(visibles.flatMap((s) => s.valores));
  const x = (i: number) => PL + (i * iw) / Math.max(etiquetas.length - 1, 1);
  const y = (v: number) => PT + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const alternar = (n: string) => setOcultas((o) => { const c = new Set(o); if (c.has(n)) c.delete(n); else c.add(n); return c; });

  return (
    <div className="chart">
      <div className="chart__legend chart__legend--toggle" role="group" aria-label="Mostrar u ocultar series">
        {series.map((s, i) => (
          <button key={s.nombre} type="button" className={`legend ${ocultas.has(s.nombre) ? 'is-off' : ''}`} aria-pressed={!ocultas.has(s.nombre)} onClick={() => alternar(s.nombre)}>
            <i style={{ background: colorSerie(i) }} />{s.nombre}
          </button>
        ))}
      </div>
      <div className="chart__lienzo">
        <svg viewBox={`0 0 ${W} ${H}`} className="chart__svg" role="img" aria-label={titulo} onMouseLeave={() => setPunto(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="var(--tanta-border-subtle)" strokeDasharray={t === 0 ? '0' : '3 5'} />
              <text x={PL - 8} y={y(t) + 4} textAnchor="end" className="chart__axis">{formatoEje(t)}</text>
            </g>
          ))}
          {etiquetas.map((e, i) => <text key={e} x={x(i)} y={H - 8} textAnchor="middle" className="chart__axis">{e}</text>)}
          {punto !== null && <line x1={x(punto)} x2={x(punto)} y1={PT} y2={PT + ih} stroke="var(--tanta-border-default)" />}
          {visibles.map((s) => (
            <g key={s.nombre}>
              <path d={s.valores.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} fill="none" stroke={s.color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
              {s.valores.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={punto === i ? 4.5 : 3} fill="var(--tanta-surface-card)" stroke={s.color} strokeWidth="2" />)}
            </g>
          ))}
          {/* Franjas invisibles por mes: el detalle sigue al cursor (o al toque en tablet). */}
          {etiquetas.map((e, i) => (
            <rect key={e} x={x(i) - iw / Math.max(etiquetas.length - 1, 1) / 2} y={PT} width={iw / Math.max(etiquetas.length - 1, 1)} height={ih} fill="transparent"
              onMouseEnter={() => setPunto(i)} onClick={() => setPunto(i)} />
          ))}
        </svg>
        {punto !== null && visibles.length > 0 && (
          <div className={`chart__tip ${punto >= etiquetas.length / 2 ? "chart__tip--izq" : ""}`} style={{ left: `${(x(punto) / W) * 100}%` }} role="status">
            <b>{etiquetas[punto]}</b>
            {[...visibles].sort((a, b) => b.valores[punto] - a.valores[punto]).map((s) => (
              <span key={s.nombre}><i style={{ background: s.color }} />{s.nombre}<em>{formato(s.valores[punto])}</em></span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Barras verticales (una o agrupadas), con el valor encima ---------- */

export function BarrasV({ etiquetas, series, formato, formatoEje = ejeFmt, titulo, colorNegativo = true }: {
  etiquetas: string[]; series: Array<{ nombre: string; valores: number[]; color: string }>; formato: (n: number) => string; formatoEje?: (n: number) => string; titulo: string;
  /** Una sola serie: las barras negativas en rojo de alerta. */ colorNegativo?: boolean;
}) {
  const W = 760, H = 300, PL = 58, PR = 12, PT = 22, PB = 28, iw = W - PL - PR, ih = H - PT - PB;
  const { lo, hi, ticks } = escala(series.flatMap((s) => s.valores));
  const y = (v: number) => PT + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const grupo = iw / etiquetas.length, ancho = Math.min(34, (grupo * 0.72) / series.length);
  const rojo = colorNegativo && series.length === 1;
  return (
    <div className="chart">
      {series.length > 1 && (
        <div className="chart__legend">{series.map((s) => <span key={s.nombre} className="legend"><i style={{ background: s.color }} />{s.nombre}</span>)}</div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="chart__svg" role="img" aria-label={titulo}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="var(--tanta-border-subtle)" strokeDasharray={t === 0 ? '0' : '3 5'} />
            <text x={PL - 8} y={y(t) + 4} textAnchor="end" className="chart__axis">{formatoEje(t)}</text>
          </g>
        ))}
        {etiquetas.map((e, i) => {
          const x0 = PL + i * grupo + (grupo - ancho * series.length) / 2;
          return (
            <g key={e}>
              {series.map((s, k) => {
                const v = s.valores[i], top = y(Math.max(v, 0)), alto = Math.abs(y(v) - y(0));
                const color = rojo && v < 0 ? 'var(--tanta-state-danger)' : s.color;
                return (
                  <g key={s.nombre}>
                    <rect x={x0 + k * ancho} y={top} width={ancho - 2} height={Math.max(alto, v ? 1 : 0)} rx="3" fill={color}><title>{`${s.nombre} · ${e}: ${formato(v)}`}</title></rect>
                    {v !== 0 && series.length === 1 && (
                      <text x={x0 + k * ancho + (ancho - 2) / 2} y={v >= 0 ? top - 5 : top + alto + 12} textAnchor="middle" className="chart__valor">{formatoEje(v)}</text>
                    )}
                  </g>
                );
              })}
              <text x={PL + i * grupo + grupo / 2} y={H - 8} textAnchor="middle" className="chart__axis">{e}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
