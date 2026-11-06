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

export type ArchivoFirebase = 'android' | 'ios' | 'cuenta';
const NOMBRE: Record<ArchivoFirebase, string> = {
  android: 'google-services.json (Android)', ios: 'GoogleService-Info.plist (iOS)', cuenta: 'la cuenta de servicio',
};

/**
 * Lee el archivo que se subió en [esperado] y devuelve los campos que llena. Si es otro de los tres archivos
 * (el error más común: subir google-services.json como cuenta de servicio), lo dice claro en vez de seguir.
 */
export async function leerArchivoFirebase(archivo: File, esperado: ArchivoFirebase): Promise<Record<string, string>> {
  if (archivo.size > 200_000) throw new Error('El archivo es demasiado grande para ser de Firebase.');
  const texto = await archivo.text();
  const datos = await interpretar(texto, archivo.name);
  const tipo: ArchivoFirebase = 'cuentaServicio' in datos ? 'cuenta' : 'appIdIos' in datos ? 'ios' : 'android';
  if (tipo !== esperado) {
    throw new Error(esperado === 'cuenta'
      ? `«${archivo.name}» es ${NOMBRE[tipo]}, no la cuenta de servicio. Descárgala en Firebase Console → ⚙ Configuración del proyecto → Cuentas de servicio → «Generar nueva clave privada» (se llama parecido a panaderia-tanta-firebase-adminsdk-xxxx.json).`
      : `«${archivo.name}» es ${NOMBRE[tipo]}: súbelo con su botón.`);
  }
  return datos;
}

async function interpretar(texto: string, nombre: string): Promise<Record<string, string>> {
  if (nombre.endsWith('.plist') || texto.trimStart().startsWith('<?xml')) {
    const doc = new DOMParser().parseFromString(texto, 'application/xml');
    const claves = [...doc.querySelectorAll('dict > key')];
    const valor = (k: string) => claves.find((x) => x.textContent === k)?.nextElementSibling?.textContent ?? '';
    if (!valor('GOOGLE_APP_ID')) throw new Error('No parece un GoogleService-Info.plist válido.');
    return { projectId: valor('PROJECT_ID'), apiKey: valor('API_KEY'), appIdIos: valor('GOOGLE_APP_ID'), senderId: valor('GCM_SENDER_ID') };
  }
  let j: {
    type?: string; project_id?: string; client_email?: string; private_key?: string;
    project_info?: { project_id?: string; project_number?: string };
    client?: Array<{ client_info?: { mobilesdk_app_id?: string; android_client_info?: { package_name?: string } }; api_key?: Array<{ current_key?: string }> }>;
  };
  try { j = JSON.parse(texto); } catch { throw new Error(`«${nombre}» no es un archivo JSON de Firebase.`); }
  if (j.type === 'service_account') {
    if (!j.client_email || !j.private_key) throw new Error('La cuenta de servicio está incompleta (falta client_email o private_key).');
    return { projectId: j.project_id ?? '', cuentaServicio: texto };
  }
  if (!j.project_info) throw new Error('No parece un google-services.json válido.');
  const cliente = j.client?.find((c) => c.client_info?.android_client_info?.package_name?.startsWith('com.tantapanaderia')) ?? j.client?.[0];
  return {
    projectId: j.project_info.project_id ?? '', senderId: j.project_info.project_number ?? '',
    appIdAndroid: cliente?.client_info?.mobilesdk_app_id ?? '', apiKey: cliente?.api_key?.[0]?.current_key ?? '',
  };
}
