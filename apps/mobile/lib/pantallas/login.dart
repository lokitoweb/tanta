import 'package:flutter/material.dart';
import '../core/api.dart';
import '../core/tema.dart';
import '../core/tokens.dart';
import '../ui/comunes.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.onEntrar});
  final ValueChanged<Map<String, dynamic>> onEntrar;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  /// Solo en desarrollo: en producción el build se compila sin DEMO_LOGIN y el
  /// formulario arranca vacío, sin credenciales ni atajos dentro del binario.
  static const _esDemo = bool.fromEnvironment('DEMO_LOGIN');

  final _usuario = TextEditingController(text: _esDemo ? 'osquilcate' : '');
  final _clave = TextEditingController(text: _esDemo ? 'tanta' : '');
  bool _cargando = false;
  String? _error;
  bool _ver = false;

  static const _demo = [
    ('Gerente', 'osquilcate'),
    ('Administrador', 'lbermudez'),
    ('Producción', 'rquispe'),
    ('Almacén', 'jramos'),
    ('Vendedor', 'cmedina'),
    ('Cliente', 'mfernandez'),
  ];

  Future<void> _entrar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      await Api.instancia.login(_usuario.text.trim(), _clave.text);
      final datos = await Api.instancia.datos();
      if (!mounted) return;
      widget.onEntrar(datos);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: TantaColors.surfacePage,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, restricciones) {
            final ancho = restricciones.maxWidth;
            final dosColumnas = ancho > 900;
            final marca = Container(
              width: double.infinity,
              color: TantaColors.ink800,
              padding: const EdgeInsets.all(32),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Marca(escala: 1.25, invertida: true),
                  const SizedBox(height: 18),
                  Text(
                    'PAN DE MASA MADRE',
                    style: TextStyle(
                      fontSize: 10,
                      letterSpacing: 3,
                      fontWeight: FontWeight.w600,
                      color: TantaColors.sand300.withValues(alpha: 0.9),
                    ),
                  ),
                ],
              ),
            );

            final formulario = SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 32),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 420),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text('Bienvenido de nuevo', style: estiloDisplay.copyWith(fontSize: 30)),
                      const SizedBox(height: 6),
                      const Text('Ingresa con tu cuenta para continuar.',
                          style: TextStyle(color: TantaColors.textMuted)),
                      const SizedBox(height: 26),
                      _campo('Usuario', _usuario, autofocus: false),
                      const SizedBox(height: 14),
                      TextField(
                        controller: _clave,
                        obscureText: !_ver,
                        decoration: InputDecoration(
                          labelText: 'Contraseña',
                          suffixIcon: IconButton(
                            icon: Icon(_ver ? Icons.visibility_off : Icons.visibility,
                                color: TantaColors.textMuted, size: 20),
                            onPressed: () => setState(() => _ver = !_ver),
                          ),
                        ),
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: 14),
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: TantaColors.stateDangerBg,
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Row(children: [
                            const Icon(Icons.error_outline, size: 18, color: TantaColors.stateDanger),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(_error!,
                                  style: const TextStyle(fontSize: 13, color: TantaColors.stateDanger)),
                            ),
                          ]),
                        ),
                      ],
                      const SizedBox(height: 20),
                      FilledButton(
                        onPressed: _cargando ? null : _entrar,
                        child: _cargando
                            ? const SizedBox(
                                width: 20, height: 20,
                                child: CircularProgressIndicator(strokeWidth: 2, color: TantaColors.cream50))
                            : const Text('Entrar al sistema'),
                      ),
                      if (_esDemo) ...[
                        const SizedBox(height: 24),
                        const Text('ACCESO RÁPIDO DE DEMOSTRACIÓN',
                            style: TextStyle(
                                fontSize: 10, letterSpacing: 1.2, fontWeight: FontWeight.w700,
                                color: TantaColors.textMuted)),
                        const SizedBox(height: 10),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: _demo
                              .map((d) => ActionChip(
                                    label: Text(d.$1, style: const TextStyle(fontSize: 12)),
                                    backgroundColor: TantaColors.surfaceCard,
                                    side: const BorderSide(color: TantaColors.borderDefault),
                                    onPressed: () {
                                      setState(() {
                                        _usuario.text = d.$2;
                                        _clave.text = 'tanta';
                                        _error = null;
                                      });
                                    },
                                  ))
                              .toList(),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            );

            if (!dosColumnas) {
              return Column(
                children: [
                  SizedBox(height: 210, child: marca),
                  Expanded(child: formulario),
                ],
              );
            }
            return Row(
              children: [
                Expanded(flex: 5, child: marca),
                Expanded(flex: 6, child: formulario),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _campo(String etiqueta, TextEditingController c, {bool autofocus = true}) {
    return TextField(
      controller: c,
      autofocus: autofocus,
      autocorrect: false,
      textCapitalization: TextCapitalization.none,
      decoration: InputDecoration(labelText: etiqueta),
    );
  }
}
