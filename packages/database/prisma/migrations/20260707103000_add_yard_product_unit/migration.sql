-- Add yard as a measurable product unit for fractional inventory and sales.
ALTER TYPE "ProductUnit" ADD VALUE IF NOT EXISTS 'YARD';
