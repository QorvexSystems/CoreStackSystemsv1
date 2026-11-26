export const VEHICLE_CATALOG = [
  ['Honda', 'CRV'], ['Toyota', 'Corolla'], ['Toyota', '4Runner'],
  ['Ford', 'Escape'], ['Ford', 'Focus'], ['Hyundai', 'Sonata'],
  ['Hyundai', 'Elantra'], ['Honda', 'Civic'], ['Honda', 'Fit'],
  ['Kia', 'Sportage'], ['Kia', 'Sorento'], ['Hyundai', 'Santa Fe'],
  ['Hyundai', 'Tucson'], ['Jeep', 'Cherokee'], ['Chevrolet', 'Tahoe'],
  ['Chevrolet', 'Colorado'], ['Nissan', 'Frontier'],
].map(([make, model]) => ({ make, model }));

export function searchVehicleCatalog(query: string) {
  const words = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().split(/\s+/);
  return VEHICLE_CATALOG.filter(({ make, model }) => words.every(word => `${make} ${model}`.toLowerCase().includes(word)));
}
