const express = require('express');
const app =express();
const port = 3000; 
 
app.get('/', (req, res) => {
    res.send('Response from Server A');
});

app.get("/health", (req, res) => {
    

    res.status(200).send("Server A is healthy");

});

app.listen(port, () => {
    console.log(`Server A listening at http://localhost:${port}`);
});