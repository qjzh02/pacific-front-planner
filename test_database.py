"""Check the saved catalog against the public item definitions and zero initial inventory."""

import json
import sqlite3
import unittest
from pathlib import Path


class ItemCatalogTests(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).resolve().parent / "data/cards.sqlite3"
        self.connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
        self.addCleanup(self.connection.close)

    def test_catalog_slots_and_snapshot(self):
        rows = self.connection.execute(
            "SELECT i.slot, i.position, i.enabled, s.quantity FROM items i "
            "JOIN item_inventory_snapshot s ON s.item_id=i.id ORDER BY i.slot, i.position"
        ).fetchall()
        self.assertEqual(rows, [
            ("special", 1, 1, 0), ("special", 2, 1, 0), ("special", 3, 1, 0),
            ("special", 4, 1, 0), ("special", 5, 1, 0),
            ("standard", 1, 1, 0), ("standard", 2, 1, 0), ("standard", 3, 1, 0),
            ("standard", 4, 1, 0), ("standard", 5, 0, 0), ("standard", 6, 0, 0),
        ])
        rule = self.connection.execute(
            "SELECT value_json FROM rules WHERE key='item_equipment_limits'"
        ).fetchone()
        self.assertEqual(json.loads(rule[0]), {"standard": 1, "special": 1})

    def test_amplification_is_not_repeated_triggering(self):
        parameters = dict(self.connection.execute("SELECT id, parameters_json FROM items"))
        buff = json.loads(parameters["standard_buff_amplifier"])
        debuff = json.loads(parameters["special_debuff_amplifier"])
        self.assertEqual(buff["resulting_buff_multiplier"], 1.6)
        self.assertEqual(debuff["resulting_debuff_multiplier"], 0.6)
        regular = self.connection.execute(
            "SELECT value_json FROM rules WHERE key='two_debuffs_multiplier'"
        ).fetchone()
        self.assertEqual(json.loads(regular[0]), 0.64)

    def test_card_catalog_is_preserved(self):
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM cards").fetchone()[0], 30)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM effects").fetchone()[0], 60)
        self.assertEqual(self.connection.execute(
            "SELECT name, unit_type, firepower, survivability, mobility, power_min FROM cards WHERE id='missouri'"
        ).fetchone(), ("USS密苏里", "battleship", 80, 80, 40, 190))
        self.assertEqual(self.connection.execute("PRAGMA integrity_check").fetchone(), ("ok",))
        self.assertEqual(self.connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_laffey_effect_directions(self):
        self.assertEqual(self.connection.execute(
            "SELECT effect_type_id, direction FROM effects WHERE card_id='laffey' ORDER BY ordinal"
        ).fetchall(), [("buff_survivability", "left"), ("debuff_ring_projectile", "front")])

    def test_effect_reduction_conditions_and_confirmed_item_bypass(self):
        rules = {key: json.loads(value) for key, value in self.connection.execute("SELECT key, value_json FROM rules")}
        self.assertEqual(rules["battle_effect_reduction"], {
            "buff_bonus_rate_multiplier": 0.5, "debuff_reduction_rate_multiplier": 0.5,
        })
        self.assertTrue(rules["ignore_conditions_bypasses_buff_reduction"])
        self.assertTrue(rules["ignore_conditions_bypasses_debuff_reduction"])

    def test_special_item_effects(self):
        items = {key: json.loads(value) for key, value in self.connection.execute(
            "SELECT id, parameters_json FROM items WHERE slot='special'"
        )}
        disabled = items["special_disable_effects_power"]
        self.assertTrue(disabled["disable_card_buffs"])
        self.assertTrue(disabled["disable_card_debuffs"])
        self.assertEqual(disabled["total_stat_multiplier"], 1.4)
        self.assertTrue(items["special_force_debuff"]["bypass_weakness_match"])
        self.assertEqual(items["special_restore_health"]["health_delta"], 2)
        self.assertTrue(items["special_ignore_conditions"]["ignore_battle_conditions"])


if __name__ == "__main__":
    unittest.main()
