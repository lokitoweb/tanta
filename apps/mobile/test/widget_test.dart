import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tanta_app/ui/comunes.dart';

void main() {
  testWidgets('La marca muestra el nombre configurado (por defecto Tanta)', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: Center(child: Marca())),
      ),
    );

    expect(find.text('TANTA'), findsOneWidget);
  });
}
