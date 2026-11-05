import { useEffect, useState } from 'react';
import { leerConfigPublica, urlApi, type ConfigPublica } from '@/core/api';
import type { ReactNode } from 'react';
import { Icon, type NombreIcono } from './icons';

/* ---------- Marca ---------- */

/** Logo subido por el superadmin si existe; si no, el wordmark de texto. */
export function BrandMark({ variant = 'light', size = 'md' }: { variant?: 'light' | 'dark'; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const [cfg, setCfg] = useState<ConfigPublica | null>(null);
  useEffect(() => {
    const leer = () => { leerConfigPublica().then(setCfg).catch(() => {}); };
    leer();
    window.addEventListener('tanta:config', leer);
    return () => window.removeEventListener('tanta:config', leer);
  }, []);
  if (cfg?.marca.logoId) {
    return <img className={`brandmark-img brandmark-img--${size} brandmark-img--${variant}`} src={urlApi(`/archivos/${cfg.marca.logoId}`)} alt={cfg.marca.nombreApp} />;
  }
  return (
    <div className={`brandmark brandmark--${variant} brandmark--${size}`}>
      <span className="brandmark__word">{(cfg?.marca.nombreApp ?? 'Tanta').toUpperCase()}</span>
      {cfg?.negocio?.claim && <span className="brandmark__pill">{cfg.negocio.claim.toUpperCase()}</span>}
    </div>
  );
}

/* ---------- Botón ---------- */

interface BtnProps {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icono?: NombreIcono;
  iconoDer?: NombreIcono;
  full?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}

export function Boton({ children, variant = 'secondary', size = 'md', icono, iconoDer, full, onClick, disabled, type = 'button', title }: BtnProps) {
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`btn btn--${variant} btn--${size} ${full ? 'btn--full' : ''}`}
    >
      {icono && <Icon name={icono} size={size === 'lg' ? 20 : 16} />}
      <span>{children}</span>
      {iconoDer && <Icon name={iconoDer} size={size === 'lg' ? 20 : 16} />}
    </button>
  );
}

/* ---------- Tarjeta ---------- */

export function Tarjeta({ children, className = '', padding = 'normal' }: { children: ReactNode; className?: string; padding?: 'none' | 'normal' | 'amplio' }) {
  return <section className={`card card--${padding} ${className}`}>{children}</section>;
}

export function TarjetaTitulo({ titulo, subtitulo, accion }: { titulo: string; subtitulo?: string; accion?: ReactNode }) {
  return (
    <header className="card__head">
      <div>
        <h3 className="card__title">{titulo}</h3>
        {subtitulo && <p className="card__sub">{subtitulo}</p>}
      </div>
      {accion}
    </header>
  );
}

/* ---------- Insignia ---------- */

export type Tono = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'ink';

export function Insignia({ children, tono = 'neutral', punto = false }: { children: ReactNode; tono?: Tono; punto?: boolean }) {
  return (
    <span className={`badge badge--${tono}`}>
      {punto && <i className="badge__dot" />}
      {children}
    </span>
  );
}

/* ---------- KPI ---------- */

export function Kpi({ label, valor, delta, deltaTono, nota, icono }: { label: string; valor: string; delta?: string; deltaTono?: 'up' | 'down' | 'flat'; nota?: string; icono?: NombreIcono }) {
  return (
    <div className="kpi">
      <div className="kpi__top">
        <span className="kpi__label">{label}</span>
        {icono && <span className="kpi__icon"><Icon name={icono} size={16} /></span>}
      </div>
      <div className="kpi__value">{valor}</div>
      <div className="kpi__foot">
        {delta && (
          <span className={`kpi__delta kpi__delta--${deltaTono ?? 'flat'}`}>
            <Icon name={deltaTono === 'down' ? 'down' : 'up'} size={13} />
            {delta}
          </span>
        )}
        {nota && <span className="kpi__nota">{nota}</span>}
      </div>
    </div>
  );
}

/* ---------- Barra de progreso ---------- */

export function Progreso({ valor, tono = 'ink' }: { valor: number; tono?: 'ink' | 'ok' | 'warn' | 'danger' }) {
  const p = Math.max(0, Math.min(1, valor));
  return (
    <div className="progress">
      <div className={`progress__fill progress__fill--${tono}`} style={{ width: `${p * 100}%` }} />
    </div>
  );
}

/* ---------- Segmentado ---------- */

export function Segmentado<T extends string>({ opciones, valor, onChange }: { opciones: Array<{ id: T; etiqueta: string }>; valor: T; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {opciones.map((o) => (
        <button key={o.id} role="tab" aria-selected={o.id === valor}
          className={`segmented__item ${o.id === valor ? 'is-active' : ''}`}
          onClick={() => onChange(o.id)}>
          {o.etiqueta}
        </button>
      ))}
    </div>
  );
}

/* ---------- Buscador ---------- */

export function Buscador({ valor, onChange, placeholder = 'Buscar…' }: { valor: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="search">
      <Icon name="search" size={16} />
      <input value={valor} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      {valor && (
        <button className="search__clear" onClick={() => onChange('')} aria-label="Limpiar">
          <Icon name="close" size={14} />
        </button>
      )}
    </label>
  );
}

/* ---------- Encabezado de página ---------- */

export function Encabezado({ titulo, descripcion, acciones }: { titulo: string; descripcion?: string; acciones?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-head__title">{titulo}</h1>
        {descripcion && <p className="page-head__desc">{descripcion}</p>}
      </div>
      {acciones && <div className="page-head__actions">{acciones}</div>}
    </div>
  );
}

/* ---------- Vacío ---------- */

export function Vacio({ titulo, detalle, icono = 'box', onReintentar }: { titulo: string; detalle?: string; icono?: NombreIcono; onReintentar?: () => void }) {
  return (
    <div className="empty" role={onReintentar ? 'alert' : undefined}>
      <div className="empty__icon"><Icon name={icono} size={22} /></div>
      <p className="empty__title">{titulo}</p>
      {detalle && <p className="empty__text">{detalle}</p>}
      {onReintentar && <div className="empty__accion"><Boton onClick={onReintentar}>Reintentar</Boton></div>}
    </div>
  );
}

/* ---------- Esqueletos de carga ---------- */

/** Bloque gris animado con la forma del contenido que viene (texto, título, KPI o bloque). */
export function Esqueleto({ variante = 'texto', ancho }: { variante?: 'texto' | 'titulo' | 'kpi' | 'bloque'; ancho?: string | number }) {
  return <span className={'esq esq--' + variante} style={ancho !== undefined ? { width: ancho } : undefined} aria-hidden="true" />;
}

/** Tabla de carga: misma grilla que la real, con anchos variados para que se lea natural. */
export function TablaEsqueleto({ filas = 6, columnas = 5 }: { filas?: number; columnas?: number }) {
  const anchos = ['70%', '55%', '85%', '40%', '62%'];
  return (
    <div className="table-wrap" aria-busy="true" aria-label="Cargando">
      <table className="table esq-tabla">
        <thead><tr>{Array.from({ length: columnas }, (_, i) => <th key={i}><Esqueleto ancho="50%" /></th>)}</tr></thead>
        <tbody>{Array.from({ length: filas }, (_, f) => (
          <tr key={f}>{Array.from({ length: columnas }, (_, c) => <td key={c}><Esqueleto ancho={anchos[(f + c) % anchos.length]} /></td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/** Pila de líneas para tarjetas y formularios que cargan. */
export function PilaEsqueleto({ lineas = 4 }: { lineas?: number }) {
  return <div className="esq-pila" aria-busy="true" aria-label="Cargando">{Array.from({ length: lineas }, (_, i) => <Esqueleto key={i} ancho={i === 0 ? '45%' : ['90%', '75%', '82%'][i % 3]} />)}</div>;
}

/* ---------- Avatar ---------- */

export function Avatar({ nombre, size = 'md', fotoUrl }: { nombre: string; size?: 'sm' | 'md' | 'lg'; fotoUrl?: string | null }) {
  if (fotoUrl) return <img className={`avatar avatar--${size} avatar--foto`} src={urlApi(fotoUrl)} alt={nombre} />;
  const ini = nombre.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');
  return <span className={`avatar avatar--${size}`}>{ini}</span>;
}
