# narsil-museum-backend

REST API backend for the **Narsil** museum app (`museum-app`). It sources
real, public-domain artworks and their artists from a museum **Public API**,
builds each artwork's image URL via the **IIIF Image API 3.0**, extracts the
title, description/content, medium, dating and artist information, and serves it
all in the exact shape the frontend already consumes.

Two museum sources are supported (see [`MUSEUM_SOURCE`](#configuration)):

- **`wellcome`** (default) — [Wellcome Collection](https://developers.wellcomecollection.org/).
  Its IIIF Image API 3.0 server (`iiif.wellcomecollection.org`) serves requests
  to the backend, so images are fetched server-side and **streamed** to the app
  from this origin — they always display, regardless of the browser's own
  network access to the museum.
- **`artic`** — [Art Institute of Chicago](https://api.artic.edu/docs/). Richer
  fine-art metadata, but its IIIF image server (`www.artic.edu`) blocks
  non-browser clients, so images can only be delivered by redirect and may be
  unreachable on some networks.

Built with Node.js, Express, and TypeScript.

## How it satisfies the client requirements

- **Art images via IIIF Image API 3.0** — `src/museum/iiif.ts` builds canonical
  IIIF 3.0 request URLs
  (`{base}/{identifier}/{region}/{size}/{rotation}/{quality}.{format}`) from
  each artwork's image identifier. The base URL is configurable and can be
  auto-discovered from the museum API's `config.iiif_url`. By default the
  backend then **fetches those IIIF images server-side and streams them** to the
  app via `GET /api/image/:identifier` (see [Image delivery](#image-delivery)),
  so images load from the app's own origin and never hit cross-origin, hotlink,
  or image-server bot-blocking issues.
- **Description, content, title & artist info from the museum API** — the source
  modules (`src/museum/wellcome.ts`, `src/museum/artic.ts`) pull those fields
  from the Public API and map them onto the frontend's `Artwork` / `Artist`
  types. When a record has no written description, a clean placard is synthesised
  from the medium, date, place and subjects so the feed always has content.
- **Displayed in the frontend** — the endpoints return the `{ data, total }`
  envelope that `museum-app/src/lib/api.ts` → `fetchRemoteCatalog()` already
  expects, and `artwork.artistId` matches `artist.id`, so the app's feed,
  search, discover, artist profiles and history all light up with no frontend
  changes.

## Requirements

- Node.js 18.18+ (Node 20+ recommended). Uses the built-in `fetch`.

## Setup

```bash
npm install
cp .env.example .env   # (Windows: copy .env.example .env)
```

## Scripts

```bash
npm run dev        # start dev server with hot reload (tsx)
npm run build      # compile TypeScript to dist/
npm run start      # run the compiled production build
npm run typecheck  # type-check without emitting
```

The server runs on **http://localhost:4000** by default.

## Connecting the frontend

The `museum-app` client reads its base URL from `VITE_API_URL` and falls back to
`http://localhost:4000`. To point it here explicitly, add to `museum-app/.env`:

```bash
VITE_API_URL=http://localhost:4000
```

Set `CORS_ORIGIN` in this project's `.env` to match the frontend dev server
(Vite defaults to `http://localhost:5173`), or use `*` for LAN / mobile / ngrok
testing.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service info |
| GET | `/api/health` | Health check |
| GET | `/api/artworks` | List artworks → `{ data, total }` |
| GET | `/api/artworks/:id` | Get one artwork |
| GET | `/api/artists` | List artists → `{ data, total }` |
| GET | `/api/artists/:id` | Get one artist |
| GET | `/api/image/:identifier` | Proxy/stream an IIIF 3.0 image (`?w=<px>`, `?full=1`) |
| POST | `/api/refresh` | Drop the cache; next request rebuilds |

## Image delivery

Every image originates from an IIIF Image API 3.0 server. How the frontend
receives it is set by `IMAGE_DELIVERY`:

- **`proxy`** (default) — `artwork.image` points at this backend
  (`{PUBLIC_BASE_URL}/api/image/:identifier`). The `/api/image` route delivers
  the IIIF 3.0 image with a **resilient two-step strategy**:
  1. **Stream** — fetch the IIIF image server-side and pipe the bytes back, so
     the app loads it from this origin (no CORS/hotlink issues). This works for
     image servers that permit server-side requests (Getty, Wellcome, most IIIF
     servers).
  2. **Redirect** — if the image server refuses the backend (e.g. the Art
     Institute of Chicago's `www.artic.edu/iiif` WAF returns `403` to
     non-browser clients), the route `302`-redirects the browser to the direct
     IIIF 3.0 URL. Real browsers pass the WAF — embedding these IIIF URLs in an
     `<img>` is AIC's documented, supported use case — so the image loads
     normally. Refusing hosts are remembered so later requests redirect at once.

  This is what turns a `502 Bad Gateway` (from a blocked server-side fetch) into
  a working image, while still keeping the backend as the image entry point.
- **`direct`** — `artwork.image` is the raw upstream IIIF 3.0 URL
  (`https://www.artic.edu/iiif/2/{id}/full/843,/0/default.jpg`). Skips the proxy
  hop entirely; the browser always loads the IIIF image directly. Fastest for a
  source like AIC whose image server only serves browsers.

### Response shapes

`Artwork` and `Artist` mirror `museum-app/src/data/types.ts` exactly:

```jsonc
// GET /api/artworks
{
  "data": [
    {
      "id": "aic-28560",
      "title": "The Bedroom",
      "artistId": "aic-agent-34123",
      "year": "1889",
      "period": "Post-Impressionism",
      "medium": "Oil on canvas",
      "source": "Helen Birch Bartlett Memorial Collection",
      "image": "https://www.artic.edu/iiif/2/<image_id>/full/843,/0/default.jpg",
      "accent": "#3a2f1c",
      "description": "…museum prose or a synthesised placard…",
      "tags": ["Post-Impressionism", "Painting", "Interiors"],
      "category": "modern-art",
      "origin": "public-domain",
      "empire": "…only when applicable…"
    }
  ],
  "total": 80
}
```

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4000` | HTTP port |
| `CORS_ORIGIN` | `http://localhost:5173,http://localhost:3000` | Allowed origins (`*` = any) |
| `PUBLIC_BASE_URL` | `http://localhost:4000` | This backend's public origin (for proxied image URLs) |
| `IMAGE_DELIVERY` | `proxy` | `proxy` (stream via backend) or `direct` (raw IIIF URL) |
| `MUSEUM_SOURCE` | `wellcome` | `wellcome` or `artic` |
| `MUSEUM_API_BASE_URL` | per-source default | Museum Public API base (unset ⇒ source default) |
| `IIIF_BASE_URL` | per-source default | IIIF Image API server base (unset ⇒ source default) |
| `IIIF_IMAGE_WIDTH` | `800` | Requested image width (IIIF size `"{width},"`) |
| `CATALOG_LIMIT` | `80` | How many public-domain artworks to ingest |
| `CATALOG_CACHE_TTL_MS` | `3600000` | In-memory catalog cache lifetime |

## Project structure

```
src/
├── index.ts                # Entry point — boots + warms the catalog cache
├── app.ts                  # Express app factory (CORS, routes, error handling)
├── config/env.ts           # Validated environment configuration
├── types/domain.ts         # Artwork / Artist domain types (mirror frontend)
├── middleware/             # 404 + error handler
├── routes/                 # health, artworks, artists, image proxy, refresh
├── museum/
│   ├── source.ts           # MuseumSource interface + CatalogData
│   ├── iiif.ts             # IIIF Image API 3.0 URL builder
│   ├── imaging.ts          # Image delivery strategy (proxy vs direct)
│   ├── wellcome.ts         # Wellcome Collection client + domain mapping (default)
│   ├── artic.ts            # Art Institute of Chicago client + domain mapping
│   ├── taxonomy.ts         # Museum metadata → Discover category / empire
│   └── catalog.ts          # Selects source, aggregates + caches the read model
└── utils/                  # http (fetch + timeout), cache (TTL), text helpers
```

## Notes

- The Public API exposes no social graph, so per-artist `followers` / `likes` /
  `saves` are **deterministically synthesised** from the artist id (stable
  across restarts) purely so profile screens render richly. Swap for real data
  when a users/engagement store exists.
- The Art Institute's image server (`www.artic.edu/iiif`) sits behind a WAF that
  returns `403` to non-browser HTTP clients (Node's `fetch`, curl, …) by
  fingerprinting the client — adding browser headers is **not** enough. Its data
  API (`api.artic.edu`) is open, and real browsers load the IIIF images fine
  (embedding them is AIC's documented use). The default `proxy` mode handles
  this automatically: it tries a server-side stream, and when AIC refuses it,
  `302`-redirects the browser to load the IIIF URL directly. Set
  `IMAGE_DELIVERY=direct` to skip the proxy hop and emit AIC IIIF URLs straight
  to the frontend.
- To target a different museum, add a sibling to `src/museum/artic.ts` that
  produces the same `CatalogData` and wire it in `catalog.ts`. Nothing else
  needs to change.
"# Narsil-museum-backend" 
