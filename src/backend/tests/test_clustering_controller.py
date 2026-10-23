"""
Tests for the pure helper in src/backend/managers/clustering_controller.py.
The Gemini-calling functions (cluster, incremental_cluster, ...) aren't
tested here - they only run for non-encrypted sessions and would need a real
or mocked LLM response; _clean_json is the deterministic piece worth locking down.
"""
from src.backend.managers.clustering_controller import _clean_json


class TestCleanJson:
    def test_strips_json_code_fence(self):
        raw = '```json\n[{"a": 1}]\n```'
        assert _clean_json(raw) == '[{"a": 1}]'

    def test_strips_plain_code_fence(self):
        raw = '```\n[{"a": 1}]\n```'
        assert _clean_json(raw) == '[{"a": 1}]'

    def test_leaves_unfenced_json_untouched(self):
        raw = '[{"a": 1}]'
        assert _clean_json(raw) == '[{"a": 1}]'

    def test_trims_surrounding_whitespace(self):
        raw = '  \n[{"a": 1}]\n  '
        assert _clean_json(raw) == '[{"a": 1}]'
