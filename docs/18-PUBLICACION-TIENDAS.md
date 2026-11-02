# 18 · Publicar en Google Play y App Store

Lo que ya está resuelto en el código y lo que solo puede hacer el dueño de las cuentas.

## Ya cumplido en el código

| Requisito | Dónde |
|---|---|
| Eliminar la cuenta desde la app (App Store 5.1.1(v), Google Play) | Perfil → Eliminar mi cuenta · `DELETE /perfil` |
| Política de privacidad y soporte accesibles en la app | Perfil → enlaces configurados en Web → Configuración → Legal |
| Textos de permiso de cámara y fotos (iOS) | `ios/Runner/Info.plist` |
| Manifiesto de privacidad de Apple | `ios/Runner/PrivacyInfo.xcprivacy` (incluido en el target) |
| Declaración de cifrado (evita la pregunta en cada envío) | `ITSAppUsesNonExemptEncryption = false` |
| Solo HTTPS en producción | Android `usesCleartextTraffic=false`; la app no arranca en release con `API_URL` http |
| Permiso de internet y de notificaciones (Android 13+) | `AndroidManifest.xml` |
| Sin respaldo de la sesión en la nube | `allowBackup=false` + `reglas_respaldo.xml` |
| Tokens en Keychain / Keystore | `flutter_secure_storage` |
| Firma de release separada de la de debug | `android/app/build.gradle.kts` + `key.properties` |
| Control de versión mínima | Web → Configuración → App móvil; la app bloquea si está por debajo |

## Pasos del dueño (una sola vez)

### Android — llave de subida
```bash
keytool -genkey -v -keystore ~/tanta-subida.jks -keyalg RSA -keysize 2048 -validity 10000 -alias tanta
```
Crear `apps/mobile/android/key.properties` (está en `.gitignore`, **nunca** se sube a git):
```
storePassword=…
keyPassword=…
keyAlias=tanta
storeFile=C:/ruta/tanta-subida.jks
```
Guardar el `.jks` y las claves en un gestor de contraseñas: si se pierden, no se puede actualizar la app.
Activar **Play App Signing** en Play Console.

### iOS — Xcode (en una Mac)
1. Abrir `ios/Runner.xcworkspace` → Signing & Capabilities → elegir el Team.
2. Agregar las capacidades **Push Notifications** y **Background Modes → Remote notifications**.
3. En Firebase Console → Cloud Messaging, subir la **llave APNs (.p8)** de la cuenta de Apple.

### Firebase (sin recompilar la app)
1. Crear el proyecto y registrar las apps Android (`com.tantapanaderia.tanta_app`) e iOS (`com.tantapanaderia.tantaApp`).
2. Copiar Project ID, API key, App IDs y Sender ID en **Web → Configuración → Integraciones**.
3. Generar una cuenta de servicio (Configuración → Cuentas de servicio → Generar clave) y pegar el JSON. Se guarda cifrado en reposo en la base y nunca vuelve al navegador.
4. «Enviarme una prueba» confirma que llega.

## Cada versión nueva
1. Subir `version:` en `pubspec.yaml` (p. ej. `1.2.0+12`: el número tras `+` siempre crece).
2. `flutter build appbundle --release --dart-define=API_URL=https://www.tantapanaderia.com/api/v1` → Play Console.
3. `flutter build ipa --release --dart-define=API_URL=https://www.tantapanaderia.com/api/v1` → Transporter / Xcode.
4. Cuando esté aprobada: Web → Configuración → App móvil → «Versión publicada». Si la anterior debe dejar de usarse, subir también «Versión mínima».

## Ficha de la tienda (datos que piden)
- Ícono 1024×1024 (el que se sube en Configuración → Marca sirve de base), capturas de teléfono y tablet.
- Clasificación de contenido, público objetivo (no infantil), declaración de seguridad de datos de Google
  (nombre, correo, teléfono, fotos, historial de compras; no se comparten; se pueden eliminar).
- Cuenta de prueba para el revisor (crear un usuario Cliente en Usuarios y roles).
