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
  image: string;
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
