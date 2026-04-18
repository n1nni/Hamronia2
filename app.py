from flask import Flask, render_template, request, send_file, Response, jsonify
import os
import uuid
import io
from datetime import datetime
from staff_detection import detect_staves

app = Flask(__name__)

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
MUSICXML    = os.path.join(BASE_DIR, "02 Ixarebs suli sheni.musicxml")
UPLOADS_DIR = os.path.join(BASE_DIR, 'static', 'uploads')
EXPORTS_DIR = os.path.join(BASE_DIR, 'exports')

os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(EXPORTS_DIR, exist_ok=True)


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/score')
def get_score():
    with open(MUSICXML, 'r', encoding='utf-8') as f:
        content = f.read()
    return Response(content, mimetype='application/xml; charset=utf-8')


@app.route('/api/upload', methods=['POST'])
def upload_image():
    if 'image' not in request.files:
        return jsonify({'error': 'No image file'}), 400
    f = request.files['image']
    ext = os.path.splitext(f.filename)[1].lower() or '.jpg'
    filename = f'score_{uuid.uuid4().hex[:10]}{ext}'
    f.save(os.path.join(UPLOADS_DIR, filename))
    return jsonify({'url': f'/static/uploads/{filename}', 'filename': filename})


@app.route('/api/detect_staves', methods=['POST'])
def detect_staves_endpoint():
    data = request.get_json(silent=True) or {}
    filename = data.get('filename', '')
    # Defensive: only allow a bare filename under UPLOADS_DIR.
    if not filename or '/' in filename or '\\' in filename or '..' in filename:
        return jsonify({'error': 'Invalid filename'}), 400
    path = os.path.join(UPLOADS_DIR, filename)
    if not os.path.isfile(path):
        return jsonify({'error': 'File not found'}), 404
    result = detect_staves(path)
    if result is None:
        return jsonify({'error': 'Could not read image'}), 500
    return jsonify(result)


@app.route('/api/download', methods=['POST'])
def download():
    xml_content = request.get_data(as_text=True)
    timestamp   = datetime.now().strftime('%Y%m%d_%H%M%S')
    filename    = f'score_edited_{timestamp}.musicxml'
    # Save a copy to the project exports folder
    with open(os.path.join(EXPORTS_DIR, filename), 'w', encoding='utf-8') as f:
        f.write(xml_content)
    buf = io.BytesIO(xml_content.encode('utf-8'))
    buf.seek(0)
    return send_file(buf, as_attachment=True, download_name=filename, mimetype='application/xml')


if __name__ == '__main__':
    app.run(debug=True, port=5000)
