import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/catalogos.dart';
import '../core/tema.dart';
import '../core/tokens.dart';

/// Carrito del cliente (PED-02): compartido por el catálogo, "Mis pedidos" (Repetir) y la confirmación.
/// productoId → cantidad. Vive mientras la app está abierta.
final carrito = ValueNotifier<Map<String, int>>({});

void ponerEnCarrito(String id, int cantidad) {
  final c = Map<String, int>.from(carrito.value);
  if (cantidad <= 0) {
    c.remove(id);
  } else {
    c[id] = cantidad;
  }
  carrito.value = c;
}

/// Base + IGV = total por línea (RN-31): el precio con IGV y el neto vienen del servidor.
({double base, double igv, double total}) totalesCarrito(List<Map<String, dynamic>> productos) {
  double base = 0, total = 0;
  for (final e in carrito.value.entries) {
    final p = productos.where((x) => x['id'] == e.key).firstOrNull;
    if (p == null) continue;
    total += e.value * ((p['precioConIgv'] as num?)?.toDouble() ?? 0);
    base += e.value * ((p['precioNeto'] as num?)?.toDouble() ?? 0);
  }
  base = (base * 100).roundToDouble() / 100;
  total = (total * 100).roundToDouble() / 100;
  return (base: base, igv: ((total - base) * 100).roundToDouble() / 100, total: total);
}

/// A04: catálogo para el cliente con búsqueda, categorías, detalle y carrito.
class Catalogo extends StatefulWidget {
  const Catalogo({super.key, required this.datos});
  final Map<String, dynamic> datos;

  @override
  State<Catalogo> createState() => _CatalogoState();
}

class _CatalogoState extends State<Catalogo> {
  String _categoria = 'todas';
  String _buscar = '';

  List<Map<String, dynamic>> get _productos => (widget.datos['productos'] as List? ?? const [])
      .cast<Map<String, dynamic>>().where((p) => p['estado'] == null || p['estado'] == 'ACTIVO').toList();

  /// A05: detalle con selector de cantidad.
  Future<void> _detalle(Map<String, dynamic> p) async {
    var cantidad = carrito.value[p['id']] ?? 1;
    final ok = await showModalBottomSheet<bool>(
      context: context, isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, set) {
        final precio = (p['precioConIgv'] as num?)?.toDouble() ?? 0;
        final peso = p['pesoMasaG'] as num?;
        final anticipacion = (p['anticipacionHoras'] as num?) ?? 0;
        return Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 28),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${p['nombre']}', style: estiloDisplay.copyWith(fontSize: 22)),
            const SizedBox(height: 4),
            Text([
              'Precio por ${'${p['unidad']}'.toLowerCase()}: ${dinero(precio)} (incluye IGV)',
              if (peso != null && peso > 0) 'Peso aprox. ${peso.round()} g',
              if (anticipacion > 0) 'Se pide con $anticipacion h de anticipación',
            ].join('\n'), style: const TextStyle(color: TantaColors.textMuted, height: 1.5)),
            const SizedBox(height: 18),
            Row(children: [
              IconButton.outlined(tooltip: 'Quitar uno', onPressed: cantidad > 1 ? () => set(() => cantidad--) : null, icon: const Icon(Icons.remove)),
              SizedBox(width: 56, child: Text('$cantidad', textAlign: TextAlign.center, style: estiloDisplay.copyWith(fontSize: 20))),
              IconButton.outlined(tooltip: 'Agregar uno', onPressed: () => set(() => cantidad++), icon: const Icon(Icons.add)),
              const Spacer(),
              Text(dinero(precio * cantidad), style: estiloDisplay.copyWith(fontSize: 18)),
            ]),
            const SizedBox(height: 18),
            SizedBox(width: double.infinity, child: FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Agregar al pedido'))),
          ]),
        );
      }),
    );
    if (ok == true) ponerEnCarrito('${p['id']}', cantidad);
  }

  Future<void> _repetir() async {
    final aviso = ScaffoldMessenger.of(context);
    try {
      final pedidos = await Api.instancia.misPedidos();
      if (pedidos.isEmpty) { aviso.showSnackBar(const SnackBar(content: Text('Aún no tienes pedidos'))); return; }
      repetirPedido(pedidos.first as Map<String, dynamic>, _productos);
      aviso.showSnackBar(SnackBar(content: Text('Carrito listo con el pedido ${(pedidos.first as Map)['codigo']} a precios de hoy')));
    } catch (_) {
      aviso.showSnackBar(const SnackBar(content: Text('Sin conexión: intenta de nuevo')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final productos = _productos;
    final categorias = (widget.datos['categorias'] as List? ?? const []).cast<Map<String, dynamic>>();
    final filtrados = productos.where((p) => (_categoria == 'todas' || p['categoriaId'] == _categoria)
        && '${p['nombre']}'.toLowerCase().contains(_buscar.toLowerCase())).toList();

    return ValueListenableBuilder<Map<String, int>>(
      valueListenable: carrito,
      builder: (context, c, _) {
        final items = c.values.fold<int>(0, (s, v) => s + v);
        final t = totalesCarrito(productos);
        return Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
            child: TextField(
              onChanged: (v) => setState(() => _buscar = v),
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Buscar pan', isDense: true),
            ),
          ),
          SizedBox(
            height: 56,
            child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10), children: [
              Padding(padding: const EdgeInsets.only(right: 8),
                  child: ActionChip(avatar: const Icon(Icons.replay, size: 16), label: const Text('Repetir último'), onPressed: _repetir)),
              _chip('todas', 'Todo'),
              ...categorias.map((x) => _chip(x['id'] as String, x['nombre'] as String)),
            ]),
          ),
          Expanded(
            child: filtrados.isEmpty
                ? const Center(child: Text('No hay panes con ese nombre'))
                : GridView.builder(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 120),
                    gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 230, mainAxisSpacing: 14, crossAxisSpacing: 14, childAspectRatio: 0.78),
                    itemCount: filtrados.length,
                    itemBuilder: (context, i) {
                      final p = filtrados[i];
                      return _Producto(
                        p: p, cantidad: c[p['id']] ?? 0, onAbrir: () => _detalle(p),
                        onAgregar: () => ponerEnCarrito('${p['id']}', (c[p['id']] ?? 0) + 1),
                      );
                    },
                  ),
          ),
          if (items > 0)
            Container(
              margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              padding: const EdgeInsets.fromLTRB(18, 14, 14, 14),
              decoration: BoxDecoration(color: TantaColors.ink800, borderRadius: BorderRadius.circular(12)),
              child: Row(children: [
                const Icon(Icons.shopping_basket_outlined, color: TantaColors.cream50),
                const SizedBox(width: 12),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('$items ${items == 1 ? 'producto' : 'productos'}',
                      style: const TextStyle(color: TantaColors.cream50, fontWeight: FontWeight.w600, fontSize: 13.5)),
                  Text('Total ${dinero(t.total)}', style: const TextStyle(color: TantaColors.sand300, fontSize: 11.5)),
                ])),
                FilledButton(
                  style: FilledButton.styleFrom(backgroundColor: TantaColors.cream50, foregroundColor: TantaColors.ink900,
                      minimumSize: const Size(0, 42), padding: const EdgeInsets.symmetric(horizontal: 18)),
                  onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => CarritoPantalla(productos: productos))),
                  child: const Text('Ver carrito'),
                ),
              ]),
            ),
        ]);
      },
    );
  }

  Widget _chip(String id, String etiqueta) {
    final activo = _categoria == id;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ChoiceChip(
        label: Text(etiqueta, style: TextStyle(fontSize: 12, color: activo ? TantaColors.cream50 : TantaColors.textSecondary)),
        selected: activo,
        backgroundColor: TantaColors.surfaceCard,
        selectedColor: TantaColors.ink800,
        side: BorderSide(color: activo ? TantaColors.ink800 : TantaColors.borderDefault),
        showCheckmark: false,
        onSelected: (_) => setState(() => _categoria = id),
      ),
    );
  }
}

/// PED-06: repetir carga los productos al carrito; el precio es siempre el vigente (lo pone el servidor).
void repetirPedido(Map<String, dynamic> pedido, List<Map<String, dynamic>> productos) {
  final activos = productos.map((p) => p['id']).toSet();
  carrito.value = {
    for (final i in ((pedido['items'] as List?) ?? const []).cast<Map>())
      if (activos.contains(i['productoId'])) '${i['productoId']}': ((i['cantidad'] as num?) ?? 0).round(),
  };
}

/// A06: carrito con cantidades editables, quitar, subtotal, IGV y total.
class CarritoPantalla extends StatelessWidget {
  const CarritoPantalla({super.key, required this.productos});
  final List<Map<String, dynamic>> productos;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Mi carrito')),
      body: ValueListenableBuilder<Map<String, int>>(
        valueListenable: carrito,
        builder: (context, c, _) {
          final lineas = c.entries.map((e) => (e, productos.where((p) => p['id'] == e.key).firstOrNull)).where((x) => x.$2 != null).toList();
          if (lineas.isEmpty) return const Center(child: Text('Tu carrito está vacío'));
          final t = totalesCarrito(productos);
          return Column(children: [
            Expanded(child: ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: lineas.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (_, i) {
                final (e, p) = lineas[i];
                final precio = (p!['precioConIgv'] as num).toDouble();
                return ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text('${p['nombre']}'),
                  subtitle: Text('${dinero(precio)} c/u · ${dinero(precio * e.value)}'),
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    IconButton(tooltip: 'Quitar uno', icon: const Icon(Icons.remove_circle_outline), onPressed: () => ponerEnCarrito(e.key, e.value - 1)),
                    SizedBox(width: 28, child: Text('${e.value}', textAlign: TextAlign.center)),
                    IconButton(tooltip: 'Agregar uno', icon: const Icon(Icons.add_circle_outline), onPressed: () => ponerEnCarrito(e.key, e.value + 1)),
                    IconButton(tooltip: 'Quitar del carrito', icon: const Icon(Icons.delete_outline), onPressed: () => ponerEnCarrito(e.key, 0)),
                  ]),
                );
              },
            )),
            SafeArea(child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
              child: Column(children: [
                _fila('Subtotal', dinero(t.base)),
                _fila('IGV', dinero(t.igv)),
                _fila('Total', dinero(t.total), fuerte: true),
                const SizedBox(height: 12),
                SizedBox(width: double.infinity, child: FilledButton(
                  onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ConfirmarPedido(productos: productos))),
                  child: const Text('Continuar'),
                )),
              ]),
            )),
          ]);
        },
      ),
    );
  }
}

Widget _fila(String a, String b, {bool fuerte = false}) => Padding(
  padding: const EdgeInsets.symmetric(vertical: 2),
  child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
    Text(a, style: TextStyle(fontWeight: fuerte ? FontWeight.w700 : FontWeight.w400)),
    Text(b, style: TextStyle(fontWeight: fuerte ? FontWeight.w700 : FontWeight.w400, fontSize: fuerte ? 17 : 14)),
  ]),
);

/// A07: fecha y hora, recojo o delivery, pago contra entrega y observaciones. El servidor recalcula todo.
class ConfirmarPedido extends StatefulWidget {
  const ConfirmarPedido({super.key, required this.productos});
  final List<Map<String, dynamic>> productos;
  @override
  State<ConfirmarPedido> createState() => _ConfirmarPedidoState();
}

class _ConfirmarPedidoState extends State<ConfirmarPedido> {
  DateTime _fecha = DateTime.now().add(const Duration(days: 1));
  TimeOfDay _hora = const TimeOfDay(hour: 9, minute: 0);
  String _tipo = 'RECOJO';
  String _pago = 'EFECTIVO';
  final _dir = TextEditingController();
  final _obs = TextEditingController();
  bool _enviando = false;


  @override
  void initState() {
    super.initState();
    Api.instancia.misDirecciones().then((l) {
      if (mounted && l.isNotEmpty && _dir.text.isEmpty) setState(() => _dir.text = '${(l.first as Map)['direccion']}');
    }).catchError((_) {});
  }

  Future<void> _confirmar() async {
    setState(() => _enviando = true);
    final aviso = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    try {
      final r = await Api.instancia.crearPedido(
        items: carrito.value.entries.map((e) => {'productoId': e.key, 'cantidad': e.value}).toList(),
        fechaEntrega: _fecha.toIso8601String().substring(0, 10),
        hora: '${_hora.hour.toString().padLeft(2, '0')}:${_hora.minute.toString().padLeft(2, '0')}',
        tipoEntrega: _tipo, direccion: _tipo == 'DELIVERY' ? _dir.text.trim() : '',
        observaciones: _obs.text.trim(), pagoEntrega: _pago,
      );
      carrito.value = {};
      nav.popUntil((r) => r.isFirst);
      aviso.showSnackBar(SnackBar(content: Text('Pedido ${r['codigo'] ?? ''} registrado. Te avisaremos cuando lo confirmemos.')));
    } on ApiException catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(e.mensaje)));
    } catch (_) {
      aviso.showSnackBar(const SnackBar(content: Text('Sin conexión: intenta de nuevo')));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = totalesCarrito(widget.productos);
    final valido = carrito.value.isNotEmpty && (_tipo == 'RECOJO' || _dir.text.trim().length >= 5);
    return Scaffold(
      appBar: AppBar(title: const Text('Confirmar pedido')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Text('Entrega', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(child: OutlinedButton.icon(
            icon: const Icon(Icons.event), label: Text('${_fecha.day}/${_fecha.month}/${_fecha.year}'),
            onPressed: () async {
              final hoy = DateTime.now();
              final f = await showDatePicker(context: context, helpText: 'Fecha de entrega', initialDate: _fecha, firstDate: hoy, lastDate: hoy.add(const Duration(days: 60)));
              if (f != null) setState(() => _fecha = f);
            },
          )),
          const SizedBox(width: 8),
          Expanded(child: OutlinedButton.icon(
            icon: const Icon(Icons.schedule), label: Text(_hora.format(context)),
            onPressed: () async {
              final h = await showTimePicker(context: context, initialTime: _hora, helpText: 'Hora de entrega');
              if (h != null) setState(() => _hora = h);
            },
          )),
        ]),
        const SizedBox(height: 12),
        SegmentedButton<String>(
          segments: const [ButtonSegment(value: 'RECOJO', label: Text('Recojo en tienda')), ButtonSegment(value: 'DELIVERY', label: Text('Delivery'))],
          selected: {_tipo},
          onSelectionChanged: (v) => setState(() => _tipo = v.first),
        ),
        if (_tipo == 'DELIVERY') ...[
          const SizedBox(height: 12),
          TextField(controller: _dir, maxLength: 200, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Dirección de entrega')),
        ],
        const SizedBox(height: 16),
        Text('Pago contra entrega', style: Theme.of(context).textTheme.titleMedium),
        const Text('Pagas al recibir tu pedido. Elige cómo para que llevemos vuelto o POS.', style: TextStyle(color: TantaColors.textMuted, fontSize: 12.5)),
        const SizedBox(height: 8),
        Wrap(spacing: 8, children: [
          // Medios de ventas del catálogo; el crédito no es pago contra entrega.
          for (final m in mediosPago('enVentas').where((m) => m['esCredito'] != true))
            ChoiceChip(label: Text('${m['nombre']}'), selected: _pago == m['codigo'], onSelected: (_) => setState(() => _pago = '${m['codigo']}')),
        ]),
        const SizedBox(height: 16),
        TextField(controller: _obs, maxLength: 500, maxLines: 2, decoration: const InputDecoration(labelText: 'Observaciones (opcional)', hintText: 'Ej.: tocar el timbre, sin ajonjolí')),
        const Divider(height: 28),
        _fila('Subtotal', dinero(t.base)),
        _fila('IGV', dinero(t.igv)),
        _fila('Total a pagar al recibir', dinero(t.total), fuerte: true),
      ]),
      bottomNavigationBar: SafeArea(child: Padding(
        padding: const EdgeInsets.all(16),
        child: FilledButton(onPressed: !valido || _enviando ? null : _confirmar, child: Text(_enviando ? 'Enviando…' : 'Confirmar pedido')),
      )),
    );
  }
}

class _Producto extends StatelessWidget {
  const _Producto({required this.p, required this.cantidad, required this.onAgregar, required this.onAbrir});
  final Map<String, dynamic> p;
  final int cantidad;
  final VoidCallback onAgregar;
  final VoidCallback onAbrir;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onAbrir,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        decoration: BoxDecoration(color: TantaColors.surfaceCard, borderRadius: BorderRadius.circular(12), border: Border.all(color: TantaColors.borderSubtle)),
        clipBehavior: Clip.antiAlias,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Container(
              width: double.infinity,
              decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFFE8D9C3), Color(0xFFD8C0A0)])),
              alignment: Alignment.center,
              child: Text('${p['nombre']}'.substring(0, 1),
                  style: const TextStyle(fontFamily: 'Fraunces', fontSize: 44, fontWeight: FontWeight.w600, color: Color(0x552E1F18))),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${p['nombre']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: estiloDisplay.copyWith(fontSize: 14)),
              const SizedBox(height: 2),
              Text('por ${'${p['unidad']}'.toLowerCase()}', style: const TextStyle(fontSize: 11, color: TantaColors.textMuted)),
              const SizedBox(height: 8),
              Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                Text(dinero((p['precioConIgv'] as num?)?.toDouble() ?? 0), style: estiloDisplay.copyWith(fontSize: 15)),
                Semantics(
                  button: true, label: 'Agregar ${p['nombre']}',
                  child: InkWell(
                    onTap: onAgregar,
                    borderRadius: BorderRadius.circular(999),
                    child: Container(
                      width: 30, height: 30,
                      decoration: BoxDecoration(border: Border.all(color: TantaColors.borderDefault), shape: BoxShape.circle),
                      child: cantidad > 0
                          ? Center(child: Text('$cantidad', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12)))
                          : const Icon(Icons.add, size: 16),
                    ),
                  ),
                ),
              ]),
            ]),
          ),
        ]),
      ),
    );
  }
}
