/**
 * One-off data migrations, run at boot (idempotent and cheap, so a deploy never needs a manual step).
 */
import Service from '../models/Service.js';

/**
 * 2026-09-23: a visit carries `kinds` (one to four tags) instead of the single `kind`. Rows written before
 * get `kinds = [kind]`; `kind` itself stays as the leading tag.
 */
export async function migrateServiceKinds() {
  const res = await Service.updateMany({ $or: [{ kinds: { $exists: false } }, { kinds: { $size: 0 } }] }, [
    { $set: { kinds: [{ $ifNull: ['$kind', 'repair'] }] } },
  ]);
  if (res.modifiedCount) console.log(`migration: ${res.modifiedCount} services got their kinds`);
}

export async function runMigrations() {
  await migrateServiceKinds();
}
