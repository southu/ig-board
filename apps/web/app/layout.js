import './globals.css';
import ThemeToggle from '../components/ThemeToggle';

export const metadata = {
  title: 'Boardroom — The Image Group',
  description: 'Private governance BI for The Image Group board.'
};

// Runs synchronously in <head>, before any app bundle, so the correct theme is
// applied on the very first paint (no flash on hard reload). Priority: an
// explicit choice in localStorage, then the OS prefers-color-scheme, then light.
// A post-build step (scripts/hoist-theme-head.mjs) moves this to the very top of
// <head> in the exported HTML, ahead of Next's async bundle tags.
const THEME_INIT = `(function(){try{var k='ig-board.theme';var t=localStorage.getItem(k);if(t!=='light'&&t!=='dark'){t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          data-theme-init=""
          dangerouslySetInnerHTML={{ __html: THEME_INIT }}
        />
      </head>
      <body>
        <div className="app-frame">
          <header className="app-header">
            <a className="brand" href="/">
              Boardroom
            </a>
            <ThemeToggle />
          </header>
          <main className="app-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
