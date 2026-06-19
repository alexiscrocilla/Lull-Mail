"""Local tool-call parser — recognises the formats GGUF chat models actually
emit when llama_cpp.server passes ``tools=`` to a quantised model that wasn't
trained to honour the OpenAI ``tool_calls[]`` response shape.

Each test pins one observed-in-the-wild model output so a regression is loud."""

from __future__ import annotations

from src import agent_local_parser as p


# ── Qwen 2.5 / Hermes ChatML ────────────────────────────────────────


def test_parses_qwen_single_call():
    text = (
        'Pour trouver votre vol, je vais chercher.\n'
        '<tool_call>\n'
        '{"name": "search_emails", "arguments": {"query": "subject:vol Air France"}}\n'
        '</tool_call>'
    )
    calls = p.parse_tool_calls(text)
    assert len(calls) == 1
    assert calls[0].name == "search_emails"
    assert calls[0].args == {"query": "subject:vol Air France"}


def test_parses_qwen_multiple_calls_in_order():
    text = (
        '<tool_call>{"name":"search_emails","arguments":{"query":"vol"}}</tool_call>\n'
        '<tool_call>{"name":"get_email","arguments":{"int_id":42}}</tool_call>'
    )
    calls = p.parse_tool_calls(text)
    assert [c.name for c in calls] == ["search_emails", "get_email"]
    assert calls[1].args == {"int_id": 42}


def test_qwen_call_with_string_arguments_field():
    """Some quantisations stringify the arguments JSON. Decode it transparently."""
    text = (
        '<tool_call>{"name":"list_emails","arguments":"{\\"folder\\":\\"inbox\\"}"}</tool_call>'
    )
    calls = p.parse_tool_calls(text)
    assert calls[0].name == "list_emails"
    assert calls[0].args == {"folder": "inbox"}


# ── Mistral 7B v0.3 ──────────────────────────────────────────────────


def test_parses_mistral_tool_calls_array():
    text = '[TOOL_CALLS][{"name":"search_emails","arguments":{"query":"facture"}}]'
    calls = p.parse_tool_calls(text)
    assert len(calls) == 1
    assert calls[0].name == "search_emails"


def test_parses_mistral_tool_calls_single_object():
    text = '[TOOL_CALLS]{"name":"get_email","arguments":{"int_id":7}}'
    calls = p.parse_tool_calls(text)
    assert calls[0].args == {"int_id": 7}


# ── Hermes function_call / bare JSON ─────────────────────────────────


def test_parses_function_call_block():
    text = '<function_call>{"name":"list_emails","arguments":{}}</function_call>'
    calls = p.parse_tool_calls(text)
    assert calls[0].name == "list_emails"
    assert calls[0].args == {}


def test_parses_bare_json_object_at_start():
    text = '{"name":"search_emails","arguments":{"query":"x"}}'
    calls = p.parse_tool_calls(text)
    assert len(calls) == 1 and calls[0].name == "search_emails"


def test_parses_openai_shape_in_bare_json():
    """Hermes sometimes emits the OpenAI wire shape verbatim."""
    text = (
        '{"tool_calls":['
        '{"function":{"name":"search_emails","arguments":"{\\"query\\":\\"x\\"}"}}'
        ']}'
    )
    calls = p.parse_tool_calls(text)
    assert calls[0].name == "search_emails"
    assert calls[0].args == {"query": "x"}


def test_parses_fenced_json_block():
    text = '```json\n{"name":"list_emails","arguments":{}}\n```'
    calls = p.parse_tool_calls(text)
    assert calls and calls[0].name == "list_emails"


# ── No tool calls → empty ────────────────────────────────────────────


def test_plain_french_answer_returns_empty():
    text = "Votre vol Air France part le 12 juin à 09:35 depuis Paris CDG."
    assert p.parse_tool_calls(text) == []


def test_refusal_returns_empty():
    text = "Je ne peux pas répondre, je n'ai pas accès à votre calendrier."
    assert p.parse_tool_calls(text) == []


def test_empty_input_returns_empty():
    assert p.parse_tool_calls("") == []
    assert p.parse_tool_calls("   \n") == []


# ── Malformed input survives ────────────────────────────────────────


def test_malformed_inner_json_skipped():
    text = '<tool_call>{not json}</tool_call>'
    assert p.parse_tool_calls(text) == []


def test_missing_name_skipped():
    text = '<tool_call>{"arguments":{"x":1}}</tool_call>'
    assert p.parse_tool_calls(text) == []


# ── Artifact stripping ──────────────────────────────────────────────


def test_strip_removes_qwen_block():
    text = (
        'Voici la date de votre vol.\n'
        '<tool_call>{"name":"x","arguments":{}}</tool_call>'
    )
    assert p.strip_tool_artifacts(text) == "Voici la date de votre vol."


def test_strip_removes_function_call_and_tool_response():
    text = (
        'Préambule\n'
        '<function_call>{"name":"x"}</function_call>\n'
        '<tool_response>{"result":"…"}</tool_response>\n'
        'Réponse finale.'
    )
    cleaned = p.strip_tool_artifacts(text)
    assert "function_call" not in cleaned
    assert "tool_response" not in cleaned
    assert "Préambule" in cleaned
    assert "Réponse finale." in cleaned


def test_strip_removes_mistral_tool_calls():
    text = 'Avant\n[TOOL_CALLS][{"name":"x"}]\nAprès'
    cleaned = p.strip_tool_artifacts(text)
    assert "[TOOL_CALLS]" not in cleaned
    assert "Avant" in cleaned and "Après" in cleaned


def test_strip_on_clean_text_is_identity():
    text = "Tu as 3 emails non lus aujourd’hui."
    assert p.strip_tool_artifacts(text) == text


def test_strip_empty_input():
    assert p.strip_tool_artifacts("") == ""
    assert p.strip_tool_artifacts(None) is None  # type: ignore[arg-type]


def test_strip_mistral_block_with_continuous_prose():
    """The previous strip used a (?=\\n\\n|...) lookahead — it leaked into
    prose when the model didn't add a paragraph break. The balanced-brace
    strip handles this correctly."""
    text = 'Avant. [TOOL_CALLS][{"name":"x","arguments":{"q":"y"}}] suite directe.'
    cleaned = p.strip_tool_artifacts(text)
    assert "[TOOL_CALLS]" not in cleaned
    assert "Avant." in cleaned
    assert "suite directe." in cleaned


def test_strip_mistral_block_with_nested_braces():
    """Arguments often contain nested objects. The balanced extractor must
    follow them all the way to the outer closing brace."""
    text = '[TOOL_CALLS][{"name":"x","arguments":{"filters":{"a":1,"b":{"c":2}}}}] trailing'
    cleaned = p.strip_tool_artifacts(text)
    assert "TOOL_CALLS" not in cleaned
    assert "trailing" in cleaned
    assert "filters" not in cleaned


def test_strip_multiple_mistral_blocks():
    text = (
        'A [TOOL_CALLS][{"name":"x"}] '
        'B [TOOL_CALLS]{"name":"y"} '
        'C'
    )
    cleaned = p.strip_tool_artifacts(text)
    assert "TOOL_CALLS" not in cleaned
    assert "A" in cleaned and "B" in cleaned and "C" in cleaned


def test_strip_mistral_sentinel_with_no_payload():
    """Some quantisations emit the sentinel as filler with no JSON. The strip
    must drop the sentinel itself rather than swallow trailing prose."""
    text = "Avant [TOOL_CALLS] après"
    cleaned = p.strip_tool_artifacts(text)
    assert "[TOOL_CALLS]" not in cleaned
    assert "Avant" in cleaned and "après" in cleaned
