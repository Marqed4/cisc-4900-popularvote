# The database layer. Every function here is one Supabase call (or two) and nothing else, no
# business rules. session_manager.py decides what should happen, this file just writes it down.
# Three tables: sessions, submissions (the questions), clusters (the groups of questions).
# Columns are snake_case here, the in-memory sessions use camelCase, the manager translates.
from src.backend.database.supabase_client import supabase

# Supabase returns at most 1000 rows per request, so big lists are fetched in pages.
PAGE_SIZE = 1000


def _fetch_all(build_query):
    # build_query returns a fresh, ordered query each time. keeps asking for the next page
    # until one comes back short.
    rows = []
    start = 0
    while True:
        batch = build_query().range(start, start + PAGE_SIZE - 1).execute().data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            return rows
        start += PAGE_SIZE


# --- sessions table -------------------------------------------------------------------------

def create_session(code, tags=None, title='', description='', encrypted=False):
    # the row starts as OPEN with no curators. title, description and encrypted go in as
    # separate updates after, so an older schema missing those columns can still create rooms.
    tags = tags or []
    result = supabase.table('sessions').insert({
        'code': code, 'phase': 'OPEN', 'tags': tags, 'expansion_round': 0, 'curators': []
    }).execute()

    if title or description:
        try:
            supabase.table('sessions').update({'title': title, 'description': description}).eq('code', code).execute()
        except Exception as e:
            print(f'[createSession] context write skipped: {e}')

    if encrypted:
        # no try/except on purpose. if this write fails the database says "not encrypted"
        # while the host thinks it is, and that's the kind of quiet lie that hurts later.
        # let it raise so session_manager at least hears about it.
        supabase.table('sessions').update({'encrypted': True}).eq('code', code).execute()

    return result.data


def get_session(code):
    # .single() raises if there isn't exactly one row, which the manager treats as "not found"
    result = supabase.table('sessions').select('*').eq('code', code).single().execute()
    return result.data


def update_phase(code, phase):
    supabase.table('sessions').update({'phase': phase}).eq('code', code).execute()


def update_tags(code, tags):
    supabase.table('sessions').update({'tags': tags}).eq('code', code).execute()


def update_session_context(code, title, description):
    supabase.table('sessions').update({'title': title, 'description': description}).eq('code', code).execute()


def update_host_notes(code, host_notes):
    supabase.table('sessions').update({'host_notes': host_notes}).eq('code', code).execute()


def delete_session(code):
    # a hard delete. nothing in the current flow calls it, delete_session in the manager
    # only marks the row DELETED and leaves it here.
    supabase.table('sessions').delete().eq('code', code).execute()


# --- submissions table: the pile of questions -----------------------------------------------

def add_submission(session_code, content):
    # `content` is plain text or the ciphertext json string, stored the same either way.
    # the inserted row comes back with its generated id, which is what the client needs.
    result = supabase.table('submissions').insert({
        'session_code': session_code, 'content': content, 'participant_answer': None, 'is_curator': False
    }).execute()
    return result.data[0]


def delete_submission(submission_id, session_code=None):
    # pass session_code and the delete only matches a submission in that room, so a guessed
    # id from another room does nothing. optional so older callers keep working.
    query = supabase.table('submissions').delete().eq('id', submission_id)
    if session_code:
        query = query.eq('session_code', session_code)
    query.execute()


def get_submissions(session_code):
    # oldest first, so the host's live feed reads in the order questions came in
    return _fetch_all(lambda: (
        supabase.table('submissions').select('*')
        .eq('session_code', session_code).order('created_at')
    ))


def update_submission_answer(submission_id, participant_answer):
    supabase.table('submissions').update({'participant_answer': participant_answer}).eq('id', submission_id).execute()


# --- clusters table: the groups ---------------------------------------------------------------

def save_clusters(session_code, clusters):
    # a clustering run replaces every cluster for the session. the old rows are indexed by
    # representative query so a new cluster with the same query inherits the old one's answer,
    # upvotes, selections and so on. otherwise re-clustering would erase the host's work.
    # a cluster whose query changed has no match and starts blank.
    existing = supabase.table('clusters').select('*').eq('session_code', session_code).execute().data or []
    old_ids = [c['id'] for c in existing]

    # each old row can be inherited once, so two clusters with the same query don't share one
    by_query = {}
    for c in existing:
        by_query.setdefault(c['representative_query'], []).append(c)

    rows = []
    for c in clusters:
        matches = by_query.get(c.get('representativeQuery'))
        prev = matches.pop(0) if matches else None
        new_answer = c.get('answer')
        # for each field: use the new value if there is one, else fall back to the old row's
        rows.append({
            'session_code': session_code,
            'representative_query': c.get('representativeQuery'),
            'submission_count': c.get('submissionCount'),
            'questions': c.get('questions'),
            'answer': new_answer if new_answer is not None else (prev.get('answer') if prev else None),
            'upvote_count': c.get('upvoteCount') or (prev.get('upvote_count') if prev else 0),
            'previewed_questions': c.get('previewedQuestions') or (prev.get('previewed_questions') if prev else []),
            'selected_questions': c.get('selectedQuestions') or (prev.get('selected_questions') if prev else []),
            'contextual_facts': c.get('contextualFacts') or (prev.get('contextual_facts') if prev else []),
            'participant_answers': c.get('participantAnswers') or (prev.get('participant_answers') if prev else []),
        })

    # insert the new rows first and delete the old ones after, so a failed insert leaves the
    # old clusters (and the host's answers) in place instead of an empty session.
    result_data = []
    if rows:
        result_data = supabase.table('clusters').insert(rows).execute().data
    if old_ids:
        supabase.table('clusters').delete().in_('id', old_ids).execute()
    return result_data


def save_new_clusters(session_code, clusters):
    # the incremental path. only inserts, never deletes, so the answered clusters that
    # already exist stay exactly as they are. everything starts blank.
    if not clusters:
        return []

    rows = [{
        'session_code': session_code,
        'representative_query': c.get('representativeQuery'),
        'submission_count': c.get('submissionCount'),
        'questions': c.get('questions'),
        'answer': None,
        'upvote_count': 0,
        'previewed_questions': [],
        'selected_questions': [],
        'contextual_facts': [],
        'participant_answers': [],
    } for c in clusters]

    result = supabase.table('clusters').insert(rows).execute()
    return result.data


def delete_cluster(cluster_id):
    supabase.table('clusters').delete().eq('id', cluster_id).execute()


def update_cluster_answer(cluster_id, answer):
    supabase.table('clusters').update({'answer': answer}).eq('id', cluster_id).execute()


def update_cluster_questions(cluster_id, questions):
    # used for upvotes, which live inside the questions json rather than their own column.
    # this overwrites the whole list, so two upvotes at the same moment can lose one.
    supabase.table('clusters').update({'questions': questions}).eq('id', cluster_id).execute()


def update_cluster_query(cluster_id, representative_query, submission_count, questions):
    # a cluster grew. new questions landed in it, so the count and the list change together.
    supabase.table('clusters').update({
        'representative_query': representative_query,
        'submission_count': submission_count,
        'questions': questions,
    }).eq('id', cluster_id).execute()


def update_cluster_previewed_questions(cluster_id, previewed_questions):
    supabase.table('clusters').update({'previewed_questions': previewed_questions}).eq('id', cluster_id).execute()


def update_cluster_selected_questions(cluster_id, selected_questions):
    supabase.table('clusters').update({'selected_questions': selected_questions}).eq('id', cluster_id).execute()


def update_cluster_contextual_facts(cluster_id, contextual_facts):
    supabase.table('clusters').update({'contextual_facts': contextual_facts}).eq('id', cluster_id).execute()


def add_participant_answer_to_cluster(cluster_id, answer):
    # best path is the append_participant_answer function in the database (see migration.sql),
    # which adds the answer in one step so overlapping answers can't overwrite each other.
    # if that function isn't installed yet, fall back to read, append, write back.
    try:
        supabase.rpc('append_participant_answer', {'p_id': cluster_id, 'p_answer': answer}).execute()
        return
    except Exception as e:
        print(f'[addParticipantAnswer] rpc unavailable, using fallback: {e}')

    fetch_result = supabase.table('clusters').select('participant_answers').eq('id', cluster_id).single().execute()
    current = fetch_result.data.get('participant_answers') or []
    supabase.table('clusters').update({'participant_answers': current + [answer]}).eq('id', cluster_id).execute()


def get_clusters(session_code):
    # oldest first, so clusters come back in the order they were created
    return _fetch_all(lambda: (
        supabase.table('clusters').select('*')
        .eq('session_code', session_code).order('created_at')
    ))


# --- boot, curators and expansion rounds ------------------------------------------------------

def get_unclosed_sessions():
    # what hydrate() loads on boot. ENDED sessions still count as "unclosed" here, only
    # DELETED ones are skipped, so finished rooms keep their summary after a restart.
    return _fetch_all(lambda: (
        supabase.table('sessions').select('*').neq('phase', 'DELETED').order('code')
    ))


def update_curators(code, curators):
    supabase.table('sessions').update({'curators': curators}).eq('code', code).execute()


def increment_expansion_round(code):
    # same idea as the participant answers: use the database function when it exists
    # (see migration.sql), otherwise read the number and write it back plus one.
    try:
        supabase.rpc('increment_expansion_round', {'p_code': code}).execute()
        return
    except Exception as e:
        print(f'[incrementExpansionRound] rpc unavailable, using fallback: {e}')

    fetch_result = supabase.table('sessions').select('expansion_round').eq('code', code).single().execute()
    current = fetch_result.data.get('expansion_round') or 0
    supabase.table('sessions').update({'expansion_round': current + 1}).eq('code', code).execute()