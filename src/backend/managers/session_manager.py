# The session manager. Routes and sockets ask it for things, and it keeps every live session
# in a plain dict (self.sessions, keyed by room code). Supabase (session_store.py) is the
# backup: nearly every method here changes memory first, then writes the same change to the DB.
#
# Phases a session moves through, and which method moves it:
#
#   OPEN --close--> CLOSED --cluster--> CLUSTERING --> RESULTS --expand--> EXPANDING --> RESULTS
#                                                                 any phase --end--> ENDED
#                                                                 host socket --delete--> DELETED
#
# the arrows are driven from routes/sessions.py and routes/expand.py through transition_phase().
# EXPANDING only exists for the length of one expand request, then it's back to RESULTS.
import random
import string

from src.backend.database import session_store as SessionStore

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
    # six characters, uppercase and digits. about two billion combinations, which is plenty
    # for a classroom and not at all plenty for secrecy
    chars = string.ascii_uppercase + string.digits
    return ''.join(random.choice(chars) for _ in range(6))


class SessionManager:
    def __init__(self):
        # code -> session dict. this is the whole live state of the app, a restart empties it
        # and hydrate() below is how it fills back up.
        self.sessions = {}

    def generate_unique_code(self):
        # keep rolling until the code isn't taken. only checks memory, not the database,
        # so a collision with an old session that was never hydrated is possible, if unlikely.
        code = _generate_code()
        while code in self.sessions:
            code = _generate_code()
        return code

    # --- Boot and lookup: getting a session into memory -----------------------------------

    def hydrate(self):
        # rebuild the in-memory cache from Supabase on boot, this is the only place
        # contextualFacts gets reassembled since it's not its own column, just clusters flattened
        try:
            sessions = SessionStore.get_unclosed_sessions()
            for s in sessions:
                submissions = SessionStore.get_submissions(s['code']) or []
                clusters = SessionStore.get_clusters(s['code']) or []
                # DB column names are snake_case, the in-memory shape is camelCase. participantCount
                # restarts at 0 because sockets don't survive a restart, they rejoin and recount.
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
                    # if clusters exist, assume they covered every submission so far, otherwise
                    # an incremental run after a restart would re-cluster everything as "new"
                    'submissionsAtLastCluster': len(submissions) if clusters else 0,
                    'encrypted': s.get('encrypted') or False,
                }
            print(f'[SessionManager] hydrated {len(sessions)} session(s) from Supabase')
        except Exception as err:
            print('[SessionManager] hydration failed:', err)

    def create_session(self, tags=None, title='', description='', encrypted=False):
        # step one of every session's life. called by POST /sessions.
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
            'encrypted': bool(encrypted),
        }
        self.sessions[code] = session
        try:
            # the session is already in memory by now, so if this write fails the room still
            # works until a restart... then it's just gone. the encrypted flag write inside used
            # to be best effort, it isn't anymore, so a failure lands here and gets printed.
            SessionStore.create_session(code, tags, title, description, encrypted)
        except Exception as err:
            print('[SessionManager] failed to persist session:', err)
        return session

    def get_session(self, code):
        # sync, memory-only lookup, callers already inside a request for a session
        # that should have been hydrated or created know it's there
        return self.sessions.get(code)

    def get_session_async(self, code):
        # falls back to Supabase when the process hasn't seen this code yet,
        # e.g. a second server instance behind the load balancer
        if code in self.sessions:
            return self.sessions[code]

        try:
            s = SessionStore.get_session(code)
            if not s:
                return None
            submissions = SessionStore.get_submissions(code) or []
            clusters = SessionStore.get_clusters(code) or []
            # same rebuild as hydrate(), just for one session. note it doesn't set
            # submissionsAtLastCluster, so that key is missing until a cluster run sets it.
            # callers read it with .get() for that reason.
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
                'encrypted': s.get('encrypted') or False,
            }
            self.sessions[code] = session
            return session
        except Exception:
            # not found, or Supabase is down. either way the caller just hears "no such session"
            return None

    # --- Phases and headcount --------------------------------------------------------------

    def transition_phase(self, code, new_phase):
        # the one place a phase changes. no rule checking here, the routes decide whether the
        # move is allowed before they call it. memory first, then the database.
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')
        session['phase'] = new_phase
        SessionStore.update_phase(code, new_phase)
        return session

    def increment_participants(self, code):
        # called from the HTTP join route. the socket join recounts from the actual room
        # anyway (see websocket_manager), so this number is a first guess that gets corrected.
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

    # --- Submissions: the pile of questions ------------------------------------------------

    def add_submission(self, code, content):
        # called by POST /submit. `content` is final by now: plain text, or the ciphertext json
        # blob for an encrypted room. this method doesn't know or care which.
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')
        # RESULTS and EXPANDING both still take submissions, host hasn't closed the room yet
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

        # ids are compared as strings because the client sends them as strings and the DB
        # might hand back numbers
        session['submissions'] = [s for s in session['submissions'] if str(s['id']) != str(submission_id)]
        SessionStore.delete_submission(submission_id)

    def delete_session(self, code):
        # reached from the host:delete_session socket event. the row stays in Supabase marked
        # DELETED (get_unclosed_sessions skips those), only the memory copy is actually dropped.
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        self.transition_phase(code, PHASES['DELETED'])
        del self.sessions[code]

    def answer_submission(self, code, submission_id, answer):
        # a participant's answer pinned to one submission
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        submission = next((s for s in session['submissions'] if str(s['id']) == str(submission_id)), None)
        if not submission:
            raise Exception('Submission not found')

        submission['participant_answer'] = answer
        SessionStore.update_submission_answer(submission_id, answer)
        return submission

    # --- Clusters: what the pile turned into -----------------------------------------------

    def save_clusters(self, code, clusters):
        # a full replace. the store deletes the old rows and inserts the new ones, and what
        # comes back (with real database ids) becomes the session's clusters.
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
        # the host's official answer for a cluster, replaces whatever was there
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
        # unlike the host's answer, these stack up. every participant answer is appended.
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
        # stores what the expand route got back from the AI: facts go on the session as a whole,
        # and each cluster gets its own previewed follow-up questions.
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
            # every cluster gets the full list of facts, not just its own. facts are stored per
            # cluster in the DB because there's no session column for them (see hydrate).
            SessionStore.update_cluster_contextual_facts(cluster['id'], contextual_facts)

        return session

    def toggle_selected_question(self, code, cluster_id, question):
        # in the list means remove it, not in the list means add it. no separate "unselect" call.
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

    # --- Curators, expansion and the ending -------------------------------------------------

    def promote_curator(self, code, socket_id):
        # same toggle idea as selecting a question. curators are stored by socket id, so a
        # curator who refreshes gets a new socket and loses the role, I guess.
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        already = socket_id in session['curators']
        session['curators'] = [c for c in session['curators'] if c != socket_id] if already else session['curators'] + [socket_id]

        SessionStore.update_curators(code, session['curators'])
        return session['curators']

    def trigger_expansion(self, code):
        # called by the expand route right before it saves the AI's preview. bumps the round
        # counter (memory and DB) and moves the phase to EXPANDING.
        session = self.get_session(code)
        if not session:
            raise Exception('Session not found')

        session['expansionRound'] = (session.get('expansionRound') or 0) + 1
        SessionStore.increment_expansion_round(code)
        self.transition_phase(code, PHASES['EXPANDING'])
        return session

    def end_session(self, code):
        # the last real phase. the session stays in memory and in the DB so the summary
        # can still be read, unlike delete_session which makes it disappear.
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

        # question text is the only handle we get from the client, breaks on first match
        # so duplicate question text across clusters would only ever hit the first one
        for cluster in session['clusters']:
            question = next((q for q in (cluster.get('questions') or []) if q['text'] == question_text), None)
            if question:
                # undo takes one off, floored at zero so a double undo can't go negative
                question['upvoteCount'] = max(0, (question.get('upvoteCount') or 0) + (-1 if undo else 1))
                new_count = question['upvoteCount']
                updated_cluster = cluster
                break

        if not updated_cluster:
            raise Exception('Question not found')

        # upvotes live inside the cluster's questions json, so the whole list gets rewritten
        SessionStore.update_cluster_questions(updated_cluster['id'], updated_cluster['questions'])

        return {'questionText': question_text, 'upvoteCount': new_count}

    def restore_session(self, code, phase, tags, submissions, clusters):
        # puts a session straight into memory from values the caller already has. skips the
        # database entirely and fills in defaults for everything else, so title, notes and
        # the encrypted flag come back empty.
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
