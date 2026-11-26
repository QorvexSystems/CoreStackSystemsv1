import { element as e } from '../src/xml.ts';
import type { XmlElement } from '../src/xml.ts';
import type { EcfType, FiscalScope } from '../src/catalog.ts';
import { formatEncf } from '../src/encf.ts';

// Synthetic structural fixtures, NOT DGII certification cases or real transactions.
export const scope: FiscalScope = {
  tenantId: 'synthetic-rivnu',
  issuerRnc: '101010632',
  environment: 'certification',
};

export function fixture(type: EcfType): XmlElement[] {
  const id: XmlElement[] = [e('TipoeCF', String(type)), e('eNCF', formatEncf(type, '1'))];
  if (type !== 32 && type !== 34) id.push(e('FechaVencimientoSecuencia', '31-12-2027'));
  if (type === 34) id.push(e('IndicadorNotaCredito', '0'));
  if ([31, 32, 44, 45, 46].includes(type)) id.push(e('TipoIngresos', '01'));
  if (![41, 43, 47].includes(type)) id.push(e('TipoPago', '1'));
  const header: XmlElement[] = [
    e('Version', '1.0'),
    e('IdDoc', id),
    e('Emisor', [
      e('RNCEmisor', scope.issuerRnc),
      e('RazonSocialEmisor', 'EMISOR SINTETICO'),
      e('DireccionEmisor', 'Direccion de prueba'),
      e('FechaEmision', '20-09-2026'),
    ]),
  ];
  if ([31, 32, 41, 44, 45, 46].includes(type)) {
    header.push(
      e('Comprador', [
        ...([31, 41, 45].includes(type) ? [e('RNCComprador', '101010632')] : []),
        e('RazonSocialComprador', 'COMPRADOR SINTETICO'),
      ]),
    );
  }
  header.push(e('Totales', [e('MontoTotal', '100.00')]));
  const item: XmlElement[] = [
    e('NumeroLinea', '1'),
    e('IndicadorFacturacion', type === 46 ? '3' : '4'),
  ];
  if (type === 41 || type === 47) {
    item.push(
      e('Retencion', [
        e('IndicadorAgenteRetencionoPercepcion', '1'),
        ...(type === 47 ? [e('MontoISRRetenido', '27.00')] : []),
      ]),
    );
  }
  item.push(
    e('NombreItem', 'Producto & servicio <prueba>'),
    e('IndicadorBienoServicio', '1'),
    e('CantidadItem', '1.00'),
    e('PrecioUnitarioItem', '100.0000'),
    e('MontoItem', '100.00'),
  );
  const sections = [e('Encabezado', header), e('DetallesItems', [e('Item', item)])];
  if (type === 33 || type === 34)
    sections.push(
      e('InformacionReferencia', [
        e('NCFModificado', 'E310000000001'),
        e('FechaNCFModificado', '19-09-2026'),
        e('CodigoModificacion', '1'),
      ]),
    );
  sections.push(e('FechaHoraFirma', '20-09-2026 10:00:00'));
  return sections;
}

export function replaceField(
  nodes: readonly XmlElement[],
  name: string,
  value: string,
): XmlElement[] {
  return nodes.map((node) => ({
    name: node.name,
    value:
      node.name === name
        ? value
        : typeof node.value === 'string'
          ? node.value
          : replaceField(node.value, name, value),
  }));
}
