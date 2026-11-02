import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { useApp } from '@/core/app-state';
import { api } from '@/core/api';
import { Dialogo } from '@/ui/Dialogo';
import { money, num, num2, pct } from '@/core/format';
import { Boton, Encabezado, Insignia, Kpi, Buscador, Tarjeta, Vacio } from '@/ui/primitives';
import { Tabla, type Columna } from '@/ui/Tabla';
import type { Insumo } from '@/core/types';

export function Almacen() {
  const { dataset, puede, refrescarDatos } = useApp();
  const [registrar, setRegistrar] = useState(false);
  const navegar = useNavigate();
  // Misma regla que el API (PDF 3.3): valorización para Gerencia/Admin y Almacén.
  const verValor = puede('costos.ver') || puede('inventario.mover');
  const [q, setQ] = useState('');

  const insumos = useMemo(
    () => dataset.insumos.filter((i) => i.nombre.toLowerCase().includes(q.toLowerCase())),
    [dataset.insumos, q],
  );

  const bajos = dataset.insumos.filter((i) => i.estado === 'BAJO_MINIMO');
  const valorTotal = dataset.insumos.reduce((s, i) => s + i.valorizado, 0);

  const todas: Array<Columna<Insumo>> = [
    {
      key: 'nombre', header: 'Insumo',
      render: (i) => (
        <div className="celda-doble">
          <strong>{i.nombre}</strong>
          <span>{i.codigo ?? i.id} · {i.proveedor}</span>
        </div>
      ),
    },
    { key: 'stock', header: 'Stock', align: 'right', render: (i) => <strong>{num2(i.stock)} {i.unidad}</strong> },
    { key: 'minimo', header: 'Mínimo', align: 'right', render: (i) => <span className="t-muted">{num(i.minimo)}</span> },
    { key: 'cpp', header: 'CPP', align: 'right', render: (i) => money(i.cpp) },
    { key: 'valorizado', header: 'Valorizado', align: 'right', render: (i) => money(i.valorizado) },
    {
      key: 'estado', header: 'Estado', align: 'right',
      render: (i) => i.estado === 'BAJO_MINIMO'
        ? <Insignia tono="danger" punto>Bajo mínimo</Insignia>
        : <Insignia tono="ok" punto>Disponible</Insignia>,
    },
  ];
  const columnas = todas.filter((c) => verValor || (c.key !== 'cpp' && c.key !== 'valorizado'));

  return (
    <>
      <Encabezado
        titulo="Almacén e inventario"
        descripcion="Stock de insumos y productos terminados, valorizado al costo promedio ponderado"
        acciones={<><Boton icono="download" onClick={() => exportarExcel('inventario', insumos.map((i) => ({ codigo: i.codigo ?? i.id, insumo: i.nombre, unidad: i.unidad, stock: i.stock, minimo: i.minimo, ...(verValor ? { cpp: i.cpp, valorizado: i.valorizado } : {}), estado: i.estado })))}>Excel</Boton><Boton icono="report" onClick={exportarPdf}>PDF</Boton>{puede('inventario.mover') && <Boton variant="primary" icono="plus" onClick={() => setRegistrar(true)}>Registrar movimiento</Boton>}</>}
      />

      <div className="grid grid--auto">
        <Kpi label="Insumos activos" valor={num(dataset.insumos.length)} nota={`${bajos.length} bajo mínimo`} icono="sack" />
        {verValor && <Kpi label="Valor del stock" valor={money(valorTotal)} nota="costo promedio ponderado" icono="wallet" />}
        <Kpi label="Movimientos recientes" valor={num(dataset.movimientos.length)} nota="kárdex inmutable" icono="ledger" />
        {verValor && <Kpi label="Merma valorizada" valor={money(dataset.kpis.mermaValorizada)} nota={pct(dataset.kpis.mermaPct) + ' de la producción'} icono="alert" />}
      </div>

      {bajos.length > 0 && (
        <div className="aviso aviso--danger">
          <IconoAlerta />
          <div>
            <strong>{bajos.length} insumos bajo el stock mínimo</strong>
            <p>{bajos.map((b) => b.nombre).join(' · ')}</p>
          </div>
          {puede('reportes.ver') && <Boton size="sm" onClick={() => navegar('/gerencia/reportes?r=A-02')}>Ver reposición sugerida</Boton>}
        </div>
      )}

      <Tarjeta padding="none">
        <div className="card__head card__head--padded">
          <div>
            <h3 className="card__title">Insumos</h3>
            <p className="card__sub">El costo promedio ponderado se recalcula en cada compra</p>
          </div>
          <Buscador valor={q} onChange={setQ} placeholder="Buscar insumo…" />
        </div>
        <Tabla
          columnas={columnas}
          filas={insumos}
          clave={(i) => i.id}
          vacio={<Vacio titulo="Sin resultados" detalle="Prueba con otro nombre de insumo." icono="sack" />}
        />
      </Tarjeta>

      {registrar && (
        <RegistrarMovimiento insumos={dataset.insumos} onCerrar={() => setRegistrar(false)}
          onListo={async () => { setRegistrar(false); await refrescarDatos(); }} />
      )}
    </>
  );
}

type TipoMov = 'COMPRA' | 'MERMA' | 'CONTEO';
const TIPOS_MOV: Record<TipoMov, string> = { COMPRA: 'Compra (ingreso)', MERMA: 'Baja / merma', CONTEO: 'Toma de inventario físico' };

/** Compra, baja con motivo o conteo físico. El servidor valida, recalcula el CPP y audita. */
function RegistrarMovimiento({ insumos, onCerrar, onListo }: { insumos: Insumo[]; onCerrar: () => void; onListo: () => Promise<void> }) {
  const [tipo, setTipo] = useState<TipoMov>('COMPRA');
  const [insumoId, setInsumoId] = useState(insumos[0]?.id ?? '');
  const [cantidad, setCantidad] = useState('');
  const [costo, setCosto] = useState('');
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState<string>();
  const [trabajando, setTrabajando] = useState(false);
  const ins = insumos.find((i) => i.id === insumoId);
  const n = Number(cantidad);
  const valido = insumoId && cantidad !== '' && n >= 0 && (tipo === 'CONTEO' || n > 0)
    && (tipo !== 'COMPRA' || Number(costo) > 0) && motivo.trim().length >= 3;

  const guardar = async () => {
    setError(undefined);
    setTrabajando(true);
    try {
      const body = tipo === 'CONTEO'
        ? { tipo, insumoId, cantidadContada: n, motivo }
        : { tipo, insumoId, cantidad: n, motivo, ...(tipo === 'COMPRA' ? { costoUnitario: Number(costo) } : {}) };
      await api('/inventario/movimientos', { method: 'POST', body, conIdempotencia: true });
      await onListo();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^STOCK_INSUFICIENTE:/, 'Stock insuficiente: ') : 'No se pudo registrar.');
    } finally {
      setTrabajando(false);
    }
  };

  return (
    <Dialogo
      abierto
      titulo="Registrar movimiento de insumo"
      descripcion="Queda en el kárdex con tu usuario y no se puede editar ni borrar."
      onCerrar={onCerrar}
      acciones={<>
        <Boton onClick={onCerrar}>Cancelar</Boton>
        <Boton variant="primary" onClick={() => void guardar()} disabled={!valido || trabajando}>{trabajando ? 'Registrando…' : 'Registrar'}</Boton>
      </>}
    >
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (valido) void guardar(); }}>
        <label className="field"><span className="field__label">Tipo</span>
          <select className="field__input" value={tipo} onChange={(e) => setTipo(e.target.value as TipoMov)}>
            {(Object.keys(TIPOS_MOV) as TipoMov[]).map((t) => <option key={t} value={t}>{TIPOS_MOV[t]}</option>)}
          </select>
        </label>
        <label className="field"><span className="field__label">Insumo</span>
          <select className="field__input" value={insumoId} onChange={(e) => setInsumoId(e.target.value)}>
            {insumos.map((i) => <option key={i.id} value={i.id}>{i.nombre} · stock {num2(i.stock)} {i.unidad}</option>)}
          </select>
        </label>
        <label className="field"><span className="field__label">{tipo === 'CONTEO' ? `Cantidad contada (${ins?.unidad ?? ''})` : `Cantidad (${ins?.unidad ?? ''})`}</span>
          <input className="field__input" type="number" inputMode="decimal" min="0" step="0.001" required value={cantidad} onChange={(e) => setCantidad(e.target.value)} />
        </label>
        {tipo === 'CONTEO' && ins && cantidad !== '' && (
          <p className="dialogo__nota">Diferencia contra el sistema: <strong>{num2(n - ins.stock)} {ins.unidad}</strong> (se registra como ajuste).</p>
        )}
        {tipo === 'COMPRA' && (
          <label className="field"><span className="field__label">Costo unitario sin IGV (S/)</span>
            <input className="field__input" type="number" inputMode="decimal" min="0.0001" step="0.0001" required value={costo} onChange={(e) => setCosto(e.target.value)} />
          </label>
        )}
        <label className="field"><span className="field__label">{tipo === 'COMPRA' ? 'Proveedor / N.° de guía' : 'Motivo'}</span>
          <input className="field__input" maxLength={200} required value={motivo} onChange={(e) => setMotivo(e.target.value)}
            placeholder={tipo === 'MERMA' ? 'Vencimiento, rotura, humedad…' : tipo === 'CONTEO' ? 'Inventario mensual' : 'Molinos del Sur · GR 001-2345'} />
        </label>
        {error && <p className="form__error" role="alert">{error}</p>}
      </form>
    </Dialogo>
  );
}

function IconoAlerta() {
  return <span className="aviso__icono">!</span>;
}
