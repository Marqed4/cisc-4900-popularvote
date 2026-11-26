"""
Tests for src/backend/managers/session_manager.py.

SessionManager is the in-memory source of truth that routes read from; these
tests exercise its business logic (phase gating, in-memory mutation) with
SessionStore (the persistence layer) replaced by simple fakes, since that
layer already has its own tests in test_session_store.py.
One test class per method under test.
"""
from unittest.mock import MagicMock

import pytest

from src.backend.managers import session_manager as session_manager_module
from src.backend.managers.session_manager import SessionManager


@pytest.fixture
def manager(monkeypatch):
    monkeypatch.setattr(session_manager_module, 'SessionStore', MagicMock())
    return SessionManager()


class TestCreateSession:
    def test_builds_open_session_with_requested_flags(self, manager):
        session = manager.create_session(tags=['science'], title='Lecture', description='Q&A', privacy_mode='encrypted')

        assert session['phase'] == 'OPEN'
        assert session['tags'] == ['science']
        assert session['privacyMode'] == 'encrypted'
        assert session['encrypted'] is True
        assert session['code'] in manager.sessions

    def test_keeps_session_in_memory_even_if_persistence_fails(self, manager):
        session_manager_module.SessionStore.create_session.side_effect = Exception('db down')

        session = manager.create_session()

        assert session['code'] in manager.sessions


class TestAddSubmission:
    def test_rejects_submission_when_window_closed(self, manager):
        code = manager.create_session()['code']
        manager.sessions[code]['phase'] = 'CLOSED'

        with pytest.raises(Exception, match='Submission window is closed'):
            manager.add_submission(code, 'question?')

    def test_accepts_submission_in_open_phase(self, manager):
        code = manager.create_session()['code']
        session_manager_module.SessionStore.add_submission.return_value = {'id': 1, 'content': 'question?'}

        saved = manager.add_submission(code, 'question?')

        assert saved == {'id': 1, 'content': 'question?'}
        assert manager.sessions[code]['submissions'] == [saved]

    def test_raises_for_unknown_session(self, manager):
        with pytest.raises(Exception, match='Session not found'):
            manager.add_submission('NOPE', 'question?')


class TestSaveClusters:
    def test_stores_result_on_session(self, manager):
        code = manager.create_session()['code']
        clusters = [{'id': 'c1', 'representativeQuery': 'Why X?'}]
        session_manager_module.SessionStore.save_clusters.return_value = clusters

        result = manager.save_clusters(code, clusters)

        assert result == clusters
        assert manager.sessions[code]['clusters'] == clusters


class TestUpvoteQuestion:
    def test_increments_matching_question_across_clusters(self, manager):
        code = manager.create_session()['code']
        manager.sessions[code]['clusters'] = [
            {'id': 'c1', 'questions': [{'text': 'Why X?', 'upvoteCount': 0}]},
        ]

        result = manager.upvote_question(code, 'Why X?')

        assert result == {'questionText': 'Why X?', 'upvoteCount': 1}
        assert manager.sessions[code]['clusters'][0]['questions'][0]['upvoteCount'] == 1

    def test_undo_does_not_go_below_zero(self, manager):
        code = manager.create_session()['code']
        manager.sessions[code]['clusters'] = [
            {'id': 'c1', 'questions': [{'text': 'Why X?', 'upvoteCount': 0}]},
        ]

        result = manager.upvote_question(code, 'Why X?', undo=True)

        assert result['upvoteCount'] == 0

    def test_raises_when_question_not_found(self, manager):
        code = manager.create_session()['code']
        manager.sessions[code]['clusters'] = []

        with pytest.raises(Exception, match='Question not found'):
            manager.upvote_question(code, 'Nothing like this')


class TestRecordViewer:
    def test_new_device_bumps_viewer_count(self, manager):
        code = manager.create_session()['code']
        session_manager_module.SessionStore.record_viewer.return_value = True

        assert manager.record_viewer(code, 'device-0001') is True
        assert manager.get_session(code)['viewerCount'] == 1

    def test_repeat_device_does_not_bump(self, manager):
        code = manager.create_session()['code']
        session_manager_module.SessionStore.record_viewer.return_value = False

        assert manager.record_viewer(code, 'device-0001') is False
        assert manager.get_session(code)['viewerCount'] == 0

    def test_unknown_session_is_ignored(self, manager):
        assert manager.record_viewer('NOPE00', 'device-0001') is False


class TestSetKeyCheck:
    def test_stores_the_check_once_for_a_passcode_room(self, manager):
        code = manager.create_session(privacy_mode='passcode')['code']

        manager.set_key_check(code, '{"ciphertext":"x","nonce":"y"}')

        assert manager.sessions[code]['keyCheck'] == '{"ciphertext":"x","nonce":"y"}'
        session_manager_module.SessionStore.set_key_check.assert_called_once_with(code, '{"ciphertext":"x","nonce":"y"}')

    def test_second_write_is_refused(self, manager):
        code = manager.create_session(privacy_mode='passcode')['code']
        manager.set_key_check(code, 'first')

        with pytest.raises(PermissionError, match='already set'):
            manager.set_key_check(code, 'second')

        assert manager.sessions[code]['keyCheck'] == 'first'

    def test_rooms_without_a_passcode_refuse_it(self, manager):
        code = manager.create_session(privacy_mode='encrypted')['code']

        with pytest.raises(ValueError, match='does not use a passcode'):
            manager.set_key_check(code, 'x')


class TestPrivacyMode:
    def test_defaults_to_standard_with_no_key_check(self, manager):
        session = manager.create_session()

        assert session['privacyMode'] == 'standard'
        assert session['encrypted'] is False
        assert session['keyCheck'] is None

    def test_is_stored_on_the_session_and_forwarded_to_the_store(self, manager):
        session = manager.create_session(privacy_mode='passcode')

        assert session['privacyMode'] == 'passcode'
        assert session['encrypted'] is True
        session_manager_module.SessionStore.create_session.assert_called_once_with(
            session['code'], [], '', '', 'passcode',
        )

    def test_rejects_an_unknown_mode(self, manager):
        with pytest.raises(ValueError, match='privacyMode'):
            manager.create_session(privacy_mode='secret')

    def test_unknown_session_cannot_take_a_key_check(self, manager):
        session_manager_module.SessionStore.get_session.side_effect = Exception('not found')

        with pytest.raises(ValueError, match='Session not found'):
            manager.set_key_check('NOPE00', 'x')


class TestGetSessionAsyncPrivacyMode:
    def _row(self, **extra):
        return {'code': 'ABC123', 'phase': 'OPEN', **extra}

    def _load(self, manager, row):
        store = session_manager_module.SessionStore
        store.get_session.return_value = row
        store.get_submissions.return_value = []
        store.get_clusters.return_value = []
        return manager.get_session_async('ABC123')

    def test_rebuilds_the_mode_and_key_check_from_the_row(self, manager):
        session = self._load(manager, self._row(privacy_mode='passcode', key_check='blob'))

        assert session['privacyMode'] == 'passcode'
        assert session['encrypted'] is True
        assert session['keyCheck'] == 'blob'

    def test_rows_from_before_the_migration_are_read_from_the_old_flags(self, manager):
        assert self._load(manager, self._row(encrypted=True, hashed_identity=True))['privacyMode'] == 'passcode'
        manager.sessions.clear()  # get_session_async caches by code, so load the next row fresh
        assert self._load(manager, self._row(encrypted=True, hashed_identity=False))['privacyMode'] == 'encrypted'

    def test_null_or_missing_columns_read_as_standard(self, manager):
        for row in (self._row(), self._row(privacy_mode=None, encrypted=None, hashed_identity=None)):
            manager.sessions.clear()
            session = self._load(manager, row)
            assert session['privacyMode'] == 'standard'
            assert session['encrypted'] is False
            assert session['keyCheck'] is None
