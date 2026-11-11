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

  /// Sube cada vez que el servidor acepta un cambio (pedido, venta, pago…): las pantallas que muestran
  /// el resumen (panel, KPIs, «Mis últimos pedidos») se recargan solas. Un solo lugar, sin duplicar avisos.
  final cambios = ValueNotifier<int>(0);
  // Sesión, avisos y telemetría no cambian los datos del negocio.
  static bool _cambiaDatos(String ruta) => !ruta.startsWith('/auth') && !ruta.startsWith('/notificaciones');
  dynamic _trasCambio(String ruta, dynamic r) {
    if (_cambiaDatos(ruta)) cambios.value++;
    return r;
  }

  static const String _baseCompilada = String.fromEnvironment(
    'API_URL',
    defaultValue: '', // sin dirección: la app se activa con el QR de la web
  );

  static String base = _baseCompilada;

  String? _acceso;
  String? _refresco;
  String nombre = '';
  /// Dueño de la sesión: la cola offline solo envía con la sesión de quien registró la operación.
  String usuarioId = '';
  String rol = '';
  List<String> permisos = const [];
  List<Map<String, dynamic>> menu = const [];
  String? fotoUrl;

  /// Marca, versión mínima, legal y Firebase: lo que el superadmin cambia desde la web.
  Map<String, dynamic> config = const {};

  /// URL absoluta de un archivo del API ("/archivos/…").
  String urlArchivo(String ruta) => '$base$ruta';

  bool get autenticado => _acceso != null;

  /// Sin servidor guardado ni compilado: hay que activar la app (QR o dirección).
  bool get activada => base.isNotEmpty;

  /// Tokens en Keychain (iOS) / Keystore (Android), nunca en SharedPreferences (texto plano).
  static const _seguro = FlutterSecureStorage();

  /// Tiempo máximo por petición: con mala señal la app avisa en vez de quedarse colgada.
  static const _limite = Duration(seconds: 20);

  Future<void> cargarSesion() async {
    // Servidor vigente: el último que indicó el sistema (Configuración → App móvil).
    // Una APK compilada con otro dominio manda sobre lo guardado: al instalarla encima de una anterior
    // (p. ej. de un túnel que ya no existe) la app no queda apuntando a la dirección vieja.
    final compiladaAntes = await _seguro.read(key: 'compilada');
    if (_baseCompilada.isNotEmpty && compiladaAntes != _baseCompilada) {
      await _seguro.write(key: 'compilada', value: _baseCompilada);
      if (compiladaAntes != null || await _seguro.read(key: 'servidor') != null) {
        await _seguro.write(key: 'servidor', value: _baseCompilada);
        for (final k in ['acceso', 'refresco']) { await _seguro.delete(key: k); }
      }
    }
    base = await _seguro.read(key: 'servidor') ?? _baseCompilada;
    // En producción solo HTTPS: un token nunca viaja en claro.
    if (kReleaseMode && base.isNotEmpty && !base.startsWith('https://')) {
      throw StateError('API_URL debe usar https:// en producción');
    }
    _acceso = await _seguro.read(key: 'acceso');
    _refresco = await _seguro.read(key: 'refresco');
    usuarioId = await _seguro.read(key: 'usuarioId') ?? '';
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

  /// Salida voluntaria: revoca el refresco en el servidor (si hay red) y borra la sesión local.
  Future<void> salir() async {
    final refresco = _refresco;
    if (_acceso != null && refresco != null) {
      try {
        await http.post(Uri.parse('$base/auth/logout'), headers: {..._cabeceras(conCuerpo: true), 'Content-Type': 'application/json'},
            body: jsonEncode({'refreshToken': refresco})).timeout(const Duration(seconds: 5));
      } catch (_) {/* sin red: igual se sale; el refresco caduca solo */}
    }
    await cerrarSesion();
  }

  Future<void> cerrarSesion() async {
    _acceso = null;
    _refresco = null;
    nombre = '';
    usuarioId = '';
    rol = '';
    permisos = const [];
    menu = const [];
    fotoUrl = null;
    await _seguro.delete(key: 'acceso');
    await _seguro.delete(key: 'refresco');
    await _seguro.delete(key: 'usuarioId');
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

  /// Comprobante privado: bytes de la imagen, pedidos con la sesión.
  Future<Uint8List> archivoPrivado(String ruta) async {
    final r = await _binario(() => http.get(Uri.parse('$base$ruta'), headers: _cabeceras()));
    return r.bodyBytes;
  }

  /// Excel real: el servidor arma el .xlsx con las filas que el usuario ya ve.
  Future<Uint8List> excel(String nombre, List<Map<String, dynamic>> filas) async {
    final r = await _binario(() => http.post(Uri.parse('$base/exportar/excel'), headers: {..._cabeceras(conCuerpo: true), 'Content-Type': 'application/json'},
        body: jsonEncode({'nombre': nombre, 'filas': filas})));
    return r.bodyBytes;
  }

  Future<http.Response> _binario(Future<http.Response> Function() pedir) async {
    late http.Response r;
    try {
      r = await pedir().timeout(_limite);
      if (r.statusCode == 401 && await _refrescar()) r = await pedir().timeout(_limite);
    } on ApiException {
      rethrow;
    } catch (_) {
      throw SinConexion();
    }
    if (r.statusCode >= 400) throw ApiException(r.statusCode, r.statusCode == 404 ? 'No se encontró el archivo o no tienes acceso' : 'No se pudo obtener el archivo');
    return r;
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
    // Si la respuesta no llegó (timeout) y el usuario reintenta lo mismo, se reusa la clave:
    // el servidor devuelve la venta, pedido o gasto ya creado en vez de duplicarlo.
    final firma = idempotente && claveIdempotencia == null ? '$ruta|${jsonEncode(cuerpo)}' : null;
    final clave = claveIdempotencia ?? (firma != null ? (_clavesSinRespuesta[firma] ??= _uuid()) : null);

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
    if (firma != null) _clavesSinRespuesta.remove(firma);
    return _trasCambio(ruta, await _decodificar(r));
  }

  final Map<String, String> _clavesSinRespuesta = {};

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
  /// Si el rol exige verificación en dos pasos devuelve el paso pendiente (código o enrolamiento);
  /// la sesión se abre con [completarMfa].
  Future<PasoMfa?> login(String usuario, String clave) async {
    final datos = await _post('/auth/login', {'usuario': usuario, 'clave': clave}, sinAuth: true)
        as Map<String, dynamic>;

    if (datos['accessToken'] == null) {
      if (datos['ticket'] is String && (datos['mfaRequerido'] == true || datos['mfaEnrolamiento'] == true)) {
        return PasoMfa(datos['ticket'] as String, enrolar: datos['mfaEnrolamiento'] == true);
      }
      throw ApiException(401, 'No se pudo iniciar sesión.');
    }
    await _abrirSesion(datos);
    return null;
  }

  /// Primer ingreso de un rol con dos pasos: el servidor genera la clave para la app autenticadora.
  Future<Map<String, dynamic>> enrolarMfa(String ticket) async =>
      await _post('/auth/mfa/enrolar', {'ticket': ticket}, sinAuth: true) as Map<String, dynamic>;

  /// Envía el código de 6 dígitos (o uno de recuperación) y abre la sesión.
  /// Al activar por primera vez devuelve los códigos de recuperación, que se muestran una sola vez.
  Future<List<String>> completarMfa(String ticket, String codigo, {required bool activar}) async {
    final datos = await _post(activar ? '/auth/mfa/activar' : '/auth/mfa/verificar', {'ticket': ticket, 'codigo': codigo.trim()}, sinAuth: true)
        as Map<String, dynamic>;
    if (datos['accessToken'] == null) throw ApiException(401, 'No se pudo iniciar sesión.');
    await _abrirSesion(datos);
    return ((datos['codigosRecuperacion'] as List?) ?? const []).cast<String>();
  }

  Future<void> _abrirSesion(Map<String, dynamic> datos) async {
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
    usuarioId = '${(datos['usuario'] as Map)['id'] ?? ''}';
    await _seguro.write(key: 'usuarioId', value: usuarioId);
    fotoUrl = (datos['usuario'] as Map)['fotoUrl'] as String?;
    rol = (datos['rol'] as Map)['nombre'] as String;
    permisos = (datos['permisos'] as List).cast<String>();
    menu = (datos['navegacion'] as List).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> datos() async => await _get('/datos') as Map<String, dynamic>;

  Future<List<dynamic>> kardex(String codigo) async => await _get('/kardex/$codigo') as List<dynamic>;

  /// Conteo físico: el Almacén registra lo contado; el Gerente aprueba y recién se ajusta el stock.
  /// COB-06: el cliente recibe solo su propio estado de cuenta (el servidor ignora otro clienteId).
  Future<Map<String, dynamic>> estadoCuenta() async => await _get('/estado-cuenta') as Map<String, dynamic>;
  /// A22: compras de insumos con proveedor y documento.
  Future<List<dynamic>> proveedores() async => await _get('/proveedores') as List<dynamic>;
  /// Compra de insumos: Compras registra en presentaciones; el stock entra cuando Almacén la verifica.
  Future<Map<String, dynamic>> registrarCompra({required String proveedorId, required String docTipo, required String serie, required String nro,
          required String fechaCompra, required List<Map<String, dynamic>> items}) async =>
      await _post('/compras', {'proveedorId': proveedorId, 'docTipo': docTipo, 'serie': serie, 'nro': nro, 'fechaCompra': fechaCompra, 'items': items},
          idempotente: true) as Map<String, dynamic>;
  /// Catálogos administrables: medios de pago, documentos, tipos de insumo y unidades.
  Future<Map<String, dynamic>> catalogos() async => await _get('/catalogos') as Map<String, dynamic>;

  /// Caja chica (5.6 del informe de compras): el vendedor la abre y la cierra.
  Future<Map<String, dynamic>> cajaChica() async => await _get('/cajas/chica') as Map<String, dynamic>;
  Future<Map<String, dynamic>> abrirCajaChica(double monto) async =>
      await _post('/cajas/chica/abrir', {'montoInicial': monto}) as Map<String, dynamic>;
  Future<Map<String, dynamic>> cerrarCajaChica(String codigo, double contado, String observacion) async =>
      await _post('/cajas/chica/$codigo/cerrar', {'montoContado': contado, 'observacion': observacion}) as Map<String, dynamic>;
  Future<List<dynamic>> comprasPorVerificar() async => await _get('/compras?estado=REGISTRADA') as List<dynamic>;
  Future<Map<String, dynamic>> verificarCompra(String codigo, List<Map<String, dynamic>> lineas) async =>
      await _post('/compras/$codigo/verificar', {'lineas': lineas}) as Map<String, dynamic>;
  Future<List<dynamic>> conteos() async => await _get('/conteos') as List<dynamic>;
  Future<Map<String, dynamic>> registrarConteo(List<Map<String, dynamic>> items, String observacion) async =>
      await _post('/conteos', {'items': items, 'observacion': observacion}) as Map<String, dynamic>;
  Future<Map<String, dynamic>> resolverConteo(String id, bool aprobar, {String motivo = ''}) async =>
      await _post('/conteos/$id/resolver', {'aprobar': aprobar, 'motivo': motivo}) as Map<String, dynamic>;

  /// Con pedidoId, la venta despacha ese pedido (VEN-05): libera su reserva y lo marca despachado.
  Future<Map<String, dynamic>> registrarVenta({required List<Map<String, dynamic>> items, required String formaPago, String? clienteId, double descuentoPct = 0, String? pedidoId, String referenciaPago = ''}) async =>
      await _post('/ventas', {
        'items': items, 'formaPago': formaPago, 'descuentoPct': descuentoPct, 'referenciaPago': referenciaPago,
        if (clienteId != null) 'clienteId': clienteId,
        if (pedidoId != null) 'pedidoId': pedidoId,
      }, idempotente: true) as Map<String, dynamic>;

  /// Insumo: merma/consumo/vencimiento/ajuste. Producto: merma/vencimiento o devolución de cliente.
  Future<void> registrarBaja({required bool producto, required String id, required double cantidad, required String motivoTipo, required String motivo}) async =>
      await _post(producto ? '/inventario/productos' : '/inventario/movimientos', producto
          ? {'productoId': id, 'cantidad': cantidad, 'motivoTipo': motivoTipo, 'motivo': motivo}
          : {'tipo': 'MERMA', 'insumoId': id, 'cantidad': cantidad, 'motivoTipo': motivoTipo, 'motivo': motivo}, idempotente: true);

  /// criterio: LOTES_COMPLETOS (redondea hacia arriba) o PROPORCIONAL. La OP envía su requisición a Almacén.
  Future<Map<String, dynamic>> crearOrden({required String productoId, required double cantidad, required String entrega, String criterio = 'LOTES_COMPLETOS'}) async =>
      await _post('/ordenes-produccion', {'productoId': productoId, 'cantidad': cantidad, 'entrega': entrega, 'criterio': criterio}, idempotente: true) as Map<String, dynamic>;

  Future<List<dynamic>> requisiciones() async => await _get('/requisiciones') as List<dynamic>;

  /// Almacén entrega insumos de una requisición: el stock baja en ese momento (RN-27).
  Future<Map<String, dynamic>> atenderRequisicion(String codigo, List<Map<String, dynamic>> lineas) async =>
      await _post('/requisiciones/$codigo/atender', {'lineas': lineas}, idempotente: true) as Map<String, dynamic>;

  Future<void> iniciarOrden(String codigo) async => await _post('/ordenes-produccion/$codigo/iniciar', {});

  /// Cierre (A17): unidades buenas, merma en unidades con su motivo y horas reales (opcionales).
  Future<Map<String, dynamic>> cerrarOrden(String codigo, num buenas, num merma, String motivoTipo, String motivo, {num? horasHombre, num? horasHorno}) async =>
      await _post('/ordenes-produccion/$codigo/cerrar', {
        'unidadesBuenas': buenas,
        'unidadesMerma': merma,
        if (merma > 0) 'motivoMermaTipo': motivoTipo,
        'motivoMerma': motivo,
        if (horasHombre != null) 'horasHombreReal': horasHombre,
        if (horasHorno != null) 'horasHornoReal': horasHorno,
      }, idempotente: true) as Map<String, dynamic>;

  /// Cuentas por cobrar abiertas. El servidor ya filtra por permiso.
  Future<Map<String, dynamic>> avisosClientes() async => await _get('/avisos-clientes') as Map<String, dynamic>;
  Future<Map<String, dynamic>> enviarAvisoClientes(String titulo, String cuerpo, bool todos, List<String> clienteIds) async =>
      await _post('/avisos-clientes', {'titulo': titulo, 'cuerpo': cuerpo, 'todos': todos, 'clienteIds': clienteIds}) as Map<String, dynamic>;
  Future<List<dynamic>> cartera() async => await _get('/cxc') as List<dynamic>;

  /// Recibo de cobro: una o varias formas de pago aplicadas a las compras elegidas (las más antiguas primero).
  Future<Map<String, dynamic>> registrarRecibo(Map<String, dynamic> datos, {String? claveIdempotencia}) async =>
      await _post('/cobranza/recibos', datos, idempotente: true, claveIdempotencia: claveIdempotencia) as Map<String, dynamic>;

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
  Future<Map<String, dynamic>> cambiarEstadoPedido(String codigo, String estado, {String motivo = '', String? claveIdempotencia}) async =>
      await _enviar('PATCH', '/pedidos/$codigo/estado', {'estado': estado, 'motivo': motivo, 'observaciones': motivo}, claveIdempotencia: claveIdempotencia) as Map<String, dynamic>;

  /// PED-07: el cliente cancela su pedido (solo antes de producción), con motivo.
  Future<void> cancelarPedido(String codigo, String motivo) async => await _post('/pedidos/$codigo/cancelar', {'motivo': motivo});

  Future<List<dynamic>> misDirecciones() async => await _get('/mis-direcciones') as List<dynamic>;
  Future<void> agregarDireccion(String direccion, String referencia) async => await _post('/mis-direcciones', {'direccion': direccion, 'referencia': referencia});
  Future<void> quitarDireccion(String id) async => await _enviar('DELETE', '/mis-direcciones/$id', {});

  /// Ficha del cliente: contacto, documento, celular y direcciones (máximo en Parámetros).
  Future<Map<String, dynamic>> miFicha() async => await _get('/mi-ficha') as Map<String, dynamic>;
  Future<void> guardarFicha({required String contacto, required String telefono}) async => await _enviar('PATCH', '/mi-ficha', {'contacto': contacto, 'telefono': telefono});

  /// VEN-06: cancela varios pedidos con un motivo; devuelve los cancelados y los que no se pudieron.
  Future<Map<String, dynamic>> cancelarVarios(List<String> codigos, String motivo) async =>
      await _post('/pedidos/cancelar-varios', {'codigos': codigos, 'motivo': motivo}) as Map<String, dynamic>;

  /// Promociones (permiso promociones.gestionar).
  Future<List<dynamic>> promociones() async => await _get('/promociones') as List<dynamic>;
  Future<void> guardarPromocion(String? id, Map<String, dynamic> datos) async =>
      id == null ? await _post('/promociones', datos) : await _enviar('PATCH', '/promociones/$id', datos);

  /// Caracteres mínimos de una contraseña nueva (Parámetros → clave_longitud_minima).
  int get claveMinima => ((config['seguridad'] as Map?)?['claveMinima'] as num?)?.toInt() ?? 5;

  /// SEG-04: autorregistro del cliente (sin sesión). Devuelve el mensaje del servidor.
  Future<String> registrarse(Map<String, dynamic> datos) async =>
      '${(await _post('/auth/registro', datos, sinAuth: true) as Map)['mensaje']}';

  /// PATCH/PUT/DELETE con renovación de token y tiempo límite, igual que _get/_post.
  Future<dynamic> _enviar(String metodo, String ruta, Map<String, dynamic> cuerpo, {bool reintentar = true, String? claveIdempotencia}) async {
    Future<http.Response> mandar() async {
      final req = http.Request(metodo, Uri.parse('$base$ruta'))
        ..headers.addAll(_cabeceras(conCuerpo: true))
        ..headers.addAll({if (claveIdempotencia != null) 'Idempotency-Key': claveIdempotencia})
        ..body = jsonEncode(cuerpo);
      return http.Response.fromStream(await req.send().timeout(_limite));
    }

    late http.Response r;
    try {
      r = await mandar();
      if (r.statusCode == 401 && reintentar && await _refrescar()) r = await mandar();
    } catch (_) {
      throw SinConexion();
    }
    return _trasCambio(ruta, await _decodificar(r));
  }

  /// Activación de una app sin dominio compilado. Acepta "https://dominio" y completa /api/v1.
  /// Cambiar de servidor cierra la sesión: los tokens de otro servidor no sirven aquí.
  Future<void> cambiarServidor(String url) async {
    if (activada) return;
    // Acepta el enlace del QR (tanta://activar?servidor=…) o la dirección escrita a mano.
    var u = url.trim();
    final enlace = Uri.tryParse(u);
    if (enlace?.scheme == 'tanta') u = enlace!.queryParameters['servidor'] ?? '';
    if (!u.contains('://')) u = 'https://$u';
    u = u.replaceAll(RegExp(r'/+$'), '');
    if (!u.startsWith('https://') && kReleaseMode) throw ApiException(422, 'El servidor debe usar https://');
    if (Uri.tryParse(u)?.host.isEmpty ?? true) throw ApiException(422, 'Dirección inválida');
    if (!u.endsWith('/api/v1')) u = '$u/api/v1';
    // Solo se guarda si de verdad es un servidor Tanta.
    try {
      final r = await http.get(Uri.parse('$u/config/publica')).timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) throw 0;
    } catch (_) {
      throw ApiException(422, 'No se encontró un servidor Tanta en esa dirección');
    }
    await cerrarSesion();
    base = u;
    await _seguro.write(key: 'servidor', value: u);
    await cargarConfig();
  }

  /* --------------------------------------------- configuración y perfil */
  Future<Map<String, dynamic>> cargarConfig() async {
    if (!activada) return config;
    try {
      // 5 s: sin red la app abre igual con la marca por defecto.
      final r = await http.get(Uri.parse('$base/config/publica')).timeout(const Duration(seconds: 5));
      if (r.statusCode == 200) config = jsonDecode(r.body) as Map<String, dynamic>;
    } catch (_) {/* sin red: se usa la marca por defecto */}
    await _seguirServidorIndicado();
    return config;
  }

  /// Si el superadmin indicó otro servidor (Configuración → App móvil), la app se muda sola,
  /// pero solo a https y solo si el nuevo responde: nunca queda apuntando a la nada.
  Future<void> _seguirServidorIndicado() async {
    final indicado = '${(config['movil'] as Map?)?['urlApi'] ?? ''}'.trim().replaceAll(RegExp(r'/+$'), '');
    if (indicado.isEmpty || indicado == base || !indicado.startsWith('https://')) return;
    try {
      final r = await http.get(Uri.parse('$indicado/config/publica')).timeout(const Duration(seconds: 5));
      if (r.statusCode != 200) return;
      // Las credenciales son del servidor anterior: no se envían al nuevo (se vuelve a ingresar).
      if (_refresco != null || _acceso != null) await cerrarSesion();
      base = indicado;
      config = jsonDecode(r.body) as Map<String, dynamic>;
      await _seguro.write(key: 'servidor', value: indicado);
    } catch (_) {/* el nuevo aún no responde: se reintenta en la próxima apertura */}
  }

  /* ------------------------------------------------ recuperar contraseña */
  /// ¿El Superadmin configuró el correo? Si no, el enlace no se muestra.
  Future<bool> recuperacionDisponible() async {
    try {
      final r = await http.get(Uri.parse('$base/auth/recuperar/disponible')).timeout(const Duration(seconds: 5));
      return r.statusCode == 200 && (jsonDecode(r.body) as Map)['disponible'] == true;
    } catch (_) {
      return false;
    }
  }

  Future<String> pedirCodigo(String identificador) async =>
      '${(await _post('/auth/recuperar', {'identificador': identificador}, sinAuth: true) as Map)['mensaje']}';

  Future<String> restablecerClave(String identificador, String codigo, String nueva) async =>
      '${(await _post('/auth/restablecer', {'identificador': identificador, 'codigo': codigo, 'nueva': nueva}, sinAuth: true) as Map)['mensaje']}';

  /* ------------------------------------------------------- pedidos y OP */
  Future<List<dynamic>> misPedidos() async => await _get('/pedidos') as List<dynamic>;

  /// El cliente no elige forma de pago al pedir: cómo paga (o si queda debiendo) se registra al entregar.
  /// La fecha de entrega la calcula el servidor con la hora de corte; va a la tienda del cliente.
  Future<Map<String, dynamic>> crearPedido({required List<Map<String, dynamic>> items, String observaciones = '', String direccion = '', String? comprobanteTipo}) async =>
      await _post('/pedidos', {'items': items, 'observaciones': observaciones, 'direccion': direccion, if (comprobanteTipo != null) 'comprobanteTipo': comprobanteTipo},
          idempotente: true) as Map<String, dynamic>;
  Future<String> entregaEstimada() async => '${(await _get('/pedidos/entrega-estimada') as Map)['fecha']}';
  Future<List<dynamic>> promocionesVigentes() async => await _get('/promociones/vigentes') as List<dynamic>;
  Future<Map<String, dynamic>> corregirPedido(String codigo, List<Map<String, dynamic>> items) async =>
      await _enviar('PUT', '/pedidos/$codigo/items', {'items': items}) as Map<String, dynamic>;

  // Despacho
  Future<Map<String, dynamic>> despacho() async => await _get('/despacho') as Map<String, dynamic>;
  Future<void> guardarVehiculo(String? id, Map<String, dynamic> datos) async => id == null ? await _post('/vehiculos', datos) : await _enviar('PATCH', '/vehiculos/$id', datos);
  Future<Map<String, dynamic>> despacharPedido({required String pedidoId, required String vehiculoId, required List<Map<String, dynamic>> items, required List<Map<String, dynamic>> empaques}) async =>
      await _post('/ventas', {'pedidoId': pedidoId, 'vehiculoId': vehiculoId, 'items': items, 'empaques': empaques}, idempotente: true) as Map<String, dynamic>;

  // Gastos de caja chica
  Future<List<dynamic>> gastos() async => await _get('/pagos-costos') as List<dynamic>;
  Future<Map<String, dynamic>> registrarGasto(Map<String, dynamic> datos) async => await _post('/pagos-costos', datos, idempotente: true) as Map<String, dynamic>;

  // Hoja de producción
  Future<Map<String, dynamic>> hojaProduccion(String? fecha) async => await _get('/produccion/hoja${fecha == null ? '' : '?fecha=$fecha'}') as Map<String, dynamic>;
  Future<List<dynamic>> hojasProduccion() async => await _get('/produccion/hojas') as List<dynamic>;
  Future<Map<String, dynamic>> detalleHoja(String codigo) async => await _get('/produccion/hojas/${Uri.encodeComponent(codigo)}') as Map<String, dynamic>;
  Future<Map<String, dynamic>> cerrarPedidosHoja(String fecha) async => await _post('/produccion/hoja/cerrar-pedidos', {'fecha': fecha}) as Map<String, dynamic>;
  Future<Map<String, dynamic>> cerrarProduccionHoja(String codigo, List<Map<String, dynamic>> lineas, {bool confirmar = false}) async =>
      await _post('/produccion/hojas/${Uri.encodeComponent(codigo)}/cerrar', {'lineas': lineas, 'confirmar': confirmar}) as Map<String, dynamic>;

  /// El vendedor avisa al cliente que su pedido parece mal hecho (el pedido no se mueve).
  Future<void> observarPedido(String codigo, String mensaje) async => await _post('/pedidos/$codigo/observar', {'mensaje': mensaje});

  /// Entregar y cobrar en un paso: [pagos] vacío = queda todo como deuda.
  Future<Map<String, dynamic>> entregarPedido(String codigo, {List<Map<String, dynamic>> pagos = const [], String observaciones = '', String? voucher, String? claveIdempotencia}) async =>
      await _enviar('PATCH', '/pedidos/$codigo/estado', {'estado': 'ENTREGADO', 'motivo': '', 'observaciones': observaciones, 'pagos': pagos, 'voucher': voucher}, claveIdempotencia: claveIdempotencia) as Map<String, dynamic>;

  /// Caja del vendedor: lo cobrado hoy por forma de pago, recibos, entregas y su rendición.
  Future<Map<String, dynamic>> miDia() async => await _get('/cobranza/mi-dia') as Map<String, dynamic>;

  /// Rinde el día a caja: el servidor calcula lo esperado; aquí solo el efectivo que se entrega.
  Future<Map<String, dynamic>> rendirDia(double efectivoEntregado, String nota) async =>
      await _post('/cobranza/rendiciones', {'efectivoEntregado': efectivoEntregado, 'nota': nota}) as Map<String, dynamic>;

  /// A09: línea de tiempo del pedido (solo los propios para el cliente).
  Future<List<dynamic>> historialPedido(String codigo) async => await _get('/pedidos/$codigo/historial') as List<dynamic>;

  /// A11: centro de notificaciones.
  Future<Map<String, dynamic>> notificaciones() async => await _get('/notificaciones') as Map<String, dynamic>;
  Future<void> marcarLeidas(List<int>? ids) async => await _post('/notificaciones/leidas', {if (ids != null) 'ids': ids});

  /// Texto de la política de privacidad o de los términos (público, sin sesión).
  Future<Map<String, dynamic>> legal(String doc) async => await _get('/legal/$doc') as Map<String, dynamic>;
  Future<Map<String, dynamic>> perfil() async => await _get('/perfil') as Map<String, dynamic>;

  Future<void> actualizarPerfil({required String nombre, required String email, required String telefono, String? clave}) async {
    await _enviar('PATCH', '/perfil', {'nombre': nombre, 'email': email, 'telefono': telefono, if (clave != null && clave.isNotEmpty) 'clave': clave});
    await yo();
  }

  Future<void> cambiarClave(String actual, String nueva) async =>
      await _post('/perfil/clave', {'actual': actual, 'nueva': nueva});

  Future<void> subirFoto(List<int> bytes) async {
    final r = await _enviar('PUT', '/perfil/foto', {'base64': base64Encode(bytes)}) as Map<String, dynamic>;
    fotoUrl = r['fotoUrl'] as String?;
  }

  /// App Store 5.1.1(v) / Google Play: eliminar la cuenta desde la app.
  Future<void> eliminarCuenta(String clave) async {
    await _enviar('DELETE', '/perfil', {'clave': clave});
    await cerrarSesion();
  }

  /// Id estable de esta instalación (no del usuario ni del teléfono): para versiones y push.
  Future<String> instalacion() async {
    final previa = await _seguro.read(key: 'instalacion');
    if (previa != null) return previa;
    final nueva = _uuid();
    await _seguro.write(key: 'instalacion', value: nueva);
    return nueva;
  }

  Future<Map<String, dynamic>> registrarDispositivo({required String plataforma, required String version, String? tokenPush}) async =>
      await _post('/dispositivo', {
        'instalacion': await instalacion(),
        'plataforma': plataforma,
        'versionApp': version,
        if (tokenPush != null) 'tokenPush': tokenPush,
      }) as Map<String, dynamic>;

  /// Permiso del rol Y módulo activo: el superadmin puede apagar una sección para todos
  /// (Configuración → App móvil → Módulos). El servidor vuelve a validar el permiso igual.
  bool puede(String permiso) => permisos.contains(permiso) && moduloActivo(_modulos[permiso.split('.').first] ?? '');

  static const _modulos = {'pedidos': 'pedidos', 'ventas': 'ventas', 'cobranza': 'cobranza', 'produccion': 'produccion', 'inventario': 'almacen', 'requisiciones': 'almacen', 'catalogo': 'catalogo'};

  bool moduloActivo(String modulo) => modulo.isEmpty || ((config['movil'] as Map?)?['modulos'] as Map?)?[modulo] != false;
}

/// Paso pendiente del ingreso: código de la app autenticadora, o activarla por primera vez.
class PasoMfa {
  PasoMfa(this.ticket, {required this.enrolar});
  final String ticket;
  final bool enrolar;
}

class ApiException implements Exception {
  ApiException(this.status, this.mensaje);
  final int status;
  final String mensaje;

  /// Errores de negocio: reintentar no sirve, hay que corregir el dato.
  /// Los 408/429 sí son transitorios, y un 401 (sesión vencida) se resuelve volviendo a entrar:
  /// una operación de dinero nunca se descarta porque caducó el token.
  bool get esDefinitivo => status >= 400 && status < 500 && status != 401 && status != 408 && status != 429;

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