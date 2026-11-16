import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConciergeBell, Coffee, CookingPot, Cupcake, Menu, Search, Soup, Utensils, X } from 'lucide-react';
import { menuPhotoPath, type GuestMenu as GuestMenuData, type GuestMenuItem } from '../shared/contracts.js';
import { api, RequestError } from './api.js';
import { availabilityCaption, filterMenu, formatPublicationTime, groupMenu } from './menu-display.js';
import { formatPaise } from './money.js';
import { GuestAccount } from './guest-account.js';
import { sampleDishPhoto } from './sample-dish-photos.js';
import './guest-menu.css';

const outlet = window.location.pathname.match(/^\/r\/([a-z0-9][a-z0-9-]{0,62})\/?$/)?.[1];
const menuPath = outlet ? `/api/public-menu/${outlet}` : '/api/guest-menu';

function categoryIcon(name: string) {
  if (/drink|beverage|tea|coffee/i.test(name)) return Coffee;
  if (/starter|soup|snack|appeti[sz]er/i.test(name)) return Soup;
  if (/dessert|sweet|cake/i.test(name)) return Cupcake;
  if (/main|rice|biryani|curry/i.test(name)) return CookingPot;
  return Utensils;
}

function PreviewThemes({ photoLed }: { photoLed: boolean }) {
  return <nav className="guest-themes" aria-label="Preview theme">
    <a href="/guest-menu" aria-current={!photoLed ? 'page' : undefined}>Classic</a>
    <a href="/guest-menu?theme=photo-led" aria-current={photoLed ? 'page' : undefined}>Photo-led</a>
  </nav>;
}

function GuestMenu() {
  const [menu, setMenu] = useState<GuestMenuData | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<'unpublished' | 'connection' | null>(null);
  const [now, setNow] = useState(Date.now);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const items = menu?.items;
  const photoLed = outlet ? menu?.theme === 'photo-led' : new URLSearchParams(window.location.search).get('theme') === 'photo-led';
  const hasEstimate = items?.some(item => !item.available && item.availableAfter !== null) ?? false;

  useEffect(() => {
    let current = true;
    void api<GuestMenuData>(menuPath).then(result => {
      if (!current) return;
      setMenu(result);
      if (result.name) document.title = `${result.name} · Menu`;
    }).catch((failure: unknown) => {
      if (current) setError(failure instanceof RequestError && failure.status === 404 ? 'unpublished' : 'connection');
    });
    return () => { current = false; };
  }, [loadAttempt]);

  useEffect(() => {
    if (!hasEstimate) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [hasEstimate]);

  const categories = groupMenu(items ?? []).map(([name], index) => ({ name, id: `category-${index + 1}` }));
  const matches = filterMenu(items ?? [], query);
  const sections = groupMenu(matches);
  const sectionIds = new Map(categories.map(({ name, id }) => [name, id]));
  const selectedId = sections.some(([name]) => sectionIds.get(name) === activeCategory)
    ? activeCategory : sectionIds.get(sections[0]?.[0] ?? '');
  const restaurant = menu?.name ?? (menu?.sampleArtwork ? 'The Outlet' : 'Restaurant');

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  function closeSearch() {
    setSearchOpen(false);
    setQuery('');
    searchButton.current?.focus();
  }

  return <div className={`guest-page ${photoLed ? 'guest-photo-led' : 'guest-classic'}`}>
    <a className="guest-skip" href="#guest-content">Skip to menu</a>
    <header className="guest-header">
      <div className="guest-topbar">
        <div className="guest-width guest-topbar-inner">
          <p className="guest-brand"><ConciergeBell aria-hidden="true" /><span>{restaurant}</span></p>
          <div className="guest-header-actions">
            {!outlet && <div className="guest-desktop-themes"><PreviewThemes photoLed={photoLed} /></div>}
            {items && items.length > 0 && <button type="button" className="guest-icon-button" aria-label={searchOpen ? 'Close search' : 'Search menu'}
              aria-expanded={searchOpen} aria-controls={searchOpen ? 'guest-search' : undefined}
              ref={searchButton} onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}>
              {searchOpen ? <X aria-hidden="true" /> : <Search aria-hidden="true" />}
            </button>}
            {!outlet && <details className="guest-mobile-themes">
              <summary className="guest-icon-button" aria-label="Preview themes"><Menu aria-hidden="true" /></summary>
              <PreviewThemes photoLed={photoLed} />
            </details>}
          </div>
        </div>
      </div>
      <div className="guest-hero">
        <div className="guest-width guest-title">
          <h1>{menu?.name ?? <>Restaurant <span>menu</span></>}</h1>
          <p>Browse dishes, prices, and availability.</p>
          {menu?.publishedAt && <p className="guest-updated">Last updated <time dateTime={menu.publishedAt}>{formatPublicationTime(menu.publishedAt)} IST</time></p>}
          <div className="guest-hero-rule" aria-hidden="true"><Utensils /></div>
        </div>
      </div>
    </header>
    <main id="guest-content" tabIndex={-1} className="guest-width guest-content">
      {searchOpen && <div className="guest-search" id="guest-search">
        <label htmlFor="guest-search-input">Search dishes</label>
        <input id="guest-search-input" ref={searchInput} type="search" value={query} placeholder="Dish or category…"
          onChange={event => setQuery(event.target.value)} onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); closeSearch(); }
          }} />
        {query.trim() && <p role="status">{matches.length} {matches.length === 1 ? 'dish' : 'dishes'} found</p>}
      </div>}
      {sections.length > 1 && <nav className="guest-categories" aria-label="Menu categories">
        {sections.map(([name]) => {
          const id = sectionIds.get(name)!;
          const Icon = categoryIcon(name);
          return <a key={name} href={`#${id}`} aria-current={selectedId === id ? 'location' : undefined}
            onClick={() => setActiveCategory(id)}><Icon aria-hidden="true" /><span>{name}</span></a>;
        })}
      </nav>}
      {outlet && menu && <GuestAccount outlet={outlet} />}
      {error && <div className="guest-message" role="alert">
        <p>{error === 'unpublished' ? 'This menu is unavailable. Ask the restaurant for its current menu.'
          : 'The menu couldn’t load. Check your connection and try again.'}</p>
        {error === 'connection' && <button type="button" onClick={() => { setError(null); setLoadAttempt(value => value + 1); }}>Try again</button>}
      </div>}
      {!items && !error && <p className="guest-message" role="status">Opening the menu…</p>}
      {items?.length === 0 && <p className="guest-message">The restaurant hasn’t added any dishes yet.</p>}
      {!!items?.length && !sections.length && <div className="guest-message">
        <p>No dishes match your search.</p>
        <button type="button" onClick={() => { setQuery(''); searchInput.current?.focus(); }}>Clear search</button>
      </div>}
      {sections.map(([name, dishes]) => <section key={name} className="guest-category" aria-labelledby={sectionIds.get(name)}>
        <div className="guest-category-heading">
          <h2 id={sectionIds.get(name)} tabIndex={-1}>{name}</h2>
          <p>{dishes.length} {dishes.length === 1 ? 'item' : 'items'}</p>
        </div>
        <ul className="guest-dishes" role="list">{dishes.map(item => <GuestDish key={item.id} item={item} now={now} sample={menu?.sampleArtwork} />)}</ul>
      </section>)}
    </main>
  </div>;
}

function GuestDish({ item, now, sample }: { item: GuestMenuItem; now: number; sample?: boolean }) {
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const caption = availabilityCaption(item, now);
  const photo = item.photoKey
    ? outlet ? `/media/menu/${outlet}/${item.id}/${item.photoKey}` : menuPhotoPath(item.id, item.photoKey)
    : sample ? sampleDishPhoto(item.name) : undefined;
  const showPhoto = Boolean(photo && photo !== failedKey);
  return <li className="guest-dish" data-photo={showPhoto}>
    {showPhoto && photo && <img src={photo} alt={item.name} width="320" height="220" loading="lazy"
      decoding="async" onError={() => setFailedKey(photo)} />}
    <div className="guest-dish-body">
      <div className="guest-dish-copy"><h3>{item.name}</h3>
        {item.description && <p className="guest-description">{item.description}</p>}
        {caption && <p className="guest-estimate">{caption}</p>}
      </div>
      <div className="guest-dish-meta">
        <strong>{formatPaise(item.pricePaise)}</strong>
        <span className="guest-availability" data-available={item.available}>{item.available ? 'Available' : 'Sold out'}</span>
      </div>
    </div>
  </li>;
}

createRoot(document.getElementById('guest-root')!).render(<GuestMenu />);
