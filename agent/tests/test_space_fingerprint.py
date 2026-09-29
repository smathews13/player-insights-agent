from types import SimpleNamespace

import space_fingerprint as fp


class FakeGenie:
    def __init__(self, spaces: dict[str, SimpleNamespace]):
        self.spaces = spaces

    def get_space(self, space_id: str, include_serialized_space: bool = False):
        return self.spaces[space_id]


def test_fingerprint_changes_when_tables_change():
    first = fp.fingerprint("space-1", ["a.b.c", "a.b.d"], "2026-01-01")
    second = fp.fingerprint("space-1", ["a.b.c", "a.b.e"], "2026-01-01")
    assert first != second
    assert len(first) == 64


def test_fingerprint_is_stable_under_table_order():
    assert fp.fingerprint("s", ["x.y.b", "x.y.a"]) == fp.fingerprint("s", ["x.y.a", "x.y.b"])


def test_compare_live_flags_a_recuration():
    baked = [{"role": "data", "sha256": "aaa", "tables": ["c.s.t"]}]
    live = [{"role": "data", "sha256": "bbb", "tables": ["c.s.u"]}]
    findings = fp.compare_live(baked, live)
    assert findings
    assert "Re-log" in findings[0]


def test_compare_targets_respects_allowlist():
    left = [{"role": "data", "tables": ["c.s.shared", "c.s.example_only"]}]
    right = [{"role": "data", "tables": ["c.s.shared"]}]
    assert fp.compare_targets(left, right, allowlist=["c.s.example_only"]) == []
    assert fp.compare_targets(left, right) != []


def test_records_from_genie_hash_each_role():
    workspace = SimpleNamespace(
        genie=FakeGenie(
            {
                "data-id": SimpleNamespace(create_time="t0"),
                "dict-id": SimpleNamespace(create_time="t1"),
            }
        )
    )
    settings = SimpleNamespace(data_genie_space_id="data-id", dictionary_genie_space_id="dict-id")

    def curated(_workspace, space_id):
        return ["cat.sch.data"] if space_id == "data-id" else ["cat.sch.dict"]

    records = fp.records_from_genie(settings, workspace, curated)
    assert [row["role"] for row in records] == ["data", "dictionary"]
    assert records[0]["sha256"] == fp.fingerprint("data-id", ["cat.sch.data"], "t0")
