"""
Quick read/write check for the Supabase database.

Run from the repo root after pointing the .env files at the project you want to test:

    python -m src.backend.database.check_db <project-ref>

<project-ref> is the subdomain of the Supabase URL (for v4900 that's pqrbpzfakmvdfjtniyzd).
It has to match SUPABASE_URL or the script bails, so it can't write to the wrong project
by accident.

What it checks
  1. service_role (what the Flask backend uses) can insert, read back, update and delete
     rows in sessions, submissions and clusters, curators round-trips as a real list, and
     deleting a session cascades to its submissions and clusters.
  2. anon (what the browser uses) can read the public sessions columns but can't read
     host_notes, can't touch submissions or clusters, and can't write sessions.

It creates one throwaway session (code ZZTEST) and deletes it at the ending.
"""
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

BACKEND_ENV = Path(__file__).resolve().parents[1] / '.env'
FRONTEND_ENV = Path(__file__).resolve().parents[2] / 'frontend' / '.env'
CODE = 'ZZTEST'

passed = 0
failed = 0


def check(name, ok, detail=''):
    global passed, failed
    if ok:
        passed += 1
        print(f'  PASS  {name}')
    else:
        failed += 1
        print(f'  FAIL  {name} {detail}')


def blocked(fn):
    """True if the call was rejected by Postgres or returned nothing."""
    try:
        result = fn()
        return not result.data
    except Exception:
        return True


def main():
    if len(sys.argv) != 2:
        sys.exit('usage: python -m src.backend.database.check_db <project-ref>')
    ref = sys.argv[1]

    load_dotenv(BACKEND_ENV, override=True)
    url = os.environ.get('SUPABASE_URL', '')
    service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
    if ref not in url:
        sys.exit(f'SUPABASE_URL does not contain "{ref}". Update src/backend/.env first.')
    if not service_key:
        sys.exit('SUPABASE_SERVICE_ROLE_KEY is empty.')

    load_dotenv(FRONTEND_ENV, override=True)
    anon_url = os.environ.get('VITE_SUPABASE_URL', '')
    anon_key = os.environ.get('VITE_SUPABASE_ANON_KEY', '')

    admin = create_client(url, service_key)

    print(f'Testing {url}')
    print('\nservice_role')
    try:
        admin.table('sessions').delete().eq('code', CODE).execute()  # leftovers from a failed run
        admin.table('sessions').insert({
            'code': CODE, 'phase': 'OPEN', 'tags': ['test'], 'title': 'db check',
            'host_notes': 'private note', 'curators': [], 'encrypted': True,
        }).execute()
        row = admin.table('sessions').select('*').eq('code', CODE).single().execute().data
        check('insert and read session', row['code'] == CODE and row['encrypted'] is True)
        check('tags round-trip as a list', row['tags'] == ['test'], row['tags'])

        admin.table('sessions').update({'curators': ['abc', 'def']}).eq('code', CODE).execute()
        row = admin.table('sessions').select('curators').eq('code', CODE).single().execute().data
        check('curators round-trips as a list (jsonb)', row['curators'] == ['abc', 'def'], row['curators'])

        blob = json.dumps({'ciphertext': 'Zm9v', 'nonce': 'YmFy'})
        sub = admin.table('submissions').insert({
            'session_code': CODE, 'content': blob, 'is_curator': False,
        }).execute().data[0]
        got = admin.table('submissions').select('*').eq('session_code', CODE).execute().data
        check('insert and read submission', len(got) == 1 and got[0]['content'] == blob)

        admin.table('clusters').insert({
            'session_code': CODE, 'representative_query': 'q', 'submission_count': 1,
            'questions': [{'text': 'hi', 'upvoteCount': 0}],
        }).execute()
        cl = admin.table('clusters').select('*').eq('session_code', CODE).execute().data
        check('insert and read cluster with jsonb', len(cl) == 1 and cl[0]['questions'][0]['text'] == 'hi')

        if anon_key and anon_url == url:
            print('\nanon (browser)')
            anon = create_client(anon_url, anon_key)
            pub = anon.table('sessions').select('code,phase,tags,title,created_at').eq('code', CODE).execute().data
            check('can read public session columns', len(pub) == 1)
            check('cannot read host_notes', blocked(lambda: anon.table('sessions').select('host_notes').eq('code', CODE).execute()))
            check('cannot read submissions', blocked(lambda: anon.table('submissions').select('*').eq('session_code', CODE).execute()))
            check('cannot read clusters', blocked(lambda: anon.table('clusters').select('*').eq('session_code', CODE).execute()))
            check('cannot insert a session', blocked(lambda: anon.table('sessions').insert({'code': 'ZZANON'}).execute()))
            check('cannot delete a session', blocked(lambda: anon.table('sessions').delete().eq('code', CODE).execute()))
            check('cannot read user_sessions', blocked(lambda: anon.table('user_sessions').select('*').execute()))
        else:
            print('\nanon checks skipped (VITE_SUPABASE_URL/ANON_KEY missing or pointing at a different project)')

        admin.table('sessions').delete().eq('code', CODE).execute()
        left_s = admin.table('submissions').select('id').eq('session_code', CODE).execute().data
        left_c = admin.table('clusters').select('id').eq('session_code', CODE).execute().data
        check('deleting a session cascades to submissions and clusters', not left_s and not left_c)
    finally:
        try:
            admin.table('sessions').delete().eq('code', CODE).execute()
            admin.table('sessions').delete().eq('code', 'ZZANON').execute()
        except Exception:
            pass

    print(f'\n{passed} passed, {failed} failed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()