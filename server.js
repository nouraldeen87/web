const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const cron = require("node-cron"); // ✅ FR5: Scheduler

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// =====================
// 🔗 MongoDB Atlas Connection
// =====================
mongoose.connect("mongodb://dev:12345@ac-jhdzxiy-shard-00-00.7way6nq.mongodb.net:27017,ac-jhdzxiy-shard-00-01.7way6nq.mongodb.net:27017,ac-jhdzxiy-shard-00-02.7way6nq.mongodb.net:27017/employeesDB?ssl=true&replicaSet=atlas-dn6wa0-shard-0&authSource=admin&retryWrites=true&w=majority")
.then(() => console.log("✅ MongoDB connected"))
.catch(err => console.log("❌ DB Error:", err));

// =====================
// 🧠 Helpers
// =====================
function isValidEmail(email) {
return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongPassword(password) {
return password && password.length >= 6;
}

const VALID_EMOTIONS = ["happy", "sad", "neutral", "angry", "tired"];
const VALID_STATUSES = ["active", "idle", "offline"];

// Engagement score weights per emotion (FR2 improvement)
const EMOTION_WEIGHTS = { happy: 1, neutral: 0.5, tired: -0.5, sad: -0.75, angry: -1 };

function isValidEmotion(e) { return !e || VALID_EMOTIONS.includes(e); }
function isValidStatus(s) { return !s || VALID_STATUSES.includes(s); }

async function checkPassword(inputPassword, storedPassword) {
if (storedPassword && storedPassword.startsWith("$2b$")) {
return await bcrypt.compare(inputPassword, storedPassword).catch(() => false);
}
return inputPassword === storedPassword;
}

// Compute engagement score from activity array (FR2)
function computeEngagementScore(data) {
if (!data.length) return 0;
const total = data.reduce((sum, r) => sum + (EMOTION_WEIGHTS[r.emotion] ?? 0), 0);
return parseFloat((total / data.length).toFixed(2));
}

// =====================
// 📦 Schemas & Models
// =====================
const Admin = mongoose.model("Admin", new mongoose.Schema({
name: String,
email: { type: String, unique: true },
password: String
}));

const Manager = mongoose.model("Manager", new mongoose.Schema({
name: String,
email: { type: String, unique: true },
password: String,
adminId: mongoose.Schema.Types.ObjectId,
hasAcceptedTerms: { type: Boolean, default: false },
emotion: { type: String, default: "neutral" },
status: { type: String, default: "active" }
}));

const Employee = mongoose.model("Employee", new mongoose.Schema({
name: String,
email: { type: String, unique: true },
password: String,
adminId: mongoose.Schema.Types.ObjectId,
managerId: mongoose.Schema.Types.ObjectId,
hasAcceptedTerms: { type: Boolean, default: false },
emotion: { type: String, default: "neutral" },
status: { type: String, default: "active" }
}));

const activitySchema = new mongoose.Schema({
employeeId: { type: mongoose.Schema.Types.ObjectId, default: null },
emotion: { type: String, enum: VALID_EMOTIONS, default: "neutral" },
status: { type: String, enum: VALID_STATUSES, default: "active" },
source: { type: String, default: "manual" },
duration: { type: Number, default: 0 },
confidence: { type: Number, default: 0 },
allEmotions: { type: Object, default: {} },
createdAt: { type: Date, default: Date.now }
});

const Activity = mongoose.model("Activity", activitySchema);

// =====================
// 📋 FR5 — Report Schema
// =====================
const reportSchema = new mongoose.Schema({
type: { type: String, enum: ["weekly", "monthly"], required: true },
scope: { type: String, enum: ["admin", "manager", "employee"], required: true },
ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
ownerEmail: { type: String, required: true },
summary: { type: Object, default: {} },
engagementScore: { type: Number, default: 0 },
periodStart: { type: Date, required: true },
periodEnd:   { type: Date, required: true },
generatedAt: { type: Date, default: Date.now }
});

const Report = mongoose.model("Report", reportSchema);

// =====================
// 🔌 Socket.IO — Real-Time (FR2)
// =====================
io.on("connection", (socket) => {
console.log("🔌 Client connected:", socket.id);

socket.on("join", (employeeId) => {
socket.join(employeeId);
console.log(`👤 Employee ${employeeId} joined room`);
});

socket.on("disconnect", () => {
console.log("❌ Client disconnected:", socket.id);
});
});

// =====================
// 🔐 LOGIN
// =====================
app.post("/login", async (req, res) => {
const { email, password } = req.body;

if (!isValidEmail(email) || !password) {
return res.json({ success: false, message: "Invalid input" });
}

try {
const admin = await Admin.findOne({ email });
if (admin && await checkPassword(password, admin.password)) {
return res.json({ success: true, role: "admin", name: admin.name, email: admin.email, id: admin._id });
}

const manager = await Manager.findOne({ email });
if (manager && await checkPassword(password, manager.password)) {
return res.json({ success: true, role: "manager", name: manager.name, email: manager.email, id: manager._id, hasAcceptedTerms: manager.hasAcceptedTerms });
}

const employee = await Employee.findOne({ email });
if (employee && await checkPassword(password, employee.password)) {
return res.json({ success: true, role: "employee", name: employee.name, email: employee.email, id: employee._id, hasAcceptedTerms: employee.hasAcceptedTerms });
}

return res.json({ success: false, message: "Wrong email or password" });

} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// ✅ ACCEPT TERMS
// =====================
app.post("/accept-terms", async (req, res) => {
const { email, role } = req.body;

if (!isValidEmail(email) || !role) {
return res.json({ success: false, message: "Invalid input" });
}

try {
if (role === "manager") {
const manager = await Manager.findOne({ email });
if (!manager) return res.json({ success: false, message: "Manager not found" });
await Manager.updateOne({ email }, { hasAcceptedTerms: true });
} else if (role === "employee") {
const employee = await Employee.findOne({ email });
if (!employee) return res.json({ success: false, message: "Employee not found" });
await Employee.updateOne({ email }, { hasAcceptedTerms: true });
} else {
return res.json({ success: false, message: "Invalid role" });
}
res.json({ success: true });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// ➕ ADD MANAGER
// =====================
app.post("/add-manager", async (req, res) => {
const { name, email, password, adminEmail } = req.body;

if (!name || !isValidEmail(email) || !isStrongPassword(password) || !isValidEmail(adminEmail)) {
return res.json({ success: false, message: "Invalid input" });
}

try {
const admin = await Admin.findOne({ email: adminEmail });
if (!admin) return res.json({ success: false, message: "Admin not found" });

const exists = await Manager.findOne({ email });
if (exists) return res.json({ success: false, message: "Email already exists" });

const hashed = await bcrypt.hash(password, 10);
const manager = new Manager({ name, email, password: hashed, adminId: admin._id });
await manager.save();

res.json({ success: true });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// ➕ ADD EMPLOYEE
// =====================
app.post("/add-employee", async (req, res) => {
const { name, email, password, adminEmail, managerEmail } = req.body;

if (!name || !isValidEmail(email) || !isStrongPassword(password) || !isValidEmail(adminEmail)) {
return res.json({ success: false, message: "Invalid input" });
}

try {
const admin = await Admin.findOne({ email: adminEmail });
if (!admin) return res.json({ success: false, message: "Admin not found" });

const exists = await Employee.findOne({ email });
if (exists) return res.json({ success: false, message: "Email already exists" });

let managerId = null;
if (managerEmail) {
const manager = await Manager.findOne({ email: managerEmail });
if (manager) managerId = manager._id;
}

const hashed = await bcrypt.hash(password, 10);
const emp = new Employee({ name, email, password: hashed, adminId: admin._id, managerId });
await emp.save();

res.json({ success: true });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// 📊 GET MANAGERS
// =====================
app.post("/get-managers", async (req, res) => {
const { email } = req.body;

if (!isValidEmail(email)) {
return res.json({ success: false, message: "Invalid input" });
}

try {
const admin = await Admin.findOne({ email });
if (!admin) return res.json({ success: false, message: "Admin not found" });

const managers = await Manager.find({ adminId: admin._id });
res.json({ success: true, managers });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// 📊 GET EMPLOYEES
// =====================
app.post("/get-employees", async (req, res) => {
const { email, role } = req.body;

if (!isValidEmail(email) || !role) {
return res.json({ success: false, message: "Invalid input" });
}

try {
if (role === "admin") {
const admin = await Admin.findOne({ email });
if (!admin) return res.json({ success: false, message: "Admin not found" });
const employees = await Employee.find({ adminId: admin._id });
return res.json({ success: true, employees });
}

if (role === "manager") {
const manager = await Manager.findOne({ email });
if (!manager) return res.json({ success: false, message: "Manager not found" });
const employees = await Employee.find({ managerId: manager._id });
return res.json({ success: true, employees });
}

res.json({ success: false, message: "Unauthorized role" });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// 📈 SAVE ACTIVITY (FR2 — server-side duration calculation)
// =====================
app.post("/save-activity", async (req, res) => {
const { email, emotion, status, source } = req.body;

if (!isValidEmail(email)) return res.json({ success: false, message: "Invalid email" });
if (!isValidEmotion(emotion)) return res.json({ success: false, message: `Invalid emotion. Must be one of: ${VALID_EMOTIONS.join(", ")}` });
if (!isValidStatus(status)) return res.json({ success: false, message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });

try {
const employee = await Employee.findOne({ email });
if (!employee) return res.json({ success: false, message: "Employee not found" });

const lastActivity = await Activity.findOne({ employeeId: employee._id }).sort({ createdAt: -1 });
const duration = lastActivity
? Math.floor((Date.now() - new Date(lastActivity.createdAt).getTime()) / 1000)
: 0;

const activity = await Activity.create({
employeeId: employee._id,
emotion,
status,
source,
duration
});

io.emit("activity-update", {
employeeId: employee._id,
name: employee.name,
emotion,
status,
duration,
createdAt: activity.createdAt
});

res.json({ success: true, activity });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// 🧠 EMOTION INPUT (from Python FR1)
// =====================
app.post("/api/emotions", async (req, res) => {
try {
const { timestamp, source, dominant_emotion, confidence, all_emotions, email } = req.body;

if (!dominant_emotion || !VALID_EMOTIONS.includes(dominant_emotion)) {
return res.json({ success: false, message: `Invalid emotion. Must be one of: ${VALID_EMOTIONS.join(", ")}` });
}

let employeeId = null;
if (email && isValidEmail(email)) {
const employee = await Employee.findOne({ email });
if (employee) employeeId = employee._id;
}

const activity = new Activity({
employeeId,
emotion: dominant_emotion,
source: source || "python_fr1",
confidence: confidence || 0,
allEmotions: all_emotions || {},
createdAt: timestamp ? new Date(timestamp) : new Date()
});

await activity.save();

if (employeeId) {
io.emit("emotion-update", {
employeeId,
emotion: dominant_emotion,
confidence,
createdAt: activity.createdAt
});
}

res.json({ success: true });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// 📋 EMPLOYEE HISTORY
// =====================
app.post("/employee-history", async (req, res) => {
const { email } = req.body;

if (!isValidEmail(email)) return res.json({ success: false, message: "Invalid input" });

try {
const employee = await Employee.findOne({ email });
if (!employee) return res.json({ success: false, message: "Employee not found" });

const history = await Activity.find({ employeeId: employee._id }).sort({ createdAt: -1 });
res.json({ success: true, history });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// 📊 ADMIN REPORT (on-demand, FR5)
// =====================
app.post("/admin-report", async (req, res) => {
const { email, type } = req.body;

if (!isValidEmail(email)) return res.json({ success: false, message: "Invalid input" });

try {
const admin = await Admin.findOne({ email });
if (!admin) return res.json({ success: false, message: "Admin not found" });

const employees = await Employee.find({ adminId: admin._id });
const ids = employees.map(e => e._id);

const days = type === "monthly" ? 30 : 7;
const since = new Date();
since.setDate(since.getDate() - days);

const data = await Activity.find({ employeeId: { $in: ids }, createdAt: { $gte: since } });
const summary = data.reduce((acc, r) => { acc[r.emotion] = (acc[r.emotion] || 0) + 1; return acc; }, {});
const engagementScore = computeEngagementScore(data);

res.json({ success: true, summary, engagementScore, data });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// 📊 MANAGER REPORT (on-demand, FR5)
// =====================
app.post("/manager-report", async (req, res) => {
const { email, type } = req.body;

if (!isValidEmail(email)) return res.json({ success: false, message: "Invalid input" });

try {
const manager = await Manager.findOne({ email });
if (!manager) return res.json({ success: false, message: "Manager not found" });

const employees = await Employee.find({ managerId: manager._id });
const ids = employees.map(e => e._id);

const days = type === "monthly" ? 30 : 7;
const since = new Date();
since.setDate(since.getDate() - days);

const data = await Activity.find({ employeeId: { $in: ids }, createdAt: { $gte: since } });
const summary = data.reduce((acc, r) => { acc[r.emotion] = (acc[r.emotion] || 0) + 1; return acc; }, {});
const engagementScore = computeEngagementScore(data);

res.json({ success: true, summary, engagementScore, data });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// 📊 EMPLOYEE REPORT (on-demand, FR5)
// =====================
app.post("/employee-report", async (req, res) => {
const { email, type } = req.body;

if (!isValidEmail(email)) return res.json({ success: false, message: "Invalid input" });

try {
const employee = await Employee.findOne({ email });
if (!employee) return res.json({ success: false, message: "Employee not found" });

const days = type === "monthly" ? 30 : 7;
const since = new Date();
since.setDate(since.getDate() - days);

const data = await Activity.find({ employeeId: employee._id, createdAt: { $gte: since } });
const summary = data.reduce((acc, r) => { acc[r.emotion] = (acc[r.emotion] || 0) + 1; return acc; }, {});
const engagementScore = computeEngagementScore(data);

res.json({ success: true, summary, engagementScore, data });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// 📂 GET SAVED REPORTS (FR5 — retrieve auto-generated reports)
// =====================
app.post("/get-reports", async (req, res) => {
const { email, role, type } = req.body;

if (!isValidEmail(email) || !role) return res.json({ success: false, message: "Invalid input" });

try {
let ownerId;

if (role === "admin") {
const admin = await Admin.findOne({ email });
if (!admin) return res.json({ success: false, message: "Admin not found" });
ownerId = admin._id;
} else if (role === "manager") {
const manager = await Manager.findOne({ email });
if (!manager) return res.json({ success: false, message: "Manager not found" });
ownerId = manager._id;
} else if (role === "employee") {
const employee = await Employee.findOne({ email });
if (!employee) return res.json({ success: false, message: "Employee not found" });
ownerId = employee._id;
} else {
return res.json({ success: false, message: "Invalid role" });
}

const query = { ownerId, scope: role };
if (type) query.type = type;

const reports = await Report.find(query).sort({ generatedAt: -1 });
res.json({ success: true, reports });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// ⚙️ FR5 — Core Report Generator (saves to DB + emits via Socket.IO)
// =====================
async function generateAndSaveReports(reportType) {
const days = reportType === "monthly" ? 30 : 7;
const periodEnd = new Date();
const periodStart = new Date();
periodStart.setDate(periodStart.getDate() - days);

console.log(`📊 Generating ${reportType} reports...`);

try {
// --- Admin-level reports ---
const admins = await Admin.find();
for (const admin of admins) {
const employees = await Employee.find({ adminId: admin._id });
const ids = employees.map(e => e._id);
const data = await Activity.find({ employeeId: { $in: ids }, createdAt: { $gte: periodStart } });
const summary = data.reduce((acc, r) => { acc[r.emotion] = (acc[r.emotion] || 0) + 1; return acc; }, {});
const engagementScore = computeEngagementScore(data);

const report = await Report.create({
type: reportType,
scope: "admin",
ownerId: admin._id,
ownerEmail: admin.email,
summary,
engagementScore,
periodStart,
periodEnd
});

io.emit("report-ready", { role: "admin", ownerEmail: admin.email, reportType, reportId: report._id });
console.log(`✅ Admin report saved for ${admin.email}`);
}

// --- Manager-level reports ---
const managers = await Manager.find();
for (const manager of managers) {
const employees = await Employee.find({ managerId: manager._id });
const ids = employees.map(e => e._id);
const data = await Activity.find({ employeeId: { $in: ids }, createdAt: { $gte: periodStart } });
const summary = data.reduce((acc, r) => { acc[r.emotion] = (acc[r.emotion] || 0) + 1; return acc; }, {});
const engagementScore = computeEngagementScore(data);

const report = await Report.create({
type: reportType,
scope: "manager",
ownerId: manager._id,
ownerEmail: manager.email,
summary,
engagementScore,
periodStart,
periodEnd
});

io.emit("report-ready", { role: "manager", ownerEmail: manager.email, reportType, reportId: report._id });
console.log(`✅ Manager report saved for ${manager.email}`);
}

// --- Employee-level reports ---
const employees = await Employee.find();
for (const employee of employees) {
const data = await Activity.find({ employeeId: employee._id, createdAt: { $gte: periodStart } });
const summary = data.reduce((acc, r) => { acc[r.emotion] = (acc[r.emotion] || 0) + 1; return acc; }, {});
const engagementScore = computeEngagementScore(data);

const report = await Report.create({
type: reportType,
scope: "employee",
ownerId: employee._id,
ownerEmail: employee.email,
summary,
engagementScore,
periodStart,
periodEnd
});

io.emit("report-ready", { role: "employee", ownerEmail: employee.email, reportType, reportId: report._id });
console.log(`✅ Employee report saved for ${employee.email}`);
}

console.log(`✅ All ${reportType} reports generated.`);
} catch (err) {
console.error(`❌ Error generating ${reportType} reports:`, err.message);
}
}

// =====================
// ⏰ FR5 — Scheduled Auto-Generation (node-cron)
// Every Monday at 00:00  → weekly report
// 1st of every month at 00:00 → monthly report
// =====================
cron.schedule("0 0 * * 1", () => {
console.log("⏰ Cron triggered: weekly report");
generateAndSaveReports("weekly");
});

cron.schedule("0 0 1 * *", () => {
console.log("⏰ Cron triggered: monthly report");
generateAndSaveReports("monthly");
});

// =====================
// 🗑️ DELETE EMPLOYEE
// =====================
app.post("/delete-employee", async (req, res) => {
const { employeeId, adminEmail } = req.body;

if (!adminEmail || !isValidEmail(adminEmail)) return res.json({ success: false, message: "Invalid input" });

try {
const admin = await Admin.findOne({ email: adminEmail });
if (!admin) return res.json({ success: false, message: "Admin not found" });

const employee = await Employee.findById(employeeId);
if (!employee) return res.json({ success: false, message: "Employee not found" });

if (employee.adminId.toString() !== admin._id.toString())
return res.json({ success: false, message: "Unauthorized" });

await Employee.findByIdAndDelete(employeeId);
await Activity.deleteMany({ employeeId });

res.json({ success: true, message: "Employee deleted successfully" });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// 🗑️ DELETE MANAGER
// =====================
app.post("/delete-manager", async (req, res) => {
const { managerId, adminEmail } = req.body;

if (!adminEmail || !isValidEmail(adminEmail)) return res.json({ success: false, message: "Invalid input" });

try {
const admin = await Admin.findOne({ email: adminEmail });
if (!admin) return res.json({ success: false, message: "Admin not found" });

const manager = await Manager.findById(managerId);
if (!manager) return res.json({ success: false, message: "Manager not found" });

if (manager.adminId.toString() !== admin._id.toString())
return res.json({ success: false, message: "Unauthorized" });

await Manager.findByIdAndDelete(managerId);
await Employee.updateMany({ managerId }, { $unset: { managerId: "" } });

res.json({ success: true, message: "Manager deleted successfully" });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// 😊 UPDATE EMOTION (FR2)
// =====================
app.post("/update-emotion", async (req, res) => {
const { email, emotion, role } = req.body;

if (!isValidEmail(email) || !VALID_EMOTIONS.includes(emotion)) {
return res.json({ success: false, message: `Invalid input. Emotion must be: ${VALID_EMOTIONS.join(", ")}` });
}

try {
if (role === "manager") {
await Manager.updateOne({ email }, { emotion });
} else if (role === "employee") {
await Employee.updateOne({ email }, { emotion });
} else {
return res.json({ success: false, message: "Invalid role" });
}

io.emit("emotion-changed", { email, role, emotion });
res.json({ success: true });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// 🔄 UPDATE STATUS (FR2)
// =====================
app.post("/update-status", async (req, res) => {
const { email, status, role } = req.body;

if (!isValidEmail(email) || !VALID_STATUSES.includes(status)) {
return res.json({ success: false, message: `Invalid input. Status must be: ${VALID_STATUSES.join(", ")}` });
}

try {
if (role === "manager") {
await Manager.updateOne({ email }, { status });
} else if (role === "employee") {
await Employee.updateOne({ email }, { status });
} else {
return res.json({ success: false, message: "Invalid role" });
}

io.emit("status-changed", { email, role, status });
res.json({ success: true });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// 👤 GET PROFILE
// =====================
app.post("/get-profile", async (req, res) => {
const { email, role } = req.body;

if (!isValidEmail(email) || !role) return res.json({ success: false, message: "Invalid input" });

try {
if (role === "admin") {
const admin = await Admin.findOne({ email });
if (!admin) return res.json({ success: false, message: "Admin not found" });
return res.json({ success: true, user: { name: admin.name, email: admin.email, role: "admin" } });
}

if (role === "manager") {
const manager = await Manager.findOne({ email });
if (!manager) return res.json({ success: false, message: "Manager not found" });
return res.json({ success: true, user: { name: manager.name, email: manager.email, role: "manager", status: manager.status, emotion: manager.emotion } });
}

if (role === "employee") {
const employee = await Employee.findOne({ email });
if (!employee) return res.json({ success: false, message: "Employee not found" });
return res.json({ success: true, user: { name: employee.name, email: employee.email, role: "employee", status: employee.status, emotion: employee.emotion } });
}

res.json({ success: false, message: "Unknown role" });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// =====================
// 🚀 START SERVER
// =====================
server.listen(3000, () => console.log("🚀 Server running on http://localhost:3000"));