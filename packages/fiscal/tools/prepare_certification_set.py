#!/usr/bin/env python3
"""Deterministic, dependency-free DGII certification XLSX to unsigned XML.

The workbook is read-only. `#e` means omit the XML element. RFCE documents are
generated only when the six-character code from the corresponding signed E32
is supplied; no placeholder fiscal value is invented.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

XSD = "{http://www.w3.org/2001/XMLSchema}"
MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
EXPECTED_RNC = "40220429126"
ALIASES = {"eNCF": "ENCF", "MontoSubRecargo": "MontosubRecargo", "NumeroContenedor": "NumeroContenedor "}


def fail(message: str) -> None:
    raise SystemExit(message)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_xml(root: ET.Element) -> bytes:
    def escape(value: str) -> str:
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\r", "&#13;")
    def emit(node: ET.Element) -> str:
        children = list(node)
        content = "".join(emit(child) for child in children) if children else escape(node.text or "")
        return f"<{node.tag}>{content}</{node.tag}>"
    return ('<?xml version="1.0" encoding="utf-8"?>' + emit(root)).encode("utf-8")


def workbook_rows(path: Path, expected_sha256: str) -> dict[str, list[list[str]]]:
    raw = path.read_bytes()
    if digest(raw) != expected_sha256:
        fail("CERTIFICATION_SET_HASH_MISMATCH")
    with ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) > 64 or sum(x.file_size for x in infos) > 64 * 1024 * 1024:
            fail("CERTIFICATION_SET_ARCHIVE_LIMIT_EXCEEDED")
        if any(Path(x.filename).is_absolute() or ".." in Path(x.filename).parts for x in infos):
            fail("CERTIFICATION_SET_ARCHIVE_PATH_REJECTED")
        if archive.testzip() is not None:
            fail("CERTIFICATION_SET_ARCHIVE_CORRUPT")
        strings_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        strings = ["".join(t.text or "" for t in item.iter(MAIN + "t")) for item in strings_root.findall(MAIN + "si")]
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {node.attrib["Id"]: node.attrib["Target"] for node in relationships.findall(PKG_REL + "Relationship")}

        result: dict[str, list[list[str]]] = {}
        sheets_node = workbook.find(MAIN + "sheets")
        if sheets_node is None:
            fail("CERTIFICATION_SET_SHEETS_MISSING")
        for sheet in sheets_node:
            name = sheet.attrib["name"]
            target = targets[sheet.attrib[REL + "id"]]
            target = target.lstrip("/") if target.startswith("/") else (target if target.startswith("xl/") else "xl/" + target)
            root = ET.fromstring(archive.read(target))
            rows: list[list[str]] = []
            for row in root.findall(".//" + MAIN + "sheetData/" + MAIN + "row"):
                values: list[str] = []
                for cell in row.findall(MAIN + "c"):
                    value = cell.find(MAIN + "v")
                    raw_value = "" if value is None else (value.text or "")
                    values.append(strings[int(raw_value)] if cell.attrib.get("t") == "s" and raw_value else raw_value)
                rows.append(values)
            result[name] = rows
    if set(result) != {"ECF", "RFCE"}:
        fail("CERTIFICATION_SET_SHEETS_INVALID")
    return result


def xml_from_row(schema_path: Path, headers: list[str], row: list[str], overrides: dict[str, str] | None = None) -> bytes:
    if len(headers) != len(row) or len(headers) != len(set(headers)):
        fail("CERTIFICATION_SET_COLUMNS_INVALID")
    values = dict(zip(headers, row))
    values.update(overrides or {})
    used: set[str] = set()
    schema_root = ET.parse(schema_path).getroot()
    root_declaration = schema_root.find(XSD + "element")
    if root_declaration is None:
        fail("CERTIFICATION_XSD_ROOT_MISSING")

    def build(declaration: ET.Element, indexes: tuple[int, ...], ancestors: tuple[str, ...]) -> ET.Element | None:
        name = declaration.attrib.get("name")
        if not name:
            fail("CERTIFICATION_XSD_ELEMENT_UNSUPPORTED")
        complex_type = declaration.find(XSD + "complexType")
        if complex_type is None:
            column = "NumeroLineaDoR" if name == "NumeroLinea" and "DescuentoORecargo" in ancestors else ALIASES.get(name, name)
            key = column + "".join(f"[{index}]" for index in indexes)
            used.add(key)
            value = values.get(key, "#e")
            if value in ("", "#e"):
                return None
            node = ET.Element(name)
            node.text = value
            return node

        children: list[ET.Element] = []
        sequence = complex_type.find(XSD + "sequence")
        for child in [] if sequence is None else list(sequence):
            if child.tag == XSD + "any":
                continue
            if child.tag != XSD + "element":
                fail("CERTIFICATION_XSD_PARTICLE_UNSUPPORTED")
            maximum = child.attrib.get("maxOccurs", "1")
            if maximum == "unbounded" or int(maximum) > 1:
                limit = 1000 if maximum == "unbounded" else int(maximum)
                for index in range(1, limit + 1):
                    node = build(child, indexes + (index,), ancestors + (name,))
                    if node is None:
                        break
                    children.append(node)
            else:
                node = build(child, indexes, ancestors + (name,))
                if node is not None:
                    children.append(node)
        if not children:
            return None
        node = ET.Element(name)
        node.extend(children)
        return node

    output = build(root_declaration, (), ())
    if output is None:
        fail("CERTIFICATION_XML_EMPTY")
    active = {key for key, value in values.items() if value not in ("", "#e")}
    unused = sorted(active - used - {"CasoPrueba"})
    if unused:
        fail("CERTIFICATION_SET_FIELDS_UNMAPPED:" + ",".join(unused))
    return canonical_xml(output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("workbook", type=Path)
    parser.add_argument("schema_directory", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--signature-time")
    parser.add_argument("--rfce-security-codes", type=Path)
    args = parser.parse_args()
    if args.output_directory.exists():
        fail("CERTIFICATION_OUTPUT_ALREADY_EXISTS")
    if args.signature_time and not re.fullmatch(r"(0[1-9]|[12][0-9]|3[01])-(0[1-9]|1[0-2])-20[0-9]{2} ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]", args.signature_time):
        fail("CERTIFICATION_SIGNATURE_TIME_INVALID")
    if not re.fullmatch(r"[a-f0-9]{64}", args.expected_sha256):
        fail("CERTIFICATION_SET_EXPECTED_HASH_INVALID")
    sheets = workbook_rows(args.workbook, args.expected_sha256)
    ecf_rows, rfce_rows = sheets["ECF"], sheets["RFCE"]
    if len(ecf_rows) != 26 or len(rfce_rows) != 5:
        fail("CERTIFICATION_SET_CASE_COUNT_INVALID")
    if any(row[0] != EXPECTED_RNC + row[3] or row[1] != "1.0" for row in ecf_rows[1:] + rfce_rows[1:]):
        fail("CERTIFICATION_SET_SCOPE_INVALID")
    codes: dict[str, str] = {}
    if args.rfce_security_codes:
        codes = json.loads(args.rfce_security_codes.read_text(encoding="utf-8"))
        if set(codes) != {row[3] for row in rfce_rows[1:]} or any(not re.fullmatch(r"[A-Za-z0-9+/]{6}", value) for value in codes.values()):
            fail("RFCE_SECURITY_CODES_INVALID")

    os.mkdir(args.output_directory, mode=0o700)
    ecf_directory = args.output_directory / "ecf-unsigned"
    os.mkdir(ecf_directory, mode=0o700)
    manifest: dict[str, object] = {"sourceSha256": args.expected_sha256, "issuerRnc": EXPECTED_RNC, "environment": "certification", "ecf": [], "rfceTemplates": []}
    if args.signature_time:
        manifest["signatureTime"] = args.signature_time
    for row in ecf_rows[1:]:
        document_type, encf = row[2], row[3]
        overrides = {"FechaHoraFirma": args.signature_time} if args.signature_time else None
        xml = xml_from_row(args.schema_directory / f"ecf-{document_type}.xsd", ecf_rows[0], row, overrides)
        target = ecf_directory / f"{encf}.xml"
        target.write_bytes(xml)
        os.chmod(target, stat.S_IRUSR | stat.S_IWUSR)
        manifest["ecf"].append({"case": row[0], "type": int(document_type), "encf": encf, "sha256": digest(xml), "bytes": len(xml)})

    for row in rfce_rows[1:]:
        template = xml_from_row(args.schema_directory / "rfce-32.xsd", rfce_rows[0], row, {"CodigoSeguridadeCF": "ABC123"})
        manifest["rfceTemplates"].append({"case": row[0], "encf": row[3], "normalizedSecurityCode": "ABC123", "sha256": digest(template)})

    if codes:
        rfce_directory = args.output_directory / "rfce-unsigned"
        os.mkdir(rfce_directory, mode=0o700)
        for row in rfce_rows[1:]:
            encf = row[3]
            xml = xml_from_row(args.schema_directory / "rfce-32.xsd", rfce_rows[0], row, {"CodigoSeguridadeCF": codes[encf]})
            target = rfce_directory / f"RFCE-{encf}.xml"
            target.write_bytes(xml)
            os.chmod(target, stat.S_IRUSR | stat.S_IWUSR)
            manifest["rfce"].append({"case": row[0], "encf": encf, "sha256": digest(xml), "bytes": len(xml)})
    else:
        manifest["rfcePendingSecurityCode"] = [row[3] for row in rfce_rows[1:]]
    manifest_path = args.output_directory / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(manifest_path, stat.S_IRUSR | stat.S_IWUSR)
    print(f"CERTIFICATION_SET_PREPARED_ECF={len(ecf_rows)-1}_RFCE_PENDING={0 if codes else len(rfce_rows)-1}")


if __name__ == "__main__":
    main()
