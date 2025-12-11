const http = require("http");
function hitProxy() {
  const start = Date.now();
  const req = http.get("http://localhost:3001/", (res) => {
    let body = "";
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => {
      const ms = Date.now() - start;
      console.log(`[CLIENT] ${ms} ms | Response: ${body.trim()}`);
    });
  });
  req.on("error", (err) => {
    console.log("[CLIENT] Error:", err.message);
  });
}
setInterval(hitProxy, 5000);