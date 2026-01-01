# IntelliProxy

IntelliProxy is a **smart, metric-driven load balancer** and reverse proxy built with Node.js. Unlike simple round-robin proxies, IntelliProxy continuously monitors the health and performance of backend servers to make intelligent routing decisions in real-time.

It routes traffic based on a composite score derived from latency, error rates, system load (CPU/Memory/Queue), and active requests, ensuring that your traffic always flows to the most capable instance.

## 🚀 Features

*   **Smart Scoring Algorithm**: Calculates a fitness score for each backend server. Lower is better.
*   **Real-time Health/Latency Checks**: Periodically pings backends to track latency (including EWMA smoothing) and packet loss.
*   **Deep Metric Integration**: Polls backends for internal metrics like CPU usage, memory usage, and request queue length.
*   **Hysteresis & Stability**:
    *   **Switching Ratio/Threshold**: Prevents "flapping" by requiring a new backend to be significantly better before switching.
    *   **Cooldown**: Enforces a minimum time duration between route changes.
*   **Fault Tolerance**: Automatically detects downed servers and routes away from them.
*   **Live Stats API**: Exposes a `/stats` endpoint to view the real-time scoring table and backend status.

## 🛠️ Installation

1.  **Clone the repository**
2.  **Install dependencies**:
    ```bash
    npm install
    ```

## 🚦 Usage

The easiest way to run the entire stack (Proxy + Server A + Server B) is using the `all` script:

```bash
npm run all
```

This commands starts:
*   **IntelliProxy** on port `3001`
*   **Server A** on port `3000`
*   **Server B** on port `3002`

### Running Individually

You can also run components separately in different terminal windows:

*   **Proxy Only**: `npm run proxy`
*   **Server A Only**: `npm run A`
*   **Server B Only**: `npm run B`

## 🧠 How It Works

### The Scoring Function
The proxy assigns a **Score** to each backend. THe Request is always routed to the backend with the **lowest score**.

The score is a weighted sum of several factors:
1.  **Latency**: Round-trip time (EWMA smoothed).
2.  **Loss**: Percentage of failed health pings.
3.  **Error Rate**: Percentage of HTTP 5xx responses from the backend.
4.  **Load**: Number of currently active requests being handled.
5.  **Queue**: Internal request queue length (if reported by backend).
6.  **CPU/Memory**: System resource usage (if reported by backend).

### Stability Logic
*   **Switch Threshold**: To switch from Server A to Server B, Server B's score must be lower than A's by at least `30` points.
*   **Cooldown**: After a switch, the proxy waits at least `1500ms` before switching again.

## 📡 API Endpoints

### 1. Proxy Root
*   **URL**: `http://localhost:3001/*`
*   **Description**: All requests sent here are forwarded to the best available backend server.

### 2. Statistics
*   **URL**: `http://localhost:3001/stats`
*   **Method**: `GET`
*   **Description**: Returns a JSON object containing the current state of all backends, including their scores, latency, active requests, and error rates.

**Example Response:**
```json
[
  {
    "name": "A",
    "url": "http://localhost:3000",
    "latency": 12,
    "latencyEwma": 14.5,
    "activeRequests": 5,
    "score": 45.2,
    "alive": true
  },
  ...
]
```

## 📂 Project Structure

*   `proxy/proxyserver.js`: The main proxy logic and scoring algorithm.
*   `serverA/`: Simulation of Backend Server A.
*   `serverB/`: Simulation of Backend Server B.
*   `package.json`: Scripts and dependencies.