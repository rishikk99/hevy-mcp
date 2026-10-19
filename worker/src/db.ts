// Small helpers over D1, mirroring the get_state/set_state pair in db.py.

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM sync_state WHERE key = ?").bind(key).first<{ value: string | null }>();
  return row ? row.value : null;
}

export function setStateStatement(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, value);
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await setStateStatement(db, key, value).run();
}

export async function deleteState(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM sync_state WHERE key = ?").bind(key).run();
}
