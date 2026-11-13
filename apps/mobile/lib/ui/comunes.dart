import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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

  /// Sin logo subido: el nombre de la app (Configuración → Marca) como wordmark centrado.
  Widget _wordmark() {
    final color = invertida ? TantaColors.cream50 : TantaColors.ink800;
    final nombre = '${(Api.instancia.config['marca'] as Map?)?['nombreApp'] ?? 'Tanta'}'.toUpperCase();
    return Text(
      nombre,
      textAlign: TextAlign.center,
      style: TextStyle(fontFamily: 'Fraunces', fontSize: 34 * escala, fontWeight: FontWeight.w600,
          letterSpacing: 34 * escala * 0.2, color: color, height: 1.05),
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
        borderRadius: BorderRadius.circular(8),
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

/// Carga: paneles grises que laten mientras llegan los datos. Es una columna: dentro de un
/// RefreshIndicator va como hijo de un ListView para que siga funcionando tirar para recargar.
class Esqueleto extends StatefulWidget {
  const Esqueleto({super.key, this.filas = 5, this.alto = 64});
  final int filas;
  final double alto;

  @override
  State<Esqueleto> createState() => _EsqueletoState();
}

class _EsqueletoState extends State<Esqueleto> with SingleTickerProviderStateMixin {
  late final AnimationController _anim = AnimationController(vsync: this, duration: const Duration(milliseconds: 900), lowerBound: 0.45);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Con "reducir movimiento" activo los paneles quedan quietos.
    if (MediaQuery.disableAnimationsOf(context)) {
      _anim.value = 1;
    } else if (!_anim.isAnimating) {
      _anim.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _anim.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Cargando',
      child: FadeTransition(
        opacity: _anim,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            for (var i = 0; i < widget.filas; i++)
              Container(
                height: widget.alto,
                margin: const EdgeInsets.only(bottom: 10),
                decoration: BoxDecoration(color: TantaColors.cream300, borderRadius: BorderRadius.circular(8)),
              ),
          ]),
        ),
      ),
    );
  }
}

/// Error de carga con botón para volver a intentar.
class ErrorReintentar extends StatelessWidget {
  const ErrorReintentar({super.key, required this.mensaje, required this.onReintentar});
  final String mensaje;
  final VoidCallback onReintentar;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 24),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.cloud_off_outlined, size: 40, color: TantaColors.textMuted),
        const SizedBox(height: 12),
        Text(mensaje, textAlign: TextAlign.center, style: const TextStyle(color: TantaColors.textSecondary)),
        const SizedBox(height: 16),
        OutlinedButton.icon(onPressed: onReintentar, icon: const Icon(Icons.refresh), label: const Text('Reintentar')),
      ]),
    );
  }
}

/// Estado vacío: icono y texto centrados.
class VacioMensaje extends StatelessWidget {
  const VacioMensaje(this.texto, {super.key, this.icono = Icons.inbox_outlined});
  final String texto;
  final IconData icono;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 24),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(icono, size: 40, color: TantaColors.textMuted),
        const SizedBox(height: 12),
        Text(texto, textAlign: TextAlign.center, style: const TextStyle(color: TantaColors.textMuted)),
      ]),
    );
  }
}

/// Entrada suave (sube y aparece), escalonada por [orden]: da ritmo al abrir el panel sin distraer.
class Aparecer extends StatelessWidget {
  const Aparecer({super.key, required this.child, this.orden = 0});
  final Widget child;
  final int orden;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: Duration(milliseconds: 320 + 60 * orden.clamp(0, 6)),
      curve: Curves.easeOutCubic,
      builder: (_, t, hijo) => Opacity(opacity: t, child: Transform.translate(offset: Offset(0, 14 * (1 - t)), child: hijo)),
      child: child,
    );
  }
}

/// Se encoge un poco al tocar: respuesta táctil en tarjetas y accesos.
class Pulsable extends StatefulWidget {
  const Pulsable({super.key, required this.child, required this.onTap, this.radio = 8});
  final Widget child;
  final VoidCallback? onTap;
  final double radio;

  @override
  State<Pulsable> createState() => _PulsableState();
}

class _PulsableState extends State<Pulsable> {
  bool _abajo = false;
  void _set(bool v) { if (_abajo != v) setState(() => _abajo = v); }

  @override
  Widget build(BuildContext context) {
    return AnimatedScale(
      scale: _abajo ? 0.96 : 1,
      duration: const Duration(milliseconds: 120),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(widget.radio),
          onTap: widget.onTap,
          onHighlightChanged: _set,
          child: widget.child,
        ),
      ),
    );
  }
}

/// Pie de todo diálogo: la opción secundaria («Cancelar», «Volver») y la principal lado a lado,
/// mismo alto y ancho. Sin esto el tema (botones a todo el ancho) apilaba «Cancelar» angosto arriba.
class AccionesDialogo extends StatelessWidget {
  const AccionesDialogo({super.key, required this.secundaria, required this.principal});
  final Widget secundaria;
  final Widget principal;

  @override
  Widget build(BuildContext context) => Row(children: [
        Expanded(child: secundaria),
        const SizedBox(width: 12),
        Expanded(child: principal),
      ]);
}

/// Cantidad con − / + y un campo para escribirla (100 sin tocar «+» cien veces).
/// Solo enteros entre [minimo] y [maximo]; al tocar el campo se selecciona el número para reemplazarlo.
class SelectorCantidad extends StatefulWidget {
  const SelectorCantidad({super.key, required this.valor, required this.onCambio, this.minimo = 1, this.maximo = 10000, this.compacto = false});
  final int valor;
  final ValueChanged<int> onCambio;
  final int minimo;
  final int maximo;
  /// Versión angosta para filas de lista (carrito).
  final bool compacto;

  @override
  State<SelectorCantidad> createState() => _SelectorCantidadState();
}

class _SelectorCantidadState extends State<SelectorCantidad> {
  late final _c = TextEditingController(text: '${widget.valor}');
  final _foco = FocusNode();

  @override
  void initState() {
    super.initState();
    _foco.addListener(() {
      if (_foco.hasFocus) {
        _c.selection = TextSelection(baseOffset: 0, extentOffset: _c.text.length);
      } else {
        _fijar(int.tryParse(_c.text) ?? widget.minimo); // al salir del campo, un valor vacío o fuera de rango se corrige
      }
    });
  }

  @override
  void didUpdateWidget(SelectorCantidad old) {
    super.didUpdateWidget(old);
    // Cambió desde fuera (− / + u otra pantalla): se refleja, salvo mientras se escribe ese mismo número.
    if (int.tryParse(_c.text) != widget.valor) _c.text = '${widget.valor}';
  }

  @override
  void dispose() {
    _c.dispose();
    _foco.dispose();
    super.dispose();
  }

  void _fijar(int n) {
    final v = n.clamp(widget.minimo, widget.maximo);
    if (_c.text != '$v') _c.text = '$v';
    if (v != widget.valor) widget.onCambio(v);
  }

  @override
  Widget build(BuildContext context) {
    final ancho = widget.compacto ? 52.0 : 72.0;
    final boton = widget.compacto ? 40.0 : 48.0;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      SizedBox(width: boton, height: boton, child: IconButton.outlined(
          tooltip: 'Quitar uno', padding: EdgeInsets.zero,
          onPressed: widget.valor > widget.minimo ? () => _fijar(widget.valor - 1) : null, icon: const Icon(Icons.remove))),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8),
        child: SizedBox(width: ancho, child: Semantics(label: 'Cantidad', textField: true, child: TextField(
          controller: _c, focusNode: _foco,
          textAlign: TextAlign.center,
          keyboardType: TextInputType.number,
          textInputAction: TextInputAction.done,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter('${widget.maximo}'.length)],
          style: estiloDisplay.copyWith(fontSize: widget.compacto ? 16 : 20),
          decoration: const InputDecoration(isDense: true, contentPadding: EdgeInsets.symmetric(vertical: 10, horizontal: 4)),
          // Mientras escribe, el total se actualiza; el rango se corrige al terminar.
          onChanged: (t) { final n = int.tryParse(t); if (n != null && n >= widget.minimo && n <= widget.maximo) widget.onCambio(n); },
          onSubmitted: (t) => _fijar(int.tryParse(t) ?? widget.minimo),
        ))),
      ),
      SizedBox(width: boton, height: boton, child: IconButton.outlined(
          tooltip: 'Agregar uno', padding: EdgeInsets.zero,
          onPressed: widget.valor < widget.maximo ? () => _fijar(widget.valor + 1) : null, icon: const Icon(Icons.add))),
    ]);
  }
}
