// Service Worker von Mmaah Intern (Online Fassung).
// Fängt api/katalog, t/<breite>/<datei> und d/<datei> ab, holt die verschlüsselten Blöcke (b/<id>.bin),
// entschlüsselt sie mit dem Schlüssel aus IndexedDB und liefert sie wie der lokale Server aus (auch Range für Videos).
const DBN = "mmaah-intern-v1"
const SCOPE = new URL(self.registration.scope)
let KEY = null, MAP = null, KAT = null
const RAM = new Map()
let ramBytes = 0
const RAM_MAX = 160 * 1024 * 1024

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()))

let DB = null
function datenbank() {
  if (DB) return DB
  DB = new Promise((res) => {
    const r = indexedDB.open(DBN, 1)
    r.onupgradeneeded = () => r.result.createObjectStore("kv")
    r.onerror = () => { DB = null; res(null) }
    r.onsuccess = () => { r.result.onclose = () => { DB = null }; res(r.result) }
  })
  return DB
}
async function idbKey() {
  const db = await datenbank()
  if (!db) return null
  return new Promise((res) => {
    try {
      const g = db.transaction("kv").objectStore("kv").get("key")
      g.onsuccess = () => res(g.result || null)
      g.onerror = () => res(null)
    } catch { DB = null; res(null) }
  })
}
// Der Schlüssel wird bei jeder Anfrage aus IndexedDB gelesen: Sperren wirkt sofort, auch wenn der Worker noch läuft.
async function schluessel() {
  const v = await idbKey()
  if (!v || v.exp < Date.now()) { KEY = null; MAP = null; KAT = null; RAM.clear(); ramBytes = 0; return null }
  return (KEY = v.key)
}
async function entschluesseln(key, buf) {
  const u8 = new Uint8Array(buf)
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: u8.slice(0, 12) }, key, u8.slice(12))
}
async function gunzipJson(plain) {
  const t = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
  return JSON.parse(t)
}
async function holen(pfad) {
  const r = await fetch(new URL(pfad, SCOPE))
  if (!r.ok) throw new Error(pfad + " " + r.status)
  return r.arrayBuffer()
}
async function katalog(key) {
  if (!KAT) KAT = await gunzipJson(await entschluesseln(key, await holen("c/katalog.bin")))
  return KAT
}
async function karte(key) {
  if (!MAP) MAP = await gunzipJson(await entschluesseln(key, await holen("c/karte.bin")))
  return MAP
}
async function block(key, id) {
  if (RAM.has(id)) { const v = RAM.get(id); RAM.delete(id); RAM.set(id, v); return v }
  const plain = await entschluesseln(key, await holen("b/" + id + ".bin"))
  RAM.set(id, plain); ramBytes += plain.byteLength
  while (ramBytes > RAM_MAX && RAM.size > 1) {
    const [alt, v] = RAM.entries().next().value
    RAM.delete(alt); ramBytes -= v.byteLength
  }
  return plain
}

function antwort(req, buf, mime) {
  const size = buf.byteLength
  const kopf = { "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  const rg = req.headers.get("range")
  if (rg) {
    const m = /bytes=(\d*)-(\d*)/.exec(rg)
    if (m) {
      let s, e
      if (m[1] === "" && m[2] !== "") { s = Math.max(size - Number(m[2]), 0); e = size - 1 }
      else { s = Number(m[1] || 0); e = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1) }
      if (s > e || s >= size) return new Response(null, { status: 416, headers: { ...kopf, "Content-Range": "bytes */" + size } })
      return new Response(buf.slice(s, e + 1), { status: 206, headers: { ...kopf, "Content-Range": `bytes ${s}-${e}/${size}`, "Content-Length": String(e - s + 1) } })
    }
  }
  return new Response(buf, { status: 200, headers: { ...kopf, "Content-Length": String(size) } })
}

async function bedienen(req, rel) {
  const key = await schluessel()
  if (!key) return new Response("gesperrt", { status: 401 })
  try {
    if (rel === "api/katalog") { KAT = null; MAP = null }
    if (rel === "api/katalog") return new Response(JSON.stringify(await katalog(key)), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } })
    if (rel === "api/stand") return new Response("null", { status: 404 })
    const k = await karte(key)
    let eintrag = null
    const t = /^t\/(\d+)\/(.*)$/s.exec(rel)
    if (t) {
      const w = Number(t[1]), name = t[2]
      eintrag = k[(w <= 800 ? "ts/" : "tl/") + name] || k["tl/" + name] || k["ts/" + name] || k["d/" + name]
    } else if (rel.startsWith("d/")) eintrag = k[rel]
    if (!eintrag) return new Response("nicht online", { status: 404 })
    return antwort(req, await block(key, eintrag[0]), eintrag[1])
  } catch (e) {
    return new Response("Fehler beim Entschlüsseln", { status: 500 })
  }
}

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url)
  if (u.origin !== SCOPE.origin || !u.pathname.startsWith(SCOPE.pathname)) return
  let rel
  try { rel = decodeURIComponent(u.pathname.slice(SCOPE.pathname.length)) } catch { return }
  if (rel === "api/katalog" || rel === "api/stand" || rel.startsWith("t/") || rel.startsWith("d/")) e.respondWith(bedienen(e.request, rel))
})
