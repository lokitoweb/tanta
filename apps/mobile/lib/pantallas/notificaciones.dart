import 'dart:async';
import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

/// Cantidad de avisos sin leer; la campana la muestra y se refresca sola.
final noLeidas = ValueNotifier<int>(0);

Future<void> refrescarNoLeidas() async {
  try { noLeidas.value = ((await Api.instancia.notificaciones())['noLeidas'] as num?)?.toInt() ?? 0; } catch (_) {}
}

/// Campana del encabezado (A02): contador de avisos y acceso al centro de notificaciones.
class Campana extends StatefulWidget {
  const Campana({super.key, required this.onAbrir});
  final void Function(String ruta) onAbrir;
  @override
  State<Campana> createState() => _CampanaState();
}

class _CampanaState extends State<Campana> {
  Timer? _t;

  @override
  void initState() {
    super.initState();
    refrescarNoLeidas();
    _t = Timer.periodic(const Duration(seconds: 30), (_) => refrescarNoLeidas());
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<int>(
        valueListenable: noLeidas,
        builder: (_, n, __) => IconButton(
          tooltip: n > 0 ? '$n notificaciones sin leer' : 'Notificaciones',
          icon: Badge(isLabelVisible: n > 0, label: Text(n > 99 ? '99+' : '$n'), child: const Icon(Icons.notifications_outlined)),
          onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => Notificaciones(onAbrir: widget.onAbrir))),
        ),
      );
}

/// A11: avisos de estado, stock, deudas y aprobaciones; tocar uno lo marca leído y abre su pantalla.
class Notificaciones extends StatefulWidget {
  const Notificaciones({super.key, required this.onAbrir});
  final void Function(String ruta) onAbrir;
  @override
  State<Notificaciones> createState() => _NotificacionesState();
}

class _NotificacionesState extends State<Notificaciones> {
  List<Map<String, dynamic>>? _avisos;
  String? _error;
  bool _soloNoLeidas = false;

  static const _iconos = {
    'pedido': Icons.receipt_long_outlined, 'promocion': Icons.campaign_outlined, 'venta': Icons.point_of_sale_outlined, 'stock': Icons.inventory_2_outlined,
    'requisicion': Icons.assignment_outlined, 'descuento': Icons.percent, 'conteo': Icons.fact_check_outlined,
  };

  Future<void> _cargar() async {
    try {
      final r = await Api.instancia.notificaciones();
      noLeidas.value = (r['noLeidas'] as num?)?.toInt() ?? 0;
      if (mounted) setState(() { _avisos = ((r['avisos'] as List?) ?? const []).cast<Map<String, dynamic>>(); _error = null; });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.mensaje);
    } catch (_) {
      if (mounted) setState(() => _error = 'Sin conexión: intenta de nuevo');
    }
  }

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _abrir(Map<String, dynamic> a) async {
    if (a['leida'] != true) {
      try { await Api.instancia.marcarLeidas([(a['id'] as num).toInt()]); } catch (_) {}
      refrescarNoLeidas();
    }
    if (!mounted) return;
    Navigator.pop(context);
    if ('${a['ruta']}'.isNotEmpty) widget.onAbrir('${a['ruta']}');
  }

  @override
  Widget build(BuildContext context) {
    final lista = (_avisos ?? const []).where((a) => !_soloNoLeidas || a['leida'] != true).toList();
    return Scaffold(
      appBar: AppBar(title: const Text('Notificaciones'), actions: [
        TextButton(
          onPressed: () async { try { await Api.instancia.marcarLeidas(null); } catch (_) {} _cargar(); },
          child: const Text('Marcar todo leído'),
        ),
      ]),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: Row(children: [
            ChoiceChip(label: const Text('Todas'), selected: !_soloNoLeidas, onSelected: (_) => setState(() => _soloNoLeidas = false)),
            const SizedBox(width: 8),
            ChoiceChip(label: const Text('Sin leer'), selected: _soloNoLeidas, onSelected: (_) => setState(() => _soloNoLeidas = true)),
          ]),
        ),
        Expanded(child: RefreshIndicator(
          onRefresh: _cargar,
          child: _error != null
              ? ListView(children: [ErrorReintentar(mensaje: _error!, onReintentar: _cargar)])
              : _avisos == null
              ? ListView(children: const [Esqueleto()])
              : lista.isEmpty
                  ? ListView(children: [VacioMensaje(_soloNoLeidas ? 'No tienes notificaciones sin leer' : 'No tienes notificaciones',
                      icono: Icons.notifications_none_outlined)])
                  : ListView.separated(
                      itemCount: lista.length,
                      separatorBuilder: (_, __) => const Divider(height: 1),
                      itemBuilder: (_, i) {
                        final a = lista[i];
                        final leida = a['leida'] == true;
                        final fecha = DateTime.tryParse('${a['fecha']}')?.toLocal();
                        return ListTile(
                          leading: Icon(_iconos[a['tipo']] ?? Icons.notifications_outlined, color: leida ? TantaColors.textMuted : TantaColors.ink800),
                          title: Text('${a['titulo']}', style: TextStyle(fontWeight: leida ? FontWeight.w400 : FontWeight.w700)),
                          subtitle: Text('${a['cuerpo']}${fecha == null ? '' : '\n${fecha.day}/${fecha.month} ${fecha.hour.toString().padLeft(2, '0')}:${fecha.minute.toString().padLeft(2, '0')}'}'),
                          isThreeLine: true,
                          trailing: leida ? null : const Icon(Icons.circle, size: 10, color: TantaColors.ink800),
                          onTap: () => _abrir(a),
                        );
                      },
                    ),
        )),
      ]),
    );
  }
}
