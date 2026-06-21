export default async function handler(req, res) {
  const path = req.query.path || "";
  if (!path.startsWith("/v1")) {
    return res.status(400).json({ error: "Invalid path" });
  }

  const targetUrl = "https://api.replicate.com" + path;
  const auth = req.headers.authorization;
  if (!auth) {
    return res.status(401).json({ error: "Authorization header missing" });
  }

  const headers = {
    "Authorization": auth,
    "Content-Type": "application/json",
  };

  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });
    const data = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    res.send(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
