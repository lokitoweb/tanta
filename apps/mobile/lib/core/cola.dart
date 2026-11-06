import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';

/// Una operación que ocurrió en el mostrador y todavía no llegó al servidor.
class OperacionPendiente {
  OperacionPendiente({
    required this.id,
    required this.tipo,
    required this.datos,
    required this.clave,
    required this.creada,
    this.descripcion = '',
    this.usuario = '',
  });

  final String id;
  final String tipo; // 'pago' | 'pedido'
  final Map<String, dynamic> datos;

  /// Se genera al encolar y **no cambia** en los reintentos: el servidor la usa
  /// para no aplicar dos veces el mismo cobro.
  final String clave;
  final DateTime creada;
  final String descripcion;

  /// Usuario que la registró: solo se envía con su sesión (otro usuario del mismo equipo no la firma).
  final String usuario;

  Map<String, dynamic> aJson() => {
        'id': id,
        'tipo': tipo,
        'datos': datos,
        'clave': clave,
        'creada': creada.toIso8601String(),
        'descripcion': descripcion,
        'usuario': usuario,
      };

  factory OperacionPendiente.desdeJson(Map<String, dynamic> j) => OperacionPendiente(
        id: j['id'] as String,
        tipo: j['tipo'] as String,
        datos: (j['datos'] as Map).cast<String, dynamic>(),
        clave: j['clave'] as String,
        creada: DateTime.tryParse('${j['creada']}') ?? DateTime.now(),
        descripcion: '${j['descripcion'] ?? ''}',
        usuario: '${j['usuario'] ?? ''}',
      );
}

/// Cola persistente de operaciones.
///
/// El mostrador no puede dejar de cobrar porque el WiFi parpadee. Cada acción
/// se guarda en disco, se reintenta en orden y solo se descarta cuando el
/// servidor confirma (o cuando el error es de negocio y reintentar no sirve).
class ColaOffline {
  ColaOffline._();
  static final ColaOffline instancia = ColaOffline._();

  static const _llave = 'tanta.cola.v1';

  final ValueNotifier<int> pendientes = ValueNotifier<int>(0);
  final ValueNotifier<bool> sincronizando = ValueNotifier<bool>(false);
  final ValueNotifier<String?> ultimoAviso = ValueNotifier<String?>(null);

  List<OperacionPendiente> _items = [];
  bool _cargada = false;
  bool _enCurso = false;

  Future<void> cargar() async {
    if (_cargada) return;
    final prefs = await SharedPreferences.getInstance();
    final crudo = prefs.getString(_llave);
    if (crudo != null) {
      try {
        final lista = jsonDecode(crudo) as List;
        _items = lista.map((e) => OperacionPendiente.desdeJson((e as Map).cast<String, dynamic>())).toList();
      } catch (_) {
        _items = [];
      }
    }
    _cargada = true;
    pendientes.value = _items.length;
  }

  Future<void> _guardar() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_llave, jsonEncode(_items.map((i) => i.aJson()).toList()));
    pendientes.value = _items.length;
  }

  /// Clave de idempotencia para enviar ya y, si no hay red, encolar con la misma.
  String nuevaClave() => _nuevoId();

  String _nuevoId() {
    final r = Random.secure();
    final b = List<int>.generate(16, (_) => r.nextInt(256));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    return b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  }

  /// Encola una operación para enviarla cuando haya red.
  Future<OperacionPendiente> encolar(
    String tipo,
    Map<String, dynamic> datos, {
    String descripcion = '',
    String? clave,
  }) async {
    await cargar();
    final op = OperacionPendiente(
      id: _nuevoId(),
      tipo: tipo,
      datos: datos,
      clave: clave ?? _nuevoId(),
      creada: DateTime.now(),
      descripcion: descripcion,
      usuario: Api.instancia.usuarioId,
    );
    _items.add(op);
    await _guardar();
    return op;
  }

  /// Intenta enviar todo lo pendiente, en orden.
  ///
  /// Devuelve cuántas se aplicaron. Se detiene al primer fallo de red:
  /// si el servidor no responde, no tiene sentido seguir intentando.
  ///
  /// [enviador] permite sustituir el transporte en las pruebas; en producción
  /// se usa [enviar], que habla con el API.
  Future<int> sincronizar(
    Api api, {
    Future<void> Function(OperacionPendiente)? enviador,
  }) async {
    await cargar();
    if (_enCurso || _items.isEmpty) return 0;

    _enCurso = true;
    sincronizando.value = true;
    var aplicadas = 0;
    final rechazos = <String>[];

    try {
      // Las de otro usuario esperan a que él vuelva a entrar en este equipo.
      for (final op in _items.where((x) => x.usuario.isEmpty || x.usuario == api.usuarioId).toList()) {
        try {
          if (enviador != null) {
            await enviador(op);
          } else {
            await enviar(api, op);
          }
          _items.removeWhere((x) => x.id == op.id);
          await _guardar();
          aplicadas++;
        } on SinConexion {
          // Sin red: se conserva todo y se reintenta más tarde.
          break;
        } on ApiException catch (e) {
          if (e.esDefinitivo) {
            // El servidor rechazó la operación: reintentarla la repetiría para siempre.
            _items.removeWhere((x) => x.id == op.id);
            await _guardar();
            rechazos.add(e.mensaje);
          } else {
            break; // 429 o 5xx: se reintenta después
          }
        } catch (_) {
          break;
        }
      }
    } finally {
      _enCurso = false;
      sincronizando.value = false;
    }

    if (rechazos.isNotEmpty) {
      ultimoAviso.value = 'No se pudo aplicar: ${rechazos.first}';
    } else if (aplicadas > 0) {
      ultimoAviso.value = '$aplicadas ${aplicadas == 1 ? 'operación sincronizada' : 'operaciones sincronizadas'}';
    }
    return aplicadas;
  }

  /// ¿Vale la pena intentar ahora? Evita ráfagas de peticiones inútiles.
  bool get tienePendientes => _items.isNotEmpty;
  bool get ocupada => _enCurso || sincronizando.value;

  /// Envía una operación concreta. Reutiliza la clave de idempotencia original.
  static Future<void> enviar(Api api, OperacionPendiente op) async {
    switch (op.tipo) {
      case 'pago':
        await api.registrarPago(
          cxcId: '${op.datos['cxcId']}',
          monto: (op.datos['monto'] as num),
          medio: '${op.datos['medio']}',
          referencia: op.datos['referencia'] as String?,
          claveIdempotencia: op.clave,
        );
      case 'recibo':
        await api.registrarRecibo({
          'clienteId': op.datos['clienteId'],
          'cxcIds': op.datos['cxcIds'],
          'pagos': op.datos['pagos'],
        }, claveIdempotencia: op.clave);
      case 'pedido':
        await api.cambiarEstadoPedido('${op.datos['codigo']}', '${op.datos['estado']}');
      default:
        throw ApiException(400, 'Tipo de operación desconocido: ${op.tipo}');
    }
  }

  List<OperacionPendiente> get items => List.unmodifiable(_items);

  Future<void> vaciar() async {
    _items = [];
    await _guardar();
  }
}
