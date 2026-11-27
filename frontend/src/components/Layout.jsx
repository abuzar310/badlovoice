import React, { useCallback, useEffect, useRef, useState } from 'react';

const TABS = [
  { id: 'studio', label: 'Studio', title: 'BadloVoice — live voice changer' },
  { id: 'models', label: 'Models', title: 'Models · BadloVoice' },
  { id: 'converter', label: 'Converter', title: 'Converter · BadloVoice' },
];

const MODES = [
  { id: 'simple', label: 'Simple' },
  { id: 'studio', label: 'Studio' },
  { id: 'advanced', label: 'Advanced' },
];

const THEME_KEY = 'badlovoice_theme';
const LAYOUT_KEY = 'badlovoice_layout_v2';
// Same breakpoint as the Studio grid (Tailwind `lg`) and the inline script in index.html.
const WIDE_QUERY = '(min-width: 1024px)';
// From here up the responsive layout already is the three-column one.
const ROOMY_QUERY = '(min-width: 1280px)';
// Below this the phone header stacks into two rows (see index.css).
const HEADER_ONE_ROW_QUERY = '(min-width: 768px)';

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let media;
    try {
      media = window.matchMedia(query);
    } catch {
      return undefined;
    }
    const sync = () => setMatches(media.matches);
    sync();
    // Safari before 14 only has the deprecated listener API.
    if (media.addEventListener) media.addEventListener('change', sync);
    else media.addListener(sync);
    return () => {
      if (media.removeEventListener) media.removeEventListener('change', sync);
      else media.removeListener(sync);
    };
  }, [query]);

  return matches;
}

function isNativeApp() {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

function readForcedDesktop() {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved === 'desktop') return true;
    // Older builds saved the detected layout ("phone"/"auto") as if the user
    // had picked it, which pinned the app to one layout after a resize or a
    // rotation. Only the explicit desktop opt-in is worth remembering.
    if (saved) localStorage.removeItem(LAYOUT_KEY);
    localStorage.removeItem('badlovoice_layout');
  } catch {
    // ignore
  }
  return false;
}

function resetSidewaysScroll() {
  window.scrollTo(0, window.scrollY || 0);
  document.documentElement.scrollLeft = 0;
  document.body.scrollLeft = 0;
}

/**
 * phone   — stacked, no sideways pan (narrow screens and the Android app)
 * auto    — responsive (wide browser windows)
 * desktop — opt-in wide three-column canvas you can pan sideways
 */
function useLayoutMode() {
  const [forcedDesktop, setForcedDesktop] = useState(readForcedDesktop);
  const wide = useMediaQuery(WIDE_QUERY);
  const layout = forcedDesktop ? 'desktop' : isNativeApp() || !wide ? 'phone' : 'auto';

  useEffect(() => {
    document.documentElement.setAttribute('data-layout', layout);
    if (layout !== 'desktop') {
      resetSidewaysScroll();
      requestAnimationFrame(resetSidewaysScroll);
    }
  }, [layout]);

  const toggleDesktop = useCallback(() => {
    setForcedDesktop((on) => {
      const next = !on;
      try {
        if (next) localStorage.setItem(LAYOUT_KEY, 'desktop');
        else localStorage.removeItem(LAYOUT_KEY);
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return { layout, forcedDesktop, toggleDesktop, wide };
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
    // The browser's own bars (address bar, Android status bar) follow the top bar.
    const surface = getComputedStyle(root).getPropertyValue('--surface').trim();
    if (surface) {
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', surface);
    }
  }, [theme]);

  const dark = theme === 'dark';
  return (
    <button
      type="button"
      className={`mode-toggle ${dark ? 'mode-toggle-on' : ''}`}
      title={dark ? 'Switch to the light theme' : 'Switch to the dark theme'}
      aria-pressed={dark}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      Dark<span className="sr-only"> theme</span>
    </button>
  );
}

function LayoutToggle({ on, onToggle }) {
  return (
    <button
      type="button"
      className={`mode-toggle ${on ? 'mode-toggle-on' : ''}`}
      title={
        on
          ? 'Back to the layout that fits this screen'
          : 'Wide three-column layout — swipe sideways to see it all'
      }
      aria-pressed={on}
      onClick={onToggle}
    >
      Desktop<span className="sr-only"> layout</span>
    </button>
  );
}

function TabNav({ tab, onTabChange, className = '' }) {
  return (
    <nav className={className} aria-label="Sections">
      <div className="seg">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="seg-item"
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => onTabChange?.(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </nav>
  );
}

function LivePill({ isLive, className = '' }) {
  return (
    <span
      className={`status-pill ${isLive ? 'status-pill-live' : 'status-pill-off'} ${className}`}
      role="status"
    >
      <span
        className={`h-2 w-2 rounded-full ${isLive ? 'bg-accent rec-blink' : 'bg-ink/30'}`}
        aria-hidden="true"
      />
      <span className="sr-only">Voice changer: </span>
      {isLive ? 'LIVE' : 'Idle'}
    </span>
  );
}

export default function Layout({
  children,
  tab,
  onTabChange,
  statusSlot = null,
  headerActions = null,
  density = 'studio',
  onDensityChange = null,
  isLive = false,
}) {
  const { layout, forcedDesktop, toggleDesktop, wide } = useLayoutMode();
  const roomy = useMediaQuery(ROOMY_QUERY);
  const headerFitsOneRow = useMediaQuery(HEADER_ONE_ROW_QUERY);
  // Stacked phone header: logo, theme and settings on the first row, the view switch on the second.
  const stackedHeader = layout === 'phone' && !headerFitsOneRow;
  // On a roomy window the wide layout is what you already have, so the switch
  // would do nothing visible. Keep it reachable whenever it is switched on.
  const showLayoutToggle = forcedDesktop || !roomy || isNativeApp();
  // Wide canvas on a small screen: the right end of the bar is a long swipe
  // away, so the way back sits next to the logo instead.
  const layoutToggleLeads = forcedDesktop && !wide;

  // Phone: note when the header has scrolled away and the tab row is pinned.
  const headerRef = useRef(null);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const header = headerRef.current;
    if (layout !== 'phone' || !header || typeof IntersectionObserver === 'undefined') {
      setPinned(false);
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => setPinned(!entry.isIntersecting));
    observer.observe(header);
    return () => observer.disconnect();
  }, [layout]);

  useEffect(() => {
    const current = TABS.find((item) => item.id === tab);
    if (current) document.title = current.title;
  }, [tab]);

  const tools = (
    <div className="shell-tools" key="tools">
      <LivePill isLive={isLive} className="shell-live" />
      {statusSlot}
      {onDensityChange && (
        <div className="shell-view">
          {/* Shown on the phone, where this row sits right above the tabs
              and both have an item called "Studio". */}
          <span id="shell-view-label" className="shell-view-label field-label">
            View
          </span>
          <div className="seg seg-boxed" role="group" aria-labelledby="shell-view-label">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className="seg-item"
                aria-pressed={density === mode.id}
                onClick={() => onDensityChange(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {showLayoutToggle && !layoutToggleLeads && (
        <LayoutToggle on={forcedDesktop} onToggle={toggleDesktop} />
      )}
    </div>
  );

  const quick = (
    <div className="shell-quick" key="quick">
      <ThemeToggle />
      {headerActions}
    </div>
  );

  return (
    <div className="badlovoice flex min-h-screen flex-col text-ink">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>

      <header className="shell-bar" ref={headerRef}>
        <div className="shell-header mx-auto w-full max-w-[1560px]">
          <div className="shell-brand">
            <img
              src={`${import.meta.env.BASE_URL}brand-mark-app.png`}
              alt=""
              width={36}
              height={36}
              className="brand-mark shrink-0"
              draggable={false}
            />
            <div className="min-w-0 leading-tight">
              <p className="font-display truncate text-xl font-bold tracking-[-0.03em]">
                BadloVoice
              </p>
              <p className="truncate text-xs text-muted">Voice studio</p>
            </div>
          </div>

          {layoutToggleLeads && <LayoutToggle on onToggle={toggleDesktop} />}

          <TabNav className="shell-tabs" tab={tab} onTabChange={onTabChange} />

          {/* DOM order follows the reading order of each layout, so Tab does too:
              in the stacked header the theme and settings buttons come first. */}
          {stackedHeader ? [quick, tools] : [tools, quick]}
        </div>
      </header>

      {/* Phone only (see index.css): the row that stays pinned while the page scrolls. */}
      <div className="shell-pin" data-stuck={pinned ? 'true' : undefined}>
        <TabNav tab={tab} onTabChange={onTabChange} />
        <LivePill isLive={isLive} />
      </div>

      <main id="main-content" tabIndex={-1} className="flex-1">
        <div className="shell-main mx-auto w-full max-w-[1560px] py-4 sm:py-5">
          {tab === 'studio' && <h1 className="sr-only">Studio</h1>}
          {children}
        </div>
      </main>

      <footer className="shell-footer border-t border-line pt-3">
        <p className="mx-auto w-full max-w-[1560px] text-center text-xs text-muted sm:text-left">
          BadloVoice
          <span className="mx-1.5" aria-hidden="true">
            ·
          </span>
          Built by Abuzar
        </p>
      </footer>
    </div>
  );
}
