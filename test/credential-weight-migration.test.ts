import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/20260731_credential_weight_validation.sql", import.meta.url),
  "utf8",
);

let database: DatabaseSync | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE credentials(id TEXT PRIMARY KEY, weight INTEGER NOT NULL)");
  return db;
}

describe("credential weight validation migration", () => {
  it("normalizes historical invalid values before enabling validation", () => {
    database = createDatabase();
    database.prepare("INSERT INTO credentials(id,weight) VALUES(?,?)").run("zero", 0);
    database.prepare("INSERT INTO credentials(id,weight) VALUES(?,?)").run("fraction", 1.5);
    database.prepare("INSERT INTO credentials(id,weight) VALUES(?,?)").run("large", 2_000_000);
    database.exec(migration);

    const rows = database.prepare("SELECT id,weight,typeof(weight) AS type FROM credentials ORDER BY id").all();
    expect(rows).toEqual([
      { id: "fraction", weight: 1, type: "integer" },
      { id: "large", weight: 1_000_000, type: "integer" },
      { id: "zero", weight: 1, type: "integer" },
    ]);
  });

  it("rejects invalid inserts and updates while accepting boundary values", () => {
    database = createDatabase();
    database.exec(migration);
    database.prepare("INSERT INTO credentials(id,weight) VALUES(?,?)").run("minimum", 1);
    database.prepare("INSERT INTO credentials(id,weight) VALUES(?,?)").run("maximum", 1_000_000);

    for (const weight of [0, -1, 1.5, 1_000_001]) {
      expect(() => database!.prepare("INSERT INTO credentials(id,weight) VALUES(?,?)")
        .run(`invalid-${weight}`, weight)).toThrow(/credential weight must be an integer/);
    }
    expect(() => database!.prepare("UPDATE credentials SET weight=? WHERE id=?")
      .run(1.25, "minimum")).toThrow(/credential weight must be an integer/);
  });
});
