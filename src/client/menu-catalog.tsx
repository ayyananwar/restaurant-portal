import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { maxMenuPhotoBytes, menuPhotoPath, type MenuAvailability, type MenuItem, type MenuItemDetails, type MenuPublicationStatus } from '../shared/contracts.js';
import { api, message, RequestError } from './api.js';
import { availabilityCaption, filterMenu, formatPublicationTime, indiaDateTime } from './menu-display.js';
import { formatPaise, parseRupees } from './money.js';
import { Ban, Download, Eye, Image, Pencil, Plus, Search } from 'lucide-react';
import { DishPhoto } from './dish-photo.js';

const MenuImageExport = lazy(() => import('./menu-image-export.js'));

type Editor = { mode: 'details'; item?: MenuItem } | { mode: 'availability' | 'photo'; item: MenuItem };

function encodePhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const encoded = String(reader.result).split(',')[1];
      if (encoded) resolve(encoded);
      else reject(new Error('Unreadable photo'));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function MenuCatalog({ menu, canEdit, connected, publication, samplePhotos, onRefresh, onClose, onEditChange }: {
  menu: MenuItem[];
  canEdit: boolean;
  connected: boolean;
  publication?: MenuPublicationStatus;
  samplePhotos?: boolean;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  onEditChange?: (editing: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState('menu');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const creationRequest = useRef('');
  const editTrigger = useRef('');
  const editorMode = editor?.mode;
  const selectedCategory = category && menu.some(item => item.category === category) ? category : null;
  const categories = [...new Set(menu.map(item => item.category))];
  const results = filterMenu(menu, query, selectedCategory);
  if (sort === 'name') results.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === 'price') results.sort((a, b) => a.pricePaise - b.pricePaise);

  useEffect(() => {
    onEditChange?.(!!editorMode || busy);
  }, [editorMode, busy, onEditChange]);

  useEffect(() => {
    if (!editorMode) return;
    const firstField = { details: 'catalog-name', availability: 'catalog-return', photo: 'catalog-photo' }[editorMode];
    document.getElementById(firstField)?.focus();
  }, [editorMode]);

  function open(next: Editor, trigger: string) {
    editTrigger.current = trigger;
    setError('');
    setNotice('');
    if (next.mode === 'details' && !next.item) creationRequest.current = crypto.randomUUID();
    setEditor(next);
  }

  function closeEditor() {
    setEditor(null);
    setError('');
    window.requestAnimationFrame(() => {
      const button = document.getElementById(editTrigger.current);
      if (button instanceof HTMLButtonElement && !button.disabled) button.focus();
      else document.getElementById('catalog-title')?.focus();
    });
  }

  async function save(action: () => Promise<unknown>, success: string) {
    if (busy || !connected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await onRefresh();
      if (editor) closeEditor();
      setNotice(success);
    } catch (error) {
      setError(message(error));
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  function saveDetails(event: FormEvent<HTMLFormElement>, item?: MenuItem) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const pricePaise = parseRupees(String(values.get('price')));
    if (pricePaise === undefined) {
      setError('Enter a price in rupees with up to two decimal places.');
      return;
    }
    const details: MenuItemDetails = {
      name: String(values.get('name')), category: String(values.get('category')),
      description: String(values.get('description')), pricePaise
    };
    if (item) void save(() => api(`/api/menu/${item.id}`, 'PATCH', { ...details, revision: item.revision }), 'Dish details saved.');
    else void save(() => api('/api/menu', 'POST', { ...details, requestId: creationRequest.current }), 'Dish added to the menu.');
  }

  function availability(item: MenuItem, available: boolean, availableAfter: number | null) {
    const change: MenuAvailability = { available, availableAfter, revision: item.revision };
    void save(() => api(`/api/menu/${item.id}/availability`, 'PATCH', change),
      available ? `${item.name} is available again.` : `${item.name} is marked sold out.`);
  }

  function savePhoto(event: FormEvent<HTMLFormElement>, item: MenuItem) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get('photo');
    if (!(file instanceof File) || file.size === 0 || file.size > maxMenuPhotoBytes) {
      setError('Choose a JPEG, PNG, or WebP photo up to 4 MB.');
      return;
    }
    void save(async () => {
      const encoded = await encodePhoto(file).catch(() => {
        throw new RequestError(400, 'The photo could not be read. Choose the file again.');
      });
      return api(`/api/menu/${item.id}/photo`, 'PATCH', { revision: item.revision, encoded });
    }, 'Dish photo saved.');
  }

  if (canEdit && exporting) return <div className="panel menu-catalog">
    <Suspense fallback={<p role="status" className="muted">Opening menu export…</p>}>
      <MenuImageExport menu={menu} connected={connected} onClose={() => {
        setExporting(false);
        window.requestAnimationFrame(() => document.getElementById('menu-image-trigger')?.focus());
      }} />
    </Suspense>
  </div>;

  return <section className="panel menu-catalog" aria-labelledby="catalog-title">
    <div className="table-header">
      <h2 id="catalog-title" tabIndex={-1}>{canEdit ? 'Dishes' : 'Dish availability'}</h2>
      <Button variant="ghost" disabled={busy || !!editor} onClick={onClose}>{canEdit ? 'Back to overview' : 'Back to queue'}</Button>
    </div>
    {canEdit && connected && publication && <p className="muted" role="status">
      {!publication.configured ? 'Public menu publishing is off.'
        : publication.pending ? 'Menu changes are saved here and waiting to publish.' : 'Public menu is up to date.'}
      {publication.publishedAt !== null && <> Last published {formatPublicationTime(publication.publishedAt)} IST.</>}
    </p>}
    {editor?.mode === 'details' && <form className="menu-editor" onSubmit={event => saveDetails(event, editor.item)}>
      <h3>{editor.item ? 'Edit dish' : 'Add dish'}</h3>
      <Field><FieldLabel htmlFor="catalog-name">Dish name</FieldLabel>
        <Input id="catalog-name" name="name" required maxLength={100} defaultValue={editor.item?.name} disabled={busy} />
      </Field>
      <Field><FieldLabel htmlFor="catalog-category">Category</FieldLabel>
        <Input id="catalog-category" name="category" list="catalog-categories" required maxLength={60} defaultValue={editor.item?.category} disabled={busy} />
        <datalist id="catalog-categories">{categories.map(category => <option key={category} value={category} />)}</datalist>
      </Field>
      <Field><FieldLabel htmlFor="catalog-price">Price (₹)</FieldLabel>
        <Input id="catalog-price" name="price" required inputMode="decimal" maxLength={12} disabled={busy}
          defaultValue={editor.item ? (editor.item.pricePaise / 100).toFixed(2) : ''} />
      </Field>
      <Field><FieldLabel htmlFor="catalog-description">Description (optional)</FieldLabel>
        <textarea id="catalog-description" name="description" rows={3} maxLength={600} defaultValue={editor.item?.description} disabled={busy} />
      </Field>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <Button type="submit" disabled={!connected || busy}>{busy ? 'Saving…' : 'Save dish'}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={closeEditor}>Cancel</Button>
      </div>
    </form>}
    {editor?.mode === 'availability' && <form className="menu-editor" onSubmit={event => {
      event.preventDefault();
      const value = String(new FormData(event.currentTarget).get('returnTime') ?? '');
      const timestamp = value ? Date.parse(`${value}:00+05:30`) : null;
      if (timestamp !== null && !Number.isFinite(timestamp)) {
        setError('Enter a valid return date and time.');
        return;
      }
      availability(editor.item, false, timestamp);
    }}>
      <h3>{editor.item.available ? 'Mark sold out' : 'Update return estimate'} · {editor.item.name}</h3>
      <Field><FieldLabel htmlFor="catalog-return">Expected return (India time, optional)</FieldLabel>
        <Input id="catalog-return" name="returnTime" type="datetime-local" disabled={busy}
          defaultValue={editor.item.availableAfter === null ? '' : indiaDateTime(editor.item.availableAfter)} />
      </Field>
      <p className="note">The dish stays sold out until the kitchen confirms it is available.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <Button type="submit" disabled={!connected || busy}>{busy ? 'Saving…' : 'Save sold out'}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={closeEditor}>Cancel</Button>
      </div>
    </form>}
    {editor?.mode === 'photo' && <form className="menu-editor" onSubmit={event => savePhoto(event, editor.item)}>
      <h3>Dish photo · {editor.item.name}</h3>
      {editor.item.photoKey && <img className="menu-photo-preview"
        src={menuPhotoPath(editor.item.id, editor.item.photoKey)} alt={`Current photo of ${editor.item.name}`} />}
      <Field><FieldLabel htmlFor="catalog-photo">Choose photo</FieldLabel>
        <Input id="catalog-photo" type="file" name="photo" accept="image/jpeg,image/png,image/webp"
          aria-describedby="catalog-photo-hint" required disabled={busy} />
      </Field>
      <p id="catalog-photo-hint" className="note">JPEG, PNG, or WebP. Up to 4 MB and 16 megapixels.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <Button type="submit" disabled={!connected || busy}>{busy ? 'Saving…' : 'Save photo'}</Button>
        {editor.item.photoKey && <Button type="button" variant="outline" disabled={!connected || busy} onClick={() => {
          const item = editor.item;
          void save(() => api(`/api/menu/${item.id}/photo`, 'PATCH', { revision: item.revision, encoded: null }), 'Dish photo removed.');
        }}>Remove photo</Button>}
        <Button type="button" variant="ghost" disabled={busy} onClick={closeEditor}>Cancel</Button>
      </div>
    </form>}
    {!editor && <>
      {canEdit && <div className="catalog-top-actions actions">
        <Button variant="outline" asChild><a href="/guest-menu"><Eye aria-hidden="true" />Preview guest menu</a></Button>
        <Button id="menu-image-trigger" onClick={() => setExporting(true)}><Download aria-hidden="true" />Export menu images</Button>
      </div>}
      <div className="catalog-category-bar">
        <div className="category-list" role="group" aria-label="Catalog categories">
          {[null, ...categories].map(option => <Button key={option ?? ''} variant="outline" aria-pressed={selectedCategory === option}
            onClick={() => setCategory(option)}>{option ?? 'All items'} ({option === null ? menu.length : menu.filter(item => item.category === option).length})</Button>)}
        </div>
        {canEdit && <Button id="add-dish" className="gold-button" disabled={!connected || busy} onClick={event => open({ mode: 'details' }, event.currentTarget.id)}><Plus aria-hidden="true" />Add dish</Button>}
      </div>
      <div className="menu-tools">
        <Field className="staff-search">
          <FieldLabel htmlFor="catalog-search" className="sr-only">Find a dish</FieldLabel><Search aria-hidden="true" />
          <Input id="catalog-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name or category" />
        </Field>
        <label className="catalog-sort">Sort by <select value={sort} onChange={event => setSort(event.target.value)}><option value="menu">Menu order</option><option value="name">Name (A–Z)</option><option value="price">Price (low to high)</option></select></label>
      </div>
      {notice && <p className="note" role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {results.length === 0 ? <div className="actions">
        <p className="note" role="status">{menu.length ? 'No dishes match your filters.' : 'No dishes have been added yet.'}</p>
        {menu.length > 0 && <Button variant="outline" onClick={() => {
          setQuery(''); setCategory(null);
          document.getElementById('catalog-search')?.focus();
        }}>Clear filters</Button>}
      </div> :
        <ul className="menu-management-list">
          {results.map(item => {
            const caption = availabilityCaption(item);
            return <li key={item.id} className="menu-management-row staff-menu-row">
              <div className="staff-menu-dish"><DishPhoto item={item} sample={samplePhotos} /><div>
                <strong>{item.name}</strong>
                <p className="note">{item.category}</p>
                {canEdit && item.description && <p className="note">{item.description}</p>}
                {caption && <p className="note">{caption}</p>}
              </div></div>
              <strong className="amount">{formatPaise(item.pricePaise)}</strong>
              <Badge variant="secondary" data-state={item.available ? 'ready' : 'sold-out'}>{item.available ? 'Available' : 'Sold out'}</Badge>
              <div className="actions">
                {canEdit && <Button id={`edit-dish-${item.id}`} variant="outline" disabled={!connected || busy} onClick={event => open({ mode: 'details', item }, event.currentTarget.id)}><Pencil aria-hidden="true" />Edit dish</Button>}
                {canEdit && <Button id={`dish-photo-${item.id}`} variant="outline" disabled={!connected || busy} onClick={event => open({ mode: 'photo', item }, event.currentTarget.id)}>
                  <Image aria-hidden="true" />{item.photoKey ? 'Change photo' : 'Add photo'}
                </Button>}
                {item.available
                  ? <Button id={`dish-availability-${item.id}`} variant="outline" disabled={!connected || busy} onClick={event => open({ mode: 'availability', item }, event.currentTarget.id)}><Ban aria-hidden="true" />Mark sold out</Button>
                  : <>
                    <Button disabled={!connected || busy} onClick={() => availability(item, true, null)}>Confirm available</Button>
                    <Button id={`dish-availability-${item.id}`} variant="ghost" disabled={!connected || busy} onClick={event => open({ mode: 'availability', item }, event.currentTarget.id)}>Edit estimate</Button>
                  </>}
              </div>
            </li>;
          })}
        </ul>}
    </>}
  </section>;
}
