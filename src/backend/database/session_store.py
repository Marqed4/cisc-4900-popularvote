from src.backend.database.supabase_client import supabase

def create_session(code, tags=None, title='', description='', encrypted=False):
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
        try:
            supabase.table('sessions').update({'encrypted': True}).eq('code', code).execute()
        except Exception as e:
            print(f'[createSession] encrypted flag write skipped (schema cache may be stale): {e}')

    return result.data


def get_session(code):
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
    supabase.table('sessions').delete().eq('code', code).execute()


def add_submission(session_code, content):
    result = supabase.table('submissions').insert({
        'session_code': session_code, 'content': content, 'participant_answer': None, 'is_curator': False
    }).execute()
    return result.data[0]


def delete_submission(submission_id):
    supabase.table('submissions').delete().eq('id', submission_id).execute()


def get_submissions(session_code):
    result = supabase.table('submissions').select('*').eq('session_code', session_code).execute()
    return result.data


def update_submission_answer(submission_id, participant_answer):
    supabase.table('submissions').update({'participant_answer': participant_answer}).eq('id', submission_id).execute()


def save_clusters(session_code, clusters):
    existing_result = supabase.table('clusters').select('*').eq('session_code', session_code).execute()
    existing = existing_result.data or []
    existing_by_query = {c['representative_query']: c for c in existing}

    supabase.table('clusters').delete().eq('session_code', session_code).execute()

    rows = []
    for c in clusters:
        prev = existing_by_query.get(c.get('representativeQuery'))
        rows.append({
            'session_code': session_code,
            'representative_query': c.get('representativeQuery'),
            'submission_count': c.get('submissionCount'),
            'questions': c.get('questions'),
            'answer': c.get('answer') or (prev.get('answer') if prev else None),
            'upvote_count': c.get('upvoteCount') or (prev.get('upvote_count') if prev else 0),
            'previewed_questions': c.get('previewedQuestions') or (prev.get('previewed_questions') if prev else []),
            'selected_questions': c.get('selectedQuestions') or (prev.get('selected_questions') if prev else []),
            'contextual_facts': c.get('contextualFacts') or (prev.get('contextual_facts') if prev else []),
            'participant_answers': c.get('participantAnswers') or (prev.get('participant_answers') if prev else []),
        })

    result = supabase.table('clusters').insert(rows).execute()
    return result.data


def save_new_clusters(session_code, clusters):
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
    supabase.table('clusters').update({'questions': questions}).eq('id', cluster_id).execute()


def update_cluster_query(cluster_id, representative_query, submission_count, questions):
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
    fetch_result = supabase.table('clusters').select('participant_answers').eq('id', cluster_id).single().execute()
    current = fetch_result.data.get('participant_answers') or []
    updated = current + [answer]
    supabase.table('clusters').update({'participant_answers': updated}).eq('id', cluster_id).execute()


def get_clusters(session_code):
    result = supabase.table('clusters').select('*').eq('session_code', session_code).order('created_at').execute()
    return result.data


def get_unclosed_sessions():
    result = supabase.table('sessions').select('*').neq('phase', 'DELETED').execute()
    return result.data


def update_curators(code, curators):
    supabase.table('sessions').update({'curators': curators}).eq('code', code).execute()


def increment_expansion_round(code):
    fetch_result = supabase.table('sessions').select('expansion_round').eq('code', code).single().execute()
    current = fetch_result.data.get('expansion_round') or 0
    supabase.table('sessions').update({'expansion_round': current + 1}).eq('code', code).execute()
