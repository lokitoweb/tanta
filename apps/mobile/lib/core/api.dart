import 'dart:convert';
import 'dart:math';
import 'package:http/http.dart' as http;
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Cliente HTTP del API de Tanta.
///
/// La URL se puede sobreescribir al compilar:
///   flutter run --dart-define=API_URL=http://10.0.2.2:3001/api/v1   (emulador Android)
///   flutter run --dart-define=API_URL=http://192.168.1.10:3001/api/v1 (dispositivo físico)
class Api {
  Api._();
  static final Api instancia = Api._();

  static const String base = String.fromEnvironment(
    'API_URL',
    defaultValue: 'http://127.0.0.1:3001/api/v1',
  );

  String? _acceso;
  String? _refresco;
  String nombre = '';
  String rol = '';
  List<String> permisos = const [];
  List<Map<String, dynamic>> menu = const [];

  bool get autenticado => _acceso != null;

  /// Tokens en Keychain (iOS) / Keystore (Android), nunca en SharedPreferences (texto plano).
  static const _seguro = FlutterSecureStorage();

  /// Tiempo máximo por petición: con mala señal la app avisa en vez de quedarse colgada.
  static const _limite = Duration(seconds: 20);

  Future<void> cargarSesion() async {
    // En producción solo HTTPS: un token nunca viaja en claro.
    if (kReleaseMode && !base.startsWith('https://')) {
      throw StateError('API_URL debe usar https:// en producción');
    }
    _acceso = await _seguro.read(key: 'acceso');
    _refresco = await _seguro.read(key: 'refresco');
    // Migración única desde versiones que guardaban en SharedPreferences.
    final p = await SharedPreferences.getInstance();
    final viejo = p.getString('refresco');
    if (_refresco == null && viejo != null) {
      await _guardar(p.getString('acceso') ?? '', viejo);
    }
    await p.remove('acceso');
    await p.remove('refresco');
  }

  Future<void> _guardar(String acceso, String refresco) async {
    _acceso = acceso;
    _refresco = refresco;
    await _seguro.write(key: 'acceso', value: acceso);
    await _seguro.write(key: 'refresco', value: refresco);
  }

  Future<void> cerrarSesion() async {
    _acceso = null;
    _refresco = null;
    nombre = '';
    rol = '';
    permisos = const [];
    menu = const [];
    await _seguro.delete(key: 'acceso');
    await _seguro.delete(key: 'refresco');
  }

  Map<String, String> _cabeceras({bool conCuerpo = false}) => {
        if (conCuerpo) 'Content-Type': 'application/json',
        if (_acceso != null) 'Authorization': 'Bearer $_acceso',
      };

  Future<dynamic> _decodificar(http.Response r) {
    if (r.statusCode >= 400) {
      String mensaje = 'Error ${r.statusCode}';
      try {
        final cuerpo = jsonDecode(r.body) as Map<String, dynamic>;
        mensaje = (cuerpo['detail'] ?? cuerpo['title'] ?? mensaje) as String;
      } catch (_) {}
      throw ApiException(r.statusCode, mensaje);
    }
    if (r.body.isEmpty) return Future.value(null);
    return Future.value(jsonDecode(r.body));
  }

  // Un solo refresco en vuelo: el servidor rota el token y detecta reuso, así que dos
  // refrescos paralelos (cola offline + pantalla) cerrarían la sesión.
  Future<bool>? _refrescando;
  Future<bool> _refrescar() => _refrescando ??= _hacerRefresco().whenComplete(() => _refrescando = null);

  Future<bool> _hacerRefresco() async {
    final actual = _refresco;
    if (actual == null || actual.isEmpty) return false;
    late http.Response r;
    try {
      r = await http.post(
        Uri.parse('$base/auth/refresh'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'refreshToken': actual}),
      ).timeout(_limite);
    } catch (_) {
      return false; // sin red: se reintenta cuando vuelva
    }
    if (r.statusCode >= 400) return false;
    final datos = jsonDecode(r.body) as Map<String, dynamic>;
    await _guardar(
      datos['accessToken'] as String,
      (datos['refreshToken'] as String?) ?? actual,
    );
    return true;
  }

  Future<dynamic> _get(String ruta, {bool reintentar = true}) async {
    late http.Response r;
    try {
      r = await http.get(Uri.parse('$base$ruta'), headers: _cabeceras()).timeout(_limite);
      if (r.statusCode == 401 && reintentar && await _refrescar()) {
        r = await http.get(Uri.parse('$base$ruta'), headers: _cabeceras()).timeout(_limite);
      }
    } on ApiException {
      rethrow;
    } catch (_) {
      throw SinConexion();
    }
    return _decodificar(r);
  }

  Future<dynamic> _post(
    String ruta,
    Map<String, dynamic> cuerpo, {
    bool sinAuth = false,
    bool reintentar = true,
    bool idempotente = false,
    String? claveIdempotencia,
  }) async {
    // La clave se genera al encolar: si se reintenta cinco veces, el servidor
    // reconoce la operación y no duplica el cobro.
    final clave = claveIdempotencia ?? (idempotente ? _uuid() : null);

    Map<String, String> cabeceras() => {
          ...(sinAuth ? const {} : _cabeceras(conCuerpo: true)),
          'Content-Type': 'application/json',
          if (clave != null && !sinAuth) 'Idempotency-Key': clave,
        };

    late http.Response r;
    try {
      r = await http.post(Uri.parse('$base$ruta'), headers: cabeceras(), body: jsonEncode(cuerpo)).timeout(_limite);
      if (r.statusCode == 401 && !sinAuth && reintentar && await _refrescar()) {
        r = await http.post(Uri.parse('$base$ruta'), headers: cabeceras(), body: jsonEncode(cuerpo)).timeout(_limite);
      }
    } catch (_) {
      // Sin red: la operación queda pendiente y se reintenta sola.
      throw SinConexion();
    }
    return _decodificar(r);
  }

  /// UUID v4 suficiente para la clave de idempotencia (no requiere dependencias).
  String _uuid() {
    final r = Random.secure();
    final bytes = List<int>.generate(16, (_) => r.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    String hex(int b) => b.toRadixString(16).padLeft(2, '0');
    final h = bytes.map(hex).join();
    return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-'
        '${h.substring(16, 20)}-${h.substring(20)}';
  }

  /// Inicia sesión y carga el perfil (rol, permisos y menú calculados por el servidor).
  Future<void> login(String usuario, String clave) async {
    final datos = await _post('/auth/login', {'usuario': usuario, 'clave': clave}, sinAuth: true)
        as Map<String, dynamic>;

    if (datos['accessToken'] == null) {
      // El servidor pidió segundo factor: en el móvil se resuelve desde la web
      // para no duplicar el enrolamiento en dos dispositivos.
      throw ApiException(
        401,
        datos['mfaRequerido'] == true || datos['mfaEnrolamiento'] == true
            ? 'Este perfil usa verificación en dos pasos. Ingresa desde el sistema web.'
            : 'No se pudo iniciar sesión.',
      );
    }

    // En la app nativa el refresco llega en el cuerpo; en un navegador viaja en
    // una cookie HttpOnly y aquí llega vacío (la sesión no se refresca, es lo correcto).
    await _guardar(
      datos['accessToken'] as String,
      (datos['refreshToken'] as String?) ?? '',
    );
    await yo();
  }

  Future<void> yo() async {
    final datos = await _get('/auth/yo') as Map<String, dynamic>;
    nombre = (datos['usuario'] as Map)['nombre'] as String;
    rol = (datos['rol'] as Map)['nombre'] as String;
    permisos = (datos['permisos'] as List).cast<String>();
    menu = (datos['navegacion'] as List).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> datos() async => await _get('/datos') as Map<String, dynamic>;

  Future<List<dynamic>> kardex(String codigo) async => await _get('/kardex/$codigo') as List<dynamic>;

  Future<Map<String, dynamic>> cerrarOrden(String codigo, num cantidad, num merma) async =>
      await _post('/ordenes-produccion/$codigo/cerrar', {
        'cantidadProducida': cantidad,
        'mermaReal': merma,
      }) as Map<String, dynamic>;

  /// Cuentas por cobrar abiertas. El servidor ya filtra por permiso.
  Future<List<dynamic>> cartera() async => await _get('/cxc') as List<dynamic>;

  /// Aplica un pago. La clave de idempotencia evita duplicar si se reintenta.
  Future<Map<String, dynamic>> registrarPago({
    required String cxcId,
    required num monto,
    required String medio,
    String? referencia,
    String? claveIdempotencia,
  }) async =>
      await _post(
        '/cobranza',
        {
          'cxcId': cxcId,
          'monto': monto,
          'medio': medio,
          if (referencia != null && referencia.isNotEmpty) 'referencia': referencia,
        },
        idempotente: true,
        claveIdempotencia: claveIdempotencia,
      ) as Map<String, dynamic>;

  /// Cambia el estado de un pedido. El servidor valida la transición.
  Future<Map<String, dynamic>> cambiarEstadoPedido(String codigo, String estado) async {
    late http.Response r;
    try {
      r = await http.patch(
        Uri.parse('$base/pedidos/$codigo/estado'),
        headers: _cabeceras(conCuerpo: true),
        body: jsonEncode({'estado': estado}),
      ).timeout(_limite);
    } catch (_) {
      throw SinConexion();
    }
    return await _decodificar(r) as Map<String, dynamic>;
  }

  bool puede(String permiso) => permisos.contains(permiso);
}

class ApiException implements Exception {
  ApiException(this.status, this.mensaje);
  final int status;
  final String mensaje;

  /// Errores de negocio: reintentar no sirve, hay que corregir el dato.
  /// Los 408/429 sí son transitorios.
  bool get esDefinitivo => status >= 400 && status < 500 && status != 408 && status != 429;

  @override
  String toString() => mensaje;
}

/// El servidor no respondió: la operación puede esperar en la cola.
class SinConexion implements Exception {
  SinConexion([this.causa = 'Sin conexión con el servidor']);
  final String causa;
  @override
  String toString() => causa;
}

String dinero(num v) {
  final s = v.toStringAsFixed(2);
  final partes = s.split('.');
  final entero = partes[0].replaceAllMapped(RegExp(r'(\d)(?=(\d{3})+(?!\d))'), (m) => '${m[1]},');
  return 'S/ $entero.${partes[1]}';
}

String porcentaje(num v, [int decimales = 1]) => '${(v * 100).toStringAsFixed(decimales)} %';

/// Fecha de negocio en formato local: 2026-11-01 se muestra como 01/11/26.
String fechaCorta(String iso) {
  if (iso.length < 10) return iso;
  final anio = iso.substring(0, 4);
  final mes = iso.substring(5, 7);
  final dia = iso.substring(8, 10);
  return '$dia/$mes/${anio.substring(2)}';
}