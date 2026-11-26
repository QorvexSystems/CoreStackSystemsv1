import { DASHBOARD_INDICATORS } from './dashboard-indicators.js';
import type { WorkshopVehicleType } from '@/lib/api';

export type LegacyVehicleMapView = 'front' | 'back' | 'left' | 'right' | 'top';
export type VehicleMapView = LegacyVehicleMapView | 'dashboard';

export type VehicleMapShape =
  | { kind: 'rect'; x: number; y: number; width: number; height: number; rx?: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'polygon'; points: string };

export type VehicleMapHotspot = {
  areaId: string;
  shape: VehicleMapShape;
};

export const LEGACY_VEHICLE_MAP_VIEWS: Array<{ id: LegacyVehicleMapView; label: string }> = [
  { id: 'front', label: 'Frente' },
  { id: 'back', label: 'Parte trasera' },
  { id: 'left', label: 'Lado izquierdo' },
  { id: 'right', label: 'Lado derecho' },
  { id: 'top', label: 'Vista superior' },
];

export const LEGACY_VEHICLE_AREA_LABELS: Record<string, string> = {
  front_bumper: 'Parachoques delantero',
  rear_bumper: 'Parachoques trasero',
  hood: 'Capó',
  trunk: 'Baúl / compuerta trasera',
  roof: 'Techo',
  windshield: 'Parabrisas',
  rear_glass: 'Cristal trasero',
  grille: 'Parrilla',
  engine: 'Motor',
  front_axle: 'Eje delantero',
  rear_axle: 'Eje trasero',
  left_headlight: 'Faro delantero izquierdo',
  right_headlight: 'Faro delantero derecho',
  left_taillight: 'Luz trasera izquierda',
  right_taillight: 'Luz trasera derecha',
  left_front_fender: 'Guardalodo delantero izquierdo',
  right_front_fender: 'Guardalodo delantero derecho',
  left_rear_fender: 'Guardalodo trasero izquierdo',
  right_rear_fender: 'Guardalodo trasero derecho',
  left_front_door: 'Puerta delantera izquierda',
  left_rear_door: 'Puerta trasera izquierda',
  right_front_door: 'Puerta delantera derecha',
  right_rear_door: 'Puerta trasera derecha',
  left_mirror: 'Retrovisor izquierdo',
  right_mirror: 'Retrovisor derecho',
  left_front_wheel: 'Rueda delantera izquierda',
  left_rear_wheel: 'Rueda trasera izquierda',
  right_front_wheel: 'Rueda delantera derecha',
  right_rear_wheel: 'Rueda trasera derecha',
  left_skirt: 'Estribo izquierdo',
  right_skirt: 'Estribo derecho',
};

const sedan: Record<LegacyVehicleMapView, VehicleMapHotspot[]> = {
  front: [
    { areaId: 'windshield', shape: { kind: 'polygon', points: '28,12 72,12 78,34 22,34' } },
    { areaId: 'hood', shape: { kind: 'polygon', points: '22,35 78,35 84,56 16,56' } },
    { areaId: 'engine', shape: { kind: 'rect', x: 36, y: 39, width: 28, height: 14, rx: 3 } },
    { areaId: 'left_headlight', shape: { kind: 'ellipse', cx: 24, cy: 59, rx: 11, ry: 6 } },
    { areaId: 'right_headlight', shape: { kind: 'ellipse', cx: 76, cy: 59, rx: 11, ry: 6 } },
    { areaId: 'grille', shape: { kind: 'rect', x: 34, y: 57, width: 32, height: 13, rx: 3 } },
    { areaId: 'front_bumper', shape: { kind: 'polygon', points: '12,68 88,68 82,83 18,83' } },
    { areaId: 'front_axle', shape: { kind: 'rect', x: 18, y: 80, width: 64, height: 8, rx: 3 } },
  ],
  back: [
    { areaId: 'rear_glass', shape: { kind: 'polygon', points: '28,13 72,13 77,35 23,35' } },
    { areaId: 'trunk', shape: { kind: 'polygon', points: '20,36 80,36 83,59 17,59' } },
    { areaId: 'left_taillight', shape: { kind: 'ellipse', cx: 22, cy: 59, rx: 11, ry: 6 } },
    { areaId: 'right_taillight', shape: { kind: 'ellipse', cx: 78, cy: 59, rx: 11, ry: 6 } },
    { areaId: 'rear_bumper', shape: { kind: 'polygon', points: '12,68 88,68 82,84 18,84' } },
    { areaId: 'rear_axle', shape: { kind: 'rect', x: 18, y: 80, width: 64, height: 8, rx: 3 } },
  ],
  left: [
    { areaId: 'hood', shape: { kind: 'polygon', points: '5,42 27,36 34,50 9,56' } },
    { areaId: 'windshield', shape: { kind: 'polygon', points: '31,25 45,22 48,43 35,44' } },
    { areaId: 'roof', shape: { kind: 'polygon', points: '43,20 67,20 76,39 48,39' } },
    { areaId: 'rear_glass', shape: { kind: 'polygon', points: '68,23 81,31 78,44 73,40' } },
    { areaId: 'left_front_fender', shape: { kind: 'polygon', points: '9,50 31,45 34,72 8,72' } },
    { areaId: 'left_front_door', shape: { kind: 'polygon', points: '35,44 52,42 53,72 34,72' } },
    { areaId: 'left_rear_door', shape: { kind: 'polygon', points: '53,42 74,42 78,72 54,72' } },
    { areaId: 'left_rear_fender', shape: { kind: 'polygon', points: '75,44 94,51 94,72 78,72' } },
    { areaId: 'left_mirror', shape: { kind: 'ellipse', cx: 33, cy: 42, rx: 4, ry: 3 } },
    { areaId: 'left_front_wheel', shape: { kind: 'ellipse', cx: 24, cy: 72, rx: 8, ry: 14 } },
    { areaId: 'left_rear_wheel', shape: { kind: 'ellipse', cx: 79, cy: 72, rx: 8, ry: 14 } },
    { areaId: 'left_skirt', shape: { kind: 'rect', x: 32, y: 72, width: 40, height: 7, rx: 2 } },
  ],
  right: [
    { areaId: 'hood', shape: { kind: 'polygon', points: '66,50 73,36 95,42 91,56' } },
    { areaId: 'windshield', shape: { kind: 'polygon', points: '52,43 55,22 69,25 65,44' } },
    { areaId: 'roof', shape: { kind: 'polygon', points: '24,39 33,20 57,20 52,39' } },
    { areaId: 'rear_glass', shape: { kind: 'polygon', points: '19,31 32,23 27,40 22,44' } },
    { areaId: 'right_front_fender', shape: { kind: 'polygon', points: '66,45 91,50 92,72 66,72' } },
    { areaId: 'right_front_door', shape: { kind: 'polygon', points: '48,42 65,44 66,72 47,72' } },
    { areaId: 'right_rear_door', shape: { kind: 'polygon', points: '26,42 47,42 46,72 22,72' } },
    { areaId: 'right_rear_fender', shape: { kind: 'polygon', points: '6,51 25,44 22,72 6,72' } },
    { areaId: 'right_mirror', shape: { kind: 'ellipse', cx: 67, cy: 42, rx: 4, ry: 3 } },
    { areaId: 'right_front_wheel', shape: { kind: 'ellipse', cx: 76, cy: 72, rx: 8, ry: 14 } },
    { areaId: 'right_rear_wheel', shape: { kind: 'ellipse', cx: 21, cy: 72, rx: 8, ry: 14 } },
    { areaId: 'right_skirt', shape: { kind: 'rect', x: 28, y: 72, width: 40, height: 7, rx: 2 } },
  ],
  top: [
    { areaId: 'front_bumper', shape: { kind: 'rect', x: 25, y: 3, width: 50, height: 7, rx: 3 } },
    { areaId: 'hood', shape: { kind: 'polygon', points: '27,10 73,10 69,30 31,30' } },
    { areaId: 'engine', shape: { kind: 'rect', x: 38, y: 14, width: 24, height: 12, rx: 3 } },
    { areaId: 'windshield', shape: { kind: 'polygon', points: '31,31 69,31 65,42 35,42' } },
    { areaId: 'roof', shape: { kind: 'rect', x: 34, y: 43, width: 32, height: 30, rx: 7 } },
    { areaId: 'rear_glass', shape: { kind: 'polygon', points: '35,74 65,74 69,84 31,84' } },
    { areaId: 'trunk', shape: { kind: 'polygon', points: '31,85 69,85 73,95 27,95' } },
    { areaId: 'rear_bumper', shape: { kind: 'rect', x: 25, y: 94, width: 50, height: 5, rx: 2 } },
  ],
};

const suv: Record<LegacyVehicleMapView, VehicleMapHotspot[]> = {
  front: sedan.front.map((hotspot) => ({
    ...hotspot,
    shape:
      hotspot.shape.kind === 'rect'
        ? {
            ...hotspot.shape,
            y: Math.max(4, hotspot.shape.y - 2),
            height: hotspot.shape.height + 2,
          }
        : hotspot.shape,
  })),
  back: sedan.back.map((hotspot) => ({
    ...hotspot,
    shape:
      hotspot.shape.kind === 'ellipse'
        ? { ...hotspot.shape, ry: hotspot.shape.ry + 1 }
        : hotspot.shape,
  })),
  left: sedan.left.map((hotspot) => ({
    ...hotspot,
    shape:
      hotspot.shape.kind === 'rect'
        ? { ...hotspot.shape, y: hotspot.shape.y - 2, height: hotspot.shape.height + 2 }
        : hotspot.shape,
  })),
  right: sedan.right.map((hotspot) => ({
    ...hotspot,
    shape:
      hotspot.shape.kind === 'rect'
        ? { ...hotspot.shape, y: hotspot.shape.y - 2, height: hotspot.shape.height + 2 }
        : hotspot.shape,
  })),
  top: sedan.top.map((hotspot) => ({
    ...hotspot,
    shape:
      hotspot.shape.kind === 'rect'
        ? { ...hotspot.shape, x: hotspot.shape.x - 2, width: hotspot.shape.width + 4 }
        : hotspot.shape,
  })),
};

export const LEGACY_VEHICLE_HOTSPOTS: Record<
  WorkshopVehicleType,
  Record<LegacyVehicleMapView, VehicleMapHotspot[]>
> = {
  CAR: sedan,
  SUV: suv,
};

export const LEGACY_VEHICLE_VIEW_ASSETS: Record<
  WorkshopVehicleType,
  Record<LegacyVehicleMapView, string>
> = {
  CAR: {
    front: '/assets/vehicles/sedan/front.png',
    back: '/assets/vehicles/sedan/back.png',
    left: '/assets/vehicles/sedan/left.png',
    right: '/assets/vehicles/sedan/right.png',
    top: '/assets/vehicles/sedan/top.png',
  },
  SUV: {
    front: '/assets/vehicles/suv/front.png',
    back: '/assets/vehicles/suv/back.png',
    left: '/assets/vehicles/suv/left.png',
    right: '/assets/vehicles/suv/right.png',
    top: '/assets/vehicles/suv/top.png',
  },
};

export const LEGACY_VEHICLE_VIEW_ASPECTS: Record<
  WorkshopVehicleType,
  Record<LegacyVehicleMapView, number>
> = {
  CAR: {
    front: 1536 / 1024,
    back: 1536 / 1024,
    left: 1944 / 809,
    right: 2172 / 724,
    top: 887 / 1774,
  },
  SUV: {
    front: 1448 / 1086,
    back: 1448 / 1086,
    left: 1944 / 809,
    right: 1847 / 852,
    top: 941 / 1672,
  },
};

export function preferredLegacyVehicleViews(
  vehicleType: WorkshopVehicleType,
  areaIds: string[],
  limit = 2,
) {
  const remaining = new Set(areaIds);
  const selected: LegacyVehicleMapView[] = [];
  while (remaining.size && selected.length < limit) {
    const candidate = LEGACY_VEHICLE_MAP_VIEWS.map(({ id }) => ({
      id,
      hits: LEGACY_VEHICLE_HOTSPOTS[vehicleType][id].filter((spot) => remaining.has(spot.areaId))
        .length,
    })).sort((a, b) => b.hits - a.hits)[0];
    if (!candidate || candidate.hits === 0) break;
    selected.push(candidate.id);
    LEGACY_VEHICLE_HOTSPOTS[vehicleType][candidate.id].forEach((spot) =>
      remaining.delete(spot.areaId),
    );
  }
  return selected.length ? selected : (['front'] as LegacyVehicleMapView[]);
}

// Keep the original diagrams and IDs for saved bodywork findings and quote snapshots.
// The persisted view codes stay compatible with existing reception/quotation records.
export const VEHICLE_MAP_VIEWS: Array<{ id: VehicleMapView; label: string }> = [
  { id: 'top', label: 'Mecánica general' },
  { id: 'front', label: 'Motor y refrigeración' },
  { id: 'back', label: 'Transmisión' },
  { id: 'left', label: 'Suspensión y frenos' },
  { id: 'right', label: 'Electricidad' },
  { id: 'dashboard', label: 'Tablero' },
];

export const VEHICLE_AREA_LABELS: Record<string, string> = {
  ...Object.fromEntries(DASHBOARD_INDICATORS.map(item => [item.id, item.label])),
  ...LEGACY_VEHICLE_AREA_LABELS,
  engine: 'Motor',
  transmission: 'Transmisión / caja de cambios',
  steering_system: 'Dirección / cremallera',
  front_axle: 'Eje delantero',
  rear_axle: 'Eje trasero',
  exhaust_system: 'Sistema de escape',
  fuel_system: 'Sistema de combustible',
  differential: 'Diferencial',
  left_front_bearing: 'Rodamiento delantero izquierdo',
  right_front_bearing: 'Rodamiento delantero derecho',
  left_rear_bearing: 'Rodamiento trasero izquierdo',
  right_rear_bearing: 'Rodamiento trasero derecho',
  ignition_system: 'Bobinas y bujías',
  radiator: 'Radiador y ventiladores',
  cooling_system: 'Bomba de agua y refrigeración',
  alternator: 'Alternador',
  starter_motor: 'Motor de arranque',
  intake_system: 'Admisión / cuerpo de aceleración',
  timing_system: 'Correa / cadena de distribución',
  engine_mounts: 'Soportes del motor',
  clutch: 'Embrague / volante de motor',
  torque_converter: 'Convertidor de par',
  driveshaft: 'Eje cardán',
  cv_joints: 'Semiejes / juntas homocinéticas',
  shock_absorbers: 'Amortiguadores y resortes',
  control_arms: 'Brazos de suspensión',
  ball_joints: 'Rótulas y terminales',
  wheel_bearings: 'Rodamientos y cubos de rueda',
  brake_discs: 'Discos de freno',
  brake_calipers: 'Calipers / pinzas de freno',
  brake_pads: 'Pastillas de freno',
  abs_system: 'Sensores ABS',
  dashboard: 'Tablero / mandos',
  instrument_cluster: 'Panel de instrumentos / testigos',
  steering_wheel: 'Volante / columna de dirección',
  air_conditioning: 'Aire acondicionado / climatización',
  airbags: 'Airbags / sistema SRS',
  electrical_system: 'Cableado / fusibles',
  battery: 'Batería y carga',
  ecu: 'Computadora / ECU',
};

const rect = (
  areaId: string,
  x: number,
  y: number,
  width: number,
  height: number,
): VehicleMapHotspot => ({
  areaId,
  shape: { kind: 'rect', x, y, width, height, rx: 3 },
});
const circle = (
  areaId: string,
  cx: number,
  cy: number,
  rx: number,
  ry = rx,
): VehicleMapHotspot => ({
  areaId,
  shape: { kind: 'ellipse', cx, cy, rx, ry },
});

const mechanical: Record<VehicleMapView, VehicleMapHotspot[]> = {
  dashboard: DASHBOARD_INDICATORS.map((item, index) => rect(item.id, (index % 6) * 16 + 1, Math.floor(index / 6) * 10 + 1, 14, 8)),
  top: [
    rect('engine', 32, 9, 36, 15),
    rect('transmission', 39, 29, 22, 13),
    rect('steering_system', 23, 46, 54, 8),
    rect('front_axle', 26, 24, 48, 5),
    rect('rear_axle', 26, 77, 48, 5),
    rect('exhaust_system', 64, 55, 13, 19),
    rect('fuel_system', 30, 63, 28, 11),
    rect('differential', 40, 83, 20, 9),
    circle('left_front_bearing', 15, 27, 9, 6),
    circle('right_front_bearing', 85, 27, 9, 6),
    circle('left_rear_bearing', 15, 80, 9, 6),
    circle('right_rear_bearing', 85, 80, 9, 6),
  ],
  front: [
    rect('engine', 30, 36, 41, 26),
    rect('ignition_system', 32, 17, 40, 15),
    rect('radiator', 19, 80, 62, 15),
    rect('cooling_system', 76, 35, 18, 27),
    rect('alternator', 6, 40, 19, 23),
    rect('starter_motor', 8, 68, 20, 15),
    rect('intake_system', 77, 9, 19, 22),
    rect('timing_system', 36, 66, 36, 11),
    rect('engine_mounts', 6, 15, 20, 19),
  ],
  back: [
    rect('transmission', 28, 10, 46, 32),
    circle('clutch', 17, 57, 13, 17),
    circle('torque_converter', 45, 59, 12, 16),
    rect('driveshaft', 7, 82, 48, 12),
    rect('differential', 69, 68, 26, 26),
    rect('cv_joints', 64, 47, 31, 13),
  ],
  left: [
    rect('shock_absorbers', 5, 5, 22, 45),
    rect('control_arms', 4, 69, 32, 24),
    circle('ball_joints', 17, 59, 10, 10),
    circle('wheel_bearings', 49, 76, 14, 17),
    circle('brake_discs', 51, 32, 20, 26),
    rect('brake_calipers', 76, 13, 19, 26),
    rect('brake_pads', 76, 45, 19, 19),
    rect('abs_system', 72, 73, 23, 19),
  ],
  right: [
    rect('instrument_cluster', 7, 9, 33, 22),
    rect('dashboard', 44, 7, 27, 17),
    circle('steering_wheel', 24, 51, 18, 20),
    rect('air_conditioning', 45, 30, 26, 30),
    rect('airbags', 76, 9, 19, 28),
    rect('electrical_system', 6, 76, 34, 19),
    rect('battery', 46, 72, 24, 23),
    rect('ecu', 77, 66, 19, 28),
  ],
};

// Generic technical diagrams: components apply to both cars and SUVs, independently of body style.
export const VEHICLE_HOTSPOTS: Record<
  WorkshopVehicleType,
  Record<VehicleMapView, VehicleMapHotspot[]>
> = {
  CAR: mechanical,
  SUV: mechanical,
};
const technicalAssets: Record<VehicleMapView, string> = {
  dashboard: '/assets/vehicles/mechanical/indicators.svg',
  top: '/assets/vehicles/mechanical/overview.svg',
  front: '/assets/vehicles/mechanical/engine.svg',
  back: '/assets/vehicles/mechanical/transmission.svg',
  left: '/assets/vehicles/mechanical/suspension.svg',
  right: '/assets/vehicles/mechanical/electrical.svg',
};
export const VEHICLE_VIEW_ASSETS = { CAR: technicalAssets, SUV: technicalAssets };
const technicalAspects: Record<VehicleMapView, number> = {
  dashboard: 1,
  top: 480 / 720,
  front: 640 / 480,
  back: 640 / 480,
  left: 640 / 480,
  right: 640 / 480,
};
export const VEHICLE_VIEW_ASPECTS = { CAR: technicalAspects, SUV: technicalAspects };

export function isMechanicalArea(areaId: string) {
  return Object.values(mechanical).some((hotspots) =>
    hotspots.some((spot) => spot.areaId === areaId),
  );
}

export function preferredVehicleViews(
  vehicleType: WorkshopVehicleType,
  areaIds: string[],
  limit = 2,
) {
  const remaining = new Set(areaIds);
  const selected: VehicleMapView[] = [];
  while (remaining.size && selected.length < limit) {
    const candidate = VEHICLE_MAP_VIEWS.map(({ id }) => ({
      id,
      hits: VEHICLE_HOTSPOTS[vehicleType][id].filter((spot) => remaining.has(spot.areaId)).length,
    })).sort((a, b) => b.hits - a.hits)[0];
    if (!candidate || candidate.hits === 0) break;
    selected.push(candidate.id);
    VEHICLE_HOTSPOTS[vehicleType][candidate.id].forEach((spot) => remaining.delete(spot.areaId));
  }
  return selected.length ? selected : (['top'] as VehicleMapView[]);
}
