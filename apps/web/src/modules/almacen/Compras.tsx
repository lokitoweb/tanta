import { useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { useCatalogos } from '@/core/catalogos';
import { useApp } from '@/core/app-state';
import { money } from '@/core/format';
import { Dialogo } from '@/ui/Dialogo';
import { Boton, Encabezado, Insignia, Tarjeta, TablaEsqueleto, Vacio } from '@/ui/primitives';
import type { Insumo } from '@/core/types';

interface Proveedor { id: string; codigo: string; razonSocial: string; ruc: string; estado: string; direccion: string; cuentas: Array<{ bancoNombre: string; numero: string }> }
interface PrecioAnterior { precio: number; fecha: string; proveedor: string; sinIgv: boolean }
interface Item {
  item: number; insumoId: string; insumo: string; presentacion: string; unidadBase: string; unidadInventario: string;
  cantidad: number; contenido: number; factor: number; cantidadBase: number; cantidadInventario: number;
  cantidadVerificada: number | null; observacion: string | null; lote: string | null; venceEn: string | null;
  precioUnitario?: number; precioLote?: number; costoInventario?: number;
}
type Estado = 'REGISTRADA' | 'VERIFICADA' | 'OBSERVADA' | 'EN_CORRECCION' | 'ANULADA';
interface Compra {
  codigo: string; estado: Estado; docTipo: string; serie: string; nro: string; documento: string; fecha: string; vencePago: string | null;
  condicion: 'CONTADO' | 'CREDITO'; preciosConIgv: boolean; ruc: string; direccion: string; creadoEn: string;
  proveedorId: string; proveedor: string; total: number; base: number | null; igv: number | null; observacion: string | null;
  motivoAnulacion: string | null; registradoPor: string; verificadoPor: string | null; anuladoPor: string | null; anuladoEn: string | null; items: Item[];
}
interface Linea { insumoId: string; buscar: string; cantidad: string; precioUnitario: string; lote: string; venceEn: string }
interface Form { codigo?: string; proveedorId: string; docTipo: string; serie: string; nro: string; fechaCompra: string; vencePago: string;
  condicion: 'CONTADO' | 'CREDITO'; preciosConIgv: boolean; lineas: Linea[] }

const ESTADO: Record<Estado, { texto: string; tono: 'warn' | 'ok' | 'danger' | 'info' | 'neutral' }> = {
  REGISTRADA: { texto: 'Por verificar', tono: 'warn' }, VERIFICADA: { texto: 'Verificada', tono: 'ok' }, OBSERVADA: { texto: 'Observada', tono: 'danger' },
  EN_CORRECCION: { texto: 'En corrección', tono: 'info' }, ANULADA: { texto: 'Anulada', tono: 'neutral' },
};
const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
const n4 = (x: number) => (Math.round(x * 10_000) / 10_000).toLocaleString('es-PE', { maximumFractionDigits: 4 });
const u = (x: string) => x.toLowerCase();

/**
 * Compra de insumos (informe v1.1): Compras registra en presentaciones, Almacén verifica lo recibido,
 * Administración autoriza correcciones y anula. El stock solo ingresa al verificar.
 */
export function Compras() {
  const { dataset, puede, refrescarDatos } = useApp();
  // null = cargando (esqueleto); [] = cargó y no hay compras.
  const [lista, setLista] = useState<Compra[] | null>(null);
  const [cargaError, setCargaError] = useState<string | null>(null);
  const compras = lista ?? [];
  const [filtro, setFiltro] = useState<Estado | 'todas'>('todas');
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [ver, setVer] = useState<Compra | null>(null);
  const [conteo, setConteo] = useState<Record<number, { cantidad: string; observacion: string }> | null>(null);
  const [anular, setAnular] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [anteriores, setAnteriores] = useState<Record<string, PrecioAnterior>>({});

  const registra = puede('compras.registrar');
  const docs = useCatalogos().tiposDocumento;
  const cargar = () => api<Compra[]>('/compras').then((c) => { setLista(c); setCargaError(null); }).catch((e) => setCargaError(e.message));
  useEffect(() => {
    void cargar();
    if (registra) api<Proveedor[]>('/proveedores').then((p) => setProveedores(p.filter((x) => x.estado === 'ACTIVO')))
      .catch((e) => setAviso({ tono: 'danger', texto: `No se pudieron cargar los proveedores: ${e.message}` }));
  }, []);

  const insumos = useMemo(() => dataset.insumos.filter((i) => (i as Insumo & { activo?: boolean }).activo !== false), [dataset.insumos]);
  // Búsqueda por código (SKU) o nombre: «HAR-01 · Harina panadera».
  const etiqueta = (i: Insumo) => `${i.codigo ?? ''} · ${i.nombre}${i.presentacion ? ` · ${i.presentacion}` : ''}`;
  const lineaVacia = (insumoId = ''): Linea => { const i = insumos.find((x) => x.id === insumoId); return { insumoId, buscar: i ? etiqueta(i) : '', cantidad: '', precioUnitario: '', lote: '', venceEn: '' }; };
  const cargarAnteriores = (excluir?: string) => api<Record<string, PrecioAnterior>>(`/compras/precios-anteriores${excluir ? `?excluir=${excluir}` : ''}`).then(setAnteriores).catch(() => setAnteriores({}));
  const porEstado = (e: Estado) => compras.filter((c) => c.estado === e).length;
  const filas = compras.filter((c) => filtro === 'todas' || c.estado === filtro);

  const accion = async (fn: () => Promise<string>) => {
    setOcupado(true);
    setAviso(null);
    try { const t = await fn(); await Promise.all([cargar(), refrescarDatos()]); setAviso({ tono: 'ok', texto: t }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo completar.' }); }
    finally { setOcupado(false); }
  };

  /* ------------------------------------------------------------- registro y corrección */
  const nueva = () => { void cargarAnteriores(); setForm({ proveedorId: proveedores[0]?.id ?? '', docTipo: 'FACTURA', serie: '', nro: '', fechaCompra: hoy(), vencePago: '',
    condicion: 'CONTADO', preciosConIgv: true, lineas: [lineaVacia()] }); };
  const corregir = (c: Compra) => {
    setVer(null);
    void cargarAnteriores(c.codigo);
    setForm({ codigo: c.codigo, proveedorId: c.proveedorId, docTipo: c.docTipo, serie: c.serie, nro: c.nro, fechaCompra: c.fecha, vencePago: c.vencePago ?? '',
      condicion: c.condicion ?? (c.vencePago ? 'CREDITO' : 'CONTADO'), preciosConIgv: c.preciosConIgv ?? true,
      lineas: c.items.map((i) => ({ ...lineaVacia(i.insumoId), cantidad: String(i.cantidad), precioUnitario: String(i.precioUnitario ?? ''), lote: i.lote ?? '', venceEn: i.venceEn ?? '' })) });
  };
  const linea = (i: number, cambio: Partial<Linea>) => form && setForm({ ...form, lineas: form.lineas.map((l, j) => (j === i ? { ...l, ...cambio } : l)) });
  const suma = form?.lineas.reduce((s, l) => s + Math.round(Number(l.cantidad) * Number(l.precioUnitario) * 100) / 100, 0) ?? 0;
  // Mismas reglas que el servidor: con factura los precios traen IGV (o no, si el detalle viene sin IGV); boleta y nota: sin desglose.
  const fiscal = !!form && !!docs.find((t) => t.codigo === form.docTipo)?.creditoFiscal;
  const conIgv = !fiscal || !!form?.preciosConIgv;
  const tasa = dataset.negocio.igv;
  const total = conIgv ? suma : Math.round(suma * (1 + tasa) * 100) / 100;
  const subtotal = fiscal ? (conIgv ? Math.round(total / (1 + tasa) * 100) / 100 : suma) : total;
  const prov = proveedores.find((p) => p.id === form?.proveedorId);
  const lineasOk = !!form && form.lineas.every((l) => l.insumoId && Number(l.cantidad) > 0 && Number(l.precioUnitario) > 0)
    && new Set(form.lineas.map((l) => l.insumoId)).size === form.lineas.length;
  const valido = !!form && !!form.proveedorId && /^[A-Za-z0-9]{0,4}$/.test(form.serie.trim()) && /^[A-Za-z0-9]{1,10}$/.test(form.nro.trim())
    && !!form.fechaCompra && form.fechaCompra <= hoy() && lineasOk && (form.condicion === 'CONTADO' || !!form.vencePago);
  const guardar = () => form && accion(async () => {
    const body = { proveedorId: form.proveedorId, docTipo: form.docTipo, serie: form.serie.trim(), nro: form.nro.trim(), fechaCompra: form.fechaCompra,
      vencePago: form.condicion === 'CREDITO' ? form.vencePago : '', condicion: form.condicion, preciosConIgv: conIgv,
      items: form.lineas.map((l) => ({ insumoId: l.insumoId, cantidad: Number(l.cantidad), precioUnitario: Number(l.precioUnitario), lote: l.lote.trim(), venceEn: l.venceEn })) };
    const r = await api<Compra>(form.codigo ? `/compras/${form.codigo}` : '/compras', { method: form.codigo ? 'PUT' : 'POST', body, conIdempotencia: !form.codigo });
    setForm(null);
    return `Compra ${r.codigo} ${form.codigo ? 'corregida' : 'registrada'} por ${money(r.total)}: Almacén la verificará antes de que el stock ingrese.`;
  });

  /* ------------------------------------------------------------- verificación, autorización, anulación */
  const abrirVerificar = (c: Compra) => setConteo(Object.fromEntries(c.items.map((i) => [i.item, { cantidad: String(i.cantidad), observacion: '' }])));
  const difiere = (i: Item) => !!conteo && Math.abs(Number(conteo[i.item]?.cantidad) - i.cantidad) > 1e-6;
  const conteoOk = !!ver && !!conteo && ver.items.every((i) => conteo[i.item]?.cantidad !== '' && Number(conteo[i.item]?.cantidad) >= 0
    && (!difiere(i) || conteo[i.item].observacion.trim().length >= 3));
  const verificar = (c: Compra) => accion(async () => {
    const r = await api<{ estado: Estado }>(`/compras/${c.codigo}/verificar`, { method: 'POST',
      body: { lineas: c.items.map((i) => ({ item: i.item, cantidadVerificada: Number(conteo![i.item].cantidad), observacion: conteo![i.item].observacion.trim() })) } });
    setConteo(null);
    setVer(null);
    return r.estado === 'VERIFICADA' ? `${c.codigo} verificada: el stock ya ingresó al inventario.` : `${c.codigo} observada: se avisó a Administración; el stock no ingresa.`;
  });
  const autorizar = (c: Compra) => accion(async () => {
    await api(`/compras/${c.codigo}/autorizar-correccion`, { method: 'POST' });
    setVer(null);
    return `Corrección de ${c.codigo} autorizada: Compras ya puede editarla.`;
  });
  const confirmarAnulacion = (c: Compra) => accion(async () => {
    const r = await api<{ lineasRevertidas: number }>(`/compras/${c.codigo}/anular`, { method: 'POST', body: { motivo: anular } });
    setAnular(null);
    setVer(null);
    return `${c.codigo} anulada${r.lineasRevertidas ? `: se revirtió el stock de ${r.lineasRevertidas} insumo(s)` : ''}.`;
  });

  return (
    <>
      <Encabezado titulo="Compras" descripcion="Compras registra · Almacén verifica lo recibido · el stock ingresa solo con la compra verificada"
        acciones={registra && <Boton variant="primary" icono="plus" disabled={!proveedores.length} onClick={nueva}>Registrar compra</Boton>} />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}

      <div className="toolbar">
        <div className="chips">
          <button className={`chipfilter ${filtro === 'todas' ? 'is-active' : ''}`} onClick={() => setFiltro('todas')}>Todas <b>{compras.length}</b></button>
          {(Object.keys(ESTADO) as Estado[]).map((e) => (
            <button key={e} className={`chipfilter ${filtro === e ? 'is-active' : ''}`} onClick={() => setFiltro(e)}>{ESTADO[e].texto} <b>{porEstado(e)}</b></button>
          ))}
        </div>
      </div>

      {/* ---------------------------------------------------- registrar o corregir */}
      <Dialogo abierto={form !== null} titulo={form?.codigo ? `Corregir ${form.codigo}` : 'Registrar compra'}
        descripcion={`Fecha de registro: ${hoy()} (la pone el sistema). Cantidades en presentaciones de compra (sacos, botellas); se convierten a unidad base y de inventario.`}
        onCerrar={() => setForm(null)}
        acciones={<><Boton onClick={() => setForm(null)}>Cancelar</Boton><Boton variant="primary" disabled={!valido || ocupado} onClick={() => void guardar()}>{ocupado ? 'Guardando…' : `${form?.codigo ? 'Enviar a verificación' : 'Guardar'} ${money(total)}`}</Boton></>}>
        {form && (<>
          <div className="form form--2col form--dialogo">
            <label className="field field--ancho"><span className="field__label">Proveedor</span>
              <select className="field__input" value={form.proveedorId} onChange={(e) => setForm({ ...form, proveedorId: e.target.value })}>
                {proveedores.map((p) => <option key={p.id} value={p.id}>{p.razonSocial}{p.ruc ? ` · ${p.ruc}` : ''}</option>)}</select></label>
            <label className="field"><span className="field__label">Documento</span>
              <select className="field__input" value={form.docTipo} onChange={(e) => setForm({ ...form, docTipo: e.target.value })}>{docs.map((t) => <option key={t.codigo} value={t.codigo}>{t.nombre}</option>)}</select></label>
            {prov && (
              <div className="field field--ancho dialogo__nota">
                {prov.codigo} · RUC {prov.ruc || 'no registrado'}{prov.direccion ? ` · ${prov.direccion}` : ''}
                {prov.cuentas?.length > 0 && <><br />Cuentas: {prov.cuentas.map((k) => `${k.bancoNombre} ${k.numero}`).join(' · ')}</>}
              </div>
            )}
            <label className="field"><span className="field__label">Fecha de emisión</span>
              <input className="field__input" type="date" max={hoy()} value={form.fechaCompra} onChange={(e) => setForm({ ...form, fechaCompra: e.target.value })} /></label>
            <label className="field"><span className="field__label">Serie{fiscal ? '' : ' (opcional)'}</span>
              <input className="field__input" maxLength={4} placeholder="E001" value={form.serie} onChange={(e) => setForm({ ...form, serie: e.target.value.toUpperCase() })} /></label>
            <label className="field"><span className="field__label">N.° de documento</span>
              <input className="field__input" maxLength={10} placeholder="545" value={form.nro} onChange={(e) => setForm({ ...form, nro: e.target.value.toUpperCase() })} /></label>
            <label className="field"><span className="field__label">Condición</span>
              <select className="field__input" value={form.condicion} onChange={(e) => setForm({ ...form, condicion: e.target.value as 'CONTADO' | 'CREDITO' })}>
                <option value="CONTADO">Contado</option><option value="CREDITO">Crédito</option></select></label>
            {form.condicion === 'CREDITO' && (
              <label className="field"><span className="field__label">Fecha de vencimiento del pago</span>
                <input className="field__input" type="date" min={form.fechaCompra} value={form.vencePago} onChange={(e) => setForm({ ...form, vencePago: e.target.value })} /></label>
            )}
            {fiscal && (
              <label className="check field--ancho"><input type="checkbox" checked={form.preciosConIgv} onChange={(e) => setForm({ ...form, preciosConIgv: e.target.checked })} />
                Los precios del documento incluyen IGV (desmárcalo si el detalle viene sin IGV)</label>
            )}
          </div>
          <datalist id="insumos-compra">{insumos.map((x) => <option key={x.id} value={etiqueta(x)} />)}</datalist>
          {form.lineas.map((l, i) => {
            const ins = insumos.find((x) => x.id === l.insumoId);
            const contenido = ins?.contenido ?? 1, factor = ins?.factor ?? 1;
            const cant = Number(l.cantidad), precio = Number(l.precioUnitario);
            const uInv = u(ins?.unidadInventario ?? ins?.unidad ?? '');
            // Mismo cálculo que el servidor: con crédito fiscal el costo va sin IGV (la tasa viene del parámetro igv).
            const sinIgv = fiscal && conIgv ? 1 / (1 + tasa) : 1;
            const ant = anteriores[l.insumoId];
            const delta = ant && precio > 0 ? (precio - ant.precio) / ant.precio : null;
            return (
              <div key={i} className="linea-compra">
                <div className="form form--2col">
                  <label className="field field--ancho"><span className="field__label">Insumo {i + 1} · busca por código o nombre</span>
                    <input className="field__input" list="insumos-compra" placeholder="HAR-01 o harina" value={l.buscar}
                      onChange={(e) => { const x = insumos.find((y) => etiqueta(y) === e.target.value); linea(i, { buscar: e.target.value, insumoId: x?.id ?? '' }); }} />
                    {!l.insumoId && l.buscar && <span className="field__aviso">Elige un insumo de la lista</span>}</label>
                  <label className="field"><span className="field__label">Cantidad ({ins?.presentacion || `de ${n4(contenido)} ${u(ins?.unidad ?? '')}`})</span>
                    <input className="field__input" type="number" min="0" step="any" value={l.cantidad} onChange={(e) => linea(i, { cantidad: e.target.value })} /></label>
                  <label className="field"><span className="field__label">Precio unitario (S/{fiscal ? (conIgv ? ', inc. IGV' : ', sin IGV') : ''})</span>
                    <input className="field__input" type="number" min="0" step="any" value={l.precioUnitario} onChange={(e) => linea(i, { precioUnitario: e.target.value })} />
                    {ant && <span className={`field__ayuda ${delta !== null && delta > 0.0001 ? 'precio-sube' : delta !== null && delta < -0.0001 ? 'precio-baja' : ''}`}>
                      P. anterior {money(ant.precio)} ({ant.fecha}, {ant.proveedor}){delta !== null && Math.abs(delta) > 0.0001 ? ` · ${delta > 0 ? '▲ sube' : '▼ baja'} ${(Math.abs(delta) * 100).toFixed(1)} %` : ''}</span>}</label>
                  <label className="field"><span className="field__label">Precio total de la línea (S/)</span>
                    <input className="field__input" type="number" min="0" step="any" value={cant > 0 && precio > 0 ? String(Math.round(cant * precio * 100) / 100) : ''}
                      onChange={(e) => cant > 0 && linea(i, { precioUnitario: String(Math.round(Number(e.target.value) / cant * 10_000) / 10_000) })}
                      disabled={!(cant > 0)} placeholder={cant > 0 ? '' : 'Primero la cantidad'} /></label>
                  <label className="field"><span className="field__label">Lote (opcional)</span>
                    <input className="field__input" maxLength={40} value={l.lote} onChange={(e) => linea(i, { lote: e.target.value.toUpperCase() })} /></label>
                  <label className="field"><span className="field__label">Vence (opcional)</span>
                    <input className="field__input" type="date" min={hoy()} value={l.venceEn} onChange={(e) => linea(i, { venceEn: e.target.value })} /></label>
                </div>
                {ins && cant > 0 && (
                  <p className="linea-compra__conv">
                    {n4(cant)} × {n4(contenido)} {u(ins.unidad)} = <b>{n4(cant * contenido)} {u(ins.unidad)}</b> · × {n4(factor)} = <b>{n4(cant * contenido * factor)} {uInv}</b> al inventario
                    {precio > 0 && <> · <b>{money(precio * sinIgv / (contenido * factor))}</b> por {uInv}{sinIgv < 1 ? ' sin IGV' : ''} · importe {money(cant * precio)}</>}
                  </p>
                )}
                {form.lineas.length > 1 && <Boton onClick={() => setForm({ ...form, lineas: form.lineas.filter((_, j) => j !== i) })}>Quitar insumo</Boton>}
              </div>
            );
          })}
          <div className="form__acciones">
            {!lineasOk && <span className="field__aviso">Cantidad y precio mayores a cero, sin insumos repetidos</span>}
            <Boton icono="plus" onClick={() => setForm({ ...form, lineas: [...form.lineas, lineaVacia()] })}>Agregar insumo</Boton>
          </div>
          <div className="totales-compra">
            {fiscal && <><span>Subtotal</span><b>{money(subtotal)}</b><span>IGV</span><b>{money(total - subtotal)}</b></>}
            <span>Total</span><b>{money(total)}</b>
          </div>
        </>)}
      </Dialogo>

      {/* ---------------------------------------------------- detalle y acciones por rol */}
      <Dialogo abierto={ver !== null} titulo={ver ? `${ver.codigo} · ${ESTADO[ver.estado].texto}` : ''}
        descripcion={ver ? `${ver.proveedor}${ver.ruc ? ` (RUC ${ver.ruc})` : ''} · ${ver.documento} · emitido ${ver.fecha} · registrado ${ver.creadoEn?.slice(0, 10) ?? ''} por ${ver.registradoPor} · ${ver.condicion === 'CREDITO' ? `crédito, vence ${ver.vencePago ?? ''}` : 'contado'}${ver.verificadoPor ? ` · verificó ${ver.verificadoPor}` : ''}` : ''}
        onCerrar={() => { setVer(null); setConteo(null); setAnular(null); }}
        acciones={ver && (<>
          {anular === null && ver.estado !== 'ANULADA' && puede('compras.anular') && <Boton onClick={() => setAnular('')}>Anular</Boton>}
          {ver.estado === 'OBSERVADA' && puede('compras.autorizar') && <Boton variant="primary" disabled={ocupado} onClick={() => void autorizar(ver)}>Autorizar corrección</Boton>}
          {['REGISTRADA', 'EN_CORRECCION'].includes(ver.estado) && registra && <Boton onClick={() => corregir(ver)}>{ver.estado === 'EN_CORRECCION' ? 'Corregir' : 'Editar'}</Boton>}
          {ver.estado === 'REGISTRADA' && puede('compras.verificar') && !conteo && <Boton variant="primary" onClick={() => abrirVerificar(ver)}>Verificar lo recibido</Boton>}
          {conteo && <Boton variant="primary" disabled={!conteoOk || ocupado} onClick={() => void verificar(ver)}>
            {ver.items.some((i) => difiere(i)) ? 'Observar compra' : 'Confirmar e ingresar al almacén'}</Boton>}
          {anular !== null && <Boton variant="primary" disabled={anular.trim().length < 5 || ocupado} onClick={() => void confirmarAnulacion(ver)}>Confirmar anulación</Boton>}
        </>)}>
        {ver && (<>
          {ver.observacion && <div className="aviso aviso--danger"><span className="aviso__icono">!</span><div><p>Observación de Almacén: {ver.observacion}</p></div></div>}
          {ver.motivoAnulacion && <p className="dialogo__nota">Anulada por {ver.anuladoPor} el {ver.anuladoEn?.slice(0, 16).replace('T', ' ')}: {ver.motivoAnulacion}</p>}
          <div className="table-wrap"><table className="table table--compacta">
            <thead><tr><th>Insumo</th><th className="t-right">Documento</th><th className="t-right">Unidad base</th><th className="t-right">Inventario</th>
              {ver.items[0]?.costoInventario !== undefined && <th className="t-right">Costo</th>}
              {ver.estado === 'REGISTRADA' && <><th className="t-right">Stock actual</th><th className="t-right">Stock esperado</th></>}
              <th className="t-right">{conteo ? 'Contado' : 'Verificado'}</th></tr></thead>
            <tbody>{ver.items.map((i) => (
              <tr key={i.item}>
                <td>{dataset.insumos.find((x) => x.id === i.insumoId)?.codigo ?? ''} · {i.insumo}<br /><small className="t-muted">{i.presentacion || `${n4(i.contenido)} ${u(i.unidadBase)} c/u`}{i.lote ? ` · lote ${i.lote}` : ''}</small></td>
                <td className="t-right">{n4(i.cantidad)}{i.precioUnitario !== undefined && <><br /><small className="t-muted">{money(i.precioUnitario)} c/u</small></>}</td>
                <td className="t-right">{n4(i.cantidadBase)} {u(i.unidadBase)}</td>
                <td className="t-right"><b>{n4(i.cantidadInventario)} {u(i.unidadInventario)}</b></td>
                {i.costoInventario !== undefined && <td className="t-right">{money(i.costoInventario)}/{u(i.unidadInventario)}</td>}
                {ver.estado === 'REGISTRADA' && (() => {
                  // Validar ingreso (Excel): stock de hoy y el que quedará al ingresar lo contado.
                  const stock = dataset.insumos.find((x) => x.id === i.insumoId)?.stock ?? 0;
                  const contado = conteo ? Number(conteo[i.item]?.cantidad) : i.cantidad;
                  const ingreso = i.cantidad > 0 ? i.cantidadInventario * (contado / i.cantidad) : 0;
                  return <><td className="t-right">{n4(stock)} {u(i.unidadInventario)}</td><td className="t-right"><b>{n4(stock + (Number.isFinite(ingreso) ? ingreso : 0))}</b></td></>;
                })()}
                <td className="t-right">{conteo ? (
                  <div className="conteo-linea">
                    <input className="field__input t-right" type="number" min="0" step="any" aria-label={`Cantidad contada de ${i.insumo}`} value={conteo[i.item]?.cantidad ?? ''}
                      onChange={(e) => setConteo({ ...conteo, [i.item]: { ...conteo[i.item], cantidad: e.target.value } })} />
                    {difiere(i) && <input className="field__input" maxLength={200} placeholder="Motivo de la diferencia" value={conteo[i.item].observacion}
                      onChange={(e) => setConteo({ ...conteo, [i.item]: { ...conteo[i.item], observacion: e.target.value } })} />}
                  </div>
                ) : i.cantidadVerificada === null ? '—' : <span className={Math.abs(i.cantidadVerificada - i.cantidad) > 1e-6 ? 't-neg' : ''}>{n4(i.cantidadVerificada)}{i.observacion ? ` · ${i.observacion}` : ''}</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
          {ver.items[0]?.costoInventario !== undefined && <p className="dialogo__nota">Total {money(ver.total)}{ver.base !== null ? ` · base ${money(ver.base)} · IGV ${money(ver.igv ?? 0)}` : ''}{ver.vencePago ? ` · vence el pago ${ver.vencePago}` : ''}</p>}
          {conteo && <p className="dialogo__nota">Cuenta en presentaciones (botellas, sacos). Si algo no coincide, la compra queda observada y el stock no ingresa.</p>}
          {anular !== null && (
            <label className="field"><span className="field__label">Motivo de la anulación{ver.estado === 'VERIFICADA' ? ' (se revierte el stock ingresado)' : ''}</span>
              <input className="field__input" autoFocus maxLength={300} value={anular} onChange={(e) => setAnular(e.target.value)} /></label>
          )}
        </>)}
      </Dialogo>

      <Tarjeta padding="none">
        {cargaError ? <Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={() => { setCargaError(null); setLista(null); void cargar(); }} />
          : lista === null ? <TablaEsqueleto columnas={7} />
          : !filas.length ? <Vacio titulo="Sin compras en este estado" icono="sack" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Código</th><th>Emisión</th><th>Proveedor</th><th>Documento</th><th>Condición</th><th className="t-right">Insumos</th><th className="t-right">Total</th><th>Estado</th></tr></thead>
            <tbody>{filas.map((c) => (
              <tr key={c.codigo} className="is-clickable" onClick={() => { setConteo(null); setAnular(null); setVer(c); }}>
                <td><strong>{c.codigo}</strong></td><td>{c.fecha}</td><td>{c.proveedor}</td><td>{c.documento}</td><td>{c.condicion === 'CREDITO' ? `Crédito${c.vencePago ? ` · ${c.vencePago}` : ''}` : 'Contado'}</td>
                <td className="t-right">{c.items.length}</td><td className="t-right">{money(c.total)}</td>
                <td><Insignia tono={ESTADO[c.estado].tono} punto>{ESTADO[c.estado].texto}</Insignia></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Tarjeta>
    </>
  );
}
