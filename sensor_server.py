from flask import Flask, jsonify
import random
from flask_cors import CORS
import time

app = Flask(__name__)
CORS(app)  # Allow React frontend to access

# Simulate previous data for charts
heart_rate_data = []
spo2_data = []
max_points = 20

def generate_data():
    global heart_rate_data, spo2_data
    hr = random.randint(60, 110)       # Heart Rate BPM
    spo2 = random.randint(88, 100)     # SpO2 %
    
    now = time.strftime("%H:%M:%S")
    
    # keep max 20 points
    if len(heart_rate_data) >= max_points:
        heart_rate_data.pop(0)
        spo2_data.pop(0)
    
    heart_rate_data.append({"time": now, "value": hr})
    spo2_data.append({"time": now, "value": spo2})
    
    return hr, spo2

@app.route("/vitals", methods=["GET"])
def vitals():
    hr, spo2 = generate_data()
    alerts = []
    
    if hr > 100:
        alerts.append(f"High heart rate: {hr} BPM")
    elif hr > 90:
        alerts.append(f"Elevated heart rate: {hr} BPM")
    
    if spo2 < 90:
        alerts.append(f"Low SpO₂: {spo2}%")
    elif spo2 < 95:
        alerts.append(f"Slightly low SpO₂: {spo2}%")
    
    if not alerts:
        alerts.append("All readings normal")
    
    return jsonify({
        "heart_rate": hr,
        "spo2": spo2,
        "heart_rate_chart": heart_rate_data,
        "spo2_chart": spo2_data,
        "alerts": alerts
    })

if __name__ == "__main__":
    app.run(port=5002, debug=True)
