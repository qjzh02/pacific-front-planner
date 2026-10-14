"""Check the public copy's initial inventory, provenance and fixture boundaries."""
import json
import re
import sqlite3
import unittest
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class FixtureParser(HTMLParser):
    def handle_starttag(self, tag, attrs):
        assert tag in {"html", "meta", "body", "h1", "h2", "h3", "section", "div", "article", "span", "img"}, tag
        allowed = {"lang"} if tag == "html" else {"charset"} if tag == "meta" else {"class", "src"} if tag == "img" else {"class"}
        assert all(name in allowed for name, _ in attrs), tag
        for name, value in attrs:
            if name == "class":
                assert all(re.fullmatch(r"_[A-Za-z0-9]+_public_1", c) for c in value.split()), value
            elif name == "src":
                assert re.fullmatch(r"/assets/(?:icon_(?:battleship|cruiser|destroyer)_standard|card_ship_(?:plane|coastal_artillery))-public\.webp", value), value

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)


class PublicReleaseTests(unittest.TestCase):
    def test_initial_inventory_is_zero_in_json_and_database(self):
        items = json.loads((ROOT / "data/items.json").read_text(encoding="utf-8"))
        quantities = items["inventory_snapshot"]["quantities"]
        self.assertEqual(set(quantities), {item["id"] for item in items["items"]})
        self.assertTrue(all(value == 0 for value in quantities.values()))
        with sqlite3.connect((ROOT / "data/cards.sqlite3").as_uri() + "?mode=ro", uri=True) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM item_inventory_snapshot WHERE quantity != 0").fetchone()[0], 0)

    def test_sources_are_public_transcriptions(self):
        for name in ("cards", "items"):
            catalog = json.loads((ROOT / f"data/{name}.json").read_text(encoding="utf-8"))
            for source in catalog["sources"]:
                path = ROOT / source["path"]
                self.assertEqual(path.suffix, ".json")
                self.assertEqual(source["original_filename"], path.name)
                self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["kind"], "public_transcription")

    def test_no_private_artifacts_or_personal_paths(self):
        text_extensions = {".js", ".mjs", ".json", ".md", ".sql", ".py", ".ps1", ".html", ".txt"}
        forbidden = re.compile(r"codex[-]clipboard-|[A-Za-z]:[/\\]Users[/\\]|/[U]sers/[^/\s]+/|"
                               r"[A-Za-z]:[/\\]fd[/\\]WWS[/\\]|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", re.I)
        for path in ROOT.rglob("*"):
            relative = path.relative_to(ROOT)
            # Dependencies and bytecode are local test products, ignored by Git.
            if not path.is_file() or any(part in {"node_modules", "__pycache__", ".git"} for part in relative.parts):
                continue
            self.assertNotIn(path.suffix.lower(), {".png", ".jpg", ".jpeg", ".webp", ".log", ".zip"}, str(relative))
            self.assertFalse(any(part.startswith(".diagnostic") for part in relative.parts), str(relative))
            self.assertNotIn("browser-input-backup", path.name)
            if path.suffix in text_extensions:
                self.assertIsNone(forbidden.search(path.read_text(encoding="utf-8-sig")), str(relative))
        with sqlite3.connect((ROOT / "data/cards.sqlite3").as_uri() + "?mode=ro", uri=True) as db:
            for table in ("sources", "rules", "items", "cards", "effect_types"):
                for row in db.execute(f"SELECT * FROM {table}"):
                    for value in row:
                        if isinstance(value, str):
                            self.assertIsNone(forbidden.search(value), table)

    def test_capture_fixtures_have_only_artificial_markup(self):
        files = list((ROOT / "html").glob("*.txt")) + list((ROOT / "html").glob("*.html"))
        self.assertEqual(len(files), 14)
        for path in files:
            content = path.read_text(encoding="utf-8")
            self.assertLess(len(content), 6000)
            self.assertIn("测试行动", content)
            self.assertNotIn("http", content.lower())
            FixtureParser().feed(content)

    def test_windows_launcher_keeps_utf8_bom(self):
        self.assertTrue((ROOT / "start.ps1").read_bytes().startswith(b"\xef\xbb\xbf"))

    def test_calibration_provenance_and_action_fixture_are_public_records(self):
        catalog = json.loads((ROOT / "data/cards.json").read_text(encoding="utf-8"))
        sources = catalog["rule_sources"]["user_confirmed_enemy_power_increase"]["sources"]
        self.assertEqual(sources, ["sources/enemy-power-calibration.json"])
        self.assertEqual(json.loads((ROOT / sources[0]).read_text(encoding="utf-8"))["kind"], "public_transcription")
        fixture = json.loads((ROOT / "test-fixtures/action-resource-regression.json").read_text(encoding="utf-8"))
        self.assertEqual(fixture["kind"], "synthetic")
        self.assertTrue(all(card["id"].startswith("test_card_") for card in fixture["catalog"]["cards"]))


if __name__ == "__main__":
    unittest.main()
