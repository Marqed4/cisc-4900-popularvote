from flask import Blueprint, request, jsonify, current_app
from pypdf import PdfReader
import io

from src.backend.managers import clustering_controller as clustering_engine
from src.backend.managers.websocket_manager import to_session
from src.backend.database import session_store as SessionStore

sessions_bp = Blueprint('sessions', __name__)

MAX_PDF_SIZE = 10 * 1024 * 1024


@sessions_bp.route('/sessions', methods=['POST'])
def create_session():
    try:
        body = request.get_json(silent=True) or {}
        tags = body.get('tags', [])
        title = body.get('title', '')
        description = body.get('description', '')
        encrypted = bool(body.get('encrypted', False))
        session_manager = current_app.session_manager
        session = session_manager.create_session(tags, title, description, encrypted)
        return jsonify({
            'code': session['code'], 'phase': session['phase'], 'tags': session['tags'],
            'title': session['title'], 'description': session['description'],
            'encrypted': session['encrypted'],
        })
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to create session'}), 500


@sessions_bp.route('/sessions/<code>/join', methods=['POST'])
def join_session(code):
    try:
        session_manager = current_app.session_manager
        session = session_manager.get_session_async(code)

        if not session:
            return jsonify({'error': 'Session not found'}), 404

        if session['phase'] == 'ENDED':
            return jsonify({
                'code': session['code'], 'phase': session['phase'],
                'participantCount': session['participantCount'], 'summaryAvailable': True,
            })

        count = session_manager.increment_participants(code)
        return jsonify({'code': session['code'], 'phase': session['phase'], 'participantCount': count})
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to join session'}), 500


@sessions_bp.route('/sessions/<code>/close', methods=['POST'])
def close_session(code):
    try:
        session_manager = current_app.session_manager
        socketio = current_app.socketio
        session = session_manager.get_session_async(code)

        if not session:
            return jsonify({'error': 'Session not found'}), 404
        if session['phase'] not in ('OPEN', 'EXPANDING'):
            return jsonify({'error': 'Session is not accepting submissions'}), 400

        session_manager.transition_phase(code, 'CLOSED')
        to_session(socketio, code, 'session:closed', None)

        return jsonify({'code': code, 'phase': 'CLOSED'})
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to close session'}), 500


@sessions_bp.route('/sessions/<code>/cluster', methods=['POST'])
def cluster_session(code):
    session_manager = current_app.session_manager
    socketio = current_app.socketio
    session = session_manager.get_session(code)

    try:
        if not session:
            return jsonify({'error': 'Session not found'}), 404
        if len(session['submissions']) == 0:
            return jsonify({'error': 'No submissions to cluster'}), 400
        if session['phase'] not in ('OPEN', 'CLOSED', 'RESULTS'):
            return jsonify({'error': 'Session is not in a clusterable state'}), 400

        session_manager.transition_phase(code, 'CLUSTERING')
        to_session(socketio, code, 'session:clustering', None)

        if session.get('encrypted'):
            body = request.get_json(silent=True) or {}
            clusters = body.get('clusters')
            if not isinstance(clusters, list):
                return jsonify({'error': 'Encrypted session requires client-computed clusters'}), 400

            saved = session_manager.save_clusters(code, clusters)
            session['submissionsAtLastCluster'] = len(session['submissions'])
            session_manager.transition_phase(code, 'RESULTS')

            to_session(socketio, code, 'session:results', {
                'clusters': saved, 'submissionsAtLastCluster': len(session['submissions']),
            })
            return jsonify({'clusters': saved})

        answered_clusters = [c for c in (session.get('clusters') or []) if c.get('answer')]
        last_cluster_idx = session.get('submissionsAtLastCluster') or 0
        new_subs = session['submissions'][last_cluster_idx:]

        if answered_clusters and new_subs:
            result = clustering_engine.incremental_cluster(new_subs, answered_clusters, session['tags'])

            for update in result['updatedClusters']:
                cluster_id = update['clusterId']
                added_questions = update['addedQuestions']
                cluster = next((c for c in session['clusters'] if str(c['id']) == str(cluster_id)), None)
                if not cluster:
                    continue
                cluster['questions'] = (cluster.get('questions') or []) + added_questions
                cluster['submission_count'] = (cluster.get('submission_count') or 0) + len(added_questions)
                try:
                    SessionStore.update_cluster_query(cluster_id, cluster['representative_query'], cluster['submission_count'], cluster['questions'])
                except Exception as err:
                    print(f'[incremental] failed to update cluster {cluster_id}', err)

            if result['newClusters']:
                saved_new = SessionStore.save_new_clusters(code, result['newClusters'])
                session['clusters'].extend(saved_new)

            session['submissionsAtLastCluster'] = len(session['submissions'])
            session_manager.transition_phase(code, 'RESULTS')
            to_session(socketio, code, 'session:results', {
                'clusters': session['clusters'], 'submissionsAtLastCluster': len(session['submissions']),
            })
            return jsonify({'clusters': session['clusters']})

        clusters = clustering_engine.cluster(session['submissions'], session['tags'])

        saved = session_manager.save_clusters(code, clusters)
        session['submissionsAtLastCluster'] = len(session['submissions'])
        session_manager.transition_phase(code, 'RESULTS')

        to_session(socketio, code, 'session:results', {
            'clusters': saved, 'submissionsAtLastCluster': len(session['submissions']),
        })

        response = jsonify({'clusters': saved})

        if session.get('hostNotes'):
            try:
                suggestions = []
                for cluster in saved:
                    suggestion = clustering_engine.generate_suggested_answer(
                        cluster, session['hostNotes'], session['title'], session['description']
                    )
                    suggestions.append({'clusterId': cluster['id'], 'suggestion': suggestion})
                to_session(socketio, code, 'cluster:suggestions', {'suggestions': suggestions})
            except Exception as err:
                print('[RAG] suggestion generation failed:', err)

        return response
    except Exception as err:
        print(err)
        session_manager.transition_phase(code, 'CLOSED')
        to_session(socketio, code, 'session:closed', None)
        return jsonify({'error': 'Clustering failed. You can retry.'}), 500


@sessions_bp.route('/sessions/<code>/clusters/<cluster_id>/select', methods=['POST'])
def select_question(code, cluster_id):
    try:
        body = request.get_json() or {}
        question = body.get('question')
        session_manager = current_app.session_manager
        socketio = current_app.socketio

        cluster = session_manager.toggle_selected_question(code, cluster_id, question)

        to_session(socketio, code, 'question:selected', {
            'clusterId': cluster_id, 'selectedQuestions': cluster['selected_questions'],
        })

        return jsonify({'clusterId': cluster_id, 'selectedQuestions': cluster['selected_questions']})
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to toggle selected question'}), 500


@sessions_bp.route('/sessions/<code>/clusters/<cluster_id>/submit', methods=['POST'])
def submit_to_cluster(code, cluster_id):
    try:
        body = request.get_json() or {}
        content = body.get('content')
        session_manager = current_app.session_manager
        socketio = current_app.socketio
        session = session_manager.get_session(code)

        if not session:
            return jsonify({'error': 'Session not found'}), 404
        if not content or not content.strip():
            return jsonify({'error': 'Question is required'}), 400
        if len(content) > 500:
            return jsonify({'error': 'Question exceeds 500 character limit'}), 400

        content = content.strip()
        saved = SessionStore.add_submission(code, content)
        session['submissions'].append(saved)

        cluster = next((c for c in session['clusters'] if str(c['id']) == str(cluster_id)), None)
        if cluster:
            cluster['questions'] = (cluster.get('questions') or []) + [{'text': content, 'upvoteCount': 0}]
            cluster['submission_count'] = (cluster.get('submission_count') or 0) + 1
            SessionStore.update_cluster_query(cluster_id, cluster['representative_query'], cluster['submission_count'], cluster['questions'])

        socketio.emit('submission:count', {'count': len(session['submissions'])}, to=code)
        socketio.emit('cluster:submission:added', {
            'clusterId': cluster_id,
            'question': {'text': content, 'upvoteCount': 0},
            'submissionCount': cluster['submission_count'] if cluster else 0,
        }, to=code)

        return jsonify({'id': saved['id'], 'content': saved['content']})
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to submit to cluster'}), 500


@sessions_bp.route('/sessions/<code>/clusters/<cluster_id>/answer', methods=['POST'])
def answer_cluster(code, cluster_id):
    try:
        body = request.get_json() or {}
        answer = body.get('answer')
        question = request.args.get('question')
        session_manager = current_app.session_manager
        socketio = current_app.socketio

        if question:
            cluster = session_manager.add_participant_answer_to_cluster(code, cluster_id, answer)
            to_session(socketio, code, 'cluster:followup:answered', {'clusterId': cluster_id, 'answer': answer})
            return jsonify(cluster)

        cluster = session_manager.update_cluster_answer(code, cluster_id, answer)
        to_session(socketio, code, 'cluster:answered', {'clusterId': cluster_id, 'answer': answer})

        try:
            suggestions = clustering_engine.generate_followup_suggestions(
                cluster['representative_query'], answer, cluster.get('questions') or []
            )
            if suggestions:
                to_session(socketio, code, 'cluster:followups', {'clusterId': cluster_id, 'suggestions': suggestions})
        except Exception as err:
            print('[followups] generation failed:', err)

        return jsonify(cluster)
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to save answer'}), 500


@sessions_bp.route('/sessions/<code>/curators', methods=['POST'])
def update_curators(code):
    try:
        body = request.get_json() or {}
        socket_id = body.get('socketId')
        session_manager = current_app.session_manager
        socketio = current_app.socketio

        curators = session_manager.promote_curator(code, socket_id)

        to_session(socketio, code, 'curator:promoted', {'curators': curators, 'socketId': socket_id})

        return jsonify({'curators': curators})
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to update curator'}), 500


@sessions_bp.route('/sessions/<code>/upvote', methods=['POST'])
def upvote(code):
    try:
        body = request.get_json() or {}
        question_text = body.get('questionText')
        undo = body.get('undo', False)
        session_manager = current_app.session_manager
        socketio = current_app.socketio

        if not question_text:
            return jsonify({'error': 'questionText is required'}), 400

        result = session_manager.upvote_question(code, question_text, undo)

        to_session(socketio, code, 'cluster:upvote', {
            'questionText': question_text, 'upvoteCount': result['upvoteCount'],
        })
        return jsonify({'questionText': question_text, 'upvoteCount': result['upvoteCount']})
    except Exception as err:
        if str(err) == 'Session not found':
            return jsonify({'error': str(err)}), 404
        if str(err) == 'Question not found':
            return jsonify({'error': str(err)}), 404
        print(err)
        return jsonify({'error': 'Failed to record upvote'}), 500


@sessions_bp.route('/sessions/<code>/context', methods=['PATCH'])
def update_context(code):
    try:
        body = request.get_json() or {}
        title = body.get('title', '')
        description = body.get('description', '')
        session_manager = current_app.session_manager

        session = session_manager.get_session(code)
        if not session:
            return jsonify({'error': 'Session not found'}), 404

        session['title'] = title
        session['description'] = description
        try:
            SessionStore.update_session_context(code, title, description)
        except Exception as err:
            print('[context] DB write failed (schema cache may be stale):', err)

        return jsonify({'title': title, 'description': description})
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to update session context'}), 500


@sessions_bp.route('/sessions/<code>/notes', methods=['PATCH'])
def update_notes(code):
    try:
        session_manager = current_app.session_manager

        session = session_manager.get_session(code)
        if not session:
            return jsonify({'error': 'Session not found'}), 404

        pdf_file = request.files.get('pdf')
        if pdf_file:
            data = pdf_file.read()
            if len(data) > MAX_PDF_SIZE:
                return jsonify({'error': 'PDF exceeds 10MB limit'}), 400
            reader = PdfReader(io.BytesIO(data))
            extracted_text = '\n'.join(page.extract_text() or '' for page in reader.pages).strip()
            if not extracted_text:
                return jsonify({'error': 'Could not extract text from PDF'}), 400
            return jsonify({'extracted': extracted_text})

        body = request.get_json(silent=True) or {}
        host_notes = body.get('hostNotes')
        session['hostNotes'] = host_notes
        try:
            SessionStore.update_host_notes(code, host_notes)
        except Exception as err:
            print('[notes] DB write failed (schema cache may be stale):', err)

        return jsonify({'success': True, 'length': len(host_notes) if host_notes else 0})
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to save host notes'}), 500


@sessions_bp.route('/sessions/<code>/tags', methods=['PATCH'])
def update_tags(code):
    try:
        session_manager = current_app.session_manager
        body = request.get_json() or {}
        tags = body.get('tags')

        if not isinstance(tags, list):
            return jsonify({'error': 'tags must be an array'}), 400

        session = session_manager.get_session_async(code)
        if not session:
            return jsonify({'error': 'Session not found'}), 404
        if session['phase'] not in ('OPEN', 'RESULTS', 'ENDED'):
            return jsonify({'error': 'Tags can only be updated in OPEN, RESULTS, or ENDED phase'}), 400

        session['tags'] = tags
        SessionStore.update_tags(code, tags)

        return jsonify({'tags': session['tags']})
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to update tags'}), 500


@sessions_bp.route('/sessions/<code>', methods=['GET'])
def get_session(code):
    try:
        session_manager = current_app.session_manager
        session = session_manager.get_session_async(code)

        if not session:
            return jsonify({'error': 'Session not found, buddy'}), 404

        return jsonify({
            'code': session['code'],
            'phase': session['phase'],
            'tags': session['tags'],
            'title': session.get('title') or '',
            'description': session.get('description') or '',
            'hostNotes': session.get('hostNotes'),
            'clusters': session.get('clusters') or [],
            'submissions': session.get('submissions') or [],
            'submissionCount': len(session.get('submissions') or []),
            'submissionsAtLastCluster': session.get('submissionsAtLastCluster') or 0,
            'participantCount': session.get('participantCount') or 0,
            'expansionRound': session.get('expansionRound') or 0,
            'curators': session.get('curators') or [],
            'contextualFacts': session.get('contextualFacts') or [],
            'encrypted': session.get('encrypted') or False,
        })
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to load the session, my guy'}), 500


@sessions_bp.route('/sessions/<code>/end', methods=['POST'])
def end_session(code):
    try:
        session_manager = current_app.session_manager
        socketio = current_app.socketio
        session = session_manager.get_session(code)

        if not session:
            return jsonify({'error': 'Session not found'}), 404

        summary = [{
            'representativeQuery': c.get('representative_query'),
            'submissionCount': c.get('submission_count'),
            'answer': c.get('answer'),
            'participantAnswers': c.get('participant_answers') or [],
            'selectedQuestions': c.get('selected_questions') or [],
            'contextualFacts': c.get('contextual_facts') or [],
        } for c in session['clusters']]

        to_session(socketio, code, 'session:ended', {'summary': summary})

        session_manager.end_session(code)
        return jsonify({'message': 'Session ended', 'summary': summary})
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to end session'}), 500


@sessions_bp.route('/sessions/<code>/summary', methods=['GET'])
def get_summary(code):
    try:
        session_manager = current_app.session_manager
        session = session_manager.get_session_async(code)

        if not session:
            return jsonify({'error': 'Session not found'}), 404
        if session['phase'] != 'ENDED':
            return jsonify({'error': 'Summary is not available until the session has ended'}), 403

        summary = {
            'code': session['code'],
            'title': session.get('title') or '',
            'description': session.get('description') or '',
            'tags': session.get('tags') or [],
            'expansionRound': session.get('expansionRound') or 0,
            'contextualFacts': session.get('contextualFacts') or [],
            'clusters': [{
                'id': c['id'],
                'representativeQuery': c.get('representative_query'),
                'submissionCount': c.get('submission_count'),
                'questions': c.get('questions') or [],
                'answer': c.get('answer'),
                'participantAnswers': c.get('participant_answers') or [],
                'selectedQuestions': c.get('selected_questions') or [],
                'contextualFacts': c.get('contextual_facts') or [],
            } for c in session['clusters']],
        }

        return jsonify(summary)
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to load session summary'}), 500


@sessions_bp.route('/sessions/<code>/clusters/<cluster_id>', methods=['DELETE'])
def delete_cluster(code, cluster_id):
    try:
        session_manager = current_app.session_manager
        socketio = current_app.socketio

        session_manager.delete_cluster(code, cluster_id)

        to_session(socketio, code, 'cluster:deleted', {'clusterId': cluster_id})

        return jsonify({'message': 'Cluster deleted'})
    except Exception as err:
        print(err)
        return jsonify({'error': 'Failed to delete cluster'}), 500
