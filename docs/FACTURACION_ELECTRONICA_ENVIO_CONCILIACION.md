# Envío y conciliación: implementación de pruebas

Actualización 2026-09-24. Cola 004 instalada únicamente en la base sintética de VM4, sin transmisión activada; no instalada en la base fiscal real de VM3. El productor ERP de borradores ya usa su propia outbox en preview. El tramo de firma/transmisión descrito aquí aún no está desplegado en ese recorrido ni transmite comprobantes reales.

## Ensayo integrado de firma y transmisión — aprobado

`prepareVerifiedDelivery` une preparación persistida → servicio de firma inyectado → verificación del conjunto ECF/RFCE → cola durable. No acepta un canal suministrado por el navegador ni activa scopes pausados. Producción y fuentes no listas permanecen bloqueadas.

```bash
bash packages/fiscal/test/signed-delivery-integration.sh
```

Requiere las imágenes locales `postgres:17-alpine` y `corestack/fiscal-signing-test:local`. Crea DB y claves efímeras, sin puertos publicados ni salida a Internet. Firma y verifica con XMLSec, autentica una semilla en el simulador mediante el cliente DGII y procesa seis documentos con el gateway/worker/SQL reales: aceptación, rechazo, respuesta perdida y caída posterior al POST para E31; aceptación y respuesta perdida para E32/RFCE. Comprueba cero POST duplicados y conservación de artefactos. Se destruye únicamente el contenedor de ensayo y sus datos efímeros al terminar.

`test/synthetic-signer.ts` fija confianza únicamente al emisor sintético y a documentos generados en el proceso. Vincula el resumen al E32 completo y su firma. No es un verificador de XML ajeno ni de autorizaciones, cadena fiscal o revocación. No importarlo en servicios desplegados. El simulador opera en memoria; el cliente HTTPS real no se invoca.

## Recorrido implementado

1. `enqueueVerifiedDelivery` lee el XML preparado e inmutable, determina el canal desde tipo/total y exige un verificador de ambos documentos y su correspondencia. No hay verificador criptográfico permisivo por defecto.
2. `enqueue_delivery` guarda el XML de salida, su hash, el hash fuente, la huella declarada del certificado y el e-CF completo firmado. RFCE no sustituye la conservación del E32 completo. Un segundo intento con contenido distinto falla.
3. `claim_delivery` bloquea una tarea mediante lease de 120 segundos y token de exclusión. Primer intento: SEND. Recuperación posterior: RECONCILE, incluso si no quedó trackId.
4. `runDeliveryOnce` ejecuta el adaptador DGII y registra el resultado de forma condicionada al token vigente. Si falla la escritura posterior al envío, propaga el fallo; no repite el POST en ese proceso.
5. ECF: acuse con trackId significa PROCESSING. Se consulta el resultado con identidad de RNC/e-NCF/trackId. RFCE: respuesta inmediata vinculada a la solicitud autenticada; posteriores consultas validan RNC/e-NCF y usan el código de seguridad del E32 original.

Estados: READY → SENDING → POLLING/RECONCILE → ACCEPTED, ACCEPTED_CONDITIONALLY, REJECTED o REVIEW_REQUIRED. Un resultado no encontrado queda pendiente de conciliación; no libera ni recicla secuencias. Veinte reclamaciones sin resolver terminan en revisión. Esperas progresivas acotadas, sin bucle de reenvío de XML.

El cliente implementa consulta de trackIds para precertificación. Cero resultados mantiene incertidumbre; varios resultados requieren revisión. En certificación, el manual revisado no publica ese servicio: un acuse perdido sin trackId requiere revisión en vez de inventar una URL. [Servicios DGII, Consulta de trackId](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Informe%20y%20Descripci%C3%B3n%20T%C3%A9cnica/Descripcion%20Tecnica%20Servicios%20DGII.pdf).

## Seguridad y operación

- Identidad de base desde `session_user`, vinculada por tenant/RNC/ambiente. Ningún parámetro de usuario permite cambiar el ámbito.
- Sin permisos nuevos automáticos. Separar el acceso a encolado del acceso a claim/complete/health al provisionar los roles definitivos. La base garantiza integridad/aislamiento; NO valida XMLDSig por sí sola.
- Control de pausa por ámbito, administrado por propietario. Ausencia de configuración significa pausado. La pausa impide nuevas reclamaciones, no revoca un POST ya en vuelo.
- XML de salida, original firmado y eventos append-only. Ninguna excepción arbitraria, contraseña o token remoto se guarda como diagnóstico.
- `delivery_health` expone contadores, pausa y antigüedad de pendientes, sin XML ni datos de clientes. Falta conectar su alerta a un sistema operativo de monitoreo.
- Este mecanismo de pausa/recuperación **no constituye la política fiscal de contingencia completa** ni autoriza reemplazar e-CF por B01/B02. Esa política y su integración siguen pendientes.

## Pruebas reproducibles

`bash packages/fiscal/test/postgres.sh` crea PostgreSQL desechable, sin puertos ni volumen persistente, aplica las cuatro migraciones y comprueba restricciones, repetición idempotente, lease perdido, cruce de tenant, recuperación, estado terminal y evidencia inmutable. Después hace `pg_dump` y restauración completa en otra base desechable, verificando hashes, triggers y permisos. Se elimina exclusivamente el contenedor sintético al terminar.

Pruebas Node adicionales: `delivery-worker.test.ts`, `delivery-gateway.test.ts`, `delivery-enqueue.test.ts`, consultas de trackId en `dgii-client.test.ts`. Los verificadores de esas pruebas son mocks explícitos; sus XML no tienen firmas válidas y no salen a DGII.

Ensayo criptográfico separado: `test/signature-integration.ts`, imagen `Dockerfile.signing-test`. Genera dos certificados sintéticos efímeros en tmpfs, firma y verifica con XMLSec los diez tipos e-CF y los cinco auxiliares (incluido E32 completo → código de firma → RFCE). Rechaza alteraciones de importes, certificado incorrecto y referencia a archivo externo. Contenedor sin red; claves borradas al finalizar y nunca mostradas. RSA-SHA256, digest SHA256 y referencia vacía, según el [instructivo de firmado DGII](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Instructivos%20sobre%20Facturaci%C3%B3n%20Electr%C3%B3nica/Firmado%20de%20e-CF.pdf).

Incidencia corregida: XMLSec 1.2.37 anuncia `--enabled-retrieval-uris` en la ayuda pero esta compilación rechaza la opción. El ensayo usa referencias exclusivamente vacías, lista permitida de datos de clave X.509 y rechazo previo de DTD/RetrievalMethod. Esto NO es un verificador productivo de documentos arbitrarios, delegaciones o revocación; no se ha instalado el firmante en VM4.

## Timbre / QR

`timbre.ts` construye el contenido de la URL de consulta para precertificación/certificación, con canal y umbral exactos, fechas dominicanas y escape de `+`, `/` y espacios. Devuelve la versión QR prevista: 8. No renderiza el símbolo ni sustituye la representación impresa completa; debe consumir evidencia persistida de firma verificada, no datos editables del catálogo.

## Siguiente integración necesaria

Implementar el firmante/verificador real usando certificados sintéticos aislados para su ensayo; provisionar roles de firma/transmisión, desplegar el worker y unirlo al productor ERP transaccional. Después ejecutar el recorrido completo y la recuperación desde copia restaurada con servicios externos simulados. Ninguna de estas pruebas locales demuestra aprobación oficial DGII.
