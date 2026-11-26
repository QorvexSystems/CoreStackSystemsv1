/** Ordered nodes preserve the XSD sequence. No raw XML, attributes, namespaces or DTD input. */
export type XmlElement = Readonly<{ name: string; value: string | readonly XmlElement[] }>;
export const element = (name: string, value: XmlElement['value']): XmlElement => ({ name, value });
const MAX_XML_BYTES = 2 * 1024 * 1024;

function escapeText(value: string): string {
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (
      !(
        point === 9 ||
        point === 10 ||
        point === 13 ||
        (point >= 0x20 && point <= 0xd7ff) ||
        (point >= 0xe000 && point <= 0xfffd) ||
        (point >= 0x10000 && point <= 0x10ffff)
      )
    ) {
      throw new Error('Character not permitted in XML 1.0.');
    }
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;');
}

export function serializeXml(root: XmlElement): string {
  let nodes = 0;
  let bytes = 0;
  const active = new Set<XmlElement>();
  const append = (value: string): string => {
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_XML_BYTES) throw new Error('XML size limit exceeded.');
    return value;
  };
  const visit = (node: XmlElement, depth: number): string => {
    if (++nodes > 100_000 || depth > 32) throw new Error('XML complexity limit exceeded.');
    if (
      !node ||
      typeof node.name !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9]*$/.test(node.name) ||
      node.name === 'Signature'
    ) {
      throw new Error('Invalid XML element name or externally supplied signature.');
    }
    if (active.has(node)) throw new Error('Cyclic XML tree.');
    active.add(node);
    const start = append(`<${node.name}>`);
    let content: string;
    if (typeof node.value === 'string') {
      if (!node.value.trim()) throw new Error('Empty XML elements must be omitted.');
      if (Buffer.byteLength(node.value, 'utf8') > MAX_XML_BYTES)
        throw new Error('XML size limit exceeded.');
      content = append(escapeText(node.value));
    } else {
      // E32 requires Comprador even for anonymous consumption. Only this known
      // container may be empty; no empty scalar or arbitrary empty node is accepted.
      if (!Array.isArray(node.value) || (node.value.length === 0 && node.name !== 'Comprador'))
        throw new Error('Invalid XML value.');
      content = node.value.map((child) => visit(child, depth + 1)).join('');
    }
    active.delete(node);
    return start + content + append(`</${node.name}>`);
  };
  return append('<?xml version="1.0" encoding="utf-8"?>') + visit(root, 0);
}

/** Parses only this module's canonical, attribute-free serialization. This is
 * not a general XML parser: externally supplied XML must use a hardened parser.
 */
export function parseSerializedXml(xml: string): XmlElement {
  const declaration = '<?xml version="1.0" encoding="utf-8"?>';
  if (
    typeof xml !== 'string' ||
    !xml.startsWith(declaration) ||
    Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES ||
    /<!|<\?(?!xml\s)|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml)
  )
    throw new Error('INVALID_CANONICAL_XML');
  const source = xml.slice(declaration.length);
  const stack: { name: string; children: XmlElement[]; text: string | null }[] = [];
  let root: XmlElement | null = null;
  let offset = 0;
  let nodes = 0;
  const decode = (value: string) => {
    if (/&(?!amp;|lt;|gt;|quot;|apos;|#13;)/.test(value))
      throw new Error('INVALID_CANONICAL_XML');
    return value.replace(/&(amp|lt|gt|quot|apos|#13);/g, (_match, entity: string) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#13': '\r' })[entity]!,
    );
  };
  while (offset < source.length) {
    if (source[offset] === '<') {
      const close = source.indexOf('>', offset + 1);
      if (close < 0) throw new Error('INVALID_CANONICAL_XML');
      const token = source.slice(offset + 1, close);
      const closing = token.startsWith('/');
      const name = closing ? token.slice(1) : token;
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name) || name === 'Signature')
        throw new Error('INVALID_CANONICAL_XML');
      if (!closing) {
        if (++nodes > 100_000 || stack.length >= 32) throw new Error('INVALID_CANONICAL_XML');
        stack.push({ name, children: [], text: null });
      } else {
        const current = stack.pop();
        if (!current || current.name !== name) throw new Error('INVALID_CANONICAL_XML');
        const value = current.text === null ? current.children : current.text;
        if (
          (current.text !== null && current.children.length > 0) ||
          (current.text === null && current.children.length === 0 && name !== 'Comprador')
        )
          throw new Error('INVALID_CANONICAL_XML');
        const node = element(name, value);
        if (stack.length) stack.at(-1)!.children.push(node);
        else if (root) throw new Error('INVALID_CANONICAL_XML');
        else root = node;
      }
      offset = close + 1;
    } else {
      const next = source.indexOf('<', offset);
      if (next < 0 || !stack.length) throw new Error('INVALID_CANONICAL_XML');
      const current = stack.at(-1)!;
      if (current.children.length || current.text !== null) throw new Error('INVALID_CANONICAL_XML');
      current.text = decode(source.slice(offset, next));
      if (!current.text.trim()) throw new Error('INVALID_CANONICAL_XML');
      offset = next;
    }
  }
  if (stack.length || !root || serializeXml(root) !== xml) throw new Error('INVALID_CANONICAL_XML');
  return root;
}

export function children(node: XmlElement): readonly XmlElement[] {
  if (!Array.isArray(node.value)) throw new Error(`Expected children in ${node.name}.`);
  return node.value;
}

export function child(node: XmlElement, name: string): XmlElement {
  const matches = children(node).filter((candidate) => candidate.name === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${name}.`);
  return matches[0];
}

export function textAt(node: XmlElement, ...path: string[]): string {
  const selected = path.reduce((current, name) => child(current, name), node);
  if (typeof selected.value !== 'string') throw new Error('Expected XML text.');
  return selected.value;
}
