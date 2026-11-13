import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../core/api.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

/// Fecha de hoy en Lima (la misma con la que el servidor decide qué promociones están vigentes).
String _hoyLima([int dias = 0]) => DateTime.now().toUtc().subtract(const Duration(hours: 5)).add(Duration(days: dias)).toIso8601String().substring(0, 10);

/// VEN-07: el vendedor publica promociones para los clientes. «Solo hoy» vence sola al terminar el día;
/// con «Avisar» llega a la campana y al celular de cada cliente. Mismo API y reglas que la web.
class Promociones extends StatefulWidget {
  const Promociones({super.key, required this.productos});
  final List<Map<String, dynamic>> productos;
  @override
  State<Promociones> createState() => _PromocionesState();
}

class _PromocionesState extends State<Promociones> {
  List<Map<String, dynamic>>? _lista;
  String? _error;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    try {
      final l = await Api.instancia.promociones();
      if (mounted) setState(() { _lista = l.cast<Map<String, dynamic>>(); _error = null; });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.mensaje);
    } catch (_) {
      if (mounted) setState(() => _error = 'Sin conexión: intenta de nuevo');
    }
  }

  Future<void> _editar([Map<String, dynamic>? p]) async {
    final ok = await Navigator.push<bool>(context, MaterialPageRoute(builder: (_) => _FormPromocion(productos: widget.productos, promo: p)));
    if (ok == true) _cargar();
  }

  @override
  Widget build(BuildContext context) {
    final l = _lista;
    final hoy = _hoyLima();
    return Scaffold(
      appBar: AppBar(title: const Text('Promociones')),
      floatingActionButton: FloatingActionButton.extended(onPressed: () => _editar(), icon: const Icon(Icons.add), label: const Text('Nueva promoción')),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _error != null
            ? ListView(children: [ErrorReintentar(mensaje: _error!, onReintentar: _cargar)])
            : l == null
                ? const Esqueleto()
                : l.isEmpty
                    ? ListView(children: const [VacioMensaje('Aún no hay promociones', icono: Icons.local_offer_outlined)])
                    : ListView.separated(
                        padding: const EdgeInsets.fromLTRB(16, 12, 16, 96),
                        itemCount: l.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 10),
                        itemBuilder: (_, i) {
                          final p = l[i];
                          final vigente = p['activa'] == true && '${p['desde']}'.compareTo(hoy) <= 0 && '${p['hasta']}'.compareTo(hoy) >= 0;
                          final soloHoy = p['desde'] == p['hasta'];
                          return Pulsable(
                            radio: 8,
                            onTap: () => _editar(p),
                            child: Panel(
                              padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Row(children: [
                                  Expanded(child: Text('${p['titulo']}', style: const TextStyle(fontWeight: FontWeight.w600))),
                                  Insignia(vigente && p['agotadaEn'] != null ? 'Agotada' : vigente ? (soloHoy ? 'Solo hoy' : 'Vigente') : p['activa'] == true ? 'Programada / vencida' : 'Inactiva',
                                      tono: vigente ? Tono.ok : Tono.neutral, punto: true),
                                ]),
                                const SizedBox(height: 2),
                                Text('${p['producto']} · ${dinero(((p['precioConIgv'] as num?) ?? 0).toDouble())} (antes ${dinero(((p['precioNormal'] as num?) ?? 0).toDouble())})',
                                    style: const TextStyle(fontSize: 12.5)),
                                Text(soloHoy ? 'Solo el ${fechaCorta('${p['desde']}')}' : 'Del ${fechaCorta('${p['desde']}')} al ${fechaCorta('${p['hasta']}')}'
                                    '${p['cantidad'] == null ? '' : ' · ofrecidas ${p['cantidad']}'} · tomadas ${((p['vendidas'] as num?) ?? 0).toStringAsFixed(0)} · quedan ${((p['disponible'] as num?) ?? 0).toStringAsFixed(0)}',
                                    style: const TextStyle(fontSize: 12, color: TantaColors.textMuted)),
                              ]),
                            ),
                          );
                        },
                      ),
      ),
    );
  }
}

class _FormPromocion extends StatefulWidget {
  const _FormPromocion({required this.productos, this.promo});
  final List<Map<String, dynamic>> productos;
  final Map<String, dynamic>? promo;
  @override
  State<_FormPromocion> createState() => _FormPromocionState();
}

class _FormPromocionState extends State<_FormPromocion> {
  late final _titulo = TextEditingController(text: '${widget.promo?['titulo'] ?? ''}');
  late final _precio = TextEditingController(text: widget.promo == null ? '' : '${widget.promo!['precioConIgv']}');
  // Unidades en oferta (10 panes); vacío = hasta agotar el stock del producto.
  late final _unidades = TextEditingController(text: widget.promo?['cantidad'] == null ? '' : '${widget.promo!['cantidad']}');
  late String? _producto = widget.promo?['productoId'] as String? ?? widget.productos.firstOrNull?['id'] as String?;
  late String _desde = '${widget.promo?['desde'] ?? _hoyLima()}';
  late String _hasta = '${widget.promo?['hasta'] ?? _hoyLima()}';
  late bool _activa = widget.promo?['activa'] != false;
  bool _avisar = true;
  bool _enviando = false;

  double get _valor => double.tryParse(_precio.text.replaceAll(',', '.')) ?? 0;
  bool get _valido => _producto != null && _titulo.text.trim().length >= 3 && _valor > 0 && _hasta.compareTo(_desde) >= 0;

  Future<void> _fecha(bool desde) async {
    final actual = DateTime.parse(desde ? _desde : _hasta);
    final f = await showDatePicker(context: context, initialDate: actual, firstDate: DateTime.parse(_hoyLima(-1)), lastDate: DateTime.parse(_hoyLima(365)));
    if (f == null) return;
    final t = f.toIso8601String().substring(0, 10);
    setState(() {
      if (desde) { _desde = t; if (_hasta.compareTo(t) < 0) _hasta = t; } else { _hasta = t; }
    });
  }

  Future<void> _guardar() async {
    final nav = Navigator.of(context);
    final aviso = ScaffoldMessenger.of(context);
    setState(() => _enviando = true);
    try {
      await Api.instancia.guardarPromocion(widget.promo?['id'] as String?, {
        'productoId': _producto, 'titulo': _titulo.text.trim(), 'precioConIgv': _valor, 'desde': _desde, 'hasta': _hasta, 'activa': _activa, 'avisar': _avisar,
        'cantidad': (int.tryParse(_unidades.text.trim()) ?? 0) > 0 ? int.parse(_unidades.text.trim()) : null,
      });
      aviso.showSnackBar(SnackBar(content: Text(_avisar && _activa ? 'Promoción publicada y avisada a los clientes' : 'Promoción guardada')));
      nav.pop(true);
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
    final hoy = _hoyLima();
    final soloHoy = _desde == hoy && _hasta == hoy;
    final normal = (widget.productos.where((p) => p['id'] == _producto).firstOrNull?['precioConIgv'] as num?)?.toDouble();
    return Scaffold(
      appBar: AppBar(title: Text(widget.promo == null ? 'Nueva promoción' : 'Editar promoción')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        TextField(controller: _titulo, maxLength: 80, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Título', hintText: 'Ej.: Pan francés a mitad de precio')),
        DropdownButtonFormField<String>(
          initialValue: _producto, isExpanded: true,
          decoration: const InputDecoration(labelText: 'Producto'),
          items: [for (final p in widget.productos) DropdownMenuItem(value: '${p['id']}', child: Text('${p['nombre']}', overflow: TextOverflow.ellipsis))],
          onChanged: (v) => setState(() => _producto = v),
        ),
        const SizedBox(height: 12),
        TextField(controller: _precio, keyboardType: const TextInputType.numberWithOptions(decimal: true), onChanged: (_) => setState(() {}),
            decoration: InputDecoration(labelText: 'Precio por unidad con IGV (S/)', helperText: normal == null ? null : 'Precio normal ${dinero(normal)} · 10 panes a S/ 20 = S/ 2.00')),
        const SizedBox(height: 12),
        TextField(controller: _unidades, keyboardType: TextInputType.number, inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: const InputDecoration(labelText: 'Unidades en oferta (opcional)', helperText: 'Al tomarse todas, se avisa a los clientes que se agotó. Vacío = hasta agotar el stock')),
        const SizedBox(height: 16),
        Text('Vigencia', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Wrap(spacing: 8, children: [
          ChoiceChip(label: const Text('Solo hoy'), selected: soloHoy, onSelected: (_) => setState(() { _desde = hoy; _hasta = hoy; })),
          ChoiceChip(label: const Text('Otras fechas'), selected: !soloHoy, onSelected: (_) => _fecha(false)),
        ]),
        if (!soloHoy) Row(children: [
          Expanded(child: TextButton.icon(onPressed: () => _fecha(true), icon: const Icon(Icons.event_outlined), label: Text('Desde ${fechaCorta(_desde)}'))),
          Expanded(child: TextButton.icon(onPressed: () => _fecha(false), icon: const Icon(Icons.event_outlined), label: Text('Hasta ${fechaCorta(_hasta)}'))),
        ]),
        Text(soloHoy ? 'Vence sola a medianoche.' : 'Vence sola al terminar el ${fechaCorta(_hasta)}.', style: const TextStyle(fontSize: 12.5, color: TantaColors.textMuted)),
        const SizedBox(height: 8),
        SwitchListTile(contentPadding: EdgeInsets.zero, value: _activa, onChanged: (v) => setState(() => _activa = v), title: const Text('Activa')),
        SwitchListTile(contentPadding: EdgeInsets.zero, value: _avisar, onChanged: (v) => setState(() => _avisar = v),
            title: const Text('Avisar a los clientes'), subtitle: const Text('Llega a la campana y al celular de quienes tienen cuenta')),
      ]),
      bottomNavigationBar: SafeArea(child: Padding(
        padding: const EdgeInsets.all(16),
        child: FilledButton(onPressed: !_valido || _enviando ? null : _guardar, child: Text(_enviando ? 'Guardando…' : 'Guardar promoción')),
      )),
    );
  }
}
