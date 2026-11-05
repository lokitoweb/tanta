import { useEffect, useState } from 'react';
import { urlApi } from '@/core/api';
import { PilaEsqueleto, Vacio } from '@/ui/primitives';

/** Página pública (sin sesión) de privacidad o términos: el enlace que piden Google Play y App Store. */
export function Legal({ doc }: { doc: 'privacidad' | 'terminos' }) {
  const [d, setD] = useState<{ titulo: string; texto: string; negocio: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cargar = () => {
    setError(null);
    fetch(urlApi(`/legal/${doc}`))
      .then((r) => { if (!r.ok) throw new Error(`Error ${r.status}`); return r.json(); })
      .then((x) => { setD(x); document.title = `${x.titulo} · ${x.negocio}`; })
      .catch((e) => setError(e instanceof TypeError ? 'Revisa tu conexión a internet.' : e.message));
  };
  useEffect(cargar, [doc]);
  if (!d) return (
    <main className="legal">
      {error ? <Vacio titulo="No se pudo cargar el documento" detalle={error} icono="report" onReintentar={cargar} /> : <PilaEsqueleto lineas={8} />}
    </main>
  );
  return (
    <main className="legal">
      <p className="legal__marca">{d.negocio}</p>
      <h1>{d.titulo}</h1>
      {d.texto.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
    </main>
  );
}
