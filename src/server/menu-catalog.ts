import type { DatabaseSync } from 'node:sqlite';
import type { MenuAvailability, MenuItemDetails } from '../shared/contracts.js';
import { WorkflowError } from './store.js';

function cleanDetails(details: MenuItemDetails) {
  const name = details.name.trim();
  const category = details.category.trim();
  if (!name || !category) throw new WorkflowError(400, 'Enter a dish name and category.');
  return { name, category, description: details.description.trim(), pricePaise: details.pricePaise };
}

export function createMenuItem(db: DatabaseSync, requestId: string, details: MenuItemDetails) {
  const item = cleanDetails(details);
  const result = db.prepare(`
    INSERT INTO menu (name, category, description, price_paise, creation_request_id)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(creation_request_id) WHERE creation_request_id IS NOT NULL DO NOTHING
    RETURNING id
  `).get(item.name, item.category, item.description, item.pricePaise, requestId);
  if (result) return Number(result.id);
  const saved = db.prepare('SELECT id, name, category, description, price_paise FROM menu WHERE creation_request_id = ?').get(requestId);
  if (!saved || saved.name !== item.name || saved.category !== item.category || saved.description !== item.description || saved.price_paise !== item.pricePaise) {
    throw new WorkflowError(409, 'This dish was already saved or edited. Check the current menu before retrying.');
  }
  return Number(saved.id);
}

export function updateMenuItem(db: DatabaseSync, id: number, revision: number, details: MenuItemDetails) {
  const item = cleanDetails(details);
  const current = db.prepare('SELECT name, category, description, price_paise, revision FROM menu WHERE id = ?').get(id);
  if (!current) throw new WorkflowError(404, 'Dish not found.');
  if (current.name === item.name && current.category === item.category && current.description === item.description
    && current.price_paise === item.pricePaise) return;
  const saved = db.prepare(`
    UPDATE menu SET name = ?, category = ?, description = ?, price_paise = ?, revision = revision + 1
    WHERE id = ? AND revision = ?
  `).run(item.name, item.category, item.description, item.pricePaise, id, revision);
  if (!saved.changes) throw new WorkflowError(409, 'This dish changed. Review its current details before saving.');
}

export function setMenuAvailability(db: DatabaseSync, id: number, change: MenuAvailability) {
  const current = db.prepare('SELECT available, available_after, revision FROM menu WHERE id = ?').get(id);
  if (!current) throw new WorkflowError(404, 'Dish not found.');
  if (change.available && change.availableAfter !== null) {
    throw new WorkflowError(400, 'An available dish does not need a return time.');
  }
  if (Boolean(current.available) === change.available && current.available_after === change.availableAfter) return;
  if (change.availableAfter !== null && change.availableAfter <= Date.now()) {
    throw new WorkflowError(400, 'Choose a return time in the future.');
  }
  const saved = db.prepare(`
    UPDATE menu SET available = ?, available_after = ?, revision = revision + 1 WHERE id = ? AND revision = ?
  `).run(change.available ? 1 : 0, change.availableAfter, id, change.revision);
  if (!saved.changes) throw new WorkflowError(409, 'This dish changed. Review its current availability and try again.');
}
