from flask import Flask, request, jsonify
from flask_cors import CORS
import pandas as pd
from deep_translator import GoogleTranslator
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.naive_bayes import MultinomialNB
from sklearn.pipeline import make_pipeline
from dotenv import load_dotenv
load_dotenv()

# --------------------------
# Helper: translation
# --------------------------
def translate_to_english(text):
    try:
        return GoogleTranslator(source='auto', target='en').translate(text)
    except Exception as e:
        print("Translation error:", e)
        return text  # fallback

# --------------------------
# Load data + train once
# --------------------------
data = pd.read_csv("data.csv")
doctors = pd.read_csv("doctors.csv")

model = make_pipeline(TfidfVectorizer(), MultinomialNB())
model.fit(data["symptom"], data["disease"])

def predict_disease_and_doctor(user_input):
    translated = translate_to_english(user_input)
    disease = model.predict([translated])[0]
    doctor_row = doctors[doctors["disease"] == disease]
    if not doctor_row.empty:
        doctor = doctor_row["doctor"].values[0]
    else:
        doctor = "Doctor not found"
    return translated, disease, doctor

# --------------------------
# Flask app
# --------------------------
app = Flask(__name__)
CORS(app)  # allow requests from React frontend

@app.route('/predict', methods=['POST'])
def predict():
    user_input = request.json.get('symptom')
    translated, disease, doctor = predict_disease_and_doctor(user_input)
    return jsonify({
        "translated": translated,
        "disease": disease,
        "doctor": doctor
    })

if __name__ == "__main__":
    app.run(port=5001, debug=True)
