import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import '../core/api.dart';
import '../core/catalogos.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

String _mensaje(Object e) => e is ApiException ? e.mensaje : 'Sin conexión: intenta de nuevo';
const _estados = {'ABIERTO': ('Abierto', Tono.danger), 'EN_PROCESO': ('En proceso', Tono.warn), 'RESUELTO': ('Resuelto', Tono.ok), 'CERRADO': ('Cerrado', Tono.neutral)};
String _cuando(String iso) {
  final d = DateTime.tryParse(iso)?.toLocal();
  return d == null ? '' : '${d.day}/${d.month} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

/// Reclamos (pedido del ingeniero). El cliente los registra (con su pedido y una foto si quiere) y sigue la respuesta;
/// la panadería responde y los lleva por sus estados. Cada paso llega como aviso y queda en el seguimiento.
class Reclamos extends StatefulWidget {
  const Reclamos({super.key, this.pedido, this.abrir});
  /// Desde el detalle de un pedido: abre el formulario ya ligado a él.
  final String? pedido;
  /// Desde un aviso: abre ese reclamo.
  final String? abrir;
  @override
  State<Reclamos> createState() => _ReclamosState();
}

class _ReclamosState extends State<Reclamos> {
  List<Map<String, dynamic>>? _lista;
  String? _error;
  bool get _esCliente => Api.instancia.puede('reclamos.crear');

  @override
  void initState() {
    super.initState();
    _cargar().then((_) {
      if (!mounted) return;
      if (widget.pedido != null) _nuevo(pedido: widget.pedido);
      if (widget.abrir != null) _detalle(widget.abrir!);
    });
  }

  Future<void> _cargar() async {
    try {
      final l = await Api.instancia.reclamos();
      if (mounted) setState(() { _lista = l.cast<Map<String, dynamic>>(); _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = _mensaje(e));
    }
  }

  Future<void> _nuevo({String? pedido}) async {
    final ok = await Navigator.push<bool>(context, MaterialPageRoute(builder: (_) => _NuevoReclamo(pedido: pedido)));
    if (ok == true) _cargar();
  }

  Future<void> _detalle(String codigo) async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => _DetalleReclamo(codigo: codigo, esCliente: _esCliente)));
    _cargar();
  }

  @override
  Widget build(BuildContext context) {
    final l = _lista;
    return Scaffold(
      appBar: AppBar(title: Text(_esCliente ? 'Mis reclamos' : 'Reclamos')),
      floatingActionButton: _esCliente ? FloatingActionButton.extended(onPressed: () => _nuevo(), icon: const Icon(Icons.add_comment_outlined), label: const Text('Nuevo reclamo')) : null,
      body: RefreshIndicator(onRefresh: _cargar, child: _error != null
          ? ListView(children: [ErrorReintentar(mensaje: _error!, onReintentar: _cargar)])
          : l == null ? const Esqueleto()
          : l.isEmpty ? ListView(children: [VacioMensaje(_esCliente ? 'No tienes reclamos. Si algo salió mal, cuéntanos.' : 'No hay reclamos', icono: Icons.support_agent_outlined)])
          : ListView.separated(
              padding: const EdgeInsets.only(bottom: 90),
              itemCount: l.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (_, i) {
                final r = l[i];
                final e = _estados['${r['estado']}'] ?? ('${r['estado']}', Tono.neutral);
                return ListTile(
                  title: Text('${r['codigo']} · ${r['tipoNombre']}'),
                  subtitle: Text('${_esCliente ? '' : '${r['cliente']} · '}${r['pedido'] == null ? '' : 'pedido ${r['pedido']} · '}${_cuando('${r['creadoEn']}')}',
                      maxLines: 1, overflow: TextOverflow.ellipsis),
                  trailing: Insignia(e.$1, tono: e.$2, punto: true),
                  onTap: () => _detalle('${r['codigo']}'),
                );
              })),
    );
  }
}

class _NuevoReclamo extends StatefulWidget {
  const _NuevoReclamo({this.pedido});
  final String? pedido;
  @override
  State<_NuevoReclamo> createState() => _NuevoReclamoState();
}

class _NuevoReclamoState extends State<_NuevoReclamo> {
  String? _tipo;
  String? _pedido;
  final _texto = TextEditingController();
  List<Map<String, dynamic>> _pedidos = [];
  String? _foto;
  bool _enviando = false;

  @override
  void initState() {
    super.initState();
    _pedido = widget.pedido;
    final t = tiposReclamo();
    if (t.isNotEmpty) _tipo = '${t.first['codigo']}';
    Api.instancia.misPedidos().then((l) { if (mounted) setState(() => _pedidos = l.cast<Map<String, dynamic>>().take(30).toList()); }).catchError((_) {});
  }

  @override
  void dispose() { _texto.dispose(); super.dispose(); }

  Future<void> _elegirFoto() async {
    final x = await ImagePicker().pickImage(source: ImageSource.camera, maxWidth: 1200, imageQuality: 70);
    if (x == null) return;
    final b = await x.readAsBytes();
    if (b.length > 1000000) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('La foto pesa más de 1 MB: toma otra.')));
      return;
    }
    setState(() => _foto = 'data:image/jpeg;base64,${base64Encode(b)}');
  }

  Future<void> _enviar() async {
    final nav = Navigator.of(context);
    final aviso = ScaffoldMessenger.of(context);
    setState(() => _enviando = true);
    try {
      final r = await Api.instancia.crearReclamo(tipo: _tipo!, descripcion: _texto.text.trim(), pedido: _pedido, foto: _foto);
      aviso.showSnackBar(SnackBar(content: Text('Reclamo ${r['codigo']} registrado: te avisaremos cada respuesta'), backgroundColor: TantaColors.stateOk));
      nav.pop(true);
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e)), backgroundColor: TantaColors.stateDanger));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tipos = tiposReclamo();
    return Scaffold(
      appBar: AppBar(title: const Text('Nuevo reclamo')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        DropdownButtonFormField<String>(
          initialValue: _tipo, isExpanded: true, decoration: const InputDecoration(labelText: 'Motivo'),
          items: [for (final t in tipos) DropdownMenuItem(value: '${t['codigo']}', child: Text('${t['nombre']}'))],
          onChanged: (v) => setState(() => _tipo = v),
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String?>(
          key: ValueKey('ped-${_pedidos.length}'),
          initialValue: _pedido, isExpanded: true, decoration: const InputDecoration(labelText: 'Pedido (opcional)'),
          items: [
            const DropdownMenuItem<String?>(value: null, child: Text('Sin pedido')),
            if (_pedido != null && !_pedidos.any((p) => p['codigo'] == _pedido)) DropdownMenuItem<String?>(value: _pedido, child: Text(_pedido!)),
            for (final p in _pedidos) DropdownMenuItem<String?>(value: '${p['codigo']}', child: Text('${p['codigo']} · entrega ${p['fecha_entrega']}')),
          ],
          onChanged: (v) => setState(() => _pedido = v),
        ),
        const SizedBox(height: 12),
        TextField(controller: _texto, maxLength: 1000, minLines: 3, maxLines: 6, onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(labelText: '¿Qué pasó?', hintText: 'Ej.: llegaron 45 panes y pedí 50')),
        const SizedBox(height: 8),
        Row(children: [
          OutlinedButton.icon(onPressed: _elegirFoto, icon: const Icon(Icons.photo_camera_outlined), label: Text(_foto == null ? 'Adjuntar foto' : 'Cambiar foto')),
          if (_foto != null) ...[
            const SizedBox(width: 8),
            const Icon(Icons.check_circle, color: TantaColors.stateOk),
            TextButton(onPressed: () => setState(() => _foto = null), child: const Text('Quitar')),
          ],
        ]),
      ]),
      bottomNavigationBar: SafeArea(child: Padding(padding: const EdgeInsets.all(16), child: FilledButton(
        onPressed: _tipo == null || _texto.text.trim().length < 10 || _enviando ? null : _enviar,
        child: Text(_enviando ? 'Enviando…' : 'Enviar reclamo')))),
    );
  }
}

class _DetalleReclamo extends StatefulWidget {
  const _DetalleReclamo({required this.codigo, required this.esCliente});
  final String codigo;
  final bool esCliente;
  @override
  State<_DetalleReclamo> createState() => _DetalleReclamoState();
}

class _DetalleReclamoState extends State<_DetalleReclamo> {
  Map<String, dynamic>? _r;
  String? _error;
  final _msg = TextEditingController();
  bool _enviando = false;

  @override
  void initState() { super.initState(); _cargar(); }
  @override
  void dispose() { _msg.dispose(); super.dispose(); }

  Future<void> _cargar() async {
    try {
      final r = await Api.instancia.reclamo(widget.codigo);
      if (mounted) setState(() { _r = r; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = _mensaje(e));
    }
  }

  Future<void> _responder({String? estado}) async {
    final aviso = ScaffoldMessenger.of(context);
    setState(() => _enviando = true);
    try {
      await Api.instancia.responderReclamo(widget.codigo, _msg.text.trim(), estado: estado);
      _msg.clear();
      await _cargar();
    } catch (e) {
      aviso.showSnackBar(SnackBar(content: Text(_mensaje(e)), backgroundColor: TantaColors.stateDanger));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = _r;
    final gestiona = Api.instancia.puede('reclamos.gestionar');
    final abierto = r != null && r['estado'] != 'CERRADO';
    final hayTexto = _msg.text.trim().length >= 2;
    return Scaffold(
      appBar: AppBar(title: Text(widget.codigo)),
      body: _error != null
          ? ListView(children: [ErrorReintentar(mensaje: _error!, onReintentar: _cargar)])
          : r == null ? const Esqueleto()
          : ListView(padding: const EdgeInsets.all(16), children: [
              Row(children: [
                Expanded(child: Text('${r['tipoNombre']}', style: Theme.of(context).textTheme.titleMedium)),
                Insignia((_estados['${r['estado']}'] ?? ('${r['estado']}', Tono.neutral)).$1, tono: (_estados['${r['estado']}'] ?? ('', Tono.neutral)).$2, punto: true),
              ]),
              Text('${widget.esCliente ? '' : '${r['cliente']} · '}${r['pedido'] == null ? '' : 'pedido ${r['pedido']} · '}${_cuando('${r['creadoEn']}')}', style: const TextStyle(color: TantaColors.textMuted)),
              const SizedBox(height: 10),
              Panel(padding: const EdgeInsets.all(12), child: Text('${r['descripcion']}')),
              if ('${r['resolucion'] ?? ''}'.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 10), child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: TantaColors.stateOkBg, borderRadius: BorderRadius.circular(8)),
                child: Text('Solución: ${r['resolucion']}'))),
              const SizedBox(height: 14),
              for (final p in ((r['seguimiento'] as List?) ?? const []).cast<Map>())
                Align(
                  alignment: p['deCliente'] == true ? Alignment.centerRight : Alignment.centerLeft,
                  child: Container(
                    margin: const EdgeInsets.only(bottom: 8), padding: const EdgeInsets.all(10),
                    constraints: const BoxConstraints(maxWidth: 320),
                    decoration: BoxDecoration(color: p['deCliente'] == true ? TantaColors.surfaceCard : TantaColors.cream200, borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: TantaColors.borderSubtle)),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('${p['autor']} · ${_cuando('${p['creadoEn']}')}', style: const TextStyle(fontSize: 11, color: TantaColors.textMuted)),
                      Text('${p['mensaje']}'),
                    ]),
                  ),
                ),
              if (abierto && (widget.esCliente || gestiona)) ...[
                const SizedBox(height: 8),
                TextField(controller: _msg, maxLength: 1000, minLines: 1, maxLines: 4, onChanged: (_) => setState(() {}),
                    decoration: InputDecoration(labelText: widget.esCliente ? 'Escribe a la panadería' : 'Respuesta al cliente')),
              ],
            ]),
      bottomNavigationBar: r == null || !abierto || !(widget.esCliente || gestiona) ? null : SafeArea(child: Padding(
        padding: const EdgeInsets.all(16),
        child: widget.esCliente
            ? FilledButton(onPressed: hayTexto && !_enviando ? () => _responder() : null, child: const Text('Enviar'))
            : AccionesDialogo(
                secundaria: OutlinedButton(onPressed: hayTexto && !_enviando ? () => _responder() : null, child: const Text('Responder')),
                principal: FilledButton(
                  onPressed: hayTexto && !_enviando ? () => _responder(estado: r['estado'] == 'RESUELTO' ? 'CERRADO' : 'RESUELTO') : null,
                  child: Text(r['estado'] == 'RESUELTO' ? 'Cerrar' : 'Resolver')),
              ),
      )),
    );
  }
}
