"""Tests for src/backend/privacy.py, the one definition of the three privacy modes."""
import pytest

from src.backend import privacy


class TestNormalize:
    def test_accepts_the_three_modes(self):
        for mode in ('standard', 'encrypted', 'passcode'):
            assert privacy.normalize(mode) == mode

    def test_none_and_empty_mean_standard(self):
        assert privacy.normalize(None) == 'standard'
        assert privacy.normalize('') == 'standard'

    def test_unknown_modes_are_refused(self):
        for bad in ('secret', 'Standard', 'hashed', 'e2e', 1, True):
            with pytest.raises(ValueError, match='privacyMode'):
                privacy.normalize(bad)


class TestIsEncrypted:
    def test_only_standard_is_readable_by_the_server(self):
        assert privacy.is_encrypted('standard') is False
        assert privacy.is_encrypted('encrypted') is True
        assert privacy.is_encrypted('passcode') is True


class TestFromRow:
    def test_prefers_the_new_column(self):
        assert privacy.from_row({'privacy_mode': 'encrypted', 'hashed_identity': True}) == 'encrypted'

    def test_falls_back_to_the_old_flags(self):
        assert privacy.from_row({'encrypted': True, 'hashed_identity': True}) == 'passcode'
        assert privacy.from_row({'encrypted': True}) == 'encrypted'
        assert privacy.from_row({}) == 'standard'

    def test_a_room_made_by_an_old_server_mid_cutover_is_never_read_as_standard(self):
        # the new column defaults to 'standard', the old flags carry the real answer
        assert privacy.from_row({'privacy_mode': 'standard', 'encrypted': True}) == 'encrypted'
        assert privacy.from_row({'privacy_mode': 'standard', 'encrypted': True, 'hashed_identity': True}) == 'passcode'

    def test_ignores_a_garbage_value_in_the_new_column(self):
        assert privacy.from_row({'privacy_mode': 'bogus', 'encrypted': True}) == 'encrypted'
