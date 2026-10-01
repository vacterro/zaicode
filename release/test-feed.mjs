// Operator-side fixture transport; never included in the installed product.
import http from "node:http";
import { createReadStream, writeFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
const root = resolve(process.argv[2]);
const server = http.createServer((request, response) => {
  try {
    const path = resolve(root, `.${decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname)}`);
    if (!path.startsWith(root + sep)) throw new Error("outside fixture");
    const file = statSync(path);
    if (!file.isFile()) throw new Error("not a file");
    response.writeHead(200, { "Content-Length": file.size, "Content-Type": path.endsWith(".json") ? "application/json" : "application/zip" });
    createReadStream(path).pipe(response);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(0, "127.0.0.1", () => writeFileSync(resolve(root, "port.txt"), String(server.address().port)));
