import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/catalogos.dart';
import 'catalogo.dart';
import '../core/tokens.dart';
import '../core/comprobante.dart';
import '../ui/comunes.dart';

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
  // El primer medio habilitado: si el admin desactiva uno, el desplegable no queda con un valor inexistente.
  String _forma = '${mediosPago('enVentas').first['codigo']}';
  String? _cliente;
  final _descuento = TextEditingController(text: '0');
  final _referencia = TextEditingController();
  bool _enviando = false;
  // COB-02: con tarjeta, Yape, Plin o transferencia se registra el número de operación.
  bool get _conReferencia => requiereOperacion(_forma);

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
        referenciaPago: _conReferencia ? _referencia.text.trim() : '',
      );
      final comprobante = r['comprobante'] as Map<String, dynamic>?;
      final cliente = _lista(widget.datos, 'clientes').where((c) => c['id'] == _cliente).firstOrNull?['nombre'] ?? 'Público general';
      await compartirComprobante(
        titulo: 'Nota de venta', numero: '${comprobante?['numero'] ?? r['codigo']}', cliente: '$cliente', vendedor: Api.instancia.nombre, total: dinero(_total),
        lineas: [
          for (final e in _cant.entries.where((e) => e.value > 0))
            ('${e.value} × ${productos.firstWhere((p) => p['id'] == e.key)['nombre']}', ''),
        ],
      );
      aviso.showSnackBar(SnackBar(content: Text('Nota de venta ${comprobante?['numero'] ?? r['codigo']} registrada')));
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
          items: [for (final m in mediosPago('enVentas')) DropdownMenuItem(value: '${m['codigo']}', child: Text('${m['nombre']}'))],
          onChanged: (v) => setState(() => _forma = v!),
        ),
        if (_conReferencia) ...[
          const SizedBox(height: 12),
          TextField(controller: _referencia, maxLength: 60, onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(labelText: 'N.° de operación')),
        ],
        const SizedBox(height: 12),
        DropdownButtonFormField<String?>(
          initialValue: _cliente,
          decoration: InputDecoration(labelText: esCredito(_forma) ? 'Cliente (obligatorio)' : 'Cliente (opcional)'),
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
            onPressed: !hay || _enviando || (esCredito(_forma) && _cliente == null) || (_conReferencia && _referencia.text.trim().length < 3) ? null : _registrar,
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
  String _criterio = 'LOTES_COMPLETOS';
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
      final r = await Api.instancia.crearOrden(productoId: _producto!, cantidad: cantidad, entrega: _entrega.toIso8601String().substring(0, 10), criterio: _criterio);
      final calc = (r['calculo'] as Map?) ?? const {};
      final faltan = (r['insumosInsuficientes'] as List?) ?? const [];
      aviso.showSnackBar(SnackBar(content: Text(faltan.isEmpty
          ? 'Orden ${r['codigo']} · ${calc['lotes']} lotes, ${calc['unidadesObtenidas']} unidades. Requisición enviada a Almacén'
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
        SegmentedButton<String>(
          segments: const [ButtonSegment(value: 'LOTES_COMPLETOS', label: Text('Lotes completos')), ButtonSegment(value: 'PROPORCIONAL', label: Text('Proporcional'))],
          selected: {_criterio},
          onSelectionChanged: (v) => setState(() => _criterio = v.first),
        ),
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

/* ------------------------------------------------ requisiciones de Almacén */
/// A18/A19: Almacén entrega a Producción los insumos de cada orden; el stock baja al confirmar.
class Requisiciones extends StatefulWidget {
  const Requisiciones({super.key});
  @override
  State<Requisiciones> createState() => _RequisicionesState();
}

class _RequisicionesState extends State<Requisiciones> {
  List<dynamic>? _lista;
  String? _error;

  Future<void> _cargar() async {
    try {
      final l = await Api.instancia.requisiciones();
      if (mounted) setState(() { _lista = l; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = _mensaje(e));
    }
  }

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _entregar(Map<String, dynamic> r) async {
    final lineas = ((r['lineas'] as List?) ?? const []).cast<Map<String, dynamic>>();
    final ctrls = {for (final l in lineas) l['insumoId'] as String: TextEditingController(text: '${((l['solicitada'] as num) - (l['entregada'] as num)).clamp(0, double.infinity)}')};
    final ok = await showDialog<bool>(context: context, builder: (_) => AlertDialog(
      title: Text('Entregar ${r['codigo']}'),
      content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Text('${r['op']} · ${r['producto']}'),
        const SizedBox(height: 12),
        for (final l in lineas) Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: TextField(controller: ctrls[l['insumoId']], keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(labelText: '${l['insumo']} (${l['unidad']})', helperText: 'Pide ${l['solicitada']} · stock ${l['stock']}')),
        ),
      ])),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Confirmar entrega')),
      ],
    ));
    if (ok != true || !mounted) return;
    final aviso = ScaffoldMessenger.of(context);
    final cantidades = {for (final l in lineas) l['insumoId']: double.tryParse(ctrls[l['insumoId']]!.text.trim().replaceAll(',', '.'))};
    if (cantidades.values.any((c) => c == null || c < 0) || cantidades.values.every((c) => c == 0)) {
      aviso.showSnackBar(const SnackBar(content: Text('Revisa las cantidades: deben ser números y al menos una mayor que cero')));
      return;
    }
    try {
      final res = await Api.instancia.atenderRequisicion('${r['codigo']}', [
        for (final e in cantidades.entries) {'insumoId': e.key, 'cantidad': e.value},
      ]);
      aviso.showSnackBar(SnackBar(content: Text('${r['codigo']}: ${res['estado'] == 'ATENDIDA' ? 'atendida' : 'atendida en parte'}')));
      _cargar();
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final lista = (_lista ?? const []).cast<Map<String, dynamic>>();
    return Scaffold(
      appBar: AppBar(title: const Text('Requisiciones')),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _error != null
            ? ListView(children: [ErrorReintentar(mensaje: _error!, onReintentar: _cargar)])
            : _lista == null
                ? ListView(children: const [Esqueleto()])
                : lista.isEmpty
                    ? ListView(children: const [VacioMensaje('Sin requisiciones por atender', icono: Icons.assignment_turned_in_outlined)])
                    : ListView.separated(
                        itemCount: lista.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (_, i) {
                          final r = lista[i];
                          return ListTile(
                            title: Text('${r['producto']}'),
                            subtitle: Text('${r['codigo']} · ${r['op']} · ${(r['lineas'] as List).length} insumos'),
                            trailing: Text(r['estado'] == 'PARCIAL' ? 'Parcial' : 'Pendiente'),
                            onTap: () => _entregar(r),
                          );
                        },
                      ),
      ),
    );
  }
}

/* ------------------------------------------------------ compra de insumos */
/// A22: recepción de mercadería con proveedor, documento y varias líneas; actualiza stock y costo promedio.
class NuevaCompra extends StatefulWidget {
  const NuevaCompra({super.key, required this.datos});
  final Map<String, dynamic> datos;
  @override
  State<NuevaCompra> createState() => _NuevaCompraState();
}

class _LineaCompra {
  String? insumoId;
  final cantidad = TextEditingController();
  final precio = TextEditingController();
  final lote = TextEditingController();
  DateTime? vence;
  double get c => double.tryParse(cantidad.text.replaceAll(',', '.')) ?? 0;
  double get p => double.tryParse(precio.text.replaceAll(',', '.')) ?? 0;
}

class _NuevaCompraState extends State<NuevaCompra> {
  List<Map<String, dynamic>> _proveedores = const [];
  String? _proveedor;
  String? _errorProveedores;
  // El primer tipo del catálogo (tiposDocumento() nunca viene vacío): no se fija 'FACTURA' por si el admin lo desactiva.
  String _docTipo = '${tiposDocumento().first['codigo']}';
  final _serie = TextEditingController();
  final _docNumero = TextEditingController();
  final _lineas = [_LineaCompra()];
  bool _enviando = false;

  @override
  void initState() {
    super.initState();
    _cargarProveedores();
  }

  Future<void> _cargarProveedores() async {
    if (_errorProveedores != null) setState(() => _errorProveedores = null);
    try {
      final l = await Api.instancia.proveedores();
      final activos = l.cast<Map<String, dynamic>>().where((p) => p['estado'] == 'ACTIVO').toList();
      if (mounted) setState(() { _proveedores = activos; _proveedor = activos.isEmpty ? null : '${activos.first['id']}'; });
    } catch (e) {
      if (mounted) setState(() => _errorProveedores = 'No se pudieron cargar los proveedores. ${_mensaje(e)}');
    }
  }

  double get _total => _lineas.fold(0, (s, l) => s + l.c * l.p);

  /// Presentación de compra del insumo (botella, saco).
  String? _presentacion(List<Map<String, dynamic>> insumos, String? id) {
    final x = insumos.where((i) => i['id'] == id).firstOrNull;
    if (x == null) return null;
    final p = '${x['presentacion'] ?? ''}';
    return p.isNotEmpty ? p : 'de ${x['contenido'] ?? 1} ${'${x['unidad']}'.toLowerCase()}';
  }

  /// Vista previa con el mismo cálculo del servidor: F1 base y F2 inventario.
  String? _conversion(List<Map<String, dynamic>> insumos, _LineaCompra l) {
    final x = insumos.where((i) => i['id'] == l.insumoId).firstOrNull;
    if (x == null || l.c <= 0) return null;
    final contenido = ((x['contenido'] as num?) ?? 1).toDouble(), factor = ((x['factor'] as num?) ?? 1).toDouble();
    String f(double v) => (v * 10000).roundToDouble() / 10000 == v.roundToDouble() ? v.round().toString() : ((v * 10000).roundToDouble() / 10000).toString();
    return '= ${f(l.c * contenido)} ${'${x['unidad']}'.toLowerCase()} = ${f(l.c * contenido * factor)} ${'${x['unidadInventario'] ?? x['unidad']}'.toLowerCase()} al inventario';
  }
  bool get _valido => _proveedor != null && RegExp(r'^[A-Za-z0-9]{1,4}$').hasMatch(_serie.text.trim()) && RegExp(r'^[A-Za-z0-9]{1,10}$').hasMatch(_docNumero.text.trim())
      && _lineas.every((l) => l.insumoId != null && l.c > 0 && l.p > 0)
      && _lineas.map((l) => l.insumoId).toSet().length == _lineas.length;

  Future<void> _guardar() async {
    setState(() => _enviando = true);
    final aviso = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    try {
      final r = await Api.instancia.registrarCompra(proveedorId: _proveedor!, docTipo: _docTipo, serie: _serie.text.trim().toUpperCase(),
          nro: _docNumero.text.trim().toUpperCase(), fechaCompra: DateTime.now().toIso8601String().substring(0, 10),
          items: [for (final l in _lineas) {'insumoId': l.insumoId, 'cantidad': l.c, 'precioUnitario': l.p, 'lote': l.lote.text.trim().toUpperCase(),
            'venceEn': l.vence == null ? '' : l.vence!.toIso8601String().substring(0, 10)}]);
      aviso.showSnackBar(SnackBar(content: Text('Compra ${r['codigo']} registrada por ${dinero(((r['total'] as num?) ?? 0).toDouble())}: Almacén la verificará')));
      nav.pop(true);
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final insumos = _lista(widget.datos, 'insumos');
    return Scaffold(
      appBar: AppBar(title: const Text('Registrar compra')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 120), children: [
        if (_errorProveedores != null) ErrorReintentar(mensaje: _errorProveedores!, onReintentar: _cargarProveedores)
        else DropdownButtonFormField<String>(
          // La lista llega después del primer build: la clave rehace el campo con el proveedor elegido.
          key: ValueKey(_proveedores.length),
          initialValue: _proveedor, isExpanded: true,
          decoration: const InputDecoration(labelText: 'Proveedor'),
          items: [for (final p in _proveedores) DropdownMenuItem(value: '${p['id']}', child: Text('${p['razonSocial']}', overflow: TextOverflow.ellipsis))],
          onChanged: (v) => setState(() => _proveedor = v),
        ),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: DropdownButtonFormField<String>(
            initialValue: _docTipo,
            decoration: const InputDecoration(labelText: 'Documento'),
            items: [for (final t in tiposDocumento()) DropdownMenuItem(value: '${t['codigo']}', child: Text('${t['nombre']}'))],
            onChanged: (v) => setState(() => _docTipo = v!),
          )),
        ]),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: TextField(controller: _serie, maxLength: 4, onChanged: (_) => setState(() {}), textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Serie', hintText: 'F001', counterText: ''))),
          const SizedBox(width: 12),
          Expanded(flex: 2, child: TextField(controller: _docNumero, maxLength: 10, onChanged: (_) => setState(() {}), textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Número', hintText: '123', counterText: ''))),
        ]),
        const SizedBox(height: 16),
        for (var i = 0; i < _lineas.length; i++) Card(child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(children: [
            Row(children: [
              Expanded(child: DropdownButtonFormField<String>(
                initialValue: _lineas[i].insumoId, isExpanded: true,
                decoration: InputDecoration(labelText: 'Insumo ${i + 1}'),
                items: [for (final x in insumos) DropdownMenuItem(value: '${x['id']}', child: Text('${x['nombre']} (${x['unidad']})', overflow: TextOverflow.ellipsis))],
                onChanged: (v) => setState(() => _lineas[i].insumoId = v),
              )),
              if (_lineas.length > 1) IconButton(tooltip: 'Quitar línea', icon: const Icon(Icons.delete_outline), onPressed: () => setState(() => _lineas.removeAt(i))),
            ]),
            Row(children: [
              Expanded(child: TextField(controller: _lineas[i].cantidad, onChanged: (_) => setState(() {}), keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: InputDecoration(labelText: 'Cantidad', helperText: _presentacion(insumos, _lineas[i].insumoId)))),
              const SizedBox(width: 12),
              Expanded(child: TextField(controller: _lineas[i].precio, onChanged: (_) => setState(() {}), keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Precio por presentación (S/)'))),
            ]),
            if (_conversion(insumos, _lineas[i]) case final t?) Padding(padding: const EdgeInsets.only(top: 6),
                child: Text(t, style: const TextStyle(fontSize: 12, color: TantaColors.textMuted))),
            // AIN-11: lote y vencimiento (opcionales); las salidas consumen primero lo que vence antes.
            Row(children: [
              Expanded(child: TextField(controller: _lineas[i].lote, maxLength: 40, textCapitalization: TextCapitalization.characters,
                  decoration: const InputDecoration(labelText: 'Lote (opcional)', counterText: ''))),
              const SizedBox(width: 12),
              Expanded(child: OutlinedButton.icon(
                icon: const Icon(Icons.event_outlined),
                label: Text(_lineas[i].vence == null ? 'Vence (opcional)' : 'Vence ${_lineas[i].vence!.day}/${_lineas[i].vence!.month}/${_lineas[i].vence!.year}'),
                onPressed: () async {
                  final hoy = DateTime.now();
                  final d = await showDatePicker(context: context, helpText: 'Fecha de vencimiento', initialDate: hoy.add(const Duration(days: 30)), firstDate: hoy, lastDate: hoy.add(const Duration(days: 1095)));
                  if (d != null) setState(() => _lineas[i].vence = d);
                },
              )),
            ]),
          ]),
        )),
        TextButton.icon(icon: const Icon(Icons.add), label: const Text('Agregar insumo'), onPressed: () => setState(() => _lineas.add(_LineaCompra()))),
        if (_lineas.map((l) => l.insumoId).whereType<String>().toSet().length < _lineas.where((l) => l.insumoId != null).length)
          const Text('Hay un insumo repetido', style: TextStyle(color: Colors.red)),
      ]),
      bottomNavigationBar: SafeArea(child: Padding(
        padding: const EdgeInsets.all(16),
        child: FilledButton(onPressed: !_valido || _enviando ? null : _guardar, child: Text(_enviando ? 'Guardando…' : 'Guardar ${dinero(_total)}')),
      )),
    );
  }
}

/* ------------------------------------------------------ verificar compras */
/// Almacén cuenta lo recibido. Todo igual → verificada y el stock ingresa; con diferencias → observada y se avisa a Administración.
class VerificarCompras extends StatefulWidget {
  const VerificarCompras({super.key});
  @override
  State<VerificarCompras> createState() => _VerificarComprasState();
}

class _VerificarComprasState extends State<VerificarCompras> {
  List<dynamic>? _compras;
  String? _error;

  Future<void> _cargar() async {
    try {
      final l = await Api.instancia.comprasPorVerificar();
      if (mounted) setState(() { _compras = l; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = _mensaje(e));
    }
  }

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _verificar(Map<String, dynamic> c) async {
    final items = ((c['items'] as List?) ?? const []).cast<Map<String, dynamic>>();
    final cant = {for (final i in items) i['item'] as int: TextEditingController(text: '${i['cantidad']}')};
    final obs = {for (final i in items) i['item'] as int: TextEditingController()};
    final ok = await showDialog<bool>(context: context, builder: (_) => AlertDialog(
      title: Text('Verificar ${c['codigo']}'),
      content: SizedBox(width: double.maxFinite, child: ListView(shrinkWrap: true, children: [
        Text('${c['proveedor']} · ${c['documento']}'),
        const SizedBox(height: 8),
        const Text('Cuenta en presentaciones (botellas, sacos). Si algo no coincide, indica el motivo.', style: TextStyle(fontSize: 12)),
        for (final i in items) ...[
          const SizedBox(height: 12),
          TextField(controller: cant[i['item']], keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: InputDecoration(labelText: '${i['insumo']}', helperText: 'Documento: ${i['cantidad']} · ${'${i['presentacion'] ?? ''}'.isEmpty ? 'unidades' : i['presentacion']}')),
          TextField(controller: obs[i['item']], maxLength: 200, decoration: const InputDecoration(labelText: 'Motivo si hay diferencia', counterText: '')),
        ],
      ])),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Enviar verificación')),
      ],
    ));
    if (ok != true || !mounted) return;
    final aviso = ScaffoldMessenger.of(context);
    final contadas = {for (final i in items) i['item'] as int: double.tryParse(cant[i['item']]!.text.trim().replaceAll(',', '.'))};
    if (contadas.values.any((v) => v == null || v < 0)) {
      aviso.showSnackBar(const SnackBar(content: Text('Revisa las cantidades contadas: deben ser números de 0 en adelante')));
      return;
    }
    try {
      final r = await Api.instancia.verificarCompra('${c['codigo']}', [
        for (final i in items) {'item': i['item'], 'cantidadVerificada': contadas[i['item']], 'observacion': obs[i['item']]!.text.trim()},
      ]);
      aviso.showSnackBar(SnackBar(content: Text(r['estado'] == 'VERIFICADA'
          ? '${c['codigo']} verificada: el stock ya ingresó'
          : '${c['codigo']} observada: se avisó a Administración; el stock no ingresa')));
      _cargar();
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final lista = (_compras ?? const []).cast<Map<String, dynamic>>();
    return Scaffold(
      appBar: AppBar(title: const Text('Compras por verificar')),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _error != null
            ? ListView(children: [ErrorReintentar(mensaje: _error!, onReintentar: _cargar)])
            : _compras == null
                ? ListView(children: const [Esqueleto()])
                : lista.isEmpty
                    ? ListView(children: const [VacioMensaje('No hay compras por verificar', icono: Icons.fact_check_outlined)])
                    : ListView.separated(
                        itemCount: lista.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (_, i) {
                          final c = lista[i];
                          return ListTile(
                            title: Text('${c['codigo']} · ${c['proveedor']}'),
                            subtitle: Text('${c['documento']} · ${(c['items'] as List).length} insumo(s)'),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => _verificar(c),
                          );
                        },
                      ),
      ),
    );
  }
}

/* ------------------------------------------------------ caja chica */
/// El vendedor abre la caja chica con un monto inicial y la cierra contando el efectivo.
/// Administración paga desde ella compras pequeñas; aquí se ve cuánto queda.
class CajaChica extends StatefulWidget {
  const CajaChica({super.key});
  @override
  State<CajaChica> createState() => _CajaChicaState();
}

class _CajaChicaState extends State<CajaChica> {
  Map<String, dynamic>? _datos;
  String? _error;
  final _monto = TextEditingController();
  final _contado = TextEditingController();
  final _obs = TextEditingController();

  Future<void> _cargar() async {
    try {
      final d = await Api.instancia.cajaChica();
      if (mounted) setState(() { _datos = d; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = _mensaje(e));
    }
  }

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _accion(Future<String> Function() fn) async {
    final aviso = ScaffoldMessenger.of(context);
    try {
      final t = await fn();
      aviso.showSnackBar(SnackBar(content: Text(t)));
      _cargar();
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    }
  }

  double _n(TextEditingController c) => double.tryParse(c.text.replaceAll(',', '.')) ?? -1;

  @override
  Widget build(BuildContext context) {
    final a = _datos?['abierta'] as Map<String, dynamic>?;
    final saldo = ((a?['saldo'] as num?) ?? 0).toDouble();
    return Scaffold(
      appBar: AppBar(title: const Text('Caja chica')),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          if (_error != null) ErrorReintentar(mensaje: _error!, onReintentar: _cargar)
          else if (_datos == null) const Esqueleto(filas: 3)
          else if (a == null) ...[
            const Text('No hay caja chica abierta. Sin ella, Administración solo paga desde caja grande.'),
            const SizedBox(height: 12),
            TextField(controller: _monto, keyboardType: const TextInputType.numberWithOptions(decimal: true), onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(labelText: 'Monto inicial (S/)')),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _n(_monto) > 0 ? () => _accion(() async {
                final r = await Api.instancia.abrirCajaChica(_n(_monto));
                _monto.clear();
                return 'Caja ${r['codigo']} abierta';
              }) : null,
              child: const Text('Abrir caja'),
            ),
          ] else ...[
            Text('Disponible ${dinero(saldo)}', style: Theme.of(context).textTheme.headlineSmall),
            Text('${a['codigo']} · inicial ${dinero(((a['montoInicial'] as num?) ?? 0).toDouble())} · pagado ${dinero(((a['pagado'] as num?) ?? 0).toDouble())}'),
            const SizedBox(height: 12),
            for (final p in ((a['pagos'] as List?) ?? const []).cast<Map<String, dynamic>>())
              ListTile(dense: true, contentPadding: EdgeInsets.zero,
                  title: Text('${p['proveedor']} · ${p['compra']}'), subtitle: Text('${p['estado']}'.toLowerCase()),
                  trailing: Text(dinero(((p['monto'] as num?) ?? 0).toDouble()))),
            const Divider(height: 28),
            Text('Cerrar caja', style: Theme.of(context).textTheme.titleMedium),
            TextField(controller: _contado, keyboardType: const TextInputType.numberWithOptions(decimal: true), onChanged: (_) => setState(() {}),
                decoration: InputDecoration(labelText: 'Efectivo contado (S/)',
                    helperText: _n(_contado) >= 0 ? 'Diferencia ${dinero(_n(_contado) - saldo)}' : 'Esperado ${dinero(saldo)}')),
            TextField(controller: _obs, maxLength: 200, decoration: const InputDecoration(labelText: 'Observación')),
            FilledButton(
              onPressed: _n(_contado) >= 0 ? () => _accion(() async {
                final r = await Api.instancia.cerrarCajaChica('${a['codigo']}', _n(_contado), _obs.text.trim());
                _contado.clear();
                _obs.clear();
                final dif = ((r['diferencia'] as num?) ?? 0).toDouble();
                return dif == 0 ? 'Caja cerrada sin diferencias' : 'Caja cerrada con diferencia de ${dinero(dif)}';
              }) : null,
              child: const Text('Cerrar caja'),
            ),
          ],
        ]),
      ),
    );
  }
}

/* ------------------------------------------------------ estado de cuenta */
/// Matriz de permisos, fila 19: el cliente consulta su deuda, documentos y pagos.
class EstadoCuenta extends StatefulWidget {
  const EstadoCuenta({super.key});
  @override
  State<EstadoCuenta> createState() => _EstadoCuentaState();
}

class _EstadoCuentaState extends State<EstadoCuenta> {
  Map<String, dynamic>? _ec;
  String? _error;

  Future<void> _cargar() async {
    try {
      final r = await Api.instancia.estadoCuenta();
      if (mounted) setState(() { _ec = r; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = _mensaje(e));
    }
  }

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  @override
  Widget build(BuildContext context) {
    final ec = _ec;
    final docs = ((ec?['documentos'] as List?) ?? const []).cast<Map<String, dynamic>>().where((d) => (d['saldo'] as num) > 0).toList();
    final pagos = ((ec?['pagos'] as List?) ?? const []).cast<Map<String, dynamic>>();
    return Scaffold(
      appBar: AppBar(title: const Text('Mi estado de cuenta')),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _error != null
            ? ListView(children: [ErrorReintentar(mensaje: _error!, onReintentar: _cargar)])
            : ec == null
                ? ListView(children: const [Esqueleto(filas: 4)])
                : ListView(padding: const EdgeInsets.all(16), children: [
                    Text('Saldo ${dinero((ec['saldo'] as num).toDouble())}', style: Theme.of(context).textTheme.headlineSmall),
                    Text('Vencido ${dinero((ec['vencido'] as num).toDouble())}'),
                    const SizedBox(height: 16),
                    Text('Documentos por pagar', style: Theme.of(context).textTheme.titleMedium),
                    if (docs.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('No tienes deuda pendiente')),
                    for (final d in docs) ListTile(contentPadding: EdgeInsets.zero,
                        title: Text('${d['documento']}'),
                        subtitle: Text('Vence ${d['vence']}${(d['diasVencido'] as num) > 0 ? ' · ${d['diasVencido']} días vencido' : ''}'),
                        trailing: Text(dinero((d['saldo'] as num).toDouble()))),
                    const SizedBox(height: 16),
                    Text('Pagos', style: Theme.of(context).textTheme.titleMedium),
                    if (pagos.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('Sin pagos registrados')),
                    for (final p in pagos) ListTile(contentPadding: EdgeInsets.zero,
                        title: Text('${p['recibo']} · ${'${p['medio']}'.toLowerCase()}'),
                        subtitle: Text('${p['fecha']}'),
                        trailing: Text(dinero((p['monto'] as num).toDouble()))),
                  ]),
      ),
    );
  }
}

/* ------------------------------------------------------ conteo físico */
/// M05: conteo contra el sistema; las diferencias se ajustan solo con la aprobación del Gerente.
class Conteos extends StatefulWidget {
  const Conteos({super.key, required this.datos});
  final Map<String, dynamic> datos;
  @override
  State<Conteos> createState() => _ConteosState();
}

class _ConteosState extends State<Conteos> {
  List<dynamic>? _conteos;
  String? _error;

  Future<void> _cargar() async {
    try {
      final l = await Api.instancia.conteos();
      if (mounted) setState(() { _conteos = l; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = _mensaje(e));
    }
  }

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _nuevo() async {
    final insumos = _lista(widget.datos, 'insumos');
    final ctrls = {for (final i in insumos) '${i['id']}': TextEditingController()};
    final obs = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (_) => AlertDialog(
      title: const Text('Nuevo conteo'),
      content: SizedBox(width: double.maxFinite, child: ListView(shrinkWrap: true, children: [
        const Text('Deja en blanco lo que no contaste.'),
        for (final i in insumos) TextField(controller: ctrls['${i['id']}'], keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(labelText: '${i['nombre']} (${i['unidad']})', helperText: 'Sistema: ${i['stock']}')),
        TextField(controller: obs, maxLength: 200, decoration: const InputDecoration(labelText: 'Observación')),
      ])),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Enviar a aprobación')),
      ],
    ));
    if (ok != true || !mounted) return;
    final items = [
      for (final e in ctrls.entries)
        if (double.tryParse(e.value.text.replaceAll(',', '.')) case final v? when v >= 0) {'insumoId': e.key, 'contado': v},
    ];
    if (items.isEmpty) return;
    final aviso = ScaffoldMessenger.of(context);
    try {
      final r = await Api.instancia.registrarConteo(items, obs.text.trim());
      aviso.showSnackBar(SnackBar(content: Text('${r['codigo']} enviado con ${r['diferencias']} diferencia(s)')));
      _cargar();
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    }
  }

  Future<void> _ver(Map<String, dynamic> k) async {
    final items = ((k['items'] as List?) ?? const []).cast<Map<String, dynamic>>();
    final aprueba = k['estado'] == 'PENDIENTE' && Api.instancia.puede('conteo.aprobar');
    final motivo = TextEditingController();
    final r = await showDialog<bool>(context: context, builder: (_) => AlertDialog(
      title: Text('${k['codigo']} · ${'${k['estado']}'.toLowerCase()}'),
      content: SizedBox(width: double.maxFinite, child: ListView(shrinkWrap: true, children: [
        for (final i in items) ListTile(dense: true, contentPadding: EdgeInsets.zero,
            title: Text('${i['insumo']}'),
            subtitle: Text('Sistema ${i['sistema']} · contado ${i['contado']}'),
            trailing: Text((i['diferencia'] as num).abs() < 0.0005 ? 'OK' : '${i['diferencia']}')),
        if (aprueba) TextField(controller: motivo, decoration: const InputDecoration(labelText: 'Motivo (solo para rechazar)')),
      ])),
      actions: aprueba
          ? [
              TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Rechazar')),
              FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Aprobar y ajustar')),
            ]
          : [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cerrar'))],
    ));
    if (!aprueba || r == null || !mounted) return;
    final aviso = ScaffoldMessenger.of(context);
    try {
      final res = await Api.instancia.resolverConteo('${k['id']}', r, motivo: motivo.text.trim());
      aviso.showSnackBar(SnackBar(content: Text(r ? '${k['codigo']} aprobado: ${res['ajustes']} ajuste(s)' : '${k['codigo']} rechazado')));
      _cargar();
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final lista = (_conteos ?? const []).cast<Map<String, dynamic>>();
    return Scaffold(
      appBar: AppBar(title: const Text('Conteo físico')),
      floatingActionButton: Api.instancia.puede('inventario.mover')
          ? FloatingActionButton.extended(onPressed: _nuevo, icon: const Icon(Icons.add), label: const Text('Nuevo conteo'))
          : null,
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _error != null
            ? ListView(children: [ErrorReintentar(mensaje: _error!, onReintentar: _cargar)])
            : _conteos == null
                ? ListView(children: const [Esqueleto()])
                : lista.isEmpty
                    ? ListView(children: const [VacioMensaje('Sin conteos registrados', icono: Icons.fact_check_outlined)])
                    : ListView.separated(
                        itemCount: lista.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (_, i) {
                          final k = lista[i];
                          return ListTile(
                            title: Text('${k['codigo']} · ${k['registradoPor']}'),
                            subtitle: Text('${(k['items'] as List).length} insumos'),
                            trailing: Text('${k['estado']}'.toLowerCase()),
                            onTap: () => _ver(k),
                          );
                        },
                      ),
      ),
    );
  }
}

/* ------------------------------------------------------ mis pedidos */
/// A08/A09: historial del cliente con estado y cancelación antes de producir (PED-07).
class MisPedidos extends StatefulWidget {
  const MisPedidos({super.key, this.productos = const []});
  /// Productos activos del catálogo: Repetir solo carga los que siguen a la venta.
  final List<Map<String, dynamic>> productos;
  @override
  State<MisPedidos> createState() => _MisPedidosState();
}

/// Nombre amable de cada estado del pedido (panel, Mis pedidos).
const etiquetaPedido = {'REGISTRADO': 'Por confirmar', 'CONFIRMADO': 'Confirmado', 'EN_PRODUCCION': 'En producción', 'LISTO': 'Listo para entregar',
  'DESPACHADO': 'En camino', 'ENTREGADO': 'Entregado', 'RECHAZADO': 'Rechazado', 'CANCELADO': 'Cancelado'};

/// Color del estado: por confirmar (ámbar), en curso (azul), listo o entregado (verde), anulado (rojo).
Tono tonoPedido(String estado) => switch (estado) {
      'REGISTRADO' => Tono.warn,
      'LISTO' || 'ENTREGADO' => Tono.ok,
      'RECHAZADO' || 'CANCELADO' => Tono.danger,
      _ => Tono.info,
    };

class _MisPedidosState extends State<MisPedidos> {
  List<dynamic>? _lista;
  String? _error;

  Future<void> _cargar() async {
    try {
      final l = await Api.instancia.misPedidos();
      if (mounted) setState(() { _lista = l; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = _mensaje(e));
    }
  }

  @override
  void initState() { super.initState(); _cargar(); }

  Future<void> _cancelar(Map<String, dynamic> p) async {
    final c = TextEditingController();
    final motivo = await showDialog<String>(context: context, builder: (_) => AlertDialog(
      title: Text('Cancelar ${p['codigo']}'),
      content: TextField(controller: c, autofocus: true, maxLength: 200, decoration: const InputDecoration(labelText: 'Motivo')),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Volver')),
        FilledButton(onPressed: () { if (c.text.trim().length >= 3) Navigator.pop(context, c.text.trim()); }, child: const Text('Cancelar pedido')),
      ],
    ));
    if (motivo == null || !mounted) return;
    final aviso = ScaffoldMessenger.of(context);
    try {
      await Api.instancia.cancelarPedido('${p['codigo']}', motivo);
      if (mounted) Navigator.of(context).maybePop();
      _cargar();
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e))));
    }
  }

  /// A09: detalle con línea de tiempo, productos, entrega y acciones.
  Future<void> _detalle(Map<String, dynamic> p) async {
    List<dynamic> historial = const [];
    try { historial = await Api.instancia.historialPedido('${p['codigo']}'); } catch (_) {}
    if (!mounted) return;
    final items = ((p['items'] as List?) ?? const []).cast<Map<String, dynamic>>();
    final cancelable = p['estado'] == 'REGISTRADO' || p['estado'] == 'CONFIRMADO';
    final pasos = p['estado'] == 'CANCELADO' || p['estado'] == 'RECHAZADO'
        ? ['REGISTRADO', p['estado'] as String]
        : ['REGISTRADO', 'CONFIRMADO', 'EN_PRODUCCION', 'LISTO', 'DESPACHADO', 'ENTREGADO'];
    final cuando = {for (final h in historial.cast<Map>()) '${h['estado']}': DateTime.tryParse('${h['fecha']}')?.toLocal()};
    final actual = pasos.indexOf('${p['estado']}');
    await showModalBottomSheet<void>(context: context, isScrollControlled: true, builder: (ctx) => DraggableScrollableSheet(
      expand: false, initialChildSize: 0.75, builder: (_, scroll) => ListView(controller: scroll, padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewPadding.bottom), children: [
        Text('${p['codigo']}', style: Theme.of(ctx).textTheme.titleLarge),
        Text('Entrega ${p['fecha_entrega']}${'${p['hora_entrega'] ?? ''}'.isEmpty ? '' : ' · ${p['hora_entrega']}'} · ${p['tipoEntrega'] == 'DELIVERY' ? 'delivery a ${p['direccion']}' : 'recojo en tienda'}'),
        Text('Pago contra entrega: ${nombreMedio('${p['pagoEntrega'] ?? 'EFECTIVO'}').toLowerCase()}'),
        const SizedBox(height: 16),
        for (var k = 0; k < pasos.length; k++)
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Column(children: [
              Icon(k <= actual ? Icons.check_circle : Icons.radio_button_unchecked, size: 20,
                  color: k <= actual ? (pasos[k] == 'CANCELADO' || pasos[k] == 'RECHAZADO' ? Colors.red.shade700 : Colors.green.shade700) : Colors.grey),
              if (k < pasos.length - 1) Container(width: 2, height: 22, color: k < actual ? Colors.green.shade700 : Colors.grey.shade300),
            ]),
            const SizedBox(width: 10),
            Expanded(child: Text('${etiquetaPedido[pasos[k]]}${cuando[pasos[k]] == null ? '' : ' · ${cuando[pasos[k]]!.day}/${cuando[pasos[k]]!.month} ${cuando[pasos[k]]!.hour.toString().padLeft(2, '0')}:${cuando[pasos[k]]!.minute.toString().padLeft(2, '0')}'}',
                style: TextStyle(fontWeight: k == actual ? FontWeight.w700 : FontWeight.w400))),
          ]),
        if ('${p['motivo'] ?? ''}'.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text('Motivo: ${p['motivo']}')),
        const Divider(height: 28),
        for (final i in items) ListTile(dense: true, contentPadding: EdgeInsets.zero,
            title: Text('${i['producto']}'), subtitle: Text('${i['cantidad']} × ${dinero(((i['precio'] as num?) ?? 0).toDouble())}'),
            trailing: Text(dinero(((i['precio'] as num?) ?? 0).toDouble() * ((i['cantidad'] as num?) ?? 0).toDouble()))),
        ListTile(dense: true, contentPadding: EdgeInsets.zero, title: const Text('Total', style: TextStyle(fontWeight: FontWeight.w700)),
            trailing: Text(dinero(((p['total'] as num?) ?? 0).toDouble()), style: const TextStyle(fontWeight: FontWeight.w700))),
        const SizedBox(height: 12),
        Row(children: [
          if (cancelable) Expanded(child: OutlinedButton.icon(
            style: OutlinedButton.styleFrom(foregroundColor: TantaColors.stateDanger, side: const BorderSide(color: TantaColors.stateDanger)),
            icon: const Icon(Icons.close), label: const Text('Cancelar'), onPressed: () => _cancelar(p))),
          if (cancelable) const SizedBox(width: 8),
          Expanded(child: FilledButton.icon(icon: const Icon(Icons.replay), label: const Text('Repetir'), onPressed: () {
            repetirPedido(p, widget.productos);
            Navigator.pop(ctx);
            Navigator.push(context, MaterialPageRoute(builder: (_) => CarritoPantalla(productos: widget.productos)));
          })),
        ]),
      ]),
    ));
    _cargar();
  }

  Widget _lista_(List<Map<String, dynamic>> l, String vacio) => RefreshIndicator(
    onRefresh: _cargar,
    child: l.isEmpty
        ? ListView(children: [VacioMensaje(vacio, icono: Icons.receipt_long_outlined)])
        : ListView.separated(
            itemCount: l.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (_, i) {
              final p = l[i];
              return ListTile(
                title: Text('${p['codigo']} · ${dinero(((p['total'] as num?) ?? 0).toDouble())}'),
                subtitle: Text('${etiquetaPedido[p['estado']] ?? p['estado']} · entrega ${p['fecha_entrega']}${p['tipoEntrega'] == 'DELIVERY' ? ' · delivery' : ''}'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => _detalle(p),
              );
            },
          ),
  );

  @override
  Widget build(BuildContext context) {
    final l = (_lista ?? const []).cast<Map<String, dynamic>>();
    bool en(Map p, List<String> e) => e.contains(p['estado']);
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(title: const Text('Mis pedidos'), bottom: const TabBar(tabs: [Tab(text: 'En curso'), Tab(text: 'Entregados'), Tab(text: 'Cancelados')])),
        // Un error ya no se muestra como "sin pedidos": se ofrece reintentar.
        body: _error != null
            ? RefreshIndicator(onRefresh: _cargar, child: ListView(children: [ErrorReintentar(mensaje: _error!, onReintentar: _cargar)]))
            : _lista == null
            ? const Esqueleto()
            : TabBarView(children: [
                _lista_(l.where((p) => en(p, ['REGISTRADO', 'CONFIRMADO', 'EN_PRODUCCION', 'LISTO', 'DESPACHADO'])).toList(), 'No tienes pedidos en curso'),
                _lista_(l.where((p) => en(p, ['ENTREGADO'])).toList(), 'Aún no tienes pedidos entregados'),
                _lista_(l.where((p) => en(p, ['CANCELADO', 'RECHAZADO'])).toList(), 'Sin pedidos cancelados'),
              ]),
      ),
    );
  }
}
