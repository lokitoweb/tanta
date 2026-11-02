/**
 * Reduce una imagen en el navegador antes de subirla: una foto de celular de 5 MB
 * queda en ~60 KB. El servidor igual valida tipo real y tamaño.
 */
export async function imagenABase64(archivo: File, lado = 512, tipo: 'image/jpeg' | 'image/png' = 'image/jpeg'): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(archivo.type)) throw new Error('Usa una imagen PNG, JPEG o WebP.');
  const bmp = await createImageBitmap(archivo);
  const escala = Math.min(1, lado / Math.max(bmp.width, bmp.height));
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.round(bmp.width * escala);
  lienzo.height = Math.round(bmp.height * escala);
  lienzo.getContext('2d')!.drawImage(bmp, 0, 0, lienzo.width, lienzo.height);
  return lienzo.toDataURL(tipo, 0.85);
}
