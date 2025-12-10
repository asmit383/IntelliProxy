const express = require('express');
const app =express();
const port = 3002; 
 
app.get('/', (req, res) => {
    res.send('Response from Server B');
});
app.get("/health", (req, res) => {
    res.status(200).send("Server B is healthy");
});

app.listen(port, () => {
    console.log(`Server B listening at http://localhost:${port}`);
});