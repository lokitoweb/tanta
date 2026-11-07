import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiArchivo } from '@/core/api';
import { Dialogo } from './Dialogo';
import { Boton, PilaEsqueleto } from './primitives';

/** Abre un comprobante privado en un modal, dentro del sistema. La imagen se pide con la sesión y se libera al cerrar. */
export function VerComprobante({ url, texto = 'Ver comprobante', titulo = 'Comprobante' }: { url: string; texto?: string; titulo?: string }) {
  const [abierto, setAbierto] = useState(false);
  const [imagen, setImagen] = useState<string | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);

  useEffect(() => {
    if (!abierto) return;
    let vivo = true, creada: string | null = null;
    setImagen(null); setFallo(null);
    apiArchivo(url).then((b) => { if (!vivo) return; creada = URL.createObjectURL(b); setImagen(creada); })
      .catch((e: Error) => { if (vivo) setFallo(e.message); });
    return () => { vivo = false; if (creada) URL.revokeObjectURL(creada); };
  }, [abierto, url]);

  return (
    <>
      <button type="button" className="enlace" onClick={() => setAbierto(true)}>{texto}</button>
      {/* En el body: puede abrirse desde otro diálogo y debe quedar encima. */}
      {abierto && createPortal(
        <Dialogo abierto titulo={titulo} onCerrar={() => setAbierto(false)}
          acciones={<>{imagen && <a className="btn btn--secondary btn--md" href={imagen} download="comprobante">Descargar</a>}<Boton onClick={() => setAbierto(false)}>Cerrar</Boton></>}>
          {fallo ? <p className="form__error" role="alert">{fallo}</p>
            : imagen ? <img className="visor-comprobante" src={imagen} alt={titulo} /> : <PilaEsqueleto lineas={4} />}
        </Dialogo>, document.body)}
    </>
  );
}
