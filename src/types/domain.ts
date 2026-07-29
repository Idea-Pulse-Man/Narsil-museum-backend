/**
 * Core domain types — a faithful mirror of the museum-app frontend
 * (`museum-app/src/data/types.ts`). The backend produces exactly these shapes
 * so the app can consume `/api/artworks` and `/api/artists` with no adapters.
 */

export type ArtistProfileType = "historical" | "freelance";

export interface Artist {
  id: string;
  name: string;
  initials: string;
  profileType: ArtistProfileType;
  lifespan: string;
  nationality: string;
  period: string;
  style: string;
  knownFor: string;
  bio: string;
  followers: number;
  likes: number;
  saves: number;
  accent?: string;
  avatar?: string;
}

export type ArtworkOrigin = "public-domain" | "artist-original" | "fan-study";

export type CategoryId =
  | "paintings"
  | "sculptures"
  | "pottery"
  | "etching-writing-books"
  | "roman"
  | "greek"
  | "egyptian"
  | "renaissance"
  | "medieval"
  | "japanese-art"
  | "modern-art";

export interface Artwork {
  id: string;
  title: string;
  artistId: string;
  year: string;
  period: string;
  medium: string;
  source: string;
  /**
   * Display image — the staged S3 copy, ingested at `INGEST_IMAGE_WIDTH`
   * (843px). Fast and cheap to serve, but NOT suitable for printing or for a
   * high-resolution download.
   */
  image: string;
  /**
   * The museum's own image URL, before staging. This is where full resolution
   * comes from: for IIIF sources the size segment is rewritten to `max`, so the
   * same URL yields both the 2000px free download and the master.
   *
   * Used by the print file sent to Printful and by the high-resolution
   * download. Falls back to `image` when absent (rows ingested before this
   * field existed), which is lossy — re-run the ingest to populate it.
   */
  sourceImage?: string;
  /** Master pixel dimensions, when the source reports them (IIIF info.json). */
  imageWidth?: number;
  imageHeight?: number;
  /** Dominant color used for the blur-up placeholder background. */
  accent: string;
  description: string;
  tags: string[];
  category: CategoryId;
  origin: ArtworkOrigin;
  /** Ancient civilisation / empire, when applicable. */
  empire?: string;
}

/** Envelope shared by both list endpoints (matches the frontend client). */
export interface ListResponse<T> {
  data: T[];
  total: number;
}
