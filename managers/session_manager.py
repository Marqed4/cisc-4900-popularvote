import random
import string

from database import session_store as SessionStore

PHASES = {
    'OPEN': 'OPEN',
    'CLOSED': 'CLOSED',
    'CLUSTERING': 'CLUSTERING',
    'RESULTS': 'RESULTS',
    'EXPANDING': 'EXPANDING',
    'ENDED': 'ENDED',
    'DELETED': 'DELETED',
}


def _generate_code():
    chars = string.ascii_uppercase + string.digits
    return ''.join(random.choice(chars) for _ in range(6))


class SessionManager:
    def __init__(self):
        self.sessions = {}

    def generate_unique_code(self):
        code = _generate_code()
        while code in self.sessions:
            code = _generate_code()
        return code

    def hydrate(self):
        try:
            sessions = SessionStore.get_unclosed_sessions()
            for s in sessions:
                submissions = SessionStore.get_submissions(s['code']) or []
                clusters = SessionStore.get_clusters(s['code']) or []
                self.sessions[s['code']] = {
                    'code': s['code'],
                    'phase': s['phase'],
                    'tags': s.get('tags') or [],
                    'title': s.get('title') or '',
                    'description': s.get('description') or '',
                    'hostNotes': s.get('host_notes'),
                    'submissions': submissions,
                    'clusters': clusters,
                    'participantCount': 0,
                    'expansionRound': s.get('expansion_round') or 0,
                    'curators': s.get('curators') or [],
                    'contextualFacts': [f for c in clusters for f in (c.get('contextual_facts') or [])],
                    'submissionsAtLastCluster': len(submissions) if clusters else 0,
                }
            print(f'[SessionManager] hydrated {len(sessions)} session(s) from Supabase')
        except Exception as err:
            print('[SessionManager] hydration failed:', err)

    def create_session(self, tags=None, title='', description=''):
        tags = tags or []
        code = self.generate_unique_code()
        session = {
            'code': code,
            'phase': PHASES['OPEN'],
            'tags': tags,
            'title': title,
            'description': description,
            'hostNotes': None,
            'submissions': [],
            'clusters': [],
            'participantCount': 0,
            'expansionRound': 0,
            'curators': [],
            'contextualFacts': [],
            'submissionsAtLastCluster': 0,
        }
        self.sessions[code] = session
        try:
            SessionStore.create_session(code, tags, title, description)
        except Exception as err:
            print('[SessionManager] failed to persist session:', err)
        return session

    def get_session(self, code):
        return self.sessions.get(code)

    def get_session_async(self, code):
        if code in self.sessions:
            return self.sessions[code]

        try:
            s = SessionStore.get_session(code)
            if not s:
                return None
            submissions = SessionStore.get_submissions(code) or []
            clusters = SessionStore.get_clusters(code) or []
            session = {
                'code': s['code'],
                'phase': s['phase'],
                'tags': s.get('tags') or [],
                'title': s.get('title') or '',
                'description': s.get('description') or '',
                'hostNotes': s.get('host_notes'),
                'submissions': submissions,
                'clusters': clusters,
                'participantCount': 0,
                'expansionRound': s.get('expansion_round') or 0,
                'curators': s.get('curators') or [],
                'contextualFacts': [f for c in clusters for f in (c.get('contextual_facts') or [])],
            }
            self.sessions[code] = session
            return session
        except Exception:
            return None

    def transition_phase(self, code, new_phase):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')
        session['phase'] = new_phase
        SessionStore.update_phase(code, new_phase)
        return session

    def increment_participants(self, code):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')
        session['participantCount'] += 1
        return session['participantCount']

    def decrement_participants(self, code):
        session = self.get_session(code)
        if not session:
            return
        session['participantCount'] = max(0, session['participantCount'] - 1)
        return session['participantCount']

    def add_submission(self, code, content):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')
        submittable_phases = [PHASES['OPEN'], PHASES['RESULTS'], PHASES['EXPANDING']]
        if session['phase'] not in submittable_phases:
            raise Exception('Submission window is closed')

        saved = SessionStore.add_submission(code, content)
        session['submissions'].append(saved)
        return saved

    def delete_submission(self, code, submission_id):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        session['submissions'] = [s for s in session['submissions'] if str(s['id']) != str(submission_id)]
        SessionStore.delete_submission(submission_id)

    def delete_session(self, code):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        self.transition_phase(code, PHASES['DELETED'])
        del self.sessions[code]

    def answer_submission(self, code, submission_id, answer):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        submission = next((s for s in session['submissions'] if str(s['id']) == str(submission_id)), None)
        if not submission:
            raise Exception('Submission not found')

        submission['participant_answer'] = answer
        SessionStore.update_submission_answer(submission_id, answer)
        return submission

    def save_clusters(self, code, clusters):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        saved = SessionStore.save_clusters(code, clusters)
        session['clusters'] = saved
        return saved

    def delete_cluster(self, code, cluster_id):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        session['clusters'] = [c for c in session['clusters'] if str(c['id']) != str(cluster_id)]
        SessionStore.delete_cluster(cluster_id)

    def update_cluster_answer(self, code, cluster_id, answer):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        cluster = next((c for c in session['clusters'] if str(c['id']) == str(cluster_id)), None)
        if not cluster:
            raise Exception('Cluster not found')
        cluster['answer'] = answer
        SessionStore.update_cluster_answer(cluster_id, answer)
        return cluster

    def add_participant_answer_to_cluster(self, code, cluster_id, answer):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        cluster = next((c for c in session['clusters'] if str(c['id']) == str(cluster_id)), None)
        if not cluster:
            raise Exception('Cluster not found')

        cluster['participant_answers'] = (cluster.get('participant_answers') or []) + [answer]
        SessionStore.add_participant_answer_to_cluster(cluster_id, answer)
        return cluster

    def save_expansion_preview(self, code, cluster_previews, contextual_facts):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        session['contextualFacts'] = (session.get('contextualFacts') or []) + contextual_facts

        for preview in cluster_previews:
            cluster = next((c for c in session['clusters'] if c['id'] == preview['clusterId']), None)
            if not cluster:
                print(f'[saveExpansionPreview] no cluster found for id: {preview["clusterId"]}')
                continue

            cluster['previewed_questions'] = preview['previewedQuestions']
            SessionStore.update_cluster_previewed_questions(cluster['id'], preview['previewedQuestions'])
            SessionStore.update_cluster_contextual_facts(cluster['id'], contextual_facts)

        return session

    def toggle_selected_question(self, code, cluster_id, question):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        cluster = next((c for c in session['clusters'] if str(c['id']) == str(cluster_id)), None)
        if not cluster:
            raise Exception('Cluster not found')

        current = cluster.get('selected_questions') or []
        already_selected = question in current

        cluster['selected_questions'] = [q for q in current if q != question] if already_selected else current + [question]

        SessionStore.update_cluster_selected_questions(cluster_id, cluster['selected_questions'])
        return cluster

    def promote_curator(self, code, socket_id):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        already = socket_id in session['curators']
        session['curators'] = [c for c in session['curators'] if c != socket_id] if already else session['curators'] + [socket_id]

        SessionStore.update_curators(code, session['curators'])
        return session['curators']

    def trigger_expansion(self, code):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        session['expansionRound'] = (session.get('expansionRound') or 0) + 1
        SessionStore.increment_expansion_round(code)
        self.transition_phase(code, PHASES['EXPANDING'])
        return session

    def end_session(self, code):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')
        self.transition_phase(code, PHASES['ENDED'])

    def upvote_question(self, code, question_text, undo=False):
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        updated_cluster = None
        new_count = 0

        for cluster in session['clusters']:
            question = next((q for q in (cluster.get('questions') or []) if q['text'] == question_text), None)
            if question:
                question['upvoteCount'] = max(0, (question.get('upvoteCount') or 0) + (-1 if undo else 1))
                new_count = question['upvoteCount']
                updated_cluster = cluster
                break

        if not updated_cluster:
            raise Exception('Question not found')

        SessionStore.update_cluster_questions(updated_cluster['id'], updated_cluster['questions'])

        return {'questionText': question_text, 'upvoteCount': new_count}

    def restore_session(self, code, phase, tags, submissions, clusters):
        self.sessions[code] = {
            'code': code,
            'phase': phase,
            'tags': tags,
            'submissions': submissions,
            'clusters': clusters,
            'participantCount': 0,
            'expansionRound': 0,
            'curators': [],
            'contextualFacts': [],
        }
