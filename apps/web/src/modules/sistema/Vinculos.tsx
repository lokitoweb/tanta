import { useState } from 'react';
import { Boton, Tarjeta, TarjetaTitulo } from '@/ui/primitives';

/**
 * Activación de la app: el APK no trae ninguna dirección. La primera vez se escribe este
 * dominio en el teléfono; después la app sigue sola los cambios de "Servidor de las apps".
 */
export function ActivacionApp({ urlApi }: { urlApi: string }) {
  const dominio = urlApi ? new URL(urlApi).host : window.location.host;
  const [copiado, setCopiado] = useState(false);
  return (
    <Tarjeta>
      <TarjetaTitulo titulo="Activar la app en un teléfono" subtitulo="Se hace una sola vez por teléfono." />
      <ol className="activacion__pasos">
        <li>Instala la app y ábrela.</li>
        <li>Escribe este dominio y toca <b>Conectar</b>.</li>
        <li>Inicia sesión con tu usuario. Si mudas el sistema de dominio, la app se actualiza sola.</li>
      </ol>
      <div className="activacion__enlace">
        <code>{dominio}</code>
        <Boton size="sm" onClick={() => { void navigator.clipboard.writeText(dominio).then(() => { setCopiado(true); setTimeout(() => setCopiado(false), 1500); }); }}>{copiado ? 'Copiado' : 'Copiar dominio'}</Boton>
      </div>
    </Tarjeta>
  );
}

/** Lee google-services.json (Android) o GoogleService-Info.plist (iOS) y devuelve los campos que usa la app. */
export async function leerArchivoFirebase(archivo: File): Promise<Record<string, string>> {
  if (archivo.size > 200_000) throw new Error('El archivo es demasiado grande para ser de Firebase.');
  const texto = await archivo.text();
  if (archivo.name.endsWith('.plist') || texto.trimStart().startsWith('<?xml')) {
    const doc = new DOMParser().parseFromString(texto, 'application/xml');
    const claves = [...doc.querySelectorAll('dict > key')];
    const valor = (k: string) => claves.find((x) => x.textContent === k)?.nextElementSibling?.textContent ?? '';
    if (!valor('GOOGLE_APP_ID')) throw new Error('No parece un GoogleService-Info.plist válido.');
    return { projectId: valor('PROJECT_ID'), apiKey: valor('API_KEY'), appIdIos: valor('GOOGLE_APP_ID'), senderId: valor('GCM_SENDER_ID') };
  }
  const j = JSON.parse(texto) as {
    type?: string; project_id?: string; client_email?: string;
    project_info?: { project_id?: string; project_number?: string };
    client?: Array<{ client_info?: { mobilesdk_app_id?: string; android_client_info?: { package_name?: string } }; api_key?: Array<{ current_key?: string }> }>;
  };
  if (j.type === 'service_account') {
    if (!j.client_email) throw new Error('La cuenta de servicio está incompleta.');
    return { projectId: j.project_id ?? '', cuentaServicio: texto };
  }
  if (!j.project_info) throw new Error('No parece un google-services.json válido.');
  const cliente = j.client?.find((c) => c.client_info?.android_client_info?.package_name?.startsWith('com.tantapanaderia')) ?? j.client?.[0];
  return {
    projectId: j.project_info.project_id ?? '', senderId: j.project_info.project_number ?? '',
    appIdAndroid: cliente?.client_info?.mobilesdk_app_id ?? '', apiKey: cliente?.api_key?.[0]?.current_key ?? '',
  };
}
