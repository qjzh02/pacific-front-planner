"""Build card/item catalogs and review tables from their editable JSON sources."""

import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DIRECTIONS = {
    "left": "左侧友军",
    "right": "右侧友军",
    "front_left": "左前敌军",
    "front": "正前敌军",
    "front_right": "右前敌军",
}
UNIT_TYPES = {"aircraft": "飞机", "battleship": "战列舰", "cruiser": "巡洋舰", "destroyer": "驱逐舰"}


def validate(catalog, item_catalog):
    effects = {effect["id"]: effect for effect in catalog["effect_types"]}
    assert len(effects) == len(catalog["effect_types"]), "Duplicate effect type"
    sources = catalog["sources"] + item_catalog["sources"]
    source_ids = {source["id"] for source in sources}
    assert len(source_ids) == len(sources), "Duplicate source"
    assert len({card["id"] for card in catalog["cards"]}) == len(catalog["cards"]), "Duplicate card ID"
    for source in sources:
        assert (ROOT / source["path"]).is_file(), f"Missing source record: {source['path']}"
    for card in catalog["cards"]:
        assert re.fullmatch(r"[a-z][a-z0-9_]*", card["id"]), f"Invalid ID: {card['id']}"
        assert card["source_id"] in source_ids, f"Unknown source: {card['id']}"
        assert card["unit_type"] in UNIT_TYPES, f"Unknown unit type: {card['id']}"
        stats = [card[key] for key in ("firepower", "survivability", "mobility")]
        assert all(type(value) is int and value >= 0 for value in stats), f"Invalid stats: {card['id']}"
        assert card["power_min"] == sum(stats) - 10, f"Power mismatch: {card['id']}"
        assert len(card["effects"]) == 2, f"Expected two effects: {card['id']}"
        for effect in card["effects"]:
            effect_type = effects[effect["type"]]
            allowed = {"left", "right"} if effect_type["kind"] == "buff" else {"front_left", "front", "front_right"}
            assert effect["direction"] in allowed, f"Direction mismatch: {card['id']}"
    rules = catalog["rules"]
    assert rules["buff_multiplier"] == 1.3
    assert rules["debuff_multiplier"] == 0.8
    assert rules["debuff_stacking"] == "additive"
    assert abs(1 - 2 * (1 - rules["debuff_multiplier"]) - rules["two_debuffs_multiplier"]) < 1e-12
    assert rules["battle_effect_reduction"] == {"buff_bonus_rate_multiplier": 0.5, "debuff_reduction_rate_multiplier": 0.5}
    assert rules["battle_items_disabled_slots"] == ["standard", "special"]
    assert rules["enemy_power_increase_with_single_debuff"] == {
        "increase_rate": 0.16, "debuff_rate": 0.2,
        "formula": "round(base_power * (1 + increase_rate - debuff_rate))",
    }
    assert rules["enemy_power_increase_other_debuff_combinations"] == "base_power * (1 + increase_rate - sum(debuff_rates))"
    items = item_catalog["items"]
    item_ids = {item["id"] for item in items}
    assert len(item_ids) == len(items), "Duplicate item ID"
    for item in items:
        assert re.fullmatch(r"[a-z][a-z0-9_]*", item["id"]), f"Invalid item ID: {item['id']}"
        assert item["source_id"] in source_ids
        assert type(item["enabled"]) is bool
        assert isinstance(item["parameters"], dict)
        assert item["slot"] in {"standard", "special"}
        maximum = 6 if item["slot"] == "standard" else 5
        assert type(item["position"]) is int and 1 <= item["position"] <= maximum
    snapshot = item_catalog["inventory_snapshot"]
    assert snapshot["source_id"] in source_ids
    assert set(snapshot["quantities"]) == item_ids, "Inventory must cover all catalog items"
    assert all(type(value) is int and value >= 0 for value in snapshot["quantities"].values())
    assert item_catalog["rules"]["item_equipment_limits"] == {"standard": 1, "special": 1}
    assert item_catalog["rules"]["item_amplification_mode"] == "bonus_rate_doubled"
    for item in items:
        parameters = item["parameters"]
        if "resulting_buff_multiplier" in parameters:
            expected = 1 + (rules["buff_multiplier"] - 1) * parameters["bonus_rate_multiplier"]
            assert abs(parameters["resulting_buff_multiplier"] - expected) < 1e-12
        if "resulting_debuff_multiplier" in parameters:
            expected = 1 - (1 - rules["debuff_multiplier"]) * parameters["reduction_rate_multiplier"]
            assert abs(parameters["resulting_debuff_multiplier"] - expected) < 1e-12


def build():
    catalog = json.loads((ROOT / "data/cards.json").read_text(encoding="utf-8"))
    item_catalog = json.loads((ROOT / "data/items.json").read_text(encoding="utf-8"))
    validate(catalog, item_catalog)
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.executescript((ROOT / "schema.sql").read_text(encoding="utf-8"))
        for source in catalog["sources"] + item_catalog["sources"]:
            connection.execute("INSERT INTO sources VALUES (?, ?, ?)",
                               (source["id"], source["path"], source["original_filename"]))
        for key, value in catalog["rules"].items():
            connection.execute("INSERT INTO rules VALUES (?, ?)", (key, json.dumps(value, ensure_ascii=False)))
        for key in ("schema_version", "scope", "rule_sources"):
            connection.execute("INSERT INTO rules VALUES (?, ?)", (key, json.dumps(catalog[key], ensure_ascii=False)))
        for key, value in item_catalog["rules"].items():
            connection.execute("INSERT INTO rules VALUES (?, ?)", (key, json.dumps(value, ensure_ascii=False)))
        connection.execute("INSERT INTO rules VALUES (?, ?)",
                           ("item_rule_sources", json.dumps(item_catalog["rule_sources"], ensure_ascii=False)))
        for item in item_catalog["items"]:
            connection.execute("INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                               (item["id"], item["slot"], item["position"], item["label"], item["icon_label"],
                                item["enabled"], item["description"], json.dumps(item["parameters"], ensure_ascii=False), item["source_id"]))
        snapshot = item_catalog["inventory_snapshot"]
        for item_id, quantity in snapshot["quantities"].items():
            connection.execute("INSERT INTO item_inventory_snapshot VALUES (?, ?, ?)",
                               (snapshot["source_id"], item_id, quantity))
        for effect in catalog["effect_types"]:
            connection.execute("INSERT INTO effect_types VALUES (?, ?, ?, ?, ?, ?, ?)",
                               tuple(effect[key] for key in ("id", "kind", "icon_label", "target_stat", "weakness_name", "multiplier", "semantic_status")))
        for card in catalog["cards"]:
            connection.execute("INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                               tuple(card[key] for key in ("id", "name", "unit_type", "firepower", "survivability", "mobility", "power_min", "source_id", "source_row", "source_column")))
            for ordinal, effect in enumerate(card["effects"], start=1):
                connection.execute("INSERT INTO effects VALUES (?, ?, ?, ?)",
                                   (card["id"], ordinal, effect["type"], effect["direction"]))
        connection.commit()
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        card_count = connection.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
        effect_count = connection.execute("SELECT COUNT(*) FROM effects").fetchone()[0]
        item_count = connection.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        assert card_count == len(catalog["cards"])
        assert effect_count == 2 * card_count
        assert item_count == len(item_catalog["items"])
        assert connection.execute("SELECT COUNT(*) FROM item_inventory_snapshot").fetchone()[0] == item_count
        output = ROOT / "data/cards.sqlite3"
        temporary = output.with_suffix(".sqlite3.tmp")
        with closing(sqlite3.connect(temporary)) as destination:
            connection.backup(destination)
        temporary.replace(output)

    effect_types = {effect["id"]: effect for effect in catalog["effect_types"]}
    rows = ["# 卡牌核对表", "", "由 data/cards.json 生成。三项属性和最低战力均为满血、无额外效果时的已整理数值。", "",
            "减益名称已核对，原图形编码保留。来源为公开文字记录编号及原卡面行、列，均从1开始；原始截图不分发。", "",
            "| 名称 | 类型 | 火力 | 存活性 | 机动性 | 最低战力 | 效果1 | 效果2 | 来源 |",
            "|---|---|---:|---:|---:|---:|---|---|---|"]
    for card in catalog["cards"]:
        descriptions = []
        for effect in card["effects"]:
            effect_type = effect_types[effect["type"]]
            amount = "对应属性×1.3" if effect_type["kind"] == "buff" else "匹配弱点后按敌方原战力降低20%，幅度加算"
            effect_name = effect_type["weakness_name"] or effect_type["icon_label"]
            descriptions.append(f"{effect_name} → {DIRECTIONS[effect['direction']]}；{amount}")
        rows.append(f"| {card['name']} | {UNIT_TYPES[card['unit_type']]} | {card['firepower']} | {card['survivability']} | {card['mobility']} | {card['power_min']} | {' | '.join(descriptions)} | {card['source_id']} 行{card['source_row']}列{card['source_column']} |")
    (ROOT / "CARD_CATALOG.md").write_text("\n".join(rows) + "\n", encoding="utf-8")
    item_rows = ["# 道具核对表", "", "按道具栏从左到右编号。名称是效果描述，不是已确认的游戏正式名称。", "",
                 "每个单位最多装备1个灰色标准变项和1个绿色特殊变项。公开版初始数量均为0，请在网页填写实际库存。", "",
                 "| 槽位 | 位置 | 描述名称 | 效果 | 初始数量 | 参与配队 |",
                 "|---|---:|---|---|---:|---|"]
    for item in item_catalog["items"]:
        slot_label = "灰色标准" if item["slot"] == "standard" else "绿色特殊"
        enabled = "是" if item["enabled"] else "否"
        quantity = item_catalog["inventory_snapshot"]["quantities"][item["id"]]
        item_rows.append(f"| {slot_label} | {item['position']} | {item['label']} | {item['description']} | {quantity} | {enabled} |")
    item_rows.extend(["", "效果翻倍按幅度计算：友方增益30%→60%（×1.6），敌方减益20%→40%（×0.6）。",
                      "各来源减益按原战力加算：两次普通减益为×0.6；一次翻倍减益为×0.6；普通与翻倍减益叠加为×0.4；两次翻倍减益为×0.2。敌方有增益时，最终战力=原战力×（1＋增益比例－减益幅度合计）。",
                      "", "同一属性的道具与友军正向增幅按实测确认加算；全局减益的结算顺序、零生命单位能否被恢复尚待确认。"])
    (ROOT / "ITEM_CATALOG.md").write_text("\n".join(item_rows) + "\n", encoding="utf-8")
    print(f"Verified {card_count} cards, {effect_count} effects, {item_count} items; SQLite integrity and foreign keys OK.")
    print(output)


if __name__ == "__main__":
    build()
