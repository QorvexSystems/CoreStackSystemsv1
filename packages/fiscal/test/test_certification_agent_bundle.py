import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from xml.etree import ElementTree as ET
from zipfile import ZipFile

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
TOOL = Path(__file__).resolve().parents[1] / "tools/prepare_certification_agent_bundle.py"


def workbook(path):
    encf, issuer = "E310000000001", "101010632"
    headers = ["CasoPrueba", "Version", "TipoeCF", "ENCF", "RNCEmisor", "RazonSocialEmisor",
               "DireccionEmisor", "FechaEmision", "TipoIngresos", "TipoPago", "MontoTotal"]
    values = [issuer + encf, "1.0", "31", encf, issuer, "SYNTHETIC ONLY", "SYNTHETIC ADDRESS",
              "04-11-2026", "01", "1", "100.00"]
    sheets = {"ECF": [headers, values], "RFCE": [["CasoPrueba", "Version", "TipoeCF", "ENCF"]]}
    strings = list(dict.fromkeys(value for rows in sheets.values() for row in rows for value in row))
    shared = ET.Element(f"{{{MAIN}}}sst")
    for value in strings:
        ET.SubElement(ET.SubElement(shared, f"{{{MAIN}}}si"), f"{{{MAIN}}}t").text = value
    book = ET.Element(f"{{{MAIN}}}workbook")
    book_sheets = ET.SubElement(book, f"{{{MAIN}}}sheets")
    rels = ET.Element(f"{{{PKG}}}Relationships")
    with ZipFile(path, "w") as archive:
        archive.writestr("xl/sharedStrings.xml", ET.tostring(shared))
        for index, (name, rows) in enumerate(sheets.items(), 1):
            rel_id = f"rId{index}"
            ET.SubElement(book_sheets, f"{{{MAIN}}}sheet", {"name": name, f"{{{REL}}}id": rel_id})
            ET.SubElement(rels, f"{{{PKG}}}Relationship", {"Id": rel_id, "Target": f"worksheets/sheet{index}.xml"})
            sheet = ET.Element(f"{{{MAIN}}}worksheet")
            data = ET.SubElement(sheet, f"{{{MAIN}}}sheetData")
            for number, row in enumerate(rows, 1):
                record = ET.SubElement(data, f"{{{MAIN}}}row")
                for column, value in enumerate(row):
                    cell = ET.SubElement(record, f"{{{MAIN}}}c", {"t": "s", "r": f"{chr(65 + column)}{number}"})
                    ET.SubElement(cell, f"{{{MAIN}}}v").text = str(strings.index(value))
            archive.writestr(f"xl/worksheets/sheet{index}.xml", ET.tostring(sheet))
        archive.writestr("xl/workbook.xml", ET.tostring(book))
        archive.writestr("xl/_rels/workbook.xml.rels", ET.tostring(rels))
    return hashlib.sha256(path.read_bytes()).hexdigest()


class CertificationBundleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="certification-bundle-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.input = self.root / "synthetic.xlsx"
        self.digest = workbook(self.input)

    def run_tool(self, digest=None, issuer="101010632"):
        return subprocess.run([sys.executable, "-B", str(TOOL), str(self.input), str(self.root / "output"),
                               "--case-id", "synthetic-case", "--tenant-id", "synthetic-tenant",
                               "--issuer-rnc", issuer, "--certificate-sha256", "a" * 64,
                               "--expected-sha256", digest or self.digest, "--step", "2"],
                              capture_output=True, text=True, timeout=10)

    def test_generates_scoped_hashed_offline_plan_without_rivnu_identity(self):
        result = self.run_tool()
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.root / "output/manifest.json").read_text())
        self.assertEqual(manifest["scope"], {"tenantId": "synthetic-tenant", "issuerRnc": "101010632", "environment": "certification"})
        self.assertEqual(manifest["sourceSha256"], self.digest)
        document = manifest["documents"][0]
        self.assertEqual(document["sha256"], hashlib.sha256((self.root / "output" / document["file"]).read_bytes()).hexdigest())

    def test_wrong_workbook_hash_fails_without_creating_output(self):
        result = self.run_tool("0" * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("WORKBOOK_HASH_MISMATCH", result.stderr)
        self.assertFalse((self.root / "output").exists())

    def test_another_issuer_fails_without_creating_output(self):
        result = self.run_tool(issuer="101010641")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("WORKBOOK_ISSUER_MISMATCH", result.stderr)
        self.assertFalse((self.root / "output").exists())


if __name__ == "__main__":
    unittest.main()
