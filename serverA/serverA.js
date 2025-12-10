const express = require('express');
const app =express();
const port = 3000; 
 
app.get('/', (req, res) => {
    res.send('Response from Server A');
});

app.get("/health", (req, res) => {
    if (Math.random() < 0.30) {
    
      return;
    }
  
    if (Math.random() < 0.20) {
      // Simulate server overload
      setTimeout(() => res.send("OK"), 200);
      return;
    }
  
    res.send("OK");
  });

app.listen(port, () => {
    console.log(`Server A listening at http://localhost:${port}`);
});