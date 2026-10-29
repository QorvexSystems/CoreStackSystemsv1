-- Pedidos solicitados desde el e-commerce propio (distinto de Shopify). Cambio aditivo: no toca datos existentes.
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'ECOMMERCE';
