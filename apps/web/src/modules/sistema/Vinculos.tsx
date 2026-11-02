import { Tarjeta, TarjetaTitulo } from '@/ui/primitives';

/** Resumen de cómo se conectan las apps: todo es automático; el dominio solo se muestra. */
export function ActivacionApp({ urlApi }: { urlApi: string }) {
  const dominio = urlApi ? new URL(urlApi).host : window.location.host;
  return (
    <Tarjeta>
      <TarjetaTitulo titulo="Conexión de las apps" subtitulo="Automática: no hay que configurar nada en el teléfono." />
      <ul className="activacion__pasos">
        <li>La APK se compila con el dominio <b className="mono">{dominio}</b>: al instalarla ya entra directo al inicio de sesión.</li>
        <li>Si cambias el dominio abajo, las apps instaladas se mudan solas la próxima vez que se abran.</li>
        <li>Cada nueva APK aparece sola en "Última versión publicada" y los teléfonos reciben el aviso para actualizar.</li>
      </ul>
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
