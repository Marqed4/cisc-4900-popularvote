"""
Tests for the clustering endpoints in src/backend/routes/sessions.py, via a
Flask test client. Covers the E2E-4 fix: encrypted sessions now cluster
client-side and POST the already-computed clusters, instead of the route
rejecting every encrypted clustering attempt.
One test class per route function.
"""
from unittest.mock import MagicMock

import pytest

from src.backend.routes import sessions as sessions_route


def _session(phase='CLOSED', encrypted=False, submissions=None, clusters=None):
    return {
        'phase': phase,
        'encrypted': encrypted,
        'submissions': submissions if submissions is not None else [{'id': 1, 'content': 'hi?'}],
        'clusters': clusters if clusters is not None else [],
        'tags': [],
        'title': '',
        'description': '',
        'hostNotes': None,
    }


@pytest.fixture(autouse=True)
def fake_session_store(monkeypatch):
    fake = MagicMock()
    monkeypatch.setattr(sessions_route, 'SessionStore', fake)
    return fake


@pytest.fixture(autouse=True)
def fake_clustering_engine(monkeypatch):
    fake = MagicMock()
    monkeypatch.setattr(sessions_route, 'clustering_engine', fake)
    return fake


class TestClusterSession:
    def test_rejects_when_session_missing(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = None

        res = client.post('/api/sessions/ABC123/cluster')

        assert res.status_code == 404

    def test_rejects_when_no_submissions(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = _session(submissions=[])

        res = client.post('/api/sessions/ABC123/cluster')

        assert res.status_code == 400

    def test_encrypted_session_without_client_clusters_is_rejected(self, client, fake_session_manager):
        """This is the bug the client-side-clustering fix (E2E-4) replaces: before,
        encrypted sessions could never pass this check because nothing ever sent
        client-computed clusters. Now the route still requires them explicitly
        (Gemini can't see encrypted content), but the frontend can satisfy it."""
        fake_session_manager.get_session.return_value = _session(encrypted=True)

        res = client.post('/api/sessions/ABC123/cluster', json={})

        assert res.status_code == 400
        assert 'client-computed clusters' in res.get_json()['error']

    def test_encrypted_session_with_client_clusters_is_accepted(self, client, fake_session_manager):
        session = _session(encrypted=True)
        fake_session_manager.get_session.return_value = session
        saved = [{'id': 'c1', 'representative_query': '{"ciphertext":"x","nonce":"y"}'}]
        fake_session_manager.save_clusters.return_value = saved

        payload = {'clusters': [{'representativeQuery': '{"ciphertext":"x","nonce":"y"}', 'submissionCount': 1, 'questions': []}]}
        res = client.post('/api/sessions/ABC123/cluster', json=payload)

        assert res.status_code == 200
        assert res.get_json() == {'clusters': saved}
        fake_session_manager.save_clusters.assert_called_once_with('ABC123', payload['clusters'])
        fake_session_manager.transition_phase.assert_any_call('ABC123', 'RESULTS')

    def test_encrypted_session_rejects_non_list_clusters_payload(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = _session(encrypted=True)

        res = client.post('/api/sessions/ABC123/cluster', json={'clusters': 'not-a-list'})

        assert res.status_code == 400

    def test_unencrypted_session_runs_gemini_clustering(self, client, fake_session_manager, fake_clustering_engine):
        session = _session(encrypted=False)
        fake_session_manager.get_session.return_value = session
        fake_clustering_engine.cluster.return_value = [{'representativeQuery': 'Why X?'}]
        fake_session_manager.save_clusters.return_value = [{'id': 'c1', 'representative_query': 'Why X?'}]

        res = client.post('/api/sessions/ABC123/cluster')

        assert res.status_code == 200
        fake_clustering_engine.cluster.assert_called_once()


class TestSubmitToCluster:
    def test_rejects_blank_content(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = _session()

        res = client.post('/api/sessions/ABC123/clusters/c1/submit', json={'content': ''})

        assert res.status_code == 400

    def test_rejects_encrypted_submission_without_nonce(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = _session(encrypted=True)

        res = client.post('/api/sessions/ABC123/clusters/c1/submit', json={'content': 'ciphertext=='})

        assert res.status_code == 400
        assert 'nonce' in res.get_json()['error'].lower()

    def test_encrypted_submission_over_plaintext_limit_but_under_encrypted_limit_is_accepted(
        self, client, fake_session_manager, fake_session_store,
    ):
        """Regression test for the plaintext-leak fix: before, this route had no
        nonce handling at all and capped everything at 500 chars, so a legitimate
        ciphertext blob (base64 + JSON overhead routinely exceeds plaintext length)
        could be wrongly rejected, or - worse - stored and broadcast as plaintext."""
        session = _session(encrypted=True, clusters=[{'id': 'c1', 'representative_query': 'Why X?', 'questions': [], 'submission_count': 0}])
        fake_session_manager.get_session.return_value = session
        fake_session_store.add_submission.return_value = {'id': 2, 'content': '...'}

        content = 'x' * 600
        res = client.post('/api/sessions/ABC123/clusters/c1/submit', json={'content': content, 'nonce': 'abc='})

        assert res.status_code == 200
        stored = fake_session_store.add_submission.call_args.args[1]
        assert '"nonce": "abc="' in stored
        assert content in stored

    def test_encrypted_submission_over_encrypted_limit_rejected(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = _session(encrypted=True)

        res = client.post('/api/sessions/ABC123/clusters/c1/submit', json={'content': 'x' * 2001, 'nonce': 'abc='})

        assert res.status_code == 400

    def test_plaintext_submission_never_wrapped_in_ciphertext_json(
        self, client, fake_session_manager, fake_session_store,
    ):
        session = _session(encrypted=False, clusters=[])
        fake_session_manager.get_session.return_value = session
        fake_session_store.add_submission.return_value = {'id': 3, 'content': 'Plain question?'}

        client.post('/api/sessions/ABC123/clusters/c1/submit', json={'content': 'Plain question?'})

        stored = fake_session_store.add_submission.call_args.args[1]
        assert stored == 'Plain question?'

    def test_broadcast_question_matches_stored_content_not_raw_input(
        self, client, fake_session_manager, fake_socketio, fake_session_store,
    ):
        """The socket broadcast must carry whatever was actually stored (ciphertext
        for encrypted sessions), never the raw request body, or plaintext leaks to
        every participant in the room via `cluster:submission:added`."""
        session = _session(encrypted=True, clusters=[{'id': 'c1', 'representative_query': 'Why X?', 'questions': [], 'submission_count': 0}])
        fake_session_manager.get_session.return_value = session
        fake_session_store.add_submission.return_value = {'id': 4, 'content': '...'}

        client.post('/api/sessions/ABC123/clusters/c1/submit', json={'content': 'secret-plaintext', 'nonce': 'n='})

        broadcast_call = next(c for c in fake_socketio.emit.call_args_list if c.args[0] == 'cluster:submission:added')
        broadcast_text = broadcast_call.args[1]['question']['text']
        assert broadcast_text != 'secret-plaintext'
        assert '"ciphertext": "secret-plaintext"' in broadcast_text


class TestSetKeyCheckRoute:
    def test_saves_and_returns_the_key_check(self, client, fake_session_manager):
        res = client.post('/api/sessions/ABC123/key-check', json={'keyCheck': 'blob'})

        assert res.status_code == 200
        fake_session_manager.set_key_check.assert_called_once_with('ABC123', 'blob')

    def test_rejects_a_missing_key_check(self, client, fake_session_manager):
        res = client.post('/api/sessions/ABC123/key-check', json={})

        assert res.status_code == 400
        fake_session_manager.set_key_check.assert_not_called()

    def test_second_write_is_a_conflict(self, client, fake_session_manager):
        fake_session_manager.set_key_check.side_effect = PermissionError('Key check is already set')

        res = client.post('/api/sessions/ABC123/key-check', json={'keyCheck': 'blob'})

        assert res.status_code == 409

    def test_unknown_session_is_404(self, client, fake_session_manager):
        fake_session_manager.set_key_check.side_effect = ValueError('Session not found')

        res = client.post('/api/sessions/NOPE00/key-check', json={'keyCheck': 'blob'})

        assert res.status_code == 404

    def test_rejects_a_non_string_key_check(self, client, fake_session_manager):
        res = client.post('/api/sessions/ABC123/key-check', json={'keyCheck': {'ciphertext': 'x'}})

        assert res.status_code == 400
        fake_session_manager.set_key_check.assert_not_called()

    def test_rejects_an_oversized_key_check(self, client, fake_session_manager):
        res = client.post('/api/sessions/ABC123/key-check', json={'keyCheck': 'x' * 501})

        assert res.status_code == 400
        fake_session_manager.set_key_check.assert_not_called()

    def test_room_without_a_passcode_is_a_400(self, client, fake_session_manager):
        fake_session_manager.set_key_check.side_effect = ValueError('Session does not use a passcode')

        res = client.post('/api/sessions/ABC123/key-check', json={'keyCheck': 'blob'})

        assert res.status_code == 400

    def test_unexpected_failure_is_a_500(self, client, fake_session_manager):
        fake_session_manager.set_key_check.side_effect = RuntimeError('boom')

        res = client.post('/api/sessions/ABC123/key-check', json={'keyCheck': 'blob'})

        assert res.status_code == 500


class TestCreateSessionRoute:
    def _created(self, **flags):
        return {
            'code': 'ABC123', 'phase': 'OPEN', 'tags': [], 'title': '', 'description': '',
            'encrypted': False, 'hashedIdentity': False, **flags,
        }

    def test_forwards_both_tier_flags_to_the_manager(self, client, fake_session_manager):
        fake_session_manager.create_session.return_value = self._created(encrypted=True, hashedIdentity=True)

        res = client.post('/api/sessions', json={'title': 'T', 'encrypted': True, 'hashedIdentity': True})

        fake_session_manager.create_session.assert_called_once_with([], 'T', '', True, True)
        assert res.get_json()['encrypted'] is True
        assert res.get_json()['hashedIdentity'] is True

    def test_flags_default_to_the_normal_tier(self, client, fake_session_manager):
        fake_session_manager.create_session.return_value = self._created()

        client.post('/api/sessions', json={})

        fake_session_manager.create_session.assert_called_once_with([], '', '', False, False)

    def test_encrypted_without_hashed_identity_is_the_middle_tier(self, client, fake_session_manager):
        fake_session_manager.create_session.return_value = self._created(encrypted=True)

        res = client.post('/api/sessions', json={'encrypted': True})

        fake_session_manager.create_session.assert_called_once_with([], '', '', True, False)
        assert res.get_json()['hashedIdentity'] is False


class TestGetSessionRoute:
    def _full(self, **extra):
        return {'code': 'ABC123', 'phase': 'OPEN', 'tags': [], **extra}

    def test_returns_the_tier_flags_and_key_check(self, client, fake_session_manager):
        fake_session_manager.get_session_async.return_value = self._full(
            encrypted=True, hashedIdentity=True, keyCheck='blob',
        )

        body = client.get('/api/sessions/ABC123').get_json()

        assert body['encrypted'] is True
        assert body['hashedIdentity'] is True
        assert body['keyCheck'] == 'blob'

    def test_sessions_missing_the_flags_read_as_the_normal_tier(self, client, fake_session_manager):
        fake_session_manager.get_session_async.return_value = self._full()

        body = client.get('/api/sessions/ABC123').get_json()

        assert body['encrypted'] is False
        assert body['hashedIdentity'] is False
        assert body['keyCheck'] is None

    def test_unknown_session_is_404(self, client, fake_session_manager):
        fake_session_manager.get_session_async.return_value = None

        assert client.get('/api/sessions/NOPE00').status_code == 404
