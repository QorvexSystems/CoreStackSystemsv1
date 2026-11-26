import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  VEHICLE_MAP_VIEWS, VEHICLE_AREA_LABELS, VEHICLE_HOTSPOTS,
  VEHICLE_VIEW_ASSETS, LEGACY_VEHICLE_HOTSPOTS, LEGACY_VEHICLE_AREA_LABELS,
  preferredVehicleViews, preferredLegacyVehicleViews, isMechanicalArea,
} from '../components/operations/vehicle-damage-map-config.ts';

test('el mapa mecánico cubre motor, rodamientos y tablero sin sustituir IDs de carrocería', () => {
  for (const type of ['CAR', 'SUV']) {
    const ids = Object.values(VEHICLE_HOTSPOTS[type]).flat().map(spot => spot.areaId);
    for (const id of ['engine', 'transmission', 'wheel_bearings', 'dashboard', 'instrument_cluster', 'left_front_bearing', 'right_rear_bearing']) assert.ok(ids.includes(id), id);
    for (const id of ['hood', 'trunk', 'front_bumper', 'windshield']) assert.ok(!ids.includes(id), id);
    for (const { id } of VEHICLE_MAP_VIEWS) {
      const spots = VEHICLE_HOTSPOTS[type][id];
      assert.equal(new Set(spots.map(spot => spot.areaId)).size, spots.length);
      for (const spot of spots) {
        assert.ok(VEHICLE_AREA_LABELS[spot.areaId]);
        const shape = spot.shape;
        if (shape.kind === 'rect') {
          assert.ok(shape.x >= 0 && shape.y >= 0 && shape.width > 0 && shape.height > 0);
          assert.ok(shape.x + shape.width <= 100 && shape.y + shape.height <= 100);
        } else if (shape.kind === 'ellipse') {
          assert.ok(shape.cx - shape.rx >= 0 && shape.cy - shape.ry >= 0);
          assert.ok(shape.cx + shape.rx <= 100 && shape.cy + shape.ry <= 100);
        }
      }
      const svg = readFileSync(new URL(`../public${VEHICLE_VIEW_ASSETS[type][id]}`, import.meta.url), 'utf8');
      assert.ok(svg.includes('viewBox="0 0 100 100"'));
      assert.ok(svg.includes('preserveAspectRatio="none"'));
    }
  }
});

test('cotización impresa selecciona sistemas mecánicos y conserva diagramas anteriores', () => {
  assert.deepEqual(preferredVehicleViews('CAR', ['wheel_bearings', 'brake_discs']), ['left']);
  assert.deepEqual(preferredVehicleViews('SUV', ['dashboard', 'battery']), ['right']);
  assert.deepEqual(preferredVehicleViews('CAR', ['ignition_system', 'radiator']), ['front']);
  const views = preferredVehicleViews('CAR', ['wheel_bearings', 'dashboard']);
  assert.ok(views.includes('left') && views.includes('right'));
  assert.equal(isMechanicalArea('wheel_bearings'), true);
  assert.equal(isMechanicalArea('rear_glass'), false);
  assert.equal(LEGACY_VEHICLE_AREA_LABELS.rear_glass, 'Cristal trasero');
  const legacyView = preferredLegacyVehicleViews('SUV', ['rear_glass', 'trunk'])[0];
  assert.ok(LEGACY_VEHICLE_HOTSPOTS.SUV[legacyView].some(spot => spot.areaId === 'rear_glass'));
  assert.deepEqual(preferredVehicleViews('CAR', []), ['top']);
});

test('tablero y electricidad separados; testigos conservan IDs y vista imprimible', () => {
  assert.ok(VEHICLE_MAP_VIEWS.some(v => v.id === 'right' && v.label === 'Electricidad'));
  assert.ok(VEHICLE_MAP_VIEWS.some(v => v.id === 'dashboard' && v.label === 'Tablero'));
  const indicators = VEHICLE_HOTSPOTS.CAR.dashboard;
  assert.ok(indicators.length >= 50);
  for(const spot of indicators) {
    assert.ok(spot.areaId.startsWith('indicator_'));
    assert.ok(VEHICLE_AREA_LABELS[spot.areaId]);
    assert.equal(isMechanicalArea(spot.areaId), true);
  }
  assert.deepEqual(preferredVehicleViews('CAR', ['indicator_abs','indicator_tpms']), ['dashboard']);
  assert.deepEqual(preferredVehicleViews('CAR', ['battery']), ['right']);
  assert.ok(VEHICLE_HOTSPOTS.CAR.right.some(s=>s.areaId==='instrument_cluster'));
});
