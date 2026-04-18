import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import { Server } from "socket.io";
import twilio from "twilio";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ------------------
// MongoDB setup
// ------------------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// ------------------
// Patient schema
// ------------------
const patientSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
  },

  age: {
    type: Number,
    default: null,
  },

  gender: {
    type: String,
    default: "",
  },

  symptoms: {
    type: String,
    default: "",
  },

  recommendation: {
    disease: {
      type: String,
      default: "",
    },

    doctor: {
      type: String,
      default: "",
    },

    priority: {
      type: String,
      default: "Normal",
    },

    advice: {
      type: String,
      default: "",
    },
  },

  vitals: {
    heartRate: {
      type: Number,
      default: null,
    },

    spo2: {
      type: Number,
      default: null,
    },

    temperature: {
      type: Number,
      default: null,
    },

    alerts: {
      type: [String],
      default: [],
    },
  },

  prescription: {
    type: {
      doctor: {
        name: String,
        qualification: String,
        hospital: String,
      },

      medicines: [
        {
          name: String,
          frequency: String,
          duration: String,
          qty: Number,
          notes: String,
        },
      ],

      createdAt: {
        type: Date,
        default: Date.now,
      },
    },
    default: null,
  },

  seen: {
    type: Boolean,
    default: false,
  },

  timestamp: {
    type: Date,
    default: Date.now,
  },
});

const Patient = mongoose.model("Patient", patientSchema);

// ------------------
// HTTP server & Socket.IO
// ------------------
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const doctorSessions = {};

// ------------------
// Socket.IO
// ------------------
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("registerDoctor", ({ doctorId }) => {
    socket.join(doctorId);
    doctorSessions[doctorId] = new Date();

    console.log(`Doctor ${doctorId} joined room ${doctorId}`);
  });

  socket.on("registerPatient", ({ phone }) => {
    socket.join(phone);
    console.log(`Patient joined room ${phone}`);
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

// ------------------
// OTP
// ------------------
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const otps = {};

app.post("/api/send-otp", async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({
      success: false,
      error: "Phone required",
    });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    await twilioClient.messages.create({
      body: `Your OTP is ${otp}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
    });

    otps[phone] = otp;

    res.json({
      success: true,
      message: "OTP sent successfully",
    });
  } catch (err) {
    console.error("OTP send error:", err);

    res.status(500).json({
      success: false,
      error: "Failed to send OTP",
    });
  }
});

app.post("/api/verify-otp", (req, res) => {
  const { phone, otp } = req.body;

  if (otps[phone] && otps[phone] === otp) {
    delete otps[phone];

    return res.json({
      success: true,
    });
  }

  return res.status(400).json({
    success: false,
    error: "Invalid OTP",
  });
});

// ------------------
// Save patient data
// ------------------
app.post("/api/patient-data", async (req, res) => {
  try {
    const {
      phone,
      age,
      gender,
      symptoms,
      recommendation,
      vitals,
    } = req.body;

    const newPatient = await Patient.create({
      phone,
      age,
      gender,
      symptoms,
      recommendation,
      vitals,
      seen: false,
      timestamp: new Date(),
    });

    Object.entries(doctorSessions).forEach(([doctorId, loginTime]) => {
      if (newPatient.timestamp >= loginTime) {
        io.to(doctorId).emit("newPatientData", newPatient);
      }
    });

    res.json({
      success: true,
      patientId: newPatient._id,
    });
  } catch (err) {
    console.error("Error saving patient:", err);

    res.status(500).json({
      success: false,
      error: "Failed to save patient",
    });
  }
});

// ------------------
// Live doctor dashboard data
// ------------------
app.get("/api/live-patients", async (req, res) => {
  try {
    const { doctorId } = req.query;

    if (!doctorId || !doctorSessions[doctorId]) {
      return res.json({
        success: true,
        records: [],
      });
    }

    const loginTime = doctorSessions[doctorId];

    const records = await Patient.find({
      seen: false,
      timestamp: { $gte: loginTime },
    }).sort({ timestamp: -1 });

    res.json({
      success: true,
      records,
    });
  } catch (err) {
    console.error("Error fetching patients:", err);

    res.status(500).json({
      success: false,
      error: "Failed to fetch patients",
    });
  }
});

// ------------------
// Save prescription from doctor
// ------------------
app.post("/api/prescription/:patientId", async (req, res) => {
  try {
    const { patientId } = req.params;
    const { doctor, medicines } = req.body;

    const updatedPatient = await Patient.findByIdAndUpdate(
      patientId,
      {
        prescription: {
          doctor,
          medicines,
          createdAt: new Date(),
        },
        seen: true,
      },
      { new: true }
    );

    if (!updatedPatient) {
      return res.status(404).json({
        success: false,
        error: "Patient not found",
      });
    }

    io.to(updatedPatient.phone).emit(
      "receivePrescription",
      updatedPatient.prescription
    );

    console.log(
      `Prescription emitted to patient room ${updatedPatient.phone}`
    );

    res.json({
      success: true,
      prescription: updatedPatient.prescription,
    });
  } catch (err) {
    console.error("Error saving prescription:", err);

    res.status(500).json({
      success: false,
      error: "Failed to save prescription",
    });
  }
});

// ------------------
// Fetch prescription for polling
// ------------------
app.get("/api/prescription/:patientId", async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.patientId);

    if (!patient) {
      return res.status(404).json({
        success: false,
        error: "Patient not found",
      });
    }

    if (!patient.prescription) {
      return res.json({
        success: false,
        message: "Prescription not available yet",
      });
    }

    return res.json({
      success: true,
      prescription: patient.prescription,
    });
  } catch (err) {
    console.error("Error fetching prescription:", err);

    res.status(500).json({
      success: false,
      error: "Failed to fetch prescription",
    });
  }
});

// ------------------
// Mark patient as seen
// ------------------
app.post("/api/mark-seen", async (req, res) => {
  try {
    const { patientId } = req.body;

    await Patient.findByIdAndUpdate(patientId, {
      seen: true,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Error marking patient as seen:", err);

    res.status(500).json({ success: false });
  }
});

// ------------------
// Start server
// ------------------
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
