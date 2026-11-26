# Ensayo desechable VM2 → VM4

No es un despliegue del ERP ni una certificación. No ejecuta el productor de Caja.

Prueba realizada el 2026-09-22: cliente HTTPS en VM2, túnel SSH con identidad del host verificada hacia la IP privada del contenedor VM4, registro autenticado, PostgreSQL desechable, worker/XSD real y consulta HTTPS de XML con hash. Mismo documento ante dos envíos simultáneos. Token incorrecto y e-NCF esperado incorrecto rechazados.

- Resultado: `PASS_DISTRIBUTED_SYNTHETIC`, documento `1`, e-NCF sintético `E310000000001`.
- SHA256 XML: `2fd94056dcdfc111c0db12b152e4c1f9b0189d0c2a4ce991dfa105b624554720`.
- Scope: `synthetic-distributed` / `101010641` / `precertification`, distinto del tenant de RIVNU.
- PostgreSQL usa tmpfs y red Docker interna sin puerto publicado. Autenticación trust **exclusiva de este fixture desechable**; esto no valida TLS de PostgreSQL entre VM4 y VM3. Esa conexión se prueba por separado.
- TLS de ensayo autofirmado, efímero, verificado mediante certificado explícito y SAN IP; no usa la CA ni las claves reales. Solo se copia el certificado público a VM2.
- Worker/servidor corren sin root, raíz de solo lectura, límites de recursos y sin salida a Internet por la red interna. No se montan secretos reales ni se conecta `fiscal-network`.

## Repetición

Copiar este paquete sin dependencias a un directorio nuevo `/home/luismel/fiscal-rehearsal.XXXXXX/fiscal` en VM4 y ejecutar `test/start-distributed-rehearsal.sh`. Requiere las imágenes existentes `postgres:17-alpine` y `corestack/fiscal-registration:dev-20260922`.

El script rechaza contenedores/red preexistentes. Devuelve la IP privada del contenedor: usarla en un túnel SSH desde VM2 con listener **127.0.0.1:14082** hacia esa IP:8443. No publicar un listener en 0.0.0.0. Las redes Docker internas pueden no publicar sus puertos en el host; por eso el túnel apunta a la IP del contenedor, no a un puerto publicado.

Copiar únicamente `rehearsal.crt` a VM2. Ejecutar `test/distributed-client.ts` en la imagen de tests, con fuentes/tests actuales montados, certificado en `/run/rehearsal.crt` y acceso al listener local del túnel. El cliente usa la solicitud sintética de ejemplo, nunca un documento real.

Al finalizar, cerrar el túnel y detener/eliminar **solo** los dos contenedores `corestack-disposable-fiscal-service` y `corestack-disposable-fiscal-db`, y su red `corestack-disposable-fiscal-net`. La base tmpfs se pierde; las fixtures permiten regenerarla. No ejecutar limpieza global de Docker.

## Límites pendientes

La consulta `readDispatchedInvoicePreparation` resuelve IDs desde la outbox por tenant/RNC/ambiente/factura y no reencola ante errores de lectura. El controlador ERP debe autorizar al actor antes de llamarla. Esta pieza todavía no está conectada a Caja ni desplegada en el API del preview. No firma ni transmite a DGII.
