"""
Shared fixtures for the backend test suite.

None of these tests talk to a real Supabase project or the Gemini API. Two
things make that possible:

1. Dummy credentials set before any backend module is imported, so
   supabase_client.py (which calls create_client(...) at import time) and
   clustering_controller.py (which calls genai.Client(...) at import time)
   don't blow up just from being imported.
2. Tests patch the specific SessionStore (or supabase) functions they
   exercise, so no network call is ever actually made.
"""
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

os.environ.setdefault('SUPABASE_URL', 'https://test.supabase.co')
os.environ.setdefault('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key')
os.environ.setdefault('GEMINI_API_KEY', 'test-gemini-key')

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


@pytest.fixture
def fake_socketio():
    """Stand-in for Flask-SocketIO's `socketio.emit(event, data, to=code)`."""
    return MagicMock()


@pytest.fixture
def fake_session_manager():
    """
    A controllable double for SessionManager, for route tests that only care
    whether the Flask view calls it correctly - not its own internals
    (those are covered separately in test_session_manager.py).
    """
    return MagicMock()


@pytest.fixture
def app(fake_socketio, fake_session_manager):
    from flask import Flask
    from src.backend.routes.sessions import sessions_bp
    from src.backend.routes.submissions import submissions_bp

    flask_app = Flask(__name__)
    flask_app.session_manager = fake_session_manager
    flask_app.socketio = fake_socketio
    flask_app.register_blueprint(sessions_bp, url_prefix='/api')
    flask_app.register_blueprint(submissions_bp, url_prefix='/api')
    return flask_app


@pytest.fixture
def client(app):
    return app.test_client()
