// api/save-video.js — copia un video (URL Replicate temporaneo) nel bucket privato
// "dossier-videos" del progetto Supabase, come l'utente autenticato (RLS: cartella = suo uid).
// Necessario perche' il browser non puo' leggere i byte da replicate.delivery (CORS).
export const config = { maxDuration: 60 };

const SUPABASE_URL = "https://ruedykgseogsmieqmffd.supabase.co";
const SUPABASE_ANON = "sb_publishable_jDuqu9CMy_yg4rY41jtXPA_cJWcIMxD"; // chiave pubblica

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const url = body && body.url;
  const path = body && body.path;
  const jwt = body && body.jwt;

  if (!url || !path || !jwt) return res.status(400).json({ error: "Missing url, path or jwt" });
  if (!/^https:\/\//.test(String(url))) return res.status(400).json({ error: "Bad url" });
  if (/\.\./.test(String(path))) return res.status(400).json({ error: "Bad path" });

  try {
    // 1) scarico il video lato server (niente blocco CORS)
    const vid = await fetch(url);
    if (!vid.ok) return res.status(502).json({ error: "Fetch video failed: " + vid.status });
    const buf = Buffer.from(await vid.arrayBuffer());

    // 2) carico nel bucket privato come l'utente (RLS controlla che la cartella sia il suo uid)
    const up = await fetch(SUPABASE_URL + "/storage/v1/object/dossier-videos/" + encodeURI(path), {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + jwt,
        "apikey": SUPABASE_ANON,
        "Content-Type": "video/mp4",
        "x-upsert": "true"
      },
      body: buf
    });
    if (!up.ok) {
      const t = await up.text();
      return res.status(up.status).json({ error: "Upload failed: " + t.slice(0, 300) });
    }
    return res.status(200).json({ ok: true, path: path });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
