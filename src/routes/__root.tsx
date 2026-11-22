import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import appCss from "../styles.css?url";

// Respect the build base (e.g. /<repo>/ on GitHub Pages project sites) so
// static assets in head don't 404.
const base = import.meta.env.BASE_URL;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Dailyfuscator" },
      { name: "theme-color", content: "#0c0c0a" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: `${base}favicon.svg` },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: `${base}__grok/manifest.webmanifest` },
      { rel: "apple-touch-icon", href: `${base}__grok/icon-180.png` },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Newsreader:opsz,wght@6..72,480;6..72,600&display=swap",
      },
    ],
  }),
  component: () => (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <PreviewHostBridge />
        <AuthProvider>
          <Outlet />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  ),
});
