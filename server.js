const express = require("express");
const jwt = require("jsonwebtoken");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const SECRET = "super_secret_key_123";

let stations = [
    { id: 1, name: "LoFi Hip Hop", stream: "https://stream.laut.fm/lofi" },
    { id: 2, name: "Deep House", stream: "https://stream.laut.fm/deepdance" }
];

// 🔐 ADMIN LOGIN
app.post("/login", (req, res) => {
    const { user, pass } = req.body;

    if (user === "Admin" && pass === "952378") {
        const token = jwt.sign({ role: "admin" }, SECRET, { expiresIn: "2h" });
        return res.json({ token });
    }

    res.status(401).json({ error: "Wrong credentials" });
});

// middleware auth
function auth(req, res, next) {
    const token = req.headers.authorization;

    try {
        jwt.verify(token, SECRET);
        next();
    } catch {
        res.status(403).json({ error: "No access" });
    }
}

// 📡 GET stations
app.get("/stations", (req, res) => {
    res.json(stations);
});

// ➕ ADD station (admin only)
app.post("/stations", auth, (req, res) => {
    const { name, stream } = req.body;

    const newStation = {
        id: Date.now(),
        name,
        stream
    };

    stations.push(newStation);

    res.json(newStation);
});

// ✏️ UPDATE text (footer)
let footerText = "Создал Максим ( ТГ MaxDiWay )";

app.get("/footer", (req, res) => {
    res.json({ text: footerText });
});

app.post("/footer", auth, (req, res) => {
    footerText = req.body.text;
    res.json({ ok: true });
});

app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});