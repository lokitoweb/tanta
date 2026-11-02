import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tanta_app/ui/comunes.dart';

void main() {
  testWidgets('La marca muestra el wordmark y el descriptor', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: Center(child: Marca())),
      ),
    );

    expect(find.text('TANTA'), findsOneWidget);
    expect(find.text('PAN DE CASA'), findsOneWidget);
  });
}
