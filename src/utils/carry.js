/**
 * Carry-forward of remaining work items between services of the same vehicle (spec 3.5).
 *
 * Link shape on both sides: { service: ObjectId, item: ObjectId }.
 * - the COPY (in the newer service T) gets `carriedFrom` pointing at the source item
 * - the ORIGINAL (in the older service S) gets `carriedTo` pointing at the copy and stops being "remaining"
 *
 * carryItems only mutates in memory and returns the touched source documents; the caller saves the target
 * first and then commits the sources (commitCarry), so a failed target save never marks a source as carried.
 */
import mongoose from 'mongoose';
import Service from '../models/Service.js';
import ApiError from './ApiError.js';

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** Groups carry refs by source service id, dropping duplicates and malformed ids. */
const groupRefs = (refs) => {
  const groups = new Map();
  const seen = new Set();
  for (const ref of Array.isArray(refs) ? refs : []) {
    const serviceId = String(ref?.serviceId ?? ref?.service ?? '');
    const itemId = String(ref?.itemId ?? ref?.item ?? '');
    if (!mongoose.isValidObjectId(serviceId) || !mongoose.isValidObjectId(itemId)) {
      throw ApiError.badRequest('מזהה פריט להעברה לא תקין');
    }
    const key = `${serviceId}:${itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!groups.has(serviceId)) groups.set(serviceId, []);
    groups.get(serviceId).push(itemId);
  }
  return groups;
};

/**
 * Copies remaining items of older services into `targetService` (unsaved mutation).
 * @param {import('mongoose').Document} targetService - the receiving service (may be new / unsaved)
 * @param {Array<{ serviceId: string, itemId: string }>} refs
 * @returns {Promise<{ sources: import('mongoose').Document[], added: object[] }>}
 */
export async function carryItems(targetService, refs) {
  const groups = groupRefs(refs);
  const sources = [];
  const added = [];

  for (const [serviceId, itemIds] of groups) {
    if (sameId(serviceId, targetService._id)) {
      throw ApiError.badRequest('לא ניתן להעביר פריט מהטיפול לעצמו');
    }
    const source = await Service.findById(serviceId);
    if (!source) throw ApiError.notFound('הטיפול המקורי לא נמצא');
    if (!sameId(source.vehicle, targetService.vehicle)) {
      throw ApiError.badRequest('ניתן להעביר פריטים רק מאותו רכב');
    }
    if (source.status === 'cancelled') {
      throw ApiError.badRequest('לא ניתן להעביר פריטים מטיפול שבוטל');
    }

    for (const itemId of itemIds) {
      const item = source.items.id(itemId);
      if (!item) throw ApiError.notFound('הפריט להעברה לא נמצא');
      if (item.done || item.carriedTo?.service) {
        throw ApiError.badRequest('הפריט כבר הועבר או בוצע');
      }

      targetService.items.push({
        title: item.title,
        work: item.work ? { title: item.work.title, price: item.work.price ?? null } : null,
        parts: (item.parts || []).map((p) => ({ title: p.title, qty: p.qty ?? 1, price: p.price ?? null })),
        price: item.price ?? null,
        oilType: item.oilType || '',
        notes: item.notes || '',
        template: item.template ?? null,
        done: false,
        carriedFrom: { service: source._id, item: item._id },
      });
      const copy = targetService.items[targetService.items.length - 1];
      item.carriedTo = { service: targetService._id, item: copy._id };
      added.push(copy);
    }
    sources.push(source);
  }

  return { sources, added };
}

/** Saves the source services touched by carryItems (call after the target was saved). */
export async function commitCarry(sources) {
  for (const source of sources || []) {
    await source.save();
  }
}

/**
 * Iterates the sources referenced by `carriedFrom` on the given items, grouped per source service,
 * applying `fn(sourceItem, copyItem, sourceService)` and saving each source that was modified.
 */
async function forEachOrigin(items, fn) {
  const groups = new Map();
  for (const it of items) {
    const sid = it?.carriedFrom?.service ? String(it.carriedFrom.service) : null;
    if (!sid) continue;
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push(it);
  }
  for (const [sid, copies] of groups) {
    const source = await Service.findById(sid);
    if (!source) continue;
    let touched = false;
    for (const copy of copies) {
      const original = source.items.id(copy.carriedFrom.item);
      if (!original) continue;
      if (fn(original, copy, source)) touched = true;
    }
    if (touched) await source.save();
  }
}

/**
 * UN-CARRY: every item of `service` that was copied from an older service releases its origin
 * (origin.carriedTo cleared, so it is remaining again). Used on cancel and delete.
 */
export async function uncarryFrom(service) {
  await forEachOrigin(service.items, (original, copy) => {
    // The copy itself was carried on to a newer service: that newer copy is the live "remaining" item,
    // so releasing the origin here would show the same job twice.
    if (copy?.carriedTo?.service) return false;
    if (original.carriedTo?.service && sameId(original.carriedTo.service, service._id)) {
      original.carriedTo = null;
      return true;
    }
    return false;
  });
}

/**
 * RE-CARRY (restore of a cancelled service): re-links each origin that is still undone and unclaimed.
 */
export async function recarryFrom(service) {
  await forEachOrigin(service.items, (original, copy) => {
    if (!original.done && !original.carriedTo?.service) {
      original.carriedTo = { service: service._id, item: copy._id };
      return true;
    }
    return false;
  });
}

/**
 * Releases the origin of ONE carried copy (item delete). `holderServiceId` is the service holding the copy.
 */
export async function uncarryItem(item, holderServiceId) {
  if (!item?.carriedFrom?.service) return;
  await forEachOrigin([item], (original) => {
    if (original.carriedTo?.service && sameId(original.carriedTo.service, holderServiceId)) {
      original.carriedTo = null;
      return true;
    }
    return false;
  });
}
