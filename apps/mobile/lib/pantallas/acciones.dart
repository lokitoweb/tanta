import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/comprobante.dart';

/// Acciones de registro del PDF §3.2–3.3 que se hacen desde el teléfono o la tablet:
/// venta a terceros (vendedor), baja de inventario (almacén) y orden de producción.

List<Map<String, dynamic>> _lista(Map<String, dynamic> datos, String clave) =>
    ((datos[clave] as List?) ?? const []).cast<Map<String, dynamic>>();

String _mensaje(Object e) => e is ApiException ? e.mensaje : 'Sin conexión: intenta de nuevo';

/* ------------------------------------------------------------ nueva venta */
class NuevaVenta extends StatefulWidget {
  const NuevaVenta({super.key, required this.datos});
  final Map<String, dynamic> datos;
  @override
  State<NuevaVenta> createState() => _NuevaVentaState();
}

class _NuevaVentaState extends State<NuevaVenta> {
  final Map<String, int> _cant = {};
  String _forma = 'EFECTIVO';
  String? _cliente;
  final _descuento = TextEditingController(text: '0');
  bool _enviando = false;

  double get _total {
    final d = (double.tryParse(_descuento.text.replaceAll(',', '.')) ?? 0) / 100;
    return _lista(widget.datos, 'productos').fold<double>(0,
        (s, p) => s + (_cant[p['id']] ?? 0) * ((p['precioConIgv'] as num?)?.toDouble() ?? 0)) * (1 - d);
  }

  Future<void> _registrar() async {
    final aviso = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    setState(() => _enviando = true);
    try {
      final productos = _lista(widget.datos, 'productos');
      final r = await Api.instancia.registrarVenta(
        items: _cant.entries.where((e) => e.value > 0).map((e) => {'productoId': e.key, 'cantidad': e.value}).toList(),
        formaPago: _forma,
        clienteId: _cliente,
        descuentoPct: (double.tryParse(_descuento.text.replaceAll(',', '.')) ?? 0) / 100,
      );
      final cliente = _lista(widget.datos, 'clientes').where((c) => c['id'] == _cliente).firstOrNull?['nombre'] ?? 'Público general';
      await compartirComprobante(
        titulo: 'Venta', numero: '${r['codigo']}', cliente: '$cliente', vendedor: Api.instancia.nombre, total: dinero(_total),
        lineas: [
          for (final e in _cant.entries.where((e) => e.value > 0))
            ('${e.value} × ${productos.firstWhere((p) => p['id'] == e.key)['nombre']}', ''),
        ],
      );
      aviso.showSnackBar(SnackBar(content: Text('Venta ${r['codigo']} registrada')));
      nav.pop(true);
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final productos = _lista(widget.datos, 'productos').where((p) => (p['stock'] as num? ?? 0) > 0).toList();
    final clientes = _lista(widget.datos, 'clientes');
    final hay = _cant.values.any((v) => v > 0);
    return Scaffold(
      appBar: AppBar(title: const Text('Nueva venta')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 120), children: [
        for (final p in productos)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text('${p['nombre']}'),
            subtitle: Text('${dinero((p['precioConIgv'] as num).toDouble())} · stock ${p['stock']}'),
            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
              IconButton(tooltip: 'Quitar', icon: const Icon(Icons.remove_circle_outline),
                  onPressed: (_cant[p['id']] ?? 0) > 0 ? () => setState(() => _cant[p['id']] = _cant[p['id']]! - 1) : null),
              SizedBox(width: 28, child: Text('${_cant[p['id']] ?? 0}', textAlign: TextAlign.center)),
              IconButton(tooltip: 'Agregar', icon: const Icon(Icons.add_circle_outline),
                  onPressed: (_cant[p['id']] ?? 0) < (p['stock'] as num) ? () => setState(() => _cant[p['id']] = (_cant[p['id']] ?? 0) + 1) : null),
            ]),
          ),
        const SizedBox(height: 16),
        DropdownButtonFormField<String>(
          initialValue: _forma,
          decoration: const InputDecoration(labelText: 'Forma de pago'),
          items: const ['EFECTIVO', 'YAPE', 'PLIN', 'TRANSFERENCIA', 'CREDITO']
              .map((f) => DropdownMenuItem(value: f, child: Text(f == 'CREDITO' ? 'Crédito' : f[0] + f.substring(1).toLowerCase()))).toList(),
          onChanged: (v) => setState(() => _forma = v!),
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String?>(
          initialValue: _cliente,
          decoration: InputDecoration(labelText: _forma == 'CREDITO' ? 'Cliente (obligatorio)' : 'Cliente (opcional)'),
          items: [
            const DropdownMenuItem<String?>(value: null, child: Text('Público general')),
            for (final c in clientes) DropdownMenuItem<String?>(value: '${c['id']}', child: Text('${c['nombre']}')),
          ],
          onChanged: (v) => setState(() => _cliente = v),
        ),
        const SizedBox(height: 12),
        TextField(controller: _descuento, keyboardType: const TextInputType.numberWithOptions(decimal: true),
            onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Descuento %', helperText: 'El tope lo fija el administrador')),
      ]),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: FilledButton(
            onPressed: !hay || _enviando || (_forma == 'CREDITO' && _cliente == null) ? null : _registrar,
            child: Text(_enviando ? 'Registrando…' : 'Cobrar ${dinero(_total)}'),
          ),
        ),
      ),
    );
  }
}

/* ------------------------------------------------------- baja de inventario */
class BajaInventario extends StatefulWidget {
  const BajaInventario({super.key, required this.datos});
  final Map<String, dynamic> datos;
  @override
  State<BajaInventario> createState() => _BajaInventarioState();
}

class _BajaInventarioState extends State<BajaInventario> {
  bool _producto = false;
  String? _item;
  String _motivoTipo = 'MERMA';
  final _cantidad = TextEditingController();
  final _motivo = TextEditingController();
  bool _enviando = false;

  Future<void> _registrar() async {
    final aviso = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    final cantidad = double.tryParse(_cantidad.text.replaceAll(',', '.'));
    if (_item == null || cantidad == null || cantidad <= 0 || _motivo.text.trim().length < 3) {
      aviso.showSnackBar(const SnackBar(content: Text('Completa ítem, cantidad y motivo')));
      return;
    }
    setState(() => _enviando = true);
    try {
      await Api.instancia.registrarBaja(producto: _producto, id: _item!, cantidad: cantidad, motivoTipo: _motivoTipo, motivo: _motivo.text.trim());
      aviso.showSnackBar(const SnackBar(content: Text('Movimiento registrado en el kárdex')));
      nav.pop(true);
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _lista(widget.datos, _producto ? 'productos' : 'insumos');
    final motivos = _producto
        ? const {'MERMA': 'Merma', 'VENCIMIENTO': 'Vencimiento', 'DEVOLUCION': 'Devolución de cliente (suma stock)'}
        : const {'MERMA': 'Merma', 'VENCIMIENTO': 'Vencimiento', 'CONSUMO': 'Consumo', 'AJUSTE': 'Ajuste'};
    return Scaffold(
      appBar: AppBar(title: const Text('Registrar baja')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        SegmentedButton<bool>(
          segments: const [ButtonSegment(value: false, label: Text('Insumo')), ButtonSegment(value: true, label: Text('Producto'))],
          selected: {_producto},
          onSelectionChanged: (s) => setState(() { _producto = s.first; _item = null; _motivoTipo = 'MERMA'; }),
        ),
        const SizedBox(height: 16),
        DropdownButtonFormField<String>(
          key: ValueKey(_producto),
          initialValue: _item,
          isExpanded: true,
          decoration: InputDecoration(labelText: _producto ? 'Producto' : 'Insumo'),
          items: [for (final i in items) DropdownMenuItem(value: '${i['id']}', child: Text('${i['nombre']} · stock ${i['stock']} ${i['unidad'] ?? ''}'))],
          onChanged: (v) => setState(() => _item = v),
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(
          key: ValueKey('m$_producto'),
          initialValue: _motivoTipo,
          decoration: const InputDecoration(labelText: 'Motivo'),
          items: [for (final m in motivos.entries) DropdownMenuItem(value: m.key, child: Text(m.value))],
          onChanged: (v) => setState(() => _motivoTipo = v!),
        ),
        const SizedBox(height: 12),
        TextField(controller: _cantidad, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Cantidad')),
        const SizedBox(height: 12),
        TextField(controller: _motivo, maxLength: 200, decoration: const InputDecoration(labelText: 'Detalle (lote, OP, pedido o venta)')),
        const SizedBox(height: 8),
        FilledButton(onPressed: _enviando ? null : _registrar, child: Text(_enviando ? 'Registrando…' : 'Registrar')),
      ]),
    );
  }
}

/* --------------------------------------------------- orden de producción */
class NuevaOrden extends StatefulWidget {
  const NuevaOrden({super.key, required this.datos});
  final Map<String, dynamic> datos;
  @override
  State<NuevaOrden> createState() => _NuevaOrdenState();
}

class _NuevaOrdenState extends State<NuevaOrden> {
  String? _producto;
  final _cantidad = TextEditingController();
  DateTime _entrega = DateTime.now().add(const Duration(days: 1));
  bool _enviando = false;

  Future<void> _crear() async {
    final aviso = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    final cantidad = double.tryParse(_cantidad.text.replaceAll(',', '.'));
    if (_producto == null || cantidad == null || cantidad <= 0) {
      aviso.showSnackBar(const SnackBar(content: Text('Elige producto y cantidad')));
      return;
    }
    setState(() => _enviando = true);
    try {
      final r = await Api.instancia.crearOrden(productoId: _producto!, cantidad: cantidad, entrega: _entrega.toIso8601String().substring(0, 10));
      final faltan = (r['insumosInsuficientes'] as List?) ?? const [];
      aviso.showSnackBar(SnackBar(content: Text(faltan.isEmpty
          ? 'Orden ${r['codigo']} creada'
          : 'Orden ${r['codigo']} creada · faltan insumos: ${faltan.map((f) => f['insumo'] ?? f['nombre'] ?? '').join(', ')}')));
      nav.pop(true);
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Nueva orden de producción')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        DropdownButtonFormField<String>(
          initialValue: _producto,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Producto'),
          items: [for (final p in _lista(widget.datos, 'productos')) DropdownMenuItem(value: '${p['id']}', child: Text('${p['nombre']}'))],
          onChanged: (v) => setState(() => _producto = v),
        ),
        const SizedBox(height: 12),
        TextField(controller: _cantidad, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Cantidad a producir')),
        const SizedBox(height: 12),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.event_outlined),
          title: const Text('Entrega'),
          subtitle: Text(_entrega.toIso8601String().substring(0, 10)),
          onTap: () async {
            final hoy = DateTime.now();
            final f = await showDatePicker(context: context, initialDate: _entrega, firstDate: hoy, lastDate: hoy.add(const Duration(days: 60)));
            if (f != null) setState(() => _entrega = f);
          },
        ),
        const SizedBox(height: 8),
        FilledButton(onPressed: _enviando ? null : _crear, child: Text(_enviando ? 'Creando…' : 'Crear orden')),
      ]),
    );
  }
}
