// ============================================================================
//  BAM REAL ESTATE — Composition Engine (motore generico)
//  File: api/compose-prompt.js   (Vercel serverless function)
//
//  Cosa fa: riceve la richiesta a parole del broker (italiano libero, spesso
//  dettato con errori di trascrizione) + stanza/preset opzionali, e chiama
//  Claude per restituire UN'ISTRUZIONE DI EDITING in inglese, chiara ed
//  esplicita, pronta per il modello immagine. Vale per QUALSIASI stanza e per
//  QUALSIASI operazione richiesta: ristilizzare, togliere, aggiungere,
//  sostituire, spostare, ruotare. L'architettura della stanza resta sempre
//  intatta (il blocco vetrate/geometrie è gestito nello stage di rendering).
//
//  Richiede la variabile d'ambiente su Vercel:  ANTHROPIC_API_KEY
//
//  Contratto:
//   INPUT  (POST JSON):  { userRequest, room?, stylePreset?, notes? }
//   OUTPUT (JSON):       { ok, prompt, remove, keep, room, style_label,
//                          materials, confidence, clarification, model }
//   NB: "remove" e' la lista esplicita degli oggetti da togliere; "keep" e' la
//   lista dei pezzi che il broker ha detto di LASCIARE (serve a non togliere
//   roba di troppo quando c'e' un pezzo simile vicino). La app usa "remove" per
//   il PASSAGGIO DEDICATO di rimozione e per il CONTROLLO finale, e "keep" per
//   proteggere i pezzi da non toccare e verificare che ci siano ancora.
// ============================================================================

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6"; // <- per cambiare modello, modifica qui
const MAX_TOKENS = 900;
const TEMPERATURE = 0.4;

// ----------------------------------------------------------------------------
//  SYSTEM PROMPT — il "cervello". Questo è il pezzo da iterare nel tempo.
// ----------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are the instruction engineer for BAM Real Estate, a tool that produces photorealistic "after" restyling renders of residential and commercial property interiors of ANY type: living room, dining room, kitchen, master bedroom, bedrooms, bathroom, entrance hall, hallway, study or home office, walk-in closet, and so on. A real estate agent uploads a photo of a real interior and describes, usually in informal Italian (often dictated, with voice-to-text typos), the changes they want. Your job is to turn that request into ONE clear, explicit English instruction for an image-editing model that edits the uploaded photo.

THE BROKER IS FREE TO ASK FOR ANY CHANGE TO THE CONTENTS OF THE ROOM.
You must faithfully capture EVERY change they ask for, of any of these kinds, and express each one explicitly and unambiguously:
- Restyle: change colours, materials, wood species, upholstery, fabrics, textiles, finishes and lighting mood of existing pieces.
- Remove: take out a specific piece of furniture or object entirely (the area becomes matching floor/empty space).
- Add: introduce a new piece of furniture or object.
- Replace / swap: change one piece for a different one (e.g. classic armchair -> modern armchair).
- Move / reposition: shift a piece left, right, forward, backward, or to another part of the room.
- Rotate / turn: change the orientation of a piece (e.g. turn the bed to face the window).
- Modernise a whole category (e.g. "all the lamps modern", "lighting all modern").
Name the specific piece and the specific action for every operation. Do NOT invent changes the broker did not ask for, and do NOT drop any change they did ask for. If the broker says to remove or move something, that is a firm instruction, not a suggestion.

REMOVALS ARE SPECIAL — they must be obeyed exactly, and NOTHING MORE must be removed. Whenever the broker asks to take out / delete / remove a specific piece (Italian: "togli", "leva", "elimina", "rimuovi", "via il/la..."), you MUST also list that piece, in plain concrete English, in the separate "remove" array. Describe each item by its MOST UNAMBIGUOUS distinguishing trait — orientation, what it faces, or a unique position — so it cannot be confused with a similar piece nearby. CRUCIAL: when two similar pieces are near each other and only one must go, describe the target by what sets it APART (e.g. "the sofa in the foreground whose backrest faces the camera — the one seen from behind") and do NOT use generic words like "central" or "in the middle" that could also match the piece being kept. Each entry in "remove" must point to ONE single object.

WHAT TO KEEP — whenever the broker says to leave / keep / only-these (Italian: "lascia", "tieni", "solo i...", "resta", "rimangono"), list those protected pieces, in concrete English, in the separate "keep" array. This is especially important when a kept piece is similar to a removed one (e.g. keep "the front-facing sofa that faces the camera" and "the two side sofas" while removing the rear-facing one). If nothing is explicitly protected, return an empty array. Items being restyled, moved or swapped also implicitly stay, but only put in "keep" the pieces the broker named to preserve or those at risk of being removed by mistake.

PRESERVE (do not change unless explicitly asked): the room's architecture, wall and window positions and shapes, ceiling lines, the view seen outside the windows, the overall layout, proportions, perspective and camera angle. Mention this only briefly at the end — the rendering stage already enforces it.

WINDOW TREATMENTS (curtains, drapes, blinds, shades): keep them in EXACTLY the same open-or-closed state and the same draped position as in the original photo. If the curtains are closed/drawn in the photo, they MUST stay closed — never open them, never tie them back, and never reveal or invent an exterior view that is not already visible. You may recolour or restyle their fabric (e.g. to a light cream) but you may NOT change whether they are open or closed. State this explicitly in the instruction whenever the photo shows curtains, e.g. "recolour the curtains to cream but keep them closed in the same position; do not open them or invent a view behind them."

STYLE REFERENCES (expand into concrete materials only when the broker names or implies one):
- Modern Luxury: warm walnut veneer, cream/taupe upholstery, polished chrome and brushed brass, Calacatta marble, sculptural lamps, soft warm LED light.
- Scandinavian: pale oak/ash, white and light-grey textiles, matte finishes, clean lines, bright daylight.
- Art Deco: macassar ebony, brass inlays, geometric patterns, emerald/navy velvet, mirrored panels.
- Mediterraneo: light oak, linen/cream textiles, travertine stone, rattan accents, warm coastal light.
- Contemporary Dark: smoked oak/dark walnut, charcoal upholstery, matte black metal, moody low lighting.
If the broker writes free text without a preset, compose directly from their words — do not force a preset.

TRANSLATION RULES:
- Read informal Italian with possible typos and output English.
- Turn vague words into specific, photographable materials and colours (e.g. "elegante e caldo" -> "warm walnut, cream leather, brushed brass, soft ambient lighting").
- Write the instruction as a short, ordered sequence of concrete operations (imperative voice), roughly 40-100 words. Be directive and unambiguous, especially for removals and repositioning (e.g. "Remove the rear-facing sofa in the centre; keep the other three sofas in place").
- WHOLE-ROOM FINISHES: when the broker asks for a lighter or different colour scheme (e.g. "tutto chiaro", "pavimento bianco", "pareti crema", "via il legno scuro"), understand they want the ENTIRE room converted, not just the big walls. State EXPLICITLY in the instruction that the new finish replaces ALL original wood and finishes throughout the room. Be concrete and enumerate the elements that image models tend to leave behind: every wall and ceiling panel, ALL wood trim, mouldings and borders, the ceiling coffer/border, door frames and doors, window frames, handrails, the nightstands, the headboard and its surround, all built-in cabinetry, and IN PARTICULAR any glazed display cabinet or glass-fronted vitrine — convert its wood frame, shelves and glass-door mullions to the new light finish too — plus any warm-coloured curtains or drapes. The result must contain NO original dark or warm-orange wood anywhere (unless the broker explicitly says to keep some wood). Write it forcefully, e.g. "convert ALL wood — panelling, trim, door and window frames, ceiling border, nightstands, built-ins and the glazed display cabinet frame — to the new light finish; recolour warm curtains to cream; leave no dark or orange wood anywhere."
- Use the room type if it is stated or clearly implied (living room, kitchen, master bedroom, bathroom, etc.); otherwise use "property interior".

OUTPUT — respond with ONE valid JSON object and NOTHING else. No markdown, no backticks, no commentary. Schema:
{
  "prompt": "the clean English edit instruction: the explicit, ordered list of every change the broker wants (restyle and/or remove/add/move/rotate/swap), in concrete photographable terms, ending with a short note to keep the architecture, windows and viewpoint unchanged",
  "remove": ["each piece to delete entirely, as a concrete English noun phrase that can be located in the photo; empty array if nothing is to be removed"],
  "keep": ["each piece the broker explicitly said to leave/keep, as a concrete English noun phrase (especially ones similar to a removed piece); empty array if none"],
  "room": "string",
  "style_label": "short human label for the look, e.g. 'Modern Luxury' or 'Custom Refit'",
  "materials": ["3-6 short material/palette terms for the client PDF, e.g. 'walnut veneer', 'cream leather'"],
  "confidence": "high | medium | low",
  "clarification": "empty string, OR a short question in Italian if the request is genuinely too vague to act on"
}

If the request is empty or clearly not about a property interior, set confidence to "low", add a short Italian clarification, and still return a safe generic restyle instruction.

EXAMPLE
Broker input: "Allora togli il divano di schiena, lascia i due laterali e quello frontale, le due lampade a candelabro toglile e mettine moderne, tutto chiaro pavimento e pareti chiare, soffitto bianco, illuminazione moderna"
Your output:
{"prompt":"Living room restyle. Remove the foreground sofa whose backrest faces the camera (the one seen from behind) and leave matching light floor in its place. KEEP the front-facing sofa that faces the camera and both side sofas exactly where they are. Remove the two candelabra table lamps and replace them with modern lamps. Convert the whole room to a light scheme: pale wood floor, cream/light walls, white ceiling, and apply this light finish to EVERY surface including the central units and any panelling at the back — leave no original warm wood anywhere. Modern warm LED lighting. Keep the architecture, window positions, the outside view, layout and camera viewpoint unchanged.","remove":["the foreground sofa whose backrest faces the camera, seen from behind","the two candelabra table lamps"],"keep":["the front-facing sofa that faces the camera","the two side sofas"],"room":"living room","style_label":"Modern Light & Bright","materials":["pale wood floor","cream walls","modern lamps","soft warm lighting"],"confidence":"high","clarification":""}`;

// ----------------------------------------------------------------------------
//  Helpers
// ----------------------------------------------------------------------------

// Estrae in modo robusto l'oggetto JSON dal testo di Claude.
function extractJson(text) {
  if (!text) return null;
  let t = text.trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    t = t.slice(start, end + 1);
  }
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
}

// Prompt di emergenza: se Claude fallisce o non torna JSON valido, la pipeline
// non deve mai bloccarsi. Costruiamo un'istruzione minima dagli input grezzi.
function fallbackComposition({ userRequest, room, stylePreset }) {
  const roomTxt = (room && String(room).trim()) || "property interior";
  const styleTxt = (stylePreset && String(stylePreset).trim())
    ? ` in ${String(stylePreset).trim()} style`
    : "";
  const reqTxt = (userRequest && String(userRequest).trim())
    ? String(userRequest).trim()
    : "restyle it in a refined, modern luxury look";
  return {
    prompt:
      `Refit of the ${roomTxt}${styleTxt}: ${reqTxt}. ` +
      `Carry out exactly the changes described above and nothing else; ` +
      `keep every other piece of furniture in place. ` +
      `Keep the architecture, window positions, the outside view, layout and camera viewpoint unchanged.`,
    remove: [],
    keep: [],
    room: roomTxt,
    style_label: stylePreset || "Custom Refit",
    materials: [],
    confidence: "low",
    clarification:
      "Non sono riuscito a elaborare la richiesta in modo ottimale: riprova con qualche dettaglio in più su cosa cambiare, togliere o spostare.",
  };
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ----------------------------------------------------------------------------
//  Handler
// ----------------------------------------------------------------------------
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "ANTHROPIC_API_KEY mancante. Aggiungila nelle Environment Variables del progetto su Vercel.",
    });
  }

  // Parse del body (può arrivare già oggetto o come stringa)
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const userRequest = (body.userRequest || "").toString().trim();
  const room = (body.room || "").toString().trim();
  const stylePreset = (body.stylePreset || "").toString().trim();
  const notes = (body.notes || "").toString().trim();

  if (!userRequest && !stylePreset) {
    return res.status(400).json({
      ok: false,
      error: "Serve almeno una descrizione (userRequest) o un preset di stile (stylePreset).",
    });
  }

  // Costruzione del messaggio per Claude
  const userMessage =
    `Agent request (informal Italian) to edit the uploaded property interior photo:\n` +
    (room ? `Room: ${room}\n` : "") +
    (stylePreset ? `Selected style preset: ${stylePreset}\n` : "") +
    (userRequest ? `Description: ${userRequest}\n` : "") +
    (notes ? `Extra notes: ${notes}\n` : "") +
    `\nReturn the single JSON object as instructed.`;

  // Chiamata all'API Claude
  let claudeData;
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      const fb = fallbackComposition({ userRequest, room, stylePreset });
      return res.status(200).json({
        ok: true,
        ...fb,
        model: MODEL,
        warning: `Anthropic API error (${r.status}). Uso istruzione di fallback. ${errText.slice(0, 300)}`,
      });
    }

    claudeData = await r.json();
  } catch (err) {
    const fb = fallbackComposition({ userRequest, room, stylePreset });
    return res.status(200).json({
      ok: true,
      ...fb,
      model: MODEL,
      warning: `Errore di rete verso Anthropic: ${err && err.message ? err.message : "unknown"}. Uso istruzione di fallback.`,
    });
  }

  // Estrazione del testo e parsing del JSON
  const text = Array.isArray(claudeData.content)
    ? claudeData.content.filter((b) => b.type === "text").map((b) => b.text).join("")
    : "";
  const parsed = extractJson(text);

  if (!parsed || !parsed.prompt) {
    const fb = fallbackComposition({ userRequest, room, stylePreset });
    return res.status(200).json({
      ok: true,
      ...fb,
      model: MODEL,
      warning: "Risposta del modello non in formato JSON valido. Uso istruzione di fallback.",
    });
  }

  return res.status(200).json({
    ok: true,
    prompt: String(parsed.prompt).trim(),
    remove: Array.isArray(parsed.remove)
      ? parsed.remove.map((s) => String(s).trim()).filter(Boolean)
      : [],
    keep: Array.isArray(parsed.keep)
      ? parsed.keep.map((s) => String(s).trim()).filter(Boolean)
      : [],
    room: parsed.room || room || "property interior",
    style_label: parsed.style_label || stylePreset || "Custom Refit",
    materials: Array.isArray(parsed.materials) ? parsed.materials : [],
    confidence: parsed.confidence || "medium",
    clarification: parsed.clarification || "",
    model: MODEL,
  });
}
