'use strict';

// How many paid executions a history cost covers. A list assembled from cached items only books its fresh items;
// dividing that cost by the whole output list would underestimate the next run. Legacy maps have only their list size.
// Only callers with known scalar outputs opt into legacy list inference; a node returning a whole list still ran once.
function costCount(entry, legacyList = false) {
  if (Number.isInteger(entry.freshItemCount) && entry.freshItemCount >= 0) return entry.freshItemCount;
  if (Array.isArray(entry.itemKeys) && entry.itemKeys.length) return entry.itemKeys.length;
  const lists = legacyList ? Object.values(entry.variants?.[0] || {}).filter((value) => value?.type === 'list') : [];
  if (lists.length && lists[0].items?.length > 0 && lists.every((value) => value.items?.length === lists[0].items.length)) return lists[0].items.length;
  const count = Number(entry.params?.count);
  return Number.isFinite(count) && count > 0 ? count : 1;
}

module.exports = { costCount };
