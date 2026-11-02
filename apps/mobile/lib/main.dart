import 'package:flutter/material.dart';
import 'core/api.dart';
import 'core/tema.dart';
import 'core/tokens.dart';
import 'pantallas/inicio.dart';
import 'pantallas/login.dart';
import 'ui/comunes.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Api.instancia.cargarSesion();
  runApp(const TantaApp());
}

class TantaApp extends StatelessWidget {
  const TantaApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Tanta',
      debugShowCheckedModeBanner: false,
      theme: construirTema(),
      home: const Raiz(),
    );
  }
}

/// Decide qué mostrar: carga, login o la aplicación con sesión.
class Raiz extends StatefulWidget {
  const Raiz({super.key});

  @override
  State<Raiz> createState() => _RaizState();
}

class _RaizState extends State<Raiz> {
  Map<String, dynamic>? _datos;
  bool _cargando = true;

  @override
  void initState() {
    super.initState();
    _arrancar();
  }

  Future<void> _arrancar() async {
    // Atajo de demostración: solo existe si se compila con DEMO_AUTOLOGIN=true.
    // No salta la autenticación: envía credenciales reales al servidor.
    const autologin = bool.fromEnvironment('DEMO_AUTOLOGIN');
    if (autologin && !Api.instancia.autenticado) {
      try {
        await Api.instancia.login(
          const String.fromEnvironment('DEMO_USER', defaultValue: 'osquilcate'),
          const String.fromEnvironment('DEMO_PASS', defaultValue: 'tanta'),
        );
      } catch (_) {}
    }
    if (Api.instancia.autenticado) {
      try {
        await Api.instancia.yo();
        final datos = await Api.instancia.datos();
        if (mounted) setState(() => _datos = datos);
      } catch (_) {
        await Api.instancia.cerrarSesion();
      }
    }
    if (mounted) setState(() => _cargando = false);
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) {
      return const Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Marca(escala: 1.1),
              SizedBox(height: 22),
              SizedBox(
                width: 26,
                height: 26,
                child: CircularProgressIndicator(strokeWidth: 2, color: TantaColors.sand500),
              ),
            ],
          ),
        ),
      );
    }

    if (_datos == null) {
      return LoginScreen(onEntrar: (datos) => setState(() => _datos = datos));
    }

    return Inicio(
      datos: _datos!,
      onSalir: () async {
        await Api.instancia.cerrarSesion();
        if (mounted) setState(() => _datos = null);
      },
    );
  }
}
