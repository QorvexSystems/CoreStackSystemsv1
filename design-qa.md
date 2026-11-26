# Design QA · Hotel Ancla

- Source visual truth: imágenes de referencia adjuntas por el usuario en la conversación (panel, reservaciones y logotipo de Hotel Ancla); no están expuestas como archivos locales.
- Implementation: `http://localhost:3000` con el servidor Next.js activo.
- Intended viewport: escritorio 1440 × 800 CSS px, densidad 1.
- Source pixels: panel 1440 × 800; reservaciones 1440 × 800; logotipo 153 × 104.
- Implementation screenshot: no disponible.
- State: panel autenticado y cola de reservaciones.

**Full-view comparison evidence**

La implementación compila y el servidor local responde, pero el entorno de trabajo no ofrece navegador integrado ni captura visual. No se realizó una comparación visual lado a lado.

**Focused region comparison evidence**

Bloqueada por la misma ausencia de captura renderizada. Las regiones prioritarias para la siguiente pasada son: marca/sidebar, cabecera y búsqueda, tarjetas KPI, gráfico de rendimiento, tabla de reservaciones y panel de detalle.

**Findings**

- [P1] Falta evidencia renderizada para confirmar fidelidad visual.
  - Location: panel y reservaciones.
  - Evidence: las fuentes visuales están en la conversación, pero no existe captura del navegador local.
  - Impact: no se pueden validar con rigor escala tipográfica, ritmo, desbordamientos ni alineación a 1440 × 800.
  - Fix: abrir la aplicación en un navegador autorizado, capturar ambos estados y compararlos junto a las referencias.

**Required fidelity surfaces**

- Fonts and typography: implementadas con Segoe UI/Inter fallback; pendiente confirmación visual de peso, ajuste y saltos de línea.
- Spacing and layout rhythm: estructura responsiva implementada; pendiente inspección renderizada.
- Colors and visual tokens: grafito, blanco cálido y turquesa centralizados; pendiente muestreo visual.
- Image quality and asset fidelity: activo raster transparente de Hotel Ancla instalado; pendiente revisar legibilidad en sidebar oscuro y login.
- Copy and content: adaptados al dominio hotelero en español y RD$.

**Comparison history**

- Iteración 1: implementación compilada; captura y comparación bloqueadas por falta de navegador disponible.
- Iteración 2: logos de Directo/Web, WhatsApp, Booking.com, Expedia y Airbnb añadidos a la tabla, resumen, detalle y tarjetas de canales; TypeScript validado. La comparación visual continúa bloqueada por falta de navegador disponible.

**Implementation checklist**

- Capturar `/dashboard` a 1440 × 800.
- Capturar `/reservations` a 1440 × 800 con la primera reserva seleccionada.
- Confirmar legibilidad, color de marca y alineación de los cinco logos de canal en tabla y resumen lateral.
- Comparar ambas capturas con las referencias y corregir cualquier P0/P1/P2.
- Verificar búsqueda, filtros, selección de reserva, acciones y navegación.
- Revisar consola del navegador.

**Follow-up polish**

- Ajustar microespaciado y tamaño del logotipo después de la comparación visual.

final result: blocked
