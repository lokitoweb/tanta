import { useState } from 'react';
import { api, apiArchivo } from '@/core/api';
import { Boton } from './primitives';

export interface Factura { numero: string; url: string; subidaEn?: string }

/** Descarga la factura (PDF privado) con la sesión: así un enlace copiado no abre el archivo de otro cliente. */
export async function descargarFactura(f: Factura) {
  const b = await apiArchivo(f.url);
  const u = URL.createObjectURL(b);
  const a = Object.assign(document.createElement('a'), { href: u, download: `factura-${f.numero}.pdf` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 10_000);
}

const leerPdf = (f: File) => new Promise<string>((ok, mal) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result));
  r.onerror = () => mal(new Error('No se pudo leer el PDF.'));
  r.readAsDataURL(f);
});

/**
 * Factura de SUNAT del pedido: la oficina la genera en SUNAT y sube el PDF aquí; el cliente la descarga en la app.
 * Subir otra la reemplaza (queda en la auditoría).
 */
export function FacturaPedido({ codigo, factura, puedeSubir, onCambio, onError }: {
  codigo: string; factura: Factura | null | undefined; puedeSubir: boolean; onCambio: (texto: string) => void; onError: (texto: string) => void;
}) {
  const [numero, setNumero] = useState(factura?.numero ?? '');
  const [ocupado, setOcupado] = useState(false);
  const subir = async (f: File) => {
    if (f.type && f.type !== 'application/pdf') return onError('Elige el PDF de la factura.');
    if (numero.trim().length < 3) return onError('Escribe el número de la factura (por ejemplo F001-123) antes de subirla.');
    setOcupado(true);
    try {
      await api(`/pedidos/${codigo}/factura`, { method: 'POST', body: { archivo: await leerPdf(f), numero: numero.trim() } });
      onCambio(`Factura ${numero.trim().toUpperCase()} subida a ${codigo}: el cliente ya la puede descargar.`);
    } catch (e) { onError(e instanceof Error ? e.message : 'No se pudo subir la factura.'); }
    finally { setOcupado(false); }
  };
  return (
    <div className="form form--2col form--dialogo">
      <p className="dialogo__nota field--ancho">
        {factura ? <>Factura SUNAT <b>{factura.numero}</b> · <button type="button" className="enlace" onClick={() => void descargarFactura(factura).catch((e: Error) => onError(e.message))}>Descargar PDF</button></>
          : 'Aún no tiene la factura de SUNAT.'}
      </p>
      {puedeSubir && <>
        <label className="field"><span className="field__label">N.° de factura SUNAT</span>
          <input className="field__input" maxLength={30} placeholder="F001-123" value={numero} onChange={(e) => setNumero(e.target.value)} /></label>
        <label className={`btn btn--secondary btn--md${ocupado ? ' is-disabled' : ''}`}>{ocupado ? 'Subiendo…' : factura ? 'Reemplazar PDF' : 'Subir PDF'}
          <input type="file" accept="application/pdf" hidden disabled={ocupado} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void subir(f); }} /></label>
      </>}
    </div>
  );
}
