# Player Insights Agent response contract

[`agent-response.schema.json`](agent-response.schema.json) is the machine-readable
contract between the served Python agent and the application that consumes its
Model Serving `custom_outputs`.

The root is a discriminated union. Dispatch on `type`; every completed Ask ends
as exactly one of:

- `plan`
- `clarification`
- `answer`
- `report`
- `dashboard`
- `unavailable`

`dashboard.renderable` is a backend-selected artifact. Its `format`
discriminator is `html` or `json`. The app passes HTML byte-for-byte to an
isolated browser frame and preserves JSON as JSON; it does not infer a format,
extract dashboard fields, or rebuild either payload as frontend-owned
components. See `x-pia-renderable` for the consumer rules.

`answer.caveats` is intentionally an open array of strings. Caveats can contain
live table names, dates, metrics, coverage counts, and access decisions, so a
closed string enum would reject valid disclosures. The schema's
`x-pia-caveats` section instead publishes:

- the complete semantic category list and display priority;
- every stable literal or prefix that either side treats as a contract;
- the dynamic caveat families and what each must disclose; and
- the rule that unknown caveat text remains visible as `unclassified`.

## Source of truth

The Pydantic models and caveat metadata in
[`agent/contracts.py`](../agent/contracts.py) are authoritative. Do not edit the
generated JSON directly.

Regenerate after changing the Python contract:

```bash
uv run --project agent --no-sync python agent/generate_contract.py --generate
```

Verify that the checked-in artifact is current:

```bash
uv run --project agent --no-sync python agent/generate_contract.py --check
```

The public mirror exposes the same paths, so another backend can pin a commit and
consume the schema without importing this repository's Python runtime.
