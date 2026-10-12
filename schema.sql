PRAGMA foreign_keys = ON;

CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    original_filename TEXT NOT NULL
);

CREATE TABLE rules (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL CHECK (json_valid(value_json))
);

CREATE TABLE items (
    id TEXT PRIMARY KEY,
    slot TEXT NOT NULL CHECK (slot IN ('standard', 'special')),
    position INTEGER NOT NULL,
    label TEXT NOT NULL,
    icon_label TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    description TEXT NOT NULL,
    parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json) AND json_type(parameters_json) = 'object'),
    source_id TEXT NOT NULL REFERENCES sources(id),
    UNIQUE (slot, position),
    CHECK ((slot = 'standard' AND position BETWEEN 1 AND 6)
        OR (slot = 'special' AND position BETWEEN 1 AND 5))
);

CREATE TABLE item_inventory_snapshot (
    source_id TEXT NOT NULL REFERENCES sources(id),
    item_id TEXT NOT NULL REFERENCES items(id),
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    PRIMARY KEY (source_id, item_id)
);

CREATE TABLE effect_types (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('buff', 'debuff')),
    icon_label TEXT NOT NULL,
    target_stat TEXT NOT NULL,
    weakness_name TEXT,
    multiplier REAL NOT NULL,
    semantic_status TEXT NOT NULL CHECK (semantic_status IN ('confirmed', 'icon_only')),
    CHECK (
        (kind = 'buff' AND target_stat IN ('firepower', 'survivability', 'mobility') AND multiplier = 1.3)
        OR (kind = 'debuff' AND target_stat = 'total_power' AND multiplier = 0.8)
    )
);

CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    unit_type TEXT NOT NULL CHECK (unit_type IN ('aircraft', 'battleship', 'cruiser', 'destroyer')),
    firepower INTEGER NOT NULL CHECK (firepower >= 0),
    survivability INTEGER NOT NULL CHECK (survivability >= 0),
    mobility INTEGER NOT NULL CHECK (mobility >= 0),
    power_min INTEGER NOT NULL CHECK (power_min = firepower + survivability + mobility - 10),
    source_id TEXT NOT NULL REFERENCES sources(id),
    source_row INTEGER NOT NULL CHECK (source_row BETWEEN 1 AND 3),
    source_column INTEGER NOT NULL CHECK (source_column BETWEEN 1 AND 5),
    UNIQUE (source_id, source_row, source_column)
);

CREATE TABLE effects (
    card_id TEXT NOT NULL REFERENCES cards(id),
    ordinal INTEGER NOT NULL CHECK (ordinal IN (1, 2)),
    effect_type_id TEXT NOT NULL REFERENCES effect_types(id),
    direction TEXT NOT NULL CHECK (direction IN ('left', 'right', 'front_left', 'front', 'front_right')),
    PRIMARY KEY (card_id, ordinal)
);

CREATE TRIGGER validate_effect_direction BEFORE INSERT ON effects
WHEN NOT (
    ((SELECT kind FROM effect_types WHERE id = NEW.effect_type_id) = 'buff' AND NEW.direction IN ('left', 'right'))
    OR ((SELECT kind FROM effect_types WHERE id = NEW.effect_type_id) = 'debuff' AND NEW.direction IN ('front_left', 'front', 'front_right'))
)
BEGIN
    SELECT RAISE(ABORT, 'effect kind and direction do not match');
END;

CREATE TRIGGER validate_effect_direction_update BEFORE UPDATE ON effects
WHEN NOT (
    ((SELECT kind FROM effect_types WHERE id = NEW.effect_type_id) = 'buff' AND NEW.direction IN ('left', 'right'))
    OR ((SELECT kind FROM effect_types WHERE id = NEW.effect_type_id) = 'debuff' AND NEW.direction IN ('front_left', 'front', 'front_right'))
)
BEGIN
    SELECT RAISE(ABORT, 'effect kind and direction do not match');
END;
