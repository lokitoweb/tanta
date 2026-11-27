import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/catalogos.dart';
import '../core/tema.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

String _mensaje(Object e) => e is ApiException ? e.mensaje : 'Sin conexión: intenta de nuevo';
double _n(Object? v) => (v as num?)?.toDouble() ?? 0;

class _Linea {
  _Linea(this.p, this.precio) : promocionId = (p['promocion'] as Map?)?['id'] as String?;
  Map<String, dynamic> p;
  final String? promocionId;
  int cantidad = 1;
  final TextEditingController precio;
  /// Precio de referencia: el de la oferta vigente (ya aprobado al publicarla) o el de lista.
  double get base => promocionId != null ? _n((p['promocion'] as Map)['precio']) : _n(p['precio']);
  double get valor => double.tryParse(precio.text.replaceAll(',', '.')) ?? -1;
  double get rebaja => base > 0 && valor >= 0 ? (1 - valor / base).clamp(0, 1).toDouble() : 0;
}

/// Venta de stock (respuesta del ingeniero): el vendedor vende pan ya producido. Ve lo libre (sin lo apartado ni lo vencido)
/// y lo que vence hoy, pone el precio de cada producto y, si lo baja del tope de Parámetros, pide la aprobación del Gerente.
/// El pan queda apartado y el pedido va directo a Despacho; sale del almacén al despachar.
class VentaStock extends StatefulWidget {
  const VentaStock({super.key, required this.datos});
  final Map<String, dynamic> datos;
  @override
  State<VentaStock> createState() => _VentaStockState();
}

class _VentaStockState extends State<VentaStock> {
  Map<String, dynamic>? _stock;
  String? _error;
  String? _cliente;
  List<Map<String, dynamic>> _direcciones = [];
  String _direccion = '';
  final List<_Linea> _lineas = [];
  String? _comprobante;
  List<Map<String, dynamic>> _aprobaciones = [];
  bool _enviando = false;

  List<Map<String, dynamic>> get _clientes => ((widget.datos['clientes'] as List?) ?? const []).cast<Map<String, dynamic>>();
  double get _tope => _n(_stock?['descuentoMaximo']);
  double get _rebaja => _lineas.fold<double>(0, (m, l) => l.rebaja > m ? l.rebaja : m);
  bool get _pideAprobacion => _rebaja > _tope + 1e-6;
  double get _total => _lineas.fold<double>(0, (s, l) => s + (l.valor < 0 ? 0 : l.valor) * l.cantidad);
  String get _nombreCliente => '${_clientes.where((c) => c['id'] == _cliente).firstOrNull?['nombre'] ?? ''}';
  Map<String, dynamic>? get _aprobacion {
    final l = _aprobaciones.where((a) => a['vigente'] == true && _n(a['porcentaje']) + 1e-6 >= _rebaja && (a['cliente'] == null || a['cliente'] == _nombreCliente)).toList()
      ..sort((a, b) => _n(a['porcentaje']).compareTo(_n(b['porcentaje'])));
    return l.firstOrNull;
  }

  @override
  void initState() {
    super.initState();
    _cargar();
    final c = comprobantesVenta();
    if (c.isNotEmpty) _comprobante = '${c.first['codigo']}';
  }

  @override
  void dispose() {
    for (final l in _lineas) { l.precio.dispose(); }
    super.dispose();
  }

  Future<void> _cargar() async {
    try {
      final s = await Api.instancia.productosStock(clienteId: _cliente);
      final a = await Api.instancia.solicitudesDescuento();
      if (!mounted) return;
      setState(() {
        _stock = s; _aprobaciones = a.cast<Map<String, dynamic>>(); _error = null;
        // Precios de la lista del cliente: las líneas sin oferta toman el precio nuevo.
        final prods = ((s['productos'] as List?) ?? const []).cast<Map<String, dynamic>>();
        for (final l in _lineas) {
          final p = prods.where((x) => x['id'] == l.p['id']).firstOrNull;
          if (p == null) continue;
          l.p = p;
          if (l.promocionId == null) l.precio.text = _n(p['precio']).toStringAsFixed(2);
        }
      });
    } catch (e) {
      if (mounted) setState(() => _error = _mensaje(e));
    }
  }

  Future<void> _elegirCliente(String? id) async {
    setState(() { _cliente = id; _direcciones = []; _direccion = ''; });
    if (id == null) return;
    _cargar();
    try {
      final r = await Api.instancia.direccionesCliente(id);
      final l = ((r['direcciones'] as List?) ?? const []).cast<Map<String, dynamic>>();
      if (mounted && _cliente == id) setState(() { _direcciones = l; _direccion = l.isEmpty ? '' : '${l.first['direccion']}'; });
    } catch (_) {}
  }

  void _aviso(String t, {Color? color}) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(t), backgroundColor: color));

  Future<void> _pedirAprobacion() async {
    setState(() => _enviando = true);
    try {
      await Api.instancia.pedirAprobacion(porcentaje: double.parse(_rebaja.clamp(0, 0.9).toStringAsFixed(4)), clienteId: _cliente, paraStock: true,
          motivo: 'Venta de stock a $_nombreCliente: ${_lineas.map((l) => '${l.cantidad} ${l.p['nombre']} a ${dinero(l.valor)}').join(', ')}'.characters.take(200).toString());
      _aviso('Se pidió al Gerente aprobar ${(_rebaja * 100).ceil()} %. Cuando apruebe, actualiza y registra.', color: TantaColors.stateInfo);
      await _cargar();
    } catch (e) {
      _aviso(_mensaje(e), color: TantaColors.stateDanger);
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  Future<void> _registrar() async {
    final nav = Navigator.of(context);
    final aviso = ScaffoldMessenger.of(context);
    setState(() => _enviando = true);
    try {
      final r = await Api.instancia.crearVentaStock({
        'clienteId': _cliente,
        'items': [for (final l in _lineas) {'productoId': l.p['id'], 'cantidad': l.cantidad, 'precio': l.valor, if (l.promocionId != null) 'promocionId': l.promocionId}],
        'direccion': _direccion, 'tipoEntrega': _direccion.isEmpty ? 'RECOJO' : 'DELIVERY',
        if (_comprobante != null) 'comprobanteTipo': _comprobante,
        if (_pideAprobacion && _aprobacion != null) 'aprobacionId': _aprobacion!['id'],
      });
      aviso.showSnackBar(SnackBar(content: Text('Venta de stock ${r['codigo']} · ${dinero(_n(r['total']))} · lista para despacho'), backgroundColor: TantaColors.stateOk));
      nav.pop(true);
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e)), backgroundColor: TantaColors.stateDanger));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final stock = _stock;
    final productos = ((stock?['productos'] as List?) ?? const []).cast<Map<String, dynamic>>().where((p) => _n(p['libre']) > 0).toList();
    final faltaPrecio = _lineas.any((l) => l.valor < 0);
    final puede = _cliente != null && _lineas.isNotEmpty && !faltaPrecio && !_enviando && (!_pideAprobacion || _aprobacion != null);
    return Scaffold(
      appBar: AppBar(title: const Text('Venta de stock'), actions: [IconButton(tooltip: 'Actualizar', onPressed: _cargar, icon: const Icon(Icons.refresh))]),
      body: _error != null
          ? ListView(children: [ErrorReintentar(mensaje: _error!, onReintentar: _cargar)])
          : stock == null
              ? const Esqueleto()
              : ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 140), children: [
                  const Text('Pan ya producido: se aparta ahora, no pasa por producción y va directo a Despacho.', style: TextStyle(color: TantaColors.textMuted)),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue: _cliente, isExpanded: true,
                    decoration: const InputDecoration(labelText: 'Cliente'),
                    items: [for (final c in _clientes) DropdownMenuItem(value: '${c['id']}', child: Text('${c['nombre']}', overflow: TextOverflow.ellipsis))],
                    onChanged: _elegirCliente,
                  ),
                  const SizedBox(height: 12),
                  // La dirección se elige de las del cliente (no se escribe); se agregan en la ficha del cliente (web).
                  DropdownButtonFormField<String>(
                    key: ValueKey('dir-$_cliente-${_direcciones.length}'),
                    initialValue: _direccion, isExpanded: true,
                    decoration: InputDecoration(labelText: 'Entrega', helperText: _cliente != null && _direcciones.isEmpty ? 'Sin direcciones registradas: recojo en tienda' : null),
                    items: [
                      for (final d in _direcciones) DropdownMenuItem(value: '${d['direccion']}', child: Text('${'${d['alias'] ?? ''}'.isEmpty ? '' : '${d['alias']}: '}${d['direccion']}', overflow: TextOverflow.ellipsis)),
                      const DropdownMenuItem(value: '', child: Text('Recojo en tienda')),
                    ],
                    onChanged: (v) => setState(() => _direccion = v ?? ''),
                  ),
                  const SizedBox(height: 16),
                  for (final l in _lineas) _linea(l),
                  const SizedBox(height: 8),
                  OutlinedButton.icon(
                    icon: const Icon(Icons.add),
                    label: Text(productos.isEmpty ? 'No hay pan libre en el almacén' : 'Agregar pan'),
                    onPressed: productos.where((p) => !_lineas.any((l) => l.p['id'] == p['id'])).isEmpty ? null : () => _agregar(productos),
                  ),
                  const SizedBox(height: 12),
                  if (comprobantesVenta().isNotEmpty) DropdownButtonFormField<String>(
                    initialValue: _comprobante,
                    decoration: const InputDecoration(labelText: 'Comprobante'),
                    items: [for (final t in comprobantesVenta()) DropdownMenuItem(value: '${t['codigo']}', child: Text('${t['nombre']}'))],
                    onChanged: (v) => setState(() => _comprobante = v),
                  ),
                  const SizedBox(height: 12),
                  Text(_tope > 0 ? 'Puedes bajar el precio hasta ${(_tope * 100).round()} % sin aprobación; más que eso lo aprueba el Gerente.'
                      : 'Bajar el precio de lista lo aprueba el Gerente.', style: const TextStyle(fontSize: 12.5, color: TantaColors.textMuted)),
                  if (_pideAprobacion) Padding(padding: const EdgeInsets.only(top: 6), child: Text(
                      _aprobacion != null ? 'Aprobado por el Gerente hasta ${(_n(_aprobacion!['porcentaje']) * 100).round()} %.' : 'Esta venta baja el precio ${(_rebaja * 100).ceil()} %: necesita aprobación.',
                      style: TextStyle(fontWeight: FontWeight.w600, color: _aprobacion != null ? TantaColors.stateOk : TantaColors.stateWarn))),
                ]),
      bottomNavigationBar: SafeArea(child: Padding(
        padding: const EdgeInsets.all(16),
        child: _pideAprobacion && _aprobacion == null
            ? FilledButton.icon(icon: const Icon(Icons.verified_user_outlined), onPressed: _cliente == null || _enviando || faltaPrecio ? null : _pedirAprobacion,
                label: Text(_enviando ? 'Enviando…' : 'Pedir aprobación al Gerente'))
            : FilledButton(onPressed: puede ? _registrar : null, child: Text(_enviando ? 'Registrando…' : 'Registrar · ${dinero(_total)}')),
      )),
    );
  }

  Widget _linea(_Linea l) {
    final libre = _n(l.p['libre']).toInt();
    final venceHoy = _n(l.p['venceHoy']);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Panel(
        padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text('${l.p['nombre']}', style: const TextStyle(fontWeight: FontWeight.w600))),
            IconButton(tooltip: 'Quitar', icon: const Icon(Icons.close), onPressed: () => setState(() { _lineas.remove(l); l.precio.dispose(); })),
          ]),
          Text('Quedan $libre${venceHoy > 0 ? ' · ${venceHoy.toStringAsFixed(0)} vencen hoy' : ''} · lista ${dinero(l.base)}${l.promocionId != null ? ' (oferta)' : ''}',
              style: TextStyle(fontSize: 12, color: venceHoy > 0 ? TantaColors.stateWarn : TantaColors.textMuted)),
          const SizedBox(height: 8),
          Row(children: [
            SelectorCantidad(valor: l.cantidad, maximo: libre, compacto: true, onCambio: (n) => setState(() => l.cantidad = n)),
            const SizedBox(width: 12),
            Expanded(child: TextField(
              controller: l.precio, keyboardType: const TextInputType.numberWithOptions(decimal: true),
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(labelText: 'Precio c/u', prefixText: 'S/ ', isDense: true,
                  helperText: l.rebaja > 0.0001 ? '−${(l.rebaja * 100).toStringAsFixed(1)} %' : null,
                  helperStyle: TextStyle(color: l.rebaja > _tope + 1e-6 ? TantaColors.stateWarn : TantaColors.textMuted)),
            )),
          ]),
        ]),
      ),
    );
  }

  Future<void> _agregar(List<Map<String, dynamic>> productos) async {
    final libres = productos.where((p) => !_lineas.any((l) => l.p['id'] == p['id'])).toList();
    final p = await showModalBottomSheet<Map<String, dynamic>>(context: context, isScrollControlled: true, useSafeArea: true, builder: (ctx) => ListView(
      padding: const EdgeInsets.symmetric(vertical: 12),
      children: [
        const ListTile(title: Text('Pan con stock libre', style: TextStyle(fontWeight: FontWeight.w700))),
        for (final x in libres) ListTile(
          title: Text('${x['nombre']}'),
          subtitle: Text('Quedan ${_n(x['libre']).toInt()}${_n(x['venceHoy']) > 0 ? ' · ${_n(x['venceHoy']).toInt()} vencen hoy' : ''}'
              '${_n(x['vencido']) > 0 ? ' · ${_n(x['vencido']).toInt()} vencidos (no se venden)' : ''}'),
          trailing: Text(dinero(_n((x['promocion'] as Map?)?['precio'] ?? x['precio'])), style: estiloDisplay.copyWith(fontSize: 15)),
          onTap: () => Navigator.pop(ctx, x),
        ),
      ],
    ));
    if (p == null || !mounted) return;
    final promo = p['promocion'] as Map?;
    setState(() => _lineas.add(_Linea(p, TextEditingController(text: _n(promo?['precio'] ?? p['precio']).toStringAsFixed(2)))));
  }
}

/// Aprobaciones del Gerente desde el celular: descuentos de mostrador y rebajas de venta de stock. Vence en 24 h.
class Aprobaciones extends StatefulWidget {
  const Aprobaciones({super.key});
  @override
  State<Aprobaciones> createState() => _AprobacionesState();
}

class _AprobacionesState extends State<Aprobaciones> {
  List<Map<String, dynamic>>? _lista;
  String? _error;
  String? _ocupado;

  @override
  void initState() { super.initState(); _cargar(); }

  Future<void> _cargar() async {
    try {
      final l = await Api.instancia.solicitudesDescuento();
      if (mounted) setState(() { _lista = l.cast<Map<String, dynamic>>(); _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = _mensaje(e));
    }
  }

  Future<void> _resolver(Map<String, dynamic> a, bool aprobar) async {
    setState(() => _ocupado = '${a['id']}');
    final aviso = ScaffoldMessenger.of(context);
    try {
      await Api.instancia.resolverAprobacion('${a['id']}', aprobar);
      aviso.showSnackBar(SnackBar(content: Text(aprobar ? 'Aprobado: el vendedor ya puede registrar la venta' : 'Rechazado'), backgroundColor: aprobar ? TantaColors.stateOk : null));
      await _cargar();
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e)), backgroundColor: TantaColors.stateDanger));
    } finally {
      if (mounted) setState(() => _ocupado = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = _lista;
    return Scaffold(
      appBar: AppBar(title: const Text('Aprobaciones')),
      body: RefreshIndicator(onRefresh: _cargar, child: _error != null
          ? ListView(children: [ErrorReintentar(mensaje: _error!, onReintentar: _cargar)])
          : l == null ? const Esqueleto()
          : l.isEmpty ? ListView(children: const [VacioMensaje('No hay solicitudes', icono: Icons.verified_outlined)])
          : ListView(padding: const EdgeInsets.all(16), children: [
              for (final a in l) Padding(padding: const EdgeInsets.only(bottom: 10), child: Panel(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(child: Text('${a['solicitante']} · ${(_n(a['porcentaje']) * 100).round()} %', style: const TextStyle(fontWeight: FontWeight.w600))),
                    Insignia(a['estado'] == 'PENDIENTE' ? 'Pendiente' : a['estado'] == 'APROBADA' ? (a['vigente'] == true ? 'Aprobada' : 'Vencida') : a['estado'] == 'USADA' ? 'Usada' : 'Rechazada',
                        tono: a['estado'] == 'PENDIENTE' ? Tono.warn : a['estado'] == 'RECHAZADA' ? Tono.danger : Tono.ok, punto: true),
                  ]),
                  if (a['cliente'] != null) Text('Cliente: ${a['cliente']}', style: const TextStyle(fontSize: 12.5)),
                  const SizedBox(height: 4),
                  Text('${a['motivo']}', style: const TextStyle(fontSize: 13, color: TantaColors.textMuted)),
                  if (a['estado'] == 'PENDIENTE' && Api.instancia.puede('descuentos.aprobar')) Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: AccionesDialogo(
                      secundaria: OutlinedButton(onPressed: _ocupado != null ? null : () => _resolver(a, false), child: const Text('Rechazar')),
                      principal: FilledButton(onPressed: _ocupado != null ? null : () => _resolver(a, true), child: const Text('Aprobar')),
                    ),
                  ),
                ]),
              )),
            ])),
    );
  }
}
