"""
Tests for src/backend/routes/submissions.py, via a Flask test client.
`current_app.session_manager` is a fake (see conftest.py) so these only check
that the route validates input and talks to session_manager/socketio
correctly - not persistence, which is covered elsewhere.
One test class per route function.
"""


def _session(phase='OPEN', encrypted=False, submissions=None):
    return {'phase': phase, 'encrypted': encrypted, 'submissions': submissions if submissions is not None else []}


class TestSubmit:
    def test_rejects_when_session_missing(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = None

        res = client.post('/api/sessions/ABC123/submit', json={'content': 'hi?'})

        assert res.status_code == 404

    def test_rejects_when_phase_not_submittable(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = _session(phase='ENDED')

        res = client.post('/api/sessions/ABC123/submit', json={'content': 'hi?'})

        assert res.status_code == 400
        assert 'closed' in res.get_json()['error'].lower()

    def test_rejects_blank_content(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = _session()

        res = client.post('/api/sessions/ABC123/submit', json={'content': '   '})

        assert res.status_code == 400

    def test_rejects_encrypted_submission_without_nonce(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = _session(encrypted=True)

        res = client.post('/api/sessions/ABC123/submit', json={'content': 'ciphertext=='})

        assert res.status_code == 400
        assert 'nonce' in res.get_json()['error'].lower()

    def test_plaintext_submission_over_500_chars_rejected(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = _session(encrypted=False)

        res = client.post('/api/sessions/ABC123/submit', json={'content': 'x' * 501})

        assert res.status_code == 400

    def test_encrypted_submission_over_2000_chars_rejected(self, client, fake_session_manager):
        # A ciphertext blob well past the plaintext 500-char cap must still be
        # rejectable once it crosses the encrypted-specific limit.
        fake_session_manager.get_session.return_value = _session(encrypted=True)

        res = client.post('/api/sessions/ABC123/submit', json={'content': 'x' * 2001, 'nonce': 'abc='})

        assert res.status_code == 400

    def test_encrypted_submission_under_2000_chars_but_over_500_is_accepted(self, client, fake_session_manager):
        session = _session(encrypted=True)
        fake_session_manager.get_session.return_value = session
        fake_session_manager.add_submission.return_value = {'id': 1, 'content': 'x' * 600}

        res = client.post('/api/sessions/ABC123/submit', json={'content': 'x' * 600, 'nonce': 'abc='})

        assert res.status_code == 200

    def test_plaintext_submission_stored_as_is(self, client, fake_session_manager):
        session = _session(encrypted=False)
        fake_session_manager.get_session.return_value = session
        fake_session_manager.add_submission.return_value = {'id': 1, 'content': 'What time is it?'}

        res = client.post('/api/sessions/ABC123/submit', json={'content': ' What time is it? '})

        assert res.status_code == 200
        fake_session_manager.add_submission.assert_called_once_with('ABC123', 'What time is it?')

    def test_encrypted_submission_stored_as_ciphertext_json_blob(self, client, fake_session_manager):
        session = _session(encrypted=True)
        fake_session_manager.get_session.return_value = session
        fake_session_manager.add_submission.return_value = {'id': 1, 'content': '...'}

        client.post('/api/sessions/ABC123/submit', json={'content': 'ciphertext==', 'nonce': 'nonce=='})

        stored = fake_session_manager.add_submission.call_args.args[1]
        assert '"ciphertext": "ciphertext=="' in stored
        assert '"nonce": "nonce=="' in stored


class TestDeleteSubmission:
    def test_rejects_when_session_missing(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = None

        res = client.delete('/api/sessions/ABC123/submit/1')

        assert res.status_code == 404

    def test_deletes_and_broadcasts_count(self, client, fake_session_manager, fake_socketio):
        fake_session_manager.get_session.return_value = _session(submissions=[])

        res = client.delete('/api/sessions/ABC123/submit/1')

        assert res.status_code == 200
        fake_session_manager.delete_submission.assert_called_once_with('ABC123', '1')
        fake_socketio.emit.assert_called_once_with('submission:count', {'count': 0}, to='ABC123')


class TestAnswerSubmission:
    def test_rejects_blank_answer(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = _session()

        res = client.post('/api/sessions/ABC123/submit/1/answer', json={'answer': ''})

        assert res.status_code == 400

    def test_rejects_answer_over_500_chars(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = _session()

        res = client.post('/api/sessions/ABC123/submit/1/answer', json={'answer': 'x' * 501})

        assert res.status_code == 400

    def test_saves_valid_answer(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = _session()
        fake_session_manager.answer_submission.return_value = {'id': '1', 'participant_answer': 'Because.'}

        res = client.post('/api/sessions/ABC123/submit/1/answer', json={'answer': 'Because.'})

        assert res.status_code == 200
        fake_session_manager.answer_submission.assert_called_once_with('ABC123', '1', 'Because.')
