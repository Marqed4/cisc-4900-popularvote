from flask import Blueprint, request, jsonify, current_app
from src.backend.managers import clustering_controller as clustering_engine
from src.backend.managers.websocket_manager import to_session

expand_bp = Blueprint('expand', __name__)


@expand_bp.route('/sessions/<code>/expand', methods=['POST'])
def expand(code):
    session_manager = current_app.session_manager
    socketio = current_app.socketio

    try:
        session = session_manager.get_session(code)

        if not session:
            return jsonify({'error': 'Session not found'}), 404
        if session['phase'] != 'RESULTS':
            return jsonify({'error': 'Can only expand from RESULTS phase'}), 400
        if len(session['clusters']) == 0:
            return jsonify({'error': 'No clusters to expand'}), 400

        preview = clustering_engine.generate_expansion_preview(
            session['clusters'], session['tags'], session['contextualFacts']
        )

        session_manager.trigger_expansion(code)
        session_manager.save_expansion_preview(code, preview['clusterPreviews'], preview['contextualFacts'])

        session_manager.transition_phase(code, 'RESULTS')

        to_session(socketio, code, 'expansion:preview', {
            'clusterPreviews': preview['clusterPreviews'],
            'contextualFacts': preview['contextualFacts'],
            'expansionRound': session['expansionRound'],
        })

        to_session(socketio, code, 'session:results', {'clusters': session['clusters']})

        return jsonify({
            'clusterPreviews': preview['clusterPreviews'],
            'contextualFacts': preview['contextualFacts'],
            'expansionRound': session['expansionRound'],
        })
    except Exception as err:
        print(err)
        try:
            session_manager.transition_phase(code, 'RESULTS')
        except Exception:
            pass
        return jsonify({'error': 'Expansion failed. You can retry.'}), 500
