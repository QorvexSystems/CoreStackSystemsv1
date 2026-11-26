# Representación impresa y capacidad QR

Revisión: 2026-10-06. Desarrollo offline; no habilita emisión fiscal ni sustituye las pruebas oficiales.

## Política vigente de capacidad

No se adoptaron las variantes experimentales uppercase, espacio `+` o importe mínimo. `TIMBRE_ENDPOINTS` y `RFCE_TIMBRE_ENDPOINTS` conocen explícitamente los tres ambientes; `buildTimbrePayload()` mantiene el bloqueo productivo. E31 contiene exactamente `RncEmisor`, `RncComprador`, `ENCF`, `FechaEmision`, `MontoTotal`, `FechaFirma`, `CodigoSeguridad`, con valores encoded una sola vez. Los lectores internos normalizan nombres al leer y detectan duplicados incluso mezclando casing.

El equipo comunicó el 2026-10-06 la respuesta recibida de DGII: usar versión 8 y, cuando el contenido ya no quepa, versión 9 según sea necesario. La política implementada intenta primero v8-L (1552 bits) y selecciona v9-L (1856 bits) únicamente si la URL exacta no cabe; no cambia parámetros, valores, casing, encoding, importe ni código de seguridad. No existe fallback a v10.

`planDgiiQr()` es la autoridad compartida por núcleo y web. Un exceso de v9 produce `DgiiQrCapacityError` (`DGII_QR_V9_CAPACITY_EXCEEDED`). La matriz renderizada se comprueba de forma independiente: 57 módulos incluyendo quiet zone para v8 y 61 para v9. Conviene archivar la respuesta original DGII junto al expediente de certificación; este documento registra el criterio comunicado, no sustituye esa evidencia.

El logger predeterminado emite un evento redacted cuando se selecciona v9 y otro si incluso v9 resulta insuficiente. Incluye tipo, ambiente, bits, capacidad, versión seleccionada cuando aplica y timestamp; nunca URL, RNC, e-NCF, código o firma. Una caída de telemetría no bloquea una RI válida ni permite una inválida.

La frontera `runFiscalPrint(prepareHtml, present)` espera la preparación completa antes de presentar HTML y devuelve `QR_CAPACITY_BLOCKED` solo si excede v9-L. El mensaje público no contiene stack ni evidencia fiscal. El botón actual de Caja continúa siendo de borrador sin firma.

Regresiones reales verifican 1551/1552 bits en v8, 1553 en v9, E31 de 1616 en v9 y extremo E31 de 1727 en v9. Todos se decodifican con ZXing recuperando exactamente la URL. Una carga sintética de 1860 bits se rechaza, demostrando que no hay escalado silencioso por encima de v9.

## Implementado

- `packages/fiscal/src/printed-representation.ts`: proyección del XML fuente validado por XSD, obligatoriamente vinculado al XML firmado por un verificador inyectado. Modelo congelado, importes originales, campos escalares preservados, identificación, detalle, referencias, retenciones, ajustes, moneda, totales y evidencia de firma.
- `preparePrintedHtml`: exige que el codificador QR tenga éxito; no entrega una RI pretendidamente completa sin QR.
- `packages/fiscal/src/qr-capacity.ts`: segmentación exacta compartida, planificación v8/v9 y rechazo después de v9. `apps/web/lib/qr-version8.ts` conserva un alias diagnóstico para medir específicamente v8.
- SVG autocontenido con namespace, imagen data URI y texto escapado. Sin recursos externos ni scripts. El renderizador es un componente interno: no debe exponerse aceptando modelos o SVG arbitrarios del cliente.

El verificador es una frontera de confianza obligatoria, no una comparación de hashes que por sí sola pruebe una firma. Debe verificar criptografía, autorización del firmante y correspondencia exacta con el XML fuente. El adaptador de `test/synthetic-signer.ts` solamente confía en su certificado efímero y fuentes del ensayo. No resuelve delegación ni revocación reales.

## Reproducción

```bash
bash packages/fiscal/test/printed-representation.sh
```

Utiliza las imágenes de pruebas existentes, crea un directorio temporal privado y deja allí `synthetic-ri-model.json` y `synthetic-ri.html`. Instala herramientas DOM/ZXing únicamente en el arnés temporal; no cambia dependencias de producción. La firma se comprueba criptográficamente para los diez tipos. El QR E32 renderizado se decodifica independientemente y debe recuperar exactamente la URL original. No se leen credenciales ni datos comerciales de RIVNU.

Muestra de esta ejecución: `/tmp/corestack-ri-test.z1oSKH/`, también con PDF y captura generados mediante Chromium en `corestack/fiscal-ri-test:local`, sin red. Artefactos temporales, regenerables; no son comprobantes fiscales. La suite opcional del borrador persistido no se ejecuta en este arnés aislado.

## Resolución del límite E31

La especificación consultada indica QR versión 8 para consulta de timbre: [Descripción técnica de servicios DGII, páginas 41 y 43](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Informe%20y%20Descripci%C3%B3n%20T%C3%A9cnica/Descripcion%20Tecnica%20Servicios%20DGII.pdf). La capacidad depende de versión, corrección y modo: [referencia Denso](https://www.qrcode.com/en/about/version.html).

El caso canónico conserva todos los parámetros y escapes de una URL de 214 caracteres. Requiere 1616 bits: excede v8-L pero cabe en v9-L. Se genera en v9 y la lectura independiente recupera exactamente la URL original. El extremo válido estudiado requiere 1727 bits y también cabe en v9-L.

No se cambiaron rutas/parámetros, escapes o campos y no se creó acortador. El único cambio es la versión física del símbolo cuando la capacidad calculada lo exige.

## Pendiente real

Archivar la respuesta original de DGII con fecha, canal y remitente; conectar el firmante autorizado al servicio/POS; revisar perfiles avanzados y paginación; ejecutar las pruebas oficiales de RI. La selección v8/v9 y la validez XSD no acreditan por sí solas aceptación DGII. El POS desplegado continúa imprimiendo únicamente el borrador sin firma.
