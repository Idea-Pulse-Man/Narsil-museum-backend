/**
 * Shareable artwork links.
 *
 *   GET /share/:id — a tiny HTML page whose Open Graph / Twitter tags make
 *     WhatsApp, iMessage, Slack, X… render the painting, title and artist as
 *     a preview card. A person who taps it is sent on to the web app's
 *     `?art=<id>` deep link; on iPhone Safari also shows the App Store banner.
 *   GET /.well-known/apple-app-site-association — lets the installed iPhone
 *     app open /share/* links directly (Universal Links). Needs APPLE_TEAM_ID
 *     and the Associated Domains capability in Xcode
 *     (applinks:<this backend's host>).
 *
 * Crawlers don't run JavaScript, so they read the tags; browsers run the
 * redirect.
 */
import { Router } from "express";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../services/supabaseAdmin.js";

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const summarize = (text: string, max = 200): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max)}…`;
};

interface ShareArtwork {
  id: string;
  title: string;
  description: string | null;
  ai_description: string | null;
  image_url: string | null;
  image_width: number | null;
  image_height: number | null;
  artist_id: string | null;
  hidden: boolean | null;
  year: string | null;
}

async function loadShareArtwork(
  id: string,
): Promise<{ art: ShareArtwork; artist: string | null } | null> {
  const db = supabaseAdmin();
  const { data } = await db
    .from("artworks")
    .select(
      "id, title, description, ai_description, image_url, image_width, image_height, artist_id, hidden, year",
    )
    .eq("id", id)
    .maybeSingle();
  const art = data as ShareArtwork | null;
  if (!art || art.hidden) return null;
  let artist: string | null = null;
  if (art.artist_id) {
    const { data: a } = await db
      .from("artists")
      .select("name")
      .eq("id", art.artist_id)
      .maybeSingle();
    artist = (a as { name?: string } | null)?.name ?? null;
  }
  return { art, artist };
}

function page(opts: {
  title: string;
  description: string;
  image: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  shareUrl: string;
  openUrl: string;
}): string {
  const t = escapeHtml(opts.title);
  const d = escapeHtml(opts.description);
  const open = escapeHtml(opts.openUrl);
  const appId = env.apple.appAppleId;
  const appStoreUrl = appId ? `https://apps.apple.com/app/id${appId}` : null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Narsil">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${escapeHtml(opts.shareUrl)}">
${opts.image ? `<meta property="og:image" content="${escapeHtml(opts.image)}">` : ""}
${opts.imageWidth ? `<meta property="og:image:width" content="${opts.imageWidth}">` : ""}
${opts.imageHeight ? `<meta property="og:image:height" content="${opts.imageHeight}">` : ""}
<meta name="twitter:card" content="${opts.image ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
${opts.image ? `<meta name="twitter:image" content="${escapeHtml(opts.image)}">` : ""}
${appId ? `<meta name="apple-itunes-app" content="app-id=${appId}, app-argument=${escapeHtml(opts.shareUrl)}">` : ""}
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#14100e;color:#f5efe6;font-family:Georgia,serif;text-align:center;padding:24px;box-sizing:border-box}
  main{max-width:420px}
  img{max-width:100%;max-height:60vh;border-radius:12px}
  h1{font-size:22px;margin:20px 0 8px}
  p{font-family:-apple-system,system-ui,sans-serif;font-size:14px;color:#bdb3a6;line-height:1.5}
  a.btn{display:inline-block;margin:12px 6px 0;padding:12px 20px;border-radius:999px;background:#d9b46c;color:#14100e;font-family:-apple-system,system-ui,sans-serif;font-weight:600;text-decoration:none}
  a.alt{background:transparent;color:#f5efe6;border:1px solid #f5efe655}
</style>
</head>
<body>
<main>
${opts.image ? `<img src="${escapeHtml(opts.image)}" alt="${t}">` : ""}
<h1>${t}</h1>
<p>${d}</p>
<a class="btn" href="${open}">Open in Narsil</a>
${appStoreUrl ? `<a class="btn alt" href="${appStoreUrl}">Get the iPhone app</a>` : ""}
</main>
<script>setTimeout(function(){location.replace(${JSON.stringify(opts.openUrl)})},1200);</script>
</body>
</html>`;
}

export function shareRoutes(): Router {
  const router = Router();

  router.get("/share/:id", async (req, res) => {
    const id = req.params.id;
    const shareUrl = `${env.publicBaseUrl}/share/${encodeURIComponent(id)}`;
    const openUrl = `${env.webAppUrl}/?art=${encodeURIComponent(id)}`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    try {
      const found = await loadShareArtwork(id);
      if (!found) {
        res.status(404).send(
          page({
            title: "Narsil",
            description: "This artwork is no longer in the collection.",
            image: null,
            shareUrl,
            openUrl: env.webAppUrl,
          }),
        );
        return;
      }
      const { art, artist } = found;
      const title = artist ? `${art.title} — ${artist}` : art.title;
      const prose = art.ai_description || art.description || "";
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(
        page({
          title,
          description: summarize(prose) || `${art.title}${art.year ? `, ${art.year}` : ""} — on Narsil.`,
          image: art.image_url,
          imageWidth: art.image_width,
          imageHeight: art.image_height,
          shareUrl,
          openUrl,
        }),
      );
    } catch {
      // Supabase down — still send the person somewhere useful.
      res.redirect(302, openUrl);
    }
  });

  router.get("/.well-known/apple-app-site-association", (_req, res) => {
    if (!env.apns.teamId) {
      res.status(404).json({ error: "Not Found", message: "APPLE_TEAM_ID is not set." });
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.json({
      applinks: {
        details: [
          {
            appIDs: [`${env.apns.teamId}.${env.apple.bundleId}`],
            components: [{ "/": "/share/*", comment: "Shared artwork links" }],
          },
        ],
      },
    });
  });

  return router;
}
