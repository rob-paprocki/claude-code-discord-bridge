// Fake bridge for hook client tests. Node 22, no dependencies.
// Usage: node fake-bridge.mjs <script.json> <log.jsonl> <port-file>
// script.json: { post: {status, body}, gets: [{status, body}, ...], release: {status, body},
//   getsAfterRelease: [{status, body}, ...], stopAfterPost: bool }
// gets are served in order; the last one repeats. Once a release was answered, getsAfterRelease
// (when given) takes over the same way, so a test need not guess how many polls come first.
// Join routes (bridge-install.sh), each {status, body}: self (GET /api/machines/self; an array is
// served in order, last repeats), enroll
// (POST /api/enroll), enrollGets (GET /api/enroll/:id, in order, last repeats), enrollDelete
// (DELETE /api/enroll/:id), selfDelete (DELETE /api/machines/self, for --leave). They accept any bearer token and log only whether an Authorization
// header was present ("bearer"), never its value.
import http from "node:http";
import fs from "node:fs";

const [scriptFile, logFile, portFile] = process.argv.slice(2);
const script = JSON.parse(fs.readFileSync(scriptFile, "utf8"));
const gets = (script.gets || []).slice();
const getsAfterRelease = (script.getsAfterRelease || []).slice();
let released = false;
const selfs = [].concat(script.self || []);
const enrollGets = (script.enrollGets || []).slice();
const post = script.post || { status: 201, body: { id: "r1", status: "pending" } };

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    const auth = req.headers.authorization === "Bearer test-token";
    const path = req.url.split("?")[0];
    fs.appendFileSync(logFile, JSON.stringify({ t: Date.now(), method: req.method, path, body, auth, contentLength: req.headers["content-length"] ?? null, bearer: Boolean(req.headers.authorization) }) + "\n");

    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && path === "/api/machines/self") {
      const r = (selfs.length > 1 ? selfs.shift() : selfs[0]) || { status: 200, body: { name: "testbox" } };
      return send(r.status, r.body);
    }
    if (req.method === "DELETE" && path === "/api/machines/self") {
      const r = script.selfDelete || { status: 200, body: { ok: true } };
      return send(r.status, r.body);
    }
    if (req.method === "POST" && path === "/api/enroll") {
      const r = script.enroll || { status: 201, body: { id: "j1", code: "ABC-234", secret: "s" } };
      return send(r.status, r.body);
    }
    if (req.method === "GET" && /^\/api\/enroll\/[^/]+$/.test(path)) {
      const next = enrollGets.length > 1 ? enrollGets.shift() : enrollGets[0];
      const r = next || { status: 200, body: { status: "pending" } };
      return send(r.status, r.body);
    }
    if (req.method === "DELETE" && /^\/api\/enroll\/[^/]+$/.test(path)) {
      const r = script.enrollDelete || { status: 200, body: { ok: true } };
      return send(r.status, r.body);
    }
    if (!auth) return send(401, { error: "unauthorized" });

    if (req.method === "POST" && path === "/api/requests") {
      send(post.status, post.body);
      if (script.stopAfterPost) setTimeout(() => { server.close(); server.closeAllConnections(); }, 20);
    } else if (req.method === "GET" && /^\/api\/requests\/[^/]+$/.test(path)) {
      const list = released && getsAfterRelease.length > 0 ? getsAfterRelease : gets;
      const next = list.length > 1 ? list.shift() : list[0];
      const r = next || { status: 200, body: { id: "r1", status: "pending" } };
      send(r.status, r.body);
    } else if (req.method === "POST" && /^\/api\/requests\/[^/]+\/release$/.test(path)) {
      const rel = script.release || { status: 200, body: { status: "released" } };
      if (rel.status === 200) released = true;
      send(rel.status, rel.body);
    } else if (req.method === "POST" && /^\/api\/sessions\/[^/]+\/end$/.test(path)) {
      send(200, { session: path.split("/")[3], conversation: false });
    } else {
      send(404, { error: "not found" });
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
