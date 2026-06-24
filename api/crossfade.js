// api/crossfade.js — unisce le clip con DISSOLVENZA (xfade) tra una e l'altra
// e applica UNA traccia musicale CC0 su tutta la durata, poi carica il risultato
// nel bucket privato dossier-videos. Tutto via ffmpeg, lato server.
import { spawn } from "child_process";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");

export const config = { maxDuration: 60 };

const SUPABASE_URL = "https://ruedykgseogsmieqmffd.supabase.co";
const SUPABASE_ANON = "sb_publishable_jDuqu9CMy_yg4rY41jtXPA_cJWcIMxD"; // chiave pubblica
const MUSIC_URL = "https://raw.githubusercontent.com/SoundSafari/CC0-1.0-Music/main/freepd.com/Martini%20Sunset.mp3";
const T = 1.5;        // durata della dissolvenza (secondi)
const W = 1920, H = 1080;

function run(args) {
  return new Promise(function (resolve) {
    const p = spawn(ffmpegPath, args);
    let err = "";
    p.stderr.on("data", function (d) { err += d.toString(); });
    p.on("close", function (code) { resolve({ code: code, err: err }); });
    p.on("error", function (e) { resolve({ code: -1, err: String(e) }); });
  });
}

function parseDurFps(stderr) {
  let dur = 0, fps = 24;
  const dm = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (dm) dur = (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);
  const fm = stderr.match(/,\s*([\d.]+)\s*fps/);
  if (fm) fps = parseFloat(fm[1]);
  return { dur: dur, fps: fps };
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("download " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(dest, buf);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const urls = body && body.urls;
  const jwt = body && body.jwt;
  const outPath = body && body.path;
  if (!Array.isArray(urls) || urls.length < 2 || !jwt || !outPath) return res.status(400).json({ error: "Missing urls/jwt/path" });
  if (/\.\./.test(String(outPath))) return res.status(400).json({ error: "Bad path" });

  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), "xf-"));

    // 1) scarico le clip + la musica
    const files = [];
    for (let i = 0; i < urls.length; i++) {
      const f = path.join(dir, "c" + i + ".mp4");
      await download(urls[i], f);
      files.push(f);
    }
    const musicFile = path.join(dir, "music.mp3");
    await download(MUSIC_URL, musicFile);

    // 2) durata + fps di ogni clip
    const durs = [];
    let fps = 24;
    for (let i = 0; i < files.length; i++) {
      const probe = await run(["-i", files[i]]);
      const d = parseDurFps(probe.err);
      durs.push(d.dur || 8);
      if (i === 0 && d.fps) fps = d.fps;
    }

    // 3) filtro: normalizzo ogni clip, poi catena di dissolvenze, poi musica
    const parts = [];
    for (let k = 0; k < files.length; k++) {
      parts.push("[" + k + ":v]fps=" + fps + ",format=yuv420p,scale=" + W + ":" + H + ":force_original_aspect_ratio=decrease,pad=" + W + ":" + H + ":-1:-1,setsar=1,settb=AVTB[n" + k + "]");
    }
    let label = "n0", total = durs[0];
    for (let k = 1; k < files.length; k++) {
      const off = Math.max(0, Math.round((total - T) * 1000) / 1000);
      const out = (k === files.length - 1) ? "vout" : ("v" + k);
      parts.push("[" + label + "][n" + k + "]xfade=transition=dissolve:duration=" + T + ":offset=" + off + "[" + out + "]");
      label = out; total = total + durs[k] - T;
    }
    const fadeAt = Math.max(0, Math.round((total - 1) * 1000) / 1000);
    const musicIdx = files.length;
    parts.push("[" + musicIdx + ":a]volume=0.85,afade=t=out:st=" + fadeAt + ":d=1[aout]");
    const fc = parts.join(";");

    // 4) eseguo ffmpeg
    const args = [];
    for (let i = 0; i < files.length; i++) args.push("-i", files[i]);
    args.push("-i", musicFile, "-filter_complex", fc, "-map", "[vout]", "-map", "[aout]", "-shortest",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-movflags", "+faststart", path.join(dir, "out.mp4"));
    const enc = await run(args);
    if (enc.code !== 0) return res.status(500).json({ error: "ffmpeg failed", detail: enc.err.slice(-400) });

    // 5) carico il risultato nel bucket privato come l'utente
    const outBuf = await readFile(path.join(dir, "out.mp4"));
    const up = await fetch(SUPABASE_URL + "/storage/v1/object/dossier-videos/" + encodeURI(outPath), {
      method: "POST",
      headers: { "Authorization": "Bearer " + jwt, "apikey": SUPABASE_ANON, "Content-Type": "video/mp4", "x-upsert": "true" },
      body: outBuf
    });
    if (!up.ok) { const t = await up.text(); return res.status(up.status).json({ error: "Upload failed: " + t.slice(0, 300) }); }

    return res.status(200).json({ ok: true, path: outPath, seconds: Math.round(total) });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  } finally {
    if (dir) { try { await rm(dir, { recursive: true, force: true }); } catch (_) {} }
  }
}
