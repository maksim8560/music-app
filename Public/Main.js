const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Подключаем MongoDB Atlas
mongoose.connect('mongodb+srv://ваш_логин:ваш_пароль@cluster0.mongodb.net/messenger', {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// Модели MongoDB
const User = mongoose.model('User', {
    username: String,
    email: String,
    password: String,
    avatarColor: String,
    createdAt: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', {
    text: String,
    senderId: String,
    receiverId: String,
    timestamp: { type: Date, default: Date.now }
});

// Раздаем статические файлы
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API endpoints
app.post('/api/register', async (req, res) => {
    // Регистрация пользователя
});

app.post('/api/login', async (req, res) => {
    // Вход пользователя
});

// WebSocket для чата и звонков
io.on('connection', (socket) => {
    console.log('Новое соединение:', socket.id);
    
    socket.on('message', (data) => {
        // Отправка сообщений
        io.emit('message', data);
    });
    
    socket.on('call', (data) => {
        // Сигналинг для звонков
        socket.broadcast.emit('incoming-call', data);
    });
    
    socket.on('disconnect', () => {
        console.log('Пользователь отключился:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});