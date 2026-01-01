const http = require("http");

function hitProxy(port, name) {
  const start = Date.now();
  const req = http.get(`http://localhost:${port}/`, (res) => {
    let body = "";
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => {
      const ms = Date.now() - start;
      console.log(`[CLIENT - ${name}] ${ms} ms | Response: ${body.trim()}`);
    });
  });
  req.on("error", (err) => {
    console.log(`[CLIENT - ${name}] Error:`, err.message);
  });
}

// Hit RL Proxy (3001)
setInterval(() => hitProxy(3001, "RL"), 5000);

// Hit Manual Proxy (3005)
setInterval(() => hitProxy(3005, "MANUAL"), 5000);