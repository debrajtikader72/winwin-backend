import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();

const AdminSettings = mongoose.model('AdminSettings', new mongoose.Schema({
    _id: { type: String, default: "game_control" },
    forcedNextNumber: { type: Number, default: null }
}), 'adminsettings');

const app = express();

// ==========================================
// MIDDLEWARES (Must be placed before routes)
// ==========================================

// 1. Unified CORS Setup targeting your exact current frontend origin (No trailing slash)
app.use(cors({
    origin: "https://frontend-5-vvsx.onrender.com", 
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true
}));

// 2. Body Parsers to correctly parse payload streams
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// ==========================================
// DATABASE & MODELS
// ==========================================

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.error(err));

const WithdrawalSchema = new mongoose.Schema({
    amount: { type: Number, required: true },
    date: { type: String, required: true },
    status: { type: String, default: "Pending" }
});

const UserSchema = new mongoose.Schema({
    mobile: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 1874.65 },
    betHistory: { type: Array, default: [] },
    profilePic: { type: String, default: "" },
    bankDetails: { name: { type: String, default: "" }, accountNumber: { type: String, default: "" }, ifsc: { type: String, default: "" } },
    withdrawals: [WithdrawalSchema]
});

const User = mongoose.model('User', UserSchema);

const GameResultSchema = new mongoose.Schema({
    period: { type: String, required: true },
    winningColor: { type: String, required: true },
    winningNumber: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now }
});

const GameResult = mongoose.model('GameResult', GameResultSchema);

const PeriodResultSchema = new mongoose.Schema({
    period: { type: String, required: true, unique: true },
    winningColor: { type: String, required: true },
    winningNumber: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

const PeriodResult = mongoose.model('PeriodResult', PeriodResultSchema);

User.collection.dropIndex('email_1').catch(() => {});

// ==========================================
// CONFIGURATIONS & UTILITIES
// ==========================================

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});

let otpCache = {};

function getActivePeriodId() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const minutesSinceMidnight = now.getHours() * 60 + now.getMinutes();
    const counter = Math.floor(minutesSinceMidnight / 3);
    return `${yyyy}${mm}${dd}${String(counter).padStart(3, '0')}`;
}

async function getOrCreatePeriodResult(periodId) {
    try {
        let periodOutcome = await PeriodResult.findOne({ period: periodId });
        if (!periodOutcome) {
            let randomNumber;
            const adminControl = await AdminSettings.findById("game_control");
            if (adminControl && adminControl.forcedNextNumber !== null && adminControl.forcedNextNumber >= 0 && adminControl.forcedNextNumber <= 9) {
                randomNumber = adminControl.forcedNextNumber;
                await AdminSettings.findByIdAndUpdate("game_control", { forcedNextNumber: null });
            } else {
                randomNumber = Math.floor(Math.random() * 10);
            }
            let randomColor = "red";
            if (randomNumber === 0) randomColor = "red-violet";
            else if (randomNumber === 5) randomColor = "green-violet";
            else if ([1, 3, 7, 9].includes(randomNumber)) randomColor = "green";
            else if ([2, 4, 6, 8].includes(randomNumber)) randomColor = "red";
            periodOutcome = new PeriodResult({ period: periodId, winningColor: randomColor, winningNumber: String(randomNumber) });
            await periodOutcome.save();
        }
        return periodOutcome;
    } catch (err) {
        return null;
    }
}

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// ==========================================
// API ROUTE ENDPOINTS
// ==========================================

app.post('/api/send-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email required" });
    const cleanEmail = email.trim().toLowerCase();
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpCache[cleanEmail] = { otp: otp, expires: Date.now() + 300000 };
    const mailOptions = { from: process.env.MAIL_USER, to: cleanEmail, subject: 'WIN_WIN Verification Code', text: `Your OTP is: ${otp}` };
    try {
        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: "OTP sent" });
    } catch (err) {
        res.status(500).json({ message: "Email error" });
    }
});

app.post('/api/register', async (req, res) => {
    const { mobile, email, password, otp } = req.body;
    if (!mobile || !email || !password || !otp) return res.status(400).json({ message: "All fields required" });
    const cleanEmail = email.trim().toLowerCase();
    const cachedData = otpCache[cleanEmail];
    if (!cachedData || String(cachedData.otp).trim() !== String(otp).trim() || Date.now() > cachedData.expires) return res.status(400).json({ message: "Invalid or expired OTP" });
    try {
        let existingUser = await User.findOne({ mobile });
        if (existingUser) return res.status(400).json({ message: "Mobile already registered." });
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ mobile, email: cleanEmail, password: hashedPassword });
        await newUser.save();
        delete otpCache[cleanEmail];
        res.status(201).json({ message: "Registration successful" });
    } catch (err) {
        res.status(500).json({ message: "Database error" });
    }
});

app.post('/api/login', async (req, res) => {
    const { mobile, password } = req.body;
    try {
        const user = await User.findOne({ mobile });
        if (!user) return res.status(400).json({ message: "Invalid credentials" });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });
        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '24h' });
        res.status(200).json({ token, userId: user._id, mobile: user.mobile, balance: user.balance, betHistory: user.betHistory });
    } catch (err) {
        res.status(500).json({ message: "Server error" });
    }
});

app.get('/api/user-data/:userId', authenticateToken, async (req, res) => {
    try {
        if (req.user.userId !== req.params.userId) return res.status(403).json({ message: "Unauthorized access" });
        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ message: "User not found" });
        res.status(200).json({ mobile: user.mobile, balance: user.balance, betHistory: user.betHistory, profilePic: user.profilePic, bankDetails: { accountName: user.bankDetails?.name || "", accountNumber: user.bankDetails?.accountNumber || "", ifsc: user.bankDetails?.ifsc || "" }, withdrawals: user.withdrawals });
    } catch (err) {
        res.status(500).json({ message: "Server error" });
    }
});

app.get('/api/game-history', async (req, res) => {
    try {
        const history = await mongoose.connection.collection('gameresults').find().sort({ _id: -1 }).limit(20).toArray();
        res.status(200).json(history);
    } catch (err) {
        res.status(500).json({ message: "Error fetching history" });
    }
});

app.post('/api/place-bet', authenticateToken, async (req, res) => {
    const { period, selection, amount } = req.body;
    try {
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: "User not found" });
        if (user.balance < amount) return res.status(400).json({ message: "Insufficient balance" });
        user.balance -= amount;
        user.betHistory.push({ period, selection, amount, status: "Pending", type: "pending" });
        await user.save();
        res.status(200).json({ balance: user.balance, message: "Bet placed successfully" });
    } catch (err) {
        res.status(500).json({ message: "Transaction failed" });
    }
});

app.post('/api/add-bank', authenticateToken, async (req, res) => {
    const { userId, accountName, accountNumber, ifsc } = req.body;
    try {
        if (req.user.userId !== userId) return res.status(403).json({ message: "Unauthorized" });
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "User not found" });
        user.bankDetails = { name: accountName, accountNumber, ifsc };
        user.markModified('bankDetails');
        await user.save();
        res.status(200).json({ message: "Bank details updated", bankDetails: user.bankDetails });
    } catch (err) {
        res.status(500).json({ message: "Server error" });
    }
});

app.post('/api/withdraw', authenticateToken, async (req, res) => {
    const { userId, amount } = req.body;
    const withdrawAmount = Number(amount);
    try {
        if (req.user.userId !== userId) return res.status(403).json({ message: "Unauthorized" });
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "User not found" });
        if (user.balance < withdrawAmount) return res.status(400).json({ message: "Insufficient balance" });
        user.balance -= withdrawAmount;
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        user.withdrawals.push({ _id: new mongoose.Types.ObjectId(), amount: withdrawAmount, date: timestamp, status: "Pending" });
        user.markModified('withdrawals');
        await user.save();
        res.status(200).json({ message: "Withdrawal placed", balance: user.balance, withdrawals: user.withdrawals });
    } catch (err) {
        res.status(500).json({ message: "Withdrawal failure" });
    }
});

app.post('/api/upload-profile-pic', authenticateToken, async (req, res) => {
    const { userId, imageBase64 } = req.body;
    try {
        if (req.user.userId !== userId) return res.status(403).json({ message: "Unauthorized" });
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "User not found" });
        user.profilePic = imageBase64;
        await user.save();
        res.status(200).json({ message: "Profile picture uploaded", profilePic: user.profilePic });
    } catch (err) {
        res.status(500).json({ message: "Upload failed" });
    }
});

app.get('/api/admin/withdrawals', async (req, res) => {
    try {
        const users = await User.find({}, 'mobile bankDetails withdrawals');
        let allRequests = [];
        users.forEach(u => u.withdrawals.forEach(w => allRequests.push({ userId: u._id, mobile: u.mobile, bankDetails: u.bankDetails, withdrawalId: w._id, amount: w.amount, date: w.date, status: w.status })));
        res.status(200).json(allRequests);
    } catch (err) {
        res.status(500).json({ message: "Admin fetch error" });
    }
});

app.post('/api/admin/approve-withdrawal', async (req, res) => {
    const { userId, withdrawalId, action } = req.body;
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "User not found" });
        const transaction = user.withdrawals.id(withdrawalId);
        if (!transaction) return res.status(404).json({ message: "Transaction missing" });
        if (transaction.status !== "Pending") return res.status(400).json({ message: "Already processed" });
        if (action === "Approved") transaction.status = "Approved";
        else if (action === "Rejected") { transaction.status = "Rejected"; user.balance += transaction.amount; }
        user.markModified('withdrawals');
        await user.save();
        res.status(200).json({ message: `Status marked as ${action}` });
    } catch (err) {
        res.status(500).json({ message: "Admin failure" });
    }
});

app.get('/api/period-result/:period', async (req, res) => {
    try {
        const periodOutcome = await getOrCreatePeriodResult(req.params.period);
        if (periodOutcome) res.status(200).json(periodOutcome);
        else res.status(500).json({ message: "Error generating result" });
    } catch (err) {
        res.status(500).json({ message: "Server error" });
    }
});

app.listen(process.env.PORT || 5000, () => console.log(`Server running on port ${process.env.PORT || 5000}`));
