import 'package:flutter/material.dart';
import 'tokens.dart';

/// Tema de Tanta: los colores vienen de packages/tokens, la misma fuente que la web.
ThemeData construirTema() {
  const base = ColorScheme.light(
    primary: TantaColors.ink800,
    onPrimary: TantaColors.cream50,
    secondary: TantaColors.honey500,
    onSecondary: TantaColors.cream50,
    surface: TantaColors.surfaceCard,
    onSurface: TantaColors.textPrimary,
    error: TantaColors.stateDanger,
    onError: Colors.white,
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: base,
    scaffoldBackgroundColor: TantaColors.surfacePage,
    fontFamily: 'Inter',
    appBarTheme: const AppBarTheme(
      backgroundColor: TantaColors.surfacePage,
      foregroundColor: TantaColors.ink800,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(
        fontFamily: 'Fraunces',
        fontSize: 22,
        fontWeight: FontWeight.w600,
        color: TantaColors.ink900,
      ),
    ),
    cardTheme: CardThemeData(
      color: TantaColors.surfaceCard,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: TantaColors.borderSubtle),
      ),
      margin: EdgeInsets.zero,
    ),
    // Misma curvatura que botones y campos (12): sobria, no "burbuja".
    dialogTheme: DialogThemeData(
      backgroundColor: TantaColors.surfaceCard,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: TantaColors.surfaceCard,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: TantaColors.borderDefault),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: TantaColors.borderDefault),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: TantaColors.sand500, width: 1.6),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: TantaColors.ink800,
        foregroundColor: TantaColors.cream50,
        minimumSize: const Size.fromHeight(52),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: TantaColors.surfaceRaised,
      indicatorColor: TantaColors.cream300,
      labelTextStyle: WidgetStateProperty.resolveWith(
        (estados) => TextStyle(
          fontSize: 11,
          fontWeight: estados.contains(WidgetState.selected) ? FontWeight.w700 : FontWeight.w500,
          color: estados.contains(WidgetState.selected) ? TantaColors.ink800 : TantaColors.textMuted,
        ),
      ),
    ),
    dividerTheme: const DividerThemeData(color: TantaColors.borderSubtle, thickness: 1, space: 1),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: TantaColors.ink900,
      contentTextStyle: const TextStyle(fontFamily: 'Inter', color: TantaColors.cream50, fontSize: 13.5, height: 1.35),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      insetPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      elevation: 6,
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: TantaColors.surfaceCard,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ),
  );
}

/// Estilo de los títulos editoriales (serif, como el wordmark de la tarjeta).
const estiloDisplay = TextStyle(
  fontFamily: 'Fraunces',
  fontWeight: FontWeight.w600,
  color: TantaColors.ink900,
  letterSpacing: -0.4,
);
