import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'api.dart';

/// Lo que la app sabe al abrir, según el servidor.
class EstadoVersion {
  const EstadoVersion({this.obligatoria = false, this.disponible = false, this.url = '', this.mensaje = ''});
  final bool obligatoria;
  final bool disponible;
  final String url;
  final String mensaje;
}

String get plataforma => kIsWeb ? 'web' : defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android';

/// Versión instalada ("1.2.0") leída del propio paquete: no se escribe a mano en el código.
Future<String> versionInstalada() async => (await PackageInfo.fromPlatform()).version;

/// Al iniciar sesión: registra versión y token push, y pregunta si hay que actualizar.
/// Nunca bloquea la app por un fallo de red o de Firebase.
Future<EstadoVersion> arrancarSesion() async {
  final api = Api.instancia;
  final version = await versionInstalada();
  String? token;
  try {
    token = await _tokenPush(api.config['firebase'] as Map<String, dynamic>?);
  } catch (_) {/* sin push: la app funciona igual */}
  try {
    final r = await api.registrarDispositivo(plataforma: plataforma, version: version, tokenPush: token);
    return EstadoVersion(
      obligatoria: r['actualizacionObligatoria'] == true,
      disponible: r['actualizacionDisponible'] == true,
      url: '${r['url'] ?? ''}',
      mensaje: '${r['mensaje'] ?? ''}',
    );
  } catch (_) {
    return const EstadoVersion();
  }
}

/// Firebase con las credenciales que el superadmin cargó en la web: no hay
/// google-services.json dentro de la app, así se cambia de proyecto sin recompilar.
Future<String?> _tokenPush(Map<String, dynamic>? fb) async {
  if (fb == null || kIsWeb) return null;
  final appId = '${plataforma == 'ios' ? fb['appIdIos'] : fb['appIdAndroid']}';
  if (appId.isEmpty || '${fb['apiKey']}'.isEmpty) return null;
  if (Firebase.apps.isEmpty) {
    await Firebase.initializeApp(
      options: FirebaseOptions(
        apiKey: '${fb['apiKey']}',
        appId: appId,
        messagingSenderId: '${fb['senderId']}',
        projectId: '${fb['projectId']}',
      ),
    );
  }
  final mensajeria = FirebaseMessaging.instance;
  // iOS y Android 13+ piden permiso explícito; si el usuario lo niega, no hay token y no pasa nada.
  final permiso = await mensajeria.requestPermission();
  if (permiso.authorizationStatus == AuthorizationStatus.denied) return null;
  // ponytail: getToken (obsoleto en v17) es el destino que FCM HTTP v1 documenta para "token".
  // Migrar a register()/onRegistered cuando se valide en un dispositivo real que el servidor lo acepta.
  // ignore: deprecated_member_use
  return mensajeria.getToken();
}
