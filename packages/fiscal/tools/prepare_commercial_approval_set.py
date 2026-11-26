#!/usr/bin/env python3
"""Prepare the exact DGII commercial-approval certification XLSX as unsigned ACECF XML."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
EXPECTED_SHEET = "ACEECF_Generadas"
EXPECTED_HEADERS = [
    "Version", "RNCEmisor", "eNCF", "FechaEmision", "MontoTotal",
    "RNCComprador", "Estado", "DetalleMotivoRechazo", "FechaHoraAprobacionComercial",
]
EXPECTED_BUYER_RNC = "40220429126"
EXPECTED_ISSUER_RNC = "131880681"


def fail(message: str) -> None:
    raise SystemExit(message)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def column_index(reference: str) -> int:
    match = re.fullmatch(r"([A-Z]+)[0-9]+", reference)
    if not match:
        fail("COMMERCIAL_APPROVAL_CELL_REFERENCE_INVALID")
    value = 0
    for character in match.group(1):
        value = value * 26 + ord(character) - ord("A") + 1
    return value - 1


def workbook_rows(path: Path, expected_sha256: str) -> list[list[str]]:
    raw = path.read_bytes()
    if digest(raw) != expected_sha256:
        fail("COMMERCIAL_APPROVAL_SET_HASH_MISMATCH")
    with ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) > 64 or sum(item.file_size for item in infos) > 16 * 1024 * 1024:
            fail("COMMERCIAL_APPROVAL_ARCHIVE_LIMIT_EXCEEDED")
        if any(Path(item.filename).is_absolute() or ".." in Path(item.filename).parts for item in infos):
            fail("COMMERCIAL_APPROVAL_ARCHIVE_PATH_REJECTED")
        if archive.testzip() is not None:
            fail("COMMERCIAL_APPROVAL_ARCHIVE_CORRUPT")
        strings_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        strings = [
            "".join(text.text or "" for text in item.iter(MAIN + "t"))
            for item in strings_root.findall(MAIN + "si")
        ]
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {
            node.attrib["Id"]: node.attrib["Target"]
            for node in relationships.findall(PKG_REL + "Relationship")
        }
        sheets_node = workbook.find(MAIN + "sheets")
        if sheets_node is None:
            fail("COMMERCIAL_APPROVAL_SHEET_INVALID")
        sheets = list(sheets_node)
        if len(sheets) != 1 or sheets[0].attrib.get("name") != EXPECTED_SHEET:
            fail("COMMERCIAL_APPROVAL_SHEET_INVALID")
        target = targets[sheets[0].attrib[REL + "id"]]
        target = target.lstrip("/") if target.startswith("/") else (
            target if target.startswith("xl/") else "xl/" + target
        )
        root = ET.fromstring(archive.read(target))
        rows: list[list[str]] = []
        for row in root.findall(".//" + MAIN + "sheetData/" + MAIN + "row"):
            values = [""] * len(EXPECTED_HEADERS)
            for cell in row.findall(MAIN + "c"):
                index = column_index(cell.attrib.get("r", ""))
                if index >= len(values):
                    fail("COMMERCIAL_APPROVAL_COLUMN_INVALID")
                value = cell.find(MAIN + "v")
                raw_value = "" if value is None else (value.text or "")
                values[index] = strings[int(raw_value)] if cell.attrib.get("t") == "s" and raw_value else raw_value
            rows.append(values)
        return rows


def canonical_xml(values: dict[str, str]) -> bytes:
    root = ET.Element("ACECF")
    detail = ET.SubElement(root, "DetalleAprobacionComercial")
    for name in EXPECTED_HEADERS:
        value = values[name]
        if name == "DetalleMotivoRechazo" and not value:
            continue
        ET.SubElement(detail, name).text = value
    return ("<?xml version=\"1.0\" encoding=\"utf-8\"?>" + ET.tostring(root, encoding="unicode")).encode("utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("workbook", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("--expected-sha256", required=True)
    args = parser.parse_args()
    if args.output_directory.exists():
        fail("COMMERCIAL_APPROVAL_OUTPUT_ALREADY_EXISTS")
    if not re.fullmatch(r"[a-f0-9]{64}", args.expected_sha256):
        fail("COMMERCIAL_APPROVAL_EXPECTED_HASH_INVALID")
    rows = workbook_rows(args.workbook, args.expected_sha256)
    if len(rows) != 12 or rows[0] != EXPECTED_HEADERS:
        fail("COMMERCIAL_APPROVAL_SET_STRUCTURE_INVALID")

    approvals: list[dict[str, object]] = []
    xml_documents: list[tuple[str, bytes]] = []
    seen: set[str] = set()
    for row in rows[1:]:
        values = dict(zip(EXPECTED_HEADERS, row))
        encf = values["eNCF"]
        if (
            values["Version"] != "1.0"
            or values["RNCEmisor"] != EXPECTED_ISSUER_RNC
            or values["RNCComprador"] != EXPECTED_BUYER_RNC
            or values["Estado"] != "1"
            or values["DetalleMotivoRechazo"]
            or not re.fullmatch(r"E(?:31|33|34|44|45)[0-9]{10}", encf)
            or encf in seen
        ):
            fail("COMMERCIAL_APPROVAL_ROW_SCOPE_INVALID")
        try:
            datetime.strptime(values["FechaEmision"], "%d-%m-%Y")
            datetime.strptime(values["FechaHoraAprobacionComercial"], "%d-%m-%Y %H:%M:%S")
            amount = Decimal(values["MontoTotal"])
        except (ValueError, InvalidOperation):
            fail("COMMERCIAL_APPROVAL_ROW_VALUE_INVALID")
        if amount < 0 or amount.as_tuple().exponent < -2:
            fail("COMMERCIAL_APPROVAL_AMOUNT_INVALID")
        values["MontoTotal"] = f"{amount:.2f}"
        xml = canonical_xml(values)
        seen.add(encf)
        xml_documents.append((encf, xml))
        approvals.append({
            "issuerRnc": values["RNCEmisor"],
            "buyerRnc": values["RNCComprador"],
            "encf": encf,
            "state": 1,
            "sha256": digest(xml),
            "bytes": len(xml),
        })

    os.mkdir(args.output_directory, mode=0o700)
    unsigned = args.output_directory / "acecf-unsigned"
    os.mkdir(unsigned, mode=0o700)
    for encf, xml in xml_documents:
        target = unsigned / f"ACECF-{encf}.xml"
        target.write_bytes(xml)
        os.chmod(target, stat.S_IRUSR | stat.S_IWUSR)
    manifest = {
        "sourceSha256": args.expected_sha256,
        "buyerRnc": EXPECTED_BUYER_RNC,
        "environment": "certification",
        "approvals": approvals,
    }
    manifest_path = args.output_directory / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(manifest_path, stat.S_IRUSR | stat.S_IWUSR)
    print(f"COMMERCIAL_APPROVAL_SET_PREPARED_COUNT={len(approvals)}")


if __name__ == "__main__":
    main()
