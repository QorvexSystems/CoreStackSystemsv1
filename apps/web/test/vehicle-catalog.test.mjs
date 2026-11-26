import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VEHICLE_CATALOG, searchVehicleCatalog } from '../lib/vehicle-catalog.ts';

test('catálogo de 17 combinaciones permite búsqueda por marca y modelo', () => {
  assert.equal(VEHICLE_CATALOG.length, 17);
  assert.deepEqual(searchVehicleCatalog('  TOYOTA   4runner '), [{make:'Toyota', model:'4Runner'}]);
  assert.deepEqual(searchVehicleCatalog('santa fe'), [{make:'Hyundai',model:'Santa Fe'}]);
  assert.equal(searchVehicleCatalog('honda').length, 3);
  assert.equal(searchVehicleCatalog('inexistente').length, 0);
  assert.equal(new Set(VEHICLE_CATALOG.map(v=>`${v.make} ${v.model}`)).size,17);
});
