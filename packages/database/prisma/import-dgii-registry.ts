// Importa el padrón oficial de la DGII (DGII_RNC.TXT, dentro de DGII_RNC.zip) a la tabla DgiiTaxpayer.
// Descarga: https://dgii.gov.do/app/WebApps/Consultas/RNC/DGII_RNC.zip (se actualiza a diario).
//
//   DGII_RNC_FILE=/ruta/DGII_RNC.TXT pnpm --filter @qorvex/database dgii:import
//
// Formato (según el archivo oficial): ISO-8859-1, separado por `|`, 11 columnas por registro:
//   0 RNC (9 dígitos) o cédula (11) · 1 nombre o razón social · 2 nombre comercial · 9 estado (ACTIVO…)
// Algunos registros traen saltos de línea dentro de un campo: una línea que NO empieza con 9/11 dígitos y
// `|` continúa el registro anterior. Se reemplaza la tabla completa: la búsqueda queda vacía unos minutos.
import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DocumentType, PrismaClient } from '../generated/client';

const prisma = new PrismaClient();
const BATCH = 5_000;
const RECORD_START = /^(?:\d{9}|\d{11})\|/;

type Row = {
  documentNumber: string;
  documentType: DocumentType;
  name: string;
  commercialName: string | null;
  status: string;
};

const clean = (value: string | undefined, max: number) =>
  (value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function parse(raw: string): Row | null {
  const columns = raw.split('|');
  if (columns.length !== 11) return null;
  const documentNumber = columns[0].trim();
  const name = clean(columns[1], 200);
  const status = clean(columns[9], 40);
  if (!/^(?:\d{9}|\d{11})$/.test(documentNumber) || !name || !status) return null;
  return {
    documentNumber,
    documentType: documentNumber.length === 9 ? DocumentType.RNC : DocumentType.CEDULA,
    name,
    commercialName: clean(columns[2], 200) || null,
    status,
  };
}

async function main() {
  const file = process.env.DGII_RNC_FILE;
  if (!file) throw new Error('Define DGII_RNC_FILE con la ruta de DGII_RNC.TXT.');
  const size = statSync(file).size;
  if (size < 30_000_000) throw new Error('El archivo es demasiado pequeño: ¿está truncado?');

  const started = Date.now();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "DgiiTaxpayer"');
  const lines = createInterface({ input: createReadStream(file, { encoding: 'latin1' }), crlfDelay: Infinity });

  let batch: Row[] = [];
  let current: string | null = null;
  let inserted = 0;
  let invalid = 0;
  const flush = async () => {
    if (!batch.length) return;
    const result = await prisma.dgiiTaxpayer.createMany({ data: batch, skipDuplicates: true });
    inserted += result.count;
    batch = [];
    if (inserted % 100_000 < BATCH)
      console.log(`  ${inserted.toLocaleString('es-DO')} registros… (${Math.round((Date.now() - started) / 1000)} s)`);
  };
  const push = async (raw: string | null) => {
    if (raw === null) return;
    const row = parse(raw);
    if (!row) {
      invalid += 1;
      return;
    }
    batch.push(row);
    if (batch.length >= BATCH) await flush();
  };

  for await (const line of lines) {
    if (RECORD_START.test(line)) {
      await push(current);
      current = line;
    } else if (current !== null) {
      current += ` ${line}`;
      if (current.length > 16_384) throw new Error('Registro demasiado largo: formato inesperado.');
    } else if (line.trim()) invalid += 1;
  }
  await push(current);
  await flush();

  if (inserted < 500_000) throw new Error(`Solo se importaron ${inserted} registros: el archivo parece incompleto.`);
  console.log(
    `Padrón DGII importado: ${inserted.toLocaleString('es-DO')} registros, ${invalid} inválidos, ` +
      `${Math.round((Date.now() - started) / 1000)} s.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
