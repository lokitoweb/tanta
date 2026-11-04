import 'package:flutter/foundation.dart';
import 'api.dart';

/// Catálogos administrables (Maestros → Catálogos en la web): medios de pago, tipos de documento,
/// tipos de insumo y unidades. Se cargan una vez al entrar; las reglas salen de sus atributos.
final catalogos = ValueNotifier<Map<String, dynamic>>({});

Future<void> cargarCatalogos() async {
  try { catalogos.value = await Api.instancia.catalogos(); } catch (_) {}
}

/// Sin conexión todavía se puede cobrar en efectivo.
const _efectivo = {'codigo': 'EFECTIVO', 'nombre': 'Efectivo', 'requiereOperacion': false, 'enVentas': true, 'enCobranza': true,
  'enCompras': true, 'cajaChica': true, 'esCredito': false};

List<Map<String, dynamic>> _lista(String clave) => ((catalogos.value[clave] as List?) ?? const []).cast<Map<String, dynamic>>();

/// Medios habilitados para un proceso: 'enVentas', 'enCobranza' o 'enCompras'.
List<Map<String, dynamic>> mediosPago(String uso) {
  final l = _lista('mediosPago').where((m) => m[uso] == true).toList();
  return l.isEmpty ? [_efectivo] : l;
}

Map<String, dynamic>? medioPago(String codigo) => _lista('mediosPago').where((m) => m['codigo'] == codigo).firstOrNull;
bool requiereOperacion(String codigo) => medioPago(codigo)?['requiereOperacion'] == true;
bool esCredito(String codigo) => medioPago(codigo)?['esCredito'] == true;
String nombreMedio(String codigo) => '${medioPago(codigo)?['nombre'] ?? codigo}';

List<Map<String, dynamic>> tiposDocumento() {
  final l = _lista('tiposDocumento');
  return l.isEmpty ? [{'codigo': 'FACTURA', 'nombre': 'Factura', 'creditoFiscal': true}] : l;
}
