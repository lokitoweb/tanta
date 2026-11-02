import nodemailer from 'nodemailer';
import { leerConfig } from './routes/sistema.js';

interface CfgCorreo { habilitado?: boolean; host?: string; puerto?: number; seguro?: boolean; usuario?: string; clave?: string; remitente?: string; nombreRemitente?: string }

const escapar = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** ¿Hay un servidor SMTP configurado y activo? */
export async function correoDisponible(): Promise<boolean> {
  const c = await leerConfig('correo') as CfgCorreo;
  return Boolean(c.habilitado && c.host && c.remitente);
}

/**
 * Envía un correo con el SMTP que el Superadmin configuró (Configuración → Correo).
 * Plantilla simple con la marca; el cuerpo se escapa (nada de HTML del usuario).
 */
export async function enviarCorreo(para: string, asunto: string, parrafos: string[], destacado?: string): Promise<void> {
  const c = await leerConfig('correo') as CfgCorreo;
  if (!c.habilitado || !c.host || !c.remitente) throw Object.assign(new Error('El correo no está configurado.'), { status: 503 });
  const transporte = nodemailer.createTransport({
    host: c.host, port: Number(c.puerto ?? 587), secure: Boolean(c.seguro),
    auth: c.usuario ? { user: c.usuario, pass: c.clave ?? '' } : undefined,
    connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000,
    tls: { minVersion: 'TLSv1.2' },
  });
  const marca = (await leerConfig('marca') as { nombreApp?: string }).nombreApp ?? 'Tanta';
  const html = `<!doctype html><html><body style="margin:0;background:#F6F1EA;font-family:Arial,sans-serif;color:#241812">
    <div style="max-width:520px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #E7DCCD">
      <div style="background:#2B1D16;color:#FBF7F1;padding:20px 24px;font-size:20px;letter-spacing:4px;font-weight:bold">${escapar(marca.toUpperCase())}</div>
      <div style="padding:24px">
        ${parrafos.map((p) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.5">${escapar(p)}</p>`).join('')}
        ${destacado ? `<p style="margin:18px 0;font-size:30px;letter-spacing:8px;font-weight:bold;text-align:center;background:#F6F1EA;padding:14px;border-radius:8px">${escapar(destacado)}</p>` : ''}
        <p style="margin:18px 0 0;font-size:12px;color:#8A7A6B">Si no solicitaste esto, ignora este correo: tu cuenta sigue segura.</p>
      </div>
    </div></body></html>`;
  await transporte.sendMail({
    from: { name: c.nombreRemitente || marca, address: c.remitente },
    to: para, subject: asunto, html,
    text: [...parrafos, destacado ?? ''].join('\n\n'),
  });
}
