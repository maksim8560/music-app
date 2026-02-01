const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Подключаем MongoDB Atlas
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/messenger', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Схемы MongoDB
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  avatarColor: { type: String, default: '#4cc9f0' },
  isVerified: { type: Boolean, default: false },
  verificationCode: String,
  verificationExpires: Date,
  lastSeen: { type: Date, default: Date.now },
  status: { type: String, enum: ['online', 'offline', 'away'], default: 'offline' },
  contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  text: { type: String, required: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false },
  emojiReactions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    emoji: String,
    timestamp: { type: Date, default: Date.now }
  }]
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// Настройка email для отправки кодов верификации
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware для проверки JWT токена
const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Токен не предоставлен' });
  }
  
  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Недействительный токен' });
    }
    req.user = user;
    next();
  });
};

// Генерация случайного цвета для аватара
function getRandomColor() {
  const colors = ['#4cc9f0', '#f72585', '#4895ef', '#3f37c9', '#7209b7', '#4361ee'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// API Endpoints

// Регистрация пользователя
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    // Проверка существующего пользователя
    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
      return res.status(400).json({ error: 'Пользователь с таким логином или email уже существует' });
    }
    
    // Хеширование пароля
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Генерация кода верификации
    const verificationCode = crypto.randomInt(100000, 999999).toString();
    
    const user = new User({
      username,
      email,
      password: hashedPassword,
      avatarColor: getRandomColor(),
      verificationCode,
      verificationExpires: Date.now() + 24 * 60 * 60 * 1000 // 24 часа
    });
    
    await user.save();
    
    // Отправка email с кодом верификации
    if (process.env.NODE_ENV === 'production') {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Код подтверждения для Web Messenger',
        html: `
          <h2>Добро пожаловать в Web Messenger!</h2>
          <p>Ваш код подтверждения: <strong>${verificationCode}</strong></p>
          <p>Код действителен в течение 24 часов.</p>
        `
      });
    } else {
      console.log(`Код подтверждения для ${email}: ${verificationCode}`);
    }
    
    res.status(201).json({ 
      message: 'Пользователь зарегистрирован. Проверьте email для подтверждения.',
      userId: user._id 
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Ошибка при регистрации' });
  }
});

// Подтверждение email
app.post('/api/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    if (user.isVerified) {
      return res.status(400).json({ error: 'Email уже подтвержден' });
    }
    
    if (user.verificationCode !== code) {
      return res.status(400).json({ error: 'Неверный код подтверждения' });
    }
    
    if (Date.now() > user.verificationExpires) {
      return res.status(400).json({ error: 'Срок действия кода истек' });
    }
    
    user.isVerified = true;
    user.verificationCode = undefined;
    user.verificationExpires = undefined;
    await user.save();
    
    // Создание JWT токена
    const token = jwt.sign(
      { userId: user._id, username: user.username },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );
    
    res.json({ 
      message: 'Email успешно подтвержден',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        avatarColor: user.avatarColor
      }
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'Ошибка при подтверждении email' });
  }
});

// Повторная отправка кода
app.post('/api/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    if (user.isVerified) {
      return res.status(400).json({ error: 'Email уже подтвержден' });
    }
    
    // Генерация нового кода
    const verificationCode = crypto.randomInt(100000, 999999).toString();
    user.verificationCode = verificationCode;
    user.verificationExpires = Date.now() + 24 * 60 * 60 * 1000;
    await user.save();
    
    // Отправка email
    if (process.env.NODE_ENV === 'production') {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Новый код подтверждения для Web Messenger',
        html: `
          <h2>Новый код подтверждения</h2>
          <p>Ваш новый код: <strong>${verificationCode}</strong></p>
          <p>Код действителен в течение 24 часов.</p>
        `
      });
    } else {
      console.log(`Новый код подтверждения для ${email}: ${verificationCode}`);
    }
    
    res.json({ message: 'Новый код отправлен на email' });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Ошибка при отправке кода' });
  }
});

// Вход пользователя
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    if (!user.isVerified) {
      return res.status(403).json({ error: 'Подтвердите email для входа' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }
    
    // Обновляем статус и время последнего посещения
    user.lastSeen = Date.now();
    user.status = 'online';
    await user.save();
    
    // Создание JWT токена
    const token = jwt.sign(
      { userId: user._id, username: user.username },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );
    
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        avatarColor: user.avatarColor,
        status: user.status,
        lastSeen: user.lastSeen
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Ошибка при входе' });
  }
});

// Получение информации о пользователе
app.get('/api/user/:id', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password -verificationCode');
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Ошибка при получении информации о пользователе' });
  }
});

// Поиск пользователей по логину
app.get('/api/users/search', authenticateToken, async (req, res) => {
  try {
    const { query } = req.query;
    
    const users = await User.find({
      username: { $regex: query, $options: 'i' },
      _id: { $ne: req.user.userId } // исключаем текущего пользователя
    }).select('username avatarColor status lastSeen').limit(10);
    
    res.json(users);
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Ошибка при поиске пользователей' });
  }
});

// Добавление пользователя в контакты
app.post('/api/contacts/add', authenticateToken, async (req, res) => {
  try {
    const { contactId } = req.body;
    
    const user = await User.findById(req.user.userId);
    const contact = await User.findById(contactId);
    
    if (!contact) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    // Проверяем, не добавлен ли уже контакт
    if (user.contacts.includes(contactId)) {
      return res.status(400).json({ error: 'Пользователь уже в контактах' });
    }
    
    user.contacts.push(contactId);
    await user.save();
    
    res.json({ message: 'Контакт добавлен', contact });
  } catch (error) {
    console.error('Add contact error:', error);
    res.status(500).json({ error: 'Ошибка при добавлении контакта' });
  }
});

// Получение списка контактов
app.get('/api/contacts', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).populate('contacts', 'username avatarColor status lastSeen');
    res.json(user.contacts);
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ error: 'Ошибка при получении контактов' });
  }
});

// Получение истории сообщений
app.get('/api/messages/:contactId', authenticateToken, async (req, res) => {
  try {
    const { contactId } = req.params;
    const { limit = 50, before } = req.query;
    
    const query = {
      $or: [
        { senderId: req.user.userId, receiverId: contactId },
        { senderId: contactId, receiverId: req.user.userId }
      ]
    };
    
    if (before) {
      query.timestamp = { $lt: new Date(before) };
    }
    
    const messages = await Message.find(query)
      .populate('senderId', 'username avatarColor')
      .sort({ timestamp: -1 })
      .limit(parseInt(limit));
    
    // Помечаем сообщения как прочитанные
    await Message.updateMany(
      { senderId: contactId, receiverId: req.user.userId, read: false },
      { $set: { read: true } }
    );
    
    res.json(messages.reverse());
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Ошибка при получении сообщений' });
  }
});

// Получение непрочитанных сообщений
app.get('/api/messages/unread/count', authenticateToken, async (req, res) => {
  try {
    const count = await Message.countDocuments({
      receiverId: req.user.userId,
      read: false
    });
    
    res.json({ count });
  } catch (error) {
    console.error('Get unread messages count error:', error);
    res.status(500).json({ error: 'Ошибка при получении непрочитанных сообщений' });
  }
});

// Добавление реакции на сообщение
app.post('/api/messages/:messageId/reaction', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Сообщение не найдено' });
    }
    
    // Проверяем, есть ли уже реакция от этого пользователя
    const existingReactionIndex = message.emojiReactions.findIndex(
      reaction => reaction.userId.toString() === req.user.userId
    );
    
    if (existingReactionIndex > -1) {
      // Обновляем существующую реакцию
      message.emojiReactions[existingReactionIndex].emoji = emoji;
      message.emojiReactions[existingReactionIndex].timestamp = Date.now();
    } else {
      // Добавляем новую реакцию
      message.emojiReactions.push({
        userId: req.user.userId,
        emoji,
        timestamp: Date.now()
      });
    }
    
    await message.save();
    
    // Отправляем обновление через WebSocket
    io.emit('message-reaction', {
      messageId,
      reactions: message.emojiReactions
    });
    
    res.json({ message: 'Реакция добавлена', reactions: message.emojiReactions });
  } catch (error) {
    console.error('Add reaction error:', error);
    res.status(500).json({ error: 'Ошибка при добавлении реакции' });
  }
});

// Удаление реакции с сообщения
app.delete('/api/messages/:messageId/reaction', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Сообщение не найдено' });
    }
    
    // Удаляем реакцию пользователя
    message.emojiReactions = message.emojiReactions.filter(
      reaction => reaction.userId.toString() !== req.user.userId
    );
    
    await message.save();
    
    // Отправляем обновление через WebSocket
    io.emit('message-reaction', {
      messageId,
      reactions: message.emojiReactions
    });
    
    res.json({ message: 'Реакция удалена', reactions: message.emojiReactions });
  } catch (error) {
    console.error('Remove reaction error:', error);
    res.status(500).json({ error: 'Ошибка при удалении реакции' });
  }
});

// WebSocket соединения
const onlineUsers = new Map(); // userId -> socketId

io.on('connection', (socket) => {
  console.log('Новое соединение:', socket.id);
  
  // Авторизация пользователя через JWT
  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
      const user = await User.findById(decoded.userId);
      
      if (!user) {
        socket.emit('auth-error', { error: 'Пользователь не найден' });
        return;
      }
      
      // Сохраняем связь userId -> socketId
      onlineUsers.set(user._id.toString(), socket.id);
      socket.userId = user._id.toString();
      
      // Обновляем статус пользователя
      user.status = 'online';
      user.lastSeen = Date.now();
      await user.save();
      
      // Уведомляем контакты об изменении статуса
      const contacts = await User.find({ _id: { $in: user.contacts } });
      contacts.forEach(contact => {
        const contactSocketId = onlineUsers.get(contact._id.toString());
        if (contactSocketId) {
          io.to(contactSocketId).emit('user-status-changed', {
            userId: user._id,
            status: 'online'
          });
        }
      });
      
      socket.emit('authenticated', {
        userId: user._id,
        username: user.username
      });
      
      console.log(`Пользователь ${user.username} авторизован, socket: ${socket.id}`);
    } catch (error) {
      console.error('WebSocket authentication error:', error);
      socket.emit('auth-error', { error: 'Ошибка авторизации' });
    }
  });
  
  // Отправка сообщения
  socket.on('send-message', async (data) => {
    try {
      const { receiverId, text } = data;
      
      if (!socket.userId) {
        socket.emit('error', { error: 'Не авторизован' });
        return;
      }
      
      // Сохраняем сообщение в БД
      const message = new Message({
        text,
        senderId: socket.userId,
        receiverId,
        timestamp: Date.now()
      });
      
      await message.save();
      
      // Получаем полную информацию об отправителе
      const populatedMessage = await Message.findById(message._id)
        .populate('senderId', 'username avatarColor');
      
      // Отправляем сообщение получателю, если он онлайн
      const receiverSocketId = onlineUsers.get(receiverId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('new-message', populatedMessage);
      }
      
      // Отправляем сообщение обратно отправителю для подтверждения
      socket.emit('message-sent', populatedMessage);
      
      // Обновляем список непрочитанных сообщений у получателя
      if (receiverSocketId) {
        const unreadCount = await Message.countDocuments({
          receiverId,
          read: false
        });
        io.to(receiverSocketId).emit('unread-count-updated', { count: unreadCount });
      }
    } catch (error) {
      console.error('Send message error:', error);
      socket.emit('error', { error: 'Ошибка при отправке сообщения' });
    }
  });
  
  // Сигналинг для звонков
  socket.on('call-offer', (data) => {
    const { to, offer, callType } = data;
    
    const receiverSocketId = onlineUsers.get(to);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('incoming-call', {
        from: socket.userId,
        offer,
        callType,
        socketId: socket.id
      });
    }
  });
  
  socket.on('call-answer', (data) => {
    const { to, answer } = data;
    
    const callerSocketId = onlineUsers.get(to);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call-answered', {
        from: socket.userId,
        answer
      });
    }
  });
  
  socket.on('call-ice-candidate', (data) => {
    const { to, candidate } = data;
    
    const otherSocketId = onlineUsers.get(to);
    if (otherSocketId) {
      io.to(otherSocketId).emit('call-ice-candidate', {
        from: socket.userId,
        candidate
      });
    }
  });
  
  socket.on('call-end', (data) => {
    const { to } = data;
    
    const otherSocketId = onlineUsers.get(to);
    if (otherSocketId) {
      io.to(otherSocketId).emit('call-ended', {
        from: socket.userId
      });
    }
  });
  
  socket.on('typing', (data) => {
    const { to, isTyping } = data;
    
    const receiverSocketId = onlineUsers.get(to);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('user-typing', {
        from: socket.userId,
        isTyping
      });
    }
  });
  
  // Отключение пользователя
  socket.on('disconnect', async () => {
    console.log('Пользователь отключился:', socket.id);
    
    if (socket.userId) {
      onlineUsers.delete(socket.userId);
      
      // Обновляем статус пользователя
      const user = await User.findById(socket.userId);
      if (user) {
        user.status = 'offline';
        user.lastSeen = Date.now();
        await user.save();
        
        // Уведомляем контакты об изменении статуса
        const contacts = await User.find({ _id: { $in: user.contacts } });
        contacts.forEach(contact => {
          const contactSocketId = onlineUsers.get(contact._id.toString());
          if (contactSocketId) {
            io.to(contactSocketId).emit('user-status-changed', {
              userId: user._id,
              status: 'offline',
              lastSeen: user.lastSeen
            });
          }
        });
      }
    }
  });
});

// Получение списка эмодзи для панели
app.get('/api/emojis', (req, res) => {
  const emojiCategories = {
    smileys: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👿', '👹', '👺', '🤡', '💩', '👻', '💀', '☠️', '👽', '👾', '🤖', '🎃', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾'],
    hearts: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❤️‍🔥', '❤️‍🩹', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟'],
    hands: ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏'],
    animals: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮', '🐷', '🐽', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🪱', '🐛', '🦋', '🐌', '🐞', '🐜', '🪰', '🪲', '🪳', '🦟', '🦗', '🕷️', '🕸️', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🦣', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘', '🦬', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙', '🐐', '🦌', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈', '🐈‍⬛', '🪶', '🐓', '🦃', '🦤', '🦚', '🦜', '🦢', '🦩', '🕊️', '🐇', '🦝', '🦨', '🦡', '🦫', '🦦', '🦥', '🐁', '🐀', '🐿️', '🦔'],
    food: ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔', '🍠', '🫘', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗', '🥘', '🫕', '🥫', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🧈', '🍩', '🍪', '🌰', '🥜', '🍯', '🥛', '🍼', '🫖', '☕', '🍵', '🧃', '🥤', '🧋', '🍶', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🧉', '🍾', '🧊', '🥄', '🍴', '🍽️', '🥣', '🥡', '🥢'],
    activities: ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '🤺', '🤾', '🏌️', '🏇', '🧘', '🏄', '🏊', '🤽', '🚣', '🧗', '🚴', '🚵', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🏵️', '🎗️', '🎫', '🎟️', '🎪', '🤹', '🎭', '🩰', '🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🪘', '🎷', '🎺', '🪗', '🎸', '🪕', '🎻', '🎲', '♟️', '🎯', '🎳', '🎮', '🎰'],
    travel: ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🦯', '🦽', '🦼', '🛴', '🚲', '🛵', '🏍️', '🛺', '🚨', '🚔', '🚍', '🚘', '🚖', '🚡', '🚠', '🚟', '🚃', '🚋', '🚞', '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚇', '🚊', '🚉', '✈️', '🛫', '🛬', '🛩️', '💺', '🛰️', '🚀', '🛸', '🚁', '🛶', '⛵', '🚤', '🛥️', '🛳️', '⛴️', '🚢', '⚓', '🛟', '🚧', '⛽', '🚏', '🚦', '🚥', '🗺️', '🗿', '🗽', '🗼', '🏰', '🏯', '🏟️', '🎡', '🎢', '🎠', '⛲', '⛱️', '🏖️', '🏝️', '🏜️', '🌋', '⛰️', '🏔️', '🗻', '🏕️', '⛺', '🛖', '🏠', '🏡', '🏘️', '🏚️', '🏗️', '🏭', '🏢', '🏬', '🏣', '🏤', '🏥', '🏦', '🏨', '🏪', '🏫', '🏩', '💒', '🏛️', '⛪', '🕌', '🛕', '🕍', '⛩️', '🕋', '⛲', '⛺', '🌁', '🌃', '🏙️', '🌄', '🌅', '🌆', '🌇', '🌉', '♨️', '🎠', '🎡', '🎢', '💈', '🎪', '🚂', '🚃', '🚄', '🚅', '🚆', '🚇'],
    objects: ['⌚', '📱', '📲', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '🕹️', '🗜️', '💽', '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥', '📽️', '🎞️', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️', '🎛️', '🧭', '⏱️', '⏲️', '⏰', '🕰️', '⌛', '⏳', '📡', '🔋', '🪫', '🔌', '💡', '🔦', '🕯️', '🪔', '🧯', '🛢️', '💸', '💵', '💴', '💶', '💷', '🪙', '💰', '💳', '💎', '⚖️', '🪜', '🧰', '🪛', '🔧', '🔨', '⚒️', '🛠️', '⛏️', '🪚', '🔩', '⚙️', '🪤', '🧱', '⛓️', '🧲', '🔫', '💣', '🧨', '🪓', '🔪', '🗡️', '⚔️', '🛡️', '🚬', '⚰️', '🪦', '⚱️', '🏺', '🔮', '📿', '💈', '⚗️', '🔭', '🔬', '🕳️', '🩹', '🩺', '💊', '💉', '🩸', '🧬', '🦠', '🧫', '🧪', '🌡️', '🧹', '🪠', '🧺', '🧻', '🚽', '🪣', '🧼', '🫧', '🪥', '🧽', '🧯', '🛒', '🚬', '⚰️'],
    symbols: ['❤️‍🔥', '❤️‍🩹', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳', '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚', '💮', '🉐', '㊙️', '㊗️', '🈴', '🈵', '🈹', '🈲', '🅰️', '🅱️', '🆎', '🆑', '🅾️', '🆘', '❌', '⭕', '🛑', '⛔', '📛', '🚫', '💯', '💢', '♨️', '🚷', '🚯', '🚳', '🚱', '🔞', '📵', '🚭', '❗', '❕', '❓', '❔', '‼️', '⁉️', '🔅', '🔆', '〽️', '⚠️', '🚸', '🔱', '⚜️', '🔰', '♻️', '✅', '🈯', '💹', '❇️', '✳️', '❎', '🌐', '💠', 'Ⓜ️', '🌀', '💤', '🏧', '🚾', '♿', '🅿️', '🈳', '🈂️', '🛂', '🛃', '🛄', '🛅', '🚹', '🚺', '🚼', '⚧️', '🚻', '🚮', '🎦', '📶', '🈁', '🔣', 'ℹ️', '🔤', '🔡', '🔠', '🆖', '🆗', '🆙', '🆒', '🆕', '🆓', '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟', '🔢', '#️⃣', '*️⃣', '⏏️', '▶️', '⏸️', '⏯️', '⏹️', '⏺️', '⏭️', '⏮️', '⏩', '⏪', '⏫', '⏬', '◀️', '🔼', '🔽', '➡️', '⬅️', '⬆️', '⬇️', '↗️', '↘️', '↙️', '↖️', '↕️', '↔️', '↪️', '↩️', '⤴️', '⤵️', '🔀', '🔁', '🔂', '🔄', '🔃', '🎵', '🎶', '➕', '➖', '➗', '✖️', '♾️', '💲', '💱', '™️', '©️', '®️', '〰️', '➰', '➿', '🔚', '🔙', '🔛', '🔝', '🔜', '✔️', '☑️', '🔘', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🟤', '🔺', '🔻', '🔸', '🔹', '🔶', '🔷', '🟧', '🟨', '🟩', '🟦', '🟪', '⬛', '⬜', '🟫', '🔈', '🔇', '🔉', '🔊', '🔔', '🔕', '📣', '📢', '👁️‍🗨️', '💬', '💭', '🗯️', '♠️', '♣️', '♥️', '♦️', '🃏', '🎴', '🀄', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛', '🕜', '🕝', '🕞', '🕟', '🕠', '🕡', '🕢', '🕣', '🕤', '🕥', '🕦', '🕧']
  };
  
  res.json(emojiCategories);
});

// Маршрут по умолчанию
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Режим: ${process.env.NODE_ENV || 'development'}`);
});
