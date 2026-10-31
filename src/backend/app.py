import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO

BASE_DIR = Path(__file__).resolve().parent

# env has to load before the imports below, supabase_client reads the keys the second it's
# imported... order matters here, which feels about right for most things.
load_dotenv(BASE_DIR / 'database' / '.env')
load_dotenv(BASE_DIR / '.env')

from src.backend.managers.session_manager import SessionManager
from src.backend.managers import websocket_manager
from src.backend.routes.chat import chat_bp
from src.backend.routes.expand import expand_bp
from src.backend.routes.sessions import sessions_bp
from src.backend.routes.submissions import submissions_bp, limiter

# the only places allowed to talk to this server, REST and sockets both. add your own
# frontend here or the browser will quietly refuse to hear back from us.
ALLOWED_ORIGINS = [
    'https://popularvote.marqed.it',
    'https://popularvote-frontend.onrender.com',
    'https://popularvote-production.up.railway.app',
    'http://localhost:6967',
]

app = Flask(__name__, static_folder=str(BASE_DIR / '..' / 'frontend' / 'dist'))
CORS(app, origins=ALLOWED_ORIGINS, methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'])
limiter.init_app(app)

socketio = SocketIO(app, cors_allowed_origins=ALLOWED_ORIGINS)

# sessions live in memory while the server runs, and Supabase is what remembers them after.
# hydrate() pulls them back on boot, so a restart is a nap and not a goodbye, I guess.
session_manager = SessionManager()
session_manager.hydrate()

# hang these on the app so the routes can reach them through current_app
app.session_manager = session_manager
app.socketio = socketio

websocket_manager.register(socketio, session_manager)

app.register_blueprint(chat_bp, url_prefix='/api')
app.register_blueprint(expand_bp, url_prefix='/api')
app.register_blueprint(sessions_bp, url_prefix='/api')
app.register_blueprint(submissions_bp, url_prefix='/api')


# too many requests from one place. send back json so the frontend can show the message
# instead of an html error page it can't read.
@app.errorhandler(429)
def rate_limit_exceeded(err):
    return jsonify({'error': str(err.description)}), 429


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_frontend(path):
    # in production the built frontend rides along with the backend. a real file gets sent
    # as is, and anything else gets index.html so React can figure out the route itself.
    static_dir = app.static_folder
    full_path = os.path.join(static_dir, path)
    if path and os.path.isfile(full_path):
        return send_from_directory(static_dir, path)
    return send_from_directory(static_dir, 'index.html')


if __name__ == '__main__':
    # one process only, sessions are in memory so a second worker would never find the first one's rooms
    port = int(os.environ.get('PORT', 2167))
    socketio.run(app, host='0.0.0.0', port=port)
