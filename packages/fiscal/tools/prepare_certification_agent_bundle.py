#!/usr/bin/env python3
"""Prepare scoped runner plans from DGII workbooks. Offline; never signs or sends."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import prepare_certification_set as ecf
import prepare_commercial_approval_set as approval


def check(value: object, code: str) -> None:
    if not value:
        raise SystemExit(code)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--case-id", required=True)
    parser.add_argument("--tenant-id", required=True)
    parser.add_argument("--issuer-rnc", required=True)
    parser.add_argument("--certificate-sha256", required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--step", type=int, choices=[2, 3], required=True)
    parser.add_argument("--schemas", type=Path, default=Path(__file__).resolve().parent.parent / "schemas")
    args = parser.parse_args()
    check(re.fullmatch(r"[A-Za-z0-9_-]{1,100}", args.case_id), "CASE_ID_INVALID")
    check(re.fullmatch(r"[A-Za-z0-9_-]{1,100}", args.tenant_id), "TENANT_ID_INVALID")
    check(re.fullmatch(r"(?:[0-9]{9}|[0-9]{11})", args.issuer_rnc), "ISSUER_RNC_INVALID")
    for value in [args.certificate_sha256, args.expected_sha256]:
        check(re.fullmatch(r"[a-f0-9]{64}", value), "EXPECTED_HASH_INVALID")
    check(args.workbook.is_file() and not args.workbook.is_symlink() and args.workbook.stat().st_size <= 16 * 1024 * 1024,
          "WORKBOOK_INVALID")
    check(hashlib.sha256(args.workbook.read_bytes()).hexdigest() == args.expected_sha256, "WORKBOOK_HASH_MISMATCH")
    with ZipFile(args.workbook) as archive:
        infos = archive.infolist()
        check(len(infos) <= 64 and sum(item.file_size for item in infos) <= 64 * 1024 * 1024, "WORKBOOK_SIZE_LIMIT")
        check(len({item.filename for item in infos}) == len(infos), "WORKBOOK_DUPLICATE_ENTRY")
        for info in infos:
            check(not Path(info.filename).is_absolute() and ".." not in Path(info.filename).parts, "WORKBOOK_PATH_INVALID")
            if info.filename.endswith(".xml") or info.filename.endswith(".rels"):
                check(b"<!" not in archive.read(info.filename), "WORKBOOK_XML_DECLARATION_REJECTED")
    documents: list[dict] = []
    outputs: dict[str, bytes] = {}
    refs: dict[str, str | None] = {}
    if args.step == 2:
        sheets = ecf.workbook_rows(args.workbook, args.expected_sha256)
        check(1 < len(sheets["ECF"]) <= 1001 and 1 <= len(sheets["RFCE"]) <= 1001, "WORKBOOK_COUNTS_INVALID")
        summaries = {row[3] for row in sheets["RFCE"][1:]}
        summary_hashes = {}
        for row in sheets["RFCE"][1:]:
            check(row[0] == args.issuer_rnc + row[3], "RFCE_WORKBOOK_SCOPE_INVALID")
            template = ecf.xml_from_row(args.schemas / "rfce-32.xsd", sheets["RFCE"][0], row,
                                        {"CodigoSeguridadeCF": "ABC123"})
            summary_hashes[row[3]] = hashlib.sha256(template).hexdigest()
        for row in sheets["ECF"][1:]:
            check(len(row) >= 4 and row[0] == args.issuer_rnc + row[3], "WORKBOOK_ISSUER_MISMATCH")
            kind, encf = row[2], row[3]
            check(kind in ["31", "32", "33", "34", "41", "43", "44", "45", "46", "47"] and
                  re.fullmatch(r"E" + kind + r"[0-9]{10}", encf) and encf not in outputs, "WORKBOOK_ENCF_INVALID")
            body = ecf.xml_from_row(args.schemas / f"ecf-{kind}.xsd", sheets["ECF"][0], row)
            root = ET.fromstring(body)
            check(root.findtext("./Encabezado/Emisor/RNCEmisor") == args.issuer_rnc, "XML_ISSUER_MISMATCH")
            refs[encf] = root.findtext("./InformacionReferencia/NCFModificado")
            if kind == "32" and root.find("./Encabezado/Comprador") is None:
                header = root.find("./Encabezado")
                check(header is not None, "XML_HEADER_MISSING")
                index = next(index for index, node in enumerate(header) if node.tag == "Totales")
                header.insert(index, ET.Element("Comprador"))
                body = ecf.canonical_xml(root)
            outputs[encf] = body
        check(summaries.issubset(outputs), "RFCE_ECF_SOURCE_MISSING")
        # Topological ordering retains original document data and only changes delivery order.
        pending = list(outputs)
        while pending:
            ready = [key for key in pending if refs[key] not in pending and
                     (key not in summaries or all(item in summaries for item in pending))]
            check(ready, "WORKBOOK_REFERENCE_CYCLE")
            for encf in ready:
                documents.append({"id": encf, "encf": encf, "route": "RFCE" if encf in summaries else "ECF",
                                  "file": f"{encf}.xml", "sha256": hashlib.sha256(outputs[encf]).hexdigest(),
                                  **({"rfceTemplateSha256": summary_hashes[encf]} if encf in summaries else {}),
                                  "dependsOn": [refs[encf]] if refs[encf] in outputs else []})
                pending.remove(encf)
    else:
        rows = approval.workbook_rows(args.workbook, args.expected_sha256)
        check(1 < len(rows) <= 1001 and rows[0] == approval.EXPECTED_HEADERS, "APPROVAL_WORKBOOK_INVALID")
        for row in rows[1:]:
            values = dict(zip(approval.EXPECTED_HEADERS, row))
            encf = values["eNCF"]
            check(values["RNCComprador"] == args.issuer_rnc and values["Version"] == "1.0" and
                  values["Estado"] in ["1", "2"] and re.fullmatch(r"E[0-9]{12}", encf) and encf not in outputs,
                  "APPROVAL_SCOPE_INVALID")
            body = approval.canonical_xml(values)
            # Convert to the attribute-free serializer profile used by the signer verifier.
            body = ecf.canonical_xml(ET.fromstring(body))
            outputs[encf] = body
            documents.append({"id": encf, "encf": encf, "route": "ACECF", "file": f"{encf}.xml",
                              "sha256": hashlib.sha256(body).hexdigest(), "dependsOn": []})
    check(not args.output.exists(), "OUTPUT_ALREADY_EXISTS")
    os.mkdir(args.output, mode=0o700)
    for encf, body in outputs.items():
        with (args.output / f"{encf}.xml").open("xb") as target:
            os.chmod(target.name, 0o600)
            target.write(body)
    manifest = {"version": 1, "caseId": args.case_id,
                "scope": {"tenantId": args.tenant_id, "issuerRnc": args.issuer_rnc, "environment": "certification"},
                "stepNumber": args.step, "sourceSha256": args.expected_sha256,
                "certificateSha256": args.certificate_sha256, "documents": documents}
    body = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
    with (args.output / "manifest.json").open("xb") as target:
        os.chmod(target.name, 0o600)
        target.write(body)
    print("CERTIFICATION_BUNDLE_READY_NOT_SIGNED_NOT_SENT")
    print("ManifestSHA256=" + hashlib.sha256(body).hexdigest())


if __name__ == "__main__":
    main()
