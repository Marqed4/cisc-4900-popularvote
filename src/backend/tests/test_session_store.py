"""
Tests for src/backend/database/session_store.py.

Each function mocks the module-level `supabase` client and asserts the
table/insert/update calls it makes, without touching a real database.
One test class per function under test.
"""
from unittest.mock import MagicMock

import pytest

from src.backend.database import session_store


def _chain(return_data):
    """Builds a MagicMock that behaves like `supabase.table(...).x(...).execute()`."""
    chain = MagicMock()
    chain.execute.return_value = MagicMock(data=return_data)
    return chain


class TestCreateSession:
    def test_persists_code_phase_and_tags(self, monkeypatch):
        table_mock = MagicMock()
        table_mock.insert.return_value = _chain([{'code': 'ABC123'}])
        monkeypatch.setattr(session_store, 'supabase', MagicMock(table=MagicMock(return_value=table_mock)))

        result = session_store.create_session('ABC123', tags=['math'], title='', description='')

        table_mock.insert.assert_called_once_with({
            'code': 'ABC123', 'phase': 'OPEN', 'tags': ['math'], 'expansion_round': 0, 'curators': [],
        })
        assert result == [{'code': 'ABC123'}]

    def test_writes_title_and_description_when_given(self, monkeypatch):
        table_mock = MagicMock()
        table_mock.insert.return_value = _chain([{}])
        table_mock.update.return_value.eq.return_value = _chain(None)
        monkeypatch.setattr(session_store, 'supabase', MagicMock(table=MagicMock(return_value=table_mock)))

        session_store.create_session('ABC123', title='Town Hall', description='Q&A')

        table_mock.update.assert_any_call({'title': 'Town Hall', 'description': 'Q&A'})

    def test_encrypted_flag_write_failure_is_not_swallowed(self, monkeypatch):
        """
        Regression test: create_session() used to catch and print any error from
        writing the `encrypted` column, so a session could end up stored as
        unencrypted while every client believed it was E2E-encrypted, with nothing
        surfacing the failure. The write must now propagate like any other.
        """
        table_mock = MagicMock()
        table_mock.insert.return_value = _chain([{}])

        def update(fields):
            if fields == {'encrypted': True}:
                raise Exception('column "encrypted" does not exist')
            return MagicMock(eq=MagicMock(return_value=_chain(None)))

        table_mock.update.side_effect = update
        monkeypatch.setattr(session_store, 'supabase', MagicMock(table=MagicMock(return_value=table_mock)))

        with pytest.raises(Exception, match='encrypted'):
            session_store.create_session('ABC123', encrypted=True)

    def test_does_not_write_encrypted_column_when_not_encrypted(self, monkeypatch):
        table_mock = MagicMock()
        table_mock.insert.return_value = _chain([{}])
        monkeypatch.setattr(session_store, 'supabase', MagicMock(table=MagicMock(return_value=table_mock)))

        session_store.create_session('ABC123', encrypted=False)

        table_mock.update.assert_not_called()


class TestAddSubmission:
    def test_inserts_content_under_session_code(self, monkeypatch):
        table_mock = MagicMock()
        table_mock.insert.return_value = _chain([{'id': 1, 'content': 'hello'}])
        monkeypatch.setattr(session_store, 'supabase', MagicMock(table=MagicMock(return_value=table_mock)))

        result = session_store.add_submission('ABC123', 'hello')

        table_mock.insert.assert_called_once_with({
            'session_code': 'ABC123', 'content': 'hello', 'participant_answer': None, 'is_curator': False,
        })
        assert result == {'id': 1, 'content': 'hello'}

    def test_stores_ciphertext_blob_as_opaque_content(self, monkeypatch):
        """Encrypted sessions pass a JSON ciphertext+nonce string; this layer must
        never interpret it, just store it like any other content string."""
        table_mock = MagicMock()
        table_mock.insert.return_value = _chain([{'id': 2}])
        monkeypatch.setattr(session_store, 'supabase', MagicMock(table=MagicMock(return_value=table_mock)))

        blob = '{"ciphertext": "abc=", "nonce": "def="}'
        session_store.add_submission('ABC123', blob)

        assert table_mock.insert.call_args.args[0]['content'] == blob


class TestSaveClusters:
    def test_replaces_existing_rows_and_preserves_prior_answer(self, monkeypatch):
        existing = [{'representative_query': 'Why X?', 'answer': 'Because Y', 'upvote_count': 3}]
        select_chain = MagicMock()
        select_chain.eq.return_value = _chain(existing)
        delete_chain = MagicMock()
        delete_chain.eq.return_value = _chain(None)
        insert_chain = _chain([{'id': 'new-id', 'representative_query': 'Why X?'}])

        table_mock = MagicMock()
        table_mock.select.return_value = select_chain
        table_mock.delete.return_value = delete_chain
        table_mock.insert.return_value = insert_chain
        monkeypatch.setattr(session_store, 'supabase', MagicMock(table=MagicMock(return_value=table_mock)))

        clusters = [{'representativeQuery': 'Why X?', 'submissionCount': 1, 'questions': []}]
        result = session_store.save_clusters('ABC123', clusters)

        inserted_rows = table_mock.insert.call_args.args[0]
        assert inserted_rows[0]['answer'] == 'Because Y'
        assert inserted_rows[0]['upvote_count'] == 3
        assert result == [{'id': 'new-id', 'representative_query': 'Why X?'}]
