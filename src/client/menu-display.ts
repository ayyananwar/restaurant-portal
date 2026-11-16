import type { MenuItem } from '../shared/contracts.js';

const indiaOffsetMs = 330 * 60_000;
const indiaTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
});
const publicationTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
});

export function formatPublicationTime(timestamp: number | string) {
  return publicationTime.format(new Date(timestamp));
}

export function groupMenu<T extends { category: string }>(items: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.category);
    if (group) group.push(item);
    else groups.set(item.category, [item]);
  }
  return [...groups.entries()];
}

export function availabilityCaption(item: Pick<MenuItem, 'available' | 'availableAfter'>, now = Date.now()) {
  if (item.available || item.availableAfter === null) return null;
  const minutes = Math.ceil((item.availableAfter - now) / 60_000);
  if (minutes <= 0) return 'Awaiting kitchen confirmation';
  const remaining = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  return `Expected ${indiaTime.format(item.availableAfter)} · ${remaining} left`;
}

export function indiaDateTime(value: number) {
  return new Date(value + indiaOffsetMs).toISOString().slice(0, 16);
}

export function filterMenu<T extends Pick<MenuItem, 'name' | 'category'>>(menu: readonly T[], query: string, category: string | null = null) {
  const words = query.toLocaleLowerCase('en-IN').trim().split(/\s+/).filter(Boolean);
  return menu.filter(item => {
    if (category !== null && item.category !== category) return false;
    if (!words.length) return true;
    const label = `${item.name} ${item.category}`.toLocaleLowerCase('en-IN');
    return words.every(word => label.includes(word));
  });
}
