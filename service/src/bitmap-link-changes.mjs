// Link invalidations share the records transaction and survive journal replay.
export function bitmapLinkSchema(db) {
  db.exec('CREATE TABLE IF NOT EXISTS bitmap_link_changes(id TEXT PRIMARY KEY)');
  for (const [name, op, ref] of [['Insert', 'INSERT', 'new'], ['Update', 'UPDATE', 'new'], ['Delete', 'DELETE', 'old']]) db.exec(`
    DROP TRIGGER IF EXISTS bitmap_link_${name};
    CREATE TRIGGER bitmap_link_${name} AFTER ${op} ON records WHEN ${ref}.space='links'
    BEGIN INSERT INTO bitmap_link_changes VALUES(${ref}.id) ON CONFLICT(id) DO NOTHING; END;`);
}
