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
        session = manager.create_session(tags=['science'], title='Lecture', description='Q&A', encrypted=True)

        assert session['phase'] == 'OPEN'
        assert session['tags'] == ['science']
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
