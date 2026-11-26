import { createHash } from 'node:crypto';
import type { EcfType } from './catalog.ts';

// Compatibility adjustment E31-TYPE-NAME-SPACE-001, scoped to the reviewed local
// artifact only. Keep the vendored XSD/manifest unchanged; see README.md.
const E31_REVIEWED_SHA256 = '7c930fe6bd53c4c885cc5b3a8fef2afeca8bc1200c5598b9b0653eee10dcd17a';
const E31_ORIGINAL_DECLARATION = '<xs:simpleType name=" IndicadorServicioTodoIncluidoType">';
const E31_NORMALIZED_DECLARATION = '<xs:simpleType name="IndicadorServicioTodoIncluidoType">';

/** Only normalizes a reviewed schema copy, never invoice XML or the source file. */
export function normalizeSchemaForValidator(type: EcfType, source: string): string {
  if (type !== 31) return source;
  // Even updating the source manifest cannot silently extend this exception to a
  // new release. Review the new artifact and remove/update this adjustment first.
  if (
    createHash('sha256').update(source, 'utf8').digest('hex') !== E31_REVIEWED_SHA256 ||
    source.split(E31_ORIGINAL_DECLARATION).length !== 2 ||
    source.includes(E31_NORMALIZED_DECLARATION)
  ) {
    throw new Error('E31 schema compatibility adjustment requires review for this artifact.');
  }
  return source.replace(E31_ORIGINAL_DECLARATION, E31_NORMALIZED_DECLARATION);
}

/** XSD regex has no captures/backreferences: ordinary grouping accepts exactly
 * the same language as these PCRE noncapturing groups. Only reviewed artifacts.
 */
export function normalizeAuxiliarySchema(filename: string, source: string): string {
  const reviewed: Record<string, { hash: string; count: number }> = {
    'acecf.xsd': {
      hash: '6dbb8dc708d2a848ed3cea21d4d8e76b46322b0d2cf4e2fae39f1e426b92391a',
      count: 1,
    },
    'rfce-32.xsd': {
      hash: 'dc891051dcba93d4535931e778c828a1f383ea10ffc9c8665145a112bb0ac4d9',
      count: 4,
    },
  };
  const expected = reviewed[filename];
  if (!expected) return source;
  if (
    createHash('sha256').update(source).digest('hex') !== expected.hash ||
    source.split('(?:').length - 1 !== expected.count
  )
    throw new Error('Auxiliary schema compatibility adjustment requires artifact review.');
  return source.replaceAll('(?:', '(');
}
