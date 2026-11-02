import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/tema.dart';
import '../core/tokens.dart';

/// Marca de la panadería: wordmark con tracking amplio y el pill "PAN DE CASA",
/// igual que la tarjeta de presentación.
class Marca extends StatelessWidget {
  const Marca({super.key, this.escala = 1, this.invertida = false});
  final double escala;
  final bool invertida;

  @override
  Widget build(BuildContext context) {
    // Logo subido por el superadmin en Configuración → Marca; si no hay, el wordmark.
    final logoId = (Api.instancia.config['marca'] as Map?)?['logoId'];
    if (logoId != null) {
      final logo = Image.network(Api.instancia.urlArchivo('/archivos/$logoId'), height: 56 * escala, fit: BoxFit.contain,
          semanticLabel: '${(Api.instancia.config['marca'] as Map)['nombreApp'] ?? 'Tanta'}',
          errorBuilder: (_, __, ___) => _wordmark());
      // Sobre fondo oscuro el logo se pinta en crema para que se lea.
      return invertida ? ColorFiltered(colorFilter: const ColorFilter.mode(TantaColors.cream50, BlendMode.srcIn), child: logo) : logo;
    }
    return _wordmark();
  }

  Widget _wordmark() {
    final color = invertida ? TantaColors.cream50 : TantaColors.ink800;
    final pillBg = invertida ? TantaColors.cream50 : TantaColors.ink800;
    final pillFg = invertida ? TantaColors.ink800 : TantaColors.cream50;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          'TANTA',
          style: TextStyle(
            fontFamily: 'Fraunces',
            fontSize: 34 * escala,
            fontWeight: FontWeight.w600,
            letterSpacing: 34 * escala * 0.2,
            color: color,
            height: 1.05,
          ),
        ),
        const SizedBox(height: 10),
        Container(
          padding: EdgeInsets.symmetric(horizontal: 16 * escala, vertical: 5 * escala),
          decoration: BoxDecoration(color: pillBg, borderRadius: BorderRadius.circular(999)),
          child: Text(
            'PAN DE CASA',
            style: TextStyle(
              fontSize: 9.5 * escala,
              fontWeight: FontWeight.w600,
              letterSpacing: 2.6 * escala,
              color: pillFg,
            ),
          ),
        ),
      ],
    );
  }
}

/// Tarjeta base del sistema: borde cálido, radio grande, sin sombra dura.
class Panel extends StatelessWidget {
  const Panel({super.key, required this.child, this.padding = const EdgeInsets.all(18)});
  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: TantaColors.surfaceCard,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: TantaColors.borderSubtle),
      ),
      child: child,
    );
  }
}

enum Tono { ok, warn, danger, info, neutral }

class Insignia extends StatelessWidget {
  const Insignia(this.texto, {super.key, this.tono = Tono.neutral, this.punto = false});
  final String texto;
  final Tono tono;
  final bool punto;

  @override
  Widget build(BuildContext context) {
    final (fondo, color) = switch (tono) {
      Tono.ok => (TantaColors.stateOkBg, TantaColors.stateOk),
      Tono.warn => (TantaColors.stateWarnBg, TantaColors.stateWarn),
      Tono.danger => (TantaColors.stateDangerBg, TantaColors.stateDanger),
      Tono.info => (TantaColors.stateInfoBg, TantaColors.stateInfo),
      Tono.neutral => (TantaColors.cream200, TantaColors.textSecondary),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(color: fondo, borderRadius: BorderRadius.circular(999)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (punto) ...[
            Container(width: 5, height: 5, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
            const SizedBox(width: 5),
          ],
          Text(texto, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: color)),
        ],
      ),
    );
  }
}

class Kpi extends StatelessWidget {
  const Kpi({super.key, required this.etiqueta, required this.valor, this.nota, this.tono});
  final String etiqueta;
  final String valor;
  final String? nota;
  final Color? tono;

  @override
  Widget build(BuildContext context) {
    return Panel(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            etiqueta.toUpperCase(),
            style: const TextStyle(
              fontSize: 9.5,
              letterSpacing: 1.1,
              fontWeight: FontWeight.w700,
              color: TantaColors.textMuted,
            ),
          ),
          const SizedBox(height: 6),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              valor,
              style: TextStyle(
                fontFamily: 'Fraunces',
                fontSize: 24,
                fontWeight: FontWeight.w600,
                color: tono ?? TantaColors.ink800,
              ),
            ),
          ),
          if (nota != null) ...[
            const SizedBox(height: 4),
            Text(nota!, style: const TextStyle(fontSize: 11, color: TantaColors.textMuted)),
          ],
        ],
      ),
    );
  }
}

class TituloSeccion extends StatelessWidget {
  const TituloSeccion(this.titulo, {super.key, this.subtitulo});
  final String titulo;
  final String? subtitulo;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Vacío cuando la barra superior ya muestra el nombre de la pestaña: no se repite.
        if (titulo.isNotEmpty) Text(titulo, style: estiloDisplay.copyWith(fontSize: 20)),
        if (subtitulo != null)
          Padding(
            padding: EdgeInsets.only(top: titulo.isEmpty ? 0 : 2),
            child: Text(subtitulo!, style: const TextStyle(fontSize: 12.5, color: TantaColors.textMuted)),
          ),
      ],
    );
  }
}

/// Barra de progreso fina.
class Progreso extends StatelessWidget {
  const Progreso({super.key, required this.valor, this.color = TantaColors.ink700});
  final double valor;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(999),
      child: LinearProgressIndicator(
        value: valor.clamp(0, 1),
        minHeight: 6,
        backgroundColor: TantaColors.cream300,
        valueColor: AlwaysStoppedAnimation(color),
      ),
    );
  }
}

/// Foto de perfil o iniciales si no hay foto (o no carga sin red).
class Avatar extends StatelessWidget {
  const Avatar({super.key, required this.nombre, this.fotoUrl, this.radio = 18});
  final String nombre;
  final String? fotoUrl;
  final double radio;

  @override
  Widget build(BuildContext context) {
    final iniciales = nombre.split(' ').where((p) => p.isNotEmpty).take(2).map((p) => p[0].toUpperCase()).join();
    final fondo = CircleAvatar(
      radius: radio,
      backgroundColor: TantaColors.sand300,
      child: Text(iniciales, style: TextStyle(fontSize: radio * 0.7, fontWeight: FontWeight.w700, color: TantaColors.ink900)),
    );
    if (fotoUrl == null) return fondo;
    return ClipOval(
      child: Image.network(Api.instancia.urlArchivo(fotoUrl!), width: radio * 2, height: radio * 2, fit: BoxFit.cover,
          semanticLabel: nombre, errorBuilder: (_, __, ___) => fondo),
    );
  }
}
