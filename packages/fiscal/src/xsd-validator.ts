import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertEcfType } from './catalog.ts';
import type { EcfType } from './catalog.ts';
import type { DraftSchemaValidator } from './draft.ts';
import { normalizeSchemaForValidator, normalizeAuxiliarySchema } from './schema-compatibility.ts';

export const AUXILIARY_SCHEMAS = {
  ARECF: 'arecf.xsd',
  ACECF: 'acecf.xsd',
  ANECF: 'anecf.xsd',
  RFCE: 'rfce-32.xsd',
  SEMILLA: 'semilla.xsd',
} as const;
export type AuxiliaryKind = keyof typeof AUXILIARY_SCHEMAS;

export class SchemaValidationError extends Error {
  constructor() {
    // libxml diagnostics may contain fiscal/customer data. Never expose them in API errors/logs.
    super('XML does not satisfy the pinned DGII schema.');
    this.name = 'SchemaValidationError';
  }
}

export class SchemaUnavailableError extends Error {
  constructor(type: EcfType) {
    super(`Pinned DGII E${type} schema cannot be compiled; official schema review required.`);
    this.name = 'SchemaUnavailableError';
  }
}

/** Offline libxml2 adapter. xmllint must be installed in the isolated fiscal runtime. */
export class XmllintDraftValidator implements DraftSchemaValidator {
  async validateUnsignedEcf(type: EcfType, xml: string): Promise<void> {
    assertEcfType(type);
    return this.validatePinnedUnsigned(`ecf-${type}.xsd`, xml, type);
  }

  async validateUnsignedAuxiliary(kind: AuxiliaryKind, xml: string): Promise<void> {
    if (!Object.hasOwn(AUXILIARY_SCHEMAS, kind)) throw new Error('Unsupported auxiliary schema.');
    return this.validatePinnedUnsigned(AUXILIARY_SCHEMAS[kind], xml);
  }

  private async validatePinnedUnsigned(
    filename: string,
    xml: string,
    type?: EcfType,
  ): Promise<void> {
    if (
      typeof xml !== 'string' ||
      Buffer.byteLength(xml, 'utf8') > 2 * 1024 * 1024 ||
      /<!|<\?(?!xml\s)/i.test(xml)
    ) {
      throw new SchemaValidationError();
    }
    const schemaUrl = new URL(`../schemas/${filename}`, import.meta.url);
    const source = await readFile(schemaUrl, 'utf8');
    const manifest = JSON.parse(
      await readFile(new URL('../schemas/manifest.json', import.meta.url), 'utf8'),
    );
    const digest = createHash('sha256').update(source, 'utf8').digest('hex');
    if (manifest.files[filename]?.sha256 !== digest) {
      throw new Error('DGII schema integrity check failed.');
    }
    const compatibleSource = type
      ? normalizeSchemaForValidator(type, source)
      : normalizeAuxiliarySchema(filename, source);
    // Official schemas require one trailing xs:any for Signature. Only this local DRAFT
    // validation copy omits it; originals stay unchanged. No dummy signature is generated.
    const wildcard = /<xs:any\b[^>]*\/>/g;
    if (
      (source.match(wildcard) ?? []).length !== 1 ||
      /<xs:(?:import|include|redefine)\b/.test(source)
    ) {
      throw new Error('Unexpected schema structure: review the schema adapter.');
    }
    const working = await mkdtemp(join(tmpdir(), 'corestack-ecf-xsd-'));
    try {
      const schemaPath = join(working, 'unsigned.xsd');
      await writeFile(schemaPath, compatibleSource.replace(wildcard, ''), { mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        const process = spawn('xmllint', ['--nonet', '--noout', '--schema', schemaPath, '-'], {
          stdio: ['pipe', 'ignore', 'pipe'],
          env: { PATH: '/usr/local/bin:/usr/bin:/bin', XML_CATALOG_FILES: '' },
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          process.kill('SIGKILL');
        }, 10_000);
        process.stderr.resume();
        process.stdin.on('error', () => {
          /* close/error event determines result (e.g. EPIPE). */
        });
        process.once('error', () => {
          clearTimeout(timer);
          reject(new Error('XSD validator unavailable. Install xmllint in the fiscal runtime.'));
        });
        process.once('close', (code) => {
          clearTimeout(timer);
          if (timedOut) reject(new Error('XSD validation timed out.'));
          else if (code === 0) resolve();
          else if (code === 5)
            reject(
              type ? new SchemaUnavailableError(type) : new Error('Auxiliary schema unavailable.'),
            );
          else reject(new SchemaValidationError());
        });
        process.stdin.end(xml, 'utf8');
      });
    } finally {
      await rm(working, { recursive: true, force: true });
    }
  }
}
