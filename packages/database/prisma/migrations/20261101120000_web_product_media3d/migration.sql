-- Aditiva: referencia estructurada a modelos 3D (Sketchfab; GLB propio en el futuro). Nulo en todos los productos actuales.
ALTER TABLE "WebProduct" ADD COLUMN "media3d" JSONB;
