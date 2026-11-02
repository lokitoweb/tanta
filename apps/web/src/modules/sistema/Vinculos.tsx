import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Boton, Tarjeta, TarjetaTitulo } from '@/ui/primitives';

/**
 * Activación de la app: el APK no trae ninguna dirección. La primera vez se escanea este QR
 * (o se abre el enlace) y la app queda vinculada a este servidor; después sigue los cambios
 * que se hagan en "Servidor de las apps".
 */
export function ActivacionApp({ urlApi }: { urlApi: string }) {
  const servidor = (urlApi || `${window.location.origin}/api/v1`).replace(/\/+$/, '');
  const enlace = `tanta://activar?servidor=${encodeURIComponent(servidor)}`;
  const [qr, setQr] = useState('');
  const [copiado, setCopiado] = useState(false);
  useEffect(() => { QRCode.toDataURL(enlace, { width: 220, margin: 1, errorCorrectionLevel: 'M' }).then(setQr).catch(() => setQr('')); }, [enlace]);

  return (
    <Tarjeta>
      <TarjetaTitulo titulo="Activar la app en un teléfono" subtitulo="Se hace una sola vez por teléfono. El APK no lleva ninguna dirección escrita." />
      <div className="activacion">
        {qr && <img src={qr} alt="Código QR de activación" width={220} height={220} />}
        <ol className="activacion__pasos">
          <li>Instala la app y ábrela.</li>
          <li>Toca <b>Escanear código</b> y apunta a este QR.</li>
          <li>Listo: inicia sesión con tu usuario. Si mudas el sistema de dominio, la app se actualiza sola.</li>
        </ol>
        <div className="activacion__enlace">
          <code>{servidor}</code>
          <Boton size="sm" onClick={() => { void navigator.clipboard.writeText(servidor).then(() => { setCopiado(true); setTimeout(() => setCopiado(false), 1500); }); }}>{copiado ? 'Copiado' : 'Copiar dirección'}</Boton>
        </div>
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
