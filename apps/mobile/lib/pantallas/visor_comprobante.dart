import 'dart:typed_data';
import 'package:flutter/material.dart';
import '../core/api.dart';
import '../ui/comunes.dart';

/// Comprobante privado dentro de la app: se pide con la sesión y se puede acercar con los dedos.
class VisorComprobante extends StatefulWidget {
  const VisorComprobante({super.key, required this.url, this.titulo = 'Comprobante'});
  final String url;
  final String titulo;
  @override
  State<VisorComprobante> createState() => _VisorComprobanteState();
}

class _VisorComprobanteState extends State<VisorComprobante> {
  Uint8List? _bytes;
  String? _error;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    setState(() => _error = null);
    try {
      final b = await Api.instancia.archivoPrivado(widget.url);
      if (mounted) setState(() => _bytes = b);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.mensaje);
    } catch (_) {
      if (mounted) setState(() => _error = 'Sin conexión: intenta de nuevo');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(widget.titulo)),
        body: _error != null
            ? ErrorReintentar(mensaje: _error!, onReintentar: _cargar)
            : _bytes == null
                ? const Center(child: CircularProgressIndicator())
                : InteractiveViewer(maxScale: 5, child: Center(child: Image.memory(_bytes!))),
      );
}

/// Botón que abre el comprobante; no aparece si el registro no lo tiene.
class BotonComprobante extends StatelessWidget {
  const BotonComprobante({super.key, required this.url});
  final String? url;

  @override
  Widget build(BuildContext context) => url == null
      ? const SizedBox.shrink()
      : IconButton(
          tooltip: 'Ver comprobante',
          icon: const Icon(Icons.receipt_outlined, size: 20),
          onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => VisorComprobante(url: url!))),
        );
}
