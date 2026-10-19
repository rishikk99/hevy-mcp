// A D1Database stand-in over node:sqlite, so tests run real SQL in plain Node.
// D1 is SQLite underneath; this covers the slice of the D1 API the Worker uses.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

type Value = string | number | null;

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: Value[] = [],
  ) {}

  bind(...params: Value[]): Statement {
    return new Statement(this.db, this.sql, params);
  }

  private prepared() {
    return this.db.prepare(this.sql);
  }

  async all<T>() {
    const results = this.prepared().all(...this.params).map((r) => ({ ...r })) as T[];
    return { results, success: true, meta: {} };
  }

  async first<T>(): Promise<T | null> {
    const row = this.prepared().get(...this.params);
    return row ? ({ ...row } as T) : null;
  }

  async run() {
    const info = this.prepared().run(...this.params);
    return { success: true, results: [], meta: { changes: Number(info.changes) } };
  }

  execute() {
    return this.prepared().run(...this.params);
  }
}

export class FakeD1 {
  readonly sqlite: DatabaseSync;

  constructor(path = ":memory:", { migrate = true, readOnly = false } = {}) {
    this.sqlite = new DatabaseSync(path, { readOnly });
    if (migrate) {
      // In filename order, as `wrangler d1 migrations apply` runs them.
      for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
        this.sqlite.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
      }
    }
  }

  prepare(sql: string): Statement {
    return new Statement(this.sqlite, sql);
  }

  /** Atomic, like D1: every statement commits or none do. */
  async batch(statements: Statement[]) {
    this.sqlite.exec("BEGIN");
    try {
      for (const s of statements) s.execute();
      this.sqlite.exec("COMMIT");
    } catch (exc) {
      this.sqlite.exec("ROLLBACK");
      throw exc;
    }
    return statements.map(() => ({ success: true, results: [], meta: {} }));
  }

  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }

  get d1(): D1Database {
    return this as unknown as D1Database;
  }
}
