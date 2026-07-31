-- Normalize historical values before enforcing the scheduling contract.
UPDATE credentials
SET weight = CASE
  WHEN typeof(weight) <> 'integer' OR weight < 1 THEN 1
  WHEN weight > 1000000 THEN 1000000
  ELSE weight
END;

CREATE TRIGGER IF NOT EXISTS credentials_validate_weight_insert
BEFORE INSERT ON credentials
WHEN typeof(NEW.weight) <> 'integer' OR NEW.weight < 1 OR NEW.weight > 1000000
BEGIN
  SELECT RAISE(ABORT, 'credential weight must be an integer between 1 and 1000000');
END;

CREATE TRIGGER IF NOT EXISTS credentials_validate_weight_update
BEFORE UPDATE OF weight ON credentials
WHEN typeof(NEW.weight) <> 'integer' OR NEW.weight < 1 OR NEW.weight > 1000000
BEGIN
  SELECT RAISE(ABORT, 'credential weight must be an integer between 1 and 1000000');
END;
