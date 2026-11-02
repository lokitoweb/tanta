import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../core/arranque.dart';
import '../core/tema.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

/// La versión instalada es menor que la mínima que fijó el superadmin:
/// la app no deja operar (evita datos con reglas viejas) y lleva a la tienda.
class ActualizacionObligatoria extends StatelessWidget {
  const ActualizacionObligatoria({super.key, required this.estado});
  final EstadoVersion estado;

  @override
  Widget build(BuildContext context) {
    final uri = Uri.tryParse(estado.url);
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Marca(),
              const SizedBox(height: 36),
              const Icon(Icons.system_update_outlined, size: 48, color: TantaColors.ink700),
              const SizedBox(height: 16),
              Text('Actualización necesaria', style: estiloDisplay.copyWith(fontSize: 22), textAlign: TextAlign.center),
              const SizedBox(height: 8),
              Text(estado.mensaje, textAlign: TextAlign.center, style: const TextStyle(fontSize: 14, color: TantaColors.textMuted)),
              const SizedBox(height: 28),
              FilledButton.icon(
                onPressed: uri != null && uri.isScheme('https') ? () => launchUrl(uri, mode: LaunchMode.externalApplication) : null,
                icon: const Icon(Icons.download_outlined),
                label: Text(plataforma == 'ios' ? 'Abrir App Store' : 'Abrir Google Play'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
