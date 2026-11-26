"""Tests for PATCH /api/sessions/<code>/notes: the size limits on host notes and PDF uploads."""
import io
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from src.backend.routes import sessions as sessions_route

LIMIT = sessions_route.clustering_engine.MAX_NOTES_CHARS
URL = '/api/sessions/ABC123/notes'


@pytest.fixture
def room(fake_session_manager, monkeypatch):
    session = {'hostNotes': None}
    fake_session_manager.get_session.return_value = session
    store = MagicMock()
    monkeypatch.setattr(sessions_route, 'SessionStore', store)
    return session, store


def fake_pdf(monkeypatch, pages, text='page text'):
    monkeypatch.setattr(
        sessions_route, 'PdfReader',
        lambda stream: SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda: text)] * pages),
    )


def upload(client, size=10):
    return client.patch(URL, data={'pdf': (io.BytesIO(b'x' * size), 'notes.pdf')},
                        content_type='multipart/form-data')


class TestSavingNotes:
    def test_saves_notes_under_the_limit(self, client, room):
        session, store = room

        res = client.patch(URL, json={'hostNotes': 'Lot C is free after 5pm.'})

        assert res.status_code == 200
        assert session['hostNotes'] == 'Lot C is free after 5pm.'
        store.update_host_notes.assert_called_once_with('ABC123', 'Lot C is free after 5pm.')

    def test_accepts_exactly_the_limit(self, client, room):
        session, _ = room

        res = client.patch(URL, json={'hostNotes': 'a' * LIMIT})

        assert res.status_code == 200
        assert len(session['hostNotes']) == LIMIT

    def test_rejects_one_character_over_and_stores_nothing(self, client, room):
        session, store = room

        res = client.patch(URL, json={'hostNotes': 'a' * (LIMIT + 1)})

        assert res.status_code == 400
        assert res.get_json()['limit'] == LIMIT
        assert session['hostNotes'] is None
        store.update_host_notes.assert_not_called()

    def test_the_error_says_how_long_the_notes_were_and_the_limit(self, client, room):
        error = client.patch(URL, json={'hostNotes': 'a' * (LIMIT + 5)}).get_json()['error']

        assert f'{LIMIT + 5:,}' in error and f'{LIMIT:,}' in error

    def test_rejects_a_body_far_over_the_limit_before_parsing_it(self, client, room):
        _, store = room

        res = client.patch(URL, json={'hostNotes': 'a' * (LIMIT * 5)})

        assert res.status_code == 413
        store.update_host_notes.assert_not_called()

    @pytest.mark.parametrize('bad', [123, ['a'], {'a': 1}, True])
    def test_rejects_notes_that_are_not_text(self, client, room, bad):
        res = client.patch(URL, json={'hostNotes': bad})

        assert res.status_code == 400

    @pytest.mark.parametrize('empty', [None, ''])
    def test_clearing_the_notes_is_allowed(self, client, room, empty):
        session, _ = room
        session['hostNotes'] = 'old notes'

        res = client.patch(URL, json={'hostNotes': empty})

        assert res.status_code == 200
        assert session['hostNotes'] == empty

    def test_unknown_session_is_404(self, client, fake_session_manager):
        fake_session_manager.get_session.return_value = None

        assert client.patch(URL, json={'hostNotes': 'x'}).status_code == 404


class TestPdfUpload:
    def test_returns_the_extracted_text(self, client, room, monkeypatch):
        fake_pdf(monkeypatch, pages=2, text='hello')

        res = upload(client)

        assert res.status_code == 200
        assert res.get_json()['extracted'] == 'hello\nhello'

    def test_accepts_exactly_the_page_limit(self, client, room, monkeypatch):
        fake_pdf(monkeypatch, pages=sessions_route.MAX_PDF_PAGES)

        assert upload(client).status_code == 200

    def test_rejects_too_many_pages_and_says_how_many(self, client, room, monkeypatch):
        fake_pdf(monkeypatch, pages=sessions_route.MAX_PDF_PAGES + 1)

        res = upload(client)

        assert res.status_code == 400
        assert str(sessions_route.MAX_PDF_PAGES + 1) in res.get_json()['error']

    def test_rejects_a_file_over_the_size_limit(self, client, room, monkeypatch):
        monkeypatch.setattr(sessions_route, 'MAX_PDF_SIZE', 100)
        fake_pdf(monkeypatch, pages=1)

        res = upload(client, size=200)

        assert res.status_code == 400
        assert 'limit' in res.get_json()['error']

    def test_rejects_a_hugely_oversized_upload_before_reading_it(self, client, room, monkeypatch):
        monkeypatch.setattr(sessions_route, 'MAX_PDF_SIZE', 100)
        reads = MagicMock()
        monkeypatch.setattr(sessions_route, 'PdfReader', reads)

        res = upload(client, size=100 + 64 * 1024 + 500)

        assert res.status_code == 413
        reads.assert_not_called()

    def test_a_file_that_is_not_a_pdf_is_a_400_not_a_crash(self, client, room, monkeypatch):
        def broken(stream):
            raise ValueError('not a pdf')
        monkeypatch.setattr(sessions_route, 'PdfReader', broken)

        res = upload(client)

        assert res.status_code == 400

    def test_a_pdf_with_no_text_is_a_400(self, client, room, monkeypatch):
        fake_pdf(monkeypatch, pages=3, text='')

        assert upload(client).status_code == 400
