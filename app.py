import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / 'database' / '.env')
load_dotenv(BASE_DIR / '.env')

from managers.session_manager import SessionManager
from managers import websocket_manager
from routes.chat import chat_bp
from routes.expand import expand_bp
from routes.sessions import sessions_bp
from routes.submissions import submissions_bp, limiter

ALLOWED_ORIGINS = [
    'https://popularvote.marqed.it',
    'https://popularvote-frontend.onrender.com',
    'https://popularvote-production.up.railway.app',
    'http://localhost:6967',
]

app = Flask(__name__, static_folder=str(BASE_DIR / '..' / 'dist'))
CORS(app, origins=ALLOWED_ORIGINS, methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'])
limiter.init_app(app)

socketio = SocketIO(app, cors_allowed_origins=ALLOWED_ORIGINS)

session_manager = SessionManager()
session_manager.hydrate()

app.session_manager = session_manager
app.socketio = socketio

websocket_manager.register(socketio, session_manager)

app.register_blueprint(chat_bp, url_prefix='/api')
app.register_blueprint(expand_bp, url_prefix='/api')
app.register_blueprint(sessions_bp, url_prefix='/api')
app.register_blueprint(submissions_bp, url_prefix='/api')


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_frontend(path):
    static_dir = app.static_folder
    full_path = os.path.join(static_dir, path)
    if path and os.path.isfile(full_path):
        return send_from_directory(static_dir, path)
    return send_from_directory(static_dir, 'index.html')


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 2167))
    socketio.run(app, host='0.0.0.0', port=port)
