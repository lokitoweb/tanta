import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:tanta_app/core/api.dart';
import 'package:tanta_app/core/cola.dart';

/// Lo que hay que garantizar de una cola offline:
///  1. lo que se encola sobrevive a cerrar la app,
///  2. la clave de idempotencia no cambia entre reintentos,
///  3. el orden se respeta,
///  4. sin red se conserva todo y se para,
///  5. un error de negocio se descarta (reintentarlo lo repetiría para siempre),
///  6. un fallo transitorio se conserva para el siguiente intento.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await ColaOffline.instancia.vaciar();
  });

  Future<void> encolarDos() async {
    await ColaOffline.instancia.encolar('pago', {'cxcId': 'a', 'monto': 1, 'medio': 'EFECTIVO'});
    await ColaOffline.instancia.encolar('pedido', {'codigo': 'PED-1', 'estado': 'LISTO'});
  }

  test('una operación encolada se recupera tras reiniciar la app', () async {
    await ColaOffline.instancia.encolar(
      'pago',
      {'cxcId': 'cxc-1', 'monto': 120.5, 'medio': 'EFECTIVO'},
      descripcion: 'Cobro 120.50',
    );
    expect(ColaOffline.instancia.pendientes.value, 1);

    final prefs = await SharedPreferences.getInstance();
    final crudo = prefs.getString('tanta.cola.v1');
    expect(crudo, isNotNull);
    expect(crudo, contains('cxc-1'));
    expect(crudo, contains('EFECTIVO'));
  });

  test('la clave de idempotencia se mantiene estable entre reintentos', () async {
    final antes = await ColaOffline.instancia.encolar('pago', {'cxcId': 'x', 'monto': 10, 'medio': 'YAPE'});
    final despues = ColaOffline.instancia.items.first;

    expect(despues.id, antes.id);
    expect(despues.clave, antes.clave);
    expect(despues.clave.length, greaterThan(20));
  });

  test('las operaciones conservan el orden en que ocurrieron', () async {
    await ColaOffline.instancia.encolar('pago', {'cxcId': 'a', 'monto': 1, 'medio': 'EFECTIVO'});
    await ColaOffline.instancia.encolar('pedido', {'codigo': 'PED-1', 'estado': 'LISTO'});
    await ColaOffline.instancia.encolar('pago', {'cxcId': 'c', 'monto': 3, 'medio': 'PLIN'});

    final items = ColaOffline.instancia.items;
    expect(items.length, 3);
    expect(items[0].datos['cxcId'], 'a');
    expect(items[1].tipo, 'pedido');
    expect(items[2].datos['cxcId'], 'c');
  });

  test('sin red se conserva todo y se detiene en la primera', () async {
    await encolarDos();
    var intentos = 0;

    final aplicadas = await ColaOffline.instancia.sincronizar(
      Api.instancia,
      enviador: (_) async {
        intentos++;
        throw SinConexion();
      },
    );

    expect(aplicadas, 0);
    expect(intentos, 1, reason: 'no debe seguir intentando si el servidor no responde');
    expect(ColaOffline.instancia.pendientes.value, 2);
  });

  test('un error de negocio sale de la cola y avisa', () async {
    await encolarDos();

    final aplicadas = await ColaOffline.instancia.sincronizar(
      Api.instancia,
      enviador: (op) async {
        if (op.tipo == 'pago') throw ApiException(422, 'MONTO_EXCEDE_SALDO');
        // el pedido sí se aplica
      },
    );

    expect(aplicadas, 1);
    expect(ColaOffline.instancia.pendientes.value, 0,
        reason: 'el cobro inválido no puede quedarse para siempre');
    expect(ColaOffline.instancia.ultimoAviso.value, contains('MONTO_EXCEDE_SALDO'));
  });

  test('un fallo transitorio (503) se conserva para el siguiente intento', () async {
    await encolarDos();

    final aplicadas = await ColaOffline.instancia.sincronizar(
      Api.instancia,
      enviador: (_) async => throw ApiException(503, 'servicio no disponible'),
    );

    expect(aplicadas, 0);
    expect(ColaOffline.instancia.pendientes.value, 2);
  });

  test('cuando todo va bien la cola queda vacía', () async {
    await encolarDos();

    final aplicadas = await ColaOffline.instancia.sincronizar(
      Api.instancia,
      enviador: (_) async {},
    );

    expect(aplicadas, 2);
    expect(ColaOffline.instancia.pendientes.value, 0);
    expect(ColaOffline.instancia.items, isEmpty);
  });

  test('vaciar deja la cola limpia', () async {
    await ColaOffline.instancia.encolar('pago', {'cxcId': 'z', 'monto': 5, 'medio': 'EFECTIVO'});
    await ColaOffline.instancia.vaciar();
    expect(ColaOffline.instancia.pendientes.value, 0);
    expect(ColaOffline.instancia.items, isEmpty);
  });
}
