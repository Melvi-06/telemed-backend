import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import { Server } from "socket.io";
import twilio from "twilio";
import path from "path";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// ------------------
// MongoDB setup
// ------------------
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error:", err));

const patientSchema = new mongoose.Schema({
  phone: String,
  symptoms: String,
  vitals: Object,
  seen: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now },
});
const Patient = mongoose.model("Patient", patientSchema);

// ------------------
// HTTP server & Socket.IO
// ------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const doctorSessions = {}; // { doctorId: loginTime }

// ------------------
// Socket.IO events
// ------------------
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("registerDoctor", ({ doctorId }) => {
    socket.join(doctorId);
    doctorSessions[doctorId] = new Date();
    console.log(`Doctor ${doctorId} logged in at ${doctorSessions[doctorId]}`);
  });

  socket.on("registerPatient", ({ phone }) => socket.join(phone));

  socket.on("startCall", ({ doctorId, patientPhone, room }) => {
    io.to(patientPhone).emit("incomingCall", { doctorId, room });
  });

  socket.on("acceptCall", ({ room, patientPhone, doctorId }) => {
    io.to(doctorId).emit("callAccepted", { room, patientPhone });
  });

  socket.on("joinRoom", ({ room }) => socket.join(room));

  socket.on("disconnect", () => console.log("Client disconnected:", socket.id));
});

// ------------------
// Twilio OTP logic
// ------------------
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const otps = {};

app.post("/api/send-otp", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: "Phone required" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    await twilioClient.messages.create({
      body: `Your OTP is ${otp}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone
    });

    otps[phone] = otp;
    console.log(`OTP for ${phone}: ${otp}`);

    res.json({ success: true, message: "OTP sent successfully" });
  } catch (err) {
    console.error("OTP send error:", err);
    res.status(500).json({ success: false, error: "Failed to send OTP" });
  }
});

app.post("/api/verify-otp", (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ success: false, error: "Phone and OTP required" });

  if (otps[phone] && otps[phone] === otp) {
    delete otps[phone];
    res.json({ success: true, message: "Phone verified" });
  } else {
    res.status(400).json({ success: false, error: "Invalid or expired OTP" });
  }
});

// ------------------
// Patient APIs
// ------------------
app.post("/api/patient-data", async (req, res) => {
  const { phone, symptoms, vitals } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: "Phone required" });

  try {
    const newPatient = await Patient.create({ phone, symptoms, vitals, seen: false });

    Object.entries(doctorSessions).forEach(([doctorId, loginTime]) => {
      if (newPatient.timestamp >= loginTime) {
        io.to(doctorId).emit("newPatientData", newPatient);
      }
    });

    res.json({ success: true, patientId: newPatient._id, message: "Patient data saved and sent to doctors" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to save patient data" });
  }
});

app.get("/api/live-patients", async (req, res) => {
  const { doctorId } = req.query;
  if (!doctorId || !doctorSessions[doctorId]) return res.json({ success: true, records: [] });

  try {
    const loginTime = doctorSessions[doctorId];
    const records = await Patient.find({ seen: false, timestamp: { $gte: loginTime } }).sort({ timestamp: 1 });
    res.json({ success: true, records });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to fetch live patients" });
  }
});

app.post("/api/mark-seen", async (req, res) => {
  const { phone } = req.body;
  try {
    await Patient.findOneAndUpdate({ phone }, { seen: true });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ------------------
// Serve both React apps
// ------------------




// ------------------
// Start server
// ------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
