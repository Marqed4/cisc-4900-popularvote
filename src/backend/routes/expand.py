from flask import Blueprint, request, jsonify, current_app
from src.backend.managers import clustering_controller as clustering_engine
from src.backend.managers.websocket_manager import to_session

expand_bp = Blueprint('expand', __name__)


@expand_bp.route('/sessions/<code>/expand', methods=['POST'])
def expand(code):
    # host presses "expand" once results are out. the AI looks at the existing clusters and
    # previews follow-up questions plus some background facts, to nudge the room toward
    # things nobody has asked yet. flow: RESULTS -> EXPANDING -> back to RESULTS.
    # EXPANDING barely lasts, it's set and cleared inside this one request.
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

        # the slow part, an AI call. it sees the clusters, the tags, and the facts earlier
        # rounds already turned up so it doesn't repeat itself.
        preview = clustering_engine.generate_expansion_preview(
            session['clusters'], session['tags'], session['contextualFacts']
        )

        # bump the round counter and flip the phase to EXPANDING (which also lets
        # submissions through, see add_submission), then store what the AI came up with
        session_manager.trigger_expansion(code)
        session_manager.save_expansion_preview(code, preview['clusterPreviews'], preview['contextualFacts'])

        # nothing else to wait on, so straight back to RESULTS
        session_manager.transition_phase(code, 'RESULTS')

        # two events: the preview itself, then a fresh results payload so the clusters on
        # screen pick up their new previewed_questions
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
        # if it died after the phase flipped, don't leave the room stuck in EXPANDING.
        # and if even this fails there's nothing left to do about it.
        try:
            session_manager.transition_phase(code, 'RESULTS')
        except Exception:
            pass
        return jsonify({'error': 'Expansion failed. You can retry.'}), 500
