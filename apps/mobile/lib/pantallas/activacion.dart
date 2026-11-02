import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

/// Primera apertura: la app no trae ninguna dirección; se escribe el dominio donde está
/// instalado el sistema. Después la app sigue sola los cambios que haga el superadmin.
class Activacion extends StatefulWidget {
  const Activacion({super.key, required this.onActivada});
  final VoidCallback onActivada;

  @override
  State<Activacion> createState() => _ActivacionState();
}

class _ActivacionState extends State<Activacion> {
  final _direccion = TextEditingController();
  bool _ocupado = false;
  String? _error;

  Future<void> _activar(String texto) async {
    if (_ocupado || texto.trim().isEmpty) return;
    setState(() { _ocupado = true; _error = null; });
    try {
      await Api.instancia.cambiarServidor(texto);
      widget.onActivada();
    } on ApiException catch (e) {
      setState(() => _error = e.mensaje);
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                const Center(child: Marca(escala: 1.1)),
                const SizedBox(height: 28),
                Text('Activa la aplicación', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 8),
                const Text('Escribe el dominio de tu empresa. Solo se hace una vez.', textAlign: TextAlign.center),
                const SizedBox(height: 24),
                TextField(
                  controller: _direccion,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  onSubmitted: _activar,
                  decoration: const InputDecoration(labelText: 'Dominio (ej. miempresa.com)', prefixIcon: Icon(Icons.language)),
                ),
                const SizedBox(height: 12),
                FilledButton(onPressed: _ocupado ? null : () => _activar(_direccion.text), child: const Text('Conectar')),
                if (_ocupado) const Padding(padding: EdgeInsets.only(top: 16), child: Center(child: CircularProgressIndicator(strokeWidth: 2, color: TantaColors.sand500))),
                if (_error != null) Padding(padding: const EdgeInsets.only(top: 16), child: Text(_error!, textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).colorScheme.error))),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
