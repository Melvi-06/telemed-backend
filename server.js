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
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// ------------------
// Patient schema
// ------------------
const patientSchema = new mongoose.Schema({
  phone: String,
  symptoms: String,

  // Doctor suggested from SymptomsPage
  recommendedDoctor: {
    type: String,
    default: "",
  },

  vitals: Object,

  // Prescription stored after doctor sends it
  prescription: {
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
  },
});

// Stores which doctors are online
const doctorSessions = {};

// ------------------
// Socket.IO events
// ------------------
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("registerDoctor", ({ doctorId }) => {
    socket.join(doctorId);
    doctorSessions[doctorId] = new Date();

    console.log(
      `Doctor ${doctorId} logged in at ${doctorSessions[doctorId]}`
    );
  });

  socket.on("registerPatient", ({ phone }) => {
    socket.join(phone);
    console.log(`Patient ${phone} joined room ${phone}`);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
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

    console.log(`OTP for ${phone}: ${otp}`);

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

  if (!phone || !otp) {
    return res.status(400).json({
      success: false,
      error: "Phone and OTP required",
    });
  }

  if (otps[phone] && otps[phone] === otp) {
    delete otps[phone];

    return res.json({
      success: true,
      message: "Phone verified",
    });
  }

  return res.status(400).json({
    success: false,
    error: "Invalid or expired OTP",
  });
});

// ------------------
// Save patient data
// ------------------
app.post("/api/patient-data", async (req, res) => {
  const { phone, symptoms, recommendedDoctor, vitals } = req.body;

  console.log("Received patient data:", req.body);

  if (!phone) {
    return res.status(400).json({
      success: false,
      error: "Phone required",
    });
  }

  try {
    const newPatient = await Patient.create({
      phone,
      symptoms,
      recommendedDoctor,
      vitals,
      seen: false,
      timestamp: new Date(),
    });

    console.log("Saved patient:", newPatient);

    // Send patient data to all logged-in doctors
    Object.entries(doctorSessions).forEach(([doctorId, loginTime]) => {
      if (newPatient.timestamp >= loginTime) {
        io.to(doctorId).emit("newPatientData", newPatient);

        console.log(
          `Sent patient ${newPatient._id} with recommended doctor "${newPatient.recommendedDoctor}" to doctor ${doctorId}`
        );
      }
    });

    res.json({
      success: true,
      patientId: newPatient._id,
      message: "Patient data saved and sent to doctors",
    });
  } catch (err) {
    console.error("Error saving patient:", err);

    res.status(500).json({
      success: false,
      error: "Failed to save patient data",
    });
  }
});

// ------------------
// Fetch live patients for doctor dashboard
// ------------------
app.get("/api/live-patients", async (req, res) => {
  const { doctorId } = req.query;

  if (!doctorId || !doctorSessions[doctorId]) {
    return res.json({
      success: true,
      records: [],
    });
  }

  try {
    const loginTime = doctorSessions[doctorId];

    const records = await Patient.find({
      seen: false,
      timestamp: { $gte: loginTime },
    }).sort({ timestamp: 1 });

    res.json({
      success: true,
      records,
    });
  } catch (err) {
    console.error("Error fetching live patients:", err);

    res.status(500).json({
      success: false,
      error: "Failed to fetch live patients",
    });
  }
});

// ------------------
// Save prescription sent by doctor
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
      },
      {
        new: true,
      }
    );

    if (!updatedPatient) {
      return res.status(404).json({
        success: false,
        error: "Patient not found",
      });
    }

    // Also send instantly if patient is online
    io.to(updatedPatient.phone).emit(
      "receivePrescription",
      updatedPatient.prescription
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
// Patient side fetches prescription
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
        message: "Prescription not yet available",
      });
    }

    res.json({
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
  const { phone } = req.body;

  try {
    await Patient.findOneAndUpdate({ phone }, { seen: true });

    res.json({
      success: true,
    });
  } catch (err) {
    console.error("Error marking patient seen:", err);

    res.status(500).json({
      success: false,
    });
  }
});

// ------------------
// Start server
// ------------------
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
