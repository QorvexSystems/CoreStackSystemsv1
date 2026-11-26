# Certificación: herramienta interna independiente

La integración anterior del agente con RIVNU se retiró del código de API/web.
RIVNU es un cliente ya certificado, no la consola de operaciones de CoreStack.

El proyecto independiente está en `/home/luismel/corestack-certification`.
Su README documenta `corestack-certify`, los expedientes propios y el acceso
SSH de `luismel` y `fabio` en VM4. No utiliza usuarios, API, tenants o bases de
ningún ERP ni publica puertos. Las fases del portal y actos legales conservan
confirmación humana; el envío técnico exige autorización explícita.

`deploy/admin/retire-rivnu-certification-panel-20261105.sh` retira la versión
desplegada del panel utilizando la última versión anterior verificada, con
respaldo y rollback. Requiere sudo en VM2. Los antiguos scripts de activación
quedan deshabilitados para evitar reintroducirlo accidentalmente.

Se conserva la migración ya aplicada
`20261104170000_electronic_certification_orchestrator` y sus modelos como
historial inactivo. No se borran tablas ni se revierte el ledger de Prisma.
La retirada no modifica facturas, rangos, certificados o servicios fiscales.
