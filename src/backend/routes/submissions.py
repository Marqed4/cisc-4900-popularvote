import json

from flask import Blueprint, request, jsonify, current_app
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

from managers.websocket_manager import to_session

submissions_bp = Blueprint('submissions', __name__)

limiter = Limiter(key_func=get_remote_address)

# Base64 ciphertext + nonce runs well past a plaintext question's length.
ENCRYPTED_CONTENT_LIMIT = 2000


@submissions_bp.route('/sessions/<code>/submit', methods=['POST'])
@limiter.limit('10 per minute', error_message='Too many submissions. Please wait a moment.')
def submit(code):
    try:
        body = request.get_json() or {}
        content = body.get('content')
        nonce = body.get('nonce')
        session_manager = current_app.session_manager
        socketio = current_app.socketio
        session = session_manager.get_session(code)

        if not session:
            return jsonify({'error': 'Session not found'}), 404
        if session['phase'] not in ('OPEN', 'RESULTS', 'EXPANDING'):
            return jsonify({'error': 'Submission window is closed'}), 400
        if not content or content.strip() == '':
            return jsonify({'error': 'Question is required'}), 400

        encrypted = session.get('encrypted', False)
        if encrypted and not nonce:
            return jsonify({'error': 'Encrypted session requires a nonce'}), 400

        limit = ENCRYPTED_CONTENT_LIMIT if encrypted else 500
        if len(content) > limit:
            return jsonify({'error': f'Question exceeds {limit} character limit'}), 400

        stored_content = json.dumps({'ciphertext': content.strip(), 'nonce': nonce}) if encrypted else content.strip()
        submission = session_manager.add_submission(code, stored_content)

        socketio.emit('submission:count', {'count': len(session['submissions'])}, to=code)
        socketio.emit('submission:new', {'id': submission['id'], 'content': submission['content']}, to=code)

        return jsonify({'id': submission['id'], 'content': submission['content']})
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to submit question'}), 500


@submissions_bp.route('/sessions/<code>/submit/<submission_id>', methods=['DELETE'])
def delete_submission(code, submission_id):
    try:
        session_manager = current_app.session_manager
        socketio = current_app.socketio
        session = session_manager.get_session(code)

        if not session:
            return jsonify({'error': 'Session not found'}), 404

        session_manager.delete_submission(code, submission_id)
        socketio.emit('submission:count', {'count': len(session['submissions'])}, to=code)

        return jsonify({'message': 'Submission deleted'})
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to delete submission'}), 500


@submissions_bp.route('/sessions/<code>/submit/<submission_id>/answer', methods=['POST'])
@limiter.limit('10 per minute', error_message='Too many submissions. Please wait a moment.')
def answer_submission(code, submission_id):
    try:
        body = request.get_json() or {}
        answer = body.get('answer')
        session_manager = current_app.session_manager
        socketio = current_app.socketio
        session = session_manager.get_session(code)

        if not session:
            return jsonify({'error': 'Session not found'}), 404
        if not answer or answer.strip() == '':
            return jsonify({'error': 'Answer is required'}), 400
        if len(answer) > 500:
            return jsonify({'error': 'Answer exceeds 500 character limit'}), 400

        submission = session_manager.answer_submission(code, submission_id, answer.strip())

        to_session(socketio, code, 'submission:answered', {'submissionId': submission_id, 'answer': answer.strip()})

        return jsonify({'id': submission['id'], 'answer': submission['participant_answer']})
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to save answer'}), 500
