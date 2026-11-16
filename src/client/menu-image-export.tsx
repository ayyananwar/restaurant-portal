import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { MenuItem } from '../shared/contracts.js';
import { drawMenuImage, menuImageBlob, prepareMenuImage, type MenuImage } from './menu-image.js';

function fileName(index: number, count: number) {
  return `menu-${String(index + 1).padStart(Math.max(2, String(count).length), '0')}.png`;
}

function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export default function MenuImageExport({ menu, connected, onClose }: {
  menu: MenuItem[];
  connected: boolean;
  onClose: () => void;
}) {
  const [image, setImage] = useState<MenuImage | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const titleHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { titleHeading.current?.focus(); }, []);

  useEffect(() => {
    if (image && canvas.current) drawMenuImage(canvas.current, image, index);
  }, [image, index]);

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connected || !menu.length) return;
    const title = String(new FormData(event.currentTarget).get('title') ?? '').trim() || 'Restaurant menu';
    try {
      setImage(prepareMenuImage(title, menu));
      setIndex(0);
      setError('');
    } catch {
      setError('Couldn’t create the menu images. Refresh this page and try again.');
    }
  }

  async function download(all: boolean) {
    if (!image || busy) return;
    setBusy(true);
    setError('');
    const output = document.createElement('canvas');
    try {
      if (all) {
        const { zipSync } = await import('fflate');
        const files: Record<string, Uint8Array> = {};
        for (let page = 0; page < image.pages.length; page++) {
          drawMenuImage(output, image, page);
          files[fileName(page, image.pages.length)] = new Uint8Array(await (await menuImageBlob(output)).arrayBuffer());
        }
        saveFile(new Blob([new Uint8Array(zipSync(files, { level: 0 }))], { type: 'application/zip' }), 'menu-images.zip');
      } else {
        drawMenuImage(output, image, index);
        saveFile(await menuImageBlob(output), fileName(index, image.pages.length));
      }
    } catch {
      setError('Couldn’t download the images. Try again, or download each page separately.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="menu-image-export" aria-labelledby="menu-image-title">
    <div className="table-header">
      <h2 id="menu-image-title" ref={titleHeading} tabIndex={-1}>Export menu images</h2>
      <Button variant="ghost" disabled={busy} onClick={onClose}>Back to catalog</Button>
    </div>
    <p className="muted">Create portrait PNGs with every dish, price, and sold-out label. The images are a snapshot of your menu.</p>
    {menu.length === 0 ? <p className="note">Add a dish before creating menu images.</p> :
      <form className="menu-editor" onSubmit={prepare}>
        <Field>
          <FieldLabel htmlFor="menu-image-name">Title on the images</FieldLabel>
          <Input id="menu-image-name" name="title" maxLength={80} defaultValue="Restaurant menu" disabled={busy} />
        </Field>
        <div className="actions"><Button type="submit" disabled={!connected || busy}>{image ? 'Refresh preview' : 'Create preview'}</Button></div>
      </form>}
    {error && <p className="error" role="alert">{error}</p>}
    {image && <>
      <div className="actions">
        <Button disabled={busy} onClick={() => void download(false)}>Download this PNG</Button>
        {image.pages.length > 1 && <Button variant="outline" disabled={busy} onClick={() => void download(true)}>Download all as ZIP</Button>}
        {busy && <span role="status" className="muted">Preparing download…</span>}
      </div>
      <div className="actions" aria-label="Menu image pages" role="group">
        <Button variant="outline" disabled={index === 0 || busy} onClick={() => setIndex(index - 1)}>Previous page</Button>
        <p role="status">Page {index + 1} of {image.pages.length}</p>
        <Button variant="outline" disabled={index + 1 >= image.pages.length || busy} onClick={() => setIndex(index + 1)}>Next page</Button>
      </div>
      <canvas ref={canvas} className="menu-image-preview" role="img" aria-label={`${image.title}, image ${index + 1} of ${image.pages.length}`} />
      <details>
        <summary>Text on this page</summary>
        <ul>{image.pages[index]?.map(({ dish, price, heading }) => <li key={dish.id}>
          {heading.length > 0 && <strong>{dish.category} · </strong>}{dish.name} · {price}{dish.available ? '' : ' · Sold out'}
        </li>)}</ul>
      </details>
    </>}
  </section>;
}
