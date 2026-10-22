import json

import carry_over as co
import documents as docs


def test_dashboard_triggers_and_typos():
    for text in [
        "make a dashboard",
        "Dashboards please",
        "give me HTML",
        "a dashbaord of sales",
        "dasboard",
        "dashbord for this",
        "dashboardd",
    ]:
        assert docs.dashboard_requested(text), text
    for text in ["database size", "dashing", "the dash", "a chart of sales", "dashed line"]:
        assert not docs.dashboard_requested(text), text


def test_dashboard_beats_report_and_report_triggers():
    assert docs.wants_document("a report dashboard") == "dashboard"
    for text in ["one-pager on churn", "build a deck", "powerpoint slides", "a report"]:
        assert docs.wants_document(text) == "report", text
    assert docs.wants_document("what is revenue") == ""


def test_dashboard_limit_and_trim(monkeypatch):
    monkeypatch.setenv(docs.DASHBOARD_TOKENS_ENV, "100")
    assert docs.dashboard_html_limit() == 400
    monkeypatch.setenv(docs.DASHBOARD_TOKENS_ENV, "bad")
    assert docs.dashboard_max_output_tokens() == 32_000
    page = "<html>a</html><html>bbbbbbbb"
    assert docs.trim_html(page, 100) == (page, False)
    assert docs.trim_html(page, 20) == ("<html>a</html>", True)
    assert docs.trim_html("<html>aaaaaaaaaaaa", 5) == ("", True)


def _turn(i, rows="r", **extra):
    block = {
        "tool": "run_sql",
        "arguments": {"sql": "SELECT 1 FROM c.s.t"},
        "result": rows,
        "sources": ["c.s.t"],
        "truncated": False,
        "version": "v1",
    }
    return {
        "turn_id": f"t{i}",
        "question": f"q{i}",
        "type": "answer",
        "takeaway": f"a{i}",
        "evidence_blocks": [block],
        **extra,
    }


def test_parse_bounds():
    assert co.parse_prior_turns("x") is None
    assert co.parse_prior_turns([]).turns == []
    parsed = co.parse_prior_turns([_turn(1), "junk", {"evidence_blocks": []}])
    assert len(parsed.turns) == 1 and parsed.rejected == 2
    many = co.parse_prior_turns([_turn(i) for i in range(co.MAX_TURNS + 5)])
    assert many.dropped == 5 and len(many.turns) == co.MAX_TURNS


def test_fit_compresses_then_omits():
    parsed = co.parse_prior_turns([_turn(i, rows="x" * 40_000) for i in range(6)])
    fitted = co.fit_turns(parsed.turns, 12_000)
    assert fitted.omitted or fitted.compressed
    assert fitted.tokens <= 12_000
    assert fitted.turns[-1]["turn_id"] == "t5"
    assert co.history_caveats(fitted, parsed)
    small = co.fit_turns(co.parse_prior_turns([_turn(1)]).turns)
    assert not small.compressed and not small.omitted


def test_statement_key():
    a = co.statement_key("SELECT  a , b FROM T WHERE x = 'Ab C';")
    b = co.statement_key("select a,b from t where x = 'Ab C'")
    assert a == b
    assert co.statement_key("select 'A'") != co.statement_key("select 'a'")
    assert co.statement_key("select 1 -- hi") is None
    assert co.statement_key("") is None


def test_eligible_blocks_filters():
    readable = ["c.s.t"]

    def tables(sql):
        return ["c.s.t"]

    parsed = co.parse_prior_turns(
        [
            _turn(1),
            _turn(2, evidence_withheld=True),
            {
                **_turn(3),
                "evidence_blocks": [
                    {
                        **_turn(3)["evidence_blocks"][0],
                        "truncated": True,
                        "arguments": {"sql": "select 2 from c.s.t"},
                    },
                    {
                        **_turn(3)["evidence_blocks"][0],
                        "sources": ["c.s.other"],
                        "arguments": {"sql": "select 3 from c.s.t"},
                    },
                    {
                        "tool": "data_genie",
                        "arguments": {"question": "q"},
                        "result": "r",
                        "version": "old",
                    },
                ],
            },
        ]
    )
    found = co.eligible_blocks(parsed.turns, readable, "v1", tables)
    assert [b["turn_id"] for b in found] == ["t1"] or len(found) == 1
    assert co.eligible_blocks(parsed.turns, [], "v1", tables) == []


def test_parse_decision():
    ok = json.dumps({"decision": "reuse", "use": [0], "gap_request": ""})
    assert co.parse_decision(ok, 1) == ("reuse", [0], "")
    assert co.parse_decision("nonsense", 1)[0] == "fetch"
    bad = json.dumps({"decision": "reuse", "use": [3], "gap_request": ""})
    assert co.parse_decision(bad, 1)[0] == "fetch"
    nogap = json.dumps({"decision": "reuse_and_fetch", "use": [0], "gap_request": ""})
    assert co.parse_decision(nogap, 1)[0] == "fetch"
